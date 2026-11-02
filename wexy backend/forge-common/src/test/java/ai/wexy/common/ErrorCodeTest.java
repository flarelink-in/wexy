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

    /**
     * Backend architecture §12, with the five rows added on 2026-10-26, and W1's content-refused and
     * quota (2026-11-02, the creations platform design §10). A change here is a contract change: the
     * frontend's test/errors.test.mjs pins the same table.
     */
    @Test
    void theSetIsExactlyTheContract() {
        assertThat(Arrays.stream(ErrorCode.values()).map(ErrorCode::code))
                .containsExactlyInAnyOrder("bad-request", "auth", "appcheck", "account-required", "forbidden",
                        "not-found", "too-large", "content-refused", "rate", "quota", "internal", "upstream",
                        "budget", "paused", "unavailable", "timeout");
        assertThat(ErrorCode.CONTENT_REFUSED.status()).isEqualTo(422);
        assertThat(ErrorCode.QUOTA.status()).isEqualTo(429);
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
        // W1: a bare 429 is a rate bucket, never the allowance (whose reset only forge knows); a bare 422 is a bad
        // request, never a content refusal.
        assertThat(ErrorCode.forStatus(429)).isEqualTo(ErrorCode.RATE);
        assertThat(ErrorCode.forStatus(422)).isEqualTo(ErrorCode.BAD_REQUEST);
    }
}
