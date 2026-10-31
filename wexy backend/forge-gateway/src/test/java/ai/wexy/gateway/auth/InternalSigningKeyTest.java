package ai.wexy.gateway.auth;

import org.junit.jupiter.api.Test;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Copied from FlareLink's InternalSigningKeyTest (pre-existing work). These pin the property that
 * broke FlareLink in production: the kid is a function of the key material, so a new key is always
 * a kid a JWKS cache has never seen.
 */
class InternalSigningKeyTest {

    @Test
    void aDifferentKeyMustNotReuseTheSameKeyId() {
        InternalSigningKey first = new InternalSigningKey(generatePkcs8Base64(2048));
        InternalSigningKey second = new InternalSigningKey(generatePkcs8Base64(2048));

        assertThat(first.getKeyId())
                .as("a new key published under the old kid is invisible to a downstream JWKS cache")
                .isNotEqualTo(second.getKeyId());
    }

    @Test
    void theSameKeyYieldsTheSameKeyIdOnEveryInstance() {
        String key = generatePkcs8Base64(2048);

        // Two constructions stand in for a restart, and for a second replica.
        InternalSigningKey before = new InternalSigningKey(key);
        InternalSigningKey after = new InternalSigningKey(key);

        assertThat(before.getKeyId()).isEqualTo(after.getKeyId());
        assertThat(before.getPublicJwkSetJson()).isEqualTo(after.getPublicJwkSetJson());
    }

    /** The local fallback is safe only because an ephemeral key still gets a kid of its own. */
    @Test
    void aGeneratedKeyAlsoGetsAKeyIdOfItsOwn() {
        InternalSigningKey first = new InternalSigningKey("");
        InternalSigningKey second = new InternalSigningKey("   ");

        assertThat(first.getKeyId()).isNotBlank();
        assertThat(second.getKeyId()).isNotBlank();
        assertThat(first.getKeyId()).isNotEqualTo(second.getKeyId());
    }

    @Test
    void thePublishedJwkSetCarriesTheKeyIdAndNoPrivateMaterial() {
        InternalSigningKey signingKey = new InternalSigningKey(generatePkcs8Base64(2048));
        String jwks = signingKey.getPublicJwkSetJson();

        assertThat(jwks).contains(signingKey.getKeyId())
                .contains("\"kty\":\"RSA\"")
                .contains("\"use\":\"sig\"");
        // "d" is the private exponent; "p" and "q" are the primes. None may ever be served.
        assertThat(jwks).doesNotContain("\"d\":")
                .doesNotContain("\"p\":")
                .doesNotContain("\"q\":");
    }

    @Test
    void aPemDocumentIsAcceptedAsWellAsRawBase64() {
        String base64 = generatePkcs8Base64(2048);
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + base64.replaceAll("(.{64})", "$1\n")
                + "\n-----END PRIVATE KEY-----\n";

        assertThat(new InternalSigningKey(pem).getKeyId())
                .isEqualTo(new InternalSigningKey(base64).getKeyId());
    }

    /** A configured but broken key stops the gateway rather than falling back to a generated one. */
    @Test
    void anUnusableConfiguredKeyFailsStartup() {
        assertThatThrownBy(() -> new InternalSigningKey("not-base64-at-all!!"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not valid base64");

        assertThatThrownBy(() -> new InternalSigningKey(Base64.getEncoder().encodeToString("nonsense".getBytes())))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aWeakKeyIsRejected() {
        assertThatThrownBy(() -> new InternalSigningKey(generatePkcs8Base64(1024)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("1024 bits");
    }

    @Test
    void theSigningKeyMatchesTheKeyThatWasConfigured() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair keyPair = generator.generateKeyPair();
        String encoded = Base64.getEncoder().encodeToString(keyPair.getPrivate().getEncoded());

        InternalSigningKey signingKey = new InternalSigningKey(encoded);

        // The same modulus: the public half served in the JWKS really verifies what this signs.
        assertThat(signingKey.getPrivateKey().getModulus())
                .isEqualTo(((RSAPrivateKey) keyPair.getPrivate()).getModulus());
    }

    static String generatePkcs8Base64(int bits) {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(bits);
            // getEncoded() on an RSA private key is already PKCS#8 DER.
            return Base64.getEncoder().encodeToString(generator.generateKeyPair().getPrivate().getEncoded());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
