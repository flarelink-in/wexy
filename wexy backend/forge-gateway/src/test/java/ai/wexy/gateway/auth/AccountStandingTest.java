package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.gateway.error.GatewayRejection;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The account's standing before a model call (2026-11-04, the user: "suspension force that"): a suspended or deleting
 * account is refused at the gateway, its call never forwarded; anyone else goes on, an anonymous caller without the
 * platform asked; the platform's word is kept a minute per uid; and a platform that cannot answer lets the call go on,
 * counted, kept for no one.
 */
class AccountStandingTest {

    private HttpServer platform;
    /** What the fake platform answers next: a status code and a body, after an optional pause. */
    private final AtomicReference<Answer> answer = new AtomicReference<>(new Answer(200, account("ACTIVE"), 0));
    private final List<String> tokens = new CopyOnWriteArrayList<>();
    private final AtomicInteger asked = new AtomicInteger();
    private final InternalSigningKey signingKey = new InternalSigningKey("");
    private final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-04T10:00:00Z"));
    private AccountStanding standing;

    private record Answer(int status, String body, long pauseMillis) {
    }

    private static String account(String status) {
        return "{\"accountId\":\"01JC3W5F6Q7R8S9T0V1W2X3Y4Z\",\"status\":\"" + status + "\",\"policyVersion\":1,"
                + "\"profile\":{\"handle\":null,\"displayName\":null,\"bio\":null,\"publicEnabled\":false,\"rowVersion\":0}}";
    }

