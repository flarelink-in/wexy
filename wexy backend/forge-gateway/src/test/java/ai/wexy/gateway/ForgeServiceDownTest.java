package ai.wexy.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.time.Duration;

/**
 * With nothing listening behind the gateway, a request that passes every filter is answered
 * {@code unavailable} with a retry hint: never a stack trace, never the service's address.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ForgeServiceDownTest {

    /** A port that was free a moment ago and is closed now: connecting to it is refused. */
    private static final int CLOSED_PORT = closedPort();

    private static int closedPort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void routeToNothing(DynamicPropertyRegistry registry) {
        registry.add("wexy.forge-service.url", () -> "http://127.0.0.1:" + CLOSED_PORT);
    }

    @Autowired
    private WebTestClient client;

    @Test
    void aRefusedConnectionIsAnUnavailableEnvelope() {
        client.mutate().responseTimeout(Duration.ofSeconds(20)).build()
                .get().uri("/v1/forge/mode").exchange()
                .expectStatus().isEqualTo(503)
                .expectHeader().valueEquals(HttpHeaders.RETRY_AFTER, "2")
                .expectBody()
                .json("{\"code\":\"unavailable\",\"message\":\"The service is unavailable right now. Try again shortly.\"}");
    }
}
