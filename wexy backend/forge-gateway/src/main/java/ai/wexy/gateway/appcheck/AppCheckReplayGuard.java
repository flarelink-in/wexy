package ai.wexy.gateway.appcheck;

import ai.wexy.gateway.auth.FirebaseCredentials;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.google.auth.oauth2.GoogleCredentials;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.netty.channel.ChannelOption;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.ConnectionProvider;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Spends App Check tokens, so a token presented to a single-use route works once.
 *
 * Copied from FlareLink's AppCheckReplayGuard (pre-existing work). Changed: the service account is
 * optional. Without one (the local profile, before Wexy's Firebase project exists), Google cannot
 * be asked, so tokens are spent on this instance's ledger alone, and that is said once at startup.
 *
 * Verifying a token as a JWT proves our site minted it in a real browser within its TTL (about an
 * hour), and nothing about how often it has been used since. Google's verifyAppCheckToken marks a
 * token consumed on first sight and answers alreadyConsumed after that, for every caller, so the
 * answer holds across replicas and restarts. In front of it, a ledger of tokens this instance has
 * spent refuses a flood of one replayed token without a call per request, and while Google cannot
 * be asked, still admits a token at most once here: an outage downgrades replay protection from
 * global to per instance, not to nothing.
 */
@Component
public class AppCheckReplayGuard {

    /** What spending a token found. */
    public enum Use { FIRST, REPEAT }

    private static final Logger log = LoggerFactory.getLogger(AppCheckReplayGuard.class);

    /** The method accepts cloud-platform or firebase; this is the narrower one. */
    private static final String FIREBASE_SCOPE = "https://www.googleapis.com/auth/firebase";

    /** The ledger forgets a token at its exp, or after this, whichever is sooner. */
    private static final long MAX_LEDGER_RETENTION_MILLIS = Duration.ofHours(1).toMillis();
    private static final int MAX_LEDGER_ENTRIES = 50_000;

    /** Null when no service account is configured: the ledger alone decides. */
    private final GoogleCredentials credentials;
    private final URI verifyUri;
    private final Duration timeout;
    private final WebClient client;
    private final Counter unconfirmedMeter;

    // Digest of each token this instance has spent, mapped to when it may be forgotten.
    private final ConcurrentHashMap<String, Long> spent = new ConcurrentHashMap<>();
    private final AtomicLong spendsSinceSweep = new AtomicLong();

    @Autowired
    public AppCheckReplayGuard(
            FirebaseCredentials firebaseCredentials,
            MeterRegistry meterRegistry,
            @Value("${wexy.appcheck.project-number:}") String projectNumber,
            @Value("${wexy.appcheck.api-base-url:https://firebaseappcheck.googleapis.com}") String apiBaseUrl,
            @Value("${wexy.appcheck.replay-protection.timeout-millis:2000}") long timeoutMillis) {
        this(firebaseCredentials.credentials().orElse(null), meterRegistry, projectNumber, apiBaseUrl, timeoutMillis);
    }

    /** With explicit credentials (or null), for tests and the constructor above. */
    public AppCheckReplayGuard(GoogleCredentials credentials, MeterRegistry meterRegistry, String projectNumber,
                               String apiBaseUrl, long timeoutMillis) {
        this.credentials = credentials == null ? null : credentials.createScoped(List.of(FIREBASE_SCOPE));
        this.verifyUri = URI.create(apiBaseUrl + "/v1beta/projects/" + projectNumber + ":verifyAppCheckToken");
        this.timeout = Duration.ofMillis(timeoutMillis);

        // Registered eagerly: a counter that appears on its first increment cannot be told apart
        // from one that has nothing to count.
        this.unconfirmedMeter = Counter.builder("wexy.appcheck.consume.failures")
                .description("Single-use App Check tokens Google could not be asked about, admitted on this instance's ledger alone")
                .register(meterRegistry);

        ConnectionProvider connectionProvider = ConnectionProvider.builder("gateway-appcheck")
                .maxConnections(50)
                .pendingAcquireMaxCount(200)
                .pendingAcquireTimeout(Duration.ofSeconds(2))
                .maxIdleTime(Duration.ofSeconds(30))
                .maxLifeTime(Duration.ofMinutes(5))
                .build();

        HttpClient httpClient = HttpClient.create(connectionProvider)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, (int) Math.min(timeoutMillis, 2000))
                .responseTimeout(this.timeout);

        this.client = WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .build();

        if (this.credentials == null) {
            log.warn("App Check replay protection has no service account: single-use tokens are spent on this "
                    + "instance's ledger only.");
        }
    }

    /**
     * Spends a token that has already passed signature and claim checks, so a junk token never costs
     * a call to Google.
     *
     * @param expiresAt the token's exp; the ledger has no reason to remember it past that
     * @return {@link Use#REPEAT} if this instance or Google has seen the token before; {@link Use#FIRST}
     *         if Google says this is its first use, or if Google could not be asked and this instance
     *         has not seen it either (counted and logged)
     */
    public Mono<Use> spend(String token, Instant expiresAt) {
        sweepIfDue();

        long forgetAt = Math.min(expiresAt.toEpochMilli(), System.currentTimeMillis() + MAX_LEDGER_RETENTION_MILLIS);
        // Atomic: of two requests racing with one token, exactly one gets past this line.
        if (spent.putIfAbsent(fingerprint(token), forgetAt) != null) {
            return Mono.just(Use.REPEAT);
        }
        if (credentials == null) {
            return Mono.just(Use.FIRST);
        }

        return alreadyConsumed(token)
                .map(consumed -> consumed ? Use.REPEAT : Use.FIRST)
                .onErrorResume(error -> {
                    unconfirmedMeter.increment();
                    log.warn("Could not spend an App Check token with Google; admitted on this instance's ledger alone. {}",
                            describe(error));
                    return Mono.just(Use.FIRST);
                });
    }

    private Mono<Boolean> alreadyConsumed(String token) {
        return Mono.fromCallable(() -> credentials.getRequestMetadata(verifyUri))
                // Refreshing the access token is a blocking call to Google, about once an hour.
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(authorization -> client.post()
                        .uri(verifyUri)
                        .headers(headers -> authorization.forEach(headers::addAll))
                        .contentType(MediaType.APPLICATION_JSON)
                        .bodyValue(Map.of("appCheckToken", token))
                        .retrieve()
                        .bodyToMono(VerifyAppCheckTokenResponse.class))
                // Google omits the field on a token's first use rather than sending false.
                .map(response -> Boolean.TRUE.equals(response.alreadyConsumed()))
                .defaultIfEmpty(false)
                // Covers the access-token refresh as well as the call itself.
                .timeout(timeout);
    }

    /**
     * What most likely went wrong. Google answers 403 both for a token it considers invalid and for a
     * caller without permission to ask; a token that got here passed our own checks, so a 403 is
     * nearly always the second.
     */
    private String describe(Throwable error) {
        if (error instanceof WebClientResponseException response) {
            String body = response.getResponseBodyAsString();
            String excerpt = body.length() > 300 ? body.substring(0, 300) + "..." : body;
            String hint = switch (response.getStatusCode().value()) {
                case 403 -> " Check that the service account in FIREBASE_SERVICE_ACCOUNT_B64 holds the role "
                        + "'Firebase App Check Token Verifier' in the project WEXY_APPCHECK_PROJECT_NUMBER names.";
                case 429 -> " The App Check API quota for this project is exhausted.";
                default -> "";
            };
            return "HTTP " + response.getStatusCode().value() + ": " + excerpt + hint;
        }
        if (error instanceof TimeoutException) {
            return "No answer within " + timeout.toMillis() + "ms.";
        }
        return error.toString();
    }

    private void sweepIfDue() {
        if (spendsSinceSweep.incrementAndGet() % 512 != 0 && spent.size() < MAX_LEDGER_ENTRIES) {
            return;
        }
        long now = System.currentTimeMillis();
        spent.values().removeIf(forgetAt -> forgetAt <= now);
        if (spent.size() >= MAX_LEDGER_ENTRIES) {
            // Only the local short-circuit is lost; Google still refuses every replay.
            log.warn("App Check replay ledger holds {} live tokens, clearing it", spent.size());
            spent.clear();
        }
    }

    /** A token is a bearer credential, so the ledger keeps digests, not tokens. */
    private static String fingerprint(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            // Every Java platform must provide SHA-256.
            throw new IllegalStateException(e);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record VerifyAppCheckTokenResponse(Boolean alreadyConsumed) {
    }
}
