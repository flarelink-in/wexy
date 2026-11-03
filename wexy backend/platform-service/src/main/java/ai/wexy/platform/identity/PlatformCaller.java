package ai.wexy.platform.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import org.springframework.web.server.ServerWebExchange;

/**
 * Who is calling, as the gateway vouched for it in a token minted for the platform: never anonymous here (the
 * filter refuses those), so always someone with a real account's sign-in.
 *
 * @param uid      the Firebase uid: mapped to the account by its HMAC, and never stored or logged as it is
 * @param admin    true when the uid is on the gateway's admin allow-list
 * @param provider Firebase's sign-in provider, e.g. {@code google.com}
 */
public record PlatformCaller(String uid, boolean admin, String provider) {

    /** The verified caller of a request that required one. */
    public static PlatformCaller of(ServerWebExchange exchange) {
        PlatformCaller caller = exchange.getAttribute(InternalTokenFilter.CALLER_ATTRIBUTE);
        if (caller == null) {
            throw new PlatformException(ErrorCode.AUTH, "This request carries no verified caller.");
        }
        return caller;
    }
}
