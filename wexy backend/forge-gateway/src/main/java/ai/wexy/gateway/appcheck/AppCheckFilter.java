package ai.wexy.gateway.appcheck;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.net.URL;
import java.time.Instant;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * Verifies the Firebase App Check attestation on the routes a script would repeat.
 *
 * Copied from FlareLink's AppCheckFilter (pre-existing work). Changed: names and meters; a refusal
 * is {@link AppCheckRejection}, which the client sees as {@code appcheck}.
 *
 * Why it exists at all, given the routes are rate limited: a limiter keyed on client address caps
 * one address, and rotating residential proxies are cheap. App Check asks whether the request came
 * from our site in a real browser, the only question with teeth against an anonymous caller, and
 * every forge call costs Wexy money. It attests a browser, not a human: headless Chrome on the
 * real site gets genuine tokens. It raises the cost of abuse; it is not a wall.
 *
 * Order: the address limiter (-500), this (-300), then sign-in (-200). Replays: a verified token is
 * a bearer credential for about an hour, so {@link #singleUse()} spends it with Google
 * ({@link AppCheckReplayGuard}) on the routes where one request is worth scripting; the page mints
 * a fresh limited-use token for those (the frontend's list of single-use routes must match
 * ForgeRoutesTest).
 *
 * The Java Admin SDK has no App Check support, so the token is verified directly as an RS256 JWT
 * against Google's published key set.
 */
@Component
public class AppCheckFilter implements GatewayFilter, Ordered {

    private static final Logger logger = LoggerFactory.getLogger(AppCheckFilter.class);

    /** The header the Firebase Web SDK sends, and the name Google's own backends expect. */
    public static final String APP_CHECK_HEADER = "X-Firebase-AppCheck";

    /** Set once a request is attested. */
    public static final String APP_CHECK_VERIFIED_ATTRIBUTE = "wexy.appcheck.verified";

    private final boolean enabled;
    private final boolean enforce;
    private final boolean replayProtection;
    private final boolean enforceReplayProtection;
    private final String issuer;
    private final String audience;
    private final Set<String> allowedAppIds;
    private final long summaryIntervalMillis;

    private final ConfigurableJWTProcessor<SecurityContext> jwtProcessor;
    private final AppCheckReplayGuard replayGuard;
    private final GatewayFilter singleUse = new SingleUse();

    // Monitor-mode accounting: one human-readable ratio per interval in the log, beside monotonic
    // counters for Prometheus. Shipping unenforced first exists to learn this ratio from real
    // traffic before it can lock anyone out.
    private final AtomicLong verified = new AtomicLong();
    private final AtomicLong missing = new AtomicLong();
    private final AtomicLong invalid = new AtomicLong();
    private final AtomicLong replayed = new AtomicLong();
    private final AtomicLong lastSummaryAt = new AtomicLong(System.currentTimeMillis());

    private final Counter verifiedMeter;
    private final Counter missingMeter;
    private final Counter invalidMeter;
    private final Counter replayedMeter;

    public AppCheckFilter(
            MeterRegistry meterRegistry,
            AppCheckReplayGuard replayGuard,
            @Value("${wexy.appcheck.enabled:true}") boolean enabled,
            @Value("${wexy.appcheck.enforce:false}") boolean enforce,
            @Value("${wexy.appcheck.replay-protection.enabled:true}") boolean replayProtection,
            @Value("${wexy.appcheck.replay-protection.enforce:false}") boolean enforceReplayProtection,
            @Value("${wexy.appcheck.project-number:}") String projectNumber,
            @Value("${wexy.appcheck.allowed-app-ids:}") String allowedAppIds,
            @Value("${wexy.appcheck.jwks-uri:https://firebaseappcheck.googleapis.com/v1/jwks}") String jwksUri,
            @Value("${wexy.appcheck.summary-interval-seconds:60}") long summaryIntervalSeconds) {

        this.verifiedMeter = attestationCounter(meterRegistry, "verified");
        this.missingMeter = attestationCounter(meterRegistry, "missing");
        this.invalidMeter = attestationCounter(meterRegistry, "invalid");
        this.replayedMeter = attestationCounter(meterRegistry, "replayed");

        this.replayGuard = replayGuard;
        this.enforce = enforce;
        this.replayProtection = replayProtection;
        // Monitor mode for App Check is monitor mode for replays too: a request that would pass with
        // no token at all is not refused for reusing one.
        this.enforceReplayProtection = enforce && enforceReplayProtection;
        this.issuer = "https://firebaseappcheck.googleapis.com/" + projectNumber;
        this.audience = "projects/" + projectNumber;
        this.summaryIntervalMillis = summaryIntervalSeconds * 1000L;
        this.allowedAppIds = Arrays.stream(allowedAppIds.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toUnmodifiableSet());

        boolean configured = !projectNumber.isBlank() && !this.allowedAppIds.isEmpty();
        this.enabled = enabled && configured;

        if (enabled && !configured) {
            logger.error("App Check is switched on but not configured (wexy.appcheck.project-number and "
                    + ".allowed-app-ids). The filter passes every request through untouched. Set both, or set "
                    + "wexy.appcheck.enabled=false to silence this.");
        }

        this.jwtProcessor = this.enabled ? buildProcessor(jwksUri) : null;

        if (this.enabled) {
            String replayMode = !replayProtection ? "OFF"
                    : this.enforceReplayProtection ? "ENFORCING" : "MONITOR (replays counted, not refused)";
            logger.info("App Check filter active in {} mode, replay protection on single-use routes {}. "
                            + "issuer={} audience={} apps={}",
                    enforce ? "ENFORCING" : "MONITOR (logging only, nothing refused)",
                    replayMode, issuer, audience, this.allowedAppIds);
        }
    }

    /** Registered eagerly, so the `invalid` and `replayed` series exist before they first fire. */
    private static Counter attestationCounter(MeterRegistry registry, String result) {
        return Counter.builder("wexy.appcheck.attestations")
                .description("App Check attestation outcomes on protected routes")
                .tag("result", result)
                .register(registry);
    }

    /**
     * JWKSourceBuilder rather than the deprecated RemoteJWKSet: it caches the key set, refreshes it
     * ahead of expiry and rate-limits refetches on unknown key ids, so a burst of junk tokens cannot
     * become a burst of calls to Google.
     */
    private ConfigurableJWTProcessor<SecurityContext> buildProcessor(String jwksUri) {
        try {
            JWKSource<SecurityContext> keySource = JWKSourceBuilder.create(new URL(jwksUri)).build();
            DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
            // RS256 pinned: accepting whatever the token's header asks for is how algorithm
            // confusion happens.
            processor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, keySource));
            // Claims are checked by hand in verifyClaims(), so every rule is visible in one place.
            processor.setJWTClaimsSetVerifier((claims, context) -> { });
            return processor;
        } catch (Exception e) {
            throw new IllegalStateException("Could not build the App Check JWT processor for " + jwksUri, e);
        }
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        return attest(exchange, chain, false);
    }

    /**
     * This filter, then the token is spent: a second request carrying it is refused as a replay.
     * Always the same instance, so a route's filter list can be checked for it.
     */
    public GatewayFilter singleUse() {
        return singleUse;
    }

    private Mono<Void> attest(ServerWebExchange exchange, GatewayFilterChain chain, boolean spend) {
        if (!enabled) {
            return chain.filter(exchange);
        }

        String token = exchange.getRequest().getHeaders().getFirst(APP_CHECK_HEADER);
        String path = exchange.getRequest().getURI().getPath();

        if (token == null || token.isBlank()) {
            missing.incrementAndGet();
            missingMeter.increment();
            maybeLogSummary();
            return reject(exchange, chain, path, "no " + APP_CHECK_HEADER + " header", enforce,
                    AppCheckRejection.Reason.INVALID);
        }

        // Signature verification fetches and parses keys, so it is blocking work.
        return Mono.fromCallable(() -> verify(token))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(attestation -> spend && replayProtection
                        ? replayGuard.spend(token, attestation.expiresAt())
                                .flatMap(use -> use == AppCheckReplayGuard.Use.REPEAT
                                        ? replay(exchange, chain, path)
                                        : admit(exchange, chain, attestation))
                        : admit(exchange, chain, attestation))
                .onErrorResume(AppCheckInvalid.class, e -> {
                    invalid.incrementAndGet();
                    invalidMeter.increment();
                    maybeLogSummary();
                    return reject(exchange, chain, path, e.getMessage(), enforce, AppCheckRejection.Reason.INVALID);
                });
    }

    private Mono<Void> admit(ServerWebExchange exchange, GatewayFilterChain chain, Attestation attestation) {
        verified.incrementAndGet();
        verifiedMeter.increment();
        maybeLogSummary();
        exchange.getAttributes().put(APP_CHECK_VERIFIED_ATTRIBUTE, attestation.appId());
        return chain.filter(exchange);
    }

    /** A genuine token, already spent: counted apart from invalid, because it is what a script produces. */
    private Mono<Void> replay(ServerWebExchange exchange, GatewayFilterChain chain, String path) {
        replayed.incrementAndGet();
        replayedMeter.increment();
        maybeLogSummary();
        return reject(exchange, chain, path, "token already spent", enforceReplayProtection,
                AppCheckRejection.Reason.REPLAYED);
    }

    /**
     * In monitor mode this logs and passes the request through. That is the point of the mode:
     * turning enforcement on against unknown traffic is how you learn your own clients never sent the
     * header, with the site already down.
     */
    private Mono<Void> reject(ServerWebExchange exchange, GatewayFilterChain chain, String path, String why,
                              boolean enforcing, AppCheckRejection.Reason reason) {
        if (!enforcing) {
            logger.debug("App Check would have refused {} ({}): monitor mode, passing through", path, why);
            return chain.filter(exchange);
        }
        logger.warn("App Check refused {}: {}", path, why);
        return Mono.error(new AppCheckRejection(reason));
    }

    /** What the token attests, or throws {@link AppCheckInvalid} with the reason. */
    private Attestation verify(String token) {
        JWTClaimsSet claims;
        try {
            claims = jwtProcessor.process(SignedJWT.parse(token), null);
        } catch (Exception e) {
            throw new AppCheckInvalid("signature/parse failed: " + e.getMessage());
        }
        return verifyClaims(claims);
    }

    private Attestation verifyClaims(JWTClaimsSet claims) {
        if (!issuer.equals(claims.getIssuer())) {
            throw new AppCheckInvalid("issuer was " + claims.getIssuer() + ", expected " + issuer);
        }

        List<String> audiences = claims.getAudience();
        if (audiences == null || !audiences.contains(audience)) {
            throw new AppCheckInvalid("audience " + audiences + " does not contain " + audience);
        }

        Date expiry = claims.getExpirationTime();
        if (expiry == null || expiry.before(new Date())) {
            throw new AppCheckInvalid("token expired at " + expiry);
        }

        // sub is the Firebase app id: checking it stops a token minted for another app in the same
        // project from being replayed here.
        String appId = claims.getSubject();
        if (appId == null || !allowedAppIds.contains(appId)) {
            throw new AppCheckInvalid("subject " + appId + " is not a recognised app id");
        }

        return new Attestation(appId, expiry.toInstant());
    }

    /** Emits the running split at most once per interval. */
    private void maybeLogSummary() {
        long now = System.currentTimeMillis();
        long last = lastSummaryAt.get();
        if (now - last < summaryIntervalMillis) {
            return;
        }
        if (!lastSummaryAt.compareAndSet(last, now)) {
            return;
        }

        long ok = verified.getAndSet(0);
        long none = missing.getAndSet(0);
        long bad = invalid.getAndSet(0);
        long reused = replayed.getAndSet(0);
        long total = ok + none + bad + reused;
        if (total == 0) {
            return;
        }

        logger.info("App Check [{}] last {}s: {} verified, {} missing, {} invalid, {} replayed ({}% attested).{}",
                enforce ? "ENFORCING" : "monitor", summaryIntervalMillis / 1000,
                ok, none, bad, reused, (ok * 100) / total,
                enforce ? "" : " Do not enforce until this is consistently near 100% on real traffic.");
    }

    @Override
    public int getOrder() {
        // Between the address limiter (-500) and sign-in (-200).
        return -300;
    }

    /** What a verified token vouches for: the app that minted it, and until when. */
    private record Attestation(String appId, Instant expiresAt) {
    }

    /** {@link #singleUse()}: the same check, spending the token. Ordered like the filter it extends. */
    private final class SingleUse implements GatewayFilter, Ordered {

        @Override
        public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
            return attest(exchange, chain, true);
        }

        @Override
        public int getOrder() {
            return AppCheckFilter.this.getOrder();
        }
    }

    /** The internal signal for why a token failed; it never leaves this filter. */
    private static class AppCheckInvalid extends RuntimeException {
        AppCheckInvalid(String message) {
            super(message);
        }
    }
}
