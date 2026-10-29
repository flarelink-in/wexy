package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.GenerationStore;
import ai.wexy.forge.records.Outcome;
import ai.wexy.forge.records.OutcomeStore;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.sse.SseEncoder;
import ai.wexy.forge.sse.SseEvent;
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
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * The loop's endpoints (forge-loop design §5.1, §7, §10): {@code plan}, {@code author},
 * {@code repair} and {@code direct} call a model; {@code outcomes} records what a browser found.
 *
 * <p>Each model call, in order:
 * <ol>
 *   <li>the request is checked against its caps: 413 or 400, before anything else;</li>
 *   <li>the call becomes a generation, RUNNING, before it is charged (I5);</li>
 *   <li>{@link MeteredModelClient#charge} charges the role's upper bound, off the event loop. A
 *       refusal is an HTTP envelope (503 {@code budget} or {@code paused}), the response not yet
 *       committed, and the record says DENIED (I1, P1);</li>
 *   <li>the paid stream goes out as {@code meta}, {@code delta}…, {@code usage}, then exactly one
 *       {@code done} or {@code error} (I3), with a heartbeat while the model is quiet; {@code direct}
 *       collects the same events and answers one JSON document instead;</li>
 *   <li>the record is finished exactly once ({@link Call}): OK, ERROR, TIMEOUT, or CANCELLED when
 *       the client goes away, which also cancels the upstream request (I7). A client that goes away
 *       while the meter is still deciding is handled too: the meter's answer reaches the record
 *       through the charge listener, so a reservation that was made is recorded as made.</li>
 * </ol>
 *
 * <p>An answer is judged before {@code done}: a plan or an edit must parse and match its schema
 * (and a draft must pass {@link DraftChecks}); a function must not be blank and must contain its
 * {@code fn} line; a {@code length} finish is unusable, and so is one the model declined. Each of
 * those ends in {@code error}, never {@code done}, is counted ({@code wexy.loop.truncated},
 * {@code wexy.loop.unusable}) and is not retried here (the studio retries once, §16). Logs carry
 * ids, codes and numbers, never the prompt or the answer (coding principles §11).
 */
@Component
public class LoopHandler {

    /** Repairs of one function before the next is refused (forge-loop design §5.1). */
    static final int MAX_REPAIRS = 3;

    private static final Logger log = LoggerFactory.getLogger(LoopHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    /** The most generations a repair chain is followed back through to its plan. */
    private static final int MAX_CHAIN = 16;
    private static final List<String> ROLES = List.of("planner", "author", "repairer", "escalator", "director");

    private final PromptBuilder prompts;
    private final MeteredModelClient models;
    private final GenerationStore store;
    private final OutcomeStore outcomes;
    private final JsonSchemas schemas;
    private final ModelCatalog catalog;
    private final LoopProperties loop;
    private final MeterRegistry meters;

    public LoopHandler(PromptBuilder prompts, MeteredModelClient models, GenerationStore store, OutcomeStore outcomes,
                       JsonSchemas schemas, ModelCatalog catalog, LoopProperties loop, MeterRegistry meters) {
        this.prompts = prompts;
        this.models = models;
        this.store = store;
        this.outcomes = outcomes;
        this.schemas = schemas;
        this.catalog = catalog;
        this.loop = loop;
        this.meters = meters;
        for (String role : ROLES) {
            catalog.role(role);
        }
        // The template decides the answer's shape; a role configured for another would be a silent lie.
        expectSchema("planner", JsonSchemas.SCENE_DRAFT);
        expectSchema("director", JsonSchemas.EDIT_PLAN);
    }

    private void expectSchema(String role, String schema) {
        String configured = catalog.role(role).response();
        if (configured != null && !configured.equals(schema)) {
            throw new IllegalStateException("wexy.roles." + role + ".response is '" + configured + "', but the " + role
                    + "'s template answers " + schema + ".");
        }
    }

    public Mono<ServerResponse> plan(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(PlanRequest.class)
                .switchIfEmpty(noBody())
                .flatMap(body -> {
                    PlanRequest plan = body.validated(loop.caps());
                    Prompt prompt = prompts.plan(plan.prompt(), plan.style(), plan.seconds());
                    return stream(Generation.Kind.PLAN, null, null, "planner", prompt, json(plan), caller);
                });
    }

    public Mono<ServerResponse> author(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(AuthorRequest.class)
                .switchIfEmpty(noBody())
                .flatMap(body -> {
                    AuthorRequest author = body.validated();
                    Generation plan = store.find(author.planId())
                            .filter(g -> g.kind() == Generation.Kind.PLAN && g.status() == Generation.Status.OK)
                            .filter(g -> g.uid().equals(caller.uid()))
                            .orElseThrow(LoopHandler::unknownWorld);
                    JsonNode draft = read(plan.output());
                    if ("sky".equals(author.fn()) && "black".equals(draft.path("sky").asText())) {
                        throw new ForgeException(ErrorCode.BAD_REQUEST, "This world's sky is black: it has no sky function.");
                    }
                    String idea = read(plan.input()).path("prompt").asText();
                    Prompt prompt = prompts.author(author.fn(), idea, draft);
                    return stream(Generation.Kind.AUTHOR, plan.id(), author.fn(), "author", prompt, json(author), caller);
                });
    }

    /**
     * A repair of a function the caller's own author or repair call wrote (§5.1): the function's
     * text comes from the store, the findings from the browser. The role is the server's choice:
     * the repairer for the first two repairs of a chain, the escalator for the third; a fourth is
     * refused. A failed repair does not count, so the studio may try it again.
     */
    public Mono<ServerResponse> repair(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(RepairRequest.class)
                .switchIfEmpty(noBody())
                .flatMap(body -> {
                    RepairRequest repair = body.validated(loop.caps());
                    Generation parent = store.find(repair.generationId())
                            .filter(g -> g.kind() == Generation.Kind.AUTHOR || g.kind() == Generation.Kind.REPAIR)
                            .filter(g -> g.status() == Generation.Status.OK)
                            .filter(g -> g.uid().equals(caller.uid()))
                            .orElseThrow(LoopHandler::unknownWorld);
                    int depth = store.okRepairDepth(parent.id());
                    if (depth >= MAX_REPAIRS) {
                        log.info("repair refused: depth {} for {}", depth, parent.id());
                        throw new ForgeException(ErrorCode.BAD_REQUEST, "This function has been repaired three times already.");
                    }
                    String role = depth < MAX_REPAIRS - 1 ? "repairer" : "escalator";
                    JsonNode draft = read(planOf(parent).orElseThrow(LoopHandler::unknownWorld).output());
                    Prompt prompt = prompts.repair(parent.fn(), draft, CodeBlocks.unfence(parent.output()), repair.diagnostics(), depth + 1);
                    return stream(Generation.Kind.REPAIR, parent.id(), parent.fn(), role, prompt, json(repair), caller);
                });
    }

    /** The director's answer to one instruction about a running world: one JSON document, not a stream (§10). */
    public Mono<ServerResponse> direct(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(DirectRequest.class)
                .switchIfEmpty(noBody())
                .flatMap(body -> {
                    DirectRequest direct = body.validated(loop.caps());
                    Prompt prompt = prompts.direct(direct.spec(), direct.turn());
                    String input = JSON.createObjectNode().put("turn", direct.turn())
                            .put("specSha256", sha256(direct.spec().toString())).toString();
                    return answer("director", prompt, input, caller);
                });
    }

    /**
     * {@code GET /v1/forge/mode}, a public read (records design §5.3): {@code live} until B4 adds the archive and
     * its reason. Served ahead of B1.2 because the frontend's drives check readiness with it where the actuator is
     * private (its pass-graph design, F8).
     */
    public Mono<ServerResponse> mode(ServerRequest request) {
        return ServerResponse.ok().contentType(MediaType.APPLICATION_JSON).bodyValue("{\"mode\":\"live\",\"reason\":null}");
    }

    /** What a browser found when it verified and ran the caller's own generations: stored, 202. */
    public Mono<ServerResponse> outcomes(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(OutcomeRequest.class)
                .switchIfEmpty(noBody())
                .flatMap(body -> {
                    OutcomeRequest report = body.validated(loop.caps());
                    for (String id : report.generationIds()) {
                        store.find(id).filter(g -> g.uid().equals(caller.uid())).orElseThrow(LoopHandler::unknownWorld);
                    }
                    Instant now = Instant.now();
                    Outcome outcome = new Outcome(Ulid.next(now), report.generationIds(), caller.uid(), report.ladder().toString(),
                            report.firstPassOk(), report.repairs(), report.autofixes(), report.probeMs(), report.predictedMs(),
                            report.fps(), report.adapter(), report.browser(), now);
                    outcomes.record(outcome);
                    log.info("outcome {} recorded for {} generations: first pass {}, repairs {}, autofixes {}, fps {}",
                            outcome.id(), outcome.generationIds().size(), outcome.firstPassOk(), outcome.repairs(),
                            outcome.autofixes(), outcome.fps() == null ? "-" : outcome.fps());
                    return ServerResponse.accepted().contentType(MediaType.APPLICATION_JSON).bodyValue("{}");
                });
    }

    static ForgeException unknownWorld() {
        return new ForgeException(ErrorCode.NOT_FOUND, "This world isn't available.");
    }

    private static <T> Mono<T> noBody() {
        return Mono.error(() -> new ForgeException(ErrorCode.BAD_REQUEST, "The request has no body."));
    }

    /** The plan a function was written for, up its chain of repairs. */
    private Optional<Generation> planOf(Generation g) {
        Generation current = g;
        for (int hops = 0; current != null && hops < MAX_CHAIN; hops++) {
            if (current.kind() == Generation.Kind.PLAN) {
                return Optional.of(current);
            }
            current = current.parentId() == null ? null : store.find(current.parentId()).orElse(null);
        }
        return Optional.empty();
    }

    /** A streamed call: the charge, then the events as text/event-stream. */
    private Mono<ServerResponse> stream(Generation.Kind kind, String parentId, String fn, String role, Prompt prompt,
                                        String input, Caller caller) {
        Call call = begin(kind, parentId, fn, role, prompt, input, caller);
        return charge(call, caller)
                .flatMap(metered -> ServerResponse.ok()
                        .contentType(MediaType.TEXT_EVENT_STREAM)
                        .header(HttpHeaders.CACHE_CONTROL, "no-store")
                        .header("X-Accel-Buffering", "no")
                        .body(BodyInserters.fromServerSentEvents(
                                SseEncoder.withHeartbeat(events(call, metered), loop.heartbeat()))))
                .doOnCancel(call::cancelled);
    }

    /**
     * A call answered as one JSON document: the charge, the whole answer collected and judged as a
     * stream's would be, then {@code 200} with the document, or the terminal error as an envelope.
     */
    private Mono<ServerResponse> answer(String role, Prompt prompt, String input, Caller caller) {
        Call call = begin(Generation.Kind.DIRECT, null, null, role, prompt, input, caller);
        return charge(call, caller)
                .flatMap(metered -> events(call, metered).last().flatMap(terminal -> switch (terminal) {
                    case SseEvent.Done ignored -> ServerResponse.ok()
                            .contentType(MediaType.APPLICATION_JSON)
                            .header(HttpHeaders.CACHE_CONTROL, "no-store")
                            .bodyValue(document(call, metered));
                    case SseEvent.Error error -> Mono.<ServerResponse>error(
                            new ForgeException(ErrorCode.fromCode(error.code()), error.message()));
                    default -> Mono.<ServerResponse>error(new IllegalStateException("A stream ends in done or error, not " + terminal));
                }))
                .doOnCancel(call::cancelled);
    }

    private Call begin(Generation.Kind kind, String parentId, String fn, String role, Prompt prompt, String input, Caller caller) {
        Instant now = Instant.now();
        String id = Ulid.next(now);
        Generation g = store.begin(Generation.started(id, kind, parentId, role, catalog.role(role).model(),
                prompt.templateId(), prompt.hostVersion(), fn, input, source(caller), caller.uid(), now));
        return new Call(g, prompt);
    }

    /**
     * The charge: a refusal finishes the record as DENIED, a fault before the call as ERROR, either
     * way before the envelope goes out. The listener keeps the record honest when the client has
     * gone before the meter answered.
     */
    private Mono<MeteredModelClient.Metered> charge(Call call, Caller caller) {
        return Mono.defer(() -> {
                    MeteredModelClient.CallOptions options = new MeteredModelClient.CallOptions(null,
                            responseFormat(call.prompt), safetyId(caller));
                    return models.charge(call.g.role(), call.prompt.messages(), options, call.detail(), call);
                })
                .onErrorResume(error -> {
                    boolean refused = error instanceof ForgeException f
                            && (f.code() == ErrorCode.BUDGET || f.code() == ErrorCode.PAUSED);
                    call.finish(refused ? Generation.Status.DENIED : Generation.Status.ERROR);
                    log.info("{} {} {}: {}", call.g.kind(), call.g.id(), refused ? "denied" : "failed before the call",
                            error instanceof ForgeException f ? f.code().code() : error.getClass().getSimpleName());
                    return Mono.error(error);
                });
    }

    /** The events of one paid call, which finish its generation exactly once. */
    private Flux<SseEvent> events(Call call, MeteredModelClient.Metered metered) {
        return Flux.defer(() -> {
            Flux<SseEvent> body = metered.chunks().concatMapIterable(chunk -> {
                List<SseEvent> out = new ArrayList<>(2);
                if (!chunk.text().isEmpty()) {
                    call.ttft.compareAndSet(-1, call.elapsedMs());
                    call.text.append(chunk.text());
                    out.add(new SseEvent.Delta(chunk.text()));
                }
                if (chunk.finishReason() != null) {
                    call.finishReason.set(chunk.finishReason());
                }
                if (chunk.usage() != null) {
                    ChatChunk.Usage u = chunk.usage();
                    call.usage.set(u);
                    out.add(new SseEvent.Usage(u.promptTokens(), u.completionTokens(), u.reasoningTokens(), u.cachedTokens()));
                }
                return out;
            });
            Mono<SseEvent> terminal = Mono.fromSupplier(() -> terminal(call, metered));
            SseEvent meta = new SseEvent.Meta(call.g.id(), metered.model(), "live", call.g.role(), call.g.fn(), call.g.promptVersion());
            return Flux.concat(Mono.just(meta), body, terminal)
                    .onErrorResume(error -> Mono.just(failure(call, error)))
                    .doFinally(signal -> {
                        if (signal == SignalType.CANCEL && !call.finished.get()) {
                            log.info("{} {} cancelled after {} ms", call.g.kind(), call.g.id(), call.elapsedMs());
                        }
                        call.finish(signal == SignalType.CANCEL ? Generation.Status.CANCELLED : Generation.Status.ERROR);
                    });
        });
    }

    /** The last event: the answer, judged. */
    private SseEvent terminal(Call call, MeteredModelClient.Metered metered) {
        Generation g = call.g;
        String finish = call.finishReason.get();
        if ("length".equals(finish)) {
            meters.counter("wexy.loop.truncated", "role", g.role()).increment();
            ChatChunk.Usage u = call.usage.get();
            log.warn("{} {} truncated at cap {} (reasoning {})", g.kind(), g.id(), metered.maxOutputTokens(),
                    u == null ? "unknown" : u.reasoningTokens());
            call.finish(Generation.Status.ERROR);
            return new SseEvent.Error(ErrorCode.UPSTREAM.code(), "The model ran out of room. Try a simpler idea.");
        }
        if (finish != null && !"stop".equals(finish)) {
            // content_filter, tool_calls, function_call (§4.1): the model did not answer the question.
            boolean declined = "content_filter".equals(finish);
            return unusable(call, declined ? "declined" : "unanswered", "finish_reason " + finish,
                    declined ? "The model declined this idea. Try another." : "The model didn't answer.");
        }
        String schema = call.prompt.responseSchema();
        if (schema == null) {
            String function = CodeBlocks.unfence(call.text.toString());
            if (function.isBlank()) {
                return unusable(call, "empty", "no text", "The model answered nothing.");
            }
            if (!functionLine(g.fn()).matcher(function).find()) {
                return unusable(call, "no-function", "no fn " + g.fn() + " line", "The model didn't write the function.");
            }
        } else {
            List<String> problems = answerProblems(schema, call.text.toString(), call.answer);
            if (!problems.isEmpty()) {
                return unusable(call, "invalid", problems.get(0),
                        g.kind() == Generation.Kind.PLAN ? "The plan didn't come through." : "The edit didn't come through.");
            }
        }
        call.finish(Generation.Status.OK);
        return SseEvent.Done.ok();
    }

    private SseEvent unusable(Call call, String reason, String why, String message) {
        meters.counter("wexy.loop.unusable", "role", call.g.role(), "reason", reason).increment();
        // The facts that tell a cap from a refusal: Meta was seen (2026-10-28) to close a stream with no
        // finish_reason and no usage when max_completion_tokens ran out during reasoning.
        log.warn("{} {} unusable ({}): {}; finish_reason {}, usage {}, {} ms", call.g.kind(), call.g.id(), reason, why,
                call.finishReason.get(), call.usage.get() == null ? "absent" : "present", call.elapsedMs());
        call.finish(Generation.Status.ERROR);
        return new SseEvent.Error(ErrorCode.UPSTREAM.code(), message);
    }

    private static SseEvent failure(Call call, Throwable error) {
        Generation g = call.g;
        if (error instanceof UpstreamException upstream) {
            log.warn("{} {} {}: {}", g.kind(), g.id(), upstream.errorCode().code(), upstream.describe());
            call.finish(upstream.kind() == UpstreamException.Kind.TIMEOUT ? Generation.Status.TIMEOUT : Generation.Status.ERROR);
            return new SseEvent.Error(upstream.errorCode().code(), upstream.publicMessage());
        }
        if (error instanceof ForgeException forge) {
            call.finish(Generation.Status.ERROR);
            return new SseEvent.Error(forge.code().code(), forge.getMessage());
        }
        log.error("{} {} failed", g.kind(), g.id(), error);
        call.finish(Generation.Status.ERROR);
        return new SseEvent.Error(ErrorCode.INTERNAL.code(), "Something went wrong on our side.");
    }

    /** The {@code fn <name>(} line a function must contain, however the model spaced it. */
    private static Pattern functionLine(String fn) {
        return Pattern.compile("(?m)^\\s*fn\\s+" + Pattern.quote(fn) + "\\s*\\(");
    }

    /**
     * Why a JSON answer is not usable: not JSON, not an object, off its schema, or (a draft) with
     * unsound controls. A usable answer is handed back parsed.
     */
    List<String> answerProblems(String schema, String text, AtomicReference<JsonNode> parsed) {
        JsonNode answer;
        try {
            answer = JSON.readTree(text);
        } catch (JsonProcessingException e) {
            return List.of("not JSON at line " + e.getLocation().getLineNr() + ", column " + e.getLocation().getColumnNr());
        }
        if (answer == null || !answer.isObject()) {
            return List.of("not a JSON object");
        }
        List<String> problems = new ArrayList<>(schemas.validate(schema, answer));
        if (problems.isEmpty() && JsonSchemas.SCENE_DRAFT.equals(schema)) {
            problems.addAll(DraftChecks.problems(answer));
        }
        if (problems.isEmpty()) {
            parsed.set(answer);
        }
        return problems;
    }

    /** Why a planner's answer is not a usable draft: not JSON, off the schema, or unsound controls. */
    List<String> planProblems(String text) {
        return answerProblems(JsonSchemas.SCENE_DRAFT, text, new AtomicReference<>());
    }

    /**
     * The direct call's document (§10, B0.4): what a stream's {@code meta} and {@code usage} carry,
     * and the edit the director answered, as it was validated.
     */
    private static String document(Call call, MeteredModelClient.Metered metered) {
        ObjectNode doc = JSON.createObjectNode();
        doc.put("generationId", call.g.id()).put("model", metered.model()).put("source", "live")
                .put("role", call.g.role()).put("promptVersion", call.g.promptVersion());
        doc.set("edit", call.answer.get().path("edit"));
        ChatChunk.Usage u = call.usage.get();
        if (u != null) {
            ObjectNode usage = doc.putObject("usage").put("in", u.promptTokens()).put("out", u.completionTokens());
            if (u.reasoningTokens() != null) {
                usage.put("reasoning", u.reasoningTokens());
            }
            if (u.cachedTokens() != null) {
                usage.put("cached", u.cachedTokens());
            }
        }
        return doc.toString();
    }

    private Map<String, Object> responseFormat(Prompt prompt) {
        if (prompt.responseSchema() == null) {
            return null;
        }
        return Map.of("type", "json_schema", "json_schema", Map.of(
                "name", prompt.responseSchema().replace('.', '_').replace('-', '_'),
                "schema", schemas.schema(prompt.responseSchema()),
                "strict", loop.strictSchemas()));
    }

    /** The caller as Meta's abuse checks see them: a hash, never the uid (B1 uses an HMAC). */
    static String safetyId(Caller caller) {
        return sha256(caller.uid());
    }

    private static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }

    private static Generation.Source source(Caller caller) {
        return caller.admin() ? Generation.Source.DEMO : Generation.Source.USER;
    }

    private static String json(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("A request record always serializes", e);
        }
    }

    private static JsonNode read(String text) {
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("A stored generation is always valid JSON", e);
        }
    }

    /**
     * One generation's lifecycle, from {@code begin} to its single finish (I5): what the model has
     * said so far, what the meter decided, and whether the client is still there.
     *
     * <p>The meter answers on its own thread, and a client may cancel at any moment. The two races
     * that matter: a cancel before the meter answered waits for the answer, then records CANCELLED
     * with the reservation (the money is reserved, nothing streamed) or DENIED; an answer after a
     * cancel does the same. Whichever of the two comes second finishes the record, and
     * {@code finished} makes sure only the first finish of any kind counts. A meter that fails
     * outright finishes the record as ERROR, cancelled or not.
     */
    private final class Call implements MeteredModelClient.ChargeListener {

        private final Generation g;
        private final Prompt prompt;
        private final long started = System.nanoTime();
        private final StringBuilder text = new StringBuilder();
        private final AtomicLong ttft = new AtomicLong(-1);
        private final AtomicReference<ChatChunk.Usage> usage = new AtomicReference<>();
        private final AtomicReference<String> finishReason = new AtomicReference<>();
        private final AtomicReference<JsonNode> answer = new AtomicReference<>();
        private final AtomicReference<MeteredModelClient.Reservation> reservation = new AtomicReference<>();
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final AtomicBoolean finished = new AtomicBoolean();

        Call(Generation g, Prompt prompt) {
            this.g = g;
            this.prompt = prompt;
        }

        String detail() {
            return g.kind().name().toLowerCase() + " " + g.id();
        }

        long elapsedMs() {
            return (System.nanoTime() - started) / 1_000_000;
        }

        /** What the call reserved: the bound once the meter allowed it, else nothing. */
        long charged() {
            MeteredModelClient.Reservation r = reservation.get();
            return r != null && r.allowed() ? r.microUsd() : 0;
        }

        /** The meter's answer, on its thread, whether or not the client is still there. */
        @Override
        public void charged(MeteredModelClient.Reservation r) {
            reservation.set(r);
            if (cancelled.get()) {
                finishAfterCancel(r);
            }
        }

        /** The meter itself failed: no call is made, and the record says so even if the client has gone. */
        @Override
        public void failed(Throwable error) {
            if (cancelled.get() && !finished.get()) {
                log.error("{} {} failed at the meter after the client had gone", g.kind(), g.id(), error);
            }
            finish(Generation.Status.ERROR);
        }

        /** The client left before the stream began. */
        void cancelled() {
            cancelled.set(true);
            MeteredModelClient.Reservation r = reservation.get();
            if (r != null) {
                finishAfterCancel(r);
            }
        }

        private void finishAfterCancel(MeteredModelClient.Reservation r) {
            if (!finished.get() && r.allowed()) {
                log.info("{} {} cancelled before the stream, {} micro-USD reserved", g.kind(), g.id(), r.microUsd());
            }
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
            long charged = charged();
            Long cost = u == null ? null : catalog.costMicroUsd(g.model(), u);
            Long first = ttft.get() < 0 ? null : ttft.get();
            store.finish(g.id(), new Generation.Finish(text.toString(),
                    u == null ? null : u.promptTokens(), u == null ? null : u.completionTokens(),
                    u == null ? null : u.reasoningTokens(), charged, cost, first, elapsed, status));
            MeteredModelClient.Reservation r = reservation.get();
            log.info("{} {} {}: {} ms (first text {} ms); tokens in {} (bound {}), out {} (reasoning {}); "
                            + "cost {} of {} micro-USD reserved",
                    g.kind(), g.id(), status, elapsed, first == null ? "-" : first,
                    u == null ? "-" : u.promptTokens(), r == null ? "-" : r.inputTokens(),
                    u == null ? "-" : u.completionTokens(), u == null || u.reasoningTokens() == null ? "-" : u.reasoningTokens(),
                    cost == null ? "-" : cost, charged);
        }
    }
}
