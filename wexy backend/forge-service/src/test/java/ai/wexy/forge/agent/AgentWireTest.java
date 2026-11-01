package ai.wexy.forge.agent;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ErrorEnvelopeHandler;
import ai.wexy.forge.identity.InternalTokenFilter;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendProperties;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MetaApiProperties;
import ai.wexy.forge.upstream.MeteredModelClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.springframework.web.reactive.function.server.RouterFunctions;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The agent turn's wire, pinned (the agent-loop design §5.4; gate B1 of §15.1): {@code POST /v1/agent/turn} over a real
 * server, against the fake Meta API and the in-memory meter, once for each way a turn ends, with the response's bytes
 * compared to the recordings under {@code src/test/resources/agent/wire/}.
 *
 * <p>The frontend reads its turns from byte-for-byte copies of these recordings (its {@code test/fixtures/agent-wire/},
 * compared with these when both repositories are on one disk). So a change to an event's name, a field or their order
 * fails here first, and is a contract change for both repositories on the same day (design guidelines §1). A run mints
 * its ids, so a recording names the turn {@code turn-1} and its calls {@code gen-1}, {@code gen-2}… in the order they
 * appear; a heartbeat is timing, not contract, so none is recorded. Run with {@code -Dwexy.wire.write=true} to write
 * the recordings instead of comparing them, then copy them to the frontend.
 */
class AgentWireTest {

    static final Path RECORDINGS = Path.of("src/test/resources/agent/wire");
    static final boolean WRITE = Boolean.getBoolean("wexy.wire.write");
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newHttpClient();
    /** The role's model and prices as production configures them (application.yaml), with a test's deadline. */
    static final String MODEL = "muse-spark-1.3";
    static final String BODY = "{\"prompt\":\"make minecraft 1870s film style\",\"style\":\"cinematic\",\"seconds\":12}";
    static final Pattern ID = Pattern.compile("\"(turnId|generationId)\":\"([^\"]+)\"");
    static final Pattern HEARTBEAT = Pattern.compile("(?m)^:hb\n\n");
    static final Pattern EVENT = Pattern.compile("(?m)^event:(.*)$");

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();
    PromptBuilder prompts;
    ModelCatalog catalog;
    private DisposableServer server;
    private String baseUrl;

    /** What the server answered: its status and its body, as bytes decoded once. */
    record Answer(int status, String body) {
    }

    @AfterEach
    void stop() {
        if (server != null) {
            server.disposeNow();
        }
        fake.close();
    }

