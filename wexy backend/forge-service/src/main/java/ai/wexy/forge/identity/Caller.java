package ai.wexy.forge.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import org.springframework.web.server.ServerWebExchange;

/**
 * Who is calling, as the gateway vouched for it in the internal token.
 *
 * @param uid       the Firebase uid
 * @param anonymous true for a Firebase anonymous user: may create and share, not publish to the
 *                  Showcase (Q8)
 * @param admin     true when the uid is on the gateway's admin allow-list
 * @param provider  Firebase's sign-in provider
 */
public record Caller(String uid, boolean anonymous, boolean admin, String provider) {

    /** The verified caller of a request that required one. */
    public static Caller of(ServerWebExchange exchange) {
        Caller caller = exchange.getAttribute(InternalTokenFilter.CALLER_ATTRIBUTE);
        if (caller == null) {
            throw new ForgeException(ErrorCode.AUTH, "This request carries no verified caller.");
        }
        return caller;
    }
}
