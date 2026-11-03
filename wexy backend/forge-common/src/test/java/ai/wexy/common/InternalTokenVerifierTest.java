package ai.wexy.common;

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

import java.util.Date;
import java.util.function.UnaryOperator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * W2: one check for every service behind the gateway. A token is the gateway's, for this service, and current, or it is
 * nothing; the audience is what keeps a token minted for forge from opening platform, and the reverse.
 */
class InternalTokenVerifierTest {

    private static final RSAKey GATEWAY = generate("gateway");
    private static final RSAKey OTHER = generate("other");

    private final InternalTokenVerifier forge =
            new InternalTokenVerifier(new ImmutableJWKSet<>(new JWKSet(GATEWAY.toPublicJWK())), InternalToken.AUDIENCE_FORGE);
    private final InternalTokenVerifier platform =
            new InternalTokenVerifier(new ImmutableJWKSet<>(new JWKSet(GATEWAY.toPublicJWK())), InternalToken.AUDIENCE_PLATFORM);

    private static RSAKey generate(String kid) {
        try {
            return new RSAKeyGenerator(2048).keyID(kid).generate();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** A token as the gateway mints it for `audience`, changed by `edit` before it is signed with `key`. */
    private static String token(RSAKey key, String audience, UnaryOperator<JWTClaimsSet.Builder> edit) throws Exception {
        long now = System.currentTimeMillis();
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
                .issuer(InternalToken.ISSUER)
                .subject("uid-1")
                .issueTime(new Date(now))
                .expirationTime(new Date(now + InternalToken.LIFETIME_MILLIS))
                .claim(InternalToken.CLAIM_ANONYMOUS, false)
                .claim(InternalToken.CLAIM_ADMIN, false)
                .claim(InternalToken.CLAIM_PROVIDER, "google.com")
                .claim(InternalToken.CLAIM_IPK, "ab12");
        if (audience != null) {
            builder.audience(audience);
        }
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID())
                .type(JOSEObjectType.JWT).build(), edit.apply(builder).build());
        jwt.sign(new RSASSASigner(key));
        return jwt.serialize();
    }

    @Test
    void aTokenForThisServiceGivesItsClaims() throws Exception {
        assertThat(forge.verify(token(GATEWAY, InternalToken.AUDIENCE_FORGE, b -> b)))
                .isEqualTo(new InternalTokenVerifier.Claims("uid-1", false, false, "google.com", "ab12"));
        assertThat(platform.verify(token(GATEWAY, InternalToken.AUDIENCE_PLATFORM, b -> b)).uid()).isEqualTo("uid-1");
    }

    /** The point of the audience: a token lifted from one service's traffic opens no other. */
    @Test
    void aTokenForTheOtherServiceIsRefused() throws Exception {
        String forForge = token(GATEWAY, InternalToken.AUDIENCE_FORGE, b -> b);
        String forPlatform = token(GATEWAY, InternalToken.AUDIENCE_PLATFORM, b -> b);
        assertThatThrownBy(() -> platform.verify(forForge)).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> forge.verify(forPlatform)).isInstanceOf(Exception.class);
    }

    /** Before W2 the gateway minted no audience; such a token is refused everywhere, so no old token outlives the deploy. */
    @Test
    void aTokenWithoutAnAudienceIsRefused() throws Exception {
        String none = token(GATEWAY, null, b -> b);
        assertThatThrownBy(() -> forge.verify(none)).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> platform.verify(none)).isInstanceOf(Exception.class);
    }

    @Test
    void anotherKeyAnotherIssuerOrAnExpiryBeyondTheSkewIsRefused() throws Exception {
        assertThatThrownBy(() -> forge.verify(token(OTHER, InternalToken.AUDIENCE_FORGE, b -> b))).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> forge.verify(token(GATEWAY, InternalToken.AUDIENCE_FORGE, b -> b.issuer("flarelink-api-gateway"))))
                .isInstanceOf(Exception.class);
        long past = System.currentTimeMillis() - 120_000;
        assertThatThrownBy(() -> forge.verify(token(GATEWAY, InternalToken.AUDIENCE_FORGE,
                b -> b.issueTime(new Date(past - 1000)).expirationTime(new Date(past))))).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> forge.verify(token(GATEWAY, InternalToken.AUDIENCE_FORGE, b -> b.subject(null))))
                .isInstanceOf(Exception.class);
    }

    @Test
    void aKeySetAddressThatIsNotAUrlStopsStartup() {
        assertThatThrownBy(() -> InternalTokenVerifier.remoteKeys("not a url")).isInstanceOf(IllegalStateException.class);
    }
}
