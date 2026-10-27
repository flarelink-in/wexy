package ai.wexy.gateway.error;

import ai.wexy.common.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.reactive.error.ErrorWebExceptionHandler;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.PrematureCloseException;

import java.net.ConnectException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;

/**
 * Every error that leaves the gateway leaves here, in the shared envelope.
 *
 * Ordered ahead of Spring Boot's default handler (-1), which would answer with its own JSON shape.
 * A {@link GatewayRejection} keeps its code and message. Anything else is answered by status
 * alone, with a fixed message: an exception's own text can carry a downstream host, a stack frame
 * or a library's internals, and none of that is the client's business (coding principles §9).
 */
@Component
@Order(-2)
public class GatewayErrorHandler implements ErrorWebExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GatewayErrorHandler.class);

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        if (error instanceof GatewayRejection rejection) {
            return ErrorResponses.write(exchange, rejection.code(), rejection.getMessage(),
                    rejection.retryAfterSeconds());
        }

        int status = statusOf(error);
        ErrorCode code = ErrorCode.forStatus(status);
        if (status >= 500) {
            log.error("{} {} failed with {}: {}", exchange.getRequest().getMethod(),
                    exchange.getRequest().getPath(), status, error.toString());
        }
        long retryAfter = code == ErrorCode.UNAVAILABLE ? 2 : 0;
        return ErrorResponses.write(exchange, code, messageFor(code), retryAfter);
    }

    /**
     * A refused connection to forge-service arrives as Netty's AnnotatedConnectException (a
     * ConnectException), an unresolvable service name as UnknownHostException, both sometimes
     * wrapped; so the causes are walked rather than the top checked. Either way the service cannot
     * be reached, and the client should retry: 503. A connection the service closed mid-answer is
     * the service failing: 502.
     */
    static int statusOf(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof ResponseStatusException statusException) {
                return statusException.getStatusCode().value();
            }
            if (cause instanceof ConnectException || cause instanceof UnknownHostException) {
                return 503;
            }
            if (cause instanceof PrematureCloseException) {
                return 502;
            }
            if (cause instanceof TimeoutException) {
                return 504;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return 500;
    }

    private static String messageFor(ErrorCode code) {
        return switch (code) {
            case NOT_FOUND -> "No such route.";
            case TOO_LARGE -> "The request body is too large.";
            case UNAVAILABLE -> "The service is unavailable right now. Try again shortly.";
            case TIMEOUT -> "The service did not answer in time.";
            case BAD_REQUEST -> "The request was not understood.";
            case AUTH -> "Sign-in is required.";
            case FORBIDDEN -> "This is not allowed.";
            case RATE -> "Too many requests. Please slow down.";
            case UPSTREAM -> "A service behind the gateway failed.";
            default -> "Something went wrong on our side.";
        };
    }
}
