package ai.wexy.forge.agent;

import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.templates.WgslWords;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * <b>Retired with {@code agent-action.v1} (EA3.6):</b> nothing calls it. A v2 program names adapters, not engine calls,
 * and {@link ProgramCheck} checks it; this is v1's check, kept unchanged with its test until the user commits or drops
 * the v1 work (it was never committed).
 *
 * <p>The pure check of a proposal's design and program (the agent-loop design §8, EA2.2; the tool the frontend's design
 * calls {@code validate_program}), against K and H in the engine bundle. It judges what the paper test found plans
 * get wrong, not names alone:
 * <ul>
 *   <li>names: every symbol an export of its family, every member declared on it, no family Wexy cannot run (a host
 *       family is a warning);</li>
 *   <li>arguments: each named by a declared parameter; every required parameter given, but the engine, which the host
 *       supplies; an options value's keys properties of its type, nested; its required properties present and not
 *       null;</li>
 *   <li>completeness: a batch names its shader; a storage buffer a draw reads is filled by an upload that names it,
 *       or by scheduled compute or upload work that writes it; each {@code PostChain} has a {@code setChain} that names
 *       it; an animated design schedules work, at fixed step or frame, that writes something a draw reads;</li>
 *   <li>layouts: no WGSL reserved word as a module's name; bind groups 0 to 3; 14 floats an instance for the stock
 *       materials;</li>
 *   <li>references: every input, scheduled object and module's user declared; one that names nothing fails.</li>
 * </ul>
 * Findings come in the program's order. Where a declaration does not show a call's parameters or an options type's
 * properties, nothing is checked there rather than guessed (Declarations). The associations of producers, chains and
 * motion were tightened by the review of gate A (§15.1).
 */
public final class RawCallCheck {

    static final Set<String> STOCK = Set.of("materials:BasicMaterial", "materials:LambertMaterial", "materials:EmissiveMaterial",
            "materials:MatcapMaterial", "materials:ToonMaterial", "materials:StandardPBRMaterial");
    /** The NullGraph calls that hand a batch its geometry, instances or bindings. */
    static final Set<String> BATCH_MEMBERS = Set.of("createBatch", "setBatchGeometry", "updateBatchData", "setRenderPassBindGroup",
            "createTextureBindGroup");
    /** Parameter types the host supplies: the engine and its device, which a world never holds (the template's host rules). */
    static final Set<String> HOST_SUPPLIED = Set.of("NullGraph", "GPUDevice");
    private static final Pattern ENGINE_OWNED = Pattern.compile("(?i)camera|instance|light|environment|probe|shadow");
    private static final Pattern FN = Pattern.compile("fn\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)");
    private static final Pattern ATTRIBUTE = Pattern.compile("@\\w+(\\([^)]*\\))?");
    private static final Pattern NULL_UNION = Pattern.compile("(^|\\|)\\s*null\\s*($|\\|)");
    private static final int NESTING = 3;

    private final EngineBundle bundle;
    private final Declarations declarations;
    private final ObjectMapper json = new ObjectMapper();

    public RawCallCheck(EngineBundle bundle) {
        this.bundle = bundle;
        this.declarations = new Declarations(bundle);
    }

    /** Whether a check's findings let the program be handed off: none fails. */
    public static boolean passes(List<Finding> findings) {
        return findings.stream().noneMatch(Finding::fails);
    }

    /** Every finding for one proposal (an {@code agent-action.v1} with its design and program), in the program's order. */
    public List<Finding> check(JsonNode action) {
        List<Finding> out = new ArrayList<>();
        JsonNode design = action.path("design");
        JsonNode program = action.path("program");
        if (!design.isObject() || !program.isObject()) {
            out.add(Finding.fail("proposal", design.isObject() ? "program" : "design", "a proposal carries both a design and a program"));
            return out;
        }
        Map<String, JsonNode> objects = new LinkedHashMap<>();
        for (JsonNode o : program.path("objects")) {
            String id = o.path("id").asText();
            if (objects.putIfAbsent(id, o) != null) {
                out.add(Finding.fail("id", "program.objects." + id, "two objects are named " + id));
            }
        }
        Set<String> modules = new LinkedHashSet<>();
        program.path("modules").forEach(m -> modules.add(m.path("id").asText()));
        names(design, objects, out);
        arguments(objects, out);
        completeness(design, program, objects, out);
        layouts(program, objects, out);
        references(program, objects, modules, out);
        return out;
    }

