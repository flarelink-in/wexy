package ai.wexy.forge;

import ai.wexy.common.InternalToken;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
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
 * Plays forge-gateway for a whole-service test: publishes a key set on a loopback port, where
 * {@code wexy.internal-jwt.jwks-uri} can point, and mints internal tokens signed with that key, as
 * the gateway does after Firebase vouched for a caller.
 */
public final class GatewayStandIn implements AutoCloseable {

    private final RSAKey key;
    private final HttpServer server;

    public GatewayStandIn() {
        try {
            key = new RSAKeyGenerator(2048).keyID("gateway-stand-in").generate();
            byte[] jwks = new JWKSet(key.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext(InternalToken.JWKS_PATH, exchange -> {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, jwks.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(jwks);
                }
            });
            server.start();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public String jwksUri() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + InternalToken.JWKS_PATH;
    }

    /** An internal token for a caller, as the gateway mints it. */
    public String token(String uid, boolean anonymous, boolean admin) {
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).subject(uid)
                    .issueTime(new Date(now)).expirationTime(new Date(now + InternalToken.LIFETIME_MILLIS))
                    .claim(InternalToken.CLAIM_ANONYMOUS, anonymous).claim(InternalToken.CLAIM_ADMIN, admin)
                    .claim(InternalToken.CLAIM_PROVIDER, anonymous ? "anonymous" : "google.com").build();
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.getKeyID())
                    .type(JOSEObjectType.JWT).build(), claims);
            jwt.sign(new RSASSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
