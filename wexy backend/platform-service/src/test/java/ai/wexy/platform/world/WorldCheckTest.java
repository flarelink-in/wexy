package ai.wexy.platform.world;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * W3.1's check of a saved world's text (the creations platform design §5, §10; PL-T4, PL-T8): the studio's castle passes
 * with its facts; an h1 world, another format, a private field, a hash of another shape, a text past the cap, one not
 * canonical and one that is not the bytes its hash names are each refused, before anything is stored.
 */
class WorldCheckTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private final WorldCheck check = new WorldCheck();

    private static String castle() throws IOException {
        return new ClassPathResource("world/castle.wexy-world.json").getContentAsString(StandardCharsets.UTF_8);
    }

    /** The castle, edited and written canonical again (keys sorted, compact), as a studio of another mind would. */
    private static String edited(Consumer<ObjectNode> edit) throws IOException {
        ObjectNode world = (ObjectNode) JSON.readTree(castle());
        edit.accept(world);
        String text = Canonical.write(world);
        assertThat(CanonicalText.problem(text)).as("the stand-in is canonical").isNull();
        return text;
    }

    private void refused(String text, ErrorCode code, String message) {
        String sha = WorldCheck.sha256(text.getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> check.check(text, sha))
                .isInstanceOfSatisfying(PlatformException.class, e -> {
                    assertThat(e.code()).isEqualTo(code);
                    assertThat(e.getMessage()).contains(message);
                });
    }

    @Test
    void theCastleAsTheStudioSavedItPasses() throws IOException {
        String text = castle();
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        WorldCheck.Facts facts = check.check(text, WorldCheck.sha256(bytes));
        assertThat(facts.format()).isEqualTo("wexy-world.v1");
        assertThat(facts.line()).isEqualTo("ea.v1");
        assertThat(facts.bytes()).isEqualTo(bytes.length).isEqualTo(20541);
        assertThat(facts.sha256()).isEqualTo("e87914fdfe0dcae929a4d11b55cab406d22ca8c636cc6d2f163caaeab6bb2fc3");
        JsonNode pins = JSON.readTree(facts.pinsJson());
        assertThat(pins.get("abi").asText()).isEqualTo("ea-abi.v2");
        assertThat(pins.get("actionSchema").asText()).isEqualTo("agent-action.v3");
        assertThat(CanonicalText.problem(facts.pinsJson())).as("the pins as stored are canonical too").isNull();
    }

    @Test
    void aTextThatIsNotItsHashOrNotCanonicalIsRefused() throws IOException {
        String text = castle();
        assertThatThrownBy(() -> check.check(text, "e".repeat(64)))
                .isInstanceOfSatisfying(PlatformException.class, e -> assertThat(e.getMessage()).contains("not the bytes its hash names"));
        refused(text.replace("\"kind\":\"agent\"", "\"kind\": \"agent\""), ErrorCode.BAD_REQUEST, "not canonical JSON");
        refused(JSON.writerWithDefaultPrettyPrinter().writeValueAsString(JSON.readTree(text)), ErrorCode.BAD_REQUEST, "not canonical JSON");
    }

    @Test
    void anH1WorldAnotherFormatAndPrivateFieldsAreRefused() throws IOException {
        refused(edited(w -> w.put("kind", "h1")), ErrorCode.BAD_REQUEST, "An h1 world is not saved here");
        refused(edited(w -> w.put("format", "wexy-world.v2")), ErrorCode.BAD_REQUEST, "This is not a wexy-world.v1 world");
        refused(edited(w -> w.put("kind", "other")), ErrorCode.BAD_REQUEST, "does not fit wexy-world.v1");
        for (String key : new String[]{"request", "calls", "evidence", "l3", "reviews", "attempt", "title"}) {
            refused(edited(w -> w.putObject(key)), ErrorCode.BAD_REQUEST, "does not fit wexy-world.v1");
        }
        refused(edited(w -> ((ObjectNode) w.get("modules").get(0)).put("originalBody", "x")), ErrorCode.BAD_REQUEST, "does not fit");
        refused(edited(w -> w.remove("view")), ErrorCode.BAD_REQUEST, "does not fit");
    }

    @Test
    void shapesTheSchemaCannotSayAreRefusedInCode() throws IOException {
        refused(edited(w -> w.put("graph", "G".repeat(64))), ErrorCode.BAD_REQUEST, "graph is not 64 lowercase hex digits");
        refused(edited(w -> ((ObjectNode) w.get("pins")).put("bundle", "x")), ErrorCode.BAD_REQUEST, "pins.bundle is not 64 lowercase hex");
        refused(edited(w -> ((ObjectNode) w.get("modules").get(1)).put("codeHash", "0".repeat(63))), ErrorCode.BAD_REQUEST, "modules[1].codeHash");
        refused(edited(w -> w.put("line", "EA 1")), ErrorCode.BAD_REQUEST, "line is not a line");
        // A line no build opens is still a line: stored, never judged here (Q125).
        String later = edited(w -> w.put("line", "ea.v2"));
        assertThat(check.check(later, WorldCheck.sha256(later.getBytes(StandardCharsets.UTF_8))).line()).isEqualTo("ea.v2");
    }

    @Test
    void aTextPastTheCapIsTooLargeBeforeAnythingElse() throws IOException {
        String big = edited(w -> ((ArrayNode) w.get("keyframes")).add("x".repeat(WorldCheck.MAX_BYTES)));
        refused(big, ErrorCode.TOO_LARGE, "too large to save");
        // Counted in UTF-8 bytes: 2-byte characters past half the cap.
        String wide = "\"" + "é".repeat(WorldCheck.MAX_BYTES / 2) + "\"";
        refused(wide, ErrorCode.TOO_LARGE, "too large");
    }

    /** A compact writer with sorted keys, for the stand-ins: the studio's form for the plain values the castle holds. */
    static final class Canonical {
        static String write(JsonNode node) {
            StringBuilder out = new StringBuilder();
            write(node, out);
            return out.toString();
        }

        private static void write(JsonNode node, StringBuilder out) {
            if (node.isObject()) {
                out.append('{');
                java.util.List<String> keys = new java.util.ArrayList<>();
                node.fieldNames().forEachRemaining(keys::add);
                java.util.Collections.sort(keys);
                for (int i = 0; i < keys.size(); i++) {
                    if (i > 0) {
                        out.append(',');
                    }
                    out.append(JSON.valueToTree(keys.get(i)).toString()).append(':');
                    write(node.get(keys.get(i)), out);
                }
                out.append('}');
            } else if (node.isArray()) {
                out.append('[');
                for (int i = 0; i < node.size(); i++) {
                    if (i > 0) {
                        out.append(',');
                    }
                    write(node.get(i), out);
                }
                out.append(']');
            } else if (node.isNumber()) {
                out.append(CanonicalText.number(node.asDouble()));
            } else {
                out.append(node.toString());
            }
        }
    }
}
