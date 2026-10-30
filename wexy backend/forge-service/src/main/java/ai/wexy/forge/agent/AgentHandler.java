package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.loop.PlanRequest;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.records.GenerationStore;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.sse.SseEncoder;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.upstream.MeteredModelClient;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * {@code POST /v1/agent/turn} (the agent-loop design §5, §10; EA2.4): one turn of the agent loop as one SSE stream.
 *
 * <p>The loop runs off the event loop and says nothing until its first call is charged (the {@code charged} callback).
 * So the route waits for its first word before it answers: a turn that ended having said nothing (the first charge
 * refused) is an HTTP envelope, {@code 503 budget} or {@code paused}, as the loop's routes answer a refusal; any other
 * opens the stream with {@code meta}, then the loop's events, a heartbeat through its silences, and exactly one
 * terminal event (A7). The client leaving cancels the call in flight and ends the turn (A8).
 */
@Component
public class AgentHandler {

    static final Set<String> FIELDS = Set.of("prompt", "style", "seconds");
    private static final Logger log = LoggerFactory.getLogger(AgentHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PROMPT_VERSION = "agent.v2";

    private final AgentLoop loop;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final GenerationStore store;
    private final LoopProperties loopProperties;
    private final EngineBundle bundle;

    public AgentHandler(AgentLoop loop, MeteredModelClient models, ModelCatalog catalog, GenerationStore store,
                        LoopProperties loopProperties, EngineBundle bundle) {
        this.loop = loop;
        this.models = models;
        this.catalog = catalog;
        this.store = store;
        this.loopProperties = loopProperties;
        this.bundle = bundle;
        catalog.role(MeteredModelCaller.ROLE);
    }

    public Mono<ServerResponse> turn(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return request.bodyToMono(JsonNode.class)
                .switchIfEmpty(Mono.error(() -> new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a body.")))
                .flatMap(body -> {
                    AgentRequest turn = validated(body, loopProperties.caps());
                    String turnId = Ulid.next(Instant.now());
                    MeteredModelCaller calls = new MeteredModelCaller(models, catalog, store, turnId, caller,
                            body.toString(), PROMPT_VERSION, HostContract.VERSION);
                    Sinks.Many<ServerSentEvent<String>> events = Sinks.many().unicast().onBackpressureBuffer();
                    Sinks.One<Boolean> opened = Sinks.one();
                    AtomicReference<AgentOutcome> silent = new AtomicReference<>();
                    AtomicBoolean cancelled = new AtomicBoolean();
                    Schedulers.boundedElastic().schedule(() -> run(turnId, turn, calls, events, opened, silent, cancelled));
                    // A client that leaves before the first word ends the turn too (gate A): no call starts after it,
                    // and one the meter is deciding stops there; the body's own cancel covers the stream after.
                    return opened.asMono().doOnCancel(() -> {
                        cancelled.set(true);
                        calls.cancel();
                    }).flatMap(started -> started
                            ? ServerResponse.ok()
                                    .contentType(MediaType.TEXT_EVENT_STREAM)
                                    .header(HttpHeaders.CACHE_CONTROL, "no-store")
                                    .header("X-Accel-Buffering", "no")
                                    .body(BodyInserters.fromServerSentEvents(SseEncoder.heartbeats(events.asFlux().doOnCancel(() -> {
                                        cancelled.set(true);
                                        calls.cancel();
                                    }), loopProperties.heartbeat())))
                            : Mono.error(refusal(silent.get())));
                });
    }

    /** The turn, on its own thread: the loop, then its terminal event, or nothing at all when it never spoke. */
    private void run(String turnId, AgentRequest turn, MeteredModelCaller calls, Sinks.Many<ServerSentEvent<String>> events,
                     Sinks.One<Boolean> opened, AtomicReference<AgentOutcome> silent, AtomicBoolean cancelled) {
        AgentOutcome outcome;
        try {
            outcome = loop.run(turn, calls, event -> {
                if (opened.tryEmitValue(Boolean.TRUE).isSuccess()) {
                    events.tryEmitNext(encode("meta", meta(turnId)));
                }
                events.tryEmitNext(encode(event.name(), event.data()));
            }, cancelled::get);
        } catch (RuntimeException e) {
            log.error("agent turn {} failed", turnId, e);
            outcome = new AgentOutcome(AgentOutcome.Status.FAILED, ErrorCode.INTERNAL.code(), "Something went wrong on our side.",
                    null, null, null, 0, 0);
        }
        log.info("AGENT TURN {} {} calls={} cost={} code={}", turnId, outcome.status(), outcome.calls(), outcome.costMicroUsd(),
                outcome.code());
        // Kept before the signal: the response is chosen on the signal's own thread, and reads it at once.
        silent.set(outcome);
        if (opened.tryEmitValue(Boolean.FALSE).isSuccess()) {
            return;
        }
        ServerSentEvent<String> terminal = terminal(outcome);
        if (terminal != null) {
            events.tryEmitNext(terminal);
        }
        events.tryEmitComplete();
    }

    /** The request as §5.1 takes it: only its three fields, within the planner's caps. */
    static AgentRequest validated(JsonNode body, LoopProperties.Caps caps) {
        if (!body.isObject()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The request must be a JSON object.");
        }
        List<String> extra = new ArrayList<>();
        body.fieldNames().forEachRemaining(name -> {
            if (!FIELDS.contains(name)) {
                extra.add(name);
            }
        });
        if (!extra.isEmpty()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "A turn takes only prompt, style and seconds, not " + String.join(", ", extra) + ".");
        }
        JsonNode seconds = body.path("seconds");
        // A number beyond an int is refused, not wrapped into range (4294967308 is not 12).
        PlanRequest checked = new PlanRequest(body.path("prompt").isTextual() ? body.path("prompt").asText() : null,
                body.path("style").isTextual() ? body.path("style").asText() : null,
                seconds.isIntegralNumber() && seconds.canConvertToInt() ? seconds.asInt() : null).validated(caps);
        return new AgentRequest(checked.prompt(), checked.style(), checked.seconds());
    }

    private Map<String, Object> meta(String turnId) {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("turnId", turnId);
        meta.put("model", catalog.role(MeteredModelCaller.ROLE).model());
        meta.put("source", "live");
        meta.put("promptVersion", PROMPT_VERSION);
        meta.put("bundleHash", bundle.bundleHash());
        // EA3.6: the action's contract and the adapter manifest its program was checked against, so a client built for
        // another refuses the turn before it reads a design or a program, as it refuses another bundle.
        meta.put("actionSchema", JsonSchemas.AGENT_ACTION);
        return meta;
    }

    /** The last event (§5.4): {@code done} when the turn ended as it may, {@code error} when it failed; none when the client left. */
    static ServerSentEvent<String> terminal(AgentOutcome outcome) {
        Map<String, Object> data = new LinkedHashMap<>();
        return switch (outcome.status()) {
            case HANDED_OFF -> encode("done", status(data, "handed-off", null));
            case ASKED -> encode("done", status(data, "asked", null));
            case EXHAUSTED -> encode("done", status(data, "exhausted", outcome.reason()));
            case FAILED -> "finished".equals(outcome.code())
                    ? encode("done", status(data, "declined", outcome.reason()))
                    : encode("error", error(data, outcome.code(), outcome.reason()));
            case DENIED -> encode("error", error(data, outcome.code(), outcome.reason()));
            case CANCELLED -> null;
        };
    }

    /** The envelope for a turn that never spoke: a refused first charge, or a fault before it. */
    static ForgeException refusal(AgentOutcome outcome) {
        if (outcome.status() == AgentOutcome.Status.DENIED) {
            return new ForgeException(ErrorCode.fromCode(outcome.code()), outcome.reason());
        }
        if (outcome.status() == AgentOutcome.Status.EXHAUSTED) {
            // Only a prompt over its budget stops a turn before its first call: a configuration fault, not the creator's.
            log.error("agent turn refused before its first call: {}", outcome.reason());
        }
        return new ForgeException(ErrorCode.INTERNAL, "Something went wrong on our side.");
    }

    private static Map<String, Object> status(Map<String, Object> data, String status, String reason) {
        data.put("status", status);
        data.put("reason", reason);
        return data;
    }

    private static Map<String, Object> error(Map<String, Object> data, String code, String message) {
        ErrorCode known;
        try {
            known = ErrorCode.fromCode(code);
        } catch (IllegalArgumentException e) {
            known = ErrorCode.INTERNAL;
        }
        data.put("code", known.code());
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
}
