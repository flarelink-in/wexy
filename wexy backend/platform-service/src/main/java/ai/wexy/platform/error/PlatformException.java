package ai.wexy.platform.error;

import ai.wexy.common.ErrorCode;

/**
 * A refusal or failure the platform answers on purpose, with the code the studio maps to a sentence. Its message is
 * ours and safe to send: never a SQL error, a subject or a token (the creations platform design §13). No stack trace:
 * a taken handle or a stale version is the design working.
 */
public class PlatformException extends RuntimeException {

    private final ErrorCode code;

    public PlatformException(ErrorCode code, String message) {
        super(message, null, false, false);
        this.code = code;
    }

    public ErrorCode code() {
        return code;
    }
}
