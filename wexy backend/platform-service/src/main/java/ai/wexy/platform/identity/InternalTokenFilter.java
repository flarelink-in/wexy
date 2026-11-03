package ai.wexy.platform.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.common.InternalTokenVerifier;
import ai.wexy.platform.error.PlatformException;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
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

import java.util.List;
import java.util.stream.Stream;

/**
 * Accepts a request only with an internal token the gateway signed for the platform (W2; the creations platform
 * design §14), from a caller with a real account, and records who is calling. forge-common's verifier makes the same
 * check as forge's filter, with the platform's audience, so a token minted for a forge route is refused here.
 *
 * An anonymous caller is refused here too, though the gateway already refuses one on every platform route (§10's N):
 * the platform holds accounts, and a token that says anonymous is never one. Health and the Prometheus scrape pass
 * without a token, and so do §10's public rows, each by its own method: the gateway sends them no token (P, and the
 * waitlist). Until their stages (W4, W6) no handler serves them, so they answer 404 (the independent W2 review: they
 * were 401). Safe only while this service is reachable solely through the gateway: never publish its port.
 */
@Component
public class InternalTokenFilter implements WebFilter, Ordered {

    public static final String CALLER_ATTRIBUTE = "wexy.platform.caller";

    private record PublicRoute(HttpMethod method, PathPattern path) {
    }

    private static final List<PublicRoute> PUBLIC = Stream.of(
                    "GET /actuator/health", "GET /actuator/health/**", "GET /actuator/prometheus",
                    "GET /v1/showcase", "GET /v1/profiles/{handle}", "GET /v1/profiles/{handle}/worlds",
                    "GET /v1/publications/{id}", "POST /v1/waitlist")
            .map(route -> route.split(" "))
            .map(parts -> new PublicRoute(HttpMethod.valueOf(parts[0]), PathPatternParser.defaultInstance.parse(parts[1])))
            .toList();

    private final InternalTokenVerifier verifier;

    @Autowired
    public InternalTokenFilter(@Value("${wexy.internal-jwt.jwks-uri}") String jwksUri) {
        this(InternalTokenVerifier.remoteKeys(jwksUri));
    }

    /** With a given key source, for tests. */
    public InternalTokenFilter(JWKSource<SecurityContext> keys) {
        this.verifier = new InternalTokenVerifier(keys, InternalToken.AUDIENCE_PLATFORM);
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (isPublic(exchange.getRequest())) {
            return chain.filter(exchange);
        }

        String token = exchange.getRequest().getHeaders().getFirst(InternalToken.HEADER);
        if (token == null || token.isBlank()) {
            return Mono.error(new PlatformException(ErrorCode.AUTH, "This request did not come through the gateway."));
        }

        // Verification may fetch the gateway's key set, so it is blocking work. The error mapping sits before flatMap on
        // purpose: errors from the handlers downstream must not become 401s.
        return Mono.fromCallable(() -> verify(token))
                .subscribeOn(Schedulers.boundedElastic())
                .onErrorMap(error -> !(error instanceof PlatformException),
                        error -> new PlatformException(ErrorCode.AUTH, "The internal token is not valid."))
                .flatMap(caller -> {
                    exchange.getAttributes().put(CALLER_ATTRIBUTE, caller);
                    return chain.filter(exchange);
                });
    }

    private PlatformCaller verify(String token) throws Exception {
        InternalTokenVerifier.Claims claims = verifier.verify(token);
        if (claims.anonymous()) {
            throw new PlatformException(ErrorCode.ACCOUNT_REQUIRED, "This needs a signed-in account.");
        }
        return new PlatformCaller(claims.uid(), claims.admin(), claims.provider());
    }

    private static boolean isPublic(ServerHttpRequest request) {
        return PUBLIC.stream().anyMatch(route -> route.method().equals(request.getMethod())
                && route.path().matches(request.getPath().pathWithinApplication()));
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 50;
    }
}
