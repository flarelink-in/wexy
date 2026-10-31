package ai.wexy.common;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ErrorEnvelopeTest {

    @Test
    void writesTheContractShape() {
        assertThat(ErrorEnvelope.of(ErrorCode.RATE, "Too many requests. Please slow down.").toJson())
                .isEqualTo("{\"code\":\"rate\",\"message\":\"Too many requests. Please slow down.\"}");
    }

    /** A hand-written serialiser must pin its own quoting hazards (null-graph principles §13, rule 3). */
    @Test
    void escapesQuotesBackslashesAndControlCharacters() {
        String json = ErrorEnvelope.of(ErrorCode.BAD_REQUEST, "a \"quoted\" \\path\\\nline\ttab\u0001end").toJson();

        assertThat(json).isEqualTo("{\"code\":\"bad-request\",\"message\":"
                + "\"a \\\"quoted\\\" \\\\path\\\\\\nline\\ttab\\u0001end\"}");
    }

    @Test
    void refusesNulls() {
        assertThatThrownBy(() -> new ErrorEnvelope(null, "x")).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new ErrorEnvelope("auth", null)).isInstanceOf(NullPointerException.class);
    }
}
