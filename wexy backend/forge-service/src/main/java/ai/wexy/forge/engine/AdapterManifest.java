package ai.wexy.forge.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The frontend's adapter manifest (EA3, its {@code src/contract/adapters/descriptors.json}), embedded byte for byte under
 * {@code resources/adapters/} (Q74: the frontend owns it, the backend embeds it). Its hash over LF line ends is pinned
 * here and in the frontend's tests, so a copy that drifted is refused at startup. It checks itself as the frontend's
 * {@code checkManifest} does: every config schema in the validator's strict subset with its objects closed, every port
 * of a known kind and count, every layout key an enum of pinned layouts, and every variant gate (Q80) an enum value its
 * adapter declares. The program check of {@code agent-action.v2} holds each adapter node to it (EA3.6).
 */
public final class AdapterManifest {

    /** sha256 of descriptors.json with LF line ends; the frontend's EA-A1 pins the same (10-31, after Q80's gates). */
    public static final String HASH = "aacc5959c0f66277befb062ee140fa2b0dbae14d7a9fe0796ca032403b7293a3";

    static final Set<String> PORT_KINDS = Set.of("storage_buffer", "geometry", "material", "lights", "color", "stage");
    /** What the strict subset uses: the frontend's {@code contract/agent} validator implements exactly these. */
    static final Set<String> KEYWORDS = Set.of("title", "description", "type", "anyOf", "enum", "properties", "required",
            "additionalProperties", "items", "minItems", "maxItems", "maxLength", "minimum", "maximum");

    /** An input port: the kind it takes, the buffer layouts it accepts (empty for any), how many connections. */
    public record InputPort(String name, String kind, List<String> layouts, int min, int max) {
    }

    /** An output port; {@code layoutFrom} and {@code strideFrom} name the config keys holding its layout and stride. */
    public record OutputPort(String name, String kind, String layoutFrom, String strideFrom) {
    }

    /** One adapter: its exact version, H's family, its closed config schema (with a validator), and its ports. */
    public record Adapter(String id, int version, String family, JsonNode config, JsonSchema validator,
                          List<InputPort> inputs, List<OutputPort> outputs) {
        public InputPort input(String name) {
            return inputs.stream().filter(p -> p.name().equals(name)).findFirst().orElse(null);
        }

        public OutputPort output(String name) {
            return outputs.stream().filter(p -> p.name().equals(name)).findFirst().orElse(null);
        }
    }

    /**
     * A config value an adapter declares but the manifest marks unavailable for now (Q80, decided): the node check refuses
     * it from this data, with its reason. Tier 2 lifts a gate by removing its entry: a data change, nothing else.
     *
     * @param path a JSON pointer into the adapter's config (RFC 6901), through its schema's properties to an enum
     */
    public record Gate(String adapter, String path, JsonNode value, String reason) {
    }

    private final String version;
    private final Map<String, Adapter> adapters;
    /** Each pinned layout's floats an element; null when the node declares its own (f32). */
    private final Map<String, Integer> layouts;
    private final List<Gate> unavailable;
    /** The manifest as read, for {@link #describe()}: its summaries and symbols are for the model, not the checks. */
    private final JsonNode source;

    private AdapterManifest(String version, Map<String, Adapter> adapters, Map<String, Integer> layouts, List<Gate> unavailable, JsonNode source) {
        this.version = version;
        this.adapters = adapters;
        this.layouts = layouts;
        this.unavailable = unavailable;
        this.source = source;
    }

    /** The manifest on the classpath, verified; throws when its hash or its own consistency fails. */
    public static AdapterManifest load(ObjectMapper json) {
        String text;
        try {
            text = new ClassPathResource("adapters/descriptors.json").getContentAsString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read adapters/descriptors.json", e);
        }
        String hash = EngineBundle.sha256(EngineBundle.lf(text));
        if (!HASH.equals(hash)) {
            throw new IllegalStateException("adapters/descriptors.json is not the pinned manifest (" + hash + ", not " + HASH
                    + "): copy the frontend's src/contract/adapters/descriptors.json again, or pin the new hash on both sides");
        }
        return parse(tree(json, text));
    }

