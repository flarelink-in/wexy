package ai.wexy.forge.error;

import ai.wexy.common.ErrorCode;

/**
 * A refusal or failure the service answers on purpose, with the code the studio maps to a
 * sentence. Its message is ours and safe to send (coding principles §9). No stack trace: a cap
 * reached is the design working. Since W1 it may carry a wait, which the envelope sends as
 * {@code Retry-After}: {@code quota} always does, to the allowance's reset.
 */
public class ForgeException extends RuntimeException {

    private final ErrorCode code;
    private final Long retryAfterSeconds;

    public ForgeException(ErrorCode code, String message) {
        this(code, message, null);
    }

    /** @param retryAfterSeconds whole seconds until trying again can succeed, or null when waiting opens nothing */
    public ForgeException(ErrorCode code, String message, Long retryAfterSeconds) {
        super(message, null, false, false);
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public ErrorCode code() {
        return code;
    }

    /** The wait to send as {@code Retry-After}, or null for none. */
    public Long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
