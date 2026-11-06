package ai.wexy.gateway;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.FluxExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * G1 (forge-loop design §12): the gateway passes a model stream through as it arrives. A filter that
 * reads the body would buffer the whole response (gotchas), and the studio would see nothing until
 * the model finished. Here a fake forge-service writes three events 300 ms apart, and the client's
 * first event must arrive before the service writes its last.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"test", "local"})
class StreamingPassThroughTest {

    private static final ParameterizedTypeReference<ServerSentEvent<String>> EVENTS = new ParameterizedTypeReference<>() {
    };
    private static final long PAUSE_MILLIS = 300;

    /** When the fake service finished each write, on this JVM's clock. */
    private static final List<Long> writes = new CopyOnWriteArrayList<>();
    private static final HttpServer forgeService = startForgeService();

    private static HttpServer startForgeService() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream out = exchange.getResponseBody()) {
                    for (int i = 1; i <= 3; i++) {
                        out.write(("event:delta\ndata:{\"text\":\"" + i + "\"}\n\n").getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        writes.add(System.nanoTime());
                        Thread.sleep(PAUSE_MILLIS);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            server.start();
            return server;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void routeToTheFake(DynamicPropertyRegistry registry) {
        registry.add("wexy.forge-service.url", () -> "http://127.0.0.1:" + forgeService.getAddress().getPort());
    }

    @AfterAll
    static void stopForgeService() {
        forgeService.stop(0);
    }

    @Autowired
    private WebTestClient client;

    @Test
    void theFirstEventReachesTheClientBeforeTheServiceWritesTheLast() {
        List<Long> arrivals = new CopyOnWriteArrayList<>();

        FluxExchangeResult<ServerSentEvent<String>> result = client.mutate().responseTimeout(Duration.ofSeconds(20)).build()
                .post().uri("/v1/agent/turn")
                .header(HttpHeaders.AUTHORIZATION, "Bearer dev.anonymous.g1")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{\"prompt\":\"a spiral galaxy\"}")
                .exchange()
                .expectStatus().isOk()
                .returnResult(EVENTS);
        List<ServerSentEvent<String>> events = result.getResponseBody()
                .filter(event -> event.event() != null)
                .doOnNext(event -> arrivals.add(System.nanoTime()))
                .collectList()
                .block(Duration.ofSeconds(20));

        assertThat(result.getResponseHeaders().getContentType()).isNotNull();
        assertThat(MediaType.TEXT_EVENT_STREAM.isCompatibleWith(result.getResponseHeaders().getContentType())).isTrue();
        assertThat(events).hasSize(3);
        assertThat(writes).hasSize(3);
        // The first event was in the client's hands while the service still had two writes to go.
        assertThat(arrivals.get(0)).isLessThan(writes.get(2));
        assertThat(Duration.ofNanos(arrivals.get(2) - arrivals.get(0)).toMillis()).isGreaterThanOrEqualTo(2 * PAUSE_MILLIS - 50);
    }
}
