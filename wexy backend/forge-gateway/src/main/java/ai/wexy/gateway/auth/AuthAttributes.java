package ai.wexy.gateway.auth;

/**
 * What the authorization filter records on the exchange once a caller is verified, so the
 * post-authentication limiters key on a verified identity instead of anything the client sent.
 */
public final class AuthAttributes {

    /** The verified Firebase uid. */
    public static final String UID = "wexy.auth.uid";

    /** True for a Firebase anonymous user. */
    public static final String ANONYMOUS = "wexy.auth.anonymous";

    private AuthAttributes() {
    }
}
