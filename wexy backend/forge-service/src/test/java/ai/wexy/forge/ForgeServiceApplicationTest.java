package ai.wexy.forge;

import ai.wexy.common.InternalToken;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The shipped configuration starts: every role priced, every provider capped (otherwise startup
 * fails by design), the identity filter and the error envelope in place, h1's creation routes gone (EA9.6).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ForgeServiceApplicationTest {

    /** The gateway's stand-in, so a caller can be a valid one (EA9.6's independent review). */
    private static final GatewayStandIn GATEWAY = new GatewayStandIn();

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("wexy.internal-jwt.jwks-uri", GATEWAY::jwksUri);
    }

    @AfterAll
    static void stopTheGateway() {
        GATEWAY.close();
    }

    @Autowired
    private ApplicationContext context;

    @Autowired
    private WebTestClient client;

    /** EA9.6: direct service routing has no h1 creation actions, even behind a trusted gateway. */
    @Test
    void retiredCreationRoutesAreAbsentButModeRemains() {
        WebTestClient routes = WebTestClient.bindToRouterFunction(new ai.wexy.forge.loop.LoopRouter().loopRoutes()).build();
        for (String action : java.util.List.of("plan", "author", "repair", "direct", "outcomes")) {
            routes.post().uri("/v1/forge/" + action).contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                    .exchange().expectStatus().isNotFound();
        }
        routes.get().uri("/v1/forge/mode").exchange().expectStatus().isOk().expectBody().json("{\"mode\":\"live\"}");
    }

    /**
     * The same through the running service (EA9.6's independent review): a caller the gateway vouched for finds no h1 route,
     * as the not-found envelope, so no handler of h1's is left behind its identity filter.
     */
    @Test
    void aValidCallerFindsNoRetiredCreationRoute() {
        String token = GATEWAY.token("uid-ea96", true, false, "net-ea96");
        for (String action : java.util.List.of("plan", "author", "repair", "direct", "outcomes")) {
            client.post().uri("/v1/forge/" + action).header(InternalToken.HEADER, token)
                    .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                    .exchange()
                    .expectStatus().isNotFound()
                    .expectBody().json("{\"code\":\"not-found\"}");
        }
    }

    /** The mode stays a public read, with no token: the drives check readiness with it where the actuator is private (F8). */
    @Test
    void theModeIsLiveAndNeedsNoToken() {
        client.get().uri("/v1/forge/mode").exchange()
                .expectStatus().isOk()
                .expectBody(String.class).isEqualTo("{\"mode\":\"live\",\"reason\":null}");
    }

    /** Nothing reaches a handler without the gateway's token, and the refusal is the envelope. */
    @Test
    void aCallWithoutTheGatewaysTokenIsAnAuthEnvelope() {
        client.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectBody().json("{\"code\":\"auth\"}");
    }

    @Test
    void aForgedTokenIsRefusedToo() {
        client.post().uri("/v1/agent/turn").header(InternalToken.HEADER, "a.b.c")
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
