package ai.wexy.forge.allowance;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;

/**
 * The key the allowances know a caller by (W1; the creations platform design §11): HMAC-SHA256 of the verified Firebase
 * uid under WEXY_UID_HMAC_KEY, in lowercase hex. Every Redis key and every grant's owner holds it, never the uid itself,
 * so the allowance data names no Firebase account. A key that is not 32 bytes of hex stops startup everywhere; a
 * missing one stops it in prod, and elsewhere leaves the allowances unable to answer, so no prompt is granted. The key
 * is not rotated on deploy: a new key makes every caller new, with a new allowance.
 */
public final class UidKey {

    private static final Logger log = LoggerFactory.getLogger(UidKey.class);
    private static final String ALGORITHM = "HmacSHA256";
    static final int KEY_BYTES = 32;

    /** Null when no key is configured: {@link #of} then answers null, and the allowances deny. */
    private final SecretKeySpec key;

    public UidKey(String hex, boolean required) {
        String value = hex == null ? "" : hex.trim();
        if (value.isEmpty()) {
            if (required) {
                throw new IllegalStateException("wexy.allowance.uid-hmac-hex (WEXY_UID_HMAC_KEY) is not set: without it no caller "
                        + "can be counted, so forge refuses to start. Set 32 random bytes as 64 hex characters.");
            }
            log.warn("No uid key (wexy.allowance.uid-hmac-hex): the allowances cannot count anyone, so no prompt is granted.");
            this.key = null;
            return;
        }
        byte[] bytes;
        try {
            bytes = HexFormat.of().parseHex(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("wexy.allowance.uid-hmac-hex is not hexadecimal: set 32 random bytes as 64 hex characters.");
        }
        if (bytes.length != KEY_BYTES) {
            throw new IllegalStateException("wexy.allowance.uid-hmac-hex holds " + bytes.length + " bytes; it must hold " + KEY_BYTES
                    + " (64 hex characters).");
        }
        this.key = new SecretKeySpec(bytes, ALGORITHM);
    }

    /** The key for `uid`, or null when no uid key is configured. */
    public String of(String uid) {
        if (key == null) {
            return null;
        }
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(key);
            return HexFormat.of().formatHex(mac.doFinal(uid.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is always present", e);
        }
    }
}
