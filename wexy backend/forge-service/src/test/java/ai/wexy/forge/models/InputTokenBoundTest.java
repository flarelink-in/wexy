package ai.wexy.forge.models;

import ai.wexy.forge.upstream.ChatMessage;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The input bound against the counts Meta's API reported in hour one (2026-10-27, the probe:
 * forge-loop design, Results). The bound is a reservation that no call may exceed, so it must
 * stay above every count the API has ever reported for a known input, with room; a new data point
 * from a live call joins this test. What this test cannot cover, the settlement's overrun path
 * does (SpendGuardSettlementTest).
 */
class InputTokenBoundTest {

    /** HourOneProbe.HELLO: Meta reported prompt_tokens 28 for muse-spark-1.3 and muse-wonder-1.0. */
    private static final List<ChatMessage> HELLO = List.of(
            ChatMessage.system("You are a connectivity test. Answer with one word."),
            ChatMessage.user("Reply with exactly: ok"));
    private static final long HELLO_REPORTED = 28;

    /** HourOneProbe.STRUCTURED with its RESPONSE_FORMAT: Meta reported prompt_tokens 72 for muse-spark-1.3. */
    private static final List<ChatMessage> STRUCTURED = List.of(
            ChatMessage.system("Answer only with JSON."),
            ChatMessage.user("Return a JSON object with one boolean field named ok, set to true."));
    private static final Map<String, Object> RESPONSE_FORMAT = Map.of(
            "type", "json_schema",
            "json_schema", Map.of(
                    "name", "probe",
                    "strict", true,
                    "schema", Map.of(
                            "type", "object",
                            "properties", Map.of("ok", Map.of("type", "boolean")),
                            "required", List.of("ok"),
                            "additionalProperties", false)));
    private static final long STRUCTURED_REPORTED = 72;

    private static long bytes(List<ChatMessage> messages) {
        return messages.stream().mapToLong(m -> m.content().getBytes(StandardCharsets.UTF_8).length).sum();
    }

    /** 72 bytes of text: the bound is the bytes plus the framing, and Meta counted 28. */
    @Test
    void theBoundStaysAboveWhatMetaReportedForTwoShortMessages() {
        long bound = ModelCatalog.inputTokenBound(HELLO);

        assertThat(bytes(HELLO)).isEqualTo(72);
        assertThat(bound).isEqualTo(72 + 2 * 16 + 64).isGreaterThan(HELLO_REPORTED);
        // The framing alone (the part the text does not explain) is what Meta could have added: at most 28 here.
        assertThat(2 * 16 + 64).isGreaterThan((int) HELLO_REPORTED);
    }

    /** 88 bytes of text and a 180-byte schema: Meta counted 72, of which the schema about 40. */
    @Test
    void theBoundStaysAboveWhatMetaReportedWithASchema() {
        long bound = ModelCatalog.inputTokenBound(STRUCTURED, RESPONSE_FORMAT);
        long schema = bound - ModelCatalog.inputTokenBound(STRUCTURED);

        assertThat(bytes(STRUCTURED)).isEqualTo(88);
        assertThat(schema).isEqualTo(2 * 180);
        assertThat(bound).isEqualTo(88 + 2 * 16 + 64 + 360).isGreaterThan(STRUCTURED_REPORTED);
        // The schema's share of the count (72 minus the text's call, about 32) is far inside its reservation.
        assertThat(schema).isGreaterThan(STRUCTURED_REPORTED - 28);
    }
}