    private void names(JsonNode design, Map<String, JsonNode> objects, List<Finding> out) {
        Set<String> families = new TreeSet<>();
        JsonNode techniques = design.path("techniques");
        for (int i = 0; i < techniques.size(); i++) {
            JsonNode symbols = techniques.get(i).path("symbols");
            for (int j = 0; j < symbols.size(); j++) {
                EngineBundle.Symbol s = resolve(symbols.get(j).asText(), "design.techniques[" + i + "].symbols[" + j + "]", out);
                if (s != null) {
                    families.add(s.family());
                }
            }
            for (JsonNode doc : techniques.get(i).path("docIds")) {
                if (!bundle.docs().containsKey(doc.asText())) {
                    out.add(Finding.warn("doc", "design.techniques[" + i + "].docIds", "no document " + doc.asText() + " in the bundle"));
                }
            }
        }
        for (JsonNode o : objects.values()) {
            String path = "program.objects." + o.path("id").asText();
            EngineBundle.Symbol s = resolve(o.path("symbol").asText(), path, out);
            if (s == null) {
                continue;
            }
            families.add(s.family());
            String member = member(o);
            if (member == null) {
                continue;
            }
            if ("function".equals(s.kind()) || "const".equals(s.kind())) {
                out.add(Finding.fail("member", path, s.id() + " is a " + s.kind() + ", with no member " + member));
            } else if (!Declarations.declaresMember(s, member)) {
                out.add(Finding.fail("member", path, s.id() + " declares no member " + member + "; inspect_api shows what it has"));
            }
        }
        for (String id : families) {
            EngineBundle.Family family = bundle.families().get(id);
            if ("host".equals(family.use())) {
                out.add(Finding.warn("host", "program", "the world uses " + id + ", which is the host's: " + family.reason()));
            } else if ("external".equals(family.use())) {
                out.add(Finding.fail("external", "program", "the world uses " + id + ", which Wexy cannot run: " + family.reason()));
            }
        }
    }

    private EngineBundle.Symbol resolve(String ref, String path, List<Finding> out) {
        EngineBundle.Symbol s = bundle.symbols().get(ref);
        if (s == null) {
            out.add(Finding.fail("name", path, ref + " is not an export of null-graph " + bundle.engineVersion() + ": "
                    + Declarations.unknownSymbol(bundle, ref)));
        }
        return s;
    }

    private void arguments(Map<String, JsonNode> objects, List<Finding> out) {
        for (JsonNode o : objects.values()) {
            EngineBundle.Symbol s = bundle.symbols().get(o.path("symbol").asText());
            if (s == null) {
                continue;
            }
            Map<String, Declarations.Param> params = declarations.params(s, member(o));
            if (params == null) {
                continue;
            }
            String base = "program.objects." + o.path("id").asText();
            String call = s.id() + (member(o) == null ? "" : "." + member(o));
            Set<String> given = new LinkedHashSet<>();
            for (JsonNode arg : o.path("args")) {
                String name = arg.path("param").asText();
                String path = base + ".args." + name;
                if (given.contains(name)) {
                    out.add(Finding.fail("arg-param", path, "the argument " + name + " is given twice"));
                    continue;
                }
                Declarations.Param param = params.get(name);
                if (param == null) {
                    given.add(name);
                    out.add(Finding.fail("arg-param", path, call + " has no parameter " + name + "; "
                            + (params.isEmpty() ? "it takes none" : "its parameters are " + String.join(", ", params.keySet()))));
                    continue;
                }
                JsonNode value = parse(arg.path("value").asText());
                if (value == null) {
                    given.add(name);
                    out.add(Finding.fail("arg-value", path, "the value of " + name + " is not JSON text"));
                } else if (value.isNull() && !nullable(param.type())) {
                    // A required parameter given null is not given (gate A); an optional one given null is left out.
                    continue;
                } else {
                    given.add(name);
                    if (value.isObject()) {
                        keys(value, param.type(), path, o, 0, out);
                    }
                }
            }
            List<String> missing = new ArrayList<>();
            for (Declarations.Param param : params.values()) {
                if (param.optional() || given.contains(param.name()) || HOST_SUPPLIED.contains(typeName(param.type()))) {
                    continue;
                }
                Map<String, Declarations.Property> props = declarations.properties(param.type());
                List<String> required = props == null ? List.of()
                        : props.values().stream().filter(p -> !p.optional()).map(Declarations.Property::name).toList();
                missing.add(required.isEmpty() ? param.name()
                        : param.name() + " (" + param.type().strip() + ", which requires " + String.join(", ", required) + ")");
            }
            if (!missing.isEmpty()) {
                out.add(Finding.fail("arg-missing", base + ".args", call + " needs "
                        + (missing.size() == 1 && missing.get(0).contains(" (") ? "its " : "") + String.join(", ", missing)));
            }
        }
    }

