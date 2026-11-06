package ai.wexy.gateway.auth;

import ai.wexy.common.InternalToken;
import ai.wexy.gateway.shield.GatewayShieldProperties;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

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
 * G2 (forge-loop design §12): under the local profile without Firebase credentials, a dev token
 * signs in through the whole gateway, and forge-service receives the gateway's own token saying who
 * that is; a token that is not a dev token still goes to Firebase and is refused; and development is
 * not rate limited by its own gateway (§9).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"test", "local"})
class DevTokenVerifierLocalTest {

    private static final List<Map<String, List<String>>> received = new CopyOnWriteArrayList<>();
    private static final HttpServer forgeService = startForgeService();

    private static HttpServer startForgeService() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                received.add(Map.copyOf(exchange.getRequestHeaders()));
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
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

    @Autowired
    private WebTestClient client;

    @Autowired
    private FirebaseTokenVerifier verifier;

    @Autowired
    private GatewayShieldProperties shield;

    @BeforeEach
    void clear() {
        received.clear();
        client = client.mutate().responseTimeout(Duration.ofSeconds(20)).build();
    }

    private JWTClaimsSet forwardedClaims() throws Exception {
        assertThat(received).hasSize(1);
        List<String> tokens = received.get(0).entrySet().stream()
                .filter(entry -> entry.getKey().equalsIgnoreCase(InternalToken.HEADER))
                .flatMap(entry -> entry.getValue().stream())
                .toList();
        assertThat(tokens).hasSize(1);
        return SignedJWT.parse(tokens.get(0)).getJWTClaimsSet();
    }

    private WebTestClient.ResponseSpec plan(String authorization) {
        return client.post().uri("/v1/agent/turn")
                .header(HttpHeaders.AUTHORIZATION, authorization)
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{\"prompt\":\"a spiral galaxy\"}")
                .exchange();
    }

    @Test
    void theDevVerifierIsTheOneInUseAndAccepting() {
        assertThat(verifier).isInstanceOf(DevTokenVerifier.class);
        assertThat(((DevTokenVerifier) verifier).accepting()).isTrue();
    }

    @Test
    void aDevTokenSignsInAndTheServiceLearnsItsUid() throws Exception {
        plan("Bearer dev.anonymous.smoke").expectStatus().isOk();

        JWTClaimsSet claims = forwardedClaims();
        assertThat(claims.getSubject()).isEqualTo("smoke");
        assertThat(claims.getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)).isTrue();
        assertThat(claims.getBooleanClaim(InternalToken.CLAIM_ADMIN)).isFalse();
        assertThat(claims.getStringClaim(InternalToken.CLAIM_PROVIDER)).isEqualTo("anonymous");
    }

    @Test
    void aDevAccountTokenIsNotAnonymous() throws Exception {
        plan("Bearer dev.google.alice").expectStatus().isOk();

        JWTClaimsSet claims = forwardedClaims();
        assertThat(claims.getSubject()).isEqualTo("alice");
        assertThat(claims.getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)).isFalse();
        assertThat(claims.getStringClaim(InternalToken.CLAIM_PROVIDER)).isEqualTo("google.com");
    }

    @Test
    void aTokenThatIsNotADevTokenStillGoesToFirebaseAndIsRefused() {
        plan("Bearer h.payload.s").expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        assertThat(received).isEmpty();
    }

    /** §9: a dozen creates in a row must not be a 429 from your own gateway. */
    @Test
    void developmentIsNotRateLimitedByItsOwnGateway() {
        for (String bucket : new String[]{"agent-module", "agent-module-user", "agent-module-anonymous", "agent-review", "agent-review-user"}) {
            assertThat(shield.bucket(bucket).getRefillPerSecond()).as(bucket).isEqualTo(30d);
            assertThat(shield.bucket(bucket).getBurstCapacity()).as(bucket).isIn(300d, 600d);
        }
        for (int i = 0; i < 12; i++) {
            plan("Bearer dev.anonymous.burst").expectStatus().isOk();
        }
    }
}
