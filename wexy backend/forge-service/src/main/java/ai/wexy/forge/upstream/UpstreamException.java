package ai.wexy.forge.upstream;

import ai.wexy.common.ErrorCode;

/**
 * The Meta Model API failed, or could not be reached.
 *
 * The upstream's own words are kept for the logs and the probe, as an excerpt with the key
 * removed; they never reach a client (coding principles §9).
 */
public class UpstreamException extends RuntimeException {

    public enum Kind {
        /** 401 or 403: the key was refused, revoked, or the credit is gone. */
        AUTH,
        /** 429: Meta's rate limit. */
        RATE_LIMITED,
        /** Another 4xx: the API refused what we sent. */
        REJECTED,
        /** 5xx, or an error inside a stream. */
        SERVER,
        /** No answer, or no next event, in time. */
        TIMEOUT,
        /** The connection failed: DNS, refused, reset. */
        NETWORK,
        /** An answer we could not read: not a stream, not JSON. */
        MALFORMED
    }

    private final Kind kind;
    private final int status;
    private final String excerpt;

    public UpstreamException(Kind kind, int status, String excerpt) {
        super("Meta API " + (status > 0 ? "answered " + status : "failed") + " (" + kind + ")", null, false, false);
        this.kind = kind;
        this.status = status;
        this.excerpt = excerpt == null ? "" : excerpt;
    }

    /** The kind for an HTTP status that is not a success. */
    public static Kind kindOf(int status) {
        if (status == 401 || status == 403) {
            return Kind.AUTH;
        }
        if (status == 429) {
            return Kind.RATE_LIMITED;
        }
        return status >= 500 ? Kind.SERVER : Kind.REJECTED;
    }

    public Kind kind() {
        return kind;
    }

    public int status() {
        return status;
    }

    public String excerpt() {
        return excerpt;
    }

    /**
     * The studio's code. A refused key means live creation is paused (backend §6.6: the archive
     * takes over); a timeout is a timeout; anything else is the upstream failing.
     */
    public ErrorCode errorCode() {
        return switch (kind) {
            case AUTH -> ErrorCode.PAUSED;
            case TIMEOUT -> ErrorCode.TIMEOUT;
            default -> ErrorCode.UPSTREAM;
        };
    }

    /** What a client may read. */
    public String publicMessage() {
        return switch (kind) {
            case AUTH -> "Live creation is paused: the model provider refused our key.";
            case TIMEOUT -> "The model did not answer in time.";
            case RATE_LIMITED -> "The model provider is busy. Try again shortly.";
            default -> "The model provider failed.";
        };
    }

    /** For logs and the probe: the status, the kind and the upstream's excerpt. */
    public String describe() {
        return getMessage() + (excerpt.isEmpty() ? "" : ": " + excerpt);
    }
}
