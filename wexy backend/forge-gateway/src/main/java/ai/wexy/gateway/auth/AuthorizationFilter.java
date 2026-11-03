package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.gateway.error.GatewayRejection;
import ai.wexy.gateway.shield.ClientNetworkKey;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Verifies the caller with Firebase and hands forge-service a signed identity.
 *
 * Adapted from FlareLink's AuthorizationFilter (pre-existing work). Changed: a caller without an
 * email (every Firebase anonymous user) is no longer refused; each route instead picks a policy
 * (backend architecture §4, Q8). Forge routes allow anonymous callers; the platform's accounts and
 * creations need a real account (W2); admin routes need a uid on the allow-list.
 *
 * Each filter also names the service its route leads to, and the token it mints carries that
 * audience (W2): forge's filters mint for forge, the platform's for the platform, and each service
 * refuses the other's tokens.
 *
 * Ordered at -200: after the address-keyed limiter (-500) and App Check (-300), so verification,
 * the most expensive thing the gateway does, is never reachable in unbounded volume.
 */
@Component
public class AuthorizationFilter {

    public enum Policy { ANONYMOUS_ALLOWED, ACCOUNT_REQUIRED, ADMIN }

    public static final int ORDER = -200;

    private final FirebaseTokenVerifier verifier;
    private final InternalTokenMinter minter;
    private final ClientNetworkKey networkKey;
    private final Set<String> adminUids;

    private final PolicyFilter anonymousAllowed = new PolicyFilter(Policy.ANONYMOUS_ALLOWED, InternalToken.AUDIENCE_FORGE);
    private final PolicyFilter accountRequired = new PolicyFilter(Policy.ACCOUNT_REQUIRED, InternalToken.AUDIENCE_FORGE);
    private final PolicyFilter adminOnly = new PolicyFilter(Policy.ADMIN, InternalToken.AUDIENCE_FORGE);
    // The platform service's (W2): never anonymous. Its own A (an active account) and O (the owner) checks follow there.
    private final PolicyFilter platformAccount = new PolicyFilter(Policy.ACCOUNT_REQUIRED, InternalToken.AUDIENCE_PLATFORM);
    private final PolicyFilter platformAdmin = new PolicyFilter(Policy.ADMIN, InternalToken.AUDIENCE_PLATFORM);

    // Split by reason, because they mean different things: `header_missing` rising is a broken
    // client, `token_rejected` an expired-session bug or someone trying tokens, `account_required`
    // an anonymous user reaching for an account-only action.
    private final Counter authorisedMeter;
    private final Counter headerMissingMeter;
    private final Counter tokenRejectedMeter;
    private final Counter accountRequiredMeter;
    private final Counter forbiddenMeter;

    /** Firebase verification is the most expensive step on the request path; this says when it is slow. */
    private final Timer verificationTimer;

    public AuthorizationFilter(FirebaseTokenVerifier verifier,
                               InternalTokenMinter minter,
                               ClientNetworkKey networkKey,
                               MeterRegistry meterRegistry,
                               @Value("${wexy.auth.admin-uids:}") String adminUids) {
        this.verifier = verifier;
        this.minter = minter;
        this.networkKey = networkKey;
        this.adminUids = Arrays.stream(adminUids.split(","))
                .map(String::trim)
                .filter(uid -> !uid.isEmpty())
                .collect(Collectors.toUnmodifiableSet());

        this.authorisedMeter = outcomeCounter(meterRegistry, "authorised");
        this.headerMissingMeter = outcomeCounter(meterRegistry, "header_missing");
        this.tokenRejectedMeter = outcomeCounter(meterRegistry, "token_rejected");
        this.accountRequiredMeter = outcomeCounter(meterRegistry, "account_required");
        this.forbiddenMeter = outcomeCounter(meterRegistry, "forbidden");

        this.verificationTimer = Timer.builder("wexy.auth.firebase.verification")
                .description("Round trip to verify a caller's Firebase ID token")
                .publishPercentileHistogram()
                .register(meterRegistry);
    }

    private static Counter outcomeCounter(MeterRegistry registry, String result) {
        return Counter.builder("wexy.auth.outcomes")
                .description("The result of authenticating a caller on a protected route")
                .tag("result", result)
                .register(registry);
    }

    /** Forge routes: any signed-in caller, anonymous included. */
    public GatewayFilter anonymousAllowed() {
        return anonymousAllowed;
    }

    /** A real account, on a forge route (none uses it yet). */
    public GatewayFilter accountRequired() {
        return accountRequired;
    }

    /** A uid on {@code wexy.auth.admin-uids}, on a forge route. */
    public GatewayFilter adminOnly() {
        return adminOnly;
    }

    /**
     * The platform service's routes that need someone signed in (W2; the creations platform design §10's N, A and O): a
     * real account, never an anonymous one, and a token minted for the platform.
     */
    public GatewayFilter platformAccount() {
        return platformAccount;
    }

    /** The platform service's admin routes (§10's D): the allow-list, and a token minted for the platform. */
    public GatewayFilter platformAdmin() {
        return platformAdmin;
    }

    /**
     * The filter for one policy and one service. Always the same instance per pair, so a route can be checked for
     * it.
     */
    public final class PolicyFilter implements GatewayFilter, Ordered {

        private final Policy policy;
        private final String audience;

        private PolicyFilter(Policy policy, String audience) {
            this.policy = policy;
            this.audience = audience;
        }

        public Policy policy() {
            return policy;
        }

        /** The service the minted token is for (W2). */
        public String audience() {
            return audience;
        }

        @Override
        public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
            String token = InternalTokenMinter.extractBearerToken(
                    exchange.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION));

            // Refused without touching Firebase: a malformed header is not worth a signature check.
            if (token == null) {
                headerMissingMeter.increment();
                return Mono.error(new GatewayRejection(ErrorCode.AUTH,
                        "Missing or malformed Authorization header."));
            }

            Timer.Sample sample = Timer.start();
            return verifier.verify(token)
                    // Stopped here, so it times the call to Google alone.
                    .doOnEach(signal -> {
                        if (signal.isOnNext() || signal.isOnError()) {
                            sample.stop(verificationTimer);
                        }
                    })
                    .doOnError(error -> tokenRejectedMeter.increment())
                    .flatMap(caller -> admit(exchange, chain, caller));
        }

        private Mono<Void> admit(ServerWebExchange exchange, GatewayFilterChain chain, VerifiedCaller caller) {
            boolean admin = adminUids.contains(caller.uid());

            if (policy == Policy.ACCOUNT_REQUIRED && caller.anonymous()) {
                accountRequiredMeter.increment();
                return Mono.error(new GatewayRejection(ErrorCode.ACCOUNT_REQUIRED,
                        "This needs a signed-in account."));
            }
            if (policy == Policy.ADMIN && !admin) {
                forbiddenMeter.increment();
                return Mono.error(new GatewayRejection(ErrorCode.FORBIDDEN, "This route is for administrators."));
            }

            // Lets the post-authentication limiter key on a verified identity.
            exchange.getAttributes().put(AuthAttributes.UID, caller.uid());
            exchange.getAttributes().put(AuthAttributes.ANONYMOUS, caller.anonymous());
            authorisedMeter.increment();

            // The network key comes from the address the gateway resolved, never from a header the client chose (W1).
            ServerHttpRequest outbound = exchange.getRequest().mutate()
                    .header(InternalToken.HEADER, minter.mint(caller, admin, networkKey.of(exchange), audience))
                    .build();
            return chain.filter(exchange.mutate().request(outbound).build());
        }

        @Override
        public int getOrder() {
            return ORDER;
        }
    }
}
