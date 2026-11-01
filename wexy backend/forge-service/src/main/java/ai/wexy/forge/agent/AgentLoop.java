package ai.wexy.forge.agent;

import ai.wexy.common.AgentTurn;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatMessage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

import static ai.wexy.forge.agent.AgentOutcome.Status.ASKED;
import static ai.wexy.forge.agent.AgentOutcome.Status.CANCELLED;
import static ai.wexy.forge.agent.AgentOutcome.Status.DENIED;
import static ai.wexy.forge.agent.AgentOutcome.Status.EXHAUSTED;
import static ai.wexy.forge.agent.AgentOutcome.Status.FAILED;
import static ai.wexy.forge.agent.AgentOutcome.Status.HANDED_OFF;

/**
 * The agent loop (the agent-loop design §2, §6; EA2.3): one turn, as a pure state machine over three seams, the model
 * ({@link ModelCaller}), the documentation tools and the program check, with no clock but the one it is given.
 *
 * <p>Each call sends the agent template's two messages, then every earlier answer and what acting on it gave,
 * so the request stays verbatim in every call and a proposal's design in every later one (A4). Before a call, every
 * budget is checked, and a refusal ends the turn with no call started (A1, P6). The turn's seconds are also a deadline:
 * the caller is given what is left of them, and an answer that comes after it is not acted on. After a call, the answer
 * must match {@code agent-action.v2} and carry its kind's payload (one repair is allowed). A {@code need_context} runs
 * its reads; a proposal runs the check, which hands off or asks for a revision; {@code ask} and {@code finish} end the
 * turn.
 *
 * <p>A turn may revise a base (Q82 (a); EA4.4, {@link AgentBase}): a program a turn handed off and the browser refused,
 * with what it found. Its first message carries the base after the request, its first call asks for the revise, and
 * every proposal of the turn is checked and handed off with the base's design, which a program revision may not change
 * (the frontend's candidate-loop design §8): an answer that changed it is told, as a {@code warn}, and not used.
 */
public final class AgentLoop {

    private final AgentTools tools;
    private final ProgramCheck check;
    private final JsonSchemas schemas;
    private final PromptBuilder prompts;
    private final AgentBudget budget;
    private final LongSupplier clockMillis;
    private final ObjectMapper json = new ObjectMapper();

    /** The template every call of a turn is built from ({@code agent.v4}), as its records and its meta name it. */
    public String promptVersion() {
        return prompts.version("agent");
    }

    public AgentLoop(AgentTools tools, ProgramCheck check, JsonSchemas schemas, PromptBuilder prompts, AgentBudget budget,
                     LongSupplier clockMillis) {
        this.tools = tools;
        this.check = check;
        this.schemas = schemas;
        this.prompts = prompts;
        this.budget = budget;
        this.clockMillis = clockMillis;
    }

    /** One turn, to its end; its events go to {@code events} as they happen, and {@code cancelled} is asked between steps. */
    public AgentOutcome run(AgentRequest request, ModelCaller caller, Consumer<AgentEvent> events, BooleanSupplier cancelled) {
        return run(request, null, caller, events, cancelled);
    }

    /** One turn that revises {@code base}, or a first turn when it is null. */
    public AgentOutcome run(AgentRequest request, AgentBase base, ModelCaller caller, Consumer<AgentEvent> events, BooleanSupplier cancelled) {
        return new Turn(request, base, caller, events, cancelled).run();
    }

    /** A revision's base, checked as this loop checks a proposal (its schema, then the program check); refused otherwise. */
    AgentBase base(JsonNode base, String bundleHash) {
        return AgentBase.validated(base, bundleHash, schemas, check);
    }

    /** The {@code response_format} every call sends: the action's schema, strict (the tests price a call by it too). */
    static Map<String, Object> responseFormat(JsonSchemas schemas) {
        return Map.of("type", "json_schema", "json_schema", Map.of("name", "agent_action_v2",
                "schema", schemas.schema(JsonSchemas.AGENT_ACTION), "strict", true));
    }

    private final class Turn {

        private final ModelCaller caller;
        private final Consumer<AgentEvent> events;
        private final BooleanSupplier cancelled;
        private final List<ChatMessage> messages = new ArrayList<>();
        private final Map<String, Object> format;
        private final ToolBudget toolBudget = new ToolBudget(budget.perRound(), budget.toolRequests(), budget.docBytes());
        private final long started = clockMillis.getAsLong();
        private int calls;
        private int rounds;
        private int revisions;
        private int repairs;
        private long spent;
        /** A design proposed alone, waiting for its program. */
        private JsonNode pendingDesign;
        /** A revision's design, which every proposal of the turn is checked and handed off with; null in a first turn. */
        private final JsonNode fixedDesign;
        private String purpose;

