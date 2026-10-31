package ai.wexy.gateway.shield;

import ai.wexy.gateway.auth.AuthAttributes;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.test.context.ActiveProfiles;

import java.net.InetSocketAddress;

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
                MockServerHttpRequest.post("/v1/forge/plan"));
        assertThat(authenticatedUserKeyResolver.resolve(unauthenticated).block()).isEqualTo("ip:203.0.113.9");

        MockServerWebExchange authenticated = exchangeFrom("203.0.113.9",
                MockServerHttpRequest.post("/v1/forge/plan"));
        authenticated.getAttributes().put(AuthAttributes.UID, "firebase-uid-1");
        assertThat(authenticatedUserKeyResolver.resolve(authenticated).block()).isEqualTo("u:firebase-uid-1");
    }

    /** Limits are tunable from configuration, not baked into code. */
    @Test
    void bucketLimitsBindFromConfiguration() {
        // application-test.yaml raises forge-edit above its compiled default.
        assertThat(properties.bucket("forge-edit").getRefillPerSecond()).isEqualTo(5d);
        assertThat(properties.bucket("forge-edit").getBurstCapacity()).isEqualTo(30d);
        assertThat(properties.getEdge().getBurstCapacity()).isEqualTo(500d);
        // The others keep their defaults.
        assertThat(properties.bucket("forge-create-anonymous").getBurstCapacity()).isEqualTo(8d);
    }

    /** One world is about four create requests at once: a create bucket smaller than that breaks the studio. */
    @Test
    void everyCreateBucketHoldsAWholeWorld() {
        for (String name : new String[]{"forge-create", "forge-create-user", "forge-create-anonymous"}) {
            assertThat(properties.bucket(name).getBurstCapacity()).as(name).isGreaterThanOrEqualTo(4d);
        }
    }

    /** A Redis key must outlive a full refill, or pausing resets the bucket to full. */
    @Test
    void bucketStateOutlivesAFullRefill() {
        GatewayShieldProperties.Bucket slow = new GatewayShieldProperties.Bucket(0.0333, 20);
        assertThat(slow.stateTtlSeconds()).isGreaterThan(600L);
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