    /** A manifest from its JSON, checked whole: for {@link #load} and for tests that break one on purpose. */
    static AdapterManifest parse(JsonNode m) {
        String name = m.path("version").asText();
        Map<String, Integer> layouts = new LinkedHashMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = m.path("layouts").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode stride = e.getValue().path("strideFloats");
            if (!stride.isNull() && !(stride.isInt() && stride.asInt() > 0)) {
                throw bad(name, "layout " + e.getKey() + "'s stride is not a positive integer");
            }
            layouts.put(e.getKey(), stride.isNull() ? null : stride.asInt());
        }
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
        Map<String, Adapter> adapters = new LinkedHashMap<>();
        for (JsonNode a : m.path("adapters")) {
            String id = a.path("id").asText();
            if (adapters.containsKey(id)) {
                throw bad(name, id + " is listed twice");
            }
            JsonNode config = a.path("config");
            strictSubset(config, "/" + id + "/config", name);
            Set<String> required = new HashSet<>();
            config.path("required").forEach(r -> required.add(r.asText()));
            List<InputPort> inputs = new ArrayList<>();
            for (JsonNode p : a.path("inputs")) {
                String port = p.path("name").asText();
                String kind = p.path("kind").asText();
                int min = p.path("min").asInt(-1);
                int max = p.path("max").asInt(-1);
                if (!PORT_KINDS.contains(kind)) {
                    throw bad(name, id + "'s input " + port + " has kind " + kind);
                }
                if (min < 0 || min > max) {
                    throw bad(name, id + "'s input " + port + " takes " + min + " to " + max);
                }
                List<String> accepted = new ArrayList<>();
                for (JsonNode l : p.path("layouts")) {
                    if (!layouts.containsKey(l.asText())) {
                        throw bad(name, id + "'s input " + port + " accepts layout " + l.asText() + ", which is not pinned");
                    }
                    accepted.add(l.asText());
                }
                inputs.add(new InputPort(port, kind, List.copyOf(accepted), min, max));
            }
            List<OutputPort> outputs = new ArrayList<>();
            for (JsonNode o : a.path("outputs")) {
                String port = o.path("name").asText();
                String kind = o.path("kind").asText();
                String layoutFrom = o.hasNonNull("layoutFrom") ? o.path("layoutFrom").asText() : null;
                String strideFrom = o.hasNonNull("strideFrom") ? o.path("strideFrom").asText() : null;
                if (!PORT_KINDS.contains(kind)) {
                    throw bad(name, id + "'s output " + port + " has kind " + kind);
                }
                if (strideFrom != null && layoutFrom == null) {
                    throw bad(name, id + "'s output " + port + " has a stride but no layout");
                }
                if (layoutFrom != null) {
                    JsonNode values = config.path("properties").path(layoutFrom).path("enum");
                    boolean pinned = values.isArray() && !values.isEmpty();
                    for (JsonNode v : values) {
                        pinned &= layouts.containsKey(v.asText());
                    }
                    if (!required.contains(layoutFrom) || !pinned) {
                        throw bad(name, id + "'s " + layoutFrom + " is not a required enum of pinned layouts");
                    }
                }
                if (strideFrom != null && (!required.contains(strideFrom)
                        || !"integer".equals(config.path("properties").path(strideFrom).path("type").asText()))) {
                    throw bad(name, id + "'s " + strideFrom + " is not a required integer");
                }
                outputs.add(new OutputPort(port, kind, layoutFrom, strideFrom));
            }
            adapters.put(id, new Adapter(id, a.path("version").asInt(), a.path("family").asText(), config, factory.getSchema(config),
                    List.copyOf(inputs), List.copyOf(outputs)));
        }
        return new AdapterManifest(name, Collections.unmodifiableMap(adapters), Collections.unmodifiableMap(layouts),
                gates(m.path("unavailable"), adapters, name), m.deepCopy());
    }

    /**
     * The variant gates (Q80), checked as the frontend's {@code checkManifest} checks them: each exactly {adapter, path,
     * value, reason}, naming an adapter, an enum of its config by pointer through properties, a value that enum holds, and
     * its way out in 1 to 200 characters; never the same value twice, and never every value of an enum.
     */
    private static List<Gate> gates(JsonNode table, Map<String, Adapter> adapters, String name) {
        if (!table.isArray()) {
            throw bad(name, "unavailable is not a list");
        }
        List<Gate> gates = new ArrayList<>();
        Map<String, Set<JsonNode>> gated = new HashMap<>();
        for (JsonNode g : table) {
            String where = "unavailable " + g.path("adapter") + " " + g.path("path");
            Set<String> keys = new HashSet<>();
            g.fieldNames().forEachRemaining(keys::add);
            if (!g.isObject() || !keys.equals(Set.of("adapter", "path", "value", "reason"))) {
                throw bad(name, where + ": a gate is exactly {adapter, path, value, reason}");
            }
            Adapter adapter = adapters.get(g.path("adapter").asText());
            if (adapter == null || !g.path("adapter").isTextual()) {
                throw bad(name, where + ": there is no such adapter");
            }
            String path = g.path("path").asText();
            JsonNode values = g.path("path").isTextual() ? enumAt(adapter.config(), path) : null;
            JsonNode value = g.path("value");
            boolean holds = false;
            for (JsonNode v : values == null ? List.<JsonNode>of() : values) {
                holds |= v.equals(value);
            }
            if (!holds) {
                throw bad(name, where + ": not an enum of its config that holds " + value);
            }
            String reason = g.path("reason").isTextual() ? g.path("reason").asText() : "";
            if (reason.isBlank() || reason.length() > 200) {
                throw bad(name, where + ": its reason is 1 to 200 characters");
            }
            Set<JsonNode> set = gated.computeIfAbsent(adapter.id() + " " + path, k -> new HashSet<>());
            if (!set.add(value)) {
                throw bad(name, where + ": " + value + " is gated twice");
            }
            boolean every = true;
            for (JsonNode v : values) {
                every &= set.contains(v);
            }
            if (every) {
                throw bad(name, where + ": every value of the enum is gated, so no node could take one");
            }
            gates.add(new Gate(adapter.id(), path, value.deepCopy(), reason));
        }
        return List.copyOf(gates);
    }

    /** The enum a config schema holds at a pointer through its properties, or null. */
    private static JsonNode enumAt(JsonNode schema, String path) {
        if (!path.startsWith("/")) {
            return null;
        }
        JsonNode at = schema;
        for (String token : path.substring(1).split("/", -1)) {
            String key = token.replace("~1", "/").replace("~0", "~");
            JsonNode properties = at.path("properties");
            at = properties.isObject() && properties.has(key) ? properties.get(key) : null;
            if (at == null) {
                return null;
            }
        }
        JsonNode values = at.path("enum");
        return values.isArray() ? values : null;
    }

    /**
     * The manifest as the agent's template quotes it (agent.v2 on): the layouts, then each adapter with its version, its
     * summary, the engine exports it wraps, its config schema as compact JSON, each value it gates as not available yet
     * with the way out (Q80), and its ports. The same bytes every time, so every call sends the same system message.
     */
    public String describe() {
        StringBuilder s = new StringBuilder("Adapters ").append(version).append(", manifest ").append(HASH, 0, 12)
                .append(".\n\nBuffer layouts (a buffer's layout pins its stride):\n");
        for (Iterator<Map.Entry<String, JsonNode>> it = source.path("layouts").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            Integer stride = layouts.get(e.getKey());
            s.append("- ").append(e.getKey()).append(": ").append(stride == null ? "the strideFloats the buffer declares" : stride + " floats an element")
                    .append(". ").append(e.getValue().path("summary").asText()).append('\n');
        }
        for (JsonNode a : source.path("adapters")) {
            Adapter adapter = adapters.get(a.path("id").asText());
            List<String> symbols = new ArrayList<>();
            a.path("symbols").forEach(x -> symbols.add(x.asText()));
            List<String> inputs = new ArrayList<>();
            for (InputPort p : adapter.inputs()) {
                inputs.add(p.name() + " (" + p.kind() + (p.layouts().isEmpty() ? "" : " of layout " + String.join(" or ", p.layouts()))
                        + ", " + p.min() + " to " + p.max() + ")");
            }
            List<String> outputs = new ArrayList<>();
            for (OutputPort p : adapter.outputs()) {
                outputs.add(p.name() + " (" + p.kind() + (p.layoutFrom() == null ? "" : "; its layout is config." + p.layoutFrom())
                        + (p.strideFrom() == null ? "" : ", its stride config." + p.strideFrom()) + ")");
            }
            s.append("\n### ").append(adapter.id()).append(", version ").append(adapter.version()).append('\n')
                    .append(a.path("summary").asText()).append('\n')
                    .append("- family ").append(adapter.family()).append("; wraps ")
                    .append(symbols.isEmpty() ? "no engine export" : String.join(", ", symbols)).append('\n')
                    .append("- config: ").append(adapter.config().toString()).append('\n');
            for (Gate g : unavailable) {
                if (g.adapter().equals(adapter.id())) {
                    s.append("- not available yet, so refused: config ").append(g.path()).append(' ').append(g.value()).append(": ")
                            .append(g.reason()).append('\n');
                }
            }
            s.append("- inputs: ").append(inputs.isEmpty() ? "none" : String.join("; ", inputs)).append('\n')
                    .append("- outputs: ").append(outputs.isEmpty() ? "none" : String.join("; ", outputs)).append('\n');
        }
        return s.toString().stripTrailing();
    }

    /** Throws unless every schema node uses only the subset's keywords and closes its objects. */
    private static void strictSubset(JsonNode node, String at, String name) {
        for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) {
            String key = it.next();
            if (!KEYWORDS.contains(key)) {
                throw bad(name, "\"" + key + "\" at " + at + " is a keyword the strict-subset validator does not implement");
            }
        }
        if (node.has("properties") && !(node.path("additionalProperties").isBoolean() && !node.path("additionalProperties").asBoolean())) {
            throw bad(name, "the object at " + at + " is not closed (additionalProperties: false)");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = node.path("properties").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            strictSubset(e.getValue(), at + "/" + e.getKey(), name);
        }
        if (node.has("items")) {
            strictSubset(node.path("items"), at + "/items", name);
        }
        int i = 0;
        for (JsonNode branch : node.path("anyOf")) {
            strictSubset(branch, at + "/anyOf/" + i++, name);
        }
    }

    private static IllegalStateException bad(String name, String what) {
        return new IllegalStateException(name + ": " + what);
    }

    private static JsonNode tree(ObjectMapper json, String text) {
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("adapters/descriptors.json is not JSON: " + e.getOriginalMessage(), e);
        }
    }

    public String version() {
        return version;
    }

    /** The adapter of this id, or null. */
    public Adapter adapter(String id) {
        return adapters.get(id);
    }

    public Map<String, Adapter> adapters() {
        return adapters;
    }

    /** The pinned layout's floats an element; null for f32, which declares its own; absent for an unpinned name. */
    public Map<String, Integer> layouts() {
        return layouts;
    }

    /** The values the manifest gates as not available yet (Q80), in its order. */
    public List<Gate> unavailable() {
        return unavailable;
    }
}
