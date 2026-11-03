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

    /**
     * The caller's network as forge's allowances count it (W1; the creations platform design §11):
     * HMAC-SHA256 of the client's IPv4 address, or its IPv6 /64, under the gateway's network key, in
     * lowercase hex. Absent when the address could not be resolved or no key is configured, and then
     * an anonymous caller gets no prompt. Signed with the token, so no client can choose it; hashed,
     * so forge never sees an address.
     */
    public static final String CLAIM_IPK = "ipk";

    /**
     * The service a token is for, as its {@code aud} (W2; the creations platform design §14): the gateway mints one per
     * route's service, and each service refuses a token minted for the other, so one lifted on the compose network
     * opens nothing but the service it was meant for.
     */
    public static final String AUDIENCE_FORGE = "forge-service";

    /** The accounts and creations service's audience (W2). */
    public static final String AUDIENCE_PLATFORM = "platform-service";

    /** Two minutes, as FlareLink's: long enough for a request, short enough that a leak expires. */
    public static final long LIFETIME_MILLIS = 120_000;

    private InternalToken() {
    }
}
