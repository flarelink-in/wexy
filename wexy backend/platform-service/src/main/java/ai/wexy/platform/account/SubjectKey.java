package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import java.util.List;

/**
 * How an account knows its Firebase subject (W2; the creations platform design §5, "Identity privacy"): HMAC-SHA256 of
 * the verified uid under WEXY_ACCOUNT_HMAC_KEY, in lowercase hex, stored with the key's version. No table holds a
 * Firebase uid or an email, and the key is platform's own, so these hashes cannot be joined with forge's.
 *
 * A key that is not 32 bytes of hex stops startup everywhere; a missing one stops it in prod and elsewhere leaves the
 * accounts answering 503, never creating an account under no key. One version today: a rotation adds the old key as a
 * retired version that lookups try before the current one, and re-keys a row it finds, so no account is duplicated.
 */
public final class SubjectKey {

    private static final Logger log = LoggerFactory.getLogger(SubjectKey.class);
    private static final String ALGORITHM = "HmacSHA256";
    static final int KEY_BYTES = 32;

    /** A subject as the account table stores it. */
    public record Subject(String hmac, int version) {
    }

    /** Null when no key is configured: every account call is then 503. */
    private final SecretKeySpec key;
    private final int version;

    public SubjectKey(String hex, int version, boolean required) {
        this.version = version;
        String value = hex == null ? "" : hex.trim();
        if (value.isEmpty()) {
            if (required) {
                throw new IllegalStateException("wexy.account.hmac-hex (WEXY_ACCOUNT_HMAC_KEY) is not set: without it no "
                        + "account can be found or made, so the platform refuses to start. Set 32 random bytes as 64 hex characters.");
            }
            log.warn("No account key (wexy.account.hmac-hex): every account call answers 503.");
            this.key = null;
            return;
        }
        byte[] bytes;
        try {
            bytes = HexFormat.of().parseHex(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("wexy.account.hmac-hex is not hexadecimal: set 32 random bytes as 64 hex characters.");
        }
        if (bytes.length != KEY_BYTES) {
            throw new IllegalStateException("wexy.account.hmac-hex holds " + bytes.length + " bytes; it must hold " + KEY_BYTES
                    + " (64 hex characters).");
        }
        this.key = new SecretKeySpec(bytes, ALGORITHM);
    }

    /** The subject a new account is stored under: the current key's. */
    public Subject current(String uid) {
        if (key == null) {
            throw new PlatformException(ErrorCode.UNAVAILABLE, "Accounts are unavailable right now. Try again shortly.");
        }
        return new Subject(hmac(uid), version);
    }

    /** Every stored form `uid` can have, to look an account up by: the current key's alone until a rotation. */
    public List<String> lookups(String uid) {
        return List.of(current(uid).hmac());
    }

    private String hmac(String uid) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(key);
            return HexFormat.of().formatHex(mac.doFinal(uid.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is always present", e);
        }
    }
}
