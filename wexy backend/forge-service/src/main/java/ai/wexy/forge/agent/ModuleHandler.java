package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.allowance.PromptAdmission;
import ai.wexy.forge.allowance.Role;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.GenerationStore;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.sse.SseEncoder;
import ai.wexy.forge.templates.CodeBlocks;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.MeteredModelClient;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * {@code POST /v1/agent/module} (the frontend's candidate-loop design §5, §6; EA4.2, Q78 (a)): one module's body, written
 * or repaired in one metered call, streamed as h1's author streams a function.
 *
 * <p>In order: the request is checked whole ({@link ModuleRequest}: 413 or 400, before anything); the turn must be the
 * caller's (one of its calls is the caller's own record, else 404: no caller attaches usage to somebody else's turn);
 * the assembled prompt must fit {@link #MAX_PROMPT_BYTES}; the call must run inside the turn's granted prompt, carrying
 * that prompt's text, with the grant alive and a module call left ({@link PromptAdmission#module}: 404, or 429 when
 * spent; W1's review, so no module call carries new, unchecked text); then the call becomes a generation of kind {@code AGENT}
 * under the turn, RUNNING before it is charged; {@link MeteredModelClient#charge} reserves its bound, and a refusal is
 * an envelope ({@code 503 budget} or {@code paused}) with nothing sent upstream. The stream is {@code meta}, which
 * echoes the job, its subject, the versions, the module and its interfaceHash; the model's text as {@code delta}s;
 * {@code usage}, apart from success; and exactly one {@code done} or {@code error}. {@code done} names the answer's
 * hash and length, so the browser installs nothing but the whole text it hashed itself; a cut, empty or oversized
 * answer, or one without an entry, ends in {@code error}. A client that leaves cancels the call upstream.
 *
 * <p>The candidate's budget (Q84) is the browser's to keep; the meter's reservations and the daily caps bound money
 * here, as for every call.
 */
@Component
public class ModuleHandler {

    /** The role every module call uses: its own model, cap and deadline, apart from the turn's. */
    public static final String ROLE = "module";
    /** A module call's prompt, at most: one token a byte, so its reservation stays known, as a turn's prompt does. */
    static final int MAX_PROMPT_BYTES = 196_608;

    private static final Logger log = LoggerFactory.getLogger(ModuleHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final PromptBuilder prompts;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final GenerationStore store;
    private final LoopProperties loop;
    private final EngineBundle bundle;
    private final JsonSchemas schemas;
    private final NodeCheck nodes;
    private final PromptAdmission admission;

    public ModuleHandler(PromptBuilder prompts, MeteredModelClient models, ModelCatalog catalog, GenerationStore store, LoopProperties loop,
                         EngineBundle bundle, AdapterManifest manifest, JsonSchemas schemas, PromptAdmission admission) {
        this.admission = admission;
        this.prompts = prompts;
        this.models = models;
        this.catalog = catalog;
        this.store = store;
        this.loop = loop;
        this.bundle = bundle;
        this.schemas = schemas;
        this.nodes = new NodeCheck(manifest, bundle);
        catalog.role(ROLE);
    }

    public Mono<ServerResponse> module(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(String.class)
                .switchIfEmpty(Mono.error(() -> new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a body.")))
                .flatMap(text -> {
                    ModuleRequest m = ModuleRequest.validated(text, loop.caps(), bundle.bundleHash(), schemas, nodes);
                    // The turn is the caller's: one of its calls is the caller's own record. A turn this service has
                    // forgotten (a restart, or past the store's time) is as unknown as another's.
                    boolean owned = store.children(m.turnId()).stream().anyMatch(g -> g.kind() == Generation.Kind.AGENT
                            && MeteredModelCaller.ROLE.equals(g.role()) && g.uid().equals(caller.uid()));
                    if (!owned) {
                        throw new ForgeException(ErrorCode.NOT_FOUND, "This turn isn't available.");
                    }
                    Prompt prompt = prompt(m);
                    long bytes = prompt.messages().stream().mapToLong(message -> ModuleRequest.utf8(message.content())).sum();
                    if (bytes > MAX_PROMPT_BYTES) {
                        throw new ForgeException(ErrorCode.TOO_LARGE, "This module's prompt would be " + bytes + " bytes; at most " + MAX_PROMPT_BYTES
                                + ". Send fewer or smaller nodes.");
                    }
                    // Inside the turn's granted prompt, off the event loop (Redis), before any record or charge.
                    return Mono.fromCallable(() -> {
                                admission.module(caller, m.turnId(), m.request().prompt());
                                return Boolean.TRUE;
                            })
                            .subscribeOn(Schedulers.boundedElastic())
                            .flatMap(admitted -> stream(m, prompt, caller));
                });
    }

    /** The prompt from R, S, the module's nodes and interface, and for a repair its previous body and findings (P7). */
    private Prompt prompt(ModuleRequest m) {
        ObjectNode r = JSON.createObjectNode().put("prompt", m.request().prompt()).put("style", m.request().style()).put("seconds", m.request().seconds());
        List<String> lines = new ArrayList<>();
        m.nodes().forEach(n -> lines.add(n.toString()));
        List<String> signatures = new ArrayList<>();
        m.iface().path("entries").forEach(e -> signatures.add(e.path("signature").asText()));
        List<PromptBuilder.Finding> findings = new ArrayList<>();
        if (m.previous() != null) {
            for (JsonNode f : m.previous().findings()) {
                findings.add(new PromptBuilder.Finding(f.path("code").asText(), f.path("line").isInt() ? f.path("line").asInt() : null,
                        f.path("message").asText()));
            }
        }
        return prompts.module(r.toString(), m.design().toString(), m.module(), m.kind(), lines, m.iface().path("preamble").asText(),
                m.iface().path("epilogue").asText(), signatures, m.previous() == null ? null : m.previous().body(), findings);
    }

    private Mono<ServerResponse> stream(ModuleRequest m, Prompt prompt, Caller caller) {
        Call call = begin(m, prompt, caller);
        return charge(call, caller)
                .flatMap(metered -> ServerResponse.ok()
                        .contentType(MediaType.TEXT_EVENT_STREAM)
                        .header(HttpHeaders.CACHE_CONTROL, "no-store")
                        .header("X-Accel-Buffering", "no")
                        .body(BodyInserters.fromServerSentEvents(SseEncoder.heartbeats(events(call, metered), loop.heartbeat()))))
                .doOnCancel(call::cancelled);
    }

    private Call begin(ModuleRequest m, Prompt prompt, Caller caller) {
        Instant now = Instant.now();
        // The record's input is the call's ids and hashes, never the prompt, R or code (coding principles §11).
        ObjectNode input = JSON.createObjectNode().put("turnId", m.turnId()).put("jobId", m.jobId()).put("purpose", m.purpose())
                .put("module", m.module()).put("interfaceHash", m.iface().path("interfaceHash").asText());
        input.put("previousCodeHash", m.previous() == null ? null : m.previous().codeHash());
        Generation g = store.begin(Generation.started(Ulid.next(now), Generation.Kind.AGENT, m.turnId(), ROLE, catalog.role(ROLE).model(),
                prompt.templateId(), ModuleRequest.ABI, m.module(), input.toString(), caller.admin() ? Generation.Source.DEMO : Generation.Source.USER,
                caller.uid(), now));
        return new Call(g, prompt, m);
    }

    /** The charge: a refusal finishes the record as DENIED, a fault before the call as ERROR, before the envelope goes out. */
    private Mono<MeteredModelClient.Metered> charge(Call call, Caller caller) {
        return Mono.defer(() -> models.charge(ROLE, call.prompt.messages(), new MeteredModelClient.CallOptions(null, null,
                        MeteredModelCaller.safetyId(caller.uid()), Role.of(caller).lane()), "module " + call.g.id(), call))
                .onErrorResume(error -> {
                    boolean refused = error instanceof ForgeException f && (f.code() == ErrorCode.BUDGET || f.code() == ErrorCode.PAUSED);
                    call.finish(refused ? Generation.Status.DENIED : Generation.Status.ERROR);
                    log.info("MODULE {} {}: {}", call.g.id(), refused ? "denied" : "failed before the call",
                            error instanceof ForgeException f ? f.code().code() : error.getClass().getSimpleName());
                    return Mono.error(error);
                });
    }

    /** The events of one paid call, which finish its generation exactly once. */
    private Flux<ServerSentEvent<String>> events(Call call, MeteredModelClient.Metered metered) {
        return Flux.defer(() -> {
            Flux<ServerSentEvent<String>> body = metered.chunks().concatMapIterable(chunk -> {
                List<ServerSentEvent<String>> out = new ArrayList<>(2);
                if (!chunk.text().isEmpty()) {
                    call.ttft.compareAndSet(-1, call.elapsedMs());
                    call.text.append(chunk.text());
                    out.add(encode("delta", Map.of("text", chunk.text())));
                }
                if (chunk.finishReason() != null) {
                    call.finishReason.set(chunk.finishReason());
                }
                if (chunk.usage() != null) {
                    ChatChunk.Usage u = chunk.usage();
                    call.usage.set(u);
                    Map<String, Object> usage = new LinkedHashMap<>();
                    usage.put("in", u.promptTokens());
                    usage.put("out", u.completionTokens());
                    usage.put("reasoning", u.reasoningTokens());
                    usage.put("cached", u.cachedTokens());
                    usage.put("costMicroUsd", catalog.costMicroUsd(metered.model(), u));
                    out.add(encode("usage", usage));
                }
                return out;
            });
            Mono<ServerSentEvent<String>> terminal = Mono.fromSupplier(() -> terminal(call, metered));
            return Flux.concat(Mono.just(encode("meta", meta(call, metered))), body, terminal)
                    .onErrorResume(error -> Mono.just(failure(call, error)))
                    .doFinally(signal -> call.finish(signal == SignalType.CANCEL ? Generation.Status.CANCELLED : Generation.Status.ERROR));
        });
    }

    /** What the call is, echoed so the browser can refuse a stream that answers another job (§5). */
    private Map<String, Object> meta(Call call, MeteredModelClient.Metered metered) {
        ModuleRequest m = call.request;
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("generationId", call.g.id());
        meta.put("turnId", m.turnId());
        meta.put("jobId", m.jobId());
        meta.put("purpose", m.purpose());
        meta.put("subject", m.subject());
        meta.put("versions", m.versions());
        meta.put("module", m.module());
        meta.put("interfaceHash", m.iface().path("interfaceHash").asText());
        meta.put("model", metered.model());
        meta.put("source", "live");
        meta.put("role", ROLE);
        meta.put("promptVersion", call.g.promptVersion());
        return meta;
    }

    /** The last event: the answer, judged as far as the server can; the browser's checks decide the rest. */
    private ServerSentEvent<String> terminal(Call call, MeteredModelClient.Metered metered) {
        String finish = call.finishReason.get();
        if ("length".equals(finish)) {
            log.warn("MODULE {} truncated at cap {}", call.g.id(), metered.maxOutputTokens());
            call.finish(Generation.Status.ERROR);
            return encode("error", error(ErrorCode.UPSTREAM, "The model ran out of room writing this part. Try a simpler world."));
        }
        if (finish != null && !"stop".equals(finish)) {
            return unusable(call, "finish_reason " + finish, "content_filter".equals(finish) ? "The model declined to write this part." : "The model didn't answer.");
        }
        String body = CodeBlocks.unfence(call.text.toString());
        if (body.isBlank()) {
            return unusable(call, "no text", "The model wrote nothing for this part.");
        }
        if (body.length() > ModuleRequest.MAX_BODY_CHARS) {
            return unusable(call, body.length() + " characters", "The model wrote too much for this part.");
        }
        for (String entry : call.request.entries()) {
            if (!defines(body, entry)) {
                return unusable(call, "no fn " + entry + " line", "The model didn't write this part's functions.");
            }
        }
        call.finish(Generation.Status.OK);
        Map<String, Object> done = new LinkedHashMap<>();
        done.put("status", "ok");
        // The text the browser assembles from the deltas and unfences must be this one, or it installs nothing (§5).
        done.put("answerSha256", ModuleRequest.sha256(body));
        done.put("answerChars", body.length());
        return encode("done", done);
    }

    private ServerSentEvent<String> unusable(Call call, String why, String message) {
        log.warn("MODULE {} unusable: {}; finish_reason {}, usage {}, {} ms", call.g.id(), why, call.finishReason.get(),
                call.usage.get() == null ? "absent" : "present", call.elapsedMs());
        call.finish(Generation.Status.ERROR);
        return encode("error", error(ErrorCode.UPSTREAM, message));
    }

    private static ServerSentEvent<String> failure(Call call, Throwable error) {
        if (error instanceof UpstreamException upstream) {
            log.warn("MODULE {} {}: {}", call.g.id(), upstream.errorCode().code(), upstream.describe());
            call.finish(upstream.kind() == UpstreamException.Kind.TIMEOUT ? Generation.Status.TIMEOUT : Generation.Status.ERROR);
            return encode("error", error(upstream.errorCode(), upstream.publicMessage()));
        }
        if (error instanceof ForgeException forge) {
            call.finish(Generation.Status.ERROR);
            return encode("error", error(forge.code(), forge.getMessage()));
        }
        log.error("MODULE {} failed", call.g.id(), error);
        call.finish(Generation.Status.ERROR);
        return encode("error", error(ErrorCode.INTERNAL, "Something went wrong on our side."));
    }

    private static Map<String, Object> error(ErrorCode code, String message) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("code", code.code());
        data.put("message", message);
        return data;
    }

    private static ServerSentEvent<String> encode(String name, Object data) {
        try {
            return ServerSentEvent.<String>builder().event(name).data(JSON.writeValueAsString(data)).build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("An event always serializes", e);
        }
    }

    /**
     * One call's lifecycle, from {@code begin} to its single finish, as the loop's own calls keep theirs
     * ({@code LoopHandler}): what the model has said, what the meter decided, and whether the client is still there. A
     * cancel before the meter answered waits for its answer, then records CANCELLED with the reservation, or DENIED;
     * {@code finished} lets only the first finish count.
     */
    private final class Call implements MeteredModelClient.ChargeListener {

        private final Generation g;
        private final Prompt prompt;
        private final ModuleRequest request;
        private final long started = System.nanoTime();
        private final StringBuilder text = new StringBuilder();
        private final AtomicLong ttft = new AtomicLong(-1);
        private final AtomicReference<ChatChunk.Usage> usage = new AtomicReference<>();
        private final AtomicReference<String> finishReason = new AtomicReference<>();
        private final AtomicReference<MeteredModelClient.Reservation> reservation = new AtomicReference<>();
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final AtomicBoolean finished = new AtomicBoolean();

        Call(Generation g, Prompt prompt, ModuleRequest request) {
            this.g = g;
            this.prompt = prompt;
            this.request = request;
        }

        long elapsedMs() {
            return (System.nanoTime() - started) / 1_000_000;
        }

        @Override
        public void charged(MeteredModelClient.Reservation r) {
            reservation.set(r);
            if (cancelled.get()) {
                finishAfterCancel(r);
            }
        }

        @Override
        public void failed(Throwable error) {
            if (cancelled.get() && !finished.get()) {
                log.error("MODULE {} failed at the meter after the client had gone", g.id(), error);
            }
            finish(Generation.Status.ERROR);
        }

        void cancelled() {
            cancelled.set(true);
            MeteredModelClient.Reservation r = reservation.get();
            if (r != null) {
                finishAfterCancel(r);
            }
        }

        private void finishAfterCancel(MeteredModelClient.Reservation r) {
            finish(r.allowed() ? Generation.Status.CANCELLED : Generation.Status.DENIED);
        }

        void finish(Generation.Status status) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            if (status == Generation.Status.DENIED) {
                store.finish(g.id(), new Generation.Finish(null, null, null, null, 0, null, null, null, Generation.Status.DENIED));
                return;
            }
            long elapsed = elapsedMs();
            ChatChunk.Usage u = usage.get();
            MeteredModelClient.Reservation r = reservation.get();
            long charged = r != null && r.allowed() ? r.microUsd() : 0;
            Long cost = u == null ? null : catalog.costMicroUsd(g.model(), u);
            Long first = ttft.get() < 0 ? null : ttft.get();
            store.finish(g.id(), new Generation.Finish(text.toString(), u == null ? null : u.promptTokens(), u == null ? null : u.completionTokens(),
                    u == null ? null : u.reasoningTokens(), charged, cost, first, elapsed, status));
            log.info("MODULE {} {} turn={} module={} purpose={}: {} ms (first text {} ms); tokens in {}, out {} (reasoning {}); cost {} of {} micro-USD reserved",
                    g.id(), status, request.turnId(), request.module(), request.purpose(), elapsed, first == null ? "-" : first,
                    u == null ? "-" : u.promptTokens(), u == null ? "-" : u.completionTokens(),
                    u == null || u.reasoningTokens() == null ? "-" : u.reasoningTokens(), cost == null ? "-" : cost, charged);
        }
    }

    /**
     * Whether a body declares {@code fn <entry>(} as tokens, outside its comments, wherever on a line: WGSL does not ask
     * a function to start one, and the browser's checker does not (`bodies.ts`). Only presence is judged here; the
     * body's whole check is the browser's (the candidate-loop design §7).
     */
    static boolean defines(String body, String entry) {
        return Pattern.compile("(?<![A-Za-z0-9_])fn\\s+" + Pattern.quote(entry) + "\\s*\\(").matcher(uncommented(body)).find();
    }

    /** The body with its comments blanked: line comments, and block comments, which nest in WGSL. */
    static String uncommented(String body) {
        StringBuilder out = new StringBuilder(body.length());
        int depth = 0;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            char next = i + 1 < body.length() ? body.charAt(i + 1) : '\0';
            if (c == '/' && next == '*') {
                depth++;
                out.append("  ");
                i++;
            } else if (depth > 0 && c == '*' && next == '/') {
                depth--;
                out.append("  ");
                i++;
            } else if (depth > 0) {
                out.append(c == '\n' ? '\n' : ' ');
            } else if (c == '/' && next == '/') {
                while (i < body.length() && body.charAt(i) != '\n') {
                    out.append(' ');
                    i++;
                }
                if (i < body.length()) {
                    out.append('\n');
                }
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }
}
