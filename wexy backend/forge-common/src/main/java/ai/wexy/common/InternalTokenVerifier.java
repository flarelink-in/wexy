package ai.wexy.common;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;

import java.net.MalformedURLException;
import java.net.URI;
import java.util.Objects;
import java.util.Set;

/**
 * The one check of an internal token, for every service behind the gateway (W2; the creations platform design §14):
 * RS256 against the gateway's published key set, its issuer, this service's audience, and a subject, an issue time and
 * an expiry, with 30 s of clock skew. Forge and platform each build one with their own audience, so a token the gateway
 * minted for one is refused by the other, and neither can drift from the other's rules.
 *
 * Moved here from forge's InternalTokenFilter (adapted from FlareLink's InternalJwtInterceptor, pre-existing work),
 * with the audience added. Each service's filter keeps its own public paths and its own error type.
 */
public final class InternalTokenVerifier {

    /** What the gateway vouched for, as the token carries it. */
    public record Claims(String uid, boolean anonymous, boolean admin, String provider, String ipk) {
    }

    static final int MAX_CLOCK_SKEW_SECONDS = 30;

    private final ConfigurableJWTProcessor<SecurityContext> processor;

    /** @param audience the service this verifier accepts tokens for: {@link InternalToken#AUDIENCE_FORGE} or another */
    public InternalTokenVerifier(JWKSource<SecurityContext> keys, String audience) {
        Objects.requireNonNull(audience, "audience");
        DefaultJWTProcessor<SecurityContext> jwtProcessor = new DefaultJWTProcessor<>();
        jwtProcessor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, keys));
        DefaultJWTClaimsVerifier<SecurityContext> claims = new DefaultJWTClaimsVerifier<>(audience,
                new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).build(),
                Set.of("sub", "iat", "exp", "aud"));
        claims.setMaxClockSkew(MAX_CLOCK_SKEW_SECONDS);
        jwtProcessor.setJWTClaimsSetVerifier(claims);
        this.processor = jwtProcessor;
    }

    /**
     * The gateway's key set at {@code jwksUri}, through Nimbus's caching source: a new key id makes it fetch the set
     * again, which is what lets the gateway rotate its key with a restart.
     */
    public static JWKSource<SecurityContext> remoteKeys(String jwksUri) {
        try {
            return JWKSourceBuilder.create(URI.create(jwksUri).toURL()).retrying(true).build();
        } catch (MalformedURLException | IllegalArgumentException e) {
            throw new IllegalStateException("wexy.internal-jwt.jwks-uri is not a URL: " + jwksUri, e);
        }
    }

    /**
     * The claims of a token the gateway signed for this service. Throws for anything else: another key, another issuer,
     * another audience or none, a missing claim, an expiry beyond the skew. It may fetch the key set, so it blocks.
     */
    public Claims verify(String token) throws Exception {
        JWTClaimsSet claims = processor.process(token, null);
        return new Claims(
                claims.getSubject(),
                Boolean.TRUE.equals(claims.getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)),
                Boolean.TRUE.equals(claims.getBooleanClaim(InternalToken.CLAIM_ADMIN)),
                claims.getStringClaim(InternalToken.CLAIM_PROVIDER),
                claims.getStringClaim(InternalToken.CLAIM_IPK));
    }
}
