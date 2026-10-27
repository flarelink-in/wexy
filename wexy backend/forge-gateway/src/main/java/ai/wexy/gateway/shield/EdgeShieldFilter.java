package ai.wexy.gateway.shield;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.ErrorResponses;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.cors.reactive.CorsUtils;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import reactor.core.publisher.Mono;

import java.util.List;
import java.util.Set;

/**
 * The first filter in the chain.
 *
 * Copied from FlareLink's EdgeShieldFilter (pre-existing work). Changed: refusals use Wexy's
 * envelope, and a ban answers 429 {@code rate} like a throttle (FlareLink sent 403), because the
 * client's right move is the same: wait. It is a {@link WebFilter} rather than a gateway global
 * filter on purpose: global filters run only once a route has matched, so a flood aimed at paths
 * that match nothing would skip the throttle while still paying for every route's predicates.
 *
 * Cheapest first: strip identity headers a client must never set; answer banned clients from a
 * local cache; apply the per-client edge budget.
 */
@Component
public class EdgeShieldFilter implements WebFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(EdgeShieldFilter.class);

    private final EdgeThrottle throttle;
    private final ClientAddressResolver addressResolver;
    private final GatewayShieldProperties properties;
    private final List<PathPattern> bypassPatterns;
    private final Set<String> allowedClients;
    private final List<String> strippedHeaders;

    /**
     * An inbound internal token can only be an impersonation attempt: the gateway mints that header
     * itself. Nothing breaks when this fires, which is why it needs a meter.
     */
    private final Counter spoofedHeaderMeter;

    public EdgeShieldFilter(EdgeThrottle throttle,
                            ClientAddressResolver addressResolver,
                            GatewayShieldProperties properties,
                            MeterRegistry meterRegistry) {
        this.throttle = throttle;
        this.addressResolver = addressResolver;
        this.properties = properties;
        this.allowedClients = Set.copyOf(properties.getAllowedClients());
        this.strippedHeaders = List.copyOf(properties.getStrippedHeaders());

        PathPatternParser parser = new PathPatternParser();
        this.bypassPatterns = properties.getBypassPaths().stream().map(parser::parse).toList();

        this.spoofedHeaderMeter = Counter.builder("wexy.edge.spoofed.headers")
                .description("Requests that arrived carrying an identity header only the gateway may set")
                .register(meterRegistry);
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerWebExchange sanitised = stripSpoofableHeaders(exchange);

        if (!properties.isEnabled() || isExempt(sanitised)) {
            return chain.filter(sanitised);
        }

        String clientIp = addressResolver.resolve(sanitised);
        if (allowedClients.contains(clientIp)) {
            return chain.filter(sanitised);
        }

        return throttle.check(clientIp).flatMap(verdict -> {
            if (verdict.allowed()) {
                // No X-RateLimit-* header here: the route limiter sets one, and a second would make
                // a confusing multi-valued header.
                return chain.filter(sanitised);
            }

            if (verdict.banned()) {
                log.warn("Blocking banned client {} for another {}s ({} {})",
                        clientIp, verdict.retryAfterSeconds(),
                        sanitised.getRequest().getMethod(), sanitised.getRequest().getPath());
                return ErrorResponses.write(sanitised, ErrorCode.RATE,
                        "Too many rejected requests. Access is blocked for a while.", verdict.retryAfterSeconds());
            }

            return ErrorResponses.write(sanitised, ErrorCode.RATE,
                    "Too many requests. Please slow down.", verdict.retryAfterSeconds());
        });
    }

    /**
     * Dropping inbound identity headers here covers every route, including the public ones that run
     * no authentication filter at all.
     */
    private ServerWebExchange stripSpoofableHeaders(ServerWebExchange exchange) {
        HttpHeaders incoming = exchange.getRequest().getHeaders();
        boolean present = strippedHeaders.stream().anyMatch(incoming::containsKey);
        if (!present) {
            return exchange;
        }
        spoofedHeaderMeter.increment();
        ServerHttpRequest cleaned = exchange.getRequest().mutate()
                .headers(headers -> strippedHeaders.forEach(headers::remove))
                .build();
        return exchange.mutate().request(cleaned).build();
    }

    private boolean isExempt(ServerWebExchange exchange) {
        // Preflights never reach forge-service (the CORS filter answers them), so throttling them
        // only risks turning a burst into a browser-side CORS failure.
        if (CorsUtils.isPreFlightRequest(exchange.getRequest())) {
            return true;
        }
        return bypassPatterns.stream()
                .anyMatch(pattern -> pattern.matches(exchange.getRequest().getPath().pathWithinApplication()));
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 100;
    }
}
