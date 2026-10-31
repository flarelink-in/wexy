package ai.wexy.gateway.error;

import ai.wexy.common.ErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ResponseStatusException;

import java.net.ConnectException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;

class GatewayErrorHandlerTest {

    private final GatewayErrorHandler handler = new GatewayErrorHandler();

    private String handle(Throwable error, MockServerWebExchange exchange) {
        handler.handle(exchange, error).block();
        return exchange.getResponse().getBodyAsString().block();
    }

    private static MockServerWebExchange exchange() {
        return MockServerWebExchange.from(MockServerHttpRequest.get("/v1/forge/mode"));
    }

    /** Netty wraps these; the status must not depend on how deep the cause sits. */
    @Test
    void unreachableServiceIsUnavailableHoweverItIsWrapped() {
        assertThat(GatewayErrorHandler.statusOf(new ConnectException("refused"))).isEqualTo(503);
        assertThat(GatewayErrorHandler.statusOf(new RuntimeException(new ConnectException("refused")))).isEqualTo(503);
        assertThat(GatewayErrorHandler.statusOf(new UnknownHostException("forge-service"))).isEqualTo(503);
        assertThat(GatewayErrorHandler.statusOf(new RuntimeException(new TimeoutException()))).isEqualTo(504);
        assertThat(GatewayErrorHandler.statusOf(new ResponseStatusException(HttpStatus.NOT_FOUND))).isEqualTo(404);
        assertThat(GatewayErrorHandler.statusOf(new IllegalStateException("bug"))).isEqualTo(500);
    }

    /** Our own refusal keeps its code, its message and its retry hint. */
    @Test
    void aRejectionKeepsItsCodeAndMessage() {
        MockServerWebExchange exchange = exchange();
        String body = handle(new GatewayRejection(ErrorCode.ACCOUNT_REQUIRED, "This needs a signed-in account.", 0),
                exchange);

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(body).isEqualTo("{\"code\":\"account-required\",\"message\":\"This needs a signed-in account.\"}");
    }

    /** Anything else is answered by status alone: its own text may name hosts or internals. */
    @Test
    void anUnexpectedErrorLeaksNothing() {
        MockServerWebExchange exchange = exchange();
        String body = handle(new IllegalStateException("password=hunter2 at forge-service:8410"), exchange);

        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(body).isEqualTo("{\"code\":\"internal\",\"message\":\"Something went wrong on our side.\"}");
    }
}
