package ai.wexy.common;

/**
 * The closed set of error codes both services return, and the HTTP status each travels with.
 *
 * The frontend maps each code to one sentence in the studio (backend architecture §12), so a code
 * is a contract. Adding one changes this enum, §12 and the frontend's forge client on the same day
 * (design guidelines §1). Several codes share a status because the studio answers them
 * differently: {@code budget} and {@code paused} send it to the archive, {@code unavailable} asks
 * for a retry.
 *
 * W1 (2026-11-02; the creations platform design §10) adds two: {@code content-refused}, an idea
 * content safety refused before any grant or model call, and {@code quota}, a signed-in caller's
 * allowance spent, always with {@code Retry-After} to its reset. A spent anonymous allowance is the
 * existing {@code account-required}: signing in is the way on, not waiting.
 *
 * W2 (2026-11-03) brings {@code conflict} (409) forward from W3: a write based on a version that has moved on
 * ({@code expectedVersion}), or a name another account holds (a handle). The studio reads again and says which.
 *
 * W3 (2026-11-03 evening) adds {@code storage-full} (403): the account's saved worlds or bytes at their cap. It never
 * carries {@code Retry-After}: deleting a world frees space, and waiting does not.
 */
public enum ErrorCode {

    BAD_REQUEST("bad-request", 400),
    AUTH("auth", 401),
    APPCHECK("appcheck", 403),
    ACCOUNT_REQUIRED("account-required", 403),
    FORBIDDEN("forbidden", 403),
    STORAGE_FULL("storage-full", 403),
    NOT_FOUND("not-found", 404),
    CONFLICT("conflict", 409),
    TOO_LARGE("too-large", 413),
    CONTENT_REFUSED("content-refused", 422),
    RATE("rate", 429),
    QUOTA("quota", 429),
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
     * 403 is {@code forbidden}, 503 is {@code unavailable}, 429 is {@code rate} (never {@code quota},
     * whose reset only forge knows), and 422 is {@code bad-request} (never a content refusal). 409 has one code,
     * {@code conflict} (W2).
     */
    public static ErrorCode forStatus(int status) {
        return switch (status) {
            case 401 -> AUTH;
            case 403 -> FORBIDDEN;
            case 404 -> NOT_FOUND;
            case 409 -> CONFLICT;
            case 413 -> TOO_LARGE;
            case 429 -> RATE;
            case 502 -> UPSTREAM;
            case 503 -> UNAVAILABLE;
            case 504 -> TIMEOUT;
            default -> status >= 500 ? INTERNAL : BAD_REQUEST;
        };
    }
}
