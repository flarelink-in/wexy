package ai.wexy.gateway.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;

/**
 * The RSA key the gateway signs internal tokens with, and the key id it publishes them under.
 *
 * Copied from FlareLink's InternalSigningKey (pre-existing work); names changed.
 *
 * <h2>Why the key id is a thumbprint</h2>
 * FlareLink once generated a fresh key on every boot under a hard-coded kid. Services cache JWKS
 * entries by kid and re-fetch only on an unfamiliar one, so a gateway-only restart left them
 * verifying against a dead key and every authenticated request failed. The kid is now the RFC 7638
 * thumbprint of the public key: a different key is always a different kid, and the service
 * re-fetches on its own.
 *
 * <h2>Why the key is configurable</h2>
 * A regenerated key is safe, but cannot survive two gateway instances: a JWKS fetch can land on the
 * replica that did not sign the token. So deployments supply {@code WEXY_INTERNAL_JWT_PRIVATE_KEY}
 * and every instance shares it; generation is a fallback for local runs only. Rotation is a restart
 * with a new secret: a new kid, a re-fetch, and old tokens expire within two minutes.
 */
@Component
public class InternalSigningKey {

    private static final Logger log = LoggerFactory.getLogger(InternalSigningKey.class);

    /** RSA below this is not worth signing an identity with. */
    private static final int MINIMUM_MODULUS_BITS = 2048;

    private final RSAPrivateKey privateKey;
    private final String keyId;
    private final String publicJwkSetJson;

    public InternalSigningKey(@Value("${wexy.internal-jwt.private-key:}") String configuredPrivateKey) {
        RSAKey jwk = StringUtils.hasText(configuredPrivateKey)
                ? fromConfiguredKey(configuredPrivateKey)
                : fromGeneratedKey();

        this.keyId = jwk.getKeyID();
        this.publicJwkSetJson = new JWKSet(jwk.toPublicJWK()).toString();
        try {
            this.privateKey = jwk.toRSAPrivateKey();
        } catch (JOSEException e) {
            throw new IllegalStateException("The internal token signing key is unusable", e);
        }

        log.info("Internal token signing key ready: kid={}, {} bits", keyId, jwk.size());
    }

    public RSAPrivateKey getPrivateKey() {
        return privateKey;
    }

    /** Published in the JWKS and set as the {@code kid} header of every internal token. */
    public String getKeyId() {
        return keyId;
    }

    /** The public half only, as a JWK Set for {@code /.well-known/jwks.json}. */
    public String getPublicJwkSetJson() {
        return publicJwkSetJson;
    }

    /**
     * A base64 (or PEM) PKCS#8 RSA private key. A key that is present but unusable fails startup
     * rather than falling back to a generated one: falling back would pass every functional test
     * while holding a different key from the other replicas, and surface later as intermittent
     * 401s with nothing in the logs pointing at a mistyped secret.
     */
    private RSAKey fromConfiguredKey(String configured) {
        try {
            byte[] der = Base64.getDecoder().decode(stripEncodingArmour(configured));
            KeyFactory keyFactory = KeyFactory.getInstance("RSA");

            PrivateKey parsed = keyFactory.generatePrivate(new PKCS8EncodedKeySpec(der));
            if (!(parsed instanceof RSAPrivateCrtKey crtKey)) {
                throw new IllegalStateException(
                        "WEXY_INTERNAL_JWT_PRIVATE_KEY must be an RSA private key in PKCS#8 form; got "
                                + parsed.getAlgorithm() + " without CRT parameters, so its public half "
                                + "cannot be derived.");
            }

            if (crtKey.getModulus().bitLength() < MINIMUM_MODULUS_BITS) {
                throw new IllegalStateException("WEXY_INTERNAL_JWT_PRIVATE_KEY is only "
                        + crtKey.getModulus().bitLength() + " bits; " + MINIMUM_MODULUS_BITS + " is the minimum.");
            }

            RSAPublicKey publicKey = (RSAPublicKey) keyFactory.generatePublic(
                    new RSAPublicKeySpec(crtKey.getModulus(), crtKey.getPublicExponent()));

            return toJwk(publicKey, crtKey);

        } catch (IllegalStateException e) {
            throw e;
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "WEXY_INTERNAL_JWT_PRIVATE_KEY is not valid base64. Expected a single-line base64 PKCS#8 "
                            + "key: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | openssl pkcs8 "
                            + "-topk8 -nocrypt -outform DER | base64 -w0", e);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(
                    "WEXY_INTERNAL_JWT_PRIVATE_KEY could not be read as a PKCS#8 RSA private key.", e);
        }
    }

    /** Local runs only: no shared key configured, so sign with an ephemeral one. */
    private RSAKey fromGeneratedKey() {
        log.warn("No wexy.internal-jwt.private-key configured: generating an ephemeral signing key. Every "
                + "restart invalidates issued tokens and makes forge-service re-fetch the key set. Never run "
                + "more than one gateway instance like this.");
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(MINIMUM_MODULUS_BITS);
            KeyPair keyPair = generator.generateKeyPair();
            return toJwk((RSAPublicKey) keyPair.getPublic(), (RSAPrivateKey) keyPair.getPrivate());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Could not generate an internal token signing key", e);
        }
    }

    private RSAKey toJwk(RSAPublicKey publicKey, RSAPrivateKey privateKey) {
        try {
            // The thumbprint hashes only the public parameters (kty, n, e), so the same key yields
            // the same kid on every instance and across restarts.
            return new RSAKey.Builder(publicKey)
                    .privateKey(privateKey)
                    .keyUse(KeyUse.SIGNATURE)
                    .algorithm(JWSAlgorithm.RS256)
                    .keyIDFromThumbprint()
                    .build();
        } catch (JOSEException e) {
            throw new IllegalStateException("Could not derive a key id from the signing key", e);
        }
    }

    /** Accepts a single-line base64 blob or a whole PEM document. */
    private static String stripEncodingArmour(String value) {
        return value.replaceAll("-----(BEGIN|END)[^-]*-----", "").replaceAll("\\s", "");
    }
}
