package ai.wexy.forge.agent;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ErrorEnvelopeHandler;
import ai.wexy.forge.allowance.TestAdmissions;
import ai.wexy.forge.identity.InternalTokenFilter;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendLanes;
import ai.wexy.forge.spend.SpendProperties;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MetaApiProperties;
import ai.wexy.forge.upstream.MeteredModelClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.springframework.web.reactive.function.server.RouterFunctions;
import reactor.core.Disposable;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * R-A1 to R-A3 and EA-U9 (the agent-loop design §10, §12): {@code POST /v1/agent/turn} over a real server, through the
 * identity filter and the error envelope, against the fake Meta API and the in-memory meter. A turn streams its events
 * with one terminal; a refused first charge is a status with nothing sent upstream; a refused later charge ends the
 * stream with nothing more sent; a client that leaves cancels the call in flight; a request with an image, or past its
 * caps, is refused before any charge. Each call is an {@code AGENT} record under the turn. A revision's base (EA-MR,
 * EA4.4) is checked whole before anything is recorded or charged, then revised with its design kept.
 */
class AgentRoutesTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final ParameterizedTypeReference<ServerSentEvent<String>> EVENTS = new ParameterizedTypeReference<>() {
    };
    static final RSAKey GATEWAY = key();
    static final String READ = resource("mock/agent/need-context.json").strip();
    static final String PROGRAM = resource("mock/agent/program.json").strip();
    static final String STOP = "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";
    static final String USAGE = "{\"choices\":[],\"usage\":{\"prompt_tokens\":30000,\"completion_tokens\":2000,\"total_tokens\":32000,"
            + "\"completion_tokens_details\":{\"reasoning_tokens\":800}}}";
    static final Map<String, Object> BODY = Map.of("prompt", "make minecraft 1870s film style", "style", "cinematic", "seconds", 12);

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();
    InMemoryGenerationStore store;
    ModelCatalog catalog;
    PromptBuilder prompts;
    WebTestClient client;
    WebClient raw;
    AgentHandler handler;
    MeteredModelClient models;
    /** The turn's admission (W1): wide, so these tests are about the turn; AllowanceRoutesTest holds the allowances. */
    TestAdmissions.Admit admit = TestAdmissions.open();
    private DisposableServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.disposeNow();
        }
        fake.close();
    }

    private void start(long sparkDailyCapMicroUsd) {
        start(sparkDailyCapMicroUsd, 0);
    }

    private void start(long sparkDailyCapMicroUsd, long meterDelayMillis) {
        start(sparkDailyCapMicroUsd, meterDelayMillis, AgentBudget.defaults());
    }

    /** @param meterDelayMillis how long the meter takes to answer a reservation */
    private void start(long sparkDailyCapMicroUsd, long meterDelayMillis, AgentBudget budget) {
        StringRedisTemplate template = ledger.template(meterDelayMillis);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, sparkDailyCapMicroUsd)), SpendLanes.open()), new SimpleMeterRegistry());
        catalog = new ModelCatalog(new ModelProperties(
                Map.of("agent", new ModelProperties.Role("m-1", "meta-spark", 16000, Duration.ofSeconds(10), "medium", null)),
                Map.of("m-1", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2),
                Duration.ofSeconds(5)), new ObjectMapper(), WebClient.builder());
        prompts = new PromptBuilder(new PromptTemplates(Set.of("agent"), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver()));
        store = new InMemoryGenerationStore(100, Duration.ofHours(2), Clock.systemUTC());
        EngineBundle bundle = EngineBundle.load(JSON);
        AgentLoop loop = new AgentLoop(new AgentTools(bundle), new ProgramCheck(bundle, AdapterManifest.load(JSON)), new JsonSchemas(), prompts,
                budget, System::currentTimeMillis);
        models = new MeteredModelClient(api, catalog, guard);
        handler = new AgentHandler(loop, models, catalog, store,
                new LoopProperties(null, Duration.ofMillis(50), null, false), bundle, admit.admission());
        HttpHandler http = RouterFunctions.toHttpHandler(new AgentConfiguration().agentRoutes(handler), HandlerStrategies.builder()
                .webFilter(new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(GATEWAY.toPublicJWK()))))
                .exceptionHandler(new ErrorEnvelopeHandler())
                .build());
        server = HttpServer.create().host("127.0.0.1").port(0).handle(new ReactorHttpHandlerAdapter(http)).bindNow();
        String baseUrl = "http://127.0.0.1:" + server.port();
        client = WebTestClient.bindToServer().baseUrl(baseUrl).responseTimeout(Duration.ofSeconds(30)).build();
        raw = WebClient.builder().baseUrl(baseUrl).build();
    }

    /** The fake answers each call with the next text, in a few chunks, a stop and (when given) the usage. */
    private void answers(String usage, String... texts) {
        AtomicInteger n = new AtomicInteger();
        fake.chat = (exchange, request) -> {
            String text = texts[Math.min(n.getAndIncrement(), texts.length - 1)];
            FakeMetaApi.sse(0, streamOf(text, usage)).respond(exchange, request);
        };
    }

    private WebTestClient.ResponseSpec post(Object body) {
        return post(body, token("uid-agent"));
    }

    /** As {@link #post(Object)}, as the caller `token` names. */
    private WebTestClient.ResponseSpec post(Object body, String token) {
        return client.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token).bodyValue(body).exchange();
    }

    private List<ServerSentEvent<String>> stream(Object body) {
        return stream(body, token("uid-agent"));
    }

    private List<ServerSentEvent<String>> stream(Object body, String token) {
        return post(body, token).expectStatus().isOk().returnResult(EVENTS).getResponseBody().collectList().block(Duration.ofSeconds(30));
    }

    static List<String> names(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> e.event() != null).map(ServerSentEvent::event).toList();
    }

    static JsonNode data(List<ServerSentEvent<String>> events, String name) throws Exception {
        for (ServerSentEvent<String> e : events) {
            if (name.equals(e.event())) {
                return JSON.readTree(e.data());
            }
        }
        throw new AssertionError("no " + name + " event in " + names(events));
    }

    private List<Generation> agentCalls() {
        return store.snapshot().stream().filter(g -> g.kind() == Generation.Kind.AGENT).toList();
    }

    /** What the loop's first call reserves: its messages and the action schema, at the role's whole cap. */
    private long firstBound() {
        AgentBudget budget = AgentBudget.defaults();
        var messages = prompts.agent((String) BODY.get("prompt"), (String) BODY.get("style"), (Integer) BODY.get("seconds"),
                budget.describe()).messages();
        Map<String, Object> format = AgentLoop.responseFormat(new JsonSchemas());
        return catalog.upperBoundMicroUsd("m-1", ModelCatalog.inputTokenBound(messages, format), 16000);
    }

    @Test
    void aTurnStreamsItsEventsWithOneTerminalAndRecordsEachCall() throws Exception {
        start(5_000_000L);
        answers(USAGE, READ, PROGRAM);

        List<ServerSentEvent<String>> events = stream(BODY);

        assertThat(names(events)).containsExactly("meta", "call", "usage", "tools", "call", "usage", "check", "design", "program", "done");
        JsonNode meta = data(events, "meta");
        assertThat(meta.path("promptVersion").asText()).isEqualTo("agent.v6");
        // EA3.6: the action's contract and the adapter manifest its program was checked against (v3 since EA6.3).
        assertThat(meta.path("actionSchema").asText()).isEqualTo("agent-action.v3");
        assertThat(meta.path("manifestHash").asText()).isEqualTo(AdapterManifest.HASH);
        assertThat(meta.path("model").asText()).isEqualTo("m-1");
        assertThat(meta.path("bundleHash").asText()).matches("[0-9a-f]{64}");
        assertThat(data(events, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(data(events, "check").path("ok").asBoolean()).isTrue();
        assertThat(data(events, "tools").path("results")).hasSize(2);
        assertThat(fake.chatRequests()).isEqualTo(2);
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions"))
                .allMatch(r -> r.body().contains("agent_action_v3") && r.body().contains("\"strict\":true"));

        List<Generation> calls = agentCalls();
        assertThat(calls).hasSize(2).allMatch(g -> g.status() == Generation.Status.OK && g.role().equals("agent")
                && g.parentId().equals(meta.path("turnId").asText()) && g.uid().equals("uid-agent"));
        assertThat(calls).extracting(Generation::promptVersion).containsOnly("agent.v6");
        assertThat(ledger.reservations()).isEqualTo(2);
    }

    @Test
    void aRefusedFirstChargeIsAStatusWithNothingSentUpstream() {
        start(10L);
        answers(USAGE, PROGRAM);

        post(BODY).expectStatus().isEqualTo(503).expectBody().jsonPath("$.code").isEqualTo("budget");

        assertThat(fake.chatRequests()).isZero();
        assertThat(agentCalls()).singleElement().matches(g -> g.status() == Generation.Status.DENIED);
    }

    @Test
    void aRefusedLaterChargeEndsTheStreamWithBudgetAndSendsNothingMore() throws Exception {
        start(5_000_000L);
        long bound = firstBound();
        server.disposeNow();
        // Room for the first call's reservation, which stands (no usage comes, Q43), but not for the second's, which is
        // larger. Starting a server touched nothing in the ledger.
        start(bound + bound / 2);
        answers(null, READ, PROGRAM);

        List<ServerSentEvent<String>> events = stream(BODY);

        assertThat(names(events)).containsExactly("meta", "call", "usage", "tools", "error");
        assertThat(data(events, "error").path("code").asText()).isEqualTo("budget");
        assertThat(fake.chatRequests()).isEqualTo(1);
        assertThat(agentCalls()).extracting(Generation::status).containsExactlyInAnyOrder(Generation.Status.OK, Generation.Status.DENIED);
    }

    @Test
    void aClientThatLeavesMidCallCancelsItAndNoLaterCallStarts() throws Exception {
        start(5_000_000L);
        String[] slow = streamOf(READ, USAGE);
        fake.chat = FakeMetaApi.sse(400, slow);

        Disposable request = raw.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token("uid-agent")).bodyValue(BODY)
                .retrieve().bodyToFlux(EVENTS).subscribe();
        await(Duration.ofSeconds(10), () -> fake.chatRequests() == 1);
        Thread.sleep(300);
        request.dispose();

        await(Duration.ofSeconds(10), () -> !agentCalls().isEmpty() && agentCalls().get(0).status() != Generation.Status.RUNNING);
        await(Duration.ofSeconds(10), fake::clientWentAway);
        assertThat(agentCalls()).singleElement().matches(g -> g.status() == Generation.Status.CANCELLED);
        assertThat(fake.clientWentAway()).isTrue();
        Thread.sleep(500);
        assertThat(fake.chatRequests()).isEqualTo(1);
    }

    @Test
    void anImageAPromptOverItsCapOrAStrayFieldIsRefusedBeforeAnyCharge() {
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        ObjectNode image = JSON.valueToTree(BODY);
        image.put("image", "data:image/png;base64,iVBORw0KGgo=");
        ObjectNode longPrompt = JSON.valueToTree(BODY);
        longPrompt.put("prompt", "x".repeat(601));
        ObjectNode budget = JSON.valueToTree(BODY);
        budget.put("budget", 100);

        post(image).expectStatus().isEqualTo(400).expectBody().jsonPath("$.code").isEqualTo("bad-request");
        post(longPrompt).expectStatus().isEqualTo(413);
        post(budget).expectStatus().isEqualTo(400);

        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).isEmpty();
        assertThat(ledger.untouched()).isTrue();
        assertThat(agentCalls()).isEmpty();
    }

    // Gate A (agent-loop design §15.1): the review of EA2.2 to EA2.4.

    /** The handler's request without a server, as the identity filter would leave it. */
    private static org.springframework.web.reactive.function.server.ServerRequest request(Object body) {
        org.springframework.mock.web.server.MockServerWebExchange exchange = org.springframework.mock.web.server.MockServerWebExchange
                .from(org.springframework.mock.http.server.reactive.MockServerHttpRequest.post("/v1/agent/turn"));
        exchange.getAttributes().put(InternalTokenFilter.CALLER_ATTRIBUTE, new ai.wexy.forge.identity.Caller("uid-agent", true, false, "anonymous", TestAdmissions.NETWORK));
        return org.springframework.mock.web.reactive.function.server.MockServerRequest.builder().exchange(exchange)
                .method(org.springframework.http.HttpMethod.POST).uri(java.net.URI.create("/v1/agent/turn"))
                .body(reactor.core.publisher.Mono.just(JSON.valueToTree(body)));
    }

    @Test
    void aClientThatLeavesBeforeTheFirstChargeIsAnsweredCancelsTheTurn() throws Exception {
        start(5_000_000L, 1_500);
        answers(USAGE, READ, PROGRAM);

        Disposable pending = handler.turn(request(BODY)).subscribe();
        Thread.sleep(300);
        pending.dispose();

        await(Duration.ofSeconds(10), () -> !agentCalls().isEmpty() && agentCalls().get(0).status() != Generation.Status.RUNNING);
        Thread.sleep(500);
        assertThat(agentCalls()).singleElement().matches(g -> g.status() == Generation.Status.CANCELLED);
        assertThat(fake.chatRequests()).isZero();
    }

    @Test
    void theTurnsTimeEndsACallStillStreaming() throws Exception {
        start(5_000_000L, 0, new AgentBudget(6, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 1L, 196_608));
        // About 9 s of stream against a turn of 1 s, and a role's deadline of 10 s (25 s with the margin).
        fake.chat = FakeMetaApi.sse(1_500, streamOf(READ, USAGE));

        long started = System.nanoTime();
        List<ServerSentEvent<String>> events = stream(BODY);

        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
        assertThat(names(events)).containsExactly("meta", "call", "done");
        assertThat(data(events, "done").path("status").asText()).isEqualTo("exhausted");
        assertThat(data(events, "done").path("reason").asText()).isEqualTo("EA_TURN_BUDGET: the turn's 1 s ran out during call 1");
        await(Duration.ofSeconds(10), fake::clientWentAway);
        assertThat(fake.clientWentAway()).isTrue();
        assertThat(agentCalls()).singleElement().matches(g -> g.status() == Generation.Status.TIMEOUT);
        assertThat(fake.chatRequests()).isEqualTo(1);
    }

    @Test
    void aCallWithNoTimeLeftIsRefusedBeforeAnythingIsChargedOrRecorded() {
        start(5_000_000L);
        MeteredModelCaller calls = new MeteredModelCaller(models, catalog, store, "turn-1",
                new ai.wexy.forge.identity.Caller("uid-agent", true, false, "anonymous", TestAdmissions.NETWORK), "{}", "agent.v3", HostContract.VERSION);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> calls.call(1, List.of(ai.wexy.forge.upstream.ChatMessage.user("x")),
                        null, () -> { }, Duration.ZERO))
                .isInstanceOfSatisfying(AgentCallFailure.class, f -> assertThat(f.code()).isEqualTo("deadline"));

        assertThat(ledger.untouched()).isTrue();
        assertThat(agentCalls()).isEmpty();
        assertThat(fake.chatRequests()).isZero();
    }

    @Test
    void secondsBeyondAnIntAreRefusedNotWrapped() {
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        ObjectNode body = JSON.valueToTree(BODY);
        body.put("seconds", 4_294_967_308L);

        post(body).expectStatus().isEqualTo(400);

        assertThat(ledger.untouched()).isTrue();
        assertThat(agentCalls()).isEmpty();
    }

    // EA-MR (EA4.4; the frontend's candidate-loop design §8, Q82 (a)): a turn that revises a base.

    /** The turn's body with a base, {@code change}d first. */
    private static ObjectNode revision(java.util.function.Consumer<ObjectNode> change) {
        ObjectNode body = JSON.valueToTree(BODY);
        ObjectNode base = AgentLoopTest.baseJson();
        change.accept(base);
        body.set("base", base);
        return body;
    }

    @Test
    void aRevisionTurnRevisesItsBaseAndHandsOffWithItsDesign() throws Exception {
        start(5_000_000L);
        answers(USAGE, AgentLoopTest.valid("revise"));

        List<ServerSentEvent<String>> events = stream(revision(base -> { }));

        // A revision says which modules' code must change, after its program (EA6.3): here none.
        assertThat(names(events)).containsExactly("meta", "call", "usage", "check", "design", "program", "repairs", "done");
        assertThat(data(events, "repairs").path("repairs").isArray()).isTrue();
        assertThat(data(events, "repairs").path("repairs")).isEmpty();
        assertThat(data(events, "meta").path("promptVersion").asText()).isEqualTo("agent.v6");
        assertThat(data(events, "call").path("purpose").asText()).isEqualTo("revise");
        assertThat(data(events, "design").path("design")).isEqualTo(AgentLoopTest.baseJson().path("design"));
        assertThat(data(events, "done").path("status").asText()).isEqualTo("handed-off");
        // The model was sent R and then the base, as data: its program and the browser's finding.
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).singleElement()
                .matches(r -> r.body().contains("This turn revises a program an earlier turn handed off.") && r.body().contains("step cannot be an entry"));
        // One record, the turn's request with its base as the input.
        assertThat(agentCalls()).singleElement().matches(g -> g.status() == Generation.Status.OK && g.input().contains("\"base\"")
                && g.promptVersion().equals("agent.v6"));
    }

    /** W1 (the creations platform design §10): a base may name the turn it revises; the revision runs as before. */
    @Test
    void aRevisionsBaseMayNameTheTurnItRevises() throws Exception {
        start(5_000_000L);
        answers(USAGE, AgentLoopTest.valid("revise"));

        List<ServerSentEvent<String>> events = stream(revision(base -> base.put("turnId", "01JD0000000000000000000000")));

        // As every revision's since EA6.3: its notes to its modules, `repairs`, before the end (empty here).
        assertThat(names(events)).containsExactly("meta", "call", "usage", "check", "design", "program", "repairs", "done");
        assertThat(data(events, "done").path("status").asText()).isEqualTo("handed-off");
        // The id is the allowance's, never the model's: it reaches no prompt.
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).singleElement()
                .matches(r -> !r.body().contains("01JD0000000000000000000000"));
    }

    @Test
    void aRevisionsBaseIsCheckedWholeBeforeAnythingIsRecordedOrCharged() throws Exception {
        start(5_000_000L);
        answers(USAGE, AgentLoopTest.valid("revise"));
        ObjectNode nullBase = JSON.valueToTree(BODY);
        nullBase.putNull("base");

        refused(nullBase, 400, "base is a revision's versions, design, program and findings");
        refused(revision(b -> b.remove("findings")), 400, "base takes exactly versions, design, program, findings (and optionally turnId); findings missing");
        refused(revision(b -> b.put("prompt", "again")), 400, "base takes exactly versions, design, program, findings (and optionally turnId); not prompt");
        // W1: the turn a base revises is a ULID as its meta named it; anything else is the client's bug, said, never a prompt.
        refused(revision(b -> b.put("turnId", "turn-1")), 400, "base.turnId is the turn this one revises, a ULID as its meta named it, not \"turn-1\"");
        refused(revision(b -> b.put("turnId", 7)), 400, "base.turnId is the turn this one revises");
        refused(revision(b -> b.putNull("turnId")), 400, "base.turnId is the turn this one revises");
        refused(revision(b -> ((ObjectNode) b.path("versions")).put("manifest", "0".repeat(64))), 400,
                "base.versions.manifest is \"" + "0".repeat(64) + "\"; this server speaks " + AdapterManifest.HASH);
        refused(revision(b -> ((ObjectNode) b.path("versions")).put("actionSchema", "agent-action.v1")), 400,
                "base.versions.actionSchema is \"agent-action.v1\"; this server speaks agent-action.v3");
        refused(revision(b -> ((ObjectNode) b.path("design")).put("mood", "sepia")), 400, "base does not fit agent-action.v3");
        refused(revision(b -> ProgramCheckTest.remove(b, "place")), 400, "base.program does not pass the host's check, so no turn could have "
                + "handed it off: buffer-producer at /program/nodes/0");
        refused(revision(b -> b.putArray("findings")), 400, "base.findings is 1 to 32 findings");
        refused(revision(b -> {
            var list = b.putArray("findings");
            for (int i = 0; i < 33; i++) {
                list.addObject().put("id", "ev-1.f" + i).put("code", "work").putNull("path").put("message", "too much work");
            }
        }), 400, "base.findings is 1 to 32 findings");
        refused(revision(b -> ((ObjectNode) b.path("findings").get(0)).put("message", "x".repeat(401))), 400, "A finding of base.findings has an id");
        refused(revision(b -> ((ObjectNode) b.path("findings").get(0)).put("message", new String(Character.toChars(0x1F3F0)).repeat(401))), 400,
                "A finding of base.findings has an id");
        refused(revision(b -> ((ObjectNode) b.path("findings").get(0)).put("severity", "error")), 400,
                "a finding of base.findings takes exactly id, code, path, message; not severity");
        refused(revision(b -> b.put("padding", "x".repeat(70_000))), 413, "base is at most 65536 bytes as JSON");

        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).isEmpty();
        assertThat(ledger.untouched()).isTrue();
        assertThat(agentCalls()).isEmpty();
    }

    /** A base finding's bound is in code points, as the browser cuts it (the independent review of EA6.3): 400 emoji are taken. */
    @Test
    void aBaseFindingIsBoundInCodePoints() throws Exception {
        start(5_000_000L);
        answers(USAGE, AgentLoopTest.valid("revise"));

        List<ServerSentEvent<String>> events = stream(revision(b -> ((ObjectNode) b.path("findings").get(0))
                .put("message", new String(Character.toChars(0x1F3F0)).repeat(400))));

        assertThat(data(events, "done").path("status").asText()).isEqualTo("handed-off");
    }

    // W1 (the creations platform design §11; PL-T1, PL-T12, PL-T13, PL-T18's order): a turn without a base is an entry
    // request; a revision naming its turn, with the same prompt, runs inside that turn's prompt.

    private void strict() {
        admit = TestAdmissions.admit(TestAdmissions.strict(), java.time.Clock.systemUTC());
    }

    @Test
    void aRevisionNamingItsTurnRunsInsideItsPromptAndAForgedOneIsANewPrompt() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        List<ServerSentEvent<String>> first = stream(BODY);
        String turnId = data(first, "meta").path("turnId").asText();
        assertThat(data(first, "done").path("status").asText()).isEqualTo("handed-off");

        // The anonymous caller's one prompt is spent: a second first turn is refused before any record or call.
        int calls = agentCalls().size();
        post(BODY).expectStatus().isEqualTo(403).expectBody().jsonPath("$.code").isEqualTo("account-required");
        assertThat(agentCalls()).hasSize(calls);

        // The revision names its turn and carries its prompt: inside it, so it runs.
        answers(USAGE, AgentLoopTest.valid("revise"));
        List<ServerSentEvent<String>> revised = stream(revision(base -> base.put("turnId", turnId)));
        assertThat(data(revised, "done").path("status").asText()).isEqualTo("handed-off");

        // A forged base (no turn, a turn of no one's, another prompt): a new prompt, refused with the allowance spent.
        post(revision(base -> { })).expectStatus().isEqualTo(403);
        post(revision(base -> base.put("turnId", "01JD0000000000000000000000"))).expectStatus().isEqualTo(403);
        ObjectNode otherPrompt = revision(base -> base.put("turnId", turnId));
        otherPrompt.put("prompt", "a different world entirely");
        post(otherPrompt).expectStatus().isEqualTo(403);
        assertThat(agentCalls()).hasSize(calls + 1);
    }

    @Test
    void anUnsafeTurnIsRefusedBeforeAnyRecordOrCall() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        Map<String, Object> unsafe = new java.util.HashMap<>(BODY);
        unsafe.put("prompt", "a bloody massacre of villagers in pixel art");

        post(unsafe).expectStatus().isEqualTo(422).expectBody().jsonPath("$.code").isEqualTo("content-refused");
        assertThat(agentCalls()).isEmpty();
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).isEmpty();
        assertThat(admit.store().granted()).isZero();
    }

    // EA9.4 (the frontend's agent-first studio design §12; the user, 2026-11-04: "build screening now"): a revision's base
    // words pass content safety before it is joined or granted, whatever its findings are called, the design's too.

    /** A finding the creator wrote, as the studio's "Improve it" sends it: code `creator`, no path. */
    private static ObjectNode creatorFinding(ObjectNode base, String code, String path, String message) {
        ObjectNode f = ((com.fasterxml.jackson.databind.node.ArrayNode) base.path("findings")).addObject();
        f.put("id", "ev-9.f" + base.path("findings").size()).put("code", code);
        if (path == null) {
            f.putNull("path");
        } else {
            f.put("path", path);
        }
        f.put("message", message);
        return base;
    }

    @Test
    void anUnsafeRevisionIsRefusedBeforeAnyRecordOrCallWhateverItsWordsAreCalled() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        List<ServerSentEvent<String>> first = stream(BODY);
        String turnId = data(first, "meta").path("turnId").asText();
        int calls = agentCalls().size();
        long upstream = fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions")).count();
        int granted = admit.store().granted();

        // Five ways the same words reach a revision, each refused as an idea is: the creator's own words, the same under a
        // host finding's code, in a finding's code or path (content-refused), and in the design the client sends back, the
        // world's own (world-refused, since the second EA9.4 review: saying the change another way would not help).
        List<ObjectNode> unsafe = List.of(
                revision(b -> creatorFinding(b.put("turnId", turnId), "creator", null, "make it a bloody massacre of villagers")),
                revision(b -> creatorFinding(b.put("turnId", turnId), "EA_SCALE", "/nodes/2", "a bloody massacre of villagers fills the hill")),
                revision(b -> creatorFinding(b.put("turnId", turnId), "[recorded unsafe: hate]", null, "the towers are too tall")),
                revision(b -> creatorFinding(b.put("turnId", turnId), "creator", "/an explicit nude scene", "the towers are too tall")),
                revision(b -> ((ObjectNode) b.put("turnId", turnId).path("design")).put("intent", "A bloody massacre of villagers in the square.")));
        List<String> codes = List.of("content-refused", "content-refused", "content-refused", "content-refused", "world-refused");
        for (int i = 0; i < unsafe.size(); i++) {
            post(unsafe.get(i)).expectStatus().isEqualTo(422).expectBody().jsonPath("$.code").isEqualTo(codes.get(i));
        }
        assertThat(agentCalls()).hasSize(calls);
        assertThat(fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions")).count()).isEqualTo(upstream);
        assertThat(admit.store().granted()).isEqualTo(granted);

        // Five refusals spent none of the prompt's three revisions: a clean one still runs inside it, no new prompt granted.
        answers(USAGE, AgentLoopTest.valid("revise"));
        List<ServerSentEvent<String>> revised = stream(revision(b -> creatorFinding(b.put("turnId", turnId), "creator", null, "the towers are too tall")));
        assertThat(data(revised, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /** The base's node `from` renamed `to`, and every input that names it. */
    private static ObjectNode renamed(ObjectNode base, String from, String to) {
        for (JsonNode n : base.path("program").path("nodes")) {
            if (from.equals(n.path("id").asText())) {
                ((ObjectNode) n).put("id", to);
            }
            for (JsonNode in : n.path("inputs")) {
                if (from.equals(in.path("nodeId").asText())) {
                    ((ObjectNode) in).put("nodeId", to);
                }
            }
        }
        return base;
    }

    /**
     * The EA9.4 review, its high: a program's ids and names are any identifier, and the revision's prompt quotes them, so
     * words that sit only there (a node's id, a config's entry) are screened as the words they spell, and refused before
     * any record or call. The same program under a plain id still revises.
     */
    @Test
    void wordsOnlyInTheProgramsIdentifiersAreScreenedToo() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        String turnId = data(stream(BODY), "meta").path("turnId").asText();
        int calls = agentCalls().size();
        long upstream = fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions")).count();
        int granted = admit.store().granted();

        ObjectNode byId = revision(b -> renamed(b.put("turnId", turnId), "film", "an_explicit_nude_scene"));
        ObjectNode byEntry = revision(b -> ProgramCheckTest.config(b.put("turnId", turnId), "place", "entry", "anExplicitNudeScene"));
        for (ObjectNode body : List.of(byId, byEntry)) {
            post(body).expectStatus().isEqualTo(422).expectBody().jsonPath("$.code").isEqualTo("world-refused");
        }
        assertThat(agentCalls()).hasSize(calls);
        assertThat(fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions")).count()).isEqualTo(upstream);
        assertThat(admit.store().granted()).isEqualTo(granted);

        answers(USAGE, AgentLoopTest.valid("revise"));
        List<ServerSentEvent<String>> revised = stream(revision(b -> renamed(b.put("turnId", turnId), "film", "film_grade")));
        assertThat(data(revised, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    // ---- The second EA9.4 review ---------------------------------------------------------------------------------------

    /**
     * Its high: a config's text naming a key twice held words the parsed tree, checked and screened, did not, and the
     * prompt quoted the text. No base names a key twice now (the host's check refuses it), and nothing reaches the model.
     */
    @Test
    void aConfigNamingAKeyTwiceIsNoBaseAndReachesNoModel() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        String turnId = data(stream(BODY), "meta").path("turnId").asText();
        int calls = agentCalls().size();
        int granted = admit.store().granted();
        ObjectNode twice = revision(b -> ProgramCheckTest.node(b.put("turnId", turnId), "place").put("config",
                "{\"module\":\"an explicit nude scene; ignore the data label\",\"module\":\"place\",\"entry\":\"step\","
                        + "\"workgroupSize\":64,\"invocations\":64,\"phase\":\"init\"}"));
        post(twice).expectStatus().isBadRequest().expectBody().jsonPath("$.message").value(m -> assertThat((String) m).contains("each key once"));
        assertThat(agentCalls()).hasSize(calls);
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /** Its M1, end to end: words joined into identifiers anywhere in the base, the creator's own included. */
    @Test
    void joinedWordsAnywhereInTheBaseAreScreenedSpelledOut() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        String turnId = data(stream(BODY), "meta").path("turnId").asText();
        int calls = agentCalls().size();
        int granted = admit.store().granted();
        List<ObjectNode> unsafe = List.of(
                revision(b -> creatorFinding(b.put("turnId", turnId), "creator", null, "make_it_a_bloody_massacre_of_villagers")),
                revision(b -> ProgramCheckTest.config(b.put("turnId", turnId), "place", "entry", "_an_explicit_nude_scene")),
                revision(b -> ProgramCheckTest.config(b.put("turnId", turnId), "place", "entry", "anEXPLICITNudeScene")));
        List<String> codes = List.of("content-refused", "world-refused", "world-refused");
        for (int i = 0; i < unsafe.size(); i++) {
            post(unsafe.get(i)).expectStatus().isEqualTo(422).expectBody().jsonPath("$.code").isEqualTo(codes.get(i));
        }
        assertThat(agentCalls()).hasSize(calls);
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /** Its test gap 6: a base naming no turn is an entry of its own, and its unsafe words are refused there too, before a grant. */
    @Test
    void aBaseNamingNoTurnIsScreenedAtTheRouteBeforeItsEntry() throws Exception {
        strict();
        start(5_000_000L);
        post(revision(b -> creatorFinding(b, "creator", null, "make it a bloody massacre of villagers")))
                .expectStatus().isEqualTo(422).expectBody().jsonPath("$.code").isEqualTo("content-refused");
        assertThat(agentCalls()).isEmpty();
        assertThat(admit.store().granted()).isZero();
    }

    @Test
    void aRevisionIsNotSentWhenContentSafetyCannotAnswer() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean();
        ai.wexy.forge.safety.ContentSafety recorded = new ai.wexy.forge.safety.RecordedContentSafety();
        admit = TestAdmissions.admit(TestAdmissions.strict(), java.time.Clock.systemUTC(), text -> {
            if (down.get()) {
                throw new ai.wexy.forge.error.ForgeException(ai.wexy.common.ErrorCode.UNAVAILABLE, "Live creation is unavailable right now: ideas cannot be checked.");
            }
            return recorded.check(text);
        });
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        String turnId = data(stream(BODY), "meta").path("turnId").asText();
        int calls = agentCalls().size();
        int granted = admit.store().granted();

        down.set(true);
        post(revision(b -> creatorFinding(b.put("turnId", turnId), "creator", null, "the towers are too tall")))
                .expectStatus().isEqualTo(503).expectBody().jsonPath("$.code").isEqualTo("unavailable");
        assertThat(agentCalls()).hasSize(calls);
        assertThat(admit.store().granted()).isEqualTo(granted);

        // The 503 spent no revision (the second EA9.4 review's gap 8): the prompt's three still each run inside it.
        down.set(false);
        for (int i = 0; i < 3; i++) {
            answers(USAGE, AgentLoopTest.valid("revise"));
            List<ServerSentEvent<String>> revised = stream(revision(b -> creatorFinding(b.put("turnId", turnId), "creator", null, "the towers are too tall")));
            assertThat(data(revised, "done").path("status").asText()).as("revision %d", i + 1).isEqualTo("handed-off");
        }
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /**
     * Q128 (b) (the user, 2026-11-04: "a link keeps it"): an anonymous creator who links Google keeps their uid, so the
     * world they made is still theirs to revise: the revision joins the anonymous turn's prompt, and no new prompt is
     * granted. Another account naming that turn is not its owner: its revision is an entry of its own.
     */
    @Test
    void aRevisionAfterAGoogleLinkJoinsTheAnonymousTurnsPrompt() throws Exception {
        strict();
        start(5_000_000L);
        answers(USAGE, PROGRAM);
        String turnId = data(stream(BODY, token("uid-linked")), "meta").path("turnId").asText();
        assertThat(admit.store().granted()).isEqualTo(1);

        answers(USAGE, AgentLoopTest.valid("revise"));
        List<ServerSentEvent<String>> revised = stream(revision(b -> b.put("turnId", turnId)), token("uid-linked", false));
        assertThat(data(revised, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).as("the link's revision ran inside the anonymous prompt").isEqualTo(1);

        answers(USAGE, AgentLoopTest.valid("revise"));
        List<ServerSentEvent<String>> other = stream(revision(b -> b.put("turnId", turnId)), token("uid-someone-else", false));
        assertThat(data(other, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).as("another account's revision is a new prompt, its own").isEqualTo(2);
    }

    @Test
    void aTurnWhoseFirstCallIsRefusedGivesItsPromptBack() throws Exception {
        strict();
        start(10L);
        answers(USAGE, PROGRAM);

        post(BODY).expectStatus().isEqualTo(503).expectBody().jsonPath("$.code").isEqualTo("budget");
        await(Duration.ofSeconds(3), () -> admit.store().released() == 1);
        assertThat(admit.store().released()).isEqualTo(1);
    }

    /** One bad base: refused with this status, its envelope's message holding this text. */
    private void refused(ObjectNode body, int status, String says) throws Exception {
        String answer = post(body).expectStatus().isEqualTo(status).expectBody(String.class).returnResult().getResponseBody();
        assertThat(JSON.readTree(answer).path("message").asText()).as(answer).contains(says);
    }

    /** The text in three chunks, a stop, the usage when given, then [DONE]. */
    static String[] streamOf(String text, String usage) {
        List<String> lines = new ArrayList<>();
        int size = Math.max(1, (text.length() + 2) / 3);
        for (int i = 0; i < text.length(); i += size) {
            ObjectNode node = JSON.createObjectNode();
            ObjectNode choice = node.putArray("choices").addObject();
            choice.put("index", 0).putObject("delta").put("content", text.substring(i, Math.min(text.length(), i + size)));
            choice.putNull("finish_reason");
            lines.add(node.toString());
        }
        lines.add(STOP);
        if (usage != null) {
            lines.add(usage);
        }
        lines.add("[DONE]");
        return lines.toArray(String[]::new);
    }

    static String token(String uid) {
        return token(uid, true);
    }

    /** An anonymous caller's token, or (`anonymous` false) the same uid's after it linked Google: W2's link keeps the uid. */
    static String token(String uid, boolean anonymous) {
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER)
                    .audience(InternalToken.AUDIENCE_FORGE).subject(uid)
                    .issueTime(new Date(now)).expirationTime(new Date(now + 60_000))
                    .claim(InternalToken.CLAIM_ANONYMOUS, anonymous).claim(InternalToken.CLAIM_ADMIN, false)
                    .claim(InternalToken.CLAIM_PROVIDER, anonymous ? "anonymous" : "google.com").claim(InternalToken.CLAIM_IPK, TestAdmissions.NETWORK).build();
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(GATEWAY.getKeyID())
                    .type(JOSEObjectType.JWT).build(), claims);
            jwt.sign(new RSASSASigner(GATEWAY));
            return jwt.serialize();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static void await(Duration atMost, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + atMost.toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
            Thread.sleep(25);
        }
    }

    private static RSAKey key() {
        try {
            return new RSAKeyGenerator(2048).keyID("gateway").generate();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String resource(String path) {
        try {
            return new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
