package ai.wexy.forge.agent;

import ai.wexy.forge.engine.EngineBundle;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * <b>Retired with {@code agent-action.v1} (EA3.6), with {@link RawCallCheck}:</b> v1's test, unchanged but for the
 * schema it reads (v1's own; the service loads v2) and the mock's turn (now v2's, in ProgramCheckTest).
 *
 * <p>EA-C1 (the agent-loop design §8, §12): the program check passes a complete program with no finding, catches each
 * rule's failure and accepts what satisfies it, and finds in the paper test's three live plans what reading them found.
 *
 * <p>The three plans (`resources/agent/plans/`) are Spark's answers of 2026-10-29 (the frontend's engine-aware design,
 * Results), converted mechanically from paper-action.v1: each free {@code config} became {@code args} named by the
 * call's declared parameters (the whole options object to its options parameter; keys that name parameters as their
 * own arguments; three old positional arguments with invented names mapped by meaning), and {@code animated} set from
 * each design's own motion text (galaxy true; the others false).
 */
class RawCallCheckTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final EngineBundle BUNDLE = EngineBundle.load(JSON);
    static final JsonSchema V1 = v1();

    private final RawCallCheck check = new RawCallCheck(BUNDLE);

    static JsonSchema v1() {
        try {
            String text = new ClassPathResource("schemas/agent-action.v1.json").getContentAsString(StandardCharsets.UTF_8);
            return JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(JSON.readTree(text));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    static Set<?> schemaProblems(JsonNode action) {
        return V1.validate(action);
    }

    /** A complete program: a lit batch drawn from uploaded instances, under a film grain. Every name and argument real. */
    static final String VALID = """
            {"kind":"propose_design_and_program","context":null,
             "design":{"intent":"Blocks under a sepia film.","interpretation":null,"assumptions":[],
              "visualElements":[{"name":"terrain","description":"cubes"}],"motion":"still","animated":false,
              "techniques":[{"purpose":"draw the blocks","symbols":["core:NullGraph","materials:LambertMaterial","materials:buildLambertShader"],"docIds":["api/core","api/materials"]},
                            {"purpose":"age the film","symbols":["post:PostChain","post:FilmGrain"],"docIds":["api/post"]}],
              "resourceFlow":[],"cameraAndTiming":"a slow orbit","controls":[],"successCriteria":["blocks stay readable"],"unresolved":[]},
             "program":{
              "objects":[
               {"id":"pass","symbol":"core:NullGraph","member":"createPass","purpose":"the scene","args":[{"param":"config","value":"{\\"name\\":\\"scene\\",\\"isMainScreenPass\\":false}"}],"inputs":[]},
               {"id":"shader","symbol":"materials:buildLambertShader","member":null,"purpose":"lit blocks","args":[{"param":"config","value":"{\\"useSkinning\\":false}"}],"inputs":[]},
               {"id":"batch","symbol":"core:NullGraph","member":"createBatch","purpose":"the blocks","args":[{"param":"pass","value":"\\"pass\\""},{"param":"config","value":"{\\"shaderCode\\":\\"shader\\",\\"strideFloats\\":14,\\"maxInstances\\":64}"}],"inputs":["pass","shader","instances"]},
               {"id":"material","symbol":"materials:LambertMaterial","member":null,"purpose":"diffuse","args":[{"param":"options","value":"{}"}],"inputs":["batch"]},
               {"id":"upload","symbol":"core:NullGraph","member":"updateBatchData","purpose":"place the blocks","args":[{"param":"batch","value":"\\"batch\\""},{"param":"rawData","value":"\\"instances\\""},{"param":"instanceCount","value":"64"}],"inputs":["batch","instances"]},
               {"id":"grain","symbol":"post:FilmGrain","member":null,"purpose":"grain","args":[{"param":"opts","value":"{\\"intensity\\":0.1}"}],"inputs":[]},
               {"id":"chain","symbol":"post:PostChain","member":null,"purpose":"the look","args":[{"param":"config","value":"{\\"outputToScreen\\":true}"}],"inputs":["pass"]},
               {"id":"setChain","symbol":"post:PostChain","member":"setChain","purpose":"the order","args":[{"param":"effects","value":"[\\"grain\\"]"}],"inputs":["chain","grain"]}],
              "resources":[{"id":"instances","kind":"storage_buffer","purpose":"blocks","layout":"14 floats","strideFloats":14,"count":64}],
              "modules":[],
              "schedule":[{"id":"draw","kind":"render","objectId":"pass","when":"frame","required":true,"reads":["instances"],"writes":[]},
                          {"id":"look","kind":"post","objectId":"chain","when":"frame","required":true,"reads":[],"writes":[]}],
              "lifecycle":{"init":[],"fixedStep":[],"frame":[],"resize":[],"dispose":[]},
              "output":{"color":"chain","colorSpace":"srgb","depth":true},"controls":[]},
             "modules":null,"revision":null,"question":null,"finish":null}""";

    static ObjectNode valid() {
        try {
            return (ObjectNode) JSON.readTree(VALID);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    static ArrayNode objects(ObjectNode action) {
        return (ArrayNode) action.path("program").path("objects");
    }

    static ObjectNode object(ObjectNode action, String id) {
        for (JsonNode o : objects(action)) {
            if (id.equals(o.path("id").asText())) {
                return (ObjectNode) o;
            }
        }
        throw new AssertionError("no object " + id);
    }

    static void removeObject(ObjectNode action, String id) {
        ArrayNode list = objects(action);
        for (int i = 0; i < list.size(); i++) {
            if (id.equals(list.get(i).path("id").asText())) {
                list.remove(i);
                return;
            }
        }
    }

    static ObjectNode addObject(ObjectNode action, String id, String symbol, String member) {
        ObjectNode o = objects(action).addObject();
        o.put("id", id).put("symbol", symbol).put("purpose", "test");
        if (member == null) {
            o.putNull("member");
        } else {
            o.put("member", member);
        }
        o.putArray("args");
        o.putArray("inputs");
        return o;
    }

    static void arg(ObjectNode o, String param, String value) {
        ArrayNode args = (ArrayNode) o.path("args");
        for (int i = 0; i < args.size(); i++) {
            if (param.equals(args.get(i).path("param").asText())) {
                ((ObjectNode) args.get(i)).put("value", value);
                return;
            }
        }
        args.addObject().put("param", param).put("value", value);
    }

    /** Each finding as {@code level code @ path}. */
    static List<String> found(List<Finding> findings) {
        return findings.stream().map(f -> f.level() + " " + f.code() + " @ " + f.path()).toList();
    }

    static JsonNode plan(String id) throws Exception {
        return JSON.readTree(new ClassPathResource("agent/plans/" + id + ".json").getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    void aCompleteProgramPassesWithNoFindingAndFitsTheSchema() {
        assertThat(schemaProblems(valid())).isEmpty();
        assertThat(check.check(valid())).isEmpty();
        assertThat(RawCallCheck.passes(check.check(valid()))).isTrue();
    }

    @Test
    void namesMembersAndFamiliesAreChecked() {
        ObjectNode a = valid();
        ((ArrayNode) a.path("design").path("techniques").get(0).path("symbols")).add("materials:Materials").add("core:PostChain");
        object(a, "batch").put("member", "createMeshBatch");
        addObject(a, "anim", "loaders:Animator", null);
        addObject(a, "fly", "cameras:FlyCameraState", null);

        List<Finding> findings = check.check(a);

        assertThat(found(findings)).contains("fail name @ design.techniques[0].symbols[3]", "fail name @ design.techniques[0].symbols[4]",
                "fail member @ program.objects.batch", "warn host @ program", "fail external @ program");
        assertThat(findings).anyMatch(f -> f.message().contains("PostChain is in post, not core"));
        assertThat(findings).anyMatch(f -> f.message().contains("core:NullGraph declares no member createMeshBatch"));
    }

    @Test
    void argumentsAreCheckedAgainstTheDeclaredParametersAndOptionsTypesNested() {
        ObjectNode a = valid();
        arg(object(a, "batch"), "shader", "\"shader\"");
        arg(object(a, "batch"), "config", "{\"shaderCode\":\"shader\",\"strideFloats\":14,\"maxInstances\":64,\"shader\":\"x\"}");
        ObjectNode lights = addObject(a, "lights", "lights:LightSystem", null);
        arg(lights, "config", "{\"technique\":\"standard\",\"capacity\":{\"directional\":1}}");
        arg(object(a, "grain"), "opts", "{not json");

        List<Finding> findings = check.check(a);

        assertThat(found(findings)).contains("fail arg-param @ program.objects.batch.args.shader",
                "fail arg-key @ program.objects.batch.args.config.shader",
                "fail arg-required @ program.objects.lights.args.config.capacity",
                "fail arg-value @ program.objects.grain.args.opts");
        assertThat(findings).anyMatch(f -> f.message().equals("core:NullGraph.createBatch has no parameter shader; its parameters are pass, config"));
        assertThat(findings).anyMatch(f -> f.message().equals("LightSystemCapacity requires point, spot"));
    }

    @Test
    void aRequiredOptionsArgumentMustBeGiven() {
        ObjectNode a = valid();
        ((ArrayNode) object(a, "batch").path("args")).remove(1);

        assertThat(check.check(a)).anyMatch(f -> f.code().equals("arg-missing") && f.path().equals("program.objects.batch.args")
                && f.message().startsWith("core:NullGraph.createBatch needs its config (PipelineConfig, which requires shaderCode, strideFloats, maxInstances"));
    }

    @Test
    void aBatchNamesItsShaderInItsConfig() {
        ObjectNode a = valid();
        arg(object(a, "batch"), "config", "{\"strideFloats\":14,\"maxInstances\":64}");

        // An input that builds a shader is not enough: PipelineConfig requires shaderCode (gate A).
        assertThat(found(check.check(a))).contains("fail batch-shader @ program.objects.batch.args.config");
    }

    @Test
    void aBufferADrawReadsNeedsAProducer() {
        ObjectNode a = valid();
        removeObject(a, "upload");
        assertThat(found(check.check(a))).contains("fail buffer-producer @ program.resources.instances");

        ObjectNode stage = addObject(a, "move", "core:NullGraph", "createComputeStage");
        arg(stage, "config", "{\"name\":\"move\",\"shaderCode\":\"step\"}");
        ((ArrayNode) stage.path("inputs")).add("instances");
        // A compute stage is not a producer until the schedule runs it, writing the buffer (gate A).
        assertThat(found(check.check(a))).contains("fail buffer-producer @ program.resources.instances");

        ObjectNode step = ((ArrayNode) a.path("program").path("schedule")).addObject();
        step.put("id", "step").put("kind", "compute").put("objectId", "move").put("when", "frame").put("required", true);
        step.putArray("reads");
        step.putArray("writes").add("instances");
        assertThat(found(check.check(a))).doesNotContain("fail buffer-producer @ program.resources.instances");
    }

    @Test
    void aPostChainNeedsSetChain() {
        ObjectNode a = valid();
        removeObject(a, "setChain");

        assertThat(found(check.check(a))).contains("fail chain-set @ program.objects.chain");
    }

    @Test
    void anAnimatedDesignNeedsWorkThatMovesIt() {
        ObjectNode a = valid();
        ((ObjectNode) a.path("design")).put("animated", true);
        assertThat(found(check.check(a))).contains("fail motion-work @ program.schedule");

        ObjectNode step = ((ArrayNode) a.path("program").path("schedule")).addObject();
        step.put("id", "spin").put("kind", "upload").put("objectId", "upload").put("when", "fixed_step").put("required", true);
        step.putArray("reads");
        step.putArray("writes").add("instances");
        assertThat(found(check.check(a))).doesNotContain("fail motion-work @ program.schedule");
    }

    @Test
    void moduleNamesBindGroupsAndTheStockStrideAreChecked() {
        ObjectNode a = valid();
        ArrayNode modules = (ArrayNode) a.path("program").path("modules");
        ObjectNode drift = modules.addObject();
        drift.put("id", "drift").put("stage", "compute").put("usedBy", "batch").put("entry", "move")
                .put("signature", "@compute @workgroup_size(64) fn move(@builtin(global_invocation_id) target: vec3u)").put("purpose", "x");
        drift.putArray("bindings").addObject().put("group", 1).put("binding", 0).put("resource", "state");
        ObjectNode shade = modules.addObject();
        shade.put("id", "shade").put("stage", "fragment").put("usedBy", "batch").put("entry", "shade_main")
                .put("signature", "fn shade_main(uv: vec2f) -> vec4f").put("purpose", "x");
        ArrayNode bindings = shade.putArray("bindings");
        bindings.addObject().put("group", 2).put("binding", 0).put("resource", "noise");
        bindings.addObject().put("group", 0).put("binding", 0).put("resource", "cameraUniform");
        bindings.addObject().put("group", 5).put("binding", 0).put("resource", "x");
        ((ObjectNode) a.path("program").path("resources").get(0)).put("strideFloats", 24);

        List<String> found = found(check.check(a));

        assertThat(found).contains("fail reserved @ program.modules.drift", "warn group @ program.modules.drift",
                "warn group @ program.modules.shade", "fail group @ program.modules.shade", "fail stride @ program.resources.instances");
        assertThat(found.stream().filter(f -> f.equals("fail reserved @ program.modules.drift")).count()).isEqualTo(2);
        assertThat(found.stream().filter(f -> f.equals("warn group @ program.modules.shade")).count()).isEqualTo(1);
        assertThat(RawCallCheck.moduleNames("main", "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u)"))
                .containsExactly("main", "gid");
    }

    @Test
    void aReferenceToNothingFailsAndATwiceNamedObjectFails() {
        ObjectNode a = valid();
        ((ArrayNode) object(a, "batch").path("inputs")).add("ghost");
        addObject(a, "pass", "core:NullGraph", "createPass");

        ObjectNode orphan = schedule(a, "compute", "nobody", null);
        orphan.put("id", "orphan");
        ObjectNode stray = ((ArrayNode) a.path("program").path("modules")).addObject();
        stray.put("id", "stray").put("stage", "fragment").put("usedBy", "nobody").put("entry", "shade")
                .put("signature", "fn shade() -> vec4f").put("purpose", "x");
        stray.putArray("bindings");

        // A program whose inputs, scheduled objects or modules' users name nothing cannot be built: a failure, not a
        // warning (gate A).
        assertThat(found(check.check(a))).contains("fail ref @ program.objects.batch", "fail id @ program.objects.pass",
                "fail ref @ program.schedule.orphan", "fail ref @ program.modules.stray");
    }

    /** Adds frame work of {@code kind} by {@code objectId}, writing {@code writes} (none when null). */
    static ObjectNode schedule(ObjectNode action, String kind, String objectId, String writes) {
        ObjectNode item = ((ArrayNode) action.path("program").path("schedule")).addObject();
        item.put("id", kind + "-" + objectId).put("kind", kind).put("objectId", objectId).put("when", "frame").put("required", true);
        item.putArray("reads");
        ArrayNode written = item.putArray("writes");
        if (writes != null) {
            written.add(writes);
        }
        return item;
    }

    // Gate A (agent-loop design §15.1): the review of EA2.2 to EA2.4.

    @Test
    void aProducerMustNameTheBufferItFills() {
        ObjectNode a = valid();
        ObjectNode extra = ((ArrayNode) a.path("program").path("resources")).addObject();
        extra.put("id", "extra").put("kind", "storage_buffer").put("purpose", "x").put("layout", "14 floats")
                .put("strideFloats", 14).put("count", 8);
        ((ArrayNode) a.path("program").path("schedule").get(0).path("reads")).add("extra");

        assertThat(found(check.check(a))).contains("fail buffer-producer @ program.resources.extra")
                .doesNotContain("fail buffer-producer @ program.resources.instances");

        // The upload names its buffer among its inputs or as an argument's value: either is enough, neither is not.
        ObjectNode b = valid();
        ArrayNode inputs = (ArrayNode) object(b, "upload").path("inputs");
        inputs.remove(1);
        assertThat(found(check.check(b))).doesNotContain("fail buffer-producer @ program.resources.instances");
        arg(object(b, "upload"), "rawData", "[0,0,0]");
        assertThat(found(check.check(b))).contains("fail buffer-producer @ program.resources.instances");
        inputs.add("instances");
        assertThat(found(check.check(b))).doesNotContain("fail buffer-producer @ program.resources.instances");
    }

    @Test
    void motionMustBeScheduledWorkThatWritesWhatIsDrawn() {
        ObjectNode a = valid();
        ((ObjectNode) a.path("design")).put("animated", true);
        arg(addObject(a, "move", "core:NullGraph", "createComputeStage"), "config", "{\"name\":\"move\",\"shaderCode\":\"step\"}");
        ((ArrayNode) a.path("program").path("resources")).addObject().put("id", "scratch").put("kind", "storage_buffer")
                .put("purpose", "x").put("layout", "4 floats").put("strideFloats", 4).put("count", 8);

        // Work by what is not a compute stage; writing nothing declared; a resource no draw reads; an object a draw
        // reads, which is no resource. None of them moves what is drawn.
        for (String[] work : new String[][]{{"pass", "instances"}, {"move", "ghost"}, {"move", "scratch"}, {"move", "pass"}}) {
            ObjectNode b = a.deepCopy();
            schedule(b, "compute", work[0], work[1]);
            assertThat(found(check.check(b))).as(work[0] + " writing " + work[1]).contains("fail motion-work @ program.schedule");
        }
        schedule(a, "compute", "move", "instances");
        assertThat(found(check.check(a))).doesNotContain("fail motion-work @ program.schedule");
    }

    @Test
    void everyRequiredParameterIsGivenButTheHostsEngine() {
        ObjectNode a = valid();
        ((ArrayNode) object(a, "upload").path("args")).removeAll();
        // DynamicGeometryManager(device: GPUDevice, maxVertices, maxIndices, vertexStrideFloats?): the host gives the device.
        ObjectNode dynamic = addObject(a, "dynamic", "geometry:DynamicGeometryManager", null);
        arg(dynamic, "maxVertices", "1024");
        arg(dynamic, "maxIndices", "4096");

        List<Finding> findings = check.check(a);

        assertThat(findings).anyMatch(f -> f.code().equals("arg-missing") && f.path().equals("program.objects.upload.args")
                && f.message().equals("core:NullGraph.updateBatchData needs batch, rawData, instanceCount"));
        assertThat(findings).noneMatch(f -> f.path().startsWith("program.objects.material") || f.path().startsWith("program.objects.dynamic"));
    }

    @Test
    void aRequiredValueGivenAsNullIsMissing() {
        ObjectNode a = valid();
        arg(object(a, "batch"), "config", "{\"shaderCode\":null,\"strideFloats\":14,\"maxInstances\":64}");
        ObjectNode lights = addObject(a, "lights", "lights:LightSystem", null);
        arg(lights, "config", "{\"technique\":\"standard\",\"capacity\":{\"point\":null,\"directional\":1,\"spot\":0}}");
        arg(object(a, "upload"), "instanceCount", "null");

        List<Finding> findings = check.check(a);

        assertThat(found(findings)).contains("fail batch-shader @ program.objects.batch.args.config",
                "fail arg-required @ program.objects.lights.args.config.capacity", "fail arg-missing @ program.objects.upload.args");
        assertThat(findings).anyMatch(f -> f.message().equals("core:NullGraph.updateBatchData needs instanceCount"));
    }

    @Test
    void eachPostChainNeedsASetChainOfItsOwn() {
        ObjectNode a = valid();
        ObjectNode second = addObject(a, "chain2", "post:PostChain", null);
        arg(second, "config", "{}");

        assertThat(found(check.check(a))).contains("fail chain-set @ program.objects.chain2")
                .doesNotContain("fail chain-set @ program.objects.chain");
    }

    @Test
    void aProposalWithoutAProgramFails() {
        ObjectNode a = valid();
        a.putNull("program");

        assertThat(found(check.check(a))).containsExactly("fail proposal @ program");
    }

    @Test
    void thePaperTestsThreeLivePlansFitTheSchemaAndShowWhatReadingThemFound() throws Exception {
        for (String id : List.of("block-film", "galaxy", "foggy-dusk")) {
            assertThat(schemaProblems(plan(id))).as(id).isEmpty();
        }

        // block-film: no shader for its batch, a light capacity without point and spot, its instances never filled,
        // and its chain never set. Since gate A, also: its batch never given the pass it draws in (createBatch(pass,
        // config); the pass is only among its inputs).
        assertThat(found(check.check(plan("block-film")))).containsExactly(
                "fail batch-shader @ program.objects.voxelBatch.args.config",
                "fail arg-missing @ program.objects.voxelBatch.args",
                "fail arg-required @ program.objects.lightRig.args.config.capacity",
                "fail buffer-producer @ program.resources.voxelInstances",
                "fail chain-set @ program.objects.chain");
        // galaxy: its stars never placed, and its rotation never scheduled. Since gate A, also: the emissive shader it
        // builds never handed to its batch (an input is not shaderCode), the batch's pass not given, and
        // setBatchGeometry given only an index count, not its batch and buffers.
        assertThat(found(check.check(plan("galaxy")))).containsExactly(
                "fail batch-shader @ program.objects.starBatch.args.config",
                "fail arg-missing @ program.objects.starBatch.args",
                "fail arg-missing @ program.objects.bindStars.args",
                "fail buffer-producer @ program.resources.starInstances",
                "fail motion-work @ program.schedule");
        // foggy-dusk: a GeometryBuilder given a grid and a size it does not take, and `shader` for `shaderCode`. And one
        // that reading the plan missed and the check found: a HeightFogMedium given its scattering alone, though the
        // type requires all five fields (the docs pass a whole medium, DEFAULT_HEIGHT_FOG). Since gate A, also: the
        // batch's config has no shaderCode and its pass is not given, setBatchGeometry lacks its batch and index
        // buffer, and the upload names hillBatch, never the hillInstances the draw reads.
        assertThat(found(check.check(plan("foggy-dusk")))).containsExactly(
                "fail arg-param @ program.objects.terrainGeom.args.grid",
                "fail arg-param @ program.objects.terrainGeom.args.size",
                "fail arg-key @ program.objects.hillBatch.args.config.shader",
                "fail batch-shader @ program.objects.hillBatch.args.config",
                "fail arg-missing @ program.objects.hillBatch.args",
                "fail arg-required @ program.objects.fog.args.options.fog",
                "fail arg-missing @ program.objects.setHillGeom.args",
                "fail buffer-producer @ program.resources.hillInstances");
        assertThat(check.check(plan("foggy-dusk"))).anyMatch(f -> f.message().equals(
                "HeightFogMedium requires absorption, referenceHeight, scaleHeight, g"));
        assertThat(check.check(plan("galaxy"))).anyMatch(f -> f.message().equals(
                "core:NullGraph.setBatchGeometry needs batch, vertexBuffer, indexBuffer"));
    }
}
