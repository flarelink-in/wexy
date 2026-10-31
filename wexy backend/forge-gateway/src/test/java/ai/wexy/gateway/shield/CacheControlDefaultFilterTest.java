package ai.wexy.gateway.shield;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.WebFilterChain;

import static org.assertj.core.api.Assertions.assertThat;

/** Copied from FlareLink's CacheControlDefaultFilterTest (pre-existing work), with Wexy's routes. */
class CacheControlDefaultFilterTest {

    private final CacheControlDefaultFilter filter = new CacheControlDefaultFilter();

    /** Runs the filter around a "downstream" answering with the given status and headers. */
    private MockServerWebExchange respond(String path, HttpStatus status, HttpHeaders downstream) {
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.get(path)
                .header(HttpHeaders.AUTHORIZATION, "Bearer creator-token"));
        WebFilterChain chain = ex -> {
            ex.getResponse().setStatusCode(status);
            ex.getResponse().getHeaders().addAll(downstream);
            return ex.getResponse().setComplete();
        };
        filter.filter(exchange, chain).block();
        return exchange;
    }

    @Test
    void aResponseThatSaysNothingIsNeverStored() {
        MockServerWebExchange exchange = respond("/v1/forge/mode", HttpStatus.OK, new HttpHeaders());

        assertThat(exchange.getResponse().getHeaders().getCacheControl()).isEqualTo("no-store");
    }

    @Test
    void aPublicReadThatAsksToBeCachedKeepsItsOwnHeader() {
        HttpHeaders showcase = new HttpHeaders();
        showcase.setCacheControl("max-age=30, public, s-maxage=60");

        MockServerWebExchange exchange = respond("/v1/showcase", HttpStatus.OK, showcase);

        assertThat(exchange.getResponse().getHeaders().get(HttpHeaders.CACHE_CONTROL))
                .containsExactly("max-age=30, public, s-maxage=60");
    }

    /** What the gateway writes itself: a throttled request must not be cached as the answer. */
    @Test
    void theGatewaysOwnRefusalsAreNotStoredEither() {
        MockServerWebExchange exchange = respond("/v1/worlds/abc", HttpStatus.TOO_MANY_REQUESTS, new HttpHeaders());

        assertThat(exchange.getResponse().getHeaders().getCacheControl()).isEqualTo("no-store");
    }
}
