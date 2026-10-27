package ai.wexy.gateway.error;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.ErrorEnvelope;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;

/**
 * Writes the shared error envelope straight onto a response: for the filters that answer before
 * any route has matched (the edge throttle, the request guard), and for the error handler.
 *
 * Adapted from FlareLink's ShieldResponses (pre-existing work): the body is now Wexy's envelope,
 * {@code {"code","message"}}, so the studio can map every refusal by its code.
 */
public final class ErrorResponses {

    private ErrorResponses() {
    }

    public static Mono<Void> write(ServerWebExchange exchange, ErrorCode code, String message,
                                   long retryAfterSeconds) {
        ServerHttpResponse response = exchange.getResponse();

        // Another filter may already have started the response; overwriting it would corrupt the
        // stream, so just terminate.
        if (response.isCommitted()) {
            return Mono.empty();
        }

        response.setStatusCode(HttpStatus.valueOf(code.status()));
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        if (retryAfterSeconds > 0) {
            response.getHeaders().set(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterSeconds));
        }

        byte[] body = ErrorEnvelope.of(code, message).toJson().getBytes(StandardCharsets.UTF_8);
        DataBuffer buffer = response.bufferFactory().wrap(body);
        return response.writeWith(Mono.just(buffer));
    }
}
