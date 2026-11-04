package ai.wexy.platform;

import ai.wexy.common.InternalToken;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2's demo at the service (the creations platform design §15: "sign in, claim @handle, restart everything: the account
 * is still there"): the whole platform service on a real MariaDB, its migrations run at startup, an account made and its
 * handle claimed through the real token filter, then the service stopped and started again on the same database. The
 * health it reports includes the database. Skipped, and reported as skipped, when Docker is not running.
 */
@Testcontainers(disabledWithoutDocker = true)
class PlatformServiceApplicationTest {

    @Container
    private static final GenericContainer<?> MARIADB = TestDatabase.container();

    private static final GatewayKeys GATEWAY = new GatewayKeys();

    @AfterAll
    static void stopTheGateway() {
        GATEWAY.close();
    }

    /** The service as its jar starts, with this test's database and gateway as arguments (they outrank application.yaml). */
    private static ConfigurableApplicationContext start() {
        TestDatabase.awaitConnection(MARIADB);
        return new SpringApplicationBuilder(PlatformServiceApplication.class)
                .profiles("test")
                .run("--server.port=0",
                        "--spring.datasource.url=" + TestDatabase.url(MARIADB),
                        "--spring.datasource.username=" + TestDatabase.USER,
                        "--spring.datasource.password=" + TestDatabase.PASSWORD,
                        "--wexy.internal-jwt.jwks-uri=" + GATEWAY.serve());
    }

    private static WebTestClient client(ConfigurableApplicationContext context) {
        int port = ((WebServerApplicationContext) context).getWebServer().getPort();
        return WebTestClient.bindToServer().baseUrl("http://127.0.0.1:" + port).responseTimeout(Duration.ofSeconds(20)).build();
    }

    @Test
    void anAccountAndItsHandleOutliveARestart() {
        String id;
        try (ConfigurableApplicationContext first = start()) {
            WebTestClient client = client(first);
            id = client.post().uri("/v1/me").header(InternalToken.HEADER, GATEWAY.account("uid-demo"))
                    .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of())
                    .exchange()
                    .expectStatus().isCreated()
                    .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                    .expectBody(Map.class).returnResult().getResponseBody().get("accountId").toString();
            client.patch().uri("/v1/me/profile").header(InternalToken.HEADER, GATEWAY.account("uid-demo"))
                    .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of("accountId", id, "expectedVersion", 0, "handle", "Nova"))
                    .exchange()
                    .expectStatus().isOk()
                    .expectBody().jsonPath("$.profile.handle").isEqualTo("nova");
            // Readiness includes the database, and needs no token.
            client.get().uri("/actuator/health").exchange()
                    .expectStatus().isOk()
                    .expectBody().jsonPath("$.status").isEqualTo("UP");
        }

        try (ConfigurableApplicationContext second = start()) {
            WebTestClient client = client(second);
            client.get().uri("/v1/me").header(InternalToken.HEADER, GATEWAY.account("uid-demo"))
                    .exchange()
                    .expectStatus().isOk()
                    .expectBody()
                    .jsonPath("$.accountId").isEqualTo(id)
                    .jsonPath("$.profile.handle").isEqualTo("nova")
                    .jsonPath("$.profile.rowVersion").isEqualTo(1);
            client.post().uri("/v1/me").header(InternalToken.HEADER, GATEWAY.account("uid-demo"))
                    .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of())
                    .exchange()
                    .expectStatus().isOk();
            assertThat(id).hasSize(26);
        }
    }

    /**
     * W3 in the service as it starts (the creations platform design §13: "B2 failure gates storage, not unrelated profile
     * reads"): the world routes are its own, and with no B2 values set (the test profile's) a valid save is 503 while the
     * account, the history and the usage still answer. The routes' rules are WorldRoutesTest's; this is their wiring.
     */
    @Test
    void withoutB2ASaveIsUnavailableAndTheAccountAndItsHistoryStillAnswer() throws java.io.IOException {
        String castle = new org.springframework.core.io.ClassPathResource("world/castle.wexy-world.json")
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        try (ConfigurableApplicationContext context = start()) {
            WebTestClient client = client(context);
            client.post().uri("/v1/me").header(InternalToken.HEADER, GATEWAY.account("uid-w3"))
                    .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of()).exchange().expectStatus().isCreated();
            client.post().uri("/v1/worlds").header(InternalToken.HEADER, GATEWAY.account("uid-w3"))
                    .header("Idempotency-Key", "0f8fad5b-d9cb-469f-a165-70867728950e")
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(Map.of("title", "The castle", "artifact", castle,
                            "sha256", ai.wexy.platform.world.WorldCheck.sha256(castle.getBytes(java.nio.charset.StandardCharsets.UTF_8))))
                    .exchange()
                    .expectStatus().isEqualTo(503)
                    .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                    .expectBody().jsonPath("$.code").isEqualTo("unavailable");
            client.get().uri("/v1/me/worlds").header(InternalToken.HEADER, GATEWAY.account("uid-w3")).exchange()
                    .expectStatus().isOk()
                    .expectBody().jsonPath("$.worlds.length()").isEqualTo(0).jsonPath("$.next").isEmpty();
            client.get().uri("/v1/me/usage").header(InternalToken.HEADER, GATEWAY.account("uid-w3")).exchange()
                    .expectStatus().isOk()
                    .expectBody().jsonPath("$.usedBytes").isEqualTo(0).jsonPath("$.limits.worlds").isEqualTo(50);
            client.get().uri("/v1/me").header(InternalToken.HEADER, GATEWAY.account("uid-w3")).exchange().expectStatus().isOk();
        }
    }

    /** The real filter in front: forge's token, or none, reads nothing; another's world, or none, is 404. */
    @Test
    void onlyThePlatformsTokenReachesItsRoutes() {
        try (ConfigurableApplicationContext context = start()) {
            WebTestClient client = client(context);
            client.get().uri("/v1/me").header(InternalToken.HEADER,
                            GATEWAY.token("uid-demo", false, false, InternalToken.AUDIENCE_FORGE))
                    .exchange()
                    .expectStatus().isUnauthorized()
                    .expectBody().jsonPath("$.code").isEqualTo("auth");
            client.get().uri("/v1/me").exchange().expectStatus().isUnauthorized();
            client.get().uri("/v1/worlds/01JC3W5F6Q7R8S9T0V1W2X3Y4Z").header(InternalToken.HEADER, GATEWAY.account("uid-demo"))
                    .exchange()
                    .expectStatus().isNotFound()
                    .expectBody().jsonPath("$.code").isEqualTo("not-found");
            // A public row the gateway sends without a token, served from W4: 404 until then, never 401.
            client.get().uri("/v1/showcase").exchange()
                    .expectStatus().isNotFound()
                    .expectBody().jsonPath("$.code").isEqualTo("not-found");
        }
    }
}