        Turn(AgentRequest request, AgentBase base, ModelCaller caller, Consumer<AgentEvent> events, BooleanSupplier cancelled) {
            this.caller = caller;
            this.events = events;
            this.cancelled = cancelled;
            Prompt first;
            if (base == null) {
                first = prompts.agent(request.prompt(), request.style(), request.seconds(), budget.describe());
                fixedDesign = null;
                purpose = "first";
            } else {
                first = prompts.agent(request.prompt(), request.style(), request.seconds(), budget.describe(), base.design(), base.program(),
                        base.findings().stream().map(f -> new PromptBuilder.ProgramFinding(f.code(), f.path(), f.message())).toList());
                fixedDesign = base.design();
                // The first call is the revise the base asks for: the template's "A turn that revises a program".
                purpose = "revise";
            }
            messages.addAll(first.messages());
            format = responseFormat(schemas);
        }

        AgentOutcome run() {
            while (true) {
                if (cancelled.getAsBoolean()) {
                    return end(CANCELLED, null, "the client left");
                }
                String refused = refusal();
                if (refused != null) {
                    return end(EXHAUSTED, refused.substring(0, refused.indexOf(':')), refused);
                }
                calls++;
                int n = calls;
                String thisPurpose = purpose;
                ModelAnswer answer;
                try {
                    Duration remaining = Duration.ofMillis(budget.turnSeconds() * 1000 - (clockMillis.getAsLong() - started));
                    answer = caller.call(n, List.copyOf(messages), format, () -> emit("call", "n", n, "purpose", thisPurpose), remaining);
                } catch (AgentCallFailure f) {
                    if ("cancelled".equals(f.code())) {
                        return end(CANCELLED, null, f.getMessage());
                    }
                    if ("deadline".equals(f.code())) {
                        return end(EXHAUSTED, "EA_TURN_BUDGET", outOfTime(n));
                    }
                    boolean denied = n == 1 && ("budget".equals(f.code()) || "paused".equals(f.code()));
                    return end(denied ? DENIED : FAILED, f.code(), f.getMessage());
                }
                spent += answer.costMicroUsd();
                emit("usage", "n", n, "generationId", answer.generationId(), "in", answer.promptTokens(), "out", answer.completionTokens(),
                        "reasoning", answer.reasoningTokens(), "cached", answer.cachedTokens(), "costMicroUsd", answer.costMicroUsd());
                if (clockMillis.getAsLong() - started >= budget.turnSeconds() * 1000) {
                    // The turn's time is a deadline, not only a check before each call (gate A): a late answer is not acted on.
                    return end(EXHAUSTED, "EA_TURN_BUDGET", outOfTime(n));
                }
                messages.add(ChatMessage.assistant(answer.text()));

                JsonNode action = parse(answer.text());
                List<String> problems = action == null || !action.isObject() ? List.of("it is not a JSON object")
                        : schemas.validate(JsonSchemas.AGENT_ACTION, action);
                if (problems.isEmpty()) {
                    problems = payload(action);
                }
                if (problems.isEmpty() && "length".equals(answer.finishReason())) {
                    problems = List.of("it was cut off at the output cap");
                }
                if (!problems.isEmpty()) {
                    if (repairs >= budget.schemaRepairs()) {
                        return end(FAILED, "upstream", "the model's answer missed the action schema after a repair: " + problems.get(0));
                    }
                    repairs++;
                    say("Your answer is not a valid action: " + String.join("; ", problems.subList(0, Math.min(3, problems.size())))
                            + ". Answer again with one action that matches the schema.", "repair");
                    continue;
                }
                AgentOutcome end = act(action);
                if (end != null) {
                    return end;
                }
            }
        }

        /** Acts on a valid action: null to call again, or the turn's end. */
        private AgentOutcome act(JsonNode action) {
            return switch (action.path("kind").asText()) {
                case "need_context" -> {
                    context(action);
                    yield null;
                }
                case "propose_design" -> {
                    pendingDesign = action.path("design");
                    say("Design received. Now answer with propose_program: the program that builds it.", "program");
                    yield null;
                }
                case "propose_program" -> {
                    if (pendingDesign == null) {
                        say("propose_program needs a design first: answer with propose_design_and_program.", "next");
                        yield null;
                    }
                    yield propose(pendingDesign, action.path("program"));
                }
                case "propose_design_and_program", "revise" -> propose(action.path("design"), action.path("program"));
                case "ask" -> {
                    String question = action.path("question").asText("");
                    emit("question", "text", question);
                    yield new AgentOutcome(ASKED, null, null, null, null, question, calls, spent);
                }
                case "finish" -> end(FAILED, "finished", action.path("finish").path("summary").asText("the model gave up"));
                default -> {
                    // propose_modules: WGSL is a later step (Q68).
                    say("Modules come later, once a program has passed the check: answer with propose_design_and_program.", "next");
                    yield null;
                }
            };
        }

