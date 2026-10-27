package ai.wexy.forge.error;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.ErrorEnvelope;
import ai.wexy.forge.upstream.UpstreamException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.reactive.error.ErrorWebExceptionHandler;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebInputException;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;

/**
 * Every error that leaves forge-service leaves here, in the shared envelope.
 *
 * Ordered ahead of Spring Boot's default handler (-1). A {@link ForgeException} keeps its code and
 * message; an {@link UpstreamException} is mapped by kind (a refused key pauses live creation; a
 * timeout is a timeout; anything else is the upstream failing) and never carries the upstream's
 * body; anything else is answered by status alone. This covers errors before a stream starts;
 * once a stream has started, its last event carries the error instead (backend §6.3).
 */
@Component
@Order(-2)
public class ErrorEnvelopeHandler implements ErrorWebExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ErrorEnvelopeHandler.class);

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        ErrorCode code;
        String message;
        if (error instanceof ForgeException forge) {
            code = forge.code();
            message = forge.getMessage();
        } else if (error instanceof UpstreamException upstream) {
            code = upstream.errorCode();
            message = upstream.publicMessage();
            log.warn("{} {}: {}", exchange.getRequest().getMethod(), exchange.getRequest().getPath(), upstream.describe());
        } else if (causedBy(error, DataBufferLimitException.class)) {
            // A body over spring.codec.max-in-memory-size; unmapped, it was a 500 (forge-loop design §4.2).
            code = ErrorCode.TOO_LARGE;
            message = "The request is too large.";
        } else if (error instanceof ServerWebInputException) {
            code = ErrorCode.BAD_REQUEST;
            message = "The request was not understood.";
        } else if (error instanceof ResponseStatusException statusException) {
            code = ErrorCode.forStatus(statusException.getStatusCode().value());
            message = genericMessage(code);
        } else {
            code = ErrorCode.INTERNAL;
            message = genericMessage(code);
            log.error("{} {} failed", exchange.getRequest().getMethod(), exchange.getRequest().getPath(), error);
        }
        return write(exchange, code, message);
    }

    private static boolean causedBy(Throwable error, Class<? extends Throwable> type) {
        for (Throwable cause = error; cause != null; cause = cause.getCause() == cause ? null : cause.getCause()) {
            if (type.isInstance(cause)) {
                return true;
            }
        }
        return false;
    }

    static Mono<Void> write(ServerWebExchange exchange, ErrorCode code, String message) {
        ServerHttpResponse response = exchange.getResponse();
        if (response.isCommitted()) {
            return Mono.empty();
        }
        response.setStatusCode(HttpStatus.valueOf(code.status()));
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        byte[] body = ErrorEnvelope.of(code, message).toJson().getBytes(StandardCharsets.UTF_8);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }

    private static String genericMessage(ErrorCode code) {
        return switch (code) {
            case NOT_FOUND -> "No such route.";
            case BAD_REQUEST -> "The request was not understood.";
            case UNAVAILABLE -> "The service is unavailable right now. Try again shortly.";
            default -> "Something went wrong on our side.";
        };
    }
}
