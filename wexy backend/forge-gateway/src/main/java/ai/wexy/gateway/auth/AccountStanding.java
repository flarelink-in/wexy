package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.gateway.error.GatewayRejection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A suspended account spends nothing (the user, 2026-11-04: "suspension force that"; the creations platform design §11's
 * abuse layers, its ninth). The platform holds each account's status (W2: ACTIVE, SUSPENDED, DELETING) and forge never
 * reads it, so the gateway asks the platform before a signed-in caller's model call reaches forge: {@code GET /v1/me} as
 * that caller, with a token minted for the platform. Only an ACTIVE account spends, as only an ACTIVE account writes on
 * the platform: SUSPENDED, DELETING, DELETED, or any status this gateway does not know, is {@code 403 forbidden},
 * nothing forwarded (the account-guards review: DELETED had passed).
 *
 * <ul>
 *   <li>Anonymous callers have no account to suspend: never asked (their allowance is one world).</li>
 *   <li>No account yet (404, a W1 early-access caller who never set one up) is not barred: there is no account to have
 *       been suspended or deleted, which is not the same as an account deleted (200, DELETED).</li>
 *   <li>An answer is kept per uid for {@code wexy.auth.standing.ttl} (60 s), so a creation's turn and module calls ask
 *       once; a suspension holds within that time.</li>
 *   <li>The platform unreachable, slow past {@code wexy.auth.standing.timeout} (2 s), or answering anything else: an
 *       account this gateway last knew barred stays barred (the review: a known suspension must not lapse with the
 *       platform); any other call goes on, counted ({@code wexy.auth.standing{result=unknown}}) and never kept. An
 *       unknown account's spend is bounded by its allowance (one world a day) and by forge's spend ceilings, which fail
 *       closed; refusing every signed-in creator while the platform is down would cost more than that.</li>
 * </ul>
 *
 * Ordered right after the caller is verified (AuthorizationFilter, -200), before the per-user limiters.
 */
@Component
public class AccountStanding {

    public static final int ORDER = AuthorizationFilter.ORDER + 10;

    /** The one status that spends: any other, known or not, is barred. */
    static final String ACTIVE = "ACTIVE";

    /** The words a barred caller gets (§12: "This account can't save or publish changes right now"). */
    static final String REFUSAL = "This account can't make worlds right now.";

    private static final Logger log = LoggerFactory.getLogger(AccountStanding.class);
    /**
     * The most uids kept at once: past it, the expired words go (a barred one last, since it holds through an outage),
     * then every word but a barred one, then the whole table if it is still full.
     */
    static final int MAX_KEPT = 10_000;

    private final WebClient platform;
    private final InternalTokenMinter minter;
    private final ObjectMapper json;
    private final Duration ttl;
    private final Duration timeout;
    private final boolean enabled;
    private final Clock clock;
    private final Map<String, Kept> kept = new ConcurrentHashMap<>();
    private final Counter allowedMeter;
    private final Counter barredMeter;
    private final Counter unknownMeter;
    private final GatewayFilter spending = new Spending();

    /** One uid's answer, and until when it holds. */
    private record Kept(boolean barred, Instant until) {
    }

    @Autowired
    public AccountStanding(WebClient.Builder webClient, InternalTokenMinter minter, ObjectMapper json, MeterRegistry meters,
                           @Value("${wexy.platform-service.url}") String platformUrl,
                           @Value("${wexy.auth.standing.ttl:60s}") Duration ttl,
                           @Value("${wexy.auth.standing.timeout:2s}") Duration timeout,
                           @Value("${wexy.auth.standing.enabled:true}") boolean enabled) {
        this(webClient, minter, json, meters, platformUrl, ttl, timeout, enabled, Clock.systemUTC());
    }

    AccountStanding(WebClient.Builder webClient, InternalTokenMinter minter, ObjectMapper json, MeterRegistry meters,
                    String platformUrl, Duration ttl, Duration timeout, boolean enabled, Clock clock) {
        this.platform = webClient.clone().baseUrl(platformUrl).build();
        this.minter = minter;
        this.json = json;
        this.ttl = ttl;
        this.timeout = timeout;
        this.enabled = enabled;
        this.clock = clock;
        this.allowedMeter = meter(meters, "allowed");
        this.barredMeter = meter(meters, "barred");
        this.unknownMeter = meter(meters, "unknown");
    }

