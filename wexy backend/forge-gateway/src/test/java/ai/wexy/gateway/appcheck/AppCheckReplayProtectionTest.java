package ai.wexy.gateway.appcheck;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Copied from FlareLink's AppCheckReplayProtectionTest (pre-existing work), on Wexy's routes, plus
 * the case Wexy added: no service account, so the ledger decides alone.
 *
 * Google is played by a throwaway local server that answers verifyAppCheckToken as its API
 * reference documents (alreadyConsumed omitted on first use, true after) and serves the JWKS the
 * tokens are signed with. So these run offline, and can assert on what was sent to Google.
 */
class AppCheckReplayProtectionTest {

    private static final String PROJECT_NUMBER = "123456789";
    private static final String APP_ID = "1:123456789:web:abc123";
    private static final String PLAN = "/v1/forge/plan";
    private static final String AUTHOR = "/v1/forge/author";
    private static final ObjectMapper JSON = new ObjectMapper();

    private record ConsumeCall(String method, String path, String authorization, String contentType, String token) {
    }

    private HttpServer server;
    private ExecutorService serverThreads;
    private RSAKey signingKey;
    private SimpleMeterRegistry registry;

    /** Google's side: every token it has been asked about. */
    private final Set<String> consumedByGoogle = ConcurrentHashMap.newKeySet();
    private final List<ConsumeCall> consumeCalls = new CopyOnWriteArrayList<>();
    private volatile int consumeStatus = 200;
    private volatile long consumeDelayMillis = 0;

    private final AtomicInteger forwarded = new AtomicInteger();
    private final GatewayFilterChain chain = exchange -> {
        forwarded.incrementAndGet();
        return Mono.empty();
    };

    @BeforeEach
    void setUp() throws Exception {
        signingKey = new RSAKeyGenerator(2048).keyID("test-key").generate();
        registry = new SimpleMeterRegistry();

        serverThreads = Executors.newCachedThreadPool();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(serverThreads);
        server.createContext("/v1/jwks", exchange ->
                respond(exchange, 200, new JWKSet(signingKey.toPublicJWK()).toString()));
        server.createContext("/v1beta/", this::verifyAppCheckToken);
        server.start();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
        serverThreads.shutdownNow();
    }

    @Test
    void aTokenWorksOnceOnASingleUseRoute() throws Exception {
        AppCheckFilter appCheck = enforcing();
        String token = token();

        send(appCheck.singleUse(), PLAN, token);

        assertRefused(() -> send(appCheck.singleUse(), PLAN, token), AppCheckRejection.Reason.REPLAYED);
        assertThat(forwarded).hasValue(1);
        assertThat(attestations("verified")).isEqualTo(1.0);
        assertThat(attestations("replayed")).isEqualTo(1.0);
    }

    /** New to this instance, so its ledger would admit it; only Google knows another replica spent it. */
    @Test
    void aTokenSpentElsewhereIsRefusedHereToo() throws Exception {
        String token = token();
        consumedByGoogle.add(token);

        assertRefused(() -> send(enforcing().singleUse(), PLAN, token), AppCheckRejection.Reason.REPLAYED);
        assertThat(forwarded).hasValue(0);
    }

    /** The page's cached token keeps working on routes that do not spend, before and after a plan spends one. */
    @Test
    void routesThatDoNotSpendKeepAcceptingTheCachedToken() throws Exception {
        AppCheckFilter appCheck = enforcing();
        String token = token();

        send(appCheck, AUTHOR, token);
        send(appCheck, AUTHOR, token);
        assertThat(consumeCalls).isEmpty();

        send(appCheck.singleUse(), PLAN, token);
        send(appCheck, AUTHOR, token);

        assertThat(forwarded).hasValue(4);
        assertThat(consumeCalls).hasSize(1);
    }

    /** Spent only once it verifies, so junk never costs a call to Google, or its quota. */
    @Test
    void aTokenThatFailsVerificationIsNeverSentToGoogle() throws Exception {
        AppCheckFilter appCheck = enforcing();
        List<String> junk = List.of(
                "not-a-jwt",
                token(APP_ID, Instant.now().minusSeconds(60)),
                token("1:123456789:web:another-app", Instant.now().plusSeconds(3600)));

        for (String token : junk) {
            assertRefused(() -> send(appCheck.singleUse(), PLAN, token), AppCheckRejection.Reason.INVALID);
        }
        assertThat(consumeCalls).isEmpty();
        assertThat(forwarded).hasValue(0);
    }

