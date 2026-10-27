package ai.wexy.forge.error;

import ai.wexy.common.ErrorCode;

/**
 * A refusal or failure the service answers on purpose, with the code the studio maps to a
 * sentence. Its message is ours and safe to send (coding principles §9). No stack trace: a cap
 * reached is the design working.
 */
public class ForgeException extends RuntimeException {

    private final ErrorCode code;

    public ForgeException(ErrorCode code, String message) {
        super(message, null, false, false);
        this.code = code;
    }

    public ErrorCode code() {
        return code;
    }
}
