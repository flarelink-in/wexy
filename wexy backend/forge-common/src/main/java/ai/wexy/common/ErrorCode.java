package ai.wexy.common;

/**
 * The closed set of error codes both services return, and the HTTP status each travels with.
 *
 * The frontend maps each code to one sentence in the studio (backend architecture §12), so a code
 * is a contract. Adding one changes this enum, §12 and the frontend's forge client on the same day
 * (design guidelines §1). Several codes share a status because the studio answers them
 * differently: {@code budget} and {@code paused} send it to the archive, {@code unavailable} asks
 * for a retry.
 */
public enum ErrorCode {

    BAD_REQUEST("bad-request", 400),
    AUTH("auth", 401),
    APPCHECK("appcheck", 403),
    ACCOUNT_REQUIRED("account-required", 403),
    FORBIDDEN("forbidden", 403),
    NOT_FOUND("not-found", 404),
    TOO_LARGE("too-large", 413),
    RATE("rate", 429),
    INTERNAL("internal", 500),
    UPSTREAM("upstream", 502),
    BUDGET("budget", 503),
    PAUSED("paused", 503),
    UNAVAILABLE("unavailable", 503),
    TIMEOUT("timeout", 504);

    private final String code;
    private final int status;

    ErrorCode(String code, int status) {
        this.code = code;
        this.status = status;
    }

    /** The wire form, as the envelope's {@code code} field carries it. */
    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    /** Looks up a wire code. An unknown code is refused, never guessed at. */
    public static ErrorCode fromCode(String code) {
        for (ErrorCode candidate : values()) {
            if (candidate.code.equals(code)) {
                return candidate;
            }
        }
        throw new IllegalArgumentException("Unknown error code: " + code);
    }

    /**
     * The code for an error that arrives with a status and none of ours: a framework 404, a proxy
     * timeout, a refused connection. Statuses with several codes take the one that promises least:
     * 403 is {@code forbidden}, 503 is {@code unavailable}.
     */
    public static ErrorCode forStatus(int status) {
        return switch (status) {
            case 401 -> AUTH;
            case 403 -> FORBIDDEN;
            case 404 -> NOT_FOUND;
            case 413 -> TOO_LARGE;
            case 429 -> RATE;
            case 502 -> UPSTREAM;
            case 503 -> UNAVAILABLE;
            case 504 -> TIMEOUT;
            default -> status >= 500 ? INTERNAL : BAD_REQUEST;
        };
    }
}
