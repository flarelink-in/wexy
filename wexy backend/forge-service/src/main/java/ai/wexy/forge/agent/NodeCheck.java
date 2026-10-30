package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.ValidationMessage;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The program check of {@code agent-action.v2} (EA3.6; the frontend's engine-adapters design §16): each adapter node of a
 * program held to the embedded manifest and to H, by the rules of the frontend's {@code checkNodes}, so a program the
 * server hands off is one the browser's own check takes. A node is exactly {@code {id, adapterId, adapterVersion, config,
 * inputs}}. Its adapter and version are exact, and its family is one H lets resolve (statically). Its config is JSON text
 * of at most 4,096 UTF-16 units, parsed once and held to its adapter's closed schema, a canonical layout pinning its
 * stride. Each input names a real port, node and output of the port's kind and layout, and every port's count is in
 * range. A v1 object (symbol, member, args) is refused, never coerced. The browser repeats all of it and more (the
 * resolver, the checks of §7), and never takes this verdict for admission.
 */
public final class NodeCheck {

    static final int MAX_NODES = 64;
    static final int CONFIG_CHARS = 4_096;
    static final int MAX_INPUTS = 16;
    static final List<String> NODE_KEYS = List.of("id", "adapterId", "adapterVersion", "config", "inputs");
    static final Pattern NODE_ID = Pattern.compile("[a-z][A-Za-z0-9_-]{0,39}");
    static final Pattern PORT_NAME = Pattern.compile("[a-z][A-Za-z0-9_]{0,39}");
    /** H's statuses that resolve, statically (Q75 as decided); any other, and {@code unsupported}, refuses. */
    static final Set<String> STATIC_STATUSES = Set.of("unverified", "supported", "device-blocked");

    /** A node that passed on its own: where it is in the program, its adapter, its config parsed, its inputs. */
    public record Node(String id, int index, AdapterManifest.Adapter adapter, JsonNode config, List<Input> inputs) {
    }

    /** One input: this node's port, fed by another node's output. */
    public record Input(String port, String nodeId, String output) {
    }

    /** The nodes that passed on their own, and every finding; the nodes are the whole program only when nothing was found. */
    public record Result(List<Node> nodes, List<Finding> findings) {
    }

    private final AdapterManifest manifest;
    private final EngineBundle bundle;
    // JSON.parse refuses text after the value, and Jackson ignores it unless told: without this, "{…} junk" passed here
    // and failed in the browser.
    private final ObjectMapper json = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public NodeCheck(AdapterManifest manifest, EngineBundle bundle) {
        this.manifest = manifest;
        this.bundle = bundle;
    }

    /** Every finding for a program's nodes ({@code program.nodes}), each at its JSON pointer into the action. */
    public List<Finding> check(JsonNode nodes) {
        return checked(nodes).findings();
    }