        private void context(JsonNode action) {
            if (rounds >= budget.contextRounds()) {
                emit("tools", "n", calls, "round", rounds + 1, "results", List.of(), "error", "EA_CONTEXT_LIMIT");
                say("Your " + budget.contextRounds() + " rounds of need_context are used (EA_CONTEXT_LIMIT): propose your design "
                        + "and program with what you have.", "next");
                return;
            }
            List<ToolRequest> requests = new ArrayList<>();
            for (JsonNode r : action.path("context").path("requests")) {
                requests.add(new ToolRequest(text(r, "tool"), text(r, "docId"), text(r, "symbolId"), text(r, "query"),
                        text(r, "family"), number(r, "startLine"), number(r, "lineCount"), text(r, "why")));
            }
            rounds++;
            List<ToolResult> results = tools.round(requests, toolBudget);
            List<Map<String, Object>> summaries = new ArrayList<>();
            for (ToolResult r : results) {
                summaries.add(data("tool", r.tool(), "target", r.target(), "ok", r.ok(), "bytes", r.bytes(), "error", r.error()));
            }
            emit("tools", "n", calls, "round", rounds, "results", summaries);
            StringBuilder s = new StringBuilder("Results of need_context round " + rounds + " of " + budget.contextRounds() + " ("
                    + toolBudget.requestsLeft() + " of " + budget.toolRequests() + " reads and " + toolBudget.bytesLeft() + " of "
                    + budget.docBytes() + " document bytes left):\n");
            for (ToolResult r : results) {
                s.append('\n').append(r.text()).append('\n');
            }
            say(s.toString().stripTrailing(), "after-tools");
        }

        private AgentOutcome propose(JsonNode proposed, JsonNode program) {
            // S is fixed in a revision: the base's design is the one checked and handed off, whatever the answer carried.
            boolean kept = fixedDesign != null && !fixedDesign.equals(proposed);
            JsonNode design = fixedDesign != null ? fixedDesign : proposed;
            ObjectNode proposal = json.createObjectNode();
            proposal.set("design", design);
            proposal.set("program", program);
            List<Finding> findings = new ArrayList<>(check.check(proposal));
            if (kept) {
                findings.add(Finding.warn("design-kept", "/design", "a program revision keeps the design it was given: the design this answer "
                        + "carried differs, and was not used"));
            }
            // What the browser could not read is not handed off: a part past the stream's limit is a finding to revise.
            wireSize("design", design, findings);
            wireSize("program", program, findings);
            baseSize(design, program, findings);
            boolean ok = ProgramCheck.passes(findings);
            List<Map<String, Object>> listed = new ArrayList<>();
            for (Finding f : findings) {
                listed.add(data("level", f.level(), "code", f.code(), "path", f.path(), "message", f.message()));
            }
            emit("check", "n", calls, "ok", ok, "findings", listed);
            if (ok) {
                emit("design", "design", design);
                emit("program", "program", program);
                return new AgentOutcome(HANDED_OFF, null, null, design, program, null, calls, spent);
            }
            if (revisions >= budget.revisions()) {
                return end(EXHAUSTED, "EA_TURN_BUDGET", "EA_TURN_BUDGET: the check still fails after " + revisions + " revisions");
            }
            revisions++;
            StringBuilder s = new StringBuilder("The host's check found what keeps this program from running (revision " + revisions
                    + " of " + budget.revisions() + "). Answer with revise: the whole design and program, corrected.\n");
            for (Finding f : findings) {
                s.append("\n- ").append(f.level()).append(' ').append(f.code()).append(" at ").append(f.path()).append(": ").append(f.message());
            }
            say(s.toString(), "revise");
            return null;
        }

        /**
         * A hand-off no revision could carry fails {@code base-size} (the EA4.4 review): its design and program, as JSON in
         * a base, must leave {@link AgentBase#RESERVE_BYTES} of the base's bound for the pins and a finding.
         */
        private void baseSize(JsonNode design, JsonNode program, List<Finding> findings) {
            int bytes = ModuleRequest.utf8(design.toString()) + ModuleRequest.utf8(program.toString());
            int room = AgentBase.MAX_BASE_BYTES - AgentBase.RESERVE_BYTES;
            if (bytes > room) {
                findings.add(Finding.fail("base-size", "/program", "the design and program are " + bytes + " bytes together as JSON, more than the "
                        + room + " a revision of this world could carry: make them smaller (fewer nodes, shorter configs and strings)"));
            }
        }

