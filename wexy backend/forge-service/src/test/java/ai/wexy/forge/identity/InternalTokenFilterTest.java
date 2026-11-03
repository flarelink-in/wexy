package ai.wexy.forge.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.forge.error.ForgeException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.util.Date;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Only the gateway's signature makes a caller; nothing a client could forge does. */
class InternalTokenFilterTest {

    private final RSAKey gatewayKey = generate("gateway");
    private final RSAKey otherKey = generate("other");
    private final InternalTokenFilter filter =
            new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(gatewayKey.toPublicJWK())));

    private final AtomicReference<ServerWebExchange> reached = new AtomicReference<>();
    private final WebFilterChain chain = exchange -> {
        reached.set(exchange);
        return Mono.empty();
    };

    private static RSAKey generate(String kid) {
        try {
            return new RSAKeyGenerator(2048).keyID(kid).generate();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String token(RSAKey key, String issuer, long expiresInMillis) throws Exception {
        return token(key, issuer, expiresInMillis, InternalToken.AUDIENCE_FORGE);
    }

    /** As the gateway mints it for `audience` (W2), or with no audience at all when it is null. */
    private static String token(RSAKey key, String issuer, long expiresInMillis, String audience) throws Exception {
        long now = System.currentTimeMillis();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .audience(audience)
                .subject("anon-uid")
                .issueTime(new Date(now))
                .expirationTime(new Date(now + expiresInMillis))
                .claim(InternalToken.CLAIM_ANONYMOUS, true)
                .claim(InternalToken.CLAIM_ADMIN, false)
                .claim(InternalToken.CLAIM_PROVIDER, "anonymous")
                .build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID())
                .type(JOSEObjectType.JWT).build(), claims);
        jwt.sign(new RSASSASigner(key));
        return jwt.serialize();
    }

    private void post(String path, String token) {
        MockServerHttpRequest.BaseBuilder<?> request = MockServerHttpRequest.post(path);
        if (token != null) {
            request.header(InternalToken.HEADER, token);
        }
        filter.filter(MockServerWebExchange.from(request), chain).block();
    }

    private static void assertAuthRefusal(Runnable call) {
        assertThatThrownBy(call::run)
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.AUTH));
    }

    @Test
    void theGatewaysTokenMakesTheCaller() throws Exception {
        post("/v1/forge/plan", token(gatewayKey, InternalToken.ISSUER, 120_000));

        assertThat(Caller.of(reached.get())).isEqualTo(new Caller("anon-uid", true, false, "anonymous", null));
    }

    /** W1: the caller's network key travels in the signed token, and only there: the caller carries what the gateway signed. */
    @Test
    void theCallersNetworkKeyComesFromTheToken() throws Exception {
        long now = System.currentTimeMillis();
        JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).audience(InternalToken.AUDIENCE_FORGE)
                .subject("anon-uid").issueTime(new Date(now)).expirationTime(new Date(now + 120_000))
                .claim(InternalToken.CLAIM_ANONYMOUS, true).claim(InternalToken.CLAIM_ADMIN, false)
                .claim(InternalToken.CLAIM_PROVIDER, "anonymous").claim(InternalToken.CLAIM_IPK, "a1b2c3").build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(gatewayKey.getKeyID())
                .type(JOSEObjectType.JWT).build(), claims);
        jwt.sign(new RSASSASigner(gatewayKey));

        post("/v1/forge/plan", jwt.serialize());

        assertThat(Caller.of(reached.get()).ipk()).isEqualTo("a1b2c3");
    }

    @Test
    void noTokenIsRefused() {
        assertAuthRefusal(() -> post("/v1/forge/plan", null));
        assertThat(reached.get()).isNull();
    }

    @Test
    void aTokenSignedWithAnotherKeyIsRefused() throws Exception {
        String forged = token(otherKey, InternalToken.ISSUER, 120_000);
        assertAuthRefusal(() -> post("/v1/forge/plan", forged));
        assertThat(reached.get()).isNull();
    }

    @Test
    void anExpiredTokenIsRefusedBeyondTheClockSkew() throws Exception {
        String expired = token(gatewayKey, InternalToken.ISSUER, -120_000);
        assertAuthRefusal(() -> post("/v1/forge/plan", expired));
    }

    @Test
    void aTokenFromAnotherIssuerIsRefused() throws Exception {
        String foreign = token(gatewayKey, "flarelink-api-gateway", 120_000);
        assertAuthRefusal(() -> post("/v1/forge/plan", foreign));
    }

    /**
     * W2: the gateway mints a token per service. One it minted for the platform service, or one with no audience (as
     * every token before W2 was), is not forge's.
     */
    @Test
    void aTokenForThePlatformServiceOrForNoServiceIsRefused() throws Exception {
        String forPlatform = token(gatewayKey, InternalToken.ISSUER, 120_000, InternalToken.AUDIENCE_PLATFORM);
        assertAuthRefusal(() -> post("/v1/forge/plan", forPlatform));
        String forNone = token(gatewayKey, InternalToken.ISSUER, 120_000, null);
        assertAuthRefusal(() -> post("/v1/forge/plan", forNone));
        assertThat(reached.get()).isNull();
    }

    /** Share pages read without signing in, by GET only: the same path refuses a write. */
    @Test
    void publicReadsPassWithoutATokenByGetOnly() {
        filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get("/v1/forge/mode")), chain).block();
        assertThat(reached.get()).isNotNull();

        reached.set(null);
        assertAuthRefusal(() -> post("/v1/forge/mode", null));
        assertThat(reached.get()).isNull();
    }

    /** W2: the worlds and the showcase are the platform service's now, so forge reads them for no one without a token. */
    @Test
    void theWorldsAndTheShowcaseAreNoLongerForgesPublicReads() {
        for (String path : java.util.List.of("/v1/worlds/01HZXY", "/v1/showcase")) {
            reached.set(null);
            assertAuthRefusal(() -> filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get(path)), chain).block());
            assertThat(reached.get()).as(path).isNull();
        }
    }

    /** The mapping to 401 sits before the handlers: a handler's own failure must not become an auth error. */
    @Test
    void aHandlersErrorIsNotTurnedIntoAnAuthRefusal() throws Exception {
        WebFilterChain failing = exchange -> Mono.error(new IllegalStateException("a bug in a handler"));
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/forge/plan")
                .header(InternalToken.HEADER, token(gatewayKey, InternalToken.ISSUER, 120_000)));

        assertThatThrownBy(() -> filter.filter(exchange, failing).block())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("a bug in a handler");
    }
}
