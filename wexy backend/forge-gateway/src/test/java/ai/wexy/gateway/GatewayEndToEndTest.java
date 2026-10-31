package ai.wexy.gateway;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.gateway.auth.FirebaseTokenVerifier;
import ai.wexy.gateway.auth.VerifiedCaller;
import ai.wexy.gateway.error.GatewayRejection;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The whole gateway on a real port, in front of a fake forge-service: refusals arrive in the
 * envelope, identity headers a client sends never reach the service, and the token the gateway
 * adds verifies against the key set it publishes.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class GatewayEndToEndTest {

    /** What the fake forge-service received: one map of headers per request. */
    private static final List<Map<String, List<String>>> received = new CopyOnWriteArrayList<>();

    private static final HttpServer forgeService = startForgeService();

    private static HttpServer startForgeService() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                received.add(Map.copyOf(exchange.getRequestHeaders()));
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{\"mode\":\"live\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(body);
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

    /** Plays Firebase for the one token these tests sign in with. */
    @TestConfiguration
    static class FakeFirebase {
        @Bean
        @Primary
        FirebaseTokenVerifier fakeVerifier() {
            return token -> "h.anonymous.s".equals(token)
                    ? Mono.just(new VerifiedCaller("anon-uid", "anonymous"))
                    : Mono.error(new GatewayRejection(ErrorCode.AUTH, "The sign-in token could not be verified."));
        }
    }

    @Autowired
    private WebTestClient client;

    @BeforeEach
    void clear() {
        received.clear();
        client = client.mutate().responseTimeout(Duration.ofSeconds(20)).build();
    }

    @Test
    void anUnknownPathIsANotFoundEnvelopeThatIsNeverStored() {
        client.get().uri("/v1/nothing-here").exchange()
                .expectStatus().isNotFound()
                .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                .expectBody().json("{\"code\":\"not-found\"}");
        assertThat(received).isEmpty();
    }

    @Test
    void aForgeCallWithoutSignInIsAnAuthEnvelope() {
        client.post().uri("/v1/forge/plan").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectBody().json("{\"code\":\"auth\"}");
        assertThat(received).isEmpty();
    }

    @Test
    void anOversizedBodyIsRefusedBeforeItIsRead() {
        String body = "{\"turn\":\"" + "x".repeat(300 * 1024) + "\"}";

        client.post().uri("/v1/forge/direct").contentType(MediaType.APPLICATION_JSON).bodyValue(body)
                .exchange()
                .expectStatus().isEqualTo(413)
                .expectBody().json("{\"code\":\"too-large\"}");
        assertThat(received).isEmpty();
    }

    /** The service trusts this header, so a client's copy must never reach it, on any route. */
    @Test
    void aPublicReadIsForwardedWithoutAnyIdentity() {
        client.get().uri("/v1/forge/mode")
                .header(InternalToken.HEADER, "forged.by.client")
                .exchange()
                .expectStatus().isOk()
                .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store");

        assertThat(received).hasSize(1);
        assertThat(headers(received.get(0), InternalToken.HEADER)).isEmpty();
    }

    @Test
    void aSignedInCallReachesTheServiceWithTheGatewaysOwnToken() throws Exception {
        client.post().uri("/v1/forge/plan")
                .header(HttpHeaders.AUTHORIZATION, "Bearer h.anonymous.s")
                .header(InternalToken.HEADER, "forged.by.client")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{\"prompt\":\"two galaxies collide\"}")
                .exchange()
                .expectStatus().isOk();

        assertThat(received).hasSize(1);
        List<String> tokens = headers(received.get(0), InternalToken.HEADER);
        assertThat(tokens).hasSize(1).doesNotContain("forged.by.client");

        String jwks = client.get().uri(InternalToken.JWKS_PATH).exchange()
                .expectStatus().isOk()
                .expectBody(String.class).returnResult().getResponseBody();
        SignedJWT jwt = SignedJWT.parse(tokens.get(0));
        RSAKey key = (RSAKey) JWKSet.parse(jwks).getKeyByKeyId(jwt.getHeader().getKeyID());
        assertThat(jwt.verify(new RSASSAVerifier(key))).isTrue();
        assertThat(jwt.getJWTClaimsSet().getSubject()).isEqualTo("anon-uid");
        assertThat(jwt.getJWTClaimsSet().getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)).isTrue();
    }

    /** The JDK server keys headers by its own casing; look them up without caring. */
    private static List<String> headers(Map<String, List<String>> headers, String name) {
        return headers.entrySet().stream()
                .filter(entry -> entry.getKey().equalsIgnoreCase(name))
                .flatMap(entry -> entry.getValue().stream())
                .toList();
    }
}