    private void start(long sparkDailyCapMicroUsd, AgentBudget budget) {
        StringRedisTemplate template = ledger.template(0);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, sparkDailyCapMicroUsd))), new SimpleMeterRegistry());
        catalog = new ModelCatalog(new ModelProperties(
                Map.of("agent", new ModelProperties.Role(MODEL, "meta-spark", 16000, Duration.ofSeconds(10), "medium", null)),
                Map.of(MODEL, new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"), new BigDecimal("0.15")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2),
                Duration.ofSeconds(5)), new ObjectMapper(), WebClient.builder());
        prompts = new PromptBuilder(new PromptTemplates(Set.of("agent"), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver()));
        InMemoryGenerationStore store = new InMemoryGenerationStore(100, Duration.ofHours(2), Clock.systemUTC());
        EngineBundle bundle = EngineBundle.load(JSON);
        AgentLoop loop = new AgentLoop(new AgentTools(bundle), new ProgramCheck(bundle, AdapterManifest.load(JSON)), new JsonSchemas(), prompts,
                budget, System::currentTimeMillis);
        // A heartbeat every ten minutes: none comes within a test's turn.
        AgentHandler handler = new AgentHandler(loop, new MeteredModelClient(api, catalog, guard), catalog, store,
                new LoopProperties(null, Duration.ofMinutes(10), null, false), bundle);
        HttpHandler http = RouterFunctions.toHttpHandler(new AgentConfiguration().agentRoutes(handler), HandlerStrategies.builder()
                .webFilter(new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(AgentRoutesTest.GATEWAY.toPublicJWK()))))
                .exceptionHandler(new ErrorEnvelopeHandler())
                .build());
        server = HttpServer.create().host("127.0.0.1").port(0).handle(new ReactorHttpHandlerAdapter(http)).bindNow();
        baseUrl = "http://127.0.0.1:" + server.port();
    }

    /** The fake answers each call with the next text, in a few chunks, a stop and (when given) the usage. */
    private void answers(String usage, String... texts) {
        AtomicInteger n = new AtomicInteger();
        fake.chat = (exchange, request) -> {
            String text = texts[Math.min(n.getAndIncrement(), texts.length - 1)];
            FakeMetaApi.sse(0, AgentRoutesTest.streamOf(text, usage)).respond(exchange, request);
        };
    }

    /** One turn, read raw: the bytes the studio's reader is given, not events a client decoded. */
    private Answer turn() throws Exception {
        return turn(BODY);
    }

    private Answer turn(String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/agent/turn"))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .header(InternalToken.HEADER, AgentRoutesTest.token("uid-agent"))
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new Answer(response.statusCode(), response.body());
    }

    /** A streamed turn, its ids named and its heartbeats dropped. */
    private String streamed() throws Exception {
        return streamed(BODY);
    }

    private String streamed(String body) throws Exception {
        Answer answer = turn(body);
        assertThat(answer.status()).as(answer.body()).isEqualTo(200);
        return wire(answer.body());
    }

    /** The ids a run mints, named in the order they appear ({@code turn-1}; {@code gen-1}, {@code gen-2}…); no heartbeats. */
    static String wire(String body) {
        Map<String, String> names = new LinkedHashMap<>();
        Matcher m = ID.matcher(body);
        int calls = 0;
        while (m.find()) {
            if (!names.containsKey(m.group(2))) {
                names.put(m.group(2), "turnId".equals(m.group(1)) ? "turn-1" : "gen-" + ++calls);
            }
        }
        String out = body;
        for (Map.Entry<String, String> e : names.entrySet()) {
            out = out.replace(e.getKey(), e.getValue());
        }
        return HEARTBEAT.matcher(out).replaceAll("");
    }

    static List<String> events(String wire) {
        List<String> names = new ArrayList<>();
        Matcher m = EVENT.matcher(wire);
        while (m.find()) {
            names.add(m.group(1));
        }
        return names;
    }

    /** The text as recorded: compared with its recording, or written over it with -Dwexy.wire.write=true. */
    private static void pin(String name, String text) throws Exception {
        Path file = RECORDINGS.resolve(name);
        if (WRITE) {
            Files.createDirectories(RECORDINGS);
            Files.writeString(file, text, StandardCharsets.UTF_8);
            return;
        }
        assertThat(file).as("the recording %s: write it with -Dwexy.wire.write=true", name).exists();
        assertThat(text).isEqualTo(Files.readString(file, StandardCharsets.UTF_8).replace("\r\n", "\n"));
    }

    private void start() {
        start(5_000_000L, AgentBudget.defaults());
    }

    @Test
    void aTurnThatReadsProposesIsRevisedAndHandsOff() throws Exception {
        start();
        answers(AgentRoutesTest.USAGE, AgentLoopTest.needContext(), AgentLoopTest.failing(), AgentLoopTest.valid("revise"));

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "tools", "call", "usage", "check", "call", "usage",
                "check", "design", "program", "done");
        assertThat(wire).contains("\"status\":\"handed-off\"").contains("\"ok\":false").contains("\"ok\":true");
        pin("handed-off.sse", wire);
    }

    /** EA4.4 (Q82 (a)): a turn that revises a base the browser refused, its first call the revise, its design the base's. */
    @Test
    void aTurnThatRevisesABaseHandsOffItsProgramWithItsDesign() throws Exception {
        start();
        answers(AgentRoutesTest.USAGE, AgentLoopTest.valid("revise"));
        ObjectNode body = (ObjectNode) JSON.readTree(BODY);
        body.set("base", AgentLoopTest.baseJson());

        String wire = streamed(body.toString());

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "check", "design", "program", "done");
        assertThat(wire).contains("\"purpose\":\"revise\"").contains("\"status\":\"handed-off\"").contains("placeBlocks");
        pin("revised.sse", wire);
    }

    @Test
    void aTurnThatAsks() throws Exception {
        start();
        ObjectNode ask = AgentLoopTest.action("ask").put("question", "Blocks of stone, or of wood — and does the river run?");
        answers(AgentRoutesTest.USAGE, ask.toString());

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "question", "done");
        assertThat(wire).contains("\"status\":\"asked\"");
        pin("asked.sse", wire);
    }

    @Test
    void aTurnTheModelDeclines() throws Exception {
        start();
        ObjectNode finish = AgentLoopTest.action("finish");
        finish.putObject("finish").put("summary", "That names no place or thing to show — I can't build a world from it.");
        answers(AgentRoutesTest.USAGE, finish.toString());

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "done");
        assertThat(wire).contains("\"status\":\"declined\"");
        pin("declined.sse", wire);
    }

    @Test
    void aTurnWhoseProgramStillFailsAfterItsRevisions() throws Exception {
        start();
        answers(AgentRoutesTest.USAGE, AgentLoopTest.failing(), AgentLoopTest.failing(), AgentLoopTest.failing());

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "check", "call", "usage", "check", "call", "usage",
                "check", "done");
        assertThat(wire).contains("\"status\":\"exhausted\"").contains("EA_TURN_BUDGET: the check still fails after 2 revisions");
        pin("exhausted-revisions.sse", wire);
    }

    @Test
    void aTurnWhoseTimeEndsInsideACall() throws Exception {
        start(5_000_000L, new AgentBudget(6, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 1L, 196_608));
        // About 9 s of stream against a turn of 1 s: the call is cut, and has no usage.
        fake.chat = FakeMetaApi.sse(1_500, AgentRoutesTest.streamOf(AgentLoopTest.needContext(), AgentRoutesTest.USAGE));

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "done");
        assertThat(wire).contains("EA_TURN_BUDGET: the turn's 1 s ran out during call 1");
        pin("exhausted-deadline.sse", wire);
    }

    @Test
    void aTurnPastItsContextRoundsStillHandsOff() throws Exception {
        start();
        answers(AgentRoutesTest.USAGE, AgentLoopTest.needContext(), AgentLoopTest.needContext(), AgentLoopTest.needContext(),
                AgentLoopTest.valid("propose_design_and_program"));

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "tools", "call", "usage", "tools", "call", "usage",
                "tools", "call", "usage", "check", "design", "program", "done");
        assertThat(wire).contains("\"results\":[],\"error\":\"EA_CONTEXT_LIMIT\"");
        pin("context-limit.sse", wire);
    }

    @Test
    void aTurnWhoseLaterChargeIsRefused() throws Exception {
        start();
        AgentBudget budget = AgentBudget.defaults();
        var messages = prompts.agent("make minecraft 1870s film style", "cinematic", 12, budget.describe()).messages();
        Map<String, Object> format = AgentLoop.responseFormat(new JsonSchemas());
        long bound = catalog.upperBoundMicroUsd(MODEL, ModelCatalog.inputTokenBound(messages, format), 16000);
        server.disposeNow();
        // Room for the first call's reservation, which stands (no usage comes, Q43), but not for the second's.
        start(bound + bound / 2, budget);
        answers(null, AgentLoopTest.needContext(), AgentLoopTest.valid("propose_design_and_program"));

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "tools", "error");
        assertThat(wire).contains("\"in\":null").contains("\"code\":\"budget\"");
        pin("error-budget.sse", wire);
    }

    @Test
    void aTurnWhoseAnswersMissTheSchemaTwice() throws Exception {
        start();
        answers(AgentRoutesTest.USAGE, "Here is my plan: blocks!", "Blocks, then.");

        String wire = streamed();

        assertThat(events(wire)).containsExactly("meta", "call", "usage", "call", "usage", "error");
        assertThat(wire).contains("\"purpose\":\"repair\"").contains("\"code\":\"upstream\"");
        pin("error-upstream.sse", wire);
    }

    @Test
    void aTurnWhoseFirstChargeIsRefusedIsAnEnvelope() throws Exception {
        start(10L, AgentBudget.defaults());
        answers(AgentRoutesTest.USAGE, AgentLoopTest.valid("propose_design_and_program"));

        Answer answer = turn();

        assertThat(answer.status()).isEqualTo(503);
        assertThat(fake.chatRequests()).isZero();
        ObjectNode recorded = JSON.createObjectNode().put("status", answer.status());
        recorded.set("body", JSON.readTree(answer.body()));
        assertThat(recorded.path("body").path("code").asText()).isEqualTo("budget");
        pin("denied.json", recorded + "\n");
    }
}
