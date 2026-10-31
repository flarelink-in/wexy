package ai.wexy.gateway.shield;

import org.junit.jupiter.api.Test;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.ratelimit.AbstractRateLimiter;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Spring Cloud Gateway's own limiter refuses with an empty body; the studio maps refusals by code,
 * so ours must carry the envelope.
 */
class RateLimitFilterTest {

    private final AtomicInteger forwarded = new AtomicInteger();
    private final GatewayFilterChain chain = exchange -> {
        forwarded.incrementAndGet();
        return Mono.empty();
    };

    private static AbstractRateLimiter<Object> limiter(boolean allowed, Map<String, String> headers) {
        return new AbstractRateLimiter<>(Object.class, "stub", null) {
            @Override
            public Mono<Response> isAllowed(String routeId, String id) {
                return Mono.just(new Response(allowed, headers));
            }
        };
    }

    private static MockServerWebExchange exchange() {
        return MockServerWebExchange.from(MockServerHttpRequest.post("/v1/forge/plan"));
    }

    @Test
    void aDenialAnswers429WithTheRateCodeAndTheLimitersRetryAfter() {
        KeyResolver key = exchange -> Mono.just("ip:203.0.113.7");
        RateLimitFilter filter = new RateLimitFilter(limiter(false, Map.of("Retry-After", "12",
                "X-RateLimit-Remaining", "0")), key, RateLimits.PRE_AUTH_ORDER, "forge-create");
        MockServerWebExchange exchange = exchange();

        filter.filter(exchange, chain).block();

        assertThat(forwarded).hasValue(0);
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(exchange.getResponse().getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("12");
        assertThat(exchange.getResponse().getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("0");
        assertThat(exchange.getResponse().getBodyAsString().block())
                .isEqualTo("{\"code\":\"rate\",\"message\":\"Too many requests. Please slow down.\"}");
    }

    /** A key that cannot be resolved must not mean unlimited. */
    @Test
    void anEmptyKeyIsRefused() {
        KeyResolver empty = exchange -> Mono.empty();
        RateLimitFilter filter = new RateLimitFilter(limiter(true, Map.of()), empty, RateLimits.PRE_AUTH_ORDER, "x");
        MockServerWebExchange exchange = exchange();

        filter.filter(exchange, chain).block();

        assertThat(forwarded).hasValue(0);
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
    }

    @Test
    void anAllowedRequestPassesWithTheLimitersHeaders() {
        KeyResolver key = exchange -> Mono.just("u:uid-1");
        RateLimitFilter filter = new RateLimitFilter(limiter(true, Map.of("X-RateLimit-Remaining", "7")), key,
                RateLimits.POST_AUTH_ORDER, "forge-edit-user");
        MockServerWebExchange exchange = exchange();

        filter.filter(exchange, chain).block();

        assertThat(forwarded).hasValue(1);
        assertThat(exchange.getResponse().getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("7");
        assertThat(filter.getOrder()).isEqualTo(-100);
    }
}
