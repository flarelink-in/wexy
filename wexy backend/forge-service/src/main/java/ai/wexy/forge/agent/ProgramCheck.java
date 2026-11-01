package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.templates.WgslWords;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The pure check of a proposal (the agent-loop design §8; the tool the frontend's design calls {@code validate_program}),
 * on {@code agent-action.v2} since EA3.6: its design against K and H in the engine bundle, its program's adapter nodes
 * against the embedded adapter manifest. It judges:
 * <ul>
 *   <li>the design's names: every technique's symbol an export of its family, no family Wexy cannot run (a host family
 *       is a warning), every document in the bundle (a missing one is a warning);</li>
 *   <li>the nodes, by {@link NodeCheck}, the frontend's {@code checkNodes}: a program handed off is one the browser's own
 *       node check takes;</li>
 *   <li>once the nodes pass, v1's completeness rules restated for nodes: a buffer a draw reads is filled, by its upload
 *       (once the manifest no longer gates it, Q80) or by a compute stage that writes it; an animated design has a node
 *       that moves what is drawn, a compute stage
 *       at fixedStep or frame writing a buffer a draw reads, or a custom batch or fullscreen module, which can move with
 *       the camera's {@code simTime}; and no WGSL reserved word names an entry. The browser refuses more names (its
 *       built-ins, and the names the host generates); a program this passes can still fail its resolver.</li>
 *   <li>two of the browser's Tier-1 rules (2026-11-01: each of the first three live {@code agent.v3} hand-offs broke one,
 *       and the browser refused it, with no revision left to the turn): a module serves one node (its
 *       {@code deriveInterfaces}: two consumers, each with its own bindings, cannot share one body), and {@code after}
 *       orders two stages of one phase (its resolver). Held here, the turn's own revision answers them.</li>
 * </ul>
 * Paths are JSON pointers into the action ({@code /program/nodes/3/config/entry}). v1's rules over raw engine calls
 * retired with the contract they read ({@link RawCallCheck}).
 */
public final class ProgramCheck {

    /** The adapters that draw, each with the input port through which it reads a buffer. */
    static final Map<String, String> DRAW_READS = Map.of("ng.render.mesh_batch", "instances", "ng.render.custom_batch", "instances",
            "ng.render.fullscreen", "reads");
    /** The adapters that draw with an authored module, which reads the camera's simTime and can move what it draws. */
    static final Set<String> AUTHORED_DRAWS = Set.of("ng.render.custom_batch", "ng.render.fullscreen");
    /** The config keys that name a WGSL entry, by adapter. */
    static final Map<String, List<String>> ENTRIES = Map.of("ng.compute.stage", List.of("entry"),
            "ng.render.custom_batch", List.of("vertexEntry", "fragmentEntry"), "ng.render.fullscreen", List.of("fragmentEntry"));

    private final EngineBundle bundle;
    private final NodeCheck nodes;
    /**
     * How an unfilled buffer is filled, in the words the model reads in its revision: never by a value the manifest gates
     * (Q80), so Tier 2's lifting of upload's gate brings the advice back with no change here.
     */
    private final String fill;

    public ProgramCheck(EngineBundle bundle, AdapterManifest manifest) {
        this.bundle = bundle;
        this.nodes = new NodeCheck(manifest, bundle);
        boolean upload = manifest.unavailable().stream().noneMatch(g -> g.adapter().equals("ng.buffer.storage") && g.path().equals("/init")
                && "upload".equals(g.value().asText()));
        this.fill = upload ? "give it init upload, or wire it to the writes of a compute stage"
                : "wire it to the writes of a compute stage; seed it with one at init";
    }

    /** Whether a check's findings let the program be handed off: none fails. */
    public static boolean passes(List<Finding> findings) {
        return findings.stream().noneMatch(Finding::fails);
    }

    /** Every finding for one proposal (an {@code agent-action.v2} with its design and program): the design's, then the program's. */
    public List<Finding> check(JsonNode action) {
        List<Finding> out = new ArrayList<>();
        JsonNode design = action.path("design");
        JsonNode program = action.path("program");
        if (!design.isObject() || !program.isObject()) {
            out.add(Finding.fail("proposal", design.isObject() ? "/program" : "/design", "a proposal carries both a design and a program"));
            return out;
        }
        names(design, out);
        NodeCheck.Result checked = nodes.checked(program.path("nodes"));
        out.addAll(checked.findings());
        if (checked.findings().isEmpty()) {
            entries(checked.nodes(), out);
            tierOne(checked.nodes(), out);
            completeness(design, checked.nodes(), fill, out);
        }
        return out;
    }

