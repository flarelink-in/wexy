package ai.wexy.gateway.shield;

import ai.wexy.gateway.auth.AuthAttributes;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.test.context.ActiveProfiles;
import reactor.core.publisher.Mono;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Adapted from FlareLink's GatewayShieldTests (pre-existing work). Pinned to the test profile:
 * these describe what application-test.yaml configures, and @ActiveProfiles also overrides a
 * SPRING_PROFILES_ACTIVE in the environment, which keeps the build hermetic.
 */
@SpringBootTest
@ActiveProfiles("test")
class GatewayShieldTests {

    @Autowired
    @Qualifier("clientIpKeyResolver")
    private KeyResolver clientIpKeyResolver;

    @Autowired
    @Qualifier("authenticatedUserKeyResolver")
    private KeyResolver authenticatedUserKeyResolver;

    @Autowired
    private GatewayShieldProperties properties;

    private static MockServerWebExchange exchangeFrom(String ip, MockServerHttpRequest.BaseBuilder<?> builder) {
        return MockServerWebExchange.from(builder.remoteAddress(new InetSocketAddress(ip, 41234)).build());
    }

    /** A key a client could choose would give it a fresh bucket per request. */
    @Test
    void rateLimitKeyIgnoresClientSuppliedIdentityHeaders() {
        MockServerWebExchange exchange = exchangeFrom("203.0.113.7",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("X-Internal-JWT", "attacker-chosen-value")
                        .header("X-Forwarded-For", "1.2.3.4"));

        assertThat(clientIpKeyResolver.resolve(exchange).block()).isEqualTo("ip:203.0.113.7");
    }

    /** With no trusted proxy, X-Forwarded-For must not influence the key. */
    @Test
    void forwardedForIsNotTrustedByDefault() {
        assertThat(properties.getTrustedProxyCount()).isZero();

        String first = clientIpKeyResolver.resolve(exchangeFrom("198.51.100.2",
                MockServerHttpRequest.get("/v1/forge/mode").header("X-Forwarded-For", "9.9.9.9"))).block();
        String second = clientIpKeyResolver.resolve(exchangeFrom("198.51.100.2",
                MockServerHttpRequest.get("/v1/forge/mode").header("X-Forwarded-For", "8.8.8.8"))).block();

        assertThat(first).isEqualTo(second);
    }

    /** The per-account key appears only once the gateway itself has verified the caller. */
    @Test
    void userKeyFallsBackToAddressWhenNotAuthenticated() {
        MockServerWebExchange unauthenticated = exchangeFrom("203.0.113.9",
                MockServerHttpRequest.post("/v1/agent/turn"));
        assertThat(authenticatedUserKeyResolver.resolve(unauthenticated).block()).isEqualTo("ip:203.0.113.9");

        MockServerWebExchange authenticated = exchangeFrom("203.0.113.9",
                MockServerHttpRequest.post("/v1/agent/turn"));
        authenticated.getAttributes().put(AuthAttributes.UID, "firebase-uid-1");
        assertThat(authenticatedUserKeyResolver.resolve(authenticated).block()).isEqualTo("u:firebase-uid-1");
    }

    /** Limits are tunable from configuration, not baked into code. */
    @Test
    void bucketLimitsBindFromConfiguration() {
        // application-test.yaml raises review-read above its compiled default.
        assertThat(properties.bucket("review-read").getRefillPerSecond()).isEqualTo(5d);
        assertThat(properties.bucket("review-read").getBurstCapacity()).isEqualTo(30d);
        assertThat(properties.getEdge().getBurstCapacity()).isEqualTo(500d);
        // The others keep their defaults.
        assertThat(properties.bucket("agent-module-anonymous").getBurstCapacity()).isEqualTo(22d);
    }

    /** One world is about four create requests at once: a create bucket smaller than that breaks the studio. */
    @Test
    void everyCreateBucketHoldsAWholeWorld() {
        for (String name : new String[]{"agent-module", "agent-module-user", "agent-module-anonymous"}) {
            assertThat(properties.bucket(name).getBurstCapacity()).as(name).isGreaterThanOrEqualTo(4d);
        }
    }

    /** A Redis key must outlive a full refill, or pausing resets the bucket to full. */
    @Test
    void bucketStateOutlivesAFullRefill() {
        GatewayShieldProperties.Bucket slow = new GatewayShieldProperties.Bucket(0.0333, 20);
        assertThat(slow.stateTtlSeconds()).isGreaterThan(600L);
    }

    @Autowired
    private RequestGuardFilter guard;

    /**
     * EA6.4: the filter itself caps a body by its route (the independent review of EA6.4: only the map behind it was
     * pinned, and review bodies of real frames stay small enough that a regression would hide). A model's review may
     * declare up to 1,048,576 bytes; past that, or on another route past the default, it is a 413 before going on.
     */
    @Test
    void theBodyCapIsTheRoutesOwnAtTheFilter() {
        long cap = properties.getBody().getMaxBytes();
        assertThat(cap).isLessThan(300 * 1024);
        assertThat(guarded("/v1/agent/review", 300 * 1024)).as("a review's 300 KiB").isNull();
        assertThat(guarded("/v1/agent/review", 1_048_576)).as("a review at its cap").isNull();
        assertThat(guarded("/v1/agent/review", 1_048_577)).as("a review past its cap").isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
        assertThat(guarded("/v1/agent/module", 300 * 1024)).as("another route keeps the default").isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
        assertThat(guarded("/v1/agent/module", cap)).isNull();
    }

    /** The status the guard answered a POST of `declared` bytes with, or null when it let the request on. */
    private HttpStatusCode guarded(String path, long declared) {
        MockServerWebExchange exchange = exchangeFrom("203.0.113.11", MockServerHttpRequest.post(path).contentLength(declared));
        AtomicBoolean reached = new AtomicBoolean();
        guard.filter(exchange, e -> {
            reached.set(true);
            return Mono.empty();
        }).block();
        return reached.get() ? null : exchange.getResponse().getStatusCode();
    }

    /** The Redis-outage fallback still has to limit. */
    @Test
    void localFallbackBucketAllowsBurstThenDenies() {
        LocalTokenBucket bucket = new LocalTokenBucket(0, 3, 100);

        assertThat(bucket.tryConsume("client", 1).allowed()).isTrue();
        assertThat(bucket.tryConsume("client", 1).allowed()).isTrue();
        assertThat(bucket.tryConsume("client", 1).allowed()).isTrue();
        assertThat(bucket.tryConsume("client", 1).allowed()).isFalse();

        // Per key: one abusive client cannot drain another's budget.
        assertThat(bucket.tryConsume("other-client", 1).allowed()).isTrue();
    }
}
