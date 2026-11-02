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

    /** A complete program, the mock's: blocks an init stage places, drawn as lit cubes, under a film look. Still. */
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

    /** Removes the node of this id. */
    static void remove(ObjectNode action, String id) {
        ArrayNode list = nodes(action);
        for (int i = 0; i < list.size(); i++) {
            if (id.equals(list.get(i).path("id").asText())) {
                list.remove(i);
                return;
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
                "ng.geometry.primitive", "ng.material.stock", "ng.light.rig", "ng.render.mesh_batch", "ng.post.chain", "ng.compute.stage");
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
        // The mock's blocks are placed by its init stage; without it, nothing fills what the terrain draws.
        ObjectNode a = valid();
        remove(a, "place");
        assertThat(found(check.check(a))).containsExactly("fail buffer-producer @ /program/nodes/0");
        // The advice the revision reads never offers what the manifest gates (Q80).
        assertThat(check.check(a).get(0).message()).isEqualTo("blocks is read to draw, but nothing fills it: wire it to the writes of a compute"
                + " stage; seed it with one at init");

        // Filled by a compute stage, in any phase: once at init is enough to fill it.
        stage(a, "seed", "init", "blocks");
        assertThat(check.check(a)).isEmpty();

        // A stage that writes another buffer fills nothing the draw reads.
        ObjectNode b = valid();
        remove(b, "place");
        add(b, "scratch", "ng.buffer.storage", Map.of("elements", 64, "layout", "f32", "strideFloats", 4, "pingPong", false, "init", "zero"));
        stage(b, "seed", "init", "scratch");
        assertThat(found(check.check(b))).containsExactly("fail buffer-producer @ /program/nodes/0");

        // Q80: an upload fills nothing in Tier 1. The node check refuses it, so no whole-program rule judges the program.
        ObjectNode c = valid();
        remove(c, "place");
        config(c, "blocks", "init", "upload");
        assertThat(found(check.check(c))).containsExactly("fail unavailable @ /program/nodes/0/config/init");
    }

    @Test
    void anAnimatedDesignMovesWhatItDraws() {
        // The mock's only work is its init stage: once, so it moves nothing.
        ObjectNode a = animated();
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

        assertThat(found(findings)).containsExactly("fail reserved @ /program/nodes/7/config/entry",
                "fail reserved @ /program/nodes/8/config/vertexEntry");
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

    // 2026-11-01, live on the VPS: each of the first three agent.v3 hand-offs broke a Tier-1 rule only the browser held.

    @Test
    void aModuleServesOneNodeAndAfterOrdersStagesOfOnePhase() {
        // A second node naming the module the mock's place stage owns, as galaxy's spin did: the later one is told.
        ObjectNode shared = valid();
        add(shared, "spin", "ng.compute.stage", Map.of("module", "place", "entry", "spinBlocks", "workgroupSize", 64, "invocations", 64,
                "phase", "frame"), "writes", "blocks", "buffer");
        List<Finding> findings = check.check(shared);
        assertThat(found(findings)).containsExactly("fail module-shared @ /program/nodes/7/config/module");
        assertThat(findings.get(0).message()).isEqualTo("module place serves place and spin: a module serves one node, so give spin a module of its own");
        // Any two module owners, of any kind.
        ObjectNode sky = valid();
        add(sky, "sky", "ng.render.fullscreen", Map.of("module", "place", "fragmentEntry", "dusk"));
        assertThat(found(check.check(sky))).containsExactly("fail module-shared @ /program/nodes/7/config/module");

        // after wired across phases, as block-film's tickcarts after seedcarts: at that input, as the browser's resolver.
        ObjectNode across = valid();
        add(across, "tick", "ng.compute.stage", Map.of("module", "tick", "entry", "tickBlocks", "workgroupSize", 64, "invocations", 64,
                "phase", "fixedStep"), "writes", "blocks", "buffer", "after", "place", "done");
        List<Finding> order = check.check(across);
        assertThat(found(order)).containsExactly("fail after-phase @ /program/nodes/7/inputs/1");
        assertThat(order.get(0).message()).isEqualTo("tick runs in fixedStep and place in init: after orders two stages of one phase, so drop it"
                + " or give both one phase (init runs once, before any fixedStep or frame)");

        // after within one phase orders two writers of one buffer, and passes; so do two modules of their own.
        ObjectNode within = valid();
        add(within, "settle", "ng.compute.stage", Map.of("module", "settle", "entry", "settleBlocks", "workgroupSize", 64, "invocations", 64,
                "phase", "init"), "writes", "blocks", "buffer", "after", "place", "done");
        assertThat(check.check(within)).isEmpty();
    }

    /** The mock's program with fullscreen passes of their own modules added until it names {@code modules} in all. */
    static ObjectNode withModules(int modules) {
        ObjectNode a = valid();
        for (int i = 2; i <= modules; i++) {
            add(a, "layer" + i, "ng.render.fullscreen", Map.of("module", "layer" + i, "fragmentEntry", "shade" + i));
        }
        return a;
    }

    // 2026-11-02, Q84 revised: the black hole starter needed about eight modules, past the browser's four, and was stopped
    // after its turn was spent. The browser now builds twelve, and the turn holds a program to them.

    @Test
    void oneWorldBuildsAtMostTwelveModulesAndTheTurnIsToldAtTheModulePastThem() {
        assertThat(ai.wexy.common.AgentTurn.MAX_MODULES).as("the frontend's Q_C").isEqualTo(12);
        assertThat(nodes(withModules(12))).hasSize(18);
        assertThat(check.check(withModules(12))).as("twelve modules: the mock's place and eleven passes").isEmpty();
        List<Finding> over = check.check(withModules(13));
        assertThat(found(over)).containsExactly("fail module-count @ /program/nodes/18/config/module");
        assertThat(over.get(0).message()).isEqualTo("the program names 13 modules, and one world builds at most 12: merge stages that run in"
                + " the same phase into one module, or leave a part out");
        assertThat(check.check(withModules(15)).get(0).message()).as("the count is the whole program's, said at the first past the cap")
                .startsWith("the program names 15 modules");
        // A module two nodes name is one module, which the module-shared rule tells: it is not counted twice.
        ObjectNode shared = withModules(12);
        add(shared, "again", "ng.render.fullscreen", Map.of("module", "layer12", "fragmentEntry", "shadeAgain"));
        assertThat(found(check.check(shared))).containsExactly("fail module-shared @ /program/nodes/18/config/module");
    }

    // EA6.3 (the frontend's visual-review design §8.2): a revision's notes to its modules, agent-action.v3.

    /** Notes as the schema takes them: each a module and a message. */
    static ArrayNode notes(String... moduleAndMessage) {
        ArrayNode list = JSON.createArrayNode();
        for (int i = 0; i < moduleAndMessage.length; i += 2) {
            list.addObject().put("module", moduleAndMessage[i]).put("message", moduleAndMessage[i + 1]);
        }
        return list;
    }

    @Test
    void aProgramsModulesAreItsStagesAndPassesModulesOnceAndNoneWhileItsNodesFail() {
        assertThat(check.modules(valid().path("program"))).containsExactly("place");
        assertThat(check.modules(withModules(3).path("program"))).containsExactly("place", "layer2", "layer3");
        ObjectNode shared = withModules(2);
        add(shared, "again", "ng.render.fullscreen", Map.of("module", "layer2", "fragmentEntry", "shadeAgain"));
        assertThat(check.modules(shared.path("program"))).containsExactly("place", "layer2");
        ObjectNode broken = valid();
        node(broken, "place").put("config", "{\"module\":\"place\"}");
        assertThat(check.modules(broken.path("program"))).isNull();
    }

    @Test
    void aRevisionsNotesNameEachModuleOfItsProgramOnceAndSaySomethingJudgedWhole() {
        java.util.Set<String> program = java.util.Set.of("place", "glow");
        java.util.Set<String> base = java.util.Set.of("place", "old");

        assertThat(ProgramCheck.repairs(notes(), program, base)).isEmpty();
        assertThat(ProgramCheck.repairs(notes("place", "Lower every block by 2 units.", "glow", "Warmer."), program, base))
                .as("a module the revision keeps, and one it adds, which is written with its note").isEmpty();

        // Every bad note is told, at its own place, and the good ones beside them do not hide it.
        List<Finding> bad = ProgramCheck.repairs(notes("place", "Lower it.", "nowhere", "x", "place", "Again.", "old", "Brighter.", "", "y",
                "glow", " "), program, base);
        assertThat(found(bad)).containsExactly("fail repair-target @ /revision/moduleRepairs/1/module", "fail repair-twice @ /revision/moduleRepairs/2/module",
                "fail repair-target @ /revision/moduleRepairs/3/module", "fail repair-target @ /revision/moduleRepairs/4/module",
                "fail repair-note @ /revision/moduleRepairs/5/message");
        assertThat(bad.get(0).message()).isEqualTo("no node of the revised program names module nowhere: a note names a module of the program, as its"
                + " node's config names it");
        assertThat(bad.get(1).message()).isEqualTo("place has two notes: give it one, with everything its code must change");
        assertThat(bad.get(2).message()).isEqualTo("the revised program no longer names module old, so there is no code of it to change: drop the note,"
                + " or keep the module");
        assertThat(bad.get(3).message()).isEqualTo("a note names the module whose code must change, as its node's config names it");
        assertThat(bad.get(4).message()).isEqualTo("the note to glow says nothing: say what its code must do differently, or leave the module out");
        assertThat(ProgramCheck.passes(bad)).isFalse();

        // Blank as the browser's trim counts it (the independent review of EA6.3): non-breaking spaces and the BOM too.
        List<Finding> invisible = ProgramCheck.repairs(notes("place", "\u00A0\u2007\u202F\uFEFF", "\u00A0", "Brighter."), program, base);
        assertThat(found(invisible)).containsExactly("fail repair-note @ /revision/moduleRepairs/0/message",
                "fail repair-target @ /revision/moduleRepairs/1/module");
        assertThat(ModuleRequest.blank("\u001F")).as("stricter than the browser where Java is: harmless, the turn revises").isTrue();
        assertThat(ModuleRequest.blank("Lower it.\u00A0")).isFalse();
    }

    /** The schema's notes and the routes that carry them agree: a module's name as a node names it, a note as a module call takes it. */
    @Test
    void theSchemasNotesKeepToTheNamesAndTheNoteTheModuleRouteTakes() {
        JsonNode repairs = SCHEMAS.schema(JsonSchemas.AGENT_ACTION).at("/properties/revision/anyOf/0/properties/moduleRepairs");
        assertThat(JsonSchemas.AGENT_ACTION).isEqualTo("agent-action.v3");
        assertThat(repairs.path("type").asText()).isEqualTo("array");
        assertThat(repairs.path("maxItems").asInt()).isEqualTo(12);
        assertThat(repairs.at("/items/properties/module/maxLength").asInt()).isEqualTo(40)
                .isEqualTo(MANIFEST.adapters().get("ng.compute.stage").config().at("/properties/module/maxLength").asInt());
        assertThat(repairs.at("/items/properties/message/maxLength").asInt()).isEqualTo(ModuleRequest.NOTE_CHARS);
        // A revise without notes is still an action, and one with a thirteenth note or an unknown key is not.
        ObjectNode revise = valid().put("kind", "revise");
        revise.putObject("revision").put("scope", "program").putArray("changes").add("lower the blocks");
        ((ObjectNode) revise.path("revision")).set("moduleRepairs", notes());
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, revise)).isEmpty();
        ArrayNode thirteen = notes();
        for (int i = 0; i < 13; i++) {
            thirteen.addObject().put("module", "m" + i).put("message", "x");
        }
        ((ObjectNode) revise.path("revision")).set("moduleRepairs", thirteen);
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, revise)).isNotEmpty();
        ((ObjectNode) revise.path("revision")).set("moduleRepairs", notes("place", "x"));
        ((ObjectNode) revise.path("revision").path("moduleRepairs").get(0)).put("line", 3);
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, revise)).isNotEmpty();
        ((ObjectNode) revise.path("revision")).remove("moduleRepairs");
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, revise)).as("strict: every key is present").isNotEmpty();
    }
}
