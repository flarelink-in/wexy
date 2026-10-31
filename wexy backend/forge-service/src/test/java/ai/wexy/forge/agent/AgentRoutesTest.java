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
import ai.wexy.forge.records.Generation;
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
 * caps, is refused before any charge. Each call is an {@code AGENT} record under the turn.
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
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, sparkDailyCapMicroUsd))), new SimpleMeterRegistry());
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
                new LoopProperties(null, Duration.ofMillis(50), null, false), bundle);
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
        return client.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token("uid-agent")).bodyValue(body).exchange();
    }

    private List<ServerSentEvent<String>> stream(Object body) {
        return post(body).expectStatus().isOk().returnResult(EVENTS).getResponseBody().collectList().block(Duration.ofSeconds(30));
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
        assertThat(meta.path("promptVersion").asText()).isEqualTo("agent.v2");
        // EA3.6: the action's contract and the adapter manifest its program was checked against.
        assertThat(meta.path("actionSchema").asText()).isEqualTo("agent-action.v2");
        assertThat(meta.path("manifestHash").asText()).isEqualTo(AdapterManifest.HASH);
        assertThat(meta.path("model").asText()).isEqualTo("m-1");
        assertThat(meta.path("bundleHash").asText()).matches("[0-9a-f]{64}");
        assertThat(data(events, "done").path("status").asText()).isEqualTo("handed-off");
        assertThat(data(events, "check").path("ok").asBoolean()).isTrue();
        assertThat(data(events, "tools").path("results")).hasSize(2);
        assertThat(fake.chatRequests()).isEqualTo(2);
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions"))
                .allMatch(r -> r.body().contains("agent_action_v2") && r.body().contains("\"strict\":true"));

        List<Generation> calls = agentCalls();
        assertThat(calls).hasSize(2).allMatch(g -> g.status() == Generation.Status.OK && g.role().equals("agent")
                && g.parentId().equals(meta.path("turnId").asText()) && g.uid().equals("uid-agent"));
        assertThat(calls).extracting(Generation::promptVersion).containsOnly("agent.v2");
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
        exchange.getAttributes().put(InternalTokenFilter.CALLER_ATTRIBUTE, new ai.wexy.forge.identity.Caller("uid-agent", true, false, "anonymous"));
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
                new ai.wexy.forge.identity.Caller("uid-agent", true, false, "anonymous"), "{}", "agent.v2", HostContract.VERSION);

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
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).subject(uid)
                    .issueTime(new Date(now)).expirationTime(new Date(now + 60_000))
                    .claim(InternalToken.CLAIM_ANONYMOUS, true).claim(InternalToken.CLAIM_ADMIN, false)
                    .claim(InternalToken.CLAIM_PROVIDER, "anonymous").build();
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
