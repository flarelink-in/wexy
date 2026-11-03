package ai.wexy.platform;

import ai.wexy.common.InternalToken;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * Plays forge-gateway for the platform's tests: its signing key, the key set it publishes (in memory, or on a loopback
 * port for a whole-service test), and internal tokens as it mints them, for the platform by default.
 */
public final class GatewayKeys implements AutoCloseable {

    private final RSAKey key;
    private HttpServer server;

    public GatewayKeys() {
        try {
            key = new RSAKeyGenerator(2048).keyID("gateway-stand-in").generate();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The key set, as the platform's filter is handed it in a unit test. */
    public JWKSource<SecurityContext> keySet() {
        return new ImmutableJWKSet<>(new JWKSet(key.toPublicJWK()));
    }

    /** The key set served on a loopback port, where {@code wexy.internal-jwt.jwks-uri} can point. */
    public String serve() {
        if (server == null) {
            byte[] jwks = new JWKSet(key.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
            try {
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            server.createContext(InternalToken.JWKS_PATH, exchange -> {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, jwks.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(jwks);
                }
            });
            server.start();
        }
        return "http://127.0.0.1:" + server.getAddress().getPort() + InternalToken.JWKS_PATH;
    }

    /** A Google user's token for the platform, as the gateway mints it on a platform route. */
    public String account(String uid) {
        return token(uid, false, false, InternalToken.AUDIENCE_PLATFORM);
    }

    /** A token as the gateway mints it: anonymous or not, admin or not, for `audience` (none when null). */
    public String token(String uid, boolean anonymous, boolean admin, String audience) {
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).subject(uid)
                    .issueTime(new Date(now)).expirationTime(new Date(now + InternalToken.LIFETIME_MILLIS))
                    .claim(InternalToken.CLAIM_ANONYMOUS, anonymous).claim(InternalToken.CLAIM_ADMIN, admin)
                    .claim(InternalToken.CLAIM_PROVIDER, anonymous ? "anonymous" : "google.com");
            if (audience != null) {
                claims.audience(audience);
            }
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID())
                    .type(JOSEObjectType.JWT).build(), claims.build());
            jwt.sign(new RSASSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() {
        if (server != null) {
            server.stop(0);
        }
    }
}
