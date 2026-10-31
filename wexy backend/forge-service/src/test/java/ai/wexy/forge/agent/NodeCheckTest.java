package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assumptions.assumeThat;

/**
 * EA-N (EA3.6; the frontend's engine-adapters design §16): the program check of {@code agent-action.v2}. The embedded
 * manifest is the frontend's, byte for byte and pinned; one program using all nine adapters passes; each way a node can
 * be wrong, the frontend's EA-A3, A5 and A6 among them, fails at its JSON pointer into the action. The frontend's own
 * check repeats all of this; the two must agree on what passes.
 */
class NodeCheckTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final EngineBundle BUNDLE = EngineBundle.load(JSON);
    static final AdapterManifest MANIFEST = AdapterManifest.load(JSON);
    static final Path FRONTEND = Path.of("../../wexy frontend/src/contract/adapters/descriptors.json");
    private final NodeCheck check = new NodeCheck(MANIFEST, BUNDLE);

    static ObjectNode node(String id, String adapterId, Map<String, Object> config, Object... inputs) {
        ObjectNode n = JSON.createObjectNode();
        n.put("id", id);
        n.put("adapterId", adapterId);
        n.put("adapterVersion", 1);
        try {
            n.put("config", JSON.writeValueAsString(config));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        ArrayNode list = n.putArray("inputs");
        for (int i = 0; i < inputs.length; i += 3) {
            list.addObject().put("port", (String) inputs[i]).put("nodeId", (String) inputs[i + 1]).put("output", (String) inputs[i + 2]);
        }
        return n;
    }

    /** The frontend's EA-A2 program: all nine adapters, each in a minimal valid variant. */
    static ArrayNode world() {
        ArrayNode w = JSON.createArrayNode();
        w.add(node("instances", "ng.buffer.storage", Map.of("elements", 64, "layout", "instance14", "strideFloats", 14, "pingPong", false, "init", "upload")));
        w.add(node("field", "ng.buffer.storage", Map.of("elements", 4096, "layout", "f32", "strideFloats", 4, "pingPong", true, "init", "zero")));
        w.add(node("move", "ng.compute.stage", Map.of("module", "motion", "entry", "advance", "workgroupSize", 64, "invocations", 64, "phase", "fixedStep"),
                "reads", "field", "buffer", "writes", "instances", "buffer"));
        w.add(node("cube", "ng.geometry.primitive", Map.of("shape", "cube", "size", 1, "segments", 3)));
        w.add(node("stone", "ng.material.stock", Map.of("kind", "lambert", "baseColor", List.of(0.6, 0.55, 0.5, 1))));
        w.add(node("sun", "ng.light.rig", Map.of("ambient", List.of(0.1, 0.1, 0.12),
                "directional", Map.of("direction", List.of(0.3, -1, 0.2), "color", List.of(1, 0.95, 0.85), "intensity", 2), "points", List.of())));
        w.add(node("blocks", "ng.render.mesh_batch", Map.of("maxInstances", 64),
                "geometry", "cube", "geometry", "material", "stone", "material", "instances", "instances", "buffer", "lights", "sun", "lights"));
        w.add(node("water", "ng.render.custom_batch", Map.of("module", "water", "vertexEntry", "wave", "fragmentEntry", "shade", "maxInstances", 1),
                "geometry", "cube", "geometry"));
        w.add(node("sky", "ng.render.fullscreen", Map.of("module", "sky", "fragmentEntry", "dusk")));
        w.add(node("look", "ng.post.chain", Map.of("effects", List.of(Map.of("effect", "Tonemap", "intensity", 1)))));
        return w;
    }

    @Test
    void theManifestIsTheFrontendsByteForByteAndChecksItself() throws Exception {
        String text = new ClassPathResource("adapters/descriptors.json").getContentAsString(StandardCharsets.UTF_8);
        assertThat(MANIFEST.adapters()).hasSize(9);
        assertThat(MANIFEST.adapter("ng.compute.stage").input("after").kind()).isEqualTo("stage");
        assertThat(MANIFEST.layouts()).containsEntry("instance14", 14).containsEntry("instance24", 24).containsKey("f32");
        assumeThat(Files.exists(FRONTEND)).as("the frontend repository is on this disk").isTrue();
        assertThat(text.replace("\r\n", "\n")).isEqualTo(Files.readString(FRONTEND).replace("\r\n", "\n"));
    }

    @Test
    void aProgramOfAllNineAdaptersPasses() {
        assertThat(check.check(world())).isEmpty();

        // What the whole-program rules read (ProgramCheck): each node parsed, in the program's order.
        NodeCheck.Result result = check.checked(world());
        assertThat(result.findings()).isEmpty();
        assertThat(result.nodes()).extracting(NodeCheck.Node::id)
                .containsExactly("instances", "field", "move", "cube", "stone", "sun", "blocks", "water", "sky", "look");
        assertThat(result.nodes().get(2).inputs()).containsExactly(new NodeCheck.Input("reads", "field", "buffer"),
                new NodeCheck.Input("writes", "instances", "buffer"));
        assertThat(result.nodes().get(2).config().path("phase").asText()).isEqualTo("fixedStep");
        assertThat(result.nodes().get(2).index()).isEqualTo(2);
    }

    private void fails(String label, Consumer<ArrayNode> change, String code, String path) {
        ArrayNode w = world();
        change.accept(w);
        List<Finding> found = check.check(w);
        assertThat(found).as(label).anySatisfy(f -> {
            assertThat(f.fails()).isTrue();
            assertThat(f.code()).isEqualTo(code);
            assertThat(f.path()).isEqualTo(path);
        });
    }

    @Test
    void eachWayANodeCanBeWrongFailsAtItsPath() throws Exception {
        fails("a v1 object", w -> w.set(3, JSON.createObjectNode().put("id", "cube").put("symbol", "geometry:Primitives").put("member", "createCube")),
                "v1-object", "/program/nodes/3");
        fails("an unknown adapter", w -> ((ObjectNode) w.get(3)).put("adapterId", "ng.render.anything"), "adapter", "/program/nodes/3/adapterId");
        fails("another version", w -> ((ObjectNode) w.get(3)).put("adapterVersion", 2), "adapter-version", "/program/nodes/3/adapterVersion");
        fails("an extra key", w -> ((ObjectNode) w.get(3)).put("call", "createCube"), "node", "/program/nodes/3");
        fails("config not JSON", w -> ((ObjectNode) w.get(3)).put("config", "{shape: cube"), "config", "/program/nodes/3/config");
        // JSON.parse refuses text after the value, so this must too (Jackson ignores it unless told).
        fails("config with text after it", w -> ((ObjectNode) w.get(3)).put("config", "{\"shape\":\"cube\",\"size\":1,\"segments\":3} junk"),
                "config", "/program/nodes/3/config");
        fails("config of two values", w -> ((ObjectNode) w.get(3)).put("config", "{\"shape\":\"cube\",\"size\":1,\"segments\":3}{}"),
                "config", "/program/nodes/3/config");
        fails("config an object", w -> ((ObjectNode) w.get(3)).set("config", JSON.createObjectNode().put("shape", "cube")), "config", "/program/nodes/3/config");
        fails("config past its characters", w -> ((ObjectNode) w.get(3)).put("config", "{\"pad\":\"" + "x".repeat(4_100) + "\"}"), "config", "/program/nodes/3/config");
        fails("an extra config key", w -> ((ObjectNode) w.get(3)).put("config", "{\"shape\":\"cube\",\"size\":1,\"segments\":3,\"method\":\"createCube\"}"),
                "config-schema", "/program/nodes/3/config");
        fails("a shape that is not one", w -> ((ObjectNode) w.get(3)).put("config", "{\"shape\":\"teapot\",\"size\":1,\"segments\":3}"),
                "config-schema", "/program/nodes/3/config");
        fails("a duplicate id", w -> ((ObjectNode) w.get(4)).put("id", "cube"), "node-id", "/program/nodes/4/id");
        fails("a port the adapter lacks", w -> ((ArrayNode) w.get(6).get("inputs")).addObject().put("port", "shadow").put("nodeId", "sun").put("output", "lights"),
                "port", "/program/nodes/6/inputs/4/port");
        fails("a dangling node", w -> ((ObjectNode) w.get(6).get("inputs").get(0)).put("nodeId", "sphere"), "wire", "/program/nodes/6/inputs/0/nodeId");
        fails("a port of another kind", w -> ((ObjectNode) w.get(6).get("inputs").get(1)).put("nodeId", "cube").put("output", "geometry"),
                "wire", "/program/nodes/6/inputs/1");
        fails("24-float instances into a stock batch", w -> ((ObjectNode) w.get(0)).put("config",
                "{\"elements\":64,\"layout\":\"instance24\",\"strideFloats\":24,\"pingPong\":false,\"init\":\"upload\"}"), "wire", "/program/nodes/6/inputs/2");
        fails("a required port left empty", w -> ((ArrayNode) w.get(6).get("inputs")).remove(1), "count", "/program/nodes/6/inputs");
        fails("a node fed by itself", w -> ((ObjectNode) w.get(2).get("inputs").get(0)).put("nodeId", "move"), "wire", "/program/nodes/2/inputs/0/nodeId");
        // The EA3.1 review: a canonical layout pins its stride.
        fails("instance14 with 24 floats", w -> ((ObjectNode) w.get(0)).put("config",
                "{\"elements\":64,\"layout\":\"instance14\",\"strideFloats\":24,\"pingPong\":false,\"init\":\"zero\"}"), "stride", "/program/nodes/0/config/strideFloats");
        // EA-A6: a model's text is quoted short.
        ArrayNode longId = world();
        ((ObjectNode) longId.get(3)).put("adapterId", "x".repeat(10_000));
        assertThat(check.check(longId)).allSatisfy(f -> assertThat(f.message().length()).isLessThan(400));
        // Q77: after takes another stage's done in the same program.
        ArrayNode ordered = world();
        ((ArrayNode) ordered.get(2).get("inputs")).addObject().put("port", "after").put("nodeId", "instances").put("output", "buffer");
        assertThat(check.check(ordered)).anySatisfy(f -> assertThat(f.path()).isEqualTo("/program/nodes/2/inputs/2"));
    }
}
