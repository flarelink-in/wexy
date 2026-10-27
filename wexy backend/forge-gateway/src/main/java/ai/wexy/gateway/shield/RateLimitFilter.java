package ai.wexy.gateway.shield;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.ErrorResponses;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.cloud.gateway.filter.ratelimit.RateLimiter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.support.ServerWebExchangeUtils;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * One rate limiter on one route, refusing in the shared envelope.
 *
 * New in Wexy. FlareLink used Spring Cloud Gateway's RequestRateLimiter filter, which refuses
 * with an empty 429; the studio maps errors by their code, so a refusal has to carry one. This
 * does what that filter did (key the request, ask the limiter, copy its headers) and writes
 * {@code rate} on a denial. An empty key is refused rather than waved through unlimited
 * (FlareLink's denyEmptyKey).
 */
public class RateLimitFilter implements GatewayFilter, Ordered {

    private final RateLimiter<?> limiter;
    private final KeyResolver keyResolver;
    private final int order;
    private final String bucket;

    public RateLimitFilter(RateLimiter<?> limiter, KeyResolver keyResolver, int order, String bucket) {
        this.limiter = limiter;
        this.keyResolver = keyResolver;
        this.order = order;
        this.bucket = bucket;
    }

    /** The bucket's name, so a route's filters can be checked against the plan (ForgeRoutesTest). */
    public String bucket() {
        return bucket;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        Route route = exchange.getAttribute(ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR);
        String routeId = route != null ? route.getId() : bucket;

        return keyResolver.resolve(exchange)
                .defaultIfEmpty("")
                .flatMap(key -> {
                    if (key.isEmpty()) {
                        return ErrorResponses.write(exchange, ErrorCode.RATE,
                                "This request cannot be rate limited, so it is refused.", 1);
                    }
                    return limiter.isAllowed(routeId, key).flatMap(response -> {
                        response.getHeaders().forEach((name, value) ->
                                exchange.getResponse().getHeaders().set(name, value));
                        if (response.isAllowed()) {
                            return chain.filter(exchange);
                        }
                        return ErrorResponses.write(exchange, ErrorCode.RATE,
                                "Too many requests. Please slow down.", retryAfter(exchange));
                    });
                });
    }

    private static long retryAfter(ServerWebExchange exchange) {
        String header = exchange.getResponse().getHeaders().getFirst(HttpHeaders.RETRY_AFTER);
        try {
            return header == null ? 1 : Math.max(1, Long.parseLong(header));
        } catch (NumberFormatException e) {
            return 1;
        }
    }

    @Override
    public int getOrder() {
        return order;
    }
}
