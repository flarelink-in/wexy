package ai.wexy.forge.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.forge.error.ForgeException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.http.HttpMethod;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Accepts a request only with an internal token the gateway signed, and records who is calling.
 *
 * Adapted from FlareLink's InternalJwtInterceptor (pre-existing work), a servlet interceptor, as a
 * WebFlux filter. Changed: Nimbus's caching JWK source (FlareLink used the deprecated RemoteJWKSet
 * and jjwt); RS256 pinned; issuer, subject, issue and expiry required, with 30 s of clock skew;
 * no per-request INFO logging of identities. A new key id makes the source fetch the key set
 * again, which is what lets the gateway rotate its key with a restart.
 *
 * Public reads pass without a token, GET only, because the gateway serves them to share pages
 * with no sign-in. That is safe only while this service is reachable solely through the gateway:
 * never publish its port.
 */
@Component
public class InternalTokenFilter implements WebFilter, Ordered {

    public static final String CALLER_ATTRIBUTE = "wexy.caller";

    private static final int MAX_CLOCK_SKEW_SECONDS = 30;

    /** The gateway's public-read routes (ForgeRoutes), and health. */
    private static final List<PathPattern> PUBLIC_READS = Stream.of(
                    "/v1/forge/mode", "/v1/archive/match", "/v1/worlds/{id}", "/v1/showcase", "/v1/stats",
                    "/actuator/health", "/actuator/health/**", "/actuator/prometheus")
            .map(PathPatternParser.defaultInstance::parse)
            .toList();

    private final ConfigurableJWTProcessor<SecurityContext> processor;

    @Autowired
    public InternalTokenFilter(@Value("${wexy.internal-jwt.jwks-uri}") String jwksUri) {
        this(remoteKeys(jwksUri));
    }

    /** With a given key source, for tests. */
    public InternalTokenFilter(JWKSource<SecurityContext> keys) {
        DefaultJWTProcessor<SecurityContext> jwtProcessor = new DefaultJWTProcessor<>();
        jwtProcessor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, keys));
        DefaultJWTClaimsVerifier<SecurityContext> claims = new DefaultJWTClaimsVerifier<>(
                new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).build(),
                Set.of("sub", "iat", "exp"));
        claims.setMaxClockSkew(MAX_CLOCK_SKEW_SECONDS);
        jwtProcessor.setJWTClaimsSetVerifier(claims);
        this.processor = jwtProcessor;
    }

    private static JWKSource<SecurityContext> remoteKeys(String jwksUri) {
        try {
            return JWKSourceBuilder.create(new URL(jwksUri)).retrying(true).build();
        } catch (MalformedURLException e) {
            throw new IllegalStateException("wexy.internal-jwt.jwks-uri is not a URL: " + jwksUri, e);
        }
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (isPublicRead(exchange.getRequest())) {
            return chain.filter(exchange);
        }

        String token = exchange.getRequest().getHeaders().getFirst(InternalToken.HEADER);
        if (token == null || token.isBlank()) {
            return Mono.error(new ForgeException(ErrorCode.AUTH, "This request did not come through the gateway."));
        }

        // Verification may fetch the gateway's key set, so it is blocking work. The error mapping sits
        // before flatMap on purpose: errors from the handlers downstream must not become 401s.
        return Mono.fromCallable(() -> verify(token))
                .subscribeOn(Schedulers.boundedElastic())
                .onErrorMap(error -> !(error instanceof ForgeException),
                        error -> new ForgeException(ErrorCode.AUTH, "The internal token is not valid."))
                .flatMap(caller -> {
                    exchange.getAttributes().put(CALLER_ATTRIBUTE, caller);
                    return chain.filter(exchange);
                });
    }

    private Caller verify(String token) throws Exception {
        JWTClaimsSet claims = processor.process(token, null);
        return new Caller(
                claims.getSubject(),
                Boolean.TRUE.equals(claims.getBooleanClaim(InternalToken.CLAIM_ANONYMOUS)),
                Boolean.TRUE.equals(claims.getBooleanClaim(InternalToken.CLAIM_ADMIN)),
                claims.getStringClaim(InternalToken.CLAIM_PROVIDER),
                claims.getStringClaim(InternalToken.CLAIM_IPK));
    }

    private static boolean isPublicRead(ServerHttpRequest request) {
        return HttpMethod.GET.equals(request.getMethod())
                && PUBLIC_READS.stream().anyMatch(pattern -> pattern.matches(request.getPath().pathWithinApplication()));
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 50;
    }
}
