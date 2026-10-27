package ai.wexy.gateway.shield;

import ai.wexy.gateway.auth.AuthAttributes;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.concurrent.ConcurrentHashMap;

/**
 * Builds the rate-limit filters the routes use: one limiter per configured bucket, keyed by client
 * address before authentication or by the verified uid after it.
 *
 * Adapted from FlareLink's RateLimiterConfiguration (pre-existing work), whose two rules hold here:
 * a key is never something the client chooses, and limits live in configuration, not in code.
 * The limiter at {@link #PRE_AUTH_ORDER} runs before App Check (-300) and sign-in (-200), so a flood
 * of junk tokens is refused before it costs a signature check; the one at {@link #POST_AUTH_ORDER}
 * runs after, where a verified uid exists to key on.
 */
@Component
public class RateLimits {

    /** Before authentication: Spring Cloud Gateway sorts a route's filters by order, not by insertion. */
    public static final int PRE_AUTH_ORDER = -500;

    /** After the authorization filter (-200). */
    public static final int POST_AUTH_ORDER = -100;

    private final ReactiveStringRedisTemplate redisTemplate;
    private final GatewayShieldProperties properties;
    private final KeyResolver clientIpKeyResolver;
    private final KeyResolver authenticatedUserKeyResolver;
    private final ConcurrentHashMap<String, TokenBucketRateLimiter> limiters = new ConcurrentHashMap<>();

    public RateLimits(ReactiveStringRedisTemplate redisTemplate,
                      GatewayShieldProperties properties,
                      @Qualifier("clientIpKeyResolver") KeyResolver clientIpKeyResolver,
                      @Qualifier("authenticatedUserKeyResolver") KeyResolver authenticatedUserKeyResolver) {
        this.redisTemplate = redisTemplate;
        this.properties = properties;
        this.clientIpKeyResolver = clientIpKeyResolver;
        this.authenticatedUserKeyResolver = authenticatedUserKeyResolver;
    }

    /** The limiter for a bucket. An unknown name fails at startup, when the routes are built. */
    public TokenBucketRateLimiter limiter(String bucket) {
        return limiters.computeIfAbsent(bucket, name ->
                new TokenBucketRateLimiter(redisTemplate, name, properties.bucket(name), properties));
    }

    /** Keyed by client address, before authentication. */
    public RateLimitFilter byClient(String bucket) {
        return new RateLimitFilter(limiter(bucket), clientIpKeyResolver, PRE_AUTH_ORDER, bucket);
    }

    /** Keyed by the verified uid (the address if there is none), after authentication. */
    public RateLimitFilter byUser(String bucket) {
        return new RateLimitFilter(limiter(bucket), authenticatedUserKeyResolver, POST_AUTH_ORDER, bucket);
    }

    /**
     * Keyed by uid, with a tighter bucket for Firebase anonymous users (backend architecture §4:
     * "anonymous tighter"). An anonymous account costs a script nothing to make, so it gets less.
     */
    public GatewayFilter byUserTiered(String signedInBucket, String anonymousBucket) {
        return new Tiered(byUser(signedInBucket), byUser(anonymousBucket));
    }

    /** Picks the anonymous or the signed-in limiter from what the authorization filter recorded. */
    public static final class Tiered implements GatewayFilter, Ordered {

        private final RateLimitFilter signedIn;
        private final RateLimitFilter anonymous;

        Tiered(RateLimitFilter signedIn, RateLimitFilter anonymous) {
            this.signedIn = signedIn;
            this.anonymous = anonymous;
        }

        public RateLimitFilter signedIn() {
            return signedIn;
        }

        public RateLimitFilter anonymous() {
            return anonymous;
        }

        @Override
        public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
            boolean isAnonymous = Boolean.TRUE.equals(exchange.getAttribute(AuthAttributes.ANONYMOUS));
            return (isAnonymous ? anonymous : signedIn).filter(exchange, chain);
        }

        @Override
        public int getOrder() {
            return POST_AUTH_ORDER;
        }
    }
}
