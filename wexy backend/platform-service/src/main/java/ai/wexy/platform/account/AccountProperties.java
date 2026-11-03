package ai.wexy.platform.account;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The accounts' settings (W2; the creations platform design §5, §6), every one required.
 *
 * @param hmacHex       the key a verified Firebase uid is known by here: 32 random bytes as 64 hex characters
 *                      (WEXY_ACCOUNT_HMAC_KEY), platform's own, never forge's uid key, so the two schemas' hashes
 *                      cannot be joined. Empty only outside prod (see {@code keyRequired}): accounts then answer 503.
 * @param hmacVersion   the version that key is stored under ({@code account.hmac_key_version}); a rotation adds a
 *                      version and a migration, never a silent swap, which would make every account new
 * @param keyRequired   true in prod: startup stops without the key
 * @param policyVersion the version of the account terms an account is created under
 */
@ConfigurationProperties(prefix = "wexy.account")
public record AccountProperties(String hmacHex, int hmacVersion, boolean keyRequired, int policyVersion) {

    public AccountProperties {
        if (hmacVersion < 1) {
            throw new IllegalStateException("wexy.account.hmac-version must be 1 or more, not " + hmacVersion);
        }
        if (policyVersion < 1) {
            throw new IllegalStateException("wexy.account.policy-version must be 1 or more, not " + policyVersion);
        }
    }
}
