package ai.wexy.platform.error;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.ErrorEnvelope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.reactive.error.ErrorWebExceptionHandler;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebInputException;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.concurrent.RejectedExecutionException;

/**
 * Every error that leaves the platform service leaves here, in the shared envelope, never stored (adapted from
 * forge-service's). A {@link PlatformException} keeps its code and message. The database lost, slow or out of
 * connections, and the database scheduler's queue full, are {@code 503 unavailable}, logged by kind alone: no SQL, no
 * value, no subject reaches a log or a response (the creations platform design §13).
 */
@Component
@Order(-2)
public class ErrorEnvelopeHandler implements ErrorWebExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ErrorEnvelopeHandler.class);

    static final String UNAVAILABLE = "Accounts are unavailable right now. Try again shortly.";

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        ErrorCode code;
        String message;
        if (error instanceof PlatformException platform) {
            code = platform.code();
            message = platform.getMessage();
        } else if (causedBy(error, DataAccessException.class) || causedBy(error, TransactionException.class)
                || causedBy(error, SQLException.class) || causedBy(error, RejectedExecutionException.class)) {
            // A transaction that cannot start is Spring's TransactionException, not a DataAccessException, with the
            // pool's own SQLException under it (the independent W2 review): the database lost all the same.
            code = ErrorCode.UNAVAILABLE;
            message = UNAVAILABLE;
            log.warn("dependency.unavailable dep=db route={} {} kind={}", exchange.getRequest().getMethod(),
                    exchange.getRequest().getPath(), rootKind(error));
        } else if (causedBy(error, DataBufferLimitException.class)) {
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
            log.error("{} {} failed: {}", exchange.getRequest().getMethod(), exchange.getRequest().getPath(), rootKind(error));
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

    /** The innermost exception's class: what went wrong, without its message, which can quote SQL or a value. */
    private static String rootKind(Throwable error) {
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getClass().getName();
    }

    static Mono<Void> write(ServerWebExchange exchange, ErrorCode code, String message) {
        ServerHttpResponse response = exchange.getResponse();
        if (response.isCommitted()) {
            return Mono.empty();
        }
        response.setStatusCode(HttpStatus.valueOf(code.status()));
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        response.getHeaders().set(HttpHeaders.CACHE_CONTROL, "no-store");
        byte[] body = ErrorEnvelope.of(code, message).toJson().getBytes(StandardCharsets.UTF_8);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }

    private static String genericMessage(ErrorCode code) {
        return switch (code) {
            case NOT_FOUND -> "No such route.";
            case BAD_REQUEST -> "The request was not understood.";
            case UNAVAILABLE -> UNAVAILABLE;
            default -> "Something went wrong on our side.";
        };
    }
}
