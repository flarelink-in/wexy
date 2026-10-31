package ai.wexy.forge;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.probe.HourOneProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.reactive.server.WebTestClient;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The shipped configuration starts: every role priced, every provider capped (otherwise startup
 * fails by design), the identity filter and the error envelope in place, the probe off.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ForgeServiceApplicationTest {

    @Autowired
    private ApplicationContext context;

    @Autowired
    private WebTestClient client;

    @Test
    void theProbeIsOffUnlessAskedFor() {
        assertThat(context.getBeanNamesForType(HourOneProbe.class)).isEmpty();
    }

    /** Nothing reaches a handler without the gateway's token, and the refusal is the envelope. */
    @Test
    void aCallWithoutTheGatewaysTokenIsAnAuthEnvelope() {
        client.post().uri("/v1/forge/plan").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectBody().json("{\"code\":\"auth\"}");
    }

    @Test
    void aForgedTokenIsRefusedToo() {
        client.post().uri("/v1/forge/plan").header(InternalToken.HEADER, "a.b.c")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectBody().json("{\"code\":\"auth\"}");
    }

    /** A public read that is not built yet (the stats, B1.4) reaches the router and finds nothing. */
    @Test
    void anUnbuiltEndpointIsANotFoundEnvelope() {
        client.get().uri("/v1/stats").exchange()
                .expectStatus().isNotFound()
                .expectBody().json("{\"code\":\"not-found\"}");
    }

    /**
     * Public (no token needed), and honest: the test profile has no Redis, so the meter is down, no
     * model call can be made, and health says so with a 503 a load balancer understands.
     */
    @Test
    void healthIsPublicAndReportsTheMeter() {
        client.get().uri("/actuator/health").exchange()
                .expectStatus().isEqualTo(503)
                .expectBody().json("{\"status\":\"DOWN\"}");
    }
}
