package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.gateway.error.GatewayRejection;
import ai.wexy.gateway.shield.ClientAddressResolver;
import ai.wexy.gateway.shield.ClientNetworkKey;
import ai.wexy.gateway.shield.ClientNetworkKeyTest;
import ai.wexy.gateway.shield.GatewayShieldProperties;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The policies Wexy added to FlareLink's filter: anonymous callers create, accounts publish to the
 * Showcase, admins administer; and the token the service receives says exactly that.
 */
class AuthorizationFilterTest {

    private final InternalSigningKey signingKey = new InternalSigningKey("");
    private final AtomicInteger verifications = new AtomicInteger();

    /** Plays Firebase: three known tokens, everything else rejected. Each has two dots, like a JWS. */
    private final FirebaseTokenVerifier verifier = token -> {
        verifications.incrementAndGet();
        return switch (token) {
            case "h.anonymous.s" -> Mono.just(new VerifiedCaller("anon-uid", "anonymous"));
            case "h.google.s" -> Mono.just(new VerifiedCaller("user-uid", "google.com"));
            case "h.admin.s" -> Mono.just(new VerifiedCaller("admin-uid", "google.com"));
            default -> Mono.error(new GatewayRejection(ErrorCode.AUTH, "The sign-in token could not be verified."));
        };
    };

    /** The network key as the gateway resolves it: the socket's peer, no proxy trusted (the test profile's). */
    private final ClientNetworkKey networkKey = new ClientNetworkKey(new ClientAddressResolver(new GatewayShieldProperties()),
            ClientNetworkKeyTest.KEY, false);

    private final AuthorizationFilter authorization = new AuthorizationFilter(
            verifier, new InternalTokenMinter(signingKey), networkKey, new SimpleMeterRegistry(), " admin-uid , ");

    private final AtomicReference<ServerWebExchange> forwarded = new AtomicReference<>();
    private final GatewayFilterChain chain = exchange -> {
        forwarded.set(exchange);
        return Mono.empty();
    };

    private static final String PEER = "203.0.113.42";

    private static MockServerWebExchange request(String authorizationHeader) {
        return request(authorizationHeader, PEER, null);
    }

    private static MockServerWebExchange request(String authorizationHeader, String peer, String forwardedFor) {
        MockServerHttpRequest.BaseBuilder<?> builder = MockServerHttpRequest.post("/v1/forge/plan");
        if (authorizationHeader != null) {
            builder.header(HttpHeaders.AUTHORIZATION, authorizationHeader);
        }
        if (forwardedFor != null) {
            builder.header("X-Forwarded-For", forwardedFor);
        }
        if (peer != null) {
            builder.remoteAddress(new InetSocketAddress(peer, 41234));
        }
        return MockServerWebExchange.from(builder);
    }

    private void send(GatewayFilter filter, String authorizationHeader) {
        filter.filter(request(authorizationHeader), chain).block();
    }

    private JWTClaimsSet forwardedClaims() throws Exception {
        String token = forwarded.get().getRequest().getHeaders().getFirst(InternalToken.HEADER);
        assertThat(token).as("the internal token").isNotNull();
        SignedJWT jwt = SignedJWT.parse(token);
        RSAKey publicKey = (RSAKey) JWKSet.parse(signingKey.getPublicJwkSetJson()).getKeys().get(0);
        // Verified against the published key set, as forge-service will verify it.
        assertThat(jwt.verify(new RSASSAVerifier(publicKey))).isTrue();
        assertThat(jwt.getHeader().getKeyID()).isEqualTo(signingKey.getKeyId());
        return jwt.getJWTClaimsSet();
    }

    @Test
    void anAnonymousCallerCreatesAndTheTokenSaysSo() throws Exception {
        send(authorization.anonymousAllowed(), "Bearer h.anonymous.s");

        JWTClaimsSet claims = forwardedClaims();
        assertThat(claims.getIssuer()).isEqualTo(InternalToken.ISSUER);
        assertThat(claims.getSubject()).isEqualTo("anon-uid");
        assertThat(claims.getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)).isTrue();
        assertThat(claims.getBooleanClaim(InternalToken.CLAIM_ADMIN)).isFalse();
        assertThat(claims.getStringClaim(InternalToken.CLAIM_PROVIDER)).isEqualTo("anonymous");
        assertThat(claims.getExpirationTime().getTime() - claims.getIssueTime().getTime())
                .isEqualTo(InternalToken.LIFETIME_MILLIS);

