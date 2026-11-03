package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.allowance.PromptAdmission;
import ai.wexy.forge.allowance.Role;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.GenerationStore;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.MeteredModelClient;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyExtractors;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;
import reactor.core.scheduler.Schedulers;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A model's review of the world on the stage (EA6.4; the frontend's visual-review design §9, §9.1; Q62's gates, Q112 (a)):
 * {@code GET /v1/agent/review}, the terms a browser must show and consent to, and {@code POST /v1/agent/review}, one
 * metered call that looks at the frames and answers a verdict, as one JSON document.
 *
 * <p>In order, cheapest first, before any record or charge: every gate must be verified ({@code 503 unavailable},
 * {@code EA_VISION_UNAVAILABLE <gate>}), before a byte of the body is read; the body is read to at most
 * {@value ReviewRequest#MAX_REQUEST_BYTES} bytes ({@code 413}); the request is checked whole ({@link ReviewRequest}: the
 * consent, the ids, then whether the turn is the caller's ({@code 404}) before anything costly, then the subject, R, S,
 * the modules, the findings and, last, the frames, decoded); the prompt must fit; the call must run inside the turn's
 * granted prompt, carrying its text, with a review left ({@link PromptAdmission#review}, W1). Then the call is a generation of kind
 * {@code AGENT} under the turn, RUNNING before {@link MeteredModelClient#charge} reserves its bound: the text's, the
 * schema's and each frame's {@code image-tokens}. A refusal is an envelope with nothing sent upstream.
 *
 * <p>The answer is judged whole: {@code review-verdict.v1}, a pass with no issue, a fail with at least one, each module
 * one the request named. An answer cut, declined, off its schema, or without usage is {@code 502 upstream}, never a
 * pass (§9). The document echoes the review, its subject and each frame's hash, so the browser can refuse an answer to
 * another review. No frame body is recorded or logged: the record's input is ids and hashes.
 */
@Component
public class ReviewHandler {

    /** The role every review uses, and the vision probe too: its own model, cap and deadline. */
    public static final String ROLE = "review";
    /** The prompt's text at most, as a module call's: one token a byte, so its reservation stays known. */
    static final int MAX_PROMPT_BYTES = 196_608;

    private static final Logger log = LoggerFactory.getLogger(ReviewHandler.class);
    /** Trailing text after the verdict is no verdict (the independent review of EA6.4: it read as the object before it). */
    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final PromptBuilder prompts;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final GenerationStore store;
    private final LoopProperties loop;
    private final JsonSchemas schemas;
    private final PromptAdmission admission;
    private final ReviewProperties review;

    public ReviewHandler(PromptBuilder prompts, MeteredModelClient models, ModelCatalog catalog, GenerationStore store, LoopProperties loop,
                         JsonSchemas schemas, PromptAdmission admission, ReviewProperties review) {
        this.prompts = prompts;
        this.models = models;
        this.catalog = catalog;
        this.store = store;
        this.loop = loop;
        this.schemas = schemas;
        this.admission = admission;
        this.review = review;
        catalog.role(ROLE);
    }

    /** The model's id, and whether it is Meta's contributor mode, whose content trains Meta's models (§4). */
    private String model() {
        return catalog.role(ROLE).model();
    }

    static String mode(String model) {
        return model.endsWith("-contributor") ? "contributor" : "standard";
    }

    /**
     * Each gate, verified or not: the operator's facts ({@link ReviewProperties#gates}), and, for privacy, a review model
     * in Standard mode too. Contributor mode's content trains Meta's models, which no disclosure here says and the
     * coding principles forbid for a creator's content (§11, R13), so its frames are never sent (the independent review of
     * EA6.4: an operator pointing the role at a contributor model opened every gate).
     */
    Map<String, Boolean> gates() {
        Map<String, Boolean> gates = review.gates();
        gates.put("privacy", gates.get("privacy") && "standard".equals(mode(model())));
        return gates;
    }

    /** The first gate not verified, or null when every one is. */
    String unmet() {
        return gates().entrySet().stream().filter(e -> !e.getValue()).map(Map.Entry::getKey).findFirst().orElse(null);
    }

    /** {@code GET /v1/agent/review}: the gates, the provider, the model and the policy a browser consents to, and the bounds. */
    public Mono<ServerResponse> terms(ServerRequest request) {
        return ServerResponse.ok().contentType(MediaType.APPLICATION_JSON).header(HttpHeaders.CACHE_CONTROL, "no-store")
                .bodyValue(terms().toString());
    }

    ObjectNode terms() {
        ObjectNode t = JSON.createObjectNode();
        String unmet = unmet();
        t.put("available", unmet == null);
        t.put("gate", unmet);
        ObjectNode gates = t.putObject("gates");
        gates().forEach((gate, verified) -> gates.put(gate, verified ? "verified" : "unverified"));
        t.put("provider", blankToNull(review.provider()));
        t.put("model", model());
        t.put("mode", mode(model()));
        t.put("policyVersion", blankToNull(review.policyVersion()));
        t.putObject("limits").put("frames", ReviewRequest.MAX_FRAMES).put("width", ReviewRequest.WIDTH).put("height", ReviewRequest.HEIGHT)
                .put("jpegBytes", ReviewRequest.MAX_JPEG_BYTES).put("pairBytes", ReviewRequest.MAX_PAIR_BYTES)
                .put("requestBytes", ReviewRequest.MAX_REQUEST_BYTES).put("findings", ReviewRequest.MAX_FINDINGS).put("modules", ReviewRequest.MAX_MODULES);
        return t;
    }

    /** {@code POST /v1/agent/review}: one review, refused before anything when it may not run. */
    public Mono<ServerResponse> review(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        // A gate first, before a byte of the body is read (the independent review of EA6.4): while one is shut, which is
        // every deployment's state until the vision probe passes, nothing of a review is read, parsed or decoded.
        String unmet = unmet();
        if (unmet != null) {
            return Mono.error(new ForgeException(ErrorCode.UNAVAILABLE, "EA_VISION_UNAVAILABLE " + unmet + ": " + why(unmet)));
        }
        // The checks parse up to a megabyte of JSON and decode and hash up to 600,000 bytes of JPEG: off the event loop,
        // with the admission (Redis), and all of it before any record or charge.
        return body(request).flatMap(text -> Mono.fromCallable(() -> admitted(text, caller))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(ready -> call(ready.request(), ready.prompt(), caller)));
    }

    /** A review checked whole, the caller's turn, its prompt within its bound, and admitted inside that turn's prompt. */
    private record Ready(ReviewRequest request, Prompt prompt) {
    }

    /**
     * Blocking: the request's checks, the turn's owner asked among them before its frames are decoded, the prompt's size,
     * then the admission. Any refusal throws.
     */
    private Ready admitted(String text, Caller caller) {
        ReviewRequest r = ReviewRequest.validated(text, loop.caps(), schemas, review.provider().strip(), model(), review.policyVersion().strip(),
                turnId -> owned(turnId, caller));
        Prompt prompt = prompt(r);
        long bytes = prompt.messages().stream().mapToLong(m -> ModuleRequest.utf8(m.content())).sum();
        if (bytes > MAX_PROMPT_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "This review's prompt would be " + bytes + " bytes of text; at most " + MAX_PROMPT_BYTES + ".");
        }
        admission.review(caller, r.turnId(), r.request().prompt());
        return new Ready(r, prompt);
    }

    /** The turn is the caller's: one of its calls is the caller's own record, as for a module call. Else 404. */
    private void owned(String turnId, Caller caller) {
        boolean owned = store.children(turnId).stream().anyMatch(g -> g.kind() == Generation.Kind.AGENT
                && MeteredModelCaller.ROLE.equals(g.role()) && g.uid().equals(caller.uid()));
        if (!owned) {
            throw new ForgeException(ErrorCode.NOT_FOUND, "This turn isn't available.");
        }
    }

    private String why(String gate) {
        return switch (gate) {
            case "images" -> "no vision probe has shown that the review model reads images (wexy.review.vision-probe)";
            case "transport" -> "no vision probe has carried a frame through this service's image part (wexy.review.vision-probe)";
            case "privacy" -> review.gates().get("privacy")
                    ? "the review model " + model() + " is in Meta's contributor mode, whose content trains Meta's models: no frame goes to it"
                    : "no disclosure is configured for the creator to consent to (wexy.review.provider, wexy.review.policy-version)";
            case "metering" -> "no bound on a frame's input tokens is configured, so a review cannot be charged before it runs (wexy.review.image-tokens)";
            default -> "unknown gate";
        };
    }

    /** The body, at most the route's bytes: a longer one is refused as it is read, never held whole. */
    private static Mono<String> body(ServerRequest request) {
        return DataBufferUtils.join(request.body(BodyExtractors.toDataBuffers()), ReviewRequest.MAX_REQUEST_BYTES)
                .map(buffer -> {
                    try {
                        return buffer.toString(StandardCharsets.UTF_8);
                    } finally {
                        DataBufferUtils.release(buffer);
                    }
                })
                .onErrorMap(DataBufferLimitException.class, e -> new ForgeException(ErrorCode.TOO_LARGE,
                        "EA_REVIEW_SIZE request: more than " + ReviewRequest.MAX_REQUEST_BYTES + " bytes."))
                .switchIfEmpty(Mono.error(() -> new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a body.")));
    }

    /** R, S, the modules, each frame's line and the kept findings, as data; the JPEGs after the text, each with its bound. */
    private Prompt prompt(ReviewRequest r) {
        ObjectNode request = JSON.createObjectNode().put("prompt", r.request().prompt()).put("style", r.request().style())
                .put("seconds", r.request().seconds());
        List<String> frames = new ArrayList<>();
        List<ChatMessage.Image> images = new ArrayList<>();
        for (ReviewRequest.Frame f : r.frames()) {
            frames.add(("framed".equals(f.view()) ? "The framed view: the camera the creator sees first"
                    : "The side view: level with the subject's middle, from its side, at the framed view's distance")
                    + "; " + ReviewRequest.WIDTH + " × " + ReviewRequest.HEIGHT + ", black bars at its edges are letterboxing, not the scene;"
                    + " drawn at the world's fixed step " + f.tick() + " (" + String.format(java.util.Locale.ROOT, "%.2f", f.seconds()) + " s).");
            images.add(new ChatMessage.Image(f.jpeg(), review.imageTokens()));
        }
        List<PromptBuilder.Finding> findings = r.hostFindings().stream().map(f -> new PromptBuilder.Finding(f.code(), null, f.message())).toList();
        return prompts.review(request.toString(), r.design().toString(), r.modules(), frames, findings, images);
    }

    private Mono<ServerResponse> call(ReviewRequest r, Prompt prompt, Caller caller) {
        Call call = begin(r, prompt, caller);
        return charge(call, caller)
                .flatMap(metered -> metered.chunks()
                        .doOnNext(call::take)
                        .then(Mono.fromCallable(() -> judged(call, metered)))
                        .onErrorMap(error -> failure(call, error))
                        .doFinally(signal -> call.finish(signal == SignalType.CANCEL ? Generation.Status.CANCELLED : Generation.Status.ERROR)))
                .flatMap(document -> ServerResponse.ok().contentType(MediaType.APPLICATION_JSON).header(HttpHeaders.CACHE_CONTROL, "no-store")
                        .bodyValue(document))
                .doOnCancel(call::cancelled);
    }

    private Call begin(ReviewRequest r, Prompt prompt, Caller caller) {
        Instant now = Instant.now();
        // The record's input is the review's ids and hashes, never R, S, a finding or a frame's bytes (§9, I5).
        ObjectNode input = JSON.createObjectNode().put("turnId", r.turnId()).put("reviewId", r.reviewId())
                .put("candidate", r.subject().path("candidate").asText());
        ArrayNode frames = input.putArray("frames");
        r.frames().forEach(f -> frames.addObject().put("id", f.id()).put("view", f.view()).put("tick", f.tick()).put("sha256", f.sha256())
                .put("bytes", f.jpeg().length));
        input.put("modules", r.modules().size()).put("hostFindings", r.hostFindings().size()).put("policyVersion", review.policyVersion().strip());
        Generation g = store.begin(Generation.started(Ulid.next(now), Generation.Kind.AGENT, r.turnId(), ROLE, model(), prompt.templateId(),
                JsonSchemas.REVIEW_VERDICT, null, input.toString(), caller.admin() ? Generation.Source.DEMO : Generation.Source.USER, caller.uid(), now));
        return new Call(g, prompt, r);
    }

    /** The charge: a refusal finishes the record as DENIED, a fault before the call as ERROR, before the envelope goes out. */
    private Mono<MeteredModelClient.Metered> charge(Call call, Caller caller) {
        Map<String, Object> format = Map.of("type", "json_schema", "json_schema", Map.of(
                "name", JsonSchemas.REVIEW_VERDICT.replace('.', '_').replace('-', '_'),
                "schema", schemas.schema(JsonSchemas.REVIEW_VERDICT),
                "strict", loop.strictSchemas()));
        return Mono.defer(() -> models.charge(ROLE, call.prompt.messages(), new MeteredModelClient.CallOptions(null, format,
                        MeteredModelCaller.safetyId(caller.uid()), Role.of(caller).lane()), "review " + call.g.id(), call))
                .onErrorResume(error -> {
                    boolean refused = error instanceof ForgeException f && (f.code() == ErrorCode.BUDGET || f.code() == ErrorCode.PAUSED);
                    call.finish(refused ? Generation.Status.DENIED : Generation.Status.ERROR);
                    log.info("REVIEW {} {}: {}", call.g.id(), refused ? "denied" : "failed before the call",
                            error instanceof ForgeException f ? f.code().code() : error.getClass().getSimpleName());
                    return Mono.error(error);
                });
    }

    /** The answer, judged whole; the document, or an envelope's error. Never a pass from an answer that cannot be held to its schema. */
    private String judged(Call call, MeteredModelClient.Metered metered) {
        String finish = call.finishReason.get();
        if ("length".equals(finish)) {
            log.warn("REVIEW {} truncated at cap {}", call.g.id(), metered.maxOutputTokens());
            throw unusable(call, "length", "The model ran out of room reviewing these frames.");
        }
        if (finish != null && !"stop".equals(finish)) {
            throw unusable(call, "finish_reason " + finish, "content_filter".equals(finish) ? "The model declined to review these frames." : "The model didn't answer.");
        }
        ChatChunk.Usage usage = call.usage.get();
        if (usage == null) {
            // §9: missing usage is not a pass. Its cost is unknown, so its reservation stays, and its verdict is not used.
            throw unusable(call, "no usage", "The review's cost was not reported, so its verdict is not used.");
        }
        JsonNode answer;
        try {
            answer = JSON.readTree(call.text.toString());
        } catch (JsonProcessingException e) {
            throw unusable(call, "not JSON", "The review didn't come through.");
        }
        List<String> problems = answer == null || !answer.isObject() ? List.of("not a JSON object") : verdictProblems(answer, call.request.modules());
        if (!problems.isEmpty()) {
            throw unusable(call, problems.get(0), "The review didn't come through.");
        }
        call.finish(Generation.Status.OK);
        ObjectNode doc = JSON.createObjectNode();
        doc.put("reviewId", call.request.reviewId()).put("generationId", call.g.id()).put("model", metered.model()).put("source", "live")
                .put("role", ROLE).put("promptVersion", call.g.promptVersion());
        doc.set("subject", call.request.subject());
        ArrayNode frames = doc.putArray("frames");
        call.request.frames().forEach(f -> frames.addObject().put("id", f.id()).put("sha256", f.sha256()));
        ObjectNode verdict = doc.putObject("verdict").put("verdict", answer.path("verdict").asText());
        ArrayNode issues = verdict.putArray("issues");
        int n = 0;
        for (JsonNode issue : answer.path("issues")) {
            ObjectNode out = issues.addObject().put("n", ++n);
            for (String key : List.of("kind", "severity", "sentence", "scope")) {
                out.put(key, issue.path(key).asText());
            }
            out.set("modules", issue.path("modules").deepCopy());
        }
        ObjectNode u = doc.putObject("usage").put("in", usage.promptTokens()).put("out", usage.completionTokens());
        u.put("reasoning", usage.reasoningTokens());
        u.put("cached", usage.cachedTokens());
        u.put("costMicroUsd", catalog.costMicroUsd(metered.model(), usage));
        return doc.toString();
    }

    /**
     * Why an answer is not a usable verdict: off {@code review-verdict.v1}, a pass with issues or a fail without one, a
     * blank sentence, or a module the request did not name, or named twice in one issue (the browser refuses that too: the
     * independent review of EA6.4 found the halves apart, a call spent on an answer the browser then discarded). Empty
     * when it is usable.
     */
    List<String> verdictProblems(JsonNode answer, List<String> modules) {
        List<String> problems = new ArrayList<>(schemas.validate(JsonSchemas.REVIEW_VERDICT, answer));
        if (!problems.isEmpty()) {
            return problems;
        }
        String verdict = answer.path("verdict").asText();
        int count = answer.path("issues").size();
        if ("pass".equals(verdict) && count > 0) {
            problems.add("a pass with " + count + " issues");
        }
        if ("fail".equals(verdict) && count == 0) {
            problems.add("a fail with no issue");
        }
        for (JsonNode issue : answer.path("issues")) {
            if (ModuleRequest.blank(issue.path("sentence").asText())) {
                problems.add("an issue whose sentence is blank");
            }
            Set<String> named = new HashSet<>();
            for (JsonNode m : issue.path("modules")) {
                if (!modules.contains(m.asText())) {
                    problems.add("an issue names a module the request did not: " + ModuleRequest.shown(m));
                } else if (!named.add(m.asText())) {
                    problems.add("an issue names a module twice: " + ModuleRequest.shown(m));
                }
            }
        }
        return problems;
    }

    private static ForgeException unusable(Call call, String why, String message) {
        // The facts that tell a cap from a refusal, never the answer itself (coding principles §11).
        log.warn("REVIEW {} unusable: {}; finish_reason {}, usage {}, {} ms", call.g.id(), why, call.finishReason.get(),
                call.usage.get() == null ? "absent" : "present", call.elapsedMs());
        call.finish(Generation.Status.ERROR);
        return new ForgeException(ErrorCode.UPSTREAM, message);
    }

    private static Throwable failure(Call call, Throwable error) {
        if (error instanceof ForgeException) {
            return error;
        }
        if (error instanceof UpstreamException upstream) {
            log.warn("REVIEW {} {}: {}", call.g.id(), upstream.errorCode().code(), upstream.describe());
            call.finish(upstream.kind() == UpstreamException.Kind.TIMEOUT ? Generation.Status.TIMEOUT : Generation.Status.ERROR);
            return new ForgeException(upstream.errorCode(), upstream.publicMessage());
        }
        log.error("REVIEW {} failed", call.g.id(), error);
        call.finish(Generation.Status.ERROR);
        return new ForgeException(ErrorCode.INTERNAL, "Something went wrong on our side.");
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    /**
     * One review call's lifecycle, from {@code begin} to its single finish, as a module call keeps its own: what the model
     * said, what the meter decided, and whether the client is still there. A cancel before the meter answered waits for its
     * answer, then records CANCELLED with the reservation, or DENIED; only the first finish counts.
     */
    private final class Call implements MeteredModelClient.ChargeListener {

        private final Generation g;
        private final Prompt prompt;
        private final ReviewRequest request;
        private final long started = System.nanoTime();
        private final StringBuilder text = new StringBuilder();
        private final AtomicLong ttft = new AtomicLong(-1);
        private final AtomicReference<ChatChunk.Usage> usage = new AtomicReference<>();
        private final AtomicReference<String> finishReason = new AtomicReference<>();
        private final AtomicReference<MeteredModelClient.Reservation> reservation = new AtomicReference<>();
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final AtomicBoolean finished = new AtomicBoolean();

        Call(Generation g, Prompt prompt, ReviewRequest request) {
            this.g = g;
            this.prompt = prompt;
            this.request = request;
        }

        long elapsedMs() {
            return (System.nanoTime() - started) / 1_000_000;
        }

        void take(ChatChunk chunk) {
            if (!chunk.text().isEmpty()) {
                ttft.compareAndSet(-1, elapsedMs());
                text.append(chunk.text());
            }
            if (chunk.finishReason() != null) {
                finishReason.set(chunk.finishReason());
            }
            if (chunk.usage() != null) {
                usage.set(chunk.usage());
            }
        }

        @Override
        public void charged(MeteredModelClient.Reservation r) {
            reservation.set(r);
            if (cancelled.get()) {
                finish(r.allowed() ? Generation.Status.CANCELLED : Generation.Status.DENIED);
            }
        }

        @Override
        public void failed(Throwable error) {
            if (cancelled.get() && !finished.get()) {
                log.error("REVIEW {} failed at the meter after the client had gone", g.id(), error);
            }
            finish(Generation.Status.ERROR);
        }

        void cancelled() {
            cancelled.set(true);
            MeteredModelClient.Reservation r = reservation.get();
            if (r != null) {
                finish(r.allowed() ? Generation.Status.CANCELLED : Generation.Status.DENIED);
            }
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
            log.info("REVIEW {} {} turn={} review={} frames={}: {} ms; tokens in {}, out {} (reasoning {}); cost {} of {} micro-USD reserved",
                    g.id(), status, request.turnId(), request.reviewId(), request.frames().size(), elapsed,
                    u == null ? "-" : u.promptTokens(), u == null ? "-" : u.completionTokens(),
                    u == null || u.reasoningTokens() == null ? "-" : u.reasoningTokens(), cost == null ? "-" : cost, charged);
        }
    }
}