        /** A part whose event, {@code {"<name>": part}}, would pass {@link AgentTurn#MAX_EVENT_CHARS} fails {@code wire-size}. */
        private void wireSize(String name, JsonNode part, List<Finding> findings) {
            int chars;
            try {
                chars = json.writeValueAsString(Map.of(name, part)).length();
            } catch (IOException e) {
                throw new IllegalStateException("A parsed part always serializes", e);
            }
            if (chars > AgentTurn.MAX_EVENT_CHARS) {
                findings.add(Finding.fail("wire-size", "/" + name, "the " + name + " is " + chars + " characters as JSON, over the "
                        + AgentTurn.MAX_EVENT_CHARS + " one event may carry: make it smaller (fewer nodes, shorter configs and strings)"));
            }
        }

        /**
         * What an action's kind needs that the schema cannot say: strict output has no {@code oneOf}, so every payload
         * is nullable there (§5.2). An action without its payload goes through the repair, like one off the schema (gate A).
         */
        private List<String> payload(JsonNode action) {
            String kind = action.path("kind").asText();
            List<String> problems = new ArrayList<>();
            switch (kind) {
                case "need_context" -> {
                    if (action.path("context").path("requests").isEmpty()) {
                        problems.add("need_context needs 1 to " + budget.perRound() + " requests in context.requests");
                    }
                }
                case "propose_design" -> needs(action, kind, "design", problems);
                case "propose_program" -> needs(action, kind, "program", problems);
                case "propose_design_and_program", "revise" -> {
                    needs(action, kind, "design", problems);
                    needs(action, kind, "program", problems);
                }
                case "propose_modules" -> {
                    if (action.path("modules").isEmpty()) {
                        problems.add("propose_modules needs its modules");
                    }
                }
                case "ask" -> {
                    if (action.path("question").asText("").isBlank()) {
                        problems.add("ask needs a question");
                    }
                }
                case "finish" -> {
                    if (action.path("finish").path("summary").asText("").isBlank()) {
                        problems.add("finish needs finish.summary, saying why");
                    }
                }
                default -> problems.add("no action is called " + kind);
            }
            return problems;
        }

        private String outOfTime(int n) {
            return "EA_TURN_BUDGET: the turn's " + budget.turnSeconds() + " s ran out during call " + n;
        }

        /** Why the next call may not start, as {@code CODE: reason}; null when every budget allows it. */
        private String refusal() {
            if (calls >= budget.calls()) {
                return "EA_TURN_BUDGET: the turn's " + budget.calls() + " model calls are used";
            }
            if (clockMillis.getAsLong() - started >= budget.turnSeconds() * 1000) {
                return "EA_TURN_BUDGET: the turn's " + budget.turnSeconds() + " s are used";
            }
            int bytes = 0;
            for (ChatMessage m : messages) {
                bytes += m.content().getBytes(StandardCharsets.UTF_8).length;
            }
            if (bytes > budget.promptBytes()) {
                return "EA_CONTEXT_LIMIT: the next call's prompt would be " + bytes + " bytes, over the turn's " + budget.promptBytes();
            }
            long bound = caller.bound(List.copyOf(messages), format);
            if (spent + bound > budget.turnMicroUsd()) {
                return "EA_TURN_BUDGET: the next call could cost up to " + bound + " micro-USD, and the turn has "
                        + (budget.turnMicroUsd() - spent) + " left";
            }
            return null;
        }

        private void say(String text, String next) {
            messages.add(ChatMessage.user(text));
            purpose = next;
        }

        private void emit(String name, Object... pairs) {
            events.accept(new AgentEvent(name, data(pairs)));
        }

        private AgentOutcome end(AgentOutcome.Status status, String code, String reason) {
            return new AgentOutcome(status, code, reason, null, null, null, calls, spent);
        }
    }

    private static Map<String, Object> data(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static void needs(JsonNode action, String kind, String field, List<String> problems) {
        if (!action.path(field).isObject()) {
            problems.add(kind + " needs its " + field);
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isTextual() ? v.asText() : null;
    }

    private static Integer number(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isIntegralNumber() ? v.asInt() : null;
    }

    private JsonNode parse(String text) {
        try {
            return json.readTree(text);
        } catch (IOException e) {
            return null;
        }
    }
}
