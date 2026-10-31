package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.schemas.JsonSchemas;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * EA-C1 on {@code agent-action.v2} (EA3.6; the agent-loop design §8, §12): the program check passes the mock's program
 * of adapter nodes with no finding; refuses v1's raw calls at the boundary, never coerces them; checks the design's
 * names; carries the node check's findings at their paths; and holds a program of nodes to v1's completeness rules,
 * restated: a buffer a draw reads is filled, an animated design moves what it draws, and no reserved word names an entry.
 */
class ProgramCheckTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final EngineBundle BUNDLE = EngineBundle.load(JSON);
    static final AdapterManifest MANIFEST = AdapterManifest.load(JSON);
    static final JsonSchemas SCHEMAS = new JsonSchemas();

    private final ProgramCheck check = new ProgramCheck(BUNDLE, MANIFEST);

    static JsonNode read(String resource) {
        try {
            return JSON.readTree(new ClassPathResource(resource).getContentAsString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** A complete program, the mock's: uploaded blocks drawn as lit cubes, under a film look. Still. */
    static ObjectNode valid() {
        return (ObjectNode) read("mock/agent/program.json");
    }

    static ArrayNode nodes(ObjectNode action) {
        return (ArrayNode) action.path("program").path("nodes");
    }

    static ObjectNode node(ObjectNode action, String id) {
        for (JsonNode n : nodes(action)) {
            if (id.equals(n.path("id").asText())) {
                return (ObjectNode) n;
            }
        }
        throw new AssertionError("no node " + id);
    }

    /** Sets one key of a node's config, which stays JSON text. */
    static void config(ObjectNode action, String id, String key, Object value) {
        ObjectNode n = node(action, id);
        try {
            ObjectNode config = (ObjectNode) JSON.readTree(n.path("config").asText());
            config.set(key, JSON.valueToTree(value));
            n.put("config", JSON.writeValueAsString(config));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** Adds a node; its inputs as (port, nodeId, output) triples. */
    static ObjectNode add(ObjectNode action, String id, String adapterId, Map<String, Object> config, String... inputs) {
        ObjectNode n = NodeCheckTest.node(id, adapterId, config, (Object[]) inputs);
        nodes(action).add(n);
        return n;
    }

    /** A compute stage of the given phase that writes the buffer {@code into}. */
    static ObjectNode stage(ObjectNode action, String id, String phase, String into) {
        return add(action, id, "ng.compute.stage", Map.of("module", "motion", "entry", "advance", "workgroupSize", 64, "invocations", 64,
                "phase", phase), "writes", into, "buffer");
    }

    static ObjectNode animated() {
        ObjectNode a = valid();
        ((ObjectNode) a.path("design")).put("animated", true);
        return a;
    }

    /** Each finding as {@code level code @ path}. */
    static List<String> found(List<Finding> findings) {
        return findings.stream().map(f -> f.level() + " " + f.code() + " @ " + f.path()).toList();
    }

    @Test
    void theMocksTurnIsValidAndItsProgramPassesWithNoFinding() {
        JsonNode read = read("mock/agent/need-context.json");
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, read)).isEmpty();
        assertThat(read.path("kind").asText()).isEqualTo("need_context");

        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, valid())).isEmpty();
        assertThat(check.check(valid())).isEmpty();
        assertThat(ProgramCheck.passes(check.check(valid()))).isTrue();
        assertThat(nodes(valid())).extracting(n -> n.path("adapterId").asText()).containsExactly("ng.buffer.storage",
                "ng.geometry.primitive", "ng.material.stock", "ng.light.rig", "ng.render.mesh_batch", "ng.post.chain");
    }

    @Test
    void theSchemaNamesTheManifestsAdaptersAndKeepsWithinTheNodeChecksLimits() {
        JsonNode node = SCHEMAS.schema(JsonSchemas.AGENT_ACTION).at("/properties/program/anyOf/0/properties/nodes");
        List<String> ids = new ArrayList<>();
        node.at("/items/properties/adapterId/enum").forEach(id -> ids.add(id.asText()));

        assertThat(ids).containsExactlyElementsOf(MANIFEST.adapters().keySet());
        assertThat(node.path("maxItems").asInt()).isPositive().isLessThanOrEqualTo(NodeCheck.MAX_NODES);
        assertThat(node.at("/items/properties/config/maxLength").asInt()).isEqualTo(NodeCheck.CONFIG_CHARS);
        assertThat(node.at("/items/properties/inputs/maxItems").asInt()).isEqualTo(NodeCheck.MAX_INPUTS);
        assertThat(node.at("/items/required")).extracting(JsonNode::asText).containsExactlyElementsOf(NodeCheck.NODE_KEYS);
    }

    @Test
    void aV1ProgramIsRefusedAtTheBoundaryNeverCoerced() throws Exception {
        // v1's complete program (the retired check passes it): the v2 schema refuses it, and so does the check.
        ObjectNode v1 = RawCallCheckTest.valid();
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, v1)).isNotEmpty();
        assertThat(found(check.check(v1))).containsExactly("fail nodes @ /program/nodes");
        for (String id : List.of("block-film", "galaxy", "foggy-dusk")) {
            assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, RawCallCheckTest.plan(id))).as(id).isNotEmpty();
        }

        // A v1 object among the nodes is named for what it is.
        ObjectNode mixed = valid();
        nodes(mixed).set(1, RawCallCheckTest.valid().path("program").path("objects").get(0));
        assertThat(found(check.check(mixed))).containsExactly("fail v1-object @ /program/nodes/1");
    }

    @Test
    void theDesignsNamesAreChecked() {
        ObjectNode a = valid();
        ArrayNode symbols = (ArrayNode) a.path("design").path("techniques").get(0).path("symbols");
        symbols.add("materials:Materials").add("core:PostChain").add("cameras:FlyCameraState").add("loaders:Animator");
        ((ArrayNode) a.path("design").path("techniques").get(1).path("docIds")).add("api/nothing");

        List<Finding> findings = check.check(a);

        assertThat(found(findings)).containsExactly("fail name @ /design/techniques/0/symbols/4", "fail name @ /design/techniques/0/symbols/5",
                "warn doc @ /design/techniques/1/docIds/1", "warn host @ /design/techniques", "fail external @ /design/techniques");
        assertThat(findings).anyMatch(f -> f.message().contains("PostChain is in post, not core"));
    }

    @Test
    void theNodeChecksFindingsComeAtTheirPathsAndHoldBackTheWholeProgramRules() {
        ObjectNode a = animated();
        ((ObjectNode) node(a, "terrain").path("inputs").get(2)).put("nodeId", "stones");
        node(a, "cube").put("adapterVersion", 2);

        // The node check's findings, and no completeness finding: a program whose nodes fail is not judged whole.
        assertThat(found(check.check(a))).containsExactly("fail adapter-version @ /program/nodes/1/adapterVersion");

        node(a, "cube").put("adapterVersion", 1);
        assertThat(found(check.check(a))).containsExactly("fail wire @ /program/nodes/4/inputs/2/nodeId");
    }

    @Test
    void aBufferADrawReadsIsFilled() {
        ObjectNode a = valid();
        config(a, "blocks", "init", "zero");
        assertThat(found(check.check(a))).containsExactly("fail buffer-producer @ /program/nodes/0");

        // Filled by a compute stage, in any phase: once at init is enough to fill it.
        stage(a, "place", "init", "blocks");
        assertThat(check.check(a)).isEmpty();

        // A stage that writes another buffer fills nothing the draw reads.
        ObjectNode b = valid();
        config(b, "blocks", "init", "zero");
        add(b, "scratch", "ng.buffer.storage", Map.of("elements", 64, "layout", "f32", "strideFloats", 4, "pingPong", false, "init", "zero"));
        stage(b, "place", "init", "scratch");
        assertThat(found(check.check(b))).containsExactly("fail buffer-producer @ /program/nodes/0");
    }

    @Test
    void anAnimatedDesignMovesWhatItDraws() {
        ObjectNode a = animated();
        assertThat(found(check.check(a))).containsExactly("fail motion-work @ /program/nodes");

        // Work once at init moves nothing.
        stage(a, "place", "init", "blocks");
        assertThat(found(check.check(a))).containsExactly("fail motion-work @ /program/nodes");

        // Work at fixedStep or frame on what is drawn does.
        for (String phase : List.of("fixedStep", "frame")) {
            ObjectNode moving = animated();
            stage(moving, "spin", phase, "blocks");
            assertThat(check.check(moving)).as(phase).isEmpty();
        }

        // Work each frame on a buffer nothing draws does not.
        ObjectNode aside = animated();
        add(aside, "scratch", "ng.buffer.storage", Map.of("elements", 64, "layout", "f32", "strideFloats", 4, "pingPong", false, "init", "zero"));
        stage(aside, "churn", "frame", "scratch");
        assertThat(found(check.check(aside))).containsExactly("fail motion-work @ /program/nodes");

        // A custom batch or a fullscreen module draws with the camera's simTime, so it can move what it draws.
        ObjectNode custom = animated();
        add(custom, "waves", "ng.render.custom_batch", Map.of("module", "sea", "vertexEntry", "swell", "fragmentEntry", "shade",
                "maxInstances", 1), "geometry", "cube", "geometry");
        assertThat(check.check(custom)).isEmpty();
        ObjectNode sky = animated();
        add(sky, "sky", "ng.render.fullscreen", Map.of("module", "sky", "fragmentEntry", "dusk"));
        assertThat(check.check(sky)).isEmpty();
    }

    @Test
    void noReservedWordNamesAnEntry() {
        ObjectNode a = valid();
        ObjectNode moving = stage(a, "spin", "frame", "blocks");
        add(a, "waves", "ng.render.custom_batch", Map.of("module", "sea", "vertexEntry", "filter", "fragmentEntry", "shade", "maxInstances", 1));
        moving.put("config", moving.path("config").asText().replace("\"advance\"", "\"move\""));

        List<Finding> findings = check.check(a);

        assertThat(found(findings)).containsExactly("fail reserved @ /program/nodes/6/config/entry",
                "fail reserved @ /program/nodes/7/config/vertexEntry");
        assertThat(findings.get(0).message()).isEqualTo("move is a reserved word in WGSL, so it cannot name an entry");
    }

    @Test
    void aProposalWithoutAProgramOrADesignFails() {
        ObjectNode a = valid();
        a.putNull("program");
        assertThat(found(check.check(a))).containsExactly("fail proposal @ /program");

        ObjectNode b = valid();
        b.putNull("design");
        assertThat(found(check.check(b))).containsExactly("fail proposal @ /design");
    }
}
