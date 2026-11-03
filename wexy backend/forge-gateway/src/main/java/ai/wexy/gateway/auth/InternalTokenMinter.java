package ai.wexy.gateway.auth;

import ai.wexy.common.InternalToken;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.stereotype.Component;

import java.util.Date;

/**
 * Mints the internal token forge-service trusts, from what Firebase vouched for.
 *
 * Adapted from FlareLink's InternalIdentityService (pre-existing work). Changed: no profile lookup
 * in a user service, and so no profile cache or its connection pool; the claims come from the
 * Firebase token alone (backend architecture §4): the uid as the subject, whether the caller is
 * anonymous, whether the uid is on the admin allow-list, and the sign-in provider; since W1, the
 * caller's network key ({@code ipk}), from the address the gateway resolved, never from a header the
 * client wrote; since W2, the service the token is for ({@code aud}), so a token minted for one service
 * opens no other. Minted with Nimbus rather than jjwt, so the gateway needs one JOSE library.
 */
@Component
public class InternalTokenMinter {

    private static final int MAX_TOKEN_LENGTH = 4096;

    private final InternalSigningKey signingKey;
    private final JWSSigner signer;

    public InternalTokenMinter(InternalSigningKey signingKey) {
        this.signingKey = signingKey;
        this.signer = new RSASSASigner(signingKey.getPrivateKey());
    }

    /**
     * The bearer token in an Authorization header, or null for anything that cannot be a Firebase ID
     * token. FlareLink's earlier {@code split("Bearer ")[1]} threw on "Authorization: x", turning a
     * one-byte request into a 500.
     */
    public static String extractBearerToken(String headerValue) {
        if (headerValue == null) {
            return null;
        }
        String trimmed = headerValue.trim();
        if (trimmed.length() <= 7 || !trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return null;
        }
        String token = trimmed.substring(7).trim();
        if (token.isEmpty() || token.length() > MAX_TOKEN_LENGTH) {
            return null;
        }
        // A compact JWS: header.payload.signature.
        if (token.chars().filter(c -> c == '.').count() != 2) {
            return null;
        }
        return token;
    }

    /**
     * The token for a verified caller.
     *
     * @param ipk      the caller's network key ({@code ClientNetworkKey}), or null when there is none: the
     *                 claim is then left out, never sent empty (W1)
     * @param audience the service the route leads to ({@link InternalToken#AUDIENCE_FORGE} or
     *                 {@link InternalToken#AUDIENCE_PLATFORM}, W2): that service alone accepts the token
     */
    public String mint(VerifiedCaller caller, boolean admin, String ipk, String audience) {
        long now = System.currentTimeMillis();
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
                .issuer(InternalToken.ISSUER)
                .audience(java.util.Objects.requireNonNull(audience, "audience"))
                .subject(caller.uid())
                .issueTime(new Date(now))
                .expirationTime(new Date(now + InternalToken.LIFETIME_MILLIS))
                .claim(InternalToken.CLAIM_ANONYMOUS, caller.anonymous())
                .claim(InternalToken.CLAIM_ADMIN, admin)
                .claim(InternalToken.CLAIM_PROVIDER, caller.provider());
        if (ipk != null) {
            builder.claim(InternalToken.CLAIM_IPK, ipk);
        }
        JWTClaimsSet claims = builder.build();
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
                .keyID(signingKey.getKeyId())
                .type(JOSEObjectType.JWT)
                .build(), claims);
        try {
            jwt.sign(signer);
        } catch (JOSEException e) {
            throw new IllegalStateException("Could not sign an internal token", e);
        }
        return jwt.serialize();
    }
}
