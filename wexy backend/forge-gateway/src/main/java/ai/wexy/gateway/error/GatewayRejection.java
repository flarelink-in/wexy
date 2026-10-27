package ai.wexy.gateway.error;

import ai.wexy.common.ErrorCode;

/**
 * A request the gateway refuses on purpose, carrying the code the client will see.
 *
 * Filters raise this rather than writing a response, so that every refusal leaves through one
 * handler ({@link GatewayErrorHandler}) in the shared envelope. Its message is ours and safe to
 * send; anything else that reaches the handler is answered without its message. No stack trace is
 * captured: a refusal is the design working, and thousands of them during a flood should not cost
 * a stack walk each.
 */
public class GatewayRejection extends RuntimeException {

    private final ErrorCode code;
    private final long retryAfterSeconds;

    public GatewayRejection(ErrorCode code, String message) {
        this(code, message, 0);
    }

    public GatewayRejection(ErrorCode code, String message, long retryAfterSeconds) {
        super(message, null, false, false);
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public ErrorCode code() {
        return code;
    }

    public long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