    /** The request, field for field, that Google's API reference documents. */
    @Test
    void googleIsAskedTheDocumentedQuestion() throws Exception {
        String token = token();

        send(enforcing().singleUse(), PLAN, token);

        assertThat(consumeCalls).singleElement().satisfies(call -> {
            assertThat(call.method()).isEqualTo("POST");
            assertThat(call.path()).isEqualTo("/v1beta/projects/" + PROJECT_NUMBER + ":verifyAppCheckToken");
            assertThat(call.authorization()).isEqualTo("Bearer test-access-token");
            assertThat(call.contentType()).startsWith("application/json");
            assertThat(call.token()).isEqualTo(token);
        });
    }

    /** Google down, out of quota or refusing our credentials: a token still works only once here. */
    @ParameterizedTest
    @ValueSource(ints = {403, 429, 500, 503})
    void whenGoogleCannotBeAskedATokenStillWorksOnlyOnceHere(int status) throws Exception {
        consumeStatus = status;
        AppCheckFilter appCheck = enforcing();
        String token = token();

        send(appCheck.singleUse(), PLAN, token);
        assertRefused(() -> send(appCheck.singleUse(), PLAN, token), AppCheckRejection.Reason.REPLAYED);

        assertThat(forwarded).hasValue(1);
        // The repeat was refused without asking Google again.
        assertThat(consumeCalls).hasSize(1);
        assertThat(consumeFailures()).isEqualTo(1.0);
    }

