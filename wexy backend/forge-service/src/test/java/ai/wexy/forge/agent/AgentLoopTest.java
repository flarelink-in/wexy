package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.ChatMessage;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

import static ai.wexy.forge.agent.AgentOutcome.Status.ASKED;
import static ai.wexy.forge.agent.AgentOutcome.Status.CANCELLED;
import static ai.wexy.forge.agent.AgentOutcome.Status.DENIED;
import static ai.wexy.forge.agent.AgentOutcome.Status.EXHAUSTED;
import static ai.wexy.forge.agent.AgentOutcome.Status.FAILED;
import static ai.wexy.forge.agent.AgentOutcome.Status.HANDED_OFF;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * EA-L1, EA-U4 and EA-U8 (the agent-loop design §2, §6, §12): one turn against a scripted model. Reads run, the check
 * judges each proposal and a failing one is revised, the request travels verbatim in every call, every budget stops the
 * turn before the next call (the script then records no further call), and ask, finish, a repair, a denial, a failure
 * and a cancel each end the turn as §2 says.
 */
class AgentLoopTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final EngineBundle BUNDLE = EngineBundle.load(JSON);
    static final AdapterManifest MANIFEST = AdapterManifest.load(JSON);
    static final JsonSchemas SCHEMAS = new JsonSchemas();
    static final PromptBuilder PROMPTS = new PromptBuilder(new PromptTemplates(Set.of("agent"), "classpath:prompts/",
            new HostContract(), new PathMatchingResourcePatternResolver()));
    static final AgentRequest REQUEST = new AgentRequest("make minecraft 1870s film style, \"sepia\" please", "cinematic", 12);

    private final List<AgentEvent> events = new ArrayList<>();

    /** A model that answers from a list and keeps every message list it was sent. */
    static final class Script implements ModelCaller {
        final Deque<Object> answers = new ArrayDeque<>();
        final List<List<ChatMessage>> seen = new ArrayList<>();
        long bound = 200_000;
        long cost = 50_000;
        Runnable onCall = () -> { };
        final List<Duration> remaining = new ArrayList<>();

        Script(Object... answers) {
            this.answers.addAll(List.of(answers));
        }

        @Override
        public long bound(List<ChatMessage> messages, Map<String, Object> responseFormat) {
            return bound;
        }

        @Override
        public ModelAnswer call(int n, List<ChatMessage> messages, Map<String, Object> responseFormat, Runnable charged,
                                Duration left) {
            seen.add(messages);
            remaining.add(left);
            onCall.run();
            Object next = answers.poll();
            if (next instanceof AgentCallFailure failure) {
                if (!"budget".equals(failure.code()) && !"paused".equals(failure.code())) {
                    charged.run();
                }
                throw failure;
            }
            if (next == null) {
                throw new AssertionError("the script has no answer for call " + n);
            }
            charged.run();
            return new ModelAnswer("gen-" + n, (String) next, "stop", 30_000L, 2_000L, 800L, 0L, cost);
        }
    }

    private AgentOutcome run(Script script) {
        return run(script, AgentBudget.defaults(), () -> 0L);
    }

    private AgentOutcome run(Script script, AgentBudget budget, LongSupplier clock) {
        return new AgentLoop(new AgentTools(BUNDLE), new ProgramCheck(BUNDLE, MANIFEST), SCHEMAS, PROMPTS, budget, clock)
                .run(REQUEST, script, events::add, () -> false);
    }

    private List<String> names() {
        return events.stream().map(AgentEvent::name).toList();
    }

    static ObjectNode action(String kind) {
        ObjectNode a = JSON.createObjectNode().put("kind", kind);
        for (String key : List.of("context", "design", "program", "modules", "revision", "question", "finish")) {
            a.putNull(key);
        }
        return a;
    }

    static String needContext() {
        ObjectNode a = action("need_context");
        ArrayNode requests = a.putObject("context").putArray("requests");
        requests.add(request("read_doc", "agent/guide", null, 1, 5));
        requests.add(request("inspect_api", null, "core:NullGraph", null, null));
        return a.toString();
    }

    static ObjectNode request(String tool, String docId, String symbolId, Integer start, Integer count) {
        ObjectNode r = JSON.createObjectNode().put("tool", tool);
        if (docId == null) r.putNull("docId"); else r.put("docId", docId);
        if (symbolId == null) r.putNull("symbolId"); else r.put("symbolId", symbolId);
        r.putNull("query");
        r.putNull("family");
        if (start == null) r.putNull("startLine"); else r.put("startLine", start);
        if (count == null) r.putNull("lineCount"); else r.put("lineCount", count);
        r.put("why", "test");
        return r;
    }

    /** The complete program of ProgramCheckTest, as the given kind. */
    static String valid(String kind) {
        return ProgramCheckTest.valid().put("kind", kind).toString();
    }

    /** The same, its drawn blocks never filled (zeroed, and nothing writes them): the check fails it (buffer-producer). */
    static String failing() {
        ObjectNode a = ProgramCheckTest.valid();
        ProgramCheckTest.config(a, "blocks", "init", "zero");
        return a.toString();
    }

    @Test
    void aTurnReadsProposesIsCheckedRevisesAndHandsOff() {
        Script script = new Script(needContext(), failing(), valid("revise"));

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(HANDED_OFF);
        assertThat(outcome.calls()).isEqualTo(3);
        assertThat(outcome.costMicroUsd()).isEqualTo(150_000);
        assertThat(outcome.program()).isEqualTo(ProgramCheckTest.valid().path("program"));
        assertThat(names()).containsExactly("call", "usage", "tools", "call", "usage", "check", "call", "usage", "check", "design", "program");
        assertThat(script.seen).extracting(List::size).containsExactly(2, 4, 6);
        assertThat(script.seen.get(0)).extracting(ChatMessage::role).containsExactly("system", "user");
        String afterTools = script.seen.get(1).get(3).content();
        assertThat(afterTools).startsWith("Results of need_context round 1 of 2 (6 of 8 reads and ")
                .contains("<tool_result tool=\"read_doc\" doc=\"agent/guide\"").contains("<tool_result tool=\"inspect_api\" symbol=\"core:NullGraph\"");
        assertThat(script.seen.get(2).get(5).content()).contains("revision 1 of 2").contains("- fail buffer-producer at /program/nodes/0");
        assertThat(events.get(5).data()).containsEntry("ok", false);
        assertThat(events.get(8).data()).containsEntry("ok", true);
    }

    @Test
    void everyCallCarriesTheRequestVerbatimAndLaterCallsTheProposedDesign() throws Exception {
        Script script = new Script(needContext(), failing(), valid("revise"));
        run(script);

        String quoted = JSON.writeValueAsString(REQUEST.prompt());
        for (List<ChatMessage> messages : script.seen) {
            assertThat(messages.get(1).content()).endsWith(quoted).contains("cinematic").contains("12 seconds");
        }
        assertThat(script.seen.get(2).get(4).content()).contains("Blocks under a sepia film.");
    }

    @Test
    void theTurnsCallsAreABudget() {
        Script script = new Script(needContext(), needContext(), needContext());

        AgentOutcome outcome = run(script, new AgentBudget(3, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 300L, 196_608), () -> 0L);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.code()).isEqualTo("EA_TURN_BUDGET");
        assertThat(outcome.reason()).contains("3 model calls");
        assertThat(script.seen).hasSize(3);
    }

    @Test
    void theTurnsMoneyIsCheckedBeforeEachCall() {
        Script script = new Script(needContext(), needContext(), valid("propose_design_and_program"));
        script.bound = 450_000;
        script.cost = 300_000;

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.reason()).contains("could cost up to 450000").contains("400000 left");
        assertThat(script.seen).hasSize(2);
        assertThat(outcome.costMicroUsd()).isEqualTo(600_000);
    }

    @Test
    void theTurnsTimeIsABudget() {
        AtomicLong now = new AtomicLong();
        Script script = new Script(needContext(), needContext(), valid("propose_design_and_program"));
        script.onCall = () -> now.addAndGet(200_000);

        AgentOutcome outcome = run(script, AgentBudget.defaults(), now::get);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.reason()).contains("300 s");
        assertThat(script.seen).hasSize(2);
    }

    @Test
    void aPromptOverItsBudgetIsNeverSent() {
        Script script = new Script(valid("propose_design_and_program"));

        AgentOutcome outcome = run(script, new AgentBudget(6, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 300L, 10_000), () -> 0L);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.code()).isEqualTo("EA_CONTEXT_LIMIT");
        assertThat(script.seen).isEmpty();
        assertThat(events).isEmpty();
    }

    @Test
    void revisionsAreABudget() {
        Script script = new Script(failing(), failing(), failing());

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.reason()).isEqualTo("EA_TURN_BUDGET: the check still fails after 2 revisions");
        assertThat(script.seen).hasSize(3);
    }

    @Test
    void contextRoundsAreABudgetAndTheModelIsToldToPropose() {
        Script script = new Script(needContext(), needContext(), needContext(), valid("propose_design_and_program"));

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(HANDED_OFF);
        List<AgentEvent> tools = events.stream().filter(e -> e.name().equals("tools")).toList();
        assertThat(tools).hasSize(3);
        assertThat(tools.get(2).data()).containsEntry("error", "EA_CONTEXT_LIMIT").containsEntry("results", List.of());
        assertThat(script.seen.get(3).get(7).content()).contains("EA_CONTEXT_LIMIT").contains("propose your design and program");
    }

    @Test
    void askEndsTheTurnWithItsQuestion() {
        ObjectNode ask = action("ask").put("question", "Blocks of stone, or of wood?");

        AgentOutcome outcome = run(new Script(ask.toString()));

        assertThat(outcome.status()).isEqualTo(ASKED);
        assertThat(outcome.question()).isEqualTo("Blocks of stone, or of wood?");
        assertThat(names()).containsExactly("call", "usage", "question");
    }

    @Test
    void finishFailsWithTheModelsReason() {
        ObjectNode finish = action("finish");
        finish.putObject("finish").put("summary", "null-graph has no way to load a Minecraft world file");

        AgentOutcome outcome = run(new Script(finish.toString()));

        assertThat(outcome.status()).isEqualTo(FAILED);
        assertThat(outcome.code()).isEqualTo("finished");
        assertThat(outcome.reason()).isEqualTo("null-graph has no way to load a Minecraft world file");
    }

    @Test
    void anAnswerOffTheSchemaGetsOneRepairThenTheTurnFails() {
        Script script = new Script("Here is my plan: blocks!", "{\"kind\":\"ask\"}");

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(FAILED);
        assertThat(outcome.code()).isEqualTo("upstream");
        assertThat(script.seen).hasSize(2);
        assertThat(script.seen.get(1).get(3).content()).startsWith("Your answer is not a valid action: it is not a JSON object.");

        events.clear();
        assertThat(run(new Script("not json", valid("propose_design_and_program"))).status()).isEqualTo(HANDED_OFF);
    }

    @Test
    void modulesAreForLaterAndADesignMayComeBeforeItsProgram() {
        ObjectNode modules = action("propose_modules");
        modules.putArray("modules").addObject().put("id", "m").put("wgsl", "fn f() {}");
        Script script = new Script(modules.toString(), valid("propose_design_and_program"));
        assertThat(run(script).status()).isEqualTo(HANDED_OFF);
        assertThat(script.seen.get(1).get(3).content()).startsWith("Modules come later");

        ObjectNode design = action("propose_design");
        design.set("design", ProgramCheckTest.valid().path("design"));
        ObjectNode program = action("propose_program");
        program.set("program", ProgramCheckTest.valid().path("program"));
        events.clear();
        AgentOutcome split = run(new Script(design.toString(), program.toString()));
        assertThat(split.status()).isEqualTo(HANDED_OFF);
        assertThat(split.calls()).isEqualTo(2);
    }

    @Test
    void aRefusedFirstCallIsADenialWithNothingSaid() {
        AgentOutcome outcome = run(new Script(new AgentCallFailure("budget", "Live creation has reached its spending limit for now.")));

        assertThat(outcome.status()).isEqualTo(DENIED);
        assertThat(outcome.code()).isEqualTo("budget");
        assertThat(events).isEmpty();
    }

    @Test
    void aLaterFailureFailsTheTurnAndACancelCancelsIt() {
        AgentOutcome failed = run(new Script(needContext(), new AgentCallFailure("upstream", "Meta API answered 502")));
        assertThat(failed.status()).isEqualTo(FAILED);
        assertThat(failed.code()).isEqualTo("upstream");
        assertThat(failed.calls()).isEqualTo(2);
        assertThat(names()).containsExactly("call", "usage", "tools", "call");

        AgentOutcome left = run(new Script(needContext(), new AgentCallFailure("cancelled", "the client left")));
        assertThat(left.status()).isEqualTo(CANCELLED);

        Script script = new Script(needContext(), valid("propose_design_and_program"));
        int[] asked = {0};
        AgentOutcome stopped = new AgentLoop(new AgentTools(BUNDLE), new ProgramCheck(BUNDLE, MANIFEST), SCHEMAS, PROMPTS, AgentBudget.defaults(), () -> 0L)
                .run(REQUEST, script, e -> { }, () -> asked[0]++ >= 1);
        assertThat(stopped.status()).isEqualTo(CANCELLED);
        assertThat(script.seen).hasSize(1);
    }

    // Gate A (agent-loop design §15.1): the review of EA2.2 to EA2.4.

    @Test
    void anAskWithoutAQuestionIsRepairedNotTakenAtItsWord() {
        Script script = new Script(action("ask").toString(), valid("propose_design_and_program"));

        AgentOutcome outcome = run(script);

        assertThat(outcome.status()).isEqualTo(HANDED_OFF);
        assertThat(script.seen.get(1).get(3).content()).startsWith("Your answer is not a valid action:").contains("ask needs a question");
    }

    @Test
    void eachKindNeedsItsOwnPayload() {
        for (String kind : List.of("need_context", "propose_design", "propose_program", "propose_design_and_program", "revise",
                "finish", "propose_modules")) {
            events.clear();
            Script script = new Script(action(kind).toString(), action(kind).toString());

            AgentOutcome outcome = run(script);

            assertThat(outcome.status()).as(kind).isEqualTo(FAILED);
            assertThat(outcome.code()).as(kind).isEqualTo("upstream");
            assertThat(script.seen).as(kind).hasSize(2);
        }
    }

    @Test
    void theTurnsTimeIsADeadlineEvenForACallInFlight() {
        AtomicLong now = new AtomicLong();
        Script script = new Script(valid("propose_design_and_program"));
        script.onCall = () -> now.set(500_000);

        AgentOutcome outcome = run(script, AgentBudget.defaults(), now::get);

        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.code()).isEqualTo("EA_TURN_BUDGET");
        assertThat(names()).doesNotContain("check", "design", "program");
    }

    @Test
    void theCallerIsGivenWhatIsLeftOfTheTurnAndItsDeadlineExhaustsIt() {
        AtomicLong now = new AtomicLong();
        Script script = new Script(needContext(), valid("propose_design_and_program"));
        script.onCall = () -> now.addAndGet(100_000);
        run(script, AgentBudget.defaults(), now::get);
        assertThat(script.remaining).containsExactly(Duration.ofSeconds(300), Duration.ofSeconds(200));

        AgentOutcome ended = run(new Script(needContext(), new AgentCallFailure("deadline", "the turn's time ran out")));
        assertThat(ended.status()).isEqualTo(EXHAUSTED);
        assertThat(ended.code()).isEqualTo("EA_TURN_BUDGET");
    }

    @Test
    void aLineNumberBeyondTheSchemasBoundIsRepairedNotWrapped() {
        ObjectNode read = action("need_context");
        read.putObject("context").putArray("requests").add(request("read_doc", "agent/guide", null, 1, 5).put("startLine", 4_294_967_297L));
        Script script = new Script(read.toString(), valid("propose_design_and_program"));

        run(script);

        // 4294967297 as an int is 1, which would read the guide's first lines; the schema's bound refuses it first.
        assertThat(script.seen.get(1).get(3).content()).startsWith("Your answer is not a valid action:")
                .contains("startLine: must have a maximum value of 100000").doesNotContain("<tool_result");
    }

    @Test
    void twoTurnsAtOnceKeepTheirOwnCounters() throws Exception {
        AgentLoop loop = new AgentLoop(new AgentTools(BUNDLE), new ProgramCheck(BUNDLE, MANIFEST), SCHEMAS, PROMPTS, AgentBudget.defaults(), () -> 0L);
        Script first = new Script(needContext(), failing(), valid("revise"));
        Script second = new Script(valid("propose_design_and_program"));
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var a = pool.submit(() -> loop.run(REQUEST, first, e -> { }, () -> false));
            var b = pool.submit(() -> loop.run(REQUEST, second, e -> { }, () -> false));

            assertThat(a.get().status()).isEqualTo(HANDED_OFF);
            assertThat(a.get().calls()).isEqualTo(3);
            assertThat(b.get().status()).isEqualTo(HANDED_OFF);
            assertThat(b.get().calls()).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aBudgetOutsideItsBoundsIsRefusedAndTheCallsMatchTheGatewaysCost() {
        assertThat(AgentBudget.defaults().calls()).isEqualTo(ai.wexy.common.AgentTurn.MAX_CALLS);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new AgentBudget(7, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 300L, 196_608))
                .hasMessageContaining("at most 6");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new AgentBudget(0, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 300L, 196_608))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new AgentBudget(6, 2, 6, 8, 0, 2, 1, 1_000_000L, 300L, 196_608))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new AgentBudget(6, 2, 6, 8, 65_536, -1, 1, 1_000_000L, 300L, 196_608))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // EA2.5's review: one wire limit for both sides (AgentTurn.MAX_EVENT_CHARS).

    @Test
    void aProgramTooLargeForTheStreamIsRevisedNotHandedOff() {
        // Schema-valid: 16 nodes, each config 4,096 code points. A control character is six characters as JSON, so the
        // program's event would be about 395,000 characters, past what the browser reads.
        ObjectNode big = ProgramCheckTest.valid().put("kind", "propose_design_and_program");
        ArrayNode nodes = ProgramCheckTest.nodes(big);
        for (int i = 0; nodes.size() < 16; i++) {
            nodes.add(NodeCheckTest.node("pad" + i, "ng.geometry.primitive", Map.of("shape", "cube", "size", 1, "segments", 3)));
        }
        String control = "\u0001".repeat(4096);
        for (var node : nodes) {
            ((ObjectNode) node).put("config", control);
        }
        assertThat(SCHEMAS.validate(JsonSchemas.AGENT_ACTION, big)).isEmpty();
        Script script = new Script(big.toString(), valid("revise"));

        AgentOutcome outcome = run(script);

        // Never handed off: the check fails it. An answer that long has also passed the turn's prompt bytes, as any
        // must (a model's own text is no shorter than its JSON), so the revision is refused before it is called.
        assertThat(names()).containsExactly("call", "usage", "check");
        assertThat(events.get(2).data()).containsEntry("ok", false);
        assertThat(events.get(2).data().get("findings").toString()).contains("code=wire-size, path=/program");
        assertThat(outcome.status()).isEqualTo(EXHAUSTED);
        assertThat(outcome.code()).isEqualTo("EA_CONTEXT_LIMIT");
        assertThat(script.seen).hasSize(1);
    }
}