    /** An options value against its type: unknown keys, nested values, then the required properties it lacks or gives null. */
    private void keys(JsonNode value, String type, String path, JsonNode o, int depth, List<Finding> out) {
        Map<String, Declarations.Property> props = declarations.properties(type);
        if (props == null) {
            return;
        }
        String name = typeName(type);
        value.fieldNames().forEachRemaining(key -> {
            Declarations.Property prop = props.get(key);
            if (prop == null) {
                out.add(Finding.fail("arg-key", path + "." + key, name + " has no property " + key + "; its properties are "
                        + String.join(", ", props.keySet())));
            } else if (depth < NESTING && value.get(key).isObject()) {
                keys(value.get(key), prop.type(), path + "." + key, o, depth + 1, out);
            }
        });
        List<String> missing = new ArrayList<>();
        for (Declarations.Property prop : props.values()) {
            JsonNode given = value.get(prop.name());
            boolean present = given != null && (!given.isNull() || nullable(prop.type()));
            if (prop.optional() || present) {
                continue;
            }
            if ("shaderCode".equals(prop.name()) && "createBatch".equals(member(o))) {
                // An input that builds a shader is not enough: the config names it (gate A).
                out.add(Finding.fail("batch-shader", path, "createBatch has no shader: its config gives no shaderCode; build one "
                        + "with a materials build…Shader function (or a module) and pass its id as shaderCode"));
            } else {
                missing.add(prop.name());
            }
        }
        if (!missing.isEmpty()) {
            out.add(Finding.fail("arg-required", path, name + " requires " + String.join(", ", missing)));
        }
    }

