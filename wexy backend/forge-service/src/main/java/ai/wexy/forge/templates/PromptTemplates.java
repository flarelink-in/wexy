package ai.wexy.forge.templates;

import ai.wexy.common.AgentTurn;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.models.ModelCatalog;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.core.io.support.ResourcePatternResolver;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The prompt templates, loaded and checked at startup (forge-loop design §5.5, §6). A template is a
 * versioned Markdown file, {@code prompts/<name>.v<n>.md}, whose first line names it:
 * {@code <!-- wexy prompt: author.evolve v1 -->}. Its id ({@code author.evolve.v1}) goes into every
 * record, cache key and mock recording, so a change to a template is a new version, never an edit.
 *
 * <p>Above the first line that is exactly {@code ---} is the static part: it becomes the system
 * message, with its placeholders filled here once ({@code {{host}}}, {@code {{particles}}},
 * {@code {{sky}}}, {@code {{rules}}}, {@code {{exemplars}}}), so every call of a template sends the
 * same system bytes and Meta's prompt cache serves them (P9). Below it is the variable part, filled
 * per request by {@link PromptBuilder} from the fields its template may use.
 *
 * <p>Startup fails, naming the file, when a configured role lacks a template, when a file's first
 * line does not match its name, when there is no {@code ---} line, or when a placeholder is not one
 * its part can fill: a mistake in a template must stop the service, not reach a model.
 *
 * <p>The exemplars placeholder shows the mock's plans to the planner, the h1 exemplar functions with
 * their worlds' plans to the authors, and the mock's edit to the director: the same files the mock
 * upstream replays (§8), so the examples a model sees and the answers the mock gives agree. The
 * agent's example is the mock's program in the same way, beside the adapter manifest it is checked
 * against.
 */
@Component
public class PromptTemplates {

    /** The templates each role's calls use. */
    static final Map<String, List<String>> TEMPLATES_BY_ROLE = Map.of(
            "planner", List.of("planner"),
            "author", List.of("author.evolve", "author.look", "author.sky"),
            "repairer", List.of("repair"),
            "escalator", List.of("repair"),
            "director", List.of("director"),
            "paper", List.of("paper"),
            "agent", List.of("agent"),
            "module", List.of("module.author", "module.repair"),
            // EA6.4 (the frontend's visual-review design §9.1): a model's review of the world on the stage. The vision
            // probe, run once on the user's word, calls the same role with the same template, so it checks what a review sends.
            "review", List.of("review"));

    /** The request fields each template's variable part may use (all authors share theirs). */
    static final Map<String, Set<String>> REQUEST_FIELDS = Map.of(
            "planner", Set.of("style", "seconds", "idea"),
            "author", Set.of("idea", "world", "spawn", "params", "controls"),
            "repair", Set.of("fn", "attempt", "params", "code", "diagnostics"),
            "director", Set.of("world", "turn"),
            "paper", Set.of("documents", "request"),
            "agent", Set.of("budgets", "style", "seconds", "request", "base"),
            "module.author", Set.of("request", "design", "module", "kind", "nodes", "preamble", "entries", "epilogue", "note"),
            "module.repair", Set.of("request", "design", "module", "kind", "nodes", "preamble", "entries", "epilogue", "code", "findings"),
            "review", Set.of("request", "design", "modules", "frames", "findings"));

