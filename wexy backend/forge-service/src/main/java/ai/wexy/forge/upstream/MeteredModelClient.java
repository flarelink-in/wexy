package ai.wexy.forge.upstream;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.spend.SpendGuard;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The one door to a model: every call is checked, reserved, made, then settled (coding principles
 * §1, §3; forge-loop design §11).
 *
 * In order, before any byte goes upstream:
 * 1. a configured key, or {@code paused} (nothing is charged);
 * 2. the role's upper bound reserved against its provider's ceilings: every input token the bound
 *    allows ({@link ModelCatalog#inputTokenBound}: one per byte, the framing, twice the schema),
 *    plus every output token the cap allows. {@code budget} if a ceiling is reached, {@code paused}
 *    if the meter is unreachable or owed; either way zero requests reach Meta;
 * 3. the stream, under the role's deadline for the whole call;
 * 4. when the stream ends, the reservation is settled to what the final chunk's usage cost: the
 *    unused part returns to the ceilings, an overrun (the bound was wrong) is counted and alarmed
 *    ({@link SpendGuard#settle}). Once per call, off the event loop and on its own subscription,
 *    so a client that leaves at the last chunk cannot cancel the bookkeeping.
 *
 * {@link #charge} does steps 1 and 2 and hands back a stream that is already reserved, so an
 * endpoint can answer a refusal as an HTTP envelope before its response commits (forge-loop design
 * §5.2, §7). The meter's answer is also reported to a {@link ChargeListener}, even when the caller
 * has gone while the meter was deciding, and even when the meter failed: a reservation that was
 * made, or a call that will never be made, must be recorded by someone.
 */
@Component
public class MeteredModelClient {

    private static final Logger log = LoggerFactory.getLogger(MeteredModelClient.class);

    /**
     * Per-call adjustments within a role's limits, and who the call is for.
     *
     * @param maxOutputTokens  lower than the role's cap, never higher; null for the role's
     * @param responseFormat   an OpenAI-style {@code response_format}, or null
     * @param safetyIdentifier a stable hash of the caller for Meta's abuse checks, or null
     * @param lane             the spend lane the call is charged to ({@link SpendGuard#LANES}; W1): always named, never
     *                         defaulted, so no call can land in another group's share; an unknown one is refused
     */
    public record CallOptions(Integer maxOutputTokens, Map<String, Object> responseFormat, String safetyIdentifier, String lane) {

        /** No adjustment: the role's cap, no response format, no safety identifier, in {@code lane}. */
        public static CallOptions defaults(String lane) {
            return new CallOptions(null, null, null, lane);
        }
    }

    /**
     * What the meter decided for one call, and what the call reserved if it was allowed.
     *
     * @param microUsd    the bound reserved when allowed; what would have been reserved otherwise
     * @param inputTokens the input bound the reservation was computed from
     */
    public record Reservation(SpendGuard.Charge outcome, long microUsd, long inputTokens) {

        public boolean allowed() {
            return outcome == SpendGuard.Charge.ALLOWED;
        }
    }

    /**
     * Hears the meter's answer for one call: exactly one of {@link #charged} or {@link #failed},
     * on the metering thread, before the reserved call is handed on, and also when the subscriber
     * cancelled while the meter was deciding. A listener must not throw; one that does is logged,
     * and the meter's decision stands.
     */
    public interface ChargeListener {

        ChargeListener NONE = reservation -> {
        };

        void charged(Reservation reservation);

        /** The meter itself failed (a bug or a misconfiguration, not a lost Redis): no call will be made. */
        default void failed(Throwable error) {
        }
    }

    /**
     * A call that is reserved, or will be when its chunks are subscribed ({@link #prepare}).
     *
     * @param inputTokenBound the input bound the reservation was computed from
     * @param chargedMicroUsd the reservation, settled to the usage when the stream ends
     * @param chunks          the model's stream, under the role's deadline; subscribing it charges
     *                        nothing more
     */
    public record Metered(String role, String model, String provider, int maxOutputTokens, long inputTokenBound,
                          long chargedMicroUsd, Flux<ChatChunk> chunks) {
    }

    private final MetaApiClient client;
    private final ModelCatalog catalog;
    private final SpendGuard spendGuard;

    public MeteredModelClient(MetaApiClient client, ModelCatalog catalog, SpendGuard spendGuard) {
        this.client = client;
        this.catalog = catalog;
        this.spendGuard = spendGuard;
    }

    /**
     * Checks the key and reserves the role's upper bound, off the event loop, when subscribed. It
     * emits the reserved call, or fails with {@code paused} or {@code budget} having sent nothing.
     */
    public Mono<Metered> charge(String roleName, List<ChatMessage> messages, CallOptions options, String detail) {
        return charge(roleName, messages, options, detail, ChargeListener.NONE);
    }

    /**
     * As {@link #charge(String, List, CallOptions, String)}, telling the listener what the meter
     * decided, whether or not the subscriber is still there to receive the result.
     */
    public Mono<Metered> charge(String roleName, List<ChatMessage> messages, CallOptions options, String detail,
                                ChargeListener listener) {
        Priced priced = price(roleName, messages, options);
        ModelProperties.Role role = priced.role();
        int maxOutput = priced.maxOutputTokens();
        long bound = priced.boundMicroUsd();
        ChatRequest request = new ChatRequest(role.model(), messages, maxOutput, options.responseFormat(),
                role.reasoningEffort(), options.safetyIdentifier());

        return Mono.defer(() -> {
            if (!client.hasKey()) {
                return Mono.error(new ForgeException(ErrorCode.PAUSED,
                        "Live creation is paused: no model API key is configured."));
            }
            return decide(role, options.lane(), bound, priced.inputTokens(), detail, listener)
                    .flatMap(receipt -> switch (receipt.outcome()) {
                        case ALLOWED -> Mono.just(new Metered(roleName, role.model(), role.provider(), maxOutput,
                                priced.inputTokens(), bound,
                                settling(withDeadline(client.streamChat(request), role.timeout()), receipt, role.model(), detail)));
                        case CAP_REACHED -> Mono.<Metered>error(new ForgeException(ErrorCode.BUDGET,
                                "Live creation has reached its spending limit for now."));
                        case METER_UNAVAILABLE -> Mono.<Metered>error(new ForgeException(ErrorCode.PAUSED,
                                "Live creation is paused: the spend meter is unavailable."));
                    });
        });
    }

    /** Streams one completion for a role, reserved first. Nothing happens until it is subscribed. */
    public Flux<ChatChunk> stream(String roleName, List<ChatMessage> messages, CallOptions options, String detail) {
        return prepare(roleName, messages, options, detail).chunks();
    }

    /**
     * As {@link #stream}, with what the call will reserve known up front; the reservation itself
     * happens when the chunks are subscribed, through {@link #charge}. The probe uses it.
     */
    public Metered prepare(String roleName, List<ChatMessage> messages, CallOptions options, String detail) {
        Priced priced = price(roleName, messages, options);
        return new Metered(roleName, priced.role().model(), priced.role().provider(), priced.maxOutputTokens(),
                priced.inputTokens(), priced.boundMicroUsd(),
                charge(roleName, messages, options, detail).flatMapMany(Metered::chunks));
    }

    /**
     * A role's cap, lowered by the caller if asked (never raised), the input bound, and the call's
     * upper bound in micro-USD.
     */
    private record Priced(ModelProperties.Role role, int maxOutputTokens, long inputTokens, long boundMicroUsd) {
    }

    private Priced price(String roleName, List<ChatMessage> messages, CallOptions options) {
        ModelProperties.Role role = catalog.role(roleName);
        int maxOutput = options.maxOutputTokens() == null
                ? role.maxOutputTokens()
                : Math.min(options.maxOutputTokens(), role.maxOutputTokens());
        long inputTokens = ModelCatalog.inputTokenBound(messages, options.responseFormat());
        long bound = catalog.upperBoundMicroUsd(role.model(), inputTokens, maxOutput);
        return new Priced(role, maxOutput, inputTokens, bound);
    }

    /**
     * The meter's decision, off the event loop, and never interrupted: a subscriber that cancels
     * stops waiting, but an increment in Redis cannot be undone, so the work runs to its end and
     * the listener hears the answer either way: the reservation, or the meter's own failure. (A
     * {@code subscribeOn} would interrupt the thread on cancel, and an interrupted Redis call
     * answers "unavailable" for a charge that may well have landed.)
     */
    private Mono<SpendGuard.Receipt> decide(ModelProperties.Role role, String lane, long bound, long inputTokens, String detail,
                                            ChargeListener listener) {
        return Mono.create(sink -> {
            AtomicBoolean waiting = new AtomicBoolean(true);
            sink.onCancel(() -> waiting.set(false));
            Schedulers.boundedElastic().schedule(() -> {
                SpendGuard.Receipt receipt;
                try {
                    receipt = spendGuard.reserve(role.provider(), lane, bound, detail);
                } catch (RuntimeException e) {
                    tellFailed(listener, e, detail);
                    if (waiting.get()) {
                        sink.error(e);
                    } else {
                        log.error("The meter failed for {} after its caller had gone.", detail, e);
                    }
                    return;
                }
                tell(listener, new Reservation(receipt.outcome(), bound, inputTokens), detail);
                sink.success(receipt);
            });
        });
    }

    private static void tell(ChargeListener listener, Reservation reservation, String detail) {
        try {
            listener.charged(reservation);
        } catch (RuntimeException e) {
            log.error("The charge listener of {} failed; the reservation stands as the meter decided it.", detail, e);
        }
    }

    private static void tellFailed(ChargeListener listener, Throwable error, String detail) {
        try {
            listener.failed(error);
        } catch (RuntimeException e) {
            log.error("The charge listener of {} failed while being told of a failure.", detail, e);
        }
    }

    /**
     * The stream, settled once when it ends, whichever way it ends: the last usage seen (Meta's is
     * on the final chunk; a repeated or cumulative usage is read last-wins) against the reservation.
     * A stream that ends without usage keeps its reservation, which over-counts.
     */
    private Flux<ChatChunk> settling(Flux<ChatChunk> chunks, SpendGuard.Receipt receipt, String model, String detail) {
        return Flux.defer(() -> {
            AtomicReference<ChatChunk.Usage> last = new AtomicReference<>();
            return chunks
                    .doOnNext(chunk -> {
                        if (chunk.usage() != null) {
                            last.set(chunk.usage());
                        }
                    })
                    .doFinally(signal -> {
                        ChatChunk.Usage usage = last.get();
                        if (usage != null) {
                            settle(receipt, model, usage, detail);
                        }
                    });
        });
    }

    /**
     * Settles off the event loop, on its own subscription: the response may already be done, or
     * its client gone, and the money is spent either way.
     */
    private void settle(SpendGuard.Receipt receipt, String model, ChatChunk.Usage usage, String detail) {
        long cost = catalog.costMicroUsd(model, usage);
        Mono.fromCallable(() -> spendGuard.settle(receipt, cost, detail))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(settlement -> {
                }, error -> log.error("Settling {} failed: cost {} against {} reserved.", detail, cost, receipt.microUsd(), error));
    }

    /**
     * One deadline for the whole stream: each event re-arms the timer with only the time that is left,
     * so a slow trickle cannot stretch the call past its role's timeout.
     */
    static <T> Flux<T> withDeadline(Flux<T> source, Duration deadline) {
        return Flux.defer(() -> {
            Instant end = Instant.now().plus(deadline);
            return source
                    .timeout(Mono.defer(() -> Mono.delay(remaining(end))),
                            item -> Mono.defer(() -> Mono.delay(remaining(end))))
                    .onErrorMap(TimeoutException.class, e -> new UpstreamException(UpstreamException.Kind.TIMEOUT, 0,
                            "the call took longer than " + deadline));
        });
    }

    private static Duration remaining(Instant end) {
        Duration left = Duration.between(Instant.now(), end);
        return left.isNegative() ? Duration.ZERO : left;
    }
}