    private void completeness(JsonNode design, JsonNode program, Map<String, JsonNode> objects, List<Finding> out) {
        Set<String> resources = new LinkedHashSet<>();
        Set<String> storage = new LinkedHashSet<>();
        for (JsonNode r : program.path("resources")) {
            resources.add(r.path("id").asText());
            if ("storage_buffer".equals(r.path("kind").asText())) {
                storage.add(r.path("id").asText());
            }
        }
        // What a draw reads: a batch's inputs, and a render item's reads.
        Set<String> drawn = new LinkedHashSet<>();
        for (JsonNode o : objects.values()) {
            if ("createBatch".equals(member(o))) {
                o.path("inputs").forEach(i -> drawn.add(i.asText()));
            }
        }
        for (JsonNode item : program.path("schedule")) {
            if ("render".equals(item.path("kind").asText())) {
                item.path("reads").forEach(r -> drawn.add(r.asText()));
            }
        }

        // A storage buffer a draw reads is filled by an upload that names it, or by scheduled work that writes it.
        for (String r : storage) {
            if (!drawn.contains(r)) {
                continue;
            }
            boolean uploaded = objects.values().stream().anyMatch(o -> "updateBatchData".equals(member(o)) && names(o, r));
            boolean written = false;
            for (JsonNode item : program.path("schedule")) {
                if (works(item, objects) && contains(item.path("writes"), r)) {
                    written = true;
                }
            }
            if (!uploaded && !written) {
                out.add(Finding.fail("buffer-producer", "program.resources." + r, r + " is read to draw, but nothing fills it: upload it "
                        + "with updateBatchData naming it, or schedule a compute stage (or an upload) that writes it"));
            }
        }

        // Each PostChain needs a setChain (or compile) on itself: one that names it among its inputs.
        for (JsonNode o : objects.values()) {
            if ("post:PostChain".equals(o.path("symbol").asText()) && member(o) == null) {
                String id = o.path("id").asText();
                boolean set = objects.values().stream().anyMatch(c -> "post:PostChain".equals(c.path("symbol").asText())
                        && ("setChain".equals(member(c)) || "compile".equals(member(c))) && contains(c.path("inputs"), id));
                if (!set) {
                    out.add(Finding.fail("chain-set", "program.objects." + id, "PostChain " + id + " needs setChain(effects) before "
                            + "getPassSequence, from an object that names " + id + " among its inputs"));
                }
            }
        }

        // An animated design schedules work, at fixed step or frame, that writes something a draw reads.
        if (design.path("animated").asBoolean(false)) {
            boolean moves = false;
            for (JsonNode item : program.path("schedule")) {
                String when = item.path("when").asText();
                if (("fixed_step".equals(when) || "frame".equals(when)) && works(item, objects)) {
                    for (JsonNode w : item.path("writes")) {
                        if (resources.contains(w.asText()) && drawn.contains(w.asText())) {
                            moves = true;
                        }
                    }
                }
            }
            if (!moves) {
                out.add(Finding.fail("motion-work", "program.schedule", "the design is animated, but no fixed-step or frame work "
                        + "writes what is drawn: schedule a compute stage, or an upload, that writes a resource a draw reads"));
            }
        }
    }

    /** Whether a schedule item is work that can write a buffer: a compute item run by a compute stage, or an upload. */
    private static boolean works(JsonNode item, Map<String, JsonNode> objects) {
        JsonNode by = objects.get(item.path("objectId").asText());
        if (by == null) {
            return false;
        }
        String kind = item.path("kind").asText();
        return ("compute".equals(kind) && "createComputeStage".equals(member(by)))
                || ("upload".equals(kind) && "updateBatchData".equals(member(by)));
    }

    /** Whether an object names {@code id}: among its inputs, or as an argument's value. */
    private boolean names(JsonNode o, String id) {
        if (contains(o.path("inputs"), id)) {
            return true;
        }
        for (JsonNode arg : o.path("args")) {
            JsonNode value = parse(arg.path("value").asText());
            if (value != null && value.isTextual() && id.equals(value.asText())) {
                return true;
            }
        }
        return false;
    }

