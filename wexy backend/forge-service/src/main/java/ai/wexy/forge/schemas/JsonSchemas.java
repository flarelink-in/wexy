package ai.wexy.forge.schemas;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The JSON the models answer with, and the schemas both sides validate it against (forge-loop
 * design §5.4, Q27): {@code agent-action.v3} for the agent loop (its program made of adapter nodes since EA3.6, v2; a
 * revision's notes to its modules since EA6.3, v3; v1's and v2's files stay as deployed, and are not loaded) and
 * {@code review-verdict.v1} for a review, in {@code resources/schemas/}. (h1's planner and director schemas went at EA9.6.)
 * The same text goes to Meta as {@code response_format}, so each
 * schema must stay inside Meta's strict subset (§4.1); startup refuses one that leaves it, because
 * Meta would answer {@code 400} to every call that sent it with {@code strict: true}.
 *
 * <p>Validation is draft 2020-12 with networknt's validator. A message names the path and the rule,
 * {@code $.particles.count: must have a minimum value of 65536}, which is what a log line needs and
 * all it may show (never the answer itself, coding principles §11).
 */
@Component
public class JsonSchemas {

    /**
     * The agent loop's action (the agent-loop design §5.2; v2 since EA3.6, the frontend's engine-adapters design §16; v3
     * since EA6.3, the frontend's visual-review design §8.2: {@code revision.moduleRepairs}).
     */
    public static final String AGENT_ACTION = "agent-action.v3";
    /**
     * A model's review of the world on the stage (EA6.4; the frontend's visual-review design §9.1, Q112 (a)): a verdict and
     * its issues, each with a kind, a severity, a sentence, a suggested scope and the modules it names.
     */
    public static final String REVIEW_VERDICT = "review-verdict.v1";

    /** Meta's limit on nesting (§4.1). */
    static final int MAX_DEPTH = 10;

    private final Map<String, JsonNode> nodes = new LinkedHashMap<>();
    private final Map<String, String> texts = new LinkedHashMap<>();
    private final Map<String, JsonSchema> validators = new LinkedHashMap<>();

    public JsonSchemas() {
        ObjectMapper json = new ObjectMapper();
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
        for (String id : List.of(AGENT_ACTION, REVIEW_VERDICT)) {
            String path = "schemas/" + id + ".json";
            try {
                String text = new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8);
                JsonNode node = json.readTree(text);
                List<String> problems = strictSubsetProblems(node);
                if (!problems.isEmpty()) {
                    throw new IllegalStateException(path + " leaves Meta's strict subset, so strict calls would fail: " + problems);
                }
                nodes.put(id, node);
                texts.put(id, text);
                validators.put(id, factory.getSchema(node));
            } catch (IOException e) {
                throw new UncheckedIOException("Cannot read " + path, e);
            }
        }
    }

    /** What is wrong with an answer, one message per finding; empty when it conforms. */
    public List<String> validate(String id, JsonNode answer) {
        JsonSchema validator = validators.get(id);
        if (validator == null) {
            throw new IllegalArgumentException("No schema '" + id + "'; known: " + validators.keySet());
        }
        Set<ValidationMessage> found = validator.validate(answer);
        List<String> messages = new ArrayList<>();
        for (ValidationMessage m : found) {
            messages.add(m.getMessage());
        }
        messages.sort(String::compareTo);
        return messages;
    }

    /** The schema as JSON, for {@code response_format}. */
    public JsonNode schema(String id) {
        JsonNode node = nodes.get(id);
        if (node == null) {
            throw new IllegalArgumentException("No schema '" + id + "'; known: " + nodes.keySet());
        }
        return node;
    }

    /** The schema's text, as read. */
    public String text(String id) {
        return texts.get(id);
    }

    /**
     * Where a schema leaves Meta's strict subset (structured-output docs, read 2026-10-27): the root
     * is a plain object with no {@code anyOf}, {@code oneOf}, {@code allOf}, {@code enum} or
     * {@code not}; {@code allOf} and {@code oneOf} appear nowhere; every object sets
     * {@code additionalProperties: false} and requires every property; references are local to
     * {@code $defs} and never recursive; nesting stays within {@value #MAX_DEPTH} levels.
     */
    public static List<String> strictSubsetProblems(JsonNode schema) {
        List<String> problems = new ArrayList<>();
        if (!"object".equals(schema.path("type").asText())) {
            problems.add("$: the root must be an object");
        }
        for (String keyword : List.of("anyOf", "oneOf", "allOf", "enum", "not")) {
            if (schema.has(keyword)) {
                problems.add("$: no " + keyword + " at the root");
            }
        }
        walk(schema, "$", problems);
        int depth = depth(schema, schema, new HashSet<>(), problems);
        if (depth > MAX_DEPTH) {
            problems.add("$: nesting " + depth + " is deeper than " + MAX_DEPTH);
        }
        return problems;
    }

    private static void walk(JsonNode s, String path, List<String> problems) {
        if (!s.isObject()) {
            return;
        }
        for (String keyword : List.of("oneOf", "allOf")) {
            if (s.has(keyword)) {
                problems.add(path + ": " + keyword + " is not supported");
            }
        }
        if (s.has("$ref") && !s.get("$ref").asText().startsWith("#/$defs/")) {
            problems.add(path + ": only references into $defs");
        }
        if ("object".equals(s.path("type").asText())) {
            JsonNode extra = s.get("additionalProperties");
            if (extra == null || !extra.isBoolean() || extra.booleanValue()) {
                problems.add(path + ": additionalProperties must be false");
            }
            Set<String> properties = new TreeSet<>();
            s.path("properties").fieldNames().forEachRemaining(properties::add);
            Set<String> required = new TreeSet<>();
            s.path("required").forEach(r -> required.add(r.asText()));
            if (!properties.equals(required)) {
                problems.add(path + ": required " + required + " must list every property " + properties);
            }
        }
        s.path("properties").fields().forEachRemaining(e -> walk(e.getValue(), path + "." + e.getKey(), problems));
        s.path("$defs").fields().forEachRemaining(e -> walk(e.getValue(), path + ".$defs." + e.getKey(), problems));
        if (s.has("items")) {
            walk(s.get("items"), path + "[]", problems);
        }
        JsonNode anyOf = s.path("anyOf");
        for (int i = 0; i < anyOf.size(); i++) {
            walk(anyOf.get(i), path + ".anyOf[" + i + "]", problems);
        }
    }

    /** The deepest nesting of objects and arrays an answer can have, following references. */
    private static int depth(JsonNode s, JsonNode root, Set<String> following, List<String> problems) {
        if (!s.isObject()) {
            return 0;
        }
        if (s.has("$ref")) {
            String ref = s.get("$ref").asText();
            if (!ref.startsWith("#/")) {
                return 0; // not followed: walk() reports any reference outside $defs
            }
            if (!following.add(ref)) {
                problems.add(ref + ": a recursive reference");
                return 0;
            }
            JsonNode target = root.at(ref.substring(1));
            int d = target.isMissingNode() ? 0 : depth(target, root, following, problems);
            following.remove(ref);
            return d;
        }
        int deepest = 0;
        JsonNode anyOf = s.path("anyOf");
        for (int i = 0; i < anyOf.size(); i++) {
            deepest = Math.max(deepest, depth(anyOf.get(i), root, following, problems));
        }
        String type = s.path("type").asText();
        if ("object".equals(type)) {
            int inner = 0;
            for (JsonNode property : (Iterable<JsonNode>) () -> s.path("properties").elements()) {
                inner = Math.max(inner, depth(property, root, following, problems));
            }
            deepest = Math.max(deepest, 1 + inner);
        } else if ("array".equals(type)) {
            deepest = Math.max(deepest, 1 + depth(s.path("items"), root, following, problems));
        }
        return deepest;
    }
}