    /** The same check, with the nodes it parsed, for the rules that read a whole program (ProgramCheck). */
    public Result checked(JsonNode nodes) {
        List<Finding> out = new ArrayList<>();
        List<Node> checked = new ArrayList<>();
        if (!nodes.isArray()) {
            out.add(Finding.fail("nodes", "/program/nodes", "the program's nodes are not a list"));
            return new Result(List.of(), out);
        }
        if (nodes.isEmpty() || nodes.size() > MAX_NODES) {
            out.add(Finding.fail("nodes", "/program/nodes", "a program has 1 to " + MAX_NODES + " nodes, not " + nodes.size()));
            return new Result(List.of(), out);
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < nodes.size(); i++) {
            JsonNode n = nodes.get(i);
            String at = "/program/nodes/" + i;
            if (!n.isObject()) {
                out.add(Finding.fail("node", at, "a node is not an object"));
                continue;
            }
            if (n.has("symbol") || n.has("member") || n.has("args")) {
                out.add(Finding.fail("v1-object", at, "an agent-action.v1 object (symbol, member, args) is not an adapter node; name an adapter instead"));
                continue;
            }
            List<String> extra = new ArrayList<>();
            for (Iterator<String> it = n.fieldNames(); it.hasNext(); ) {
                String key = it.next();
                if (!NODE_KEYS.contains(key)) {
                    extra.add(shown(key));
                }
            }
            List<String> missing = NODE_KEYS.stream().filter(k -> !n.has(k)).toList();
            if (!extra.isEmpty() || !missing.isEmpty()) {
                out.add(Finding.fail("node", at, "a node has exactly " + String.join(", ", NODE_KEYS)
                        + (extra.isEmpty() ? "" : "; not " + String.join(", ", extra.subList(0, Math.min(5, extra.size()))))
                        + (missing.isEmpty() ? "" : "; " + String.join(", ", missing) + " missing")));
                continue;
            }
            JsonNode idNode = n.path("id");
            if (!idNode.isTextual() || !NODE_ID.matcher(idNode.asText()).matches()) {
                out.add(Finding.fail("node-id", at + "/id", "a node id is 1 to 40 letters, digits, - or _, starting lower-case"));
                continue;
            }
            String id = idNode.asText();
            if (!seen.add(id)) {
                out.add(Finding.fail("node-id", at + "/id", "node id " + id + " is used twice"));
                continue;
            }
            AdapterManifest.Adapter adapter = n.path("adapterId").isTextual() ? manifest.adapter(n.path("adapterId").asText()) : null;
            if (adapter == null) {
                out.add(Finding.fail("adapter", at + "/adapterId", "no adapter " + shown(n.path("adapterId")) + "; the adapters are "
                        + String.join(", ", manifest.adapters().keySet())));
                continue;
            }
            if (!n.path("adapterVersion").isIntegralNumber() || n.path("adapterVersion").asLong() != adapter.version()) {
                out.add(Finding.fail("adapter-version", at + "/adapterVersion", adapter.id() + " is version " + adapter.version() + ", not "
                        + shown(n.path("adapterVersion")) + "; no other version is taken"));
                continue;
            }
            EngineBundle.Support support = bundle.support(adapter.family());
            String status = support == null ? null : support.status();
            if (status == null || !STATIC_STATUSES.contains(status)) {
                out.add(Finding.fail("family", at + "/adapterId", adapter.id() + "'s family " + adapter.family() + " is "
                        + (status == null ? "not in H" : status) + "; only " + String.join(", ", STATIC_STATUSES) + " resolve, and statically"));
                continue;
            }
            JsonNode configText = n.path("config");
            if (!configText.isTextual() || configText.asText().length() > CONFIG_CHARS) {
                out.add(Finding.fail("config", at + "/config", "config is JSON text of at most " + CONFIG_CHARS + " characters"));
                continue;
            }
            JsonNode config;
            try {
                config = json.readTree(configText.asText());
            } catch (JsonProcessingException e) {
                out.add(Finding.fail("config", at + "/config", "config is not JSON: " + shown(configText)));
                continue;
            }
            if (config == null || config.isMissingNode()) {
                out.add(Finding.fail("config", at + "/config", "config is not JSON: " + shown(configText)));
                continue;
            }
            List<String> problems = new ArrayList<>();
            for (ValidationMessage m : adapter.validator().validate(config)) {
                problems.add(m.getMessage());
            }
            if (!problems.isEmpty()) {
                problems.sort(String::compareTo);
                for (String p : problems.subList(0, Math.min(5, problems.size()))) {
                    out.add(Finding.fail("config-schema", at + "/config", adapter.id() + " config " + p));
                }
                continue;
            }
            // A canonical layout pins its stride: a buffer cannot claim instance14 and hold 24 floats an element.
            boolean strides = true;
            for (AdapterManifest.OutputPort o : adapter.outputs()) {
                if (o.layoutFrom() == null || o.strideFrom() == null) {
                    continue;
                }
                String layout = config.path(o.layoutFrom()).asText();
                Integer want = manifest.layouts().get(layout);
                if (want != null && config.path(o.strideFrom()).asInt() != want) {
                    out.add(Finding.fail("stride", at + "/config/" + o.strideFrom(), "layout " + layout + " is " + want + " floats an element, not "
                            + shown(config.path(o.strideFrom())) + "; only f32 takes the stride it declares"));
                    strides = false;
                }
            }
            if (!strides) {
                continue;
            }
            JsonNode inputs = n.path("inputs");
            if (!inputs.isArray() || inputs.size() > MAX_INPUTS) {
                out.add(Finding.fail("inputs", at + "/inputs", "inputs is a list of at most " + MAX_INPUTS));
                continue;
            }
            boolean wired = true;
            List<Input> list = new ArrayList<>();
            for (int j = 0; j < inputs.size(); j++) {
                JsonNode w = inputs.get(j);
                Set<String> keys = new HashSet<>();
                w.fieldNames().forEachRemaining(keys::add);
                if (!w.isObject() || !keys.equals(Set.of("port", "nodeId", "output"))
                        || !w.path("port").isTextual() || !w.path("nodeId").isTextual() || !w.path("output").isTextual()
                        || !PORT_NAME.matcher(w.path("port").asText()).matches() || !NODE_ID.matcher(w.path("nodeId").asText()).matches()
                        || !PORT_NAME.matcher(w.path("output").asText()).matches()) {
                    out.add(Finding.fail("input", at + "/inputs/" + j,
                            "an input is exactly {port, nodeId, output}: a port name, a node id and an output name, each 1 to 40 characters"));
                    wired = false;
                    continue;
                }
                list.add(new Input(w.path("port").asText(), w.path("nodeId").asText(), w.path("output").asText()));
            }
            if (wired) {
                checked.add(new Node(id, i, adapter, config, List.copyOf(list)));
            }
        }
        if (out.isEmpty()) {
            wire(checked, out);
        }
        return new Result(List.copyOf(checked), out);
    }

