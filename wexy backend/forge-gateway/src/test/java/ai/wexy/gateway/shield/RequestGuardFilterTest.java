package ai.wexy.gateway.shield;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DefaultDataBufferFactory;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PL-T17's body caps (W2; the creations platform design §10, §11): 768 KiB passes only a world's save, 1 MiB only a
 * poster, and every other route keeps 256 KiB, a DELETE included; by the declared length, and while a chunked body
 * streams.
 */
class RequestGuardFilterTest {

    private static final long DEFAULT = 256 * 1024;
    private static final long SAVE = 768 * 1024;
    private static final long POSTER = 1024 * 1024;
    private static final String WORLD = "01JC3W5F6Q7R8S9T0V1W2X3Y4Z";

    private final GatewayShieldProperties properties = new GatewayShieldProperties();
    private final RequestGuardFilter guard = new RequestGuardFilter(new ClientAddressResolver(properties), properties);
    private final AtomicReference<ServerWebExchange> passed = new AtomicReference<>();
    private final WebFilterChain chain = exchange -> {
        passed.set(exchange);
        return Mono.empty();
    };

    /** The status a request declaring `length` bytes gets: 200 when it passed the guard, else the guard's own answer. */
    private int status(HttpMethod method, String path, long length) {
        passed.set(null);
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.method(method, path)
                .remoteAddress(new InetSocketAddress("203.0.113.9", 4100)).contentLength(length));
        guard.filter(exchange, chain).block();
        if (passed.get() != null) {
            return 200;
        }
        HttpStatus answered = HttpStatus.resolve(exchange.getResponse().getStatusCode().value());
        if (answered == HttpStatus.PAYLOAD_TOO_LARGE) {
            assertThat(exchange.getResponse().getBodyAsString().block()).contains("\"code\":\"too-large\"");
        }
        return answered.value();
    }

    @Test
    void aWorldsSavePasses768KiBAndNoMore() {
        assertThat(status(HttpMethod.POST, "/v1/worlds", SAVE)).isEqualTo(200);
        assertThat(status(HttpMethod.POST, "/v1/worlds", SAVE + 1)).isEqualTo(413);
        assertThat(status(HttpMethod.POST, "/v1/worlds/" + WORLD + "/revisions", SAVE)).isEqualTo(200);
        assertThat(status(HttpMethod.POST, "/v1/worlds/" + WORLD + "/revisions", SAVE + 1)).isEqualTo(413);
    }

    @Test
    void aPosterPassesOneMiBAndNoMore() {
        assertThat(status(HttpMethod.POST, "/v1/worlds/" + WORLD + "/posters", POSTER)).isEqualTo(200);
        assertThat(status(HttpMethod.POST, "/v1/worlds/" + WORLD + "/posters", POSTER + 1)).isEqualTo(413);
    }

    /** The safe side: another route, another method on a save's path, or a path spelled otherwise keeps the default. */
    @Test
    void everythingElseKeeps256KiB() {
        for (Object[] row : new Object[][]{
                {HttpMethod.POST, "/v1/forge/plan"},
                {HttpMethod.POST, "/v1/agent/turn"},
                {HttpMethod.PATCH, "/v1/me/profile"},
                {HttpMethod.PATCH, "/v1/worlds/" + WORLD},
                {HttpMethod.POST, "/v1/me"},
                {HttpMethod.POST, "/v1/worlds/" + WORLD + "/submissions"},
                {HttpMethod.POST, "/v1/worlds/a/b/revisions"},
                {HttpMethod.POST, "/v1/worldsx"},
                // A cap is its method's as well as its path's.
                {HttpMethod.PUT, "/v1/worlds"},
                {HttpMethod.PATCH, "/v1/worlds/" + WORLD + "/revisions"}}) {
            HttpMethod method = (HttpMethod) row[0];
            String path = (String) row[1];
            assertThat(status(method, path, DEFAULT)).as("%s %s at the cap", method, path).isEqualTo(200);
            assertThat(status(method, path, DEFAULT + 1)).as("%s %s past it", method, path).isEqualTo(413);
        }
    }

    /** W2 added DELETE routes, and the gateway forwards any method's body: a DELETE's is capped like the rest. */
    @Test
    void aDeletesBodyIsCappedToo() {
        assertThat(status(HttpMethod.DELETE, "/v1/me", DEFAULT)).isEqualTo(200);
        assertThat(status(HttpMethod.DELETE, "/v1/me", DEFAULT + 1)).isEqualTo(413);
        assertThat(status(HttpMethod.DELETE, "/v1/worlds/" + WORLD, DEFAULT + 1)).isEqualTo(413);
    }

    /** A chunked body declares nothing, so it is counted as it streams, against its own route's cap. */
    @Test
    void aChunkedBodyIsCountedAgainstItsRoutesCap() {
        assertThat(streamed("/v1/worlds", SAVE)).isNull();
        assertThat(streamed("/v1/worlds", SAVE + 1)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(413));
        assertThat(streamed("/v1/forge/direct", DEFAULT + 1)).isInstanceOf(ResponseStatusException.class);
    }

    /** What reading a chunked body of `bytes` through the guard ended in: null when it was read whole. */
    private Throwable streamed(String path, long bytes) {
        int chunk = 64 * 1024;
        Flux<DataBuffer> body = Flux.range(0, (int) ((bytes + chunk - 1) / chunk))
                .map(i -> DefaultDataBufferFactory.sharedInstance.wrap(new byte[(int) Math.min(chunk, bytes - (long) i * chunk)]));
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post(path)
                .remoteAddress(new InetSocketAddress("203.0.113.9", 4100)).body(body));
        WebFilterChain reading = ex -> ex.getRequest().getBody().map(DataBuffer::readableByteCount).then();
        try {
            guard.filter(exchange, reading).block();
            return null;
        } catch (Throwable error) {
            return error;
        }
    }

    /** A cap written wrong would cap nothing; the gateway refuses to start instead. */
    @Test
    void aMalformedRouteCapStopsStartup() {
        for (Map<String, Long> routes : java.util.List.of(Map.of("POST/v1/worlds", SAVE), Map.of("post /v1/worlds", SAVE),
                Map.of("POST v1/worlds", SAVE), Map.of("POST /v1/worlds", 0L))) {
            GatewayShieldProperties bad = new GatewayShieldProperties();
            bad.getBody().setRoutes(routes);
            assertThatThrownBy(() -> new RequestGuardFilter(new ClientAddressResolver(bad), bad)).as(routes.toString())
                    .isInstanceOf(IllegalStateException.class);
        }
    }
}