    @BeforeEach
    void start() throws IOException {
        platform = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        platform.createContext("/v1/me", exchange -> {
            asked.incrementAndGet();
            tokens.add(exchange.getRequestHeaders().getFirst(InternalToken.HEADER));
            Answer a = answer.get();
            if (a.pauseMillis() > 0) {
                try {
                    Thread.sleep(a.pauseMillis());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            byte[] body = a.body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(a.status(), body.length == 0 ? -1 : body.length);
            if (body.length > 0) {
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(body);
                }
            }
            exchange.close();
        });
        platform.start();
        // The JVM's first request (Netty, class loading) can outlast the deadline, which would read as no answer, so a
        // throwaway instance of its own (its own meters and table) makes one first, and its trace is forgotten.
        new AccountStanding(WebClient.builder(), new InternalTokenMinter(signingKey), new ObjectMapper(), new SimpleMeterRegistry(),
                platformUrl(), Duration.ofSeconds(60), Duration.ofSeconds(10), true, clock).permits(new VerifiedCaller("warm-up", "google.com")).block();
        asked.set(0);
        tokens.clear();
        standing = new AccountStanding(WebClient.builder(), new InternalTokenMinter(signingKey), new ObjectMapper(), meters,
                platformUrl(), Duration.ofSeconds(60), DEADLINE, true, clock);
    }

    /** The deadline under test: longer than any local answer once warm, shorter than the slow one below. */
    private static final Duration DEADLINE = Duration.ofMillis(1500);

    private String platformUrl() {
        return "http://127.0.0.1:" + platform.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        platform.stop(0);
    }

    private static final VerifiedCaller GOOGLE = new VerifiedCaller("user-uid", "google.com");
    private static final VerifiedCaller ANONYMOUS = new VerifiedCaller("anon-uid", "anonymous");

    /** A model call by `caller`, through the standing filter: whether it was forwarded. */
    private boolean call(VerifiedCaller caller) {
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/agent/turn"));
        exchange.getAttributes().put(AuthAttributes.CALLER, caller);
        AtomicReference<Boolean> forwarded = new AtomicReference<>(false);
        GatewayFilterChain chain = ex -> {
            forwarded.set(true);
            return Mono.empty();
        };
        standing.spending().filter(exchange, chain).block();
        return forwarded.get();
    }

    private double meter(String result) {
        return meters.get("wexy.auth.standing").tag("result", result).counter().count();
    }

    @Test
    void anAccountThatIsNotActiveIsRefusedBeforeForge() throws Exception {
        // DELETED too (the account-guards review), and any status this gateway does not know: only ACTIVE spends.
        for (String status : List.of("SUSPENDED", "DELETING", "DELETED", "SOMETHING_NEW")) {
            answer.set(new Answer(200, account(status), 0));
            VerifiedCaller caller = new VerifiedCaller("uid-" + status, "google.com");
            assertThatThrownBy(() -> call(caller))
                    .isInstanceOfSatisfying(GatewayRejection.class, e -> {
                        assertThat(e.code()).isEqualTo(ErrorCode.FORBIDDEN);
                        assertThat(e.getMessage()).isEqualTo(AccountStanding.REFUSAL);
                    });
        }
        assertThat(meter("barred")).isEqualTo(4);
        // The platform was asked as that caller, with a token for the platform alone (W2's audience).
        SignedJWT token = SignedJWT.parse(tokens.get(0));
        assertThat(token.getJWTClaimsSet().getSubject()).isEqualTo("uid-SUSPENDED");
        assertThat(token.getJWTClaimsSet().getAudience()).containsExactly(InternalToken.AUDIENCE_PLATFORM);
    }

    @Test
    void anActiveAccountOrNoneYetGoesOn() {
        assertThat(call(GOOGLE)).isTrue();
        answer.set(new Answer(404, "{\"code\":\"not-found\",\"message\":\"No account yet.\"}", 0));
        assertThat(call(new VerifiedCaller("new-uid", "google.com"))).as("W1's early access needs no account").isTrue();
        assertThat(meter("allowed")).isEqualTo(2);
        // A 404 that is not the platform's word (a URL that reaches something else) is no answer: on, but unknown, and
        // asked again, never kept as allowed (the independent review).
        answer.set(new Answer(404, "<html>Not Found</html>", 0));
        assertThat(call(new VerifiedCaller("odd-404", "google.com"))).isTrue();
        assertThat(call(new VerifiedCaller("odd-404", "google.com"))).isTrue();
        assertThat(meter("unknown")).isEqualTo(2);
        assertThat(meter("allowed")).isEqualTo(2);
    }

    @Test
    void anAnonymousCallerIsNeverAsked() {
        assertThat(call(ANONYMOUS)).isTrue();
        assertThat(asked.get()).isZero();
    }

    @Test
    void theWordIsKeptAMinutePerUidSoASuspensionHoldsWithinIt() {
        assertThat(call(GOOGLE)).isTrue();
        assertThat(call(GOOGLE)).isTrue();
        assertThat(asked.get()).as("a creation's calls ask once").isEqualTo(1);
        // Suspended meanwhile: the kept word stands until it expires, then the suspension holds.
        answer.set(new Answer(200, account("SUSPENDED"), 0));
        clock.advance(Duration.ofSeconds(59));
        assertThat(call(GOOGLE)).isTrue();
        clock.advance(Duration.ofSeconds(2));
        assertThatThrownBy(() -> call(GOOGLE)).isInstanceOf(GatewayRejection.class);
        assertThat(asked.get()).isEqualTo(2);
    }

    @Test
    void aPlatformThatCannotAnswerLetsTheCallGoOnCountedAndKeptForNoOne() {
        answer.set(new Answer(503, "{\"code\":\"unavailable\",\"message\":\"down\"}", 0));
        assertThat(call(GOOGLE)).isTrue();
        assertThat(call(GOOGLE)).isTrue();
        assertThat(asked.get()).as("nothing kept: asked again").isEqualTo(2);
        // Slow past the deadline, or not the account's DTO: the same.
        answer.set(new Answer(200, account("SUSPENDED"), DEADLINE.toMillis() * 2));
        assertThat(call(new VerifiedCaller("slow-uid", "google.com"))).isTrue();
        answer.set(new Answer(200, "{\"mode\":\"live\"}", 0));
        assertThat(call(new VerifiedCaller("odd-uid", "google.com"))).isTrue();
        assertThat(meter("unknown")).isEqualTo(4);
        assertThat(meter("barred")).isZero();
    }

    /** The review: a suspension the gateway knew does not lapse with the platform; an active account's word does. */
    @Test
    void aKnownSuspensionHoldsWhileThePlatformCannotAnswer() {
        answer.set(new Answer(200, account("SUSPENDED"), 0));
        assertThatThrownBy(() -> call(GOOGLE)).isInstanceOf(GatewayRejection.class);
        clock.advance(Duration.ofSeconds(61));
        answer.set(new Answer(503, "{\"code\":\"unavailable\",\"message\":\"down\"}", 0));
        assertThatThrownBy(() -> call(GOOGLE)).as("still barred, its word expired, the platform down").isInstanceOf(GatewayRejection.class);
        assertThat(asked.get()).as("the platform was asked again, and said nothing").isEqualTo(2);
        // Back, and active: the call goes on.
        answer.set(new Answer(200, account("ACTIVE"), 0));
        assertThat(call(GOOGLE)).isTrue();

        // An account last known active, its word expired, the platform down: on, as an unknown one.
        VerifiedCaller active = new VerifiedCaller("active-uid", "google.com");
        assertThat(call(active)).isTrue();
        clock.advance(Duration.ofSeconds(61));
        answer.set(new Answer(503, "{\"code\":\"unavailable\",\"message\":\"down\"}", 0));
        assertThat(call(active)).isTrue();
    }

    @Test
    void switchedOffItAsksNoOne() {
        AccountStanding off = new AccountStanding(WebClient.builder(), new InternalTokenMinter(signingKey), new ObjectMapper(), meters,
                platformUrl(), Duration.ofSeconds(60), DEADLINE, false, clock);
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/agent/turn"));
        exchange.getAttributes().put(AuthAttributes.CALLER, GOOGLE);
        AtomicReference<Boolean> forwarded = new AtomicReference<>(false);
        off.spending().filter(exchange, ex -> {
            forwarded.set(true);
            return Mono.empty();
        }).block();
        assertThat(forwarded.get()).isTrue();
        assertThat(asked.get()).isZero();
    }

    /** A clock the test moves. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
