package ai.wexy.forge.engine;

import ai.wexy.forge.agent.ProgramCheck;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Q80's variant gates in the embedded manifest (the frontend's candidate-loop design §5; its EA-A8): the table is parsed
 * and checked whole at startup, as the frontend's {@code checkManifest} checks it, so a gate this side could not enforce
 * stops the service rather than passing a value the browser refuses, or the other way round.
 */
class AdapterManifestTest {

    private final ObjectMapper json = new ObjectMapper();

    private ObjectNode manifest() throws Exception {
        return (ObjectNode) json.readTree(new ClassPathResource("adapters/descriptors.json").getContentAsString(StandardCharsets.UTF_8));
    }

    /** The manifest with its gate table replaced by {@code change}'s. */
    private AdapterManifest gated(Consumer<ArrayNode> change) throws Exception {
        ObjectNode m = manifest();
        ArrayNode table = m.putArray("unavailable");
        change.accept(table);
        return AdapterManifest.parse(m);
    }

    private ObjectNode gate(ArrayNode table) {
        return table.addObject().put("adapter", "ng.buffer.storage").put("path", "/init").put("value", "upload").put("reason", "r");
    }

    @Test
    void theShippedManifestGatesUploadAndSaysWhy() {
        AdapterManifest m = AdapterManifest.load(json);
        assertThat(m.unavailable()).hasSize(1);
        AdapterManifest.Gate g = m.unavailable().get(0);
        assertThat(g.adapter()).isEqualTo("ng.buffer.storage");
        assertThat(g.path()).isEqualTo("/init");
        assertThat(g.value().asText()).isEqualTo("upload");
        assertThat(g.reason()).isEqualTo("no host data source until Tier 2 (assets); seed the buffer with an init-phase compute stage");
        // The value stays in the schema: Tier 2 lifts the gate, not the enum.
        assertThat(m.adapter("ng.buffer.storage").config().at("/properties/init/enum")).extracting(JsonNode::asText).containsExactly("zero", "upload");
    }

    @Test
    void aGateThisSideCouldNotEnforceWholeStopsTheManifest() throws Exception {
        assertThatCode(() -> gated(this::gate)).doesNotThrowAnyException();
        assertThatCode(() -> gated(t -> { })).as("no gate at all is a valid table").doesNotThrowAnyException();

        assertThatThrownBy(() -> gated(t -> gate(t).put("adapter", "ng.buffer.store"))).hasMessageContaining("there is no such adapter");
        assertThatThrownBy(() -> gated(t -> gate(t).put("path", "/layout"))).hasMessageContaining("not an enum of its config that holds \"upload\"");
        assertThatThrownBy(() -> gated(t -> gate(t).put("path", "/elements"))).hasMessageContaining("not an enum");
        assertThatThrownBy(() -> gated(t -> gate(t).put("path", "init"))).hasMessageContaining("not an enum");
        assertThatThrownBy(() -> gated(t -> t.addObject().put("adapter", "ng.post.chain").put("path", "/effects/effect").put("value", "Bloom")
                .put("reason", "r"))).as("a path runs through properties, never into an array's items").hasMessageContaining("not an enum");
        assertThatThrownBy(() -> gated(t -> gate(t).put("value", "stream"))).hasMessageContaining("holds \"stream\"");
        assertThatThrownBy(() -> gated(t -> {
            gate(t);
            gate(t);
        })).hasMessageContaining("\"upload\" is gated twice");
        assertThatThrownBy(() -> gated(t -> {
            gate(t);
            gate(t).put("value", "zero");
        })).hasMessageContaining("every value of the enum is gated");
        assertThatThrownBy(() -> gated(t -> gate(t).put("reason", " "))).hasMessageContaining("its reason is 1 to 200 characters");
        assertThatThrownBy(() -> gated(t -> gate(t).put("reason", "x".repeat(201)))).hasMessageContaining("its reason is 1 to 200 characters");
        assertThatThrownBy(() -> gated(t -> gate(t).put("why", "x"))).hasMessageContaining("a gate is exactly {adapter, path, value, reason}");

        ObjectNode none = manifest();
        none.remove("unavailable");
        assertThatThrownBy(() -> AdapterManifest.parse(none)).hasMessageContaining("unavailable is not a list");
    }

    @Test
    void liftingTheGateIsADataChangeTheChecksFollow() throws Exception {
        // Tier 2 removes the entry: the same node check then takes upload, and the program check's advice offers it again.
        EngineBundle bundle = EngineBundle.load(json);
        ObjectNode m = manifest();
        m.putArray("unavailable");
        ProgramCheck lifted = new ProgramCheck(bundle, AdapterManifest.parse(m));
        ProgramCheck shipped = new ProgramCheck(bundle, AdapterManifest.load(json));

        ObjectNode unfilled = mockWithoutItsSeed();
        assertThat(shipped.check(unfilled)).extracting(f -> f.message()).containsExactly(
                "blocks is read to draw, but nothing fills it: wire it to the writes of a compute stage; seed it with one at init");
        assertThat(lifted.check(unfilled)).extracting(f -> f.message()).containsExactly(
                "blocks is read to draw, but nothing fills it: give it init upload, or wire it to the writes of a compute stage");

        ObjectNode uploaded = mockWithoutItsSeed();
        ObjectNode blocks = (ObjectNode) uploaded.path("program").path("nodes").get(0);
        blocks.put("config", blocks.path("config").asText().replace("\"init\":\"zero\"", "\"init\":\"upload\""));
        assertThat(shipped.check(uploaded)).extracting(f -> f.code() + " @ " + f.path()).containsExactly("unavailable @ /program/nodes/0/config/init");
        assertThat(lifted.check(uploaded)).as("an upload fills what is drawn once Tier 2 has content for it").isEmpty();
    }

    /** The mock's program without the init stage that places its blocks. */
    private ObjectNode mockWithoutItsSeed() throws Exception {
        ObjectNode action = (ObjectNode) json.readTree(new ClassPathResource("mock/agent/program.json").getContentAsString(StandardCharsets.UTF_8));
        ArrayNode nodes = (ArrayNode) action.path("program").path("nodes");
        for (int i = 0; i < nodes.size(); i++) {
            if ("place".equals(nodes.get(i).path("id").asText())) {
                nodes.remove(i);
                return action;
            }
        }
        throw new AssertionError("the mock's program has no place stage");
    }
}
