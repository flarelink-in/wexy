package ai.wexy.gateway.auth;

import java.util.Objects;

/**
 * What Firebase vouched for about a caller.
 *
 * @param uid      the Firebase uid
 * @param provider Firebase's {@code sign_in_provider}: {@code anonymous}, {@code google.com}, …
 *                 ({@code unknown} when the token does not say)
 */
public record VerifiedCaller(String uid, String provider) {

    public static final String ANONYMOUS_PROVIDER = "anonymous";

    public VerifiedCaller {
        Objects.requireNonNull(uid, "uid");
        provider = provider == null || provider.isBlank() ? "unknown" : provider;
    }

    /**
     * True for a Firebase anonymous user. FlareLink refused every token without an email, which
     * includes all of these; Wexy lets them create (Q8) and asks for an account only to publish to
     * the Showcase.
     */
    public boolean anonymous() {
        return ANONYMOUS_PROVIDER.equals(provider);
    }
}