    /** Every input names a real port, node and output of the port's kind and layout; every port's count is in range. */
    private void wire(List<Node> nodes, List<Finding> out) {
        Map<String, Node> byId = new HashMap<>();
        for (Node n : nodes) {
            byId.put(n.id(), n);
        }
        for (Node n : nodes) {
            String at = "/program/nodes/" + n.index();
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (int j = 0; j < n.inputs().size(); j++) {
                Input w = n.inputs().get(j);
                String portName = w.port();
                String nodeId = w.nodeId();
                String outputName = w.output();
                AdapterManifest.InputPort port = n.adapter().input(portName);
                if (port == null) {
                    List<String> names = n.adapter().inputs().stream().map(AdapterManifest.InputPort::name).toList();
                    out.add(Finding.fail("port", at + "/inputs/" + j + "/port", n.adapter().id() + " has no input " + portName + "; its inputs are "
                            + (names.isEmpty() ? "none" : String.join(", ", names))));
                    continue;
                }
                counts.merge(port.name(), 1, Integer::sum);
                Node from = byId.get(nodeId);
                if (from == null) {
                    out.add(Finding.fail("wire", at + "/inputs/" + j + "/nodeId", "no node " + nodeId));
                    continue;
                }
                if (from == n) {
                    out.add(Finding.fail("wire", at + "/inputs/" + j + "/nodeId", "a node cannot take its own output"));
                    continue;
                }
                AdapterManifest.OutputPort output = from.adapter().output(outputName);
                if (output == null) {
                    out.add(Finding.fail("wire", at + "/inputs/" + j + "/output", nodeId + " (" + from.adapter().id() + ") has no output " + outputName));
                    continue;
                }
                if (!output.kind().equals(port.kind())) {
                    out.add(Finding.fail("wire", at + "/inputs/" + j, port.name() + " takes " + port.kind() + ", but " + nodeId + "." + outputName
                            + " is " + output.kind()));
                    continue;
                }
                String layout = output.layoutFrom() == null ? null : from.config().path(output.layoutFrom()).asText();
                if (!port.layouts().isEmpty() && (layout == null || !port.layouts().contains(layout))) {
                    out.add(Finding.fail("wire", at + "/inputs/" + j, port.name() + " takes " + String.join(" or ", port.layouts()) + " buffers, but "
                            + nodeId + " is " + (layout == null ? "of no layout" : layout) + "; no bridge is in Tier 1"));
                }
            }
            for (AdapterManifest.InputPort port : n.adapter().inputs()) {
                int c = counts.getOrDefault(port.name(), 0);
                if (c < port.min() || c > port.max()) {
                    out.add(Finding.fail("count", at + "/inputs", n.adapter().id() + "'s " + port.name() + " takes " + port.min() + " to " + port.max()
                            + " connections, not " + c));
                }
            }
        }
    }

    /** A model's value, short enough to quote in a finding. */
    private static String shown(Object v) {
        if (v instanceof JsonNode node) {
            if (node.isTextual()) {
                return shown(node.asText());
            }
            if (node.isNumber()) {
                return node.asText();
            }
            return node.isNull() || node.isMissingNode() ? "null" : node.getNodeType().name().toLowerCase();
        }
        String s = String.valueOf(v);
        return "\"" + (s.length() > 40 ? s.substring(0, 40) : s) + "\"";
    }
}