    /**
     * The browser's rules on modules and order, at the browser's places: a module named by a second node fails at that
     * node's module, as {@code deriveInterfaces} names the later node; an {@code after} wired to a stage of another phase
     * fails at that input, as the resolver does.
     */
    private static void tierOne(List<NodeCheck.Node> nodes, List<Finding> out) {
        Map<String, NodeCheck.Node> owners = new HashMap<>();
        Map<String, NodeCheck.Node> byId = new HashMap<>();
        for (NodeCheck.Node n : nodes) {
            byId.put(n.id(), n);
        }
        for (NodeCheck.Node n : nodes) {
            if (!ENTRIES.containsKey(n.adapter().id())) {
                continue;
            }
            String module = n.config().path("module").asText();
            NodeCheck.Node first = owners.putIfAbsent(module, n);
            if (first != null) {
                out.add(Finding.fail("module-shared", "/program/nodes/" + n.index() + "/config/module", "module " + module + " serves "
                        + first.id() + " and " + n.id() + ": a module serves one node, so give " + n.id() + " a module of its own"));
            }
        }
        for (NodeCheck.Node n : nodes) {
            if (!"ng.compute.stage".equals(n.adapter().id())) {
                continue;
            }
            String phase = n.config().path("phase").asText();
            for (int j = 0; j < n.inputs().size(); j++) {
                NodeCheck.Input w = n.inputs().get(j);
                NodeCheck.Node before = "after".equals(w.port()) ? byId.get(w.nodeId()) : null;
                String theirs = before == null ? phase : before.config().path("phase").asText();
                if (!phase.equals(theirs)) {
                    out.add(Finding.fail("after-phase", "/program/nodes/" + n.index() + "/inputs/" + j, n.id() + " runs in " + phase + " and "
                            + w.nodeId() + " in " + theirs + ": after orders two stages of one phase, so drop it or give both one phase "
                            + "(init runs once, before any fixedStep or frame)"));
                }
            }
        }
    }

    private void names(JsonNode design, List<Finding> out) {
        Set<String> families = new TreeSet<>();
        JsonNode techniques = design.path("techniques");
        for (int i = 0; i < techniques.size(); i++) {
            JsonNode symbols = techniques.get(i).path("symbols");
            for (int j = 0; j < symbols.size(); j++) {
                String ref = symbols.get(j).asText();
                EngineBundle.Symbol s = bundle.symbols().get(ref);
                if (s == null) {
                    out.add(Finding.fail("name", "/design/techniques/" + i + "/symbols/" + j, ref + " is not an export of null-graph "
                            + bundle.engineVersion() + ": " + Declarations.unknownSymbol(bundle, ref)));
                } else {
                    families.add(s.family());
                }
            }
            JsonNode docs = techniques.get(i).path("docIds");
            for (int j = 0; j < docs.size(); j++) {
                if (!bundle.docs().containsKey(docs.get(j).asText())) {
                    out.add(Finding.warn("doc", "/design/techniques/" + i + "/docIds/" + j, "no document " + docs.get(j).asText() + " in the bundle"));
                }
            }
        }
        for (String id : families) {
            EngineBundle.Family family = bundle.families().get(id);
            if ("host".equals(family.use())) {
                out.add(Finding.warn("host", "/design/techniques", "the design uses " + id + ", which is the host's: " + family.reason()));
            } else if ("external".equals(family.use())) {
                out.add(Finding.fail("external", "/design/techniques", "the design uses " + id + ", which Wexy cannot run: " + family.reason()));
            }
        }
    }

    /** No WGSL reserved word names an entry: WGSL refuses it as any name (the browser refuses it too, among more). */
    private static void entries(List<NodeCheck.Node> nodes, List<Finding> out) {
        for (NodeCheck.Node n : nodes) {
            for (String key : ENTRIES.getOrDefault(n.adapter().id(), List.of())) {
                String entry = n.config().path(key).asText();
                if (WgslWords.RESERVED.contains(entry)) {
                    out.add(Finding.fail("reserved", "/program/nodes/" + n.index() + "/config/" + key, entry
                            + " is a reserved word in WGSL, so it cannot name an entry"));
                }
            }
        }
    }

    /** What a draw reads is filled; an animated design moves something drawn (v1's buffer-producer and motion-work). */
    private static void completeness(JsonNode design, List<NodeCheck.Node> nodes, String fill, List<Finding> out) {
        Set<String> drawn = new LinkedHashSet<>();
        for (NodeCheck.Node n : nodes) {
            String port = DRAW_READS.get(n.adapter().id());
            if (port != null) {
                n.inputs().stream().filter(w -> w.port().equals(port)).forEach(w -> drawn.add(w.nodeId()));
            }
        }
        Set<String> written = new HashSet<>();
        Set<String> moved = new HashSet<>();
        for (NodeCheck.Node n : nodes) {
            if (!"ng.compute.stage".equals(n.adapter().id())) {
                continue;
            }
            String phase = n.config().path("phase").asText();
            for (NodeCheck.Input w : n.inputs()) {
                if (w.port().equals("writes")) {
                    written.add(w.nodeId());
                    if (phase.equals("fixedStep") || phase.equals("frame")) {
                        moved.add(w.nodeId());
                    }
                }
            }
        }
        for (NodeCheck.Node n : nodes) {
            if (drawn.contains(n.id()) && !"upload".equals(n.config().path("init").asText()) && !written.contains(n.id())) {
                out.add(Finding.fail("buffer-producer", "/program/nodes/" + n.index(), n.id() + " is read to draw, but nothing fills it: " + fill));
            }
        }
        if (design.path("animated").asBoolean(false)) {
            boolean moves = drawn.stream().anyMatch(moved::contains) || nodes.stream().anyMatch(n -> AUTHORED_DRAWS.contains(n.adapter().id()));
            if (!moves) {
                out.add(Finding.fail("motion-work", "/program/nodes", "the design is animated, but nothing moves what is drawn: wire a compute "
                        + "stage at fixedStep or frame to write a buffer a draw reads, or draw with a custom batch or a fullscreen module, "
                        + "which can move with the camera's simTime"));
            }
        }
    }
}
