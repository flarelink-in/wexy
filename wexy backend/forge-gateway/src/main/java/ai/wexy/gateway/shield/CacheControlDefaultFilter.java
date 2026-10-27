package ai.wexy.gateway.shield;

import org.springframework.core.Ordered;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Makes "do not store" the default for every response, so caching is something an endpoint asks
 * for rather than something the CDN decides.
 *
 * Copied from FlareLink's CacheControlDefaultFilter (pre-existing work), where Cloudflare, given no
 * Cache-Control, cached responses by URL alone and served them to the next caller of that URL. A
 * public read that wants caching (a world, the Showcase, stats) says so itself; everything else,
 * the gateway's own refusals included, leaves as no-store (design guidelines §2).
 */
@Component
public class CacheControlDefaultFilter implements WebFilter, Ordered {

    private static final String NO_STORE = CacheControl.noStore().getHeaderValue();

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpResponse response = exchange.getResponse();
        // At commit, once forge-service's headers have been copied in, or the gateway's own for a
        // response it writes itself (401, 429, 413, no route).
        response.beforeCommit(() -> {
            HttpHeaders headers = response.getHeaders();
            if (!headers.containsKey(HttpHeaders.CACHE_CONTROL)) {
                headers.set(HttpHeaders.CACHE_CONTROL, NO_STORE);
            }
            return Mono.empty();
        });
        return chain.filter(exchange);
    }

    @Override
    public int getOrder() {
        // Ahead of the edge shield (+100) and the request guard (+110), so their refusals are covered.
        return Ordered.HIGHEST_PRECEDENCE + 90;
    }
}
