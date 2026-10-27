package ai.wexy.common;

/**
 * The identity the gateway hands the service: a short-lived RS256 JWT in one header, signed with
 * the gateway's key and checked against the key set it publishes (backend architecture §4).
 *
 * The names live here because both sides must agree on them byte for byte. A claim read under the
 * wrong name is not an error anywhere; it is just null.
 */
public final class InternalToken {

    /** The only header that carries identity. The gateway strips any inbound copy. */
    public static final String HEADER = "X-Internal-JWT";

    public static final String ISSUER = "wexy-forge-gateway";

    /** Where the gateway publishes the public half of its signing key. */
    public static final String JWKS_PATH = "/.well-known/jwks.json";

    /** True for a Firebase anonymous user. The Firebase uid itself travels as the subject. */
    public static final String CLAIM_ANONYMOUS = "anon";

    /** True when the uid is on the gateway's admin allow-list. */
    public static final String CLAIM_ADMIN = "admin";

    /** Firebase's {@code sign_in_provider}: {@code anonymous}, {@code google.com}, … */
    public static final String CLAIM_PROVIDER = "provider";

    /** Two minutes, as FlareLink's: long enough for a request, short enough that a leak expires. */
    public static final long LIFETIME_MILLIS = 120_000;

    private InternalToken() {
    }
}
