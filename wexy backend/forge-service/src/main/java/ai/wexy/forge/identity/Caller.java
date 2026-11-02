package ai.wexy.forge.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import org.springframework.web.server.ServerWebExchange;

/**
 * Who is calling, as the gateway vouched for it in the internal token.
 *
 * @param uid       the Firebase uid
 * @param anonymous true for a Firebase anonymous user: one free prompt, then sign in (W1, Q92)
 * @param admin     true when the uid is on the gateway's admin allow-list
 * @param provider  Firebase's sign-in provider
 * @param ipk       the caller's network key (W1; {@code InternalToken.CLAIM_IPK}), or null when the gateway gave none:
 *                  an anonymous caller without one gets no prompt
 */
public record Caller(String uid, boolean anonymous, boolean admin, String provider, String ipk) {

    /** The verified caller of a request that required one. */
    public static Caller of(ServerWebExchange exchange) {
        Caller caller = exchange.getAttribute(InternalTokenFilter.CALLER_ATTRIBUTE);
        if (caller == null) {
            throw new ForgeException(ErrorCode.AUTH, "This request carries no verified caller.");
        }
        return caller;
    }
}
