package ai.wexy.forge.records;

import java.security.SecureRandom;
import java.time.Instant;

/**
 * Ids as the API's are written (backend design guidelines §3): ULIDs, 26 characters of Crockford's
 * base 32, the first ten the creation time in milliseconds, the rest random. They sort by time, and
 * a guess at another caller's generation is hopeless (80 random bits).
 */
public final class Ulid {

    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private Ulid() {
    }

    public static String next(Instant at) {
        char[] out = new char[26];
        long time = at.toEpochMilli();
        for (int i = 9; i >= 0; i--) {
            out[i] = ALPHABET[(int) (time & 31)];
            time >>>= 5;
        }
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);
        long hi = 0;
        long lo = 0;
        for (int i = 0; i < 5; i++) {
            hi = (hi << 8) | (random[i] & 0xff);
            lo = (lo << 8) | (random[i + 5] & 0xff);
        }
        for (int i = 17; i >= 10; i--) {
            out[i] = ALPHABET[(int) (hi & 31)];
            hi >>>= 5;
        }
        for (int i = 25; i >= 18; i--) {
            out[i] = ALPHABET[(int) (lo & 31)];
            lo >>>= 5;
        }
        return new String(out);
    }

    /** Whether a string has a ULID's shape; anything else is not an id this service issued. */
    public static boolean looksLikeOne(String value) {
        if (value == null || value.length() != 26) {
            return false;
        }
        for (char c : value.toCharArray()) {
            if (c >= 128 || "0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(c) < 0) {
                return false;
            }
        }
        return true;
    }
}
