package ai.wexy.common;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ErrorCodeTest {

    /** The studio maps by code; two constants with one wire code would make one of them unreachable. */
    @Test
    void wireCodesAreUnique() {
        Set<String> codes = Arrays.stream(ErrorCode.values()).map(ErrorCode::code).collect(Collectors.toSet());
        assertThat(codes).hasSize(ErrorCode.values().length);
    }

    /** Backend architecture §12, with the five rows added on 2026-10-26. A change here is a contract change. */
    @Test
    void theSetIsExactlyTheContract() {
        assertThat(Arrays.stream(ErrorCode.values()).map(ErrorCode::code))
                .containsExactlyInAnyOrder("bad-request", "auth", "appcheck", "account-required", "forbidden",
                        "not-found", "too-large", "rate", "internal", "upstream", "budget", "paused",
                        "unavailable", "timeout");
    }

    @Test
    void everyCodeRoundTripsThroughItsWireForm() {
        for (ErrorCode code : ErrorCode.values()) {
            assertThat(ErrorCode.fromCode(code.code())).isSameAs(code);
        }
        assertThatThrownBy(() -> ErrorCode.fromCode("budget-exceeded")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void bareStatusesMapToTheCodeThatPromisesLeast() {
        assertThat(ErrorCode.forStatus(404)).isEqualTo(ErrorCode.NOT_FOUND);
        assertThat(ErrorCode.forStatus(403)).isEqualTo(ErrorCode.FORBIDDEN);
        // A bare 503 is a busy dependency, never the archive's budget or paused.
        assertThat(ErrorCode.forStatus(503)).isEqualTo(ErrorCode.UNAVAILABLE);
        assertThat(ErrorCode.forStatus(504)).isEqualTo(ErrorCode.TIMEOUT);
        assertThat(ErrorCode.forStatus(405)).isEqualTo(ErrorCode.BAD_REQUEST);
        assertThat(ErrorCode.forStatus(500)).isEqualTo(ErrorCode.INTERNAL);
        assertThat(ErrorCode.forStatus(599)).isEqualTo(ErrorCode.INTERNAL);
    }
}