    /** A slow Google must not hold a request open: it gets a deadline, then counts as down. */
    @Test
    void aGoogleThatDoesNotAnswerInTimeDoesNotHoldTheRequest() throws Exception {
        consumeDelayMillis = 3_000;
        AppCheckFilter appCheck = filter(true, true, true, 300);

        long started = System.nanoTime();
        send(appCheck.singleUse(), PLAN, token());

        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(2_500));
        assertThat(forwarded).hasValue(1);
        assertThat(consumeFailures()).isEqualTo(1.0);
    }

    /** A script firing one token down many connections at once still gets one request through. */
    @Test
    void ofRequestsRacingWithOneTokenExactlyOneIsAdmitted() throws Exception {
        AppCheckFilter appCheck = enforcing();
        String token = token();
        AtomicInteger refused = new AtomicInteger();

        Flux.range(0, 20)
                .flatMap(i -> appCheck.singleUse().filter(request(PLAN, token), chain)
                        .subscribeOn(Schedulers.parallel())
                        .onErrorResume(AppCheckRejection.class, e -> {
                            refused.incrementAndGet();
                            return Mono.empty();
                        }))
                .blockLast(Duration.ofSeconds(20));

        assertThat(forwarded).hasValue(1);
        assertThat(refused).hasValue(19);
        assertThat(consumeCalls).hasSize(1);
    }

    /** Monitor mode: what enforcing would refuse is counted, and let through. */
    @Test
    void monitorModeCountsReplaysWithoutRefusingThem() throws Exception {
        AppCheckFilter appCheck = filter(true, true, false, 2_000);
        String token = token();

        send(appCheck.singleUse(), PLAN, token);
        send(appCheck.singleUse(), PLAN, token);

        assertThat(forwarded).hasValue(2);
        assertThat(attestations("verified")).isEqualTo(1.0);
        assertThat(attestations("replayed")).isEqualTo(1.0);
    }

    /** App Check in monitor mode lets a request with no token through, so it refuses none for reuse. */
    @Test
    void appCheckInMonitorModeRefusesNoReplayEither() throws Exception {
        AppCheckFilter appCheck = filter(false, true, true, 2_000);
        String token = token();

        send(appCheck.singleUse(), PLAN, token);
        send(appCheck.singleUse(), PLAN, token);

        assertThat(forwarded).hasValue(2);
        assertThat(attestations("replayed")).isEqualTo(1.0);
    }

    /** The kill switch: single-use routes fall back to the plain check, and Google is not called. */
    @Test
    void switchedOffNothingIsSpent() throws Exception {
        AppCheckFilter appCheck = filter(true, false, true, 2_000);
        String token = token();

        send(appCheck.singleUse(), PLAN, token);
        send(appCheck.singleUse(), PLAN, token);

        assertThat(forwarded).hasValue(2);
        assertThat(consumeCalls).isEmpty();
    }

    /** Wexy's addition: before the Firebase project exists, there is no service account to ask with. */
    @Test
    void withNoServiceAccountTheLedgerDecidesAlone() throws Exception {
        AppCheckReplayGuard guard = new AppCheckReplayGuard((GoogleCredentials) null, registry, PROJECT_NUMBER,
                baseUrl(), 2_000);
        AppCheckFilter appCheck = new AppCheckFilter(registry, guard, true, true, true, true,
                PROJECT_NUMBER, APP_ID, baseUrl() + "/v1/jwks", 60);
        String token = token();

        send(appCheck.singleUse(), PLAN, token);
        assertRefused(() -> send(appCheck.singleUse(), PLAN, token), AppCheckRejection.Reason.REPLAYED);

        assertThat(forwarded).hasValue(1);
        assertThat(consumeCalls).isEmpty();
    }

    // ------------------------------------------------------------------------------------------

    private AppCheckFilter enforcing() {
        return filter(true, true, true, 2_000);
    }

    private AppCheckFilter filter(boolean enforce, boolean replayProtection, boolean enforceReplays,
                                  long consumeTimeoutMillis) {
        GoogleCredentials credentials = GoogleCredentials.create(
                new AccessToken("test-access-token", Date.from(Instant.now().plus(Duration.ofHours(1)))));
        AppCheckReplayGuard guard = new AppCheckReplayGuard(
                credentials, registry, PROJECT_NUMBER, baseUrl(), consumeTimeoutMillis);
        return new AppCheckFilter(registry, guard, true, enforce, replayProtection, enforceReplays,
                PROJECT_NUMBER, APP_ID, baseUrl() + "/v1/jwks", 60);
    }

    private String token() throws JOSEException {
        return token(APP_ID, Instant.now().plus(Duration.ofHours(1)));
    }

    /** Shaped like the tokens App Check issues for a web app, signed by the key the local JWKS serves. */
    private String token(String appId, Instant expiresAt) throws JOSEException {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer("https://firebaseappcheck.googleapis.com/" + PROJECT_NUMBER)
                .audience(List.of("projects/" + PROJECT_NUMBER, "projects/wexy-test"))
                .subject(appId)
                .issueTime(new Date())
                .expirationTime(Date.from(expiresAt))
                // Two tokens minted in the same second must still differ, as Google's do.
                .jwtID(UUID.randomUUID().toString())
                .build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
                .keyID(signingKey.getKeyID())
                .type(JOSEObjectType.JWT)
                .build(), claims);
        jwt.sign(new RSASSASigner(signingKey));
        return jwt.serialize();
    }

    private void send(GatewayFilter filter, String path, String token) {
        filter.filter(request(path, token), chain).block(Duration.ofSeconds(10));
    }

    private static MockServerWebExchange request(String path, String token) {
        return MockServerWebExchange.from(MockServerHttpRequest.post(path)
                .header(AppCheckFilter.APP_CHECK_HEADER, token));
    }

    private static void assertRefused(Runnable request, AppCheckRejection.Reason reason) {
        assertThatThrownBy(request::run)
                .isInstanceOfSatisfying(AppCheckRejection.class, e -> assertThat(e.reason()).isEqualTo(reason));
    }

    private double attestations(String result) {
        return registry.get("wexy.appcheck.attestations").tag("result", result).counter().count();
    }

    private double consumeFailures() {
        return registry.get("wexy.appcheck.consume.failures").counter().count();
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void verifyAppCheckToken(HttpExchange exchange) throws IOException {
        String token = JSON.readTree(exchange.getRequestBody()).path("appCheckToken").asText(null);
        consumeCalls.add(new ConsumeCall(
                exchange.getRequestMethod(),
                exchange.getRequestURI().getPath(),
                exchange.getRequestHeaders().getFirst("Authorization"),
                exchange.getRequestHeaders().getFirst("Content-Type"),
                token));

        if (consumeDelayMillis > 0) {
            try {
                Thread.sleep(consumeDelayMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        if (consumeStatus != 200) {
            respond(exchange, consumeStatus,
                    "{\"error\":{\"code\":" + consumeStatus + ",\"message\":\"simulated\",\"status\":\"UNAVAILABLE\"}}");
            return;
        }
        respond(exchange, 200, consumedByGoogle.add(token) ? "{}" : "{\"alreadyConsumed\":true}");
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