    private static Counter meter(MeterRegistry registry, String result) {
        return Counter.builder("wexy.auth.standing")
                .description("A signed-in caller's account standing, read before a model call")
                .tag("result", result)
                .register(registry);
    }

    /** The filter for forge's spending routes: a barred account's call is refused before it reaches forge. */
    public GatewayFilter spending() {
        return spending;
    }

    /** Whether `caller`'s account may spend: false only when the platform said SUSPENDED or DELETING. */
    Mono<Boolean> permits(VerifiedCaller caller) {
        Instant now = clock.instant();
        Kept known = kept.get(caller.uid());
        if (known != null && now.isBefore(known.until())) {
            return Mono.just(!known.barred());
        }
        return read(caller).map(barred -> {
            keep(caller.uid(), barred, now);
            (barred ? barredMeter : allowedMeter).increment();
            return !barred;
        }).switchIfEmpty(Mono.fromSupplier(() -> {
            unknownMeter.increment();
            // The platform gave no word: an account last known barred stays barred, expired or not (the review).
            return known == null || !known.barred();
        }));
    }

    /** The platform's word: barred or not; empty when it gave none to keep (unreachable, slow, or not its DTO). */
    private Mono<Boolean> read(VerifiedCaller caller) {
        String token = minter.mint(caller, false, null, InternalToken.AUDIENCE_PLATFORM);
        return platform.get().uri("/v1/me")
                .header(InternalToken.HEADER, token)
                .accept(MediaType.APPLICATION_JSON)
                .exchangeToMono(response -> {
                    if (response.statusCode().value() == HttpStatus.NOT_FOUND.value()) {
                        // No account yet, in the platform's own envelope; a 404 that is not its word (a URL that reaches
                        // something else) is no answer at all, so it is never kept as "allowed" (the independent review).
                        return response.bodyToMono(String.class).defaultIfEmpty("")
                                .flatMap(body -> "not-found".equals(codeOf(body)) ? Mono.just(false) : Mono.<Boolean>empty());
                    }
                    if (!response.statusCode().is2xxSuccessful()) {
                        return response.releaseBody().then(Mono.<Boolean>empty());
                    }
                    return response.bodyToMono(String.class).flatMap(body -> {
                        String status = statusOf(body);
                        return status == null ? Mono.<Boolean>empty() : Mono.just(!ACTIVE.equals(status));
                    });
                })
                .timeout(timeout)
                .onErrorResume(error -> {
                    log.warn("account.standing unknown: the platform did not answer ({})", error.toString());
                    return Mono.empty();
                });
    }

    private String statusOf(String body) {
        return field(body, "status");
    }

    private String codeOf(String body) {
        return field(body, "code");
    }

    private String field(String body, String name) {
        try {
            JsonNode value = json.readTree(body).get(name);
            return value != null && value.isTextual() ? value.asText() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void keep(String uid, boolean barred, Instant now) {
        if (kept.size() >= MAX_KEPT) {
            kept.values().removeIf(k -> !k.barred() && !now.isBefore(k.until()));
            if (kept.size() >= MAX_KEPT) {
                kept.values().removeIf(k -> !k.barred());
            }
            if (kept.size() >= MAX_KEPT) {
                kept.clear();
            }
        }
        kept.put(uid, new Kept(barred, now.plus(ttl)));
    }

    /** The route filter: signed-in callers only, after their verification. */
    private final class Spending implements GatewayFilter, Ordered {

        @Override
        public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
            VerifiedCaller caller = exchange.getAttribute(AuthAttributes.CALLER);
            if (!enabled || caller == null || caller.anonymous()) {
                return chain.filter(exchange);
            }
            return permits(caller).flatMap(ok -> ok
                    ? chain.filter(exchange)
                    : Mono.error(new GatewayRejection(ErrorCode.FORBIDDEN, REFUSAL)));
        }

        @Override
        public int getOrder() {
            return ORDER;
        }
    }
}
