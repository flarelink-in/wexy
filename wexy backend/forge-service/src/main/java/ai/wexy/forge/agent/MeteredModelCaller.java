package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.GenerationStore;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.MeteredModelClient;
import ai.wexy.forge.upstream.UpstreamException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.Disposable;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The agent loop's calls through the metered door (the agent-loop design §3, §11; EA2.4). Each call is a
 * {@code Generation} of kind {@code AGENT} under the turn's id (A2): recorded before it is charged, reserved by
 * {@link MeteredModelClient#charge}, streamed under the role's deadline or the turn's, whichever comes first, and
 * collected whole, then finished once, with its usage and cost, as {@code OK}, {@code DENIED}, {@code CANCELLED},
 * {@code TIMEOUT} or {@code ERROR}.
 *
 * <p>The loop's thread waits for each step. {@link #cancel()} comes from the route when the client leaves: it disposes
 * the call in flight, which cancels its upstream request, and releases the waiting thread at once (A8).
 */
final class MeteredModelCaller implements ModelCaller {

    static final String ROLE = "agent";
    private static final Logger log = LoggerFactory.getLogger(MeteredModelCaller.class);
    /** Above the role's own deadline, which ends a stream first (MeteredModelClient). */
    private static final Duration MARGIN = Duration.ofSeconds(15);

    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final GenerationStore store;
    private final String turnId;
    private final Caller caller;
    private final String requestJson;
    private final String promptVersion;
    private final String hostVersion;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final AtomicReference<Pending> pending = new AtomicReference<>();

    /** The call in flight: its subscription, and the latch the loop's thread waits on. */
    private record Pending(Disposable subscription, CountDownLatch done) {
    }

    MeteredModelCaller(MeteredModelClient models, ModelCatalog catalog, GenerationStore store, String turnId, Caller caller,
                       String requestJson, String promptVersion, String hostVersion) {
        this.models = models;
        this.catalog = catalog;
        this.store = store;
        this.turnId = turnId;
        this.caller = caller;
        this.requestJson = requestJson;
        this.promptVersion = promptVersion;
        this.hostVersion = hostVersion;
    }

    @Override
    public long bound(List<ChatMessage> messages, Map<String, Object> responseFormat) {
        ModelProperties.Role role = catalog.role(ROLE);
        return catalog.upperBoundMicroUsd(role.model(), ModelCatalog.inputTokenBound(messages, responseFormat), role.maxOutputTokens());
    }

    @Override
    public ModelAnswer call(int n, List<ChatMessage> messages, Map<String, Object> responseFormat, Runnable charged,
                            Duration remaining) {
        if (cancelled.get()) {
            throw new AgentCallFailure("cancelled", "the client left");
        }
        if (!remaining.isPositive()) {
            throw new AgentCallFailure("deadline", "the turn's time ran out before call " + n);
        }
        long deadline = System.nanoTime() + remaining.toNanos();
        ModelProperties.Role role = catalog.role(ROLE);
        Instant now = Instant.now();
        String id = Ulid.next(now);
        store.begin(Generation.started(id, Generation.Kind.AGENT, turnId, ROLE, role.model(), promptVersion, hostVersion, null,
                n == 1 ? requestJson : "call " + n + " of turn " + turnId, caller.admin() ? Generation.Source.DEMO : Generation.Source.USER,
                caller.uid(), now));
        long started = System.nanoTime();
        AtomicReference<MeteredModelClient.Reservation> reservation = new AtomicReference<>();
        MeteredModelClient.ChargeListener listener = new MeteredModelClient.ChargeListener() {
            @Override
            public void charged(MeteredModelClient.Reservation r) {
                reservation.set(r);
            }

            @Override
            public void failed(Throwable error) {
                log.error("agent {} call {}: the meter failed", turnId, n, error);
            }
        };

        MeteredModelClient.Metered metered;
        try {
            metered = models.charge(ROLE, messages, new MeteredModelClient.CallOptions(null, responseFormat, safetyId(caller.uid())),
                    "agent " + id, listener).block();
        } catch (ForgeException e) {
            boolean refused = e.code() == ErrorCode.BUDGET || e.code() == ErrorCode.PAUSED;
            finish(id, null, null, null, 0, started, refused ? Generation.Status.DENIED : Generation.Status.ERROR);
            throw new AgentCallFailure(e.code().code(), e.getMessage());
        } catch (RuntimeException e) {
            finish(id, null, null, null, 0, started, Generation.Status.ERROR);
            log.error("agent {} call {} failed before the call", turnId, n, e);
            throw new AgentCallFailure(ErrorCode.INTERNAL.code(), "Something went wrong on our side.");
        }
        long chargedMicroUsd = metered.chargedMicroUsd();
        if (cancelled.get()) {
            finish(id, null, null, null, chargedMicroUsd, started, Generation.Status.CANCELLED);
            throw new AgentCallFailure("cancelled", "the client left");
        }
        charged.run();

        StringBuilder text = new StringBuilder();
        AtomicReference<String> finishReason = new AtomicReference<>();
        AtomicReference<ChatChunk.Usage> usage = new AtomicReference<>();
        AtomicReference<Long> ttft = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Disposable subscription = metered.chunks().subscribe(chunk -> {
            if (!chunk.text().isEmpty()) {
                ttft.compareAndSet(null, (System.nanoTime() - started) / 1_000_000);
                text.append(chunk.text());
            }
            if (chunk.finishReason() != null) {
                finishReason.set(chunk.finishReason());
            }
            if (chunk.usage() != null) {
                usage.set(chunk.usage());
            }
        }, failure -> {
            error.set(failure);
            done.countDown();
        }, done::countDown);
        pending.set(new Pending(subscription, done));
        if (cancelled.get()) {
            subscription.dispose();
            done.countDown();
        }
        // The wait ends at the role's deadline or the turn's, whichever comes first (gate A).
        long roleWait = role.timeout().plus(MARGIN).toMillis();
        long turnWait = Math.max(0, (deadline - System.nanoTime()) / 1_000_000);
        boolean outOfTurn = false;
        try {
            if (!done.await(Math.min(roleWait, turnWait), TimeUnit.MILLISECONDS)) {
                subscription.dispose();
                outOfTurn = turnWait < roleWait;
                error.compareAndSet(null, new UpstreamException(UpstreamException.Kind.TIMEOUT, 0, "the call outlived its deadline"));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            subscription.dispose();
            cancelled.set(true);
        } finally {
            pending.set(null);
        }

        ChatChunk.Usage u = usage.get();
        Long cost = u == null ? null : catalog.costMicroUsd(role.model(), u);
        if (cancelled.get()) {
            finish(id, text.toString(), u, cost, chargedMicroUsd, started, Generation.Status.CANCELLED, ttft.get());
            throw new AgentCallFailure("cancelled", "the client left");
        }
        if (outOfTurn) {
            finish(id, text.toString(), u, cost, chargedMicroUsd, started, Generation.Status.TIMEOUT, ttft.get());
            log.warn("agent {} call {} outlived the turn's deadline", turnId, n);
            throw new AgentCallFailure("deadline", "the turn's time ran out during call " + n);
        }
        Throwable failure = error.get();
        if (failure instanceof UpstreamException upstream) {
            finish(id, text.toString(), u, cost, chargedMicroUsd, started,
                    upstream.kind() == UpstreamException.Kind.TIMEOUT ? Generation.Status.TIMEOUT : Generation.Status.ERROR, ttft.get());
            log.warn("agent {} call {} {}: {}", turnId, n, upstream.errorCode().code(), upstream.describe());
            throw new AgentCallFailure(upstream.errorCode().code(), upstream.publicMessage());
        }
        if (failure instanceof ForgeException forge) {
            finish(id, text.toString(), u, cost, chargedMicroUsd, started, Generation.Status.ERROR, ttft.get());
            throw new AgentCallFailure(forge.code().code(), forge.getMessage());
        }
        if (failure != null) {
            finish(id, text.toString(), u, cost, chargedMicroUsd, started, Generation.Status.ERROR, ttft.get());
            log.error("agent {} call {} failed", turnId, n, failure);
            throw new AgentCallFailure(ErrorCode.INTERNAL.code(), "Something went wrong on our side.");
        }
        finish(id, text.toString(), u, cost, chargedMicroUsd, started, Generation.Status.OK, ttft.get());
        // A stream without usage keeps its whole reservation (Q43), so the turn counts that against its money.
        return new ModelAnswer(id, text.toString(), finishReason.get(), u == null ? null : u.promptTokens(),
                u == null ? null : u.completionTokens(), u == null ? null : u.reasoningTokens(), u == null ? null : u.cachedTokens(),
                cost == null ? chargedMicroUsd : cost);
    }

    /** The client left: no later call starts, and the one in flight is disposed and its waiter released. */
    void cancel() {
        cancelled.set(true);
        Pending p = pending.get();
        if (p != null) {
            p.subscription().dispose();
            p.done().countDown();
        }
    }

    private void finish(String id, String text, ChatChunk.Usage u, Long cost, long charged, long started, Generation.Status status) {
        finish(id, text, u, cost, charged, started, status, null);
    }

    private void finish(String id, String text, ChatChunk.Usage u, Long cost, long charged, long started, Generation.Status status,
                        Long ttft) {
        long elapsed = (System.nanoTime() - started) / 1_000_000;
        store.finish(id, new Generation.Finish(text, u == null ? null : u.promptTokens(), u == null ? null : u.completionTokens(),
                u == null ? null : u.reasoningTokens(), charged, cost, ttft, elapsed, status));
        log.info("AGENT {} call of turn {} {}: {} ms; tokens in {}, out {} (reasoning {}); cost {} of {} micro-USD reserved",
                id, turnId, status, elapsed, u == null ? "-" : u.promptTokens(), u == null ? "-" : u.completionTokens(),
                u == null || u.reasoningTokens() == null ? "-" : u.reasoningTokens(), cost == null ? "-" : cost, charged);
    }

    /** The caller as Meta's abuse checks see them: a hash, never the uid (as the loop's routes send it). */
    static String safetyId(String uid) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(uid.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }
}
