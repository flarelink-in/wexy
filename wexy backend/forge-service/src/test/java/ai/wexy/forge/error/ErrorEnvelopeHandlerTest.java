package ai.wexy.forge.error;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.upstream.UpstreamException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebInputException;

import static org.assertj.core.api.Assertions.assertThat;

class ErrorEnvelopeHandlerTest {

    private final ErrorEnvelopeHandler handler = new ErrorEnvelopeHandler();

    private MockServerWebExchange handle(Throwable error) {
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/forge/plan"));
        handler.handle(exchange, error).block();
        return exchange;
    }

    private static String body(MockServerWebExchange exchange) {
        return exchange.getResponse().getBodyAsString().block();
    }

    @Test
    void aReachedCapIsBudget() {
        MockServerWebExchange exchange = handle(new ForgeException(ErrorCode.BUDGET, "Live creation has reached its spending limit for now."));

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(body(exchange)).isEqualTo(
                "{\"code\":\"budget\",\"message\":\"Live creation has reached its spending limit for now.\"}");
    }

    /** A refused key pauses live creation (backend §6.6); the upstream's own words stay in the logs. */
    @Test
    void aRefusedKeyIsPausedAndTheUpstreamBodyNeverLeaves() {
        MockServerWebExchange exchange = handle(new UpstreamException(UpstreamException.Kind.AUTH, 401,
                "{\"error\":\"key <key> revoked for project 42\"}"));

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(body(exchange)).contains("\"code\":\"paused\"").doesNotContain("project 42");
    }

    @Test
    void anUpstreamTimeoutIsATimeoutAndOtherFailuresAreUpstream() {
        assertThat(body(handle(new UpstreamException(UpstreamException.Kind.TIMEOUT, 0, "slow"))))
                .contains("\"code\":\"timeout\"");
        assertThat(body(handle(new UpstreamException(UpstreamException.Kind.SERVER, 503, "down"))))
                .contains("\"code\":\"upstream\"");
    }

    @Test
    void anUnreadableRequestIsABadRequest() {
        MockServerWebExchange exchange = handle(new ServerWebInputException("Failed to read HTTP message"));

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(body(exchange)).contains("\"code\":\"bad-request\"");
    }

    @Test
    void anUnexpectedErrorLeaksNothing() {
        MockServerWebExchange exchange = handle(new IllegalStateException("jdbc:mariadb://db:3306/wexy password=x"));

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(body(exchange)).isEqualTo("{\"code\":\"internal\",\"message\":\"Something went wrong on our side.\"}");
    }
}
