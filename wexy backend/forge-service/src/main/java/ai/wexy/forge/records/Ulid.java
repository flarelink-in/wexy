package ai.wexy.forge.records;

import java.time.Instant;

/**
 * Ids as the API's are written (backend design guidelines §3): ULIDs. The shape lives in forge-common since W2
 * ({@link ai.wexy.common.Ulid}), where platform's accounts take theirs from too; this keeps forge's callers as they were.
 */
public final class Ulid {

    private Ulid() {
    }

    public static String next(Instant at) {
        return ai.wexy.common.Ulid.next(at);
    }

    /** Whether a string has a ULID's shape; anything else is not an id this service issued. */
    public static boolean looksLikeOne(String value) {
        return ai.wexy.common.Ulid.looksLikeOne(value);
    }
}