    static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{([A-Za-z]+)}}");

    private static final Pattern ID_LINE = Pattern.compile("<!-- wexy prompt: ([a-z]+(?:\\.[a-z]+)?) v([1-9][0-9]*) -->");
    private static final Pattern FILE_NAME = Pattern.compile("([a-z]+(?:\\.[a-z]+)?)\\.v([1-9][0-9]*)\\.md");
    private static final String PLANS = "classpath:mock/plans/";
    private static final String EDITS = "classpath:mock/edits/";
    private static final String PAPER_REQUESTS = "classpath:paper/requests.v1.json";
    /** The mock's agent program: the example agent.v2 shows, and the answer the mock gives. */
    private static final String AGENT_EXAMPLE = "classpath:mock/agent/program.json";
    /** The mock program's module body: the example the module templates show, and the answer the mock gives (EA4.2). */
    private static final String MODULE_EXAMPLE = "classpath:mock/modules/place.wgsl";
    /**
     * The documents every agent call carries (Q65, the agent-loop design). They are part of the agent template: a change
     * is a new version of it, so records and the prompt cache name what a call was given.
     */
    static final List<String> AGENT_SEED_DOCS = List.of("agent/guide", "api/core");

    private final Map<String, Template> templates = new LinkedHashMap<>();

    /**
     * One loaded template.
     *
     * @param id     {@code <name>.v<version>}, as records carry it
     * @param path   where it was read from, for error messages
     * @param system the system message, every placeholder filled
     * @param user   the variable part, its request placeholders still open
     */
    public record Template(String name, int version, String id, String path, String system, String user) {
    }

    @Autowired
    public PromptTemplates(ModelCatalog catalog, HostContract host) {
        this(catalog.roleNames(), "classpath:prompts/", host, new PathMatchingResourcePatternResolver());
    }

    /** For tests and tools: the templates of the given roles, read from another location. */
    public PromptTemplates(Set<String> roles, String location, HostContract host, ResourcePatternResolver resources) {
        Set<String> names = new TreeSet<>();
        for (String role : roles) {
            List<String> needed = TEMPLATES_BY_ROLE.get(role);
            if (needed == null) {
                throw new IllegalStateException("Role '" + role + "' (wexy.roles." + role + ") has no prompt templates: "
                        + "add it to PromptTemplates.TEMPLATES_BY_ROLE with the templates its calls use.");
            }
            names.addAll(needed);
        }
        ObjectMapper json = new ObjectMapper();
        for (String name : names) {
            templates.put(name, load(name, location, host, resources, json));
        }
    }

    private static Template load(String name, String location, HostContract host, ResourcePatternResolver resources, ObjectMapper json) {
        Resource file = latest(name, location, resources);
        String path = location + file.getFilename();
        Matcher fileName = FILE_NAME.matcher(String.valueOf(file.getFilename()));
        if (!fileName.matches()) {
            throw new IllegalStateException(path + " is not named <name>.v<n>.md.");
        }
        int version = Integer.parseInt(fileName.group(2));
        String text = HostContract.read(file);
        int firstBreak = text.indexOf('\n');
        Matcher id = ID_LINE.matcher(firstBreak < 0 ? text : text.substring(0, firstBreak));
        if (!id.matches() || !id.group(1).equals(name) || Integer.parseInt(id.group(2)) != version) {
            throw new IllegalStateException(path + " must open with the line <!-- wexy prompt: " + name + " v" + version
                    + " -->: the template's id is in every record, and it must match the file.");
        }
        String rest = firstBreak < 0 ? "" : text.substring(firstBreak + 1);
        int split = rest.startsWith("---\n") ? 0 : rest.indexOf("\n---\n");
        if (split < 0) {
            throw new IllegalStateException(path + " has no line '---' between its static part (the system message) "
                    + "and its variable part (the user message).");
        }
        String staticPart = rest.substring(0, split).strip();
        String variablePart = rest.substring(split == 0 ? 4 : split + 5).strip();

        Map<String, String> fill = staticFields(name, host, resources, json);
        String system = fillAll(staticPart, fill, path + " (static part)");
        Set<String> requestFields = REQUEST_FIELDS.get(name.startsWith("author.") ? "author" : name);
        Matcher open = PLACEHOLDER.matcher(variablePart);
        while (open.find()) {
            if (requestFields == null || !requestFields.contains(open.group(1))) {
                throw new IllegalStateException(path + " uses {{" + open.group(1) + "}} in its variable part, which a "
                        + name + " request cannot fill; it can fill " + (requestFields == null ? "nothing" : new TreeSet<>(requestFields)) + ".");
            }
        }
        return new Template(name, version, name + ".v" + version, path, system, variablePart);
    }

    /** The highest version of a template present at the location. */
    private static Resource latest(String name, String location, ResourcePatternResolver resources) {
        Resource best = null;
        int bestVersion = 0;
        try {
            for (Resource candidate : resources.getResources(location + name + ".v*.md")) {
                Matcher m = FILE_NAME.matcher(String.valueOf(candidate.getFilename()));
                if (m.matches() && m.group(1).equals(name) && Integer.parseInt(m.group(2)) > bestVersion) {
                    best = candidate;
                    bestVersion = Integer.parseInt(m.group(2));
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot list " + location, e);
        }
        if (best == null) {
            throw new IllegalStateException("No prompt template " + name + ": expected " + location + name + ".v<n>.md.");
        }
        return best;
    }

    /** What a template's static part may use: both views, the rules, and the examples for its kind. */
    private static Map<String, String> staticFields(String name, HostContract host, ResourcePatternResolver resources, ObjectMapper json) {
        Map<String, String> fill = new LinkedHashMap<>();
        fill.put("particles", host.particles());
        fill.put("sky", host.sky());
        fill.put("rules", host.rules());
        if (name.startsWith("author.")) {
            String fn = name.substring("author.".length());
            fill.put("host", host.contractFor(fn));
            fill.put("exemplars", functionExamples(fn, host, resources, json));
        } else if (name.equals("planner")) {
            fill.put("exemplars", planExamples(resources));
        } else if (name.equals("director")) {
            fill.put("exemplars", fenced("json", HostContract.read(resources.getResource(EDITS + "director.json"))));
        } else if (name.equals("paper") || name.equals("agent")) {
            // The engine-aware templates (PaperProbe; the agent loop): the engine bundle, verified, and the documents every
            // call shares, quoted here once so that every call sends the same system bytes.
            EngineBundle engine = EngineBundle.load(json);
            fill.put("engineVersion", engine.engineVersion());
            fill.put("bundleHash", engine.bundleHash());
            fill.put("familyIndex", engine.familyIndex().strip());
            fill.put("sharedDocuments", engine.quote(name.equals("agent") ? AGENT_SEED_DOCS : sharedDocuments(resources, json)));
            if (name.equals("agent")) {
                // agent-action.v2 (EA3.6): a program is adapter nodes, so the template lists the adapters it may use.
                fill.put("adapters", AdapterManifest.load(json).describe());
                fill.put("example", exampleProgram(resources, json));
                // agent.v5 (Q84 revised 2026-11-02): the candidate's module budget, which the program check holds; agent.v6
                // (EA6.3) states it too.
                fill.put("maxModules", String.valueOf(AgentTurn.MAX_MODULES));
            }
        } else if (name.startsWith("module.")) {
            // EA4.2: a module body for a turn's program; the mock world's own body is the example, as for the agent.
            fill.put("engineVersion", EngineBundle.load(json).engineVersion());
            fill.put("example", fenced("wgsl", HostContract.read(resources.getResource(MODULE_EXAMPLE)).strip()));
        }
        return fill;
    }

    /** The mock's program, one node a line, as a fenced block. */
    private static String exampleProgram(ResourcePatternResolver resources, ObjectMapper json) {
        JsonNode nodes;
        try {
            nodes = json.readTree(HostContract.read(resources.getResource(AGENT_EXAMPLE))).path("program").path("nodes");
        } catch (IOException e) {
            throw new IllegalStateException("The agent template needs the mock's program at " + AGENT_EXAMPLE, e);
        }
        if (!nodes.isArray() || nodes.isEmpty()) {
            throw new IllegalStateException(AGENT_EXAMPLE + " has no program.nodes to show as the agent's example.");
        }
        List<String> lines = new ArrayList<>();
        nodes.forEach(n -> lines.add("  " + n));
        return fenced("json", "{\"nodes\": [\n" + String.join(",\n", lines) + "\n]}");
    }

    /** The paper test's shared documents: {@code commonDocs} in its requests file. */
    private static List<String> sharedDocuments(ResourcePatternResolver resources, ObjectMapper json) {
        try {
            List<String> ids = new ArrayList<>();
            json.readTree(HostContract.read(resources.getResource(PAPER_REQUESTS))).path("commonDocs").forEach(id -> ids.add(id.asText()));
            return ids;
        } catch (IOException e) {
            throw new IllegalStateException("The paper template needs its requests at " + PAPER_REQUESTS, e);
        }
    }

    private static String planExamples(ResourcePatternResolver resources) {
        List<String> examples = new ArrayList<>();
        try {
            Resource[] plans = resources.getResources(PLANS + "*.json");
            Arrays.sort(plans, Comparator.comparing(Resource::getFilename));
            for (Resource plan : plans) {
                examples.add(fenced("json", HostContract.read(plan)));
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot list " + PLANS, e);
        }
        return String.join("\n\n", examples);
    }

    private static String functionExamples(String fn, HostContract host, ResourcePatternResolver resources, ObjectMapper json) {
        List<String> examples = new ArrayList<>();
        int n = 1;
        for (HostContract.Exemplar exemplar : host.exemplars(fn)) {
            String planPath = PLANS + exemplar.world() + ".json";
            JsonNode plan;
            try {
                plan = json.readTree(HostContract.read(resources.getResource(planPath)));
            } catch (IOException e) {
                throw new IllegalStateException("The exemplar " + exemplar.world() + "." + fn + " needs its world's plan at " + planPath, e);
            }
            StringBuilder text = new StringBuilder("Example ").append(n++).append(", from \"").append(plan.path("title").asText())
                    .append("\": ").append(plan.path("summary").asText()).append('\n')
                    .append("Its controls: ").append(DraftText.paramsInline(plan)).append('\n');
            if (!fn.equals("sky")) {
                text.append("Its random numbers:\n").append(DraftText.spawn(plan)).append('\n');
            }
            examples.add(text.append(fenced("wgsl", exemplar.code())).toString());
        }
        return String.join("\n\n", examples);
    }

    private static String fenced(String language, String code) {
        return "```" + language + "\n" + code + "\n```";
    }

    /**
     * Fills every placeholder in one pass. Inserted text is never scanned again, so a value that
     * happens to contain {{rules}} (a creator's idea, say) stays exactly as written.
     */
    static String fillAll(String text, Map<String, String> values, String where) {
        Matcher m = PLACEHOLDER.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String value = values.get(m.group(1));
            if (value == null) {
                throw new IllegalStateException(where + " uses {{" + m.group(1) + "}}, which is not one of " + new TreeSet<>(values.keySet()) + ".");
            }
            m.appendReplacement(out, Matcher.quoteReplacement(value));
        }
        m.appendTail(out);
        return out.toString();
    }

    public Template get(String name) {
        Template template = templates.get(name);
        if (template == null) {
            throw new IllegalArgumentException("No prompt template '" + name + "' is loaded; loaded: " + templates.keySet());
        }
        return template;
    }

    public Collection<Template> all() {
        return templates.values();
    }
}