    private void layouts(JsonNode program, Map<String, JsonNode> objects, List<Finding> out) {
        for (JsonNode m : program.path("modules")) {
            String path = "program.modules." + m.path("id").asText();
            for (String word : moduleNames(m.path("entry").asText(), m.path("signature").asText())) {
                if (WgslWords.RESERVED.contains(word)) {
                    out.add(Finding.fail("reserved", path, word + " is a reserved word in WGSL, so it cannot name anything"));
                }
            }
            String stage = m.path("stage").asText();
            for (JsonNode b : m.path("bindings")) {
                int group = b.path("group").asInt();
                String resource = b.path("resource").asText();
                if (group > 3) {
                    out.add(Finding.fail("group", path, "group " + group + ", but WebGPU gives four (0 to 3)"));
                } else if ("compute".equals(stage) && group != 0) {
                    out.add(Finding.warn("group", path, "a compute stage binds its own resources at group 0 (setComputePassBindGroup's "
                            + "default), not " + group));
                } else if (!"compute".equals(stage) && !"post_effect".equals(stage) && group != 1 && !ENGINE_OWNED.matcher(resource).find()) {
                    out.add(Finding.warn("group", path, resource + " at group " + group + ", which the engine owns (0 camera and "
                            + "instances, 2 lights and environment, 3 shadows); a batch's own bindings go at group 1"));
                }
            }
        }
        if (objects.values().stream().noneMatch(o -> STOCK.contains(o.path("symbol").asText()))) {
            return;
        }
        for (JsonNode r : program.path("resources")) {
            String id = r.path("id").asText();
            if (!"storage_buffer".equals(r.path("kind").asText())) {
                continue;
            }
            boolean fed = objects.values().stream().anyMatch(o -> "core:NullGraph".equals(o.path("symbol").asText())
                    && BATCH_MEMBERS.contains(member(o)) && contains(o.path("inputs"), id));
            if (!fed) {
                continue;
            }
            JsonNode stride = r.path("strideFloats");
            if (stride.isNull() || stride.isMissingNode()) {
                out.add(Finding.warn("stride", "program.resources." + id, id + " feeds a batch beside a stock material and gives no "
                        + "strideFloats (the stock materials read 14)"));
            } else if (stride.asInt() != 14) {
                out.add(Finding.fail("stride", "program.resources." + id, id + " is " + stride.asInt() + " floats a stride; the stock "
                        + "materials read 14" + (stride.asInt() == 24 ? " (24 is the visibility family's layout)" : "")));
            }
        }
    }

    /** References the program must resolve to be built: a name that points at nothing fails (gate A). */
    private void references(JsonNode program, Map<String, JsonNode> objects, Set<String> modules, List<Finding> out) {
        Set<String> declared = new LinkedHashSet<>(objects.keySet());
        program.path("resources").forEach(r -> declared.add(r.path("id").asText()));
        declared.addAll(modules);
        for (JsonNode o : objects.values()) {
            for (JsonNode input : o.path("inputs")) {
                if (!declared.contains(input.asText())) {
                    out.add(Finding.fail("ref", "program.objects." + o.path("id").asText(), "input " + input.asText()
                            + " is declared nowhere: name an object, a resource or a module"));
                }
            }
        }
        for (JsonNode item : program.path("schedule")) {
            if (!objects.containsKey(item.path("objectId").asText())) {
                out.add(Finding.fail("ref", "program.schedule." + item.path("id").asText(), "object " + item.path("objectId").asText()
                        + " is declared nowhere"));
            }
        }
        for (JsonNode m : program.path("modules")) {
            if (!objects.containsKey(m.path("usedBy").asText())) {
                out.add(Finding.fail("ref", "program.modules." + m.path("id").asText(), "usedBy " + m.path("usedBy").asText()
                        + " is declared nowhere"));
            }
        }
    }

    /** The names a module gives: its entry, its function's name, its parameters' (attributes dropped; types are not names). */
    static List<String> moduleNames(String entry, String signature) {
        Set<String> names = new LinkedHashSet<>();
        if (!entry.isBlank()) {
            names.add(entry);
        }
        Matcher m = FN.matcher(ATTRIBUTE.matcher(signature).replaceAll(""));
        if (m.find()) {
            names.add(m.group(1));
            for (String p : m.group(2).split(",")) {
                String name = p.split(":")[0].strip();
                if (!name.isEmpty()) {
                    names.add(name);
                }
            }
        }
        return List.copyOf(names);
    }

    /** Whether a declared type takes null: {@code T | null}, or {@code any}. */
    private static boolean nullable(String type) {
        String t = type.strip();
        return t.equals("any") || t.equals("unknown") || NULL_UNION.matcher(t).find();
    }

    private static String typeName(String type) {
        return type.replace("| undefined", "").strip();
    }

    private static String member(JsonNode o) {
        JsonNode m = o.path("member");
        return m.isTextual() && !m.asText().isBlank() ? m.asText() : null;
    }

    private static boolean contains(JsonNode array, String value) {
        for (JsonNode v : array) {
            if (value.equals(v.asText())) {
                return true;
            }
        }
        return false;
    }

    private JsonNode parse(String text) {
        try {
            return json.readTree(text);
        } catch (IOException e) {
            return null;
        }
    }
}