        // The post-authentication limiter keys on these, never on anything the client sent.
        assertThat((String) forwarded.get().getAttribute(AuthAttributes.UID)).isEqualTo("anon-uid");
        assertThat((Boolean) forwarded.get().getAttribute(AuthAttributes.ANONYMOUS)).isTrue();
        // And the account's standing check reads the verified caller itself (2026-11-04).
        assertThat((VerifiedCaller) forwarded.get().getAttribute(AuthAttributes.CALLER)).isEqualTo(new VerifiedCaller("anon-uid", "anonymous"));
        send(authorization.anonymousAllowed(), "Bearer h.google.s");
        assertThat((VerifiedCaller) forwarded.get().getAttribute(AuthAttributes.CALLER)).isEqualTo(new VerifiedCaller("user-uid", "google.com"));
    }

    /**
     * PL-T17's ipk (W1): every token carries the caller's network key, from the address the gateway resolved, so
     * forge can count anonymous prompts per network; no request header can set it.
     */
    @Test
    void theTokenCarriesTheCallersNetworkKeyAndNoHeaderCanSetIt() throws Exception {
        String expected = networkKey.of(request(null));
        assertThat(expected).matches("v4\\.[0-9a-f]{64}");

        send(authorization.anonymousAllowed(), "Bearer h.anonymous.s");
        assertThat(forwardedClaims().getStringClaim(InternalToken.CLAIM_IPK)).isEqualTo(expected);

        // A forwarded-for the gateway does not trust, and an inbound internal token, change nothing.
        MockServerWebExchange spoofed = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/forge/plan")
                .header(HttpHeaders.AUTHORIZATION, "Bearer h.google.s")
                .header("X-Forwarded-For", "198.51.100.1")
                .header(InternalToken.HEADER, "forged")
                .remoteAddress(new InetSocketAddress(PEER, 1)));
        authorization.anonymousAllowed().filter(spoofed, chain).block();
        assertThat(forwarded.get().getRequest().getHeaders().get(InternalToken.HEADER)).hasSize(1);
        assertThat(forwardedClaims().getStringClaim(InternalToken.CLAIM_IPK)).isEqualTo(expected);
    }

    /** No resolvable address, or no key: no claim at all, never an empty or made-up one, and forge grants no anonymous prompt. */
    @Test
    void withoutANetworkKeyTheClaimIsLeftOut() throws Exception {
        authorization.anonymousAllowed().filter(request("Bearer h.anonymous.s", null, null), chain).block();
        assertThat(forwardedClaims().getClaims()).doesNotContainKey(InternalToken.CLAIM_IPK);

        AuthorizationFilter keyless = new AuthorizationFilter(verifier, new InternalTokenMinter(signingKey),
                new ClientNetworkKey(new ClientAddressResolver(new GatewayShieldProperties()), "", false), new SimpleMeterRegistry(), "");
        keyless.anonymousAllowed().filter(request("Bearer h.anonymous.s"), chain).block();
        assertThat(forwardedClaims().getClaims()).doesNotContainKey(InternalToken.CLAIM_IPK);
    }

    @Test
    void anAnonymousCallerCannotTakeAnAccountOnlyAction() {
        assertThatThrownBy(() -> send(authorization.accountRequired(), "Bearer h.anonymous.s"))
                .isInstanceOfSatisfying(GatewayRejection.class,
                        e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(forwarded.get()).isNull();

        send(authorization.accountRequired(), "Bearer h.google.s");
        assertThat(forwarded.get()).isNotNull();
    }

    @Test
    void adminRoutesAdmitOnlyTheAllowList() throws Exception {
        assertThatThrownBy(() -> send(authorization.adminOnly(), "Bearer h.google.s"))
                .isInstanceOfSatisfying(GatewayRejection.class,
                        e -> assertThat(e.code()).isEqualTo(ErrorCode.FORBIDDEN));
        assertThat(forwarded.get()).isNull();

        send(authorization.adminOnly(), "Bearer h.admin.s");
        assertThat(forwardedClaims().getBooleanClaim(InternalToken.CLAIM_ADMIN)).isTrue();
    }

    /**
     * W2: every token names the one service its route leads to. Forge's filters mint for forge, the platform's for the
     * platform, so a token lifted from one service's traffic is refused by the other (forge-common's verifier).
     */
    @Test
    void eachTokenIsForTheServiceItsRouteLeadsTo() throws Exception {
        send(authorization.anonymousAllowed(), "Bearer h.anonymous.s");
        assertThat(forwardedClaims().getAudience()).containsExactly(InternalToken.AUDIENCE_FORGE);

        send(authorization.platformAccount(), "Bearer h.google.s");
        assertThat(forwardedClaims().getAudience()).containsExactly(InternalToken.AUDIENCE_PLATFORM);
        assertThat(forwardedClaims().getSubject()).isEqualTo("user-uid");

        send(authorization.platformAdmin(), "Bearer h.admin.s");
        assertThat(forwardedClaims().getAudience()).containsExactly(InternalToken.AUDIENCE_PLATFORM);
        assertThat(forwardedClaims().getBooleanClaim(InternalToken.CLAIM_ADMIN)).isTrue();

        send(authorization.adminOnly(), "Bearer h.admin.s");
        assertThat(forwardedClaims().getAudience()).containsExactly(InternalToken.AUDIENCE_FORGE);
    }

    /** The platform's accounts are real accounts (§10's N): an anonymous caller is refused there before any token is minted. */
    @Test
    void thePlatformsAccountRoutesRefuseAnAnonymousCaller() {
        assertThatThrownBy(() -> send(authorization.platformAccount(), "Bearer h.anonymous.s"))
                .isInstanceOfSatisfying(GatewayRejection.class,
                        e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(forwarded.get()).isNull();
        assertThatThrownBy(() -> send(authorization.platformAdmin(), "Bearer h.google.s"))
                .isInstanceOfSatisfying(GatewayRejection.class,
                        e -> assertThat(e.code()).isEqualTo(ErrorCode.FORBIDDEN));
        assertThat(forwarded.get()).isNull();
    }

    /** A malformed header is refused before anything is asked of Firebase. */
    @Test
    void aMissingOrMalformedHeaderIsRefusedWithoutAVerification() {
        for (String header : new String[]{null, "", "Bearer", "Basic abc", "Bearer notajwt"}) {
            assertThatThrownBy(() -> send(authorization.anonymousAllowed(), header))
                    .as(String.valueOf(header))
                    .isInstanceOfSatisfying(GatewayRejection.class,
                            e -> assertThat(e.code()).isEqualTo(ErrorCode.AUTH));
        }
        assertThat(verifications).hasValue(0);
        assertThat(forwarded.get()).isNull();
    }

    @Test
    void aTokenFirebaseRejectsIsRefused() {
        assertThatThrownBy(() -> send(authorization.anonymousAllowed(), "Bearer h.forged.s"))
                .isInstanceOfSatisfying(GatewayRejection.class,
                        e -> assertThat(e.code()).isEqualTo(ErrorCode.AUTH));
        assertThat(verifications).hasValue(1);
        assertThat(forwarded.get()).isNull();
    }

    /** FlareLink's old split("Bearer ")[1] threw on these, turning a one-byte request into a 500. */
    @Test
    void bearerExtractionNeverThrows() {
        assertThat(InternalTokenMinter.extractBearerToken(null)).isNull();
        assertThat(InternalTokenMinter.extractBearerToken("x")).isNull();
        assertThat(InternalTokenMinter.extractBearerToken("Bearer ")).isNull();
        assertThat(InternalTokenMinter.extractBearerToken("Bearer " + "a.b.".repeat(1200))).isNull();
        assertThat(InternalTokenMinter.extractBearerToken("bearer head.payload.sig")).isEqualTo("head.payload.sig");
    }
}
