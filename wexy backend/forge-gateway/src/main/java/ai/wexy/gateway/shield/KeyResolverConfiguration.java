package ai.wexy.gateway.shield;

import ai.wexy.gateway.auth.AuthAttributes;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import reactor.core.publisher.Mono;

/**
 * The two rate-limit keys. Adapted from FlareLink's RateLimiterConfiguration (pre-existing work).
 *
 * FlareLink's lesson: its old per-user key read a request header the gateway had stopped setting,
 * so it was purely client-supplied, and rotating it gave an attacker a fresh bucket per request.
 * Keys come only from the resolved client address, or from a uid the gateway itself verified.
 */
@Configuration
public class KeyResolverConfiguration {

    /** The client address. Primary, so Spring Cloud Gateway's own rate-limit wiring finds one. */
    @Bean(name = "clientIpKeyResolver")
    @Primary
    public KeyResolver clientIpKeyResolver(ClientAddressResolver addressResolver) {
        return exchange -> Mono.just("ip:" + addressResolver.resolve(exchange));
    }

    /**
     * The verified uid, meaningful only after the authorization filter. Falls back to the address,
     * so an unauthenticated request never lands in an empty or shared bucket.
     */
    @Bean(name = "authenticatedUserKeyResolver")
    public KeyResolver authenticatedUserKeyResolver(ClientAddressResolver addressResolver) {
        return exchange -> {
            Object uid = exchange.getAttributes().get(AuthAttributes.UID);
            if (uid instanceof String value && !value.isEmpty()) {
                return Mono.just("u:" + value);
            }
            return Mono.just("ip:" + addressResolver.resolve(exchange));
        };
    }
}
