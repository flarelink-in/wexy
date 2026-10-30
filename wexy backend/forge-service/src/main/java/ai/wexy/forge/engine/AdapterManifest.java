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
 * of a known kind and count, and every layout key an enum of pinned layouts. The program check of {@code agent-action.v2}
 * holds each adapter node to it (EA3.6).
 */
public final class AdapterManifest {

    /** sha256 of descriptors.json with LF line ends; the frontend's EA-A1 pins the same (10-30, after Q77). */
    public static final String HASH = "1de4e9b80b3d604f712cac856a17e58b66a00cc0d7a981cf88e65fd5fd87ba64";

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

    private final String version;
    private final Map<String, Adapter> adapters;
    /** Each pinned layout's floats an element; null when the node declares its own (f32). */
    private final Map<String, Integer> layouts;
    /** The manifest as read, for {@link #describe()}: its summaries and symbols are for the model, not the checks. */
    private final JsonNode source;

    private AdapterManifest(String version, Map<String, Adapter> adapters, Map<String, Integer> layouts, JsonNode source) {
        this.version = version;
        this.adapters = adapters;
        this.layouts = layouts;
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
        return new AdapterManifest(name, Collections.unmodifiableMap(adapters), Collections.unmodifiableMap(layouts), m.deepCopy());
    }

    /**
     * The manifest as the agent's template quotes it (agent.v2): the layouts, then each adapter with its version, its
     * summary, the engine exports it wraps, its config schema as compact JSON and its ports. The same bytes every time,
     * so every call sends the same system message.
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
                    .append("- config: ").append(adapter.config().toString()).append('\n')
                    .append("- inputs: ").append(inputs.isEmpty() ? "none" : String.join("; ", inputs)).append('\n')
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
}
