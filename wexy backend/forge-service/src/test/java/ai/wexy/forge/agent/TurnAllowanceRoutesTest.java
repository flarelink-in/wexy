package ai.wexy.forge.agent;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.allowance.AllowanceHandler;
import ai.wexy.forge.allowance.TestAdmissions;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ErrorEnvelopeHandler;
import ai.wexy.forge.identity.InternalTokenFilter;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.safety.ContentSafety;
import ai.wexy.forge.safety.RecordedContentSafety;
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
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
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
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The allowances on the agent's turn route, and the follow-up of a turn that ended with no world.
 *
 * <p>W1's cases (the frontend's agent-first studio design §12, required before the switch, EA9.5: "W1's allowance cases
 * pinned on the turn route too: anonymous, early access, spent, a refused idea, the store down, the give-back"), as
 * AllowanceRoutesTest holds them on h1's plan route: every world now begins on this route.
 *
 * <p>Q120 (b) (the user, 2026-11-05: "Build the follow-up"; the creations platform design §10, "Q120's follow-up"): a turn
 * that ended with no world (asked, declined, exhausted, failed, cancelled after its first call) may be followed once inside
 * its prompt. Its idea is screened when changed. Anything else is {@code 409 conflict}, never an entry. A follow-up that
 * dispatched nothing is given back. The contract's tests: two joins raced, another account, an expired grant, a dropped
 * response, a repeated request.
 *
 * <p>Over a real server: the turn, module and allowance routes, the identity filter and the error envelope, against the
 * fake Meta API, the in-memory meter and the in-memory grants.
 */
class TurnAllowanceRoutesTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String IDEA = "make minecraft 1870s film style";
    static final String ANSWERED = "make minecraft 1870s film style, the blocks of stone";
    static final String UNSAFE = "a bloody massacre of villagers in pixel art";
    static final String ASK = AgentLoopTest.action("ask").put("question", "Blocks of stone, or of wood?").toString();
    static final String DECLINE = declined();
    /** Not an action: the schema misses it, twice repaired, and the turn fails as `upstream` (AgentLoop). */
    static final String NOT_AN_ACTION = "{}";

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();
    TestAdmissions.Admit admit = TestAdmissions.admit(TestAdmissions.strict(), Clock.systemUTC());
    InMemoryGenerationStore store;
    WebTestClient client;
    WebClient raw;
    private DisposableServer server;
    private long sparkCap = 5_000_000L;
    private long meterDelay;
    private AgentBudget budget = AgentBudget.defaults();

    @AfterEach
    void stop() {
        if (server != null) {
            server.disposeNow();
        }
        fake.close();
    }

    private static String declined() {
        ObjectNode finish = AgentLoopTest.action("finish");
        finish.putObject("finish").put("summary", "null-graph has no way to load a Minecraft world file");
        return finish.toString();
    }

    /** A server over this test's admission, meter cap, meter delay and turn budget; the generation store kept across restarts. */
    private void start() {
        if (server != null) {
            server.disposeNow();
        }
        StringRedisTemplate template = ledger.template(meterDelay);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, sparkCap)), SpendLanes.open()), new SimpleMeterRegistry());
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of("agent", new ModelProperties.Role("m-1", "meta-spark", 16000, Duration.ofSeconds(10), "medium", null),
                        "module", new ModelProperties.Role("m-1", "meta-spark", 12000, Duration.ofSeconds(10), "medium", null)),
                Map.of("m-1", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2),
                Duration.ofSeconds(5)), new ObjectMapper(), WebClient.builder());
        PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of("agent", "module"), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver()));
        if (store == null) {
            store = new InMemoryGenerationStore(100, Duration.ofHours(2), Clock.systemUTC());
        }
        EngineBundle bundle = EngineBundle.load(JSON);
        AdapterManifest manifest = AdapterManifest.load(JSON);
        JsonSchemas schemas = new JsonSchemas();
        AgentLoop loop = new AgentLoop(new AgentTools(bundle), new ProgramCheck(bundle, manifest), schemas, prompts, budget, System::currentTimeMillis);
        MeteredModelClient models = new MeteredModelClient(api, catalog, guard);
        LoopProperties loopProperties = new LoopProperties(null, Duration.ofMillis(50), null, false);
        AgentConfiguration routes = new AgentConfiguration();
        HttpHandler http = RouterFunctions.toHttpHandler(
                routes.agentRoutes(new AgentHandler(loop, models, catalog, store, loopProperties, bundle, admit.admission()))
                        .and(routes.moduleRoutes(new ModuleHandler(prompts, models, catalog, store, loopProperties, bundle, manifest, schemas,
                                admit.admission())))
                        .and(new AllowanceHandler.Routes().allowanceRoutes(new AllowanceHandler(admit.grants()))),
                HandlerStrategies.builder()
                        .webFilter(new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(AgentRoutesTest.GATEWAY.toPublicJWK()))))
                        .exceptionHandler(new ErrorEnvelopeHandler())
                        .build());
        server = HttpServer.create().host("127.0.0.1").port(0).handle(new ReactorHttpHandlerAdapter(http)).bindNow();
        String baseUrl = "http://127.0.0.1:" + server.port();
        client = WebTestClient.bindToServer().baseUrl(baseUrl).responseTimeout(Duration.ofSeconds(30)).build();
        raw = WebClient.builder().baseUrl(baseUrl).build();
    }

    /** The fake answers each call with the next text, in a few chunks, a stop and the usage; the last one again after. */
    private void answers(String... texts) {
        AtomicInteger n = new AtomicInteger();
        fake.chat = (exchange, request) -> {
            String text = texts[Math.min(n.getAndIncrement(), texts.length - 1)];
            FakeMetaApi.sse(0, AgentRoutesTest.streamOf(text, AgentRoutesTest.USAGE)).respond(exchange, request);
        };
    }

    private static String anonymous(String uid) {
        return AgentRoutesTest.token(uid, true);
    }

    /** The same uid after it linked Google (W2's link keeps the uid): early access. */
    private static String google(String uid) {
        return AgentRoutesTest.token(uid, false);
    }

    private static Map<String, Object> idea(String prompt) {
        return Map.of("prompt", prompt, "style", "cinematic", "seconds", 12);
    }

    /** A turn of `prompt` that follows `turnId` (Q120 (b)). */
    private static Map<String, Object> following(String prompt, String turnId) {
        Map<String, Object> body = new HashMap<>(idea(prompt));
        body.put("retryOf", turnId);
        return body;
    }

    private WebTestClient.ResponseSpec turn(Object body, String token) {
        return client.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token).bodyValue(body).exchange();
    }

    private List<ServerSentEvent<String>> streamed(Object body, String token) {
        return turn(body, token).expectStatus().isOk().returnResult(AgentRoutesTest.EVENTS).getResponseBody().collectList()
                .block(Duration.ofSeconds(30));
    }

    /** A turn's stream read to its end: its id and how it ended (`done`'s status, or `error`'s code). */
    private record Ended(String turnId, String end) {
    }

    private Ended ended(Object body, String token) throws Exception {
        List<ServerSentEvent<String>> events = streamed(body, token);
        String turnId = AgentRoutesTest.data(events, "meta").path("turnId").asText();
        List<String> names = AgentRoutesTest.names(events);
        String end = names.contains("done") ? AgentRoutesTest.data(events, "done").path("status").asText()
                : "error:" + AgentRoutesTest.data(events, "error").path("code").asText();
        return new Ended(turnId, end);
    }

    private JsonNode refused(Object body, String token, int status) throws Exception {
        byte[] answer = turn(body, token).expectStatus().isEqualTo(status).expectBody().returnResult().getResponseBody();
        return JSON.readTree(answer);
    }

    private JsonNode allowance(String token) throws Exception {
        return JSON.readTree(client.get().uri("/v1/forge/allowance").header(InternalToken.HEADER, token).exchange()
                .expectStatus().isOk().expectBody().returnResult().getResponseBody());
    }

    private List<Generation> agentCalls() {
        return store.snapshot().stream().filter(g -> g.kind() == Generation.Kind.AGENT).toList();
    }

    /** The grant a turn runs in, as the store holds it. */
    private Map<String, String> grantOf(String turnId) {
        String grantId = admit.store().grantOf(turnId);
        return grantId == null ? null : admit.store().record(grantId);
    }

    /** A module call that runs: its stream read to its end, so no answer is left open. */
    private void moduleRuns(String turnId, String prompt, String token) {
        module(turnId, prompt, token).expectStatus().isOk().returnResult(String.class).getResponseBody().blockLast(Duration.ofSeconds(30));
    }

    /** A module call (the mock world's `place` author) naming `turnId` and carrying `prompt`, as the studio sends one. */
    private WebTestClient.ResponseSpec module(String turnId, String prompt, String token) {
        ObjectNode b = JSON.createObjectNode();
        b.put("turnId", turnId).put("jobId", "job-1");
        ObjectNode subject = b.putObject("subject");
        JsonNode place = ModuleRoutesTest.PLACE;
        subject.put("attempt", "attempt-1").put("revision", 0).put("programHash", place.path("programHash").asText())
                .put("graph", place.path("graph").asText()).putNull("candidate").put("module", "place")
                .put("interfaceHash", place.path("interface").path("interfaceHash").asText()).putNull("codeHash");
        b.putObject("versions").put("bundle", EngineBundle.load(JSON).bundleHash()).put("actionSchema", JsonSchemas.AGENT_ACTION)
                .put("manifest", AdapterManifest.HASH).put("abi", "ea-abi.v2").put("checker", "ea4-body.v1");
        b.put("purpose", "author");
        b.putObject("request").put("prompt", prompt).put("style", "cinematic").put("seconds", 12);
        b.set("design", ModuleRoutesTest.PROGRAM.path("design").deepCopy());
        ArrayNode nodes = b.putArray("nodes");
        for (JsonNode n : ModuleRoutesTest.PROGRAM.path("program").path("nodes")) {
            if (Set.of("place", "blocks", "terrain", "cube", "clay").contains(n.path("id").asText())) {
                nodes.add(n.deepCopy());
            }
        }
        ObjectNode m = b.putObject("module");
        m.put("id", "place").put("kind", "compute");
        m.set("interface", place.path("interface").deepCopy());
        b.putNull("previous");
        b.putNull("note");
        return client.post().uri("/v1/agent/module").contentType(MediaType.APPLICATION_JSON).accept(MediaType.TEXT_EVENT_STREAM)
                .header(InternalToken.HEADER, token).bodyValue(b).exchange();
    }

    // ---- W1 on the turn route ------------------------------------------------------------------------------------------

    /** PL-T1 on the turn route: an anonymous caller's second turn is account-required, before any record or upstream request. */
    @Test
    void anAnonymousCallersSecondTurnIsAccountRequiredWithNothingSentUpstream() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(idea(IDEA), anonymous("u1")).end()).isEqualTo("handed-off");
        long sent = fake.chatRequests();
        int records = store.snapshot().size();

        JsonNode second = refused(idea("a spiral galaxy"), anonymous("u1"), 403);
        assertThat(second.path("code").asText()).isEqualTo("account-required");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(store.snapshot()).hasSize(records);
        // Another anonymous account on the same network: its first turn is the network's second today.
        assertThat(refused(idea("a galaxy"), anonymous("u2"), 403).path("code").asText()).isEqualTo("account-required");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).isEqualTo(1);
    }

    /** PL-T1, PL-T12 on the turn route: once linked (the same uid), early access, one a day; its second is quota with its reset. */
    @Test
    void earlyAccessIsOneTurnADayAndItsSecondIsQuotaWithRetryAfter() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(idea(IDEA), anonymous("u1")).end()).isEqualTo("handed-off");
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(idea("a spiral galaxy"), google("u1")).end()).isEqualTo("handed-off");
        long sent = fake.chatRequests();

        var result = turn(idea("a third world"), google("u1")).expectStatus().isEqualTo(429)
                .expectHeader().exists("Retry-After").expectBody().returnResult();
        assertThat(JSON.readTree(result.getResponseBody()).path("code").asText()).isEqualTo("quota");
        long wait = Long.parseLong(result.getResponseHeaders().getFirst("Retry-After"));
        assertThat(wait).isBetween(1L, 86_400L);
        assertThat(fake.chatRequests()).isEqualTo(sent);
    }

    /** PL-T18's order on the turn route: an unsafe idea is refused before any grant or upstream request, and spends nothing. */
    @Test
    void anUnsafeIdeaIsRefusedBeforeAnyGrantAndSpendsNothing() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        JsonNode refused = refused(idea(UNSAFE), anonymous("u1"), 422);
        assertThat(refused.path("code").asText()).isEqualTo("content-refused");
        assertThat(refused.path("message").asText()).doesNotContain("massacre");
        assertThat(fake.chatRequests()).isZero();
        assertThat(admit.store().granted()).isZero();
        assertThat(store.snapshot()).isEmpty();
        // Nothing was spent: the caller's one world is still there.
        assertThat(ended(idea(IDEA), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** A spent allowance is refused before content safety is asked: a refused caller costs no safety check. */
    @Test
    void aSpentAllowanceIsRefusedBeforeTheSafetyCheck() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        ended(idea(IDEA), anonymous("u1"));
        assertThat(refused(idea(UNSAFE), anonymous("u1"), 403).path("code").asText()).isEqualTo("account-required");
    }

    /** PL-T14 on the turn route: a store that cannot answer grants nothing: 503 unavailable, nothing recorded or sent. */
    @Test
    void aStoreThatCannotAnswerIsUnavailable() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        admit.store().down(true);
        assertThat(refused(idea(IDEA), anonymous("u1"), 503).path("code").asText()).isEqualTo("unavailable");
        assertThat(fake.chatRequests()).isZero();
        assertThat(store.snapshot()).isEmpty();
        // A follow-up asks the store first too: no verdict, no turn.
        assertThat(refused(following(IDEA, "01JD0000000000000000000000"), anonymous("u1"), 503).path("code").asText()).isEqualTo("unavailable");
        assertThat(fake.chatRequests()).isZero();
    }

    /** PL-T12 on the turn route: a first call the meter refuses gives the turn's prompt back; the caller still has their world. */
    @Test
    void aRefusedFirstCallGivesTheTurnsPromptBack() throws Exception {
        sparkCap = 10L;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(refused(idea(IDEA), anonymous("u1"), 503).path("code").asText()).isEqualTo("budget");
        AgentRoutesTest.await(Duration.ofSeconds(3), () -> admit.store().released() == 1);
        assertThat(admit.store().released()).isEqualTo(1);

        sparkCap = 5_000_000L;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(idea(IDEA), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** PL-T13 on the turn route: a turn's module calls run inside its prompt; another caller's naming it are not theirs. */
    @Test
    void aTurnsModuleCallsRunInsideItsPromptAndAnotherCallersAreRefused() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        String turnId = ended(idea(IDEA), anonymous("u1")).turnId();
        answers(ModuleRoutesTest.BODY);

        moduleRuns(turnId, IDEA, anonymous("u1"));
        long sent = fake.chatRequests();
        module(turnId, IDEA, anonymous("u2")).expectStatus().isNotFound();
        module(turnId, "another idea entirely", anonymous("u1")).expectStatus().isNotFound();
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).isEqualTo(1);
    }

    /** PL-T19 after a turn: the allowance read right after it (the studio's chip, afterEntry) says the world is made. */
    @Test
    void theAllowanceReadAfterATurnSaysItsWorldIsMade() throws Exception {
        start();
        assertThat(allowance(anonymous("u1")).toString()).isEqualTo("{\"label\":\"Free\",\"left\":1,\"resetsAt\":null}");
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        ended(idea(IDEA), anonymous("u1"));
        assertThat(allowance(anonymous("u1")).path("left").asLong()).isZero();
        JsonNode early = allowance(google("u1"));
        assertThat(early.path("label").asText()).isEqualTo("Early access");
        assertThat(early.path("left").asLong()).isEqualTo(1);
    }

    /**
     * PL-T19 on the allowance route itself (EA9.6's independent review: h1's AllowanceRoutesTest held these): exactly
     * {label, left, resetsAt}, never cached; an anonymous caller the gateway gave no network has none left; a store that
     * cannot answer is 503, never a zero; and without the gateway's token there is no caller, so no answer.
     */
    @Test
    void theAllowanceIsTheCallersOwnNeverCachedAndNeverAPublicRead() throws Exception {
        start();
        client.get().uri("/v1/forge/allowance").header(InternalToken.HEADER, anonymous("u1")).exchange()
                .expectStatus().isOk().expectHeader().valueEquals("Cache-Control", "no-store");
        JsonNode early = allowance(google("u1"));
        assertThat(early.size()).isEqualTo(3);
        assertThat(early.path("resetsAt").asText()).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z");
        assertThat(allowance(AgentRoutesTest.token("u5", true, null)).path("left").asLong()).as("no network, nothing left").isZero();

        client.get().uri("/v1/forge/allowance").exchange().expectStatus().isUnauthorized()
                .expectBody().jsonPath("$.code").isEqualTo("auth");
        admit.store().down(true);
        client.get().uri("/v1/forge/allowance").header(InternalToken.HEADER, anonymous("u1")).exchange()
                .expectStatus().isEqualTo(503).expectBody().jsonPath("$.code").isEqualTo("unavailable");
        assertThat(fake.chatRequests()).isZero();
    }

    /** I13 on the turn route: a turn's own answer carries no allowance: only the allowance route says what is left. */
    @Test
    void noTurnAnswerCarriesTheAllowance() {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        String all = streamed(idea(IDEA), anonymous("u1")).stream().map(e -> String.valueOf(e.data())).reduce("", String::concat);
        assertThat(all).doesNotContain("\"left\"").doesNotContain("Early access").doesNotContain("\"label\"");
    }

    // ---- Q120 (b): the follow-up ---------------------------------------------------------------------------------------

    /**
     * An asked turn's answer runs inside its prompt: no new grant, its idea screened (changed), its module calls joining
     * by the new idea. Then no second follow-up, and no second world: the anonymous caller's one world is the follow-up's.
     */
    @Test
    void anAskedTurnIsFollowedOnceInsideItsPrompt() throws Exception {
        start();
        answers(ASK);
        Ended asked = ended(idea(IDEA), anonymous("u1"));
        assertThat(asked.end()).isEqualTo("asked");
        assertThat(grantOf(asked.turnId())).containsEntry("end", "asked");
        assertThat(admit.store().granted()).isEqualTo(1);

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        Ended answer = ended(following(ANSWERED, asked.turnId()), anonymous("u1"));
        assertThat(answer.end()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).as("no new prompt").isEqualTo(1);
        assertThat(admit.store().followed()).isEqualTo(1);
        assertThat(grantOf(answer.turnId())).containsEntry("end", "handed-off").containsEntry("following", answer.turnId());
        // Every call of both turns is the caller's, under its own turn.
        assertThat(agentCalls()).extracting(Generation::parentId).contains(asked.turnId(), answer.turnId());

        // The follow-up's module calls carry its own idea, which the prompt now holds; the first idea's no longer joins.
        answers(ModuleRoutesTest.BODY);
        moduleRuns(answer.turnId(), ANSWERED, anonymous("u1"));
        long sent = fake.chatRequests();
        module(answer.turnId(), IDEA, anonymous("u1")).expectStatus().isNotFound();

        // One follow-up a prompt: a second is refused, whichever turn it names, and is never an entry.
        for (String named : List.of(answer.turnId(), asked.turnId())) {
            JsonNode again = refused(following(ANSWERED, named), anonymous("u1"), 409);
            assertThat(again.path("code").asText()).isEqualTo("conflict");
            assertThat(again.path("message").asText()).isEqualTo("This try can't be continued, so a new Create makes a new world.");
        }
        assertThat(refused(idea("a spiral galaxy"), anonymous("u1"), 403).path("code").asText()).as("its one world is made").isEqualTo("account-required");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).isEqualTo(1);
    }

    /**
     * One follow-up a prompt, even when it too ends with no world (the mutation check, 2026-11-06: every second follow-up
     * the tests sent named a turn that had handed off, so "a world" refused it before "its one is spent" was asked). The
     * studio never follows a follow-up; a forged client may, and is refused, never granted a third turn or a new prompt.
     */
    @Test
    void aFollowUpThatEndsWithNoWorldIsNotFollowedAgain() throws Exception {
        start();
        answers(ASK);
        String first = ended(idea(IDEA), anonymous("u1")).turnId();
        answers(ASK);
        Ended second = ended(following(ANSWERED, first), anonymous("u1"));
        assertThat(second.end()).isEqualTo("asked");
        assertThat(grantOf(second.turnId())).containsEntry("end", "asked").containsEntry("followups", "1");
        long sent = fake.chatRequests();

        for (String named : List.of(second.turnId(), first)) {
            assertThat(refused(following(ANSWERED + ", wood", named), anonymous("u1"), 409).path("code").asText()).as(named).isEqualTo("conflict");
        }
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().followed()).isEqualTo(1);
        assertThat(refused(idea("a spiral galaxy"), anonymous("u1"), 403).path("code").asText()).isEqualTo("account-required");
    }

    /**
     * The race's loser at the join itself (the mutation check, 2026-11-06: the raced requests never interleaved there): a
     * follow-up whose read said it may run, but another joined while its idea was screened, is refused, never granted.
     */
    @Test
    void aFollowUpThatLosesTheJoinIsRefusedNotGranted() throws Exception {
        java.util.concurrent.atomic.AtomicReference<Runnable> whileScreened = new java.util.concurrent.atomic.AtomicReference<>(() -> { });
        ContentSafety recorded = new RecordedContentSafety();
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC(), text -> {
            whileScreened.getAndSet(() -> { }).run();
            return recorded.check(text);
        });
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();
        int granted = admit.store().granted();
        ai.wexy.forge.identity.Caller u1 = new ai.wexy.forge.identity.Caller("u1", true, false, "anonymous", TestAdmissions.NETWORK);
        whileScreened.set(() -> assertThat(admit.grants().follow(u1, asked, "01JD0000000000000000000009", "another idea's hash")).isNotNull());
        long sent = fake.chatRequests();

        assertThat(refused(following(ANSWERED, asked), anonymous("u1"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(admit.store().followed()).as("only the one that joined first").isEqualTo(1);
        assertThat(admit.store().granted()).as("the loser granted nothing").isEqualTo(granted);
        assertThat(fake.chatRequests()).isEqualTo(sent);
    }

    /** A changed idea is screened before the join, as an entry's: a refusal spends nothing, the follow-up included. */
    @Test
    void aChangedIdeaIsScreenedAndItsRefusalSpendsNotTheFollowUp() throws Exception {
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();
        long sent = fake.chatRequests();
        int records = store.snapshot().size();

        JsonNode refused = refused(following(UNSAFE, asked), anonymous("u1"), 422);
        assertThat(refused.path("code").asText()).isEqualTo("content-refused");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(store.snapshot()).hasSize(records);
        assertThat(grantOf(asked)).containsEntry("end", "asked").doesNotContainKey("following");

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(ANSWERED, asked), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** A failed turn is retried with the same idea (the studio's own retry): no safety call, since its idea was checked. */
    @Test
    void theSameIdeaIsNotScreenedAgain() throws Exception {
        AtomicInteger checks = new AtomicInteger();
        ContentSafety recorded = new RecordedContentSafety();
        admit = TestAdmissions.admit(TestAdmissions.strict(), Clock.systemUTC(), text -> {
            checks.incrementAndGet();
            return recorded.check(text);
        });
        start();
        answers(NOT_AN_ACTION);
        Ended failed = ended(idea(IDEA), anonymous("u1"));
        assertThat(failed.end()).isEqualTo("error:upstream");
        assertThat(grantOf(failed.turnId())).containsEntry("end", "failed");
        assertThat(checks.get()).isEqualTo(1);

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(IDEA, failed.turnId()), anonymous("u1")).end()).isEqualTo("handed-off");
        assertThat(checks.get()).as("the same idea is not asked again").isEqualTo(1);
        assertThat(admit.store().granted()).isEqualTo(1);
    }

    /** Each end with no world may be followed: a decline, a spent budget, a failure, a cancel after the first call. */
    @Test
    void everyEndWithNoWorldMayBeFollowedAndAWorldMayNot() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC());
        start();
        answers(DECLINE);
        Ended declined = ended(idea(IDEA), anonymous("u1"));
        assertThat(declined.end()).isEqualTo("declined");
        assertThat(grantOf(declined.turnId())).containsEntry("end", "declined");

        answers(NOT_AN_ACTION);
        Ended failed = ended(idea(IDEA), anonymous("u2"));
        assertThat(grantOf(failed.turnId())).containsEntry("end", "failed");

        // A client that leaves mid-call: the turn is cancelled after its first call was charged.
        fake.chat = FakeMetaApi.sse(400, AgentRoutesTest.streamOf(AgentRoutesTest.READ, AgentRoutesTest.USAGE));
        List<ServerSentEvent<String>> seen = Collections.synchronizedList(new ArrayList<>());
        Disposable leaving = raw.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, anonymous("u3")).bodyValue(idea(IDEA))
                .retrieve().bodyToFlux(AgentRoutesTest.EVENTS).subscribe(seen::add);
        AgentRoutesTest.await(Duration.ofSeconds(10), () -> seen.stream().anyMatch(e -> "call".equals(e.event())));
        String cancelledId = AgentRoutesTest.data(new ArrayList<>(seen), "meta").path("turnId").asText();
        leaving.dispose();
        AgentRoutesTest.await(Duration.ofSeconds(10), () -> grantOf(cancelledId) != null && "cancelled".equals(grantOf(cancelledId).get("end")));
        assertThat(grantOf(cancelledId)).containsEntry("end", "cancelled");

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        Ended world = ended(idea(IDEA), anonymous("u4"));
        assertThat(grantOf(world.turnId())).containsEntry("end", "handed-off");
        int granted = admit.store().granted();

        for (var followed : List.of(Map.entry(declined.turnId(), "u1"), Map.entry(failed.turnId(), "u2"), Map.entry(cancelledId, "u3"))) {
            answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
            assertThat(ended(following(ANSWERED, followed.getKey()), anonymous(followed.getValue())).end()).isEqualTo("handed-off");
        }
        // A turn that made a world is never followed, even for a caller with prompts to spare: no fall-through to a grant.
        long sent = fake.chatRequests();
        assertThat(refused(following(ANSWERED, world.turnId()), anonymous("u4"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).as("three follow-ups, and no grant for the refused one").isEqualTo(granted);
        assertThat(admit.store().followed()).isEqualTo(3);
    }

    /** A spent budget, `EA_TURN_BUDGET`: its turn is followed too. */
    @Test
    void anExhaustedTurnMayBeFollowed() throws Exception {
        budget = new AgentBudget(1, 2, 6, 8, 65_536, 2, 1, 1_000_000L, 600L, 196_608);
        start();
        answers(AgentRoutesTest.READ);
        Ended exhausted = ended(idea(IDEA), anonymous("u1"));
        assertThat(exhausted.end()).isEqualTo("exhausted");
        assertThat(grantOf(exhausted.turnId())).containsEntry("end", "exhausted");

        budget = AgentBudget.defaults();
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following("a simpler blocky world", exhausted.turnId()), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** Another account naming the turn is refused, never granted one of its own; a Google link (the same uid) follows it. */
    @Test
    void anotherAccountCannotFollowAndALinkCan() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC());
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();
        int granted = admit.store().granted();
        long sent = fake.chatRequests();

        assertThat(refused(following(ANSWERED, asked), anonymous("u2"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(refused(following(ANSWERED, asked), google("u9"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).isEqualTo(granted);

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(ANSWERED, asked), google("u1")).end()).isEqualTo("handed-off");
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /** A follow-up after its prompt's life is refused: the grant is gone, and nothing becomes an entry in its place. */
    @Test
    void aFollowUpAfterItsPromptsLifeIsRefused() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.strict(Duration.ofSeconds(1)), Clock.systemUTC());
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), google("u1")).turnId();
        Thread.sleep(1_200);

        long sent = fake.chatRequests();
        assertThat(refused(following(ANSWERED, asked), google("u1"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).as("early access's day not spent by a refused follow-up").isEqualTo(1);
    }

    /** Two follow-ups raced: one runs inside the prompt, every other is refused, and none is granted a prompt of its own. */
    @Test
    void followUpsRacedRunOneAndRefuseTheRest() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC());
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();
        int granted = admit.store().granted();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);

        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<Integer>> tries = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String prompt = ANSWERED + " " + i;
                tries.add(pool.submit(() -> {
                    go.await();
                    return turn(following(prompt, asked), anonymous("u1")).returnResult(AgentRoutesTest.EVENTS).getStatus().value();
                }));
            }
            go.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> t : tries) {
                statuses.add(t.get());
            }
            assertThat(statuses).containsOnly(200, 409).filteredOn(s -> s == 200).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
        assertThat(admit.store().followed()).isEqualTo(1);
        assertThat(admit.store().granted()).isEqualTo(granted);
    }

    /** The same follow-up sent again (a client's repeat): the first ran, the second is refused, not an entry. */
    @Test
    void aRepeatedFollowUpIsRefused() throws Exception {
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), google("u1")).turnId();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(ANSWERED, asked), google("u1")).end()).isEqualTo("handed-off");
        long sent = fake.chatRequests();

        assertThat(refused(following(ANSWERED, asked), google("u1"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(fake.chatRequests()).isEqualTo(sent);
        assertThat(admit.store().granted()).isEqualTo(1);
    }

    /** A follow-up whose first charge the meter refuses dispatched nothing: it is given back, and runs when sent again. */
    @Test
    void aFollowUpThatDispatchedNothingIsGivenBack() throws Exception {
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();

        sparkCap = 10L;
        start();
        assertThat(refused(following(ANSWERED, asked), anonymous("u1"), 503).path("code").asText()).isEqualTo("budget");
        AgentRoutesTest.await(Duration.ofSeconds(3), () -> admit.store().unfollowed() == 1);
        assertThat(admit.store().unfollowed()).isEqualTo(1);
        assertThat(grantOf(asked)).containsEntry("end", "asked").containsEntry("followups", "0").doesNotContainKey("following");
        assertThat(admit.store().released()).as("the entry's own grant stays spent").isZero();

        sparkCap = 5_000_000L;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(ANSWERED, asked), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** A dropped response (the client gone before the follow-up's first word): given back too, and sent again it runs. */
    @Test
    void aFollowUpDroppedBeforeItsFirstWordIsGivenBack() throws Exception {
        start();
        answers(ASK);
        String asked = ended(idea(IDEA), anonymous("u1")).turnId();

        meterDelay = 1_500;
        start();
        Disposable dropped = raw.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, anonymous("u1")).bodyValue(following(ANSWERED, asked))
                .retrieve().bodyToFlux(AgentRoutesTest.EVENTS).subscribe(e -> { }, e -> { });
        AgentRoutesTest.await(Duration.ofSeconds(5), () -> admit.store().followed() == 1);
        Thread.sleep(200);
        dropped.dispose();
        AgentRoutesTest.await(Duration.ofSeconds(10), () -> admit.store().unfollowed() == 1);
        assertThat(admit.store().unfollowed()).isEqualTo(1);
        assertThat(fake.chatRequests()).as("only the asked turn's call").isEqualTo(1);

        meterDelay = 0;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        assertThat(ended(following(ANSWERED, asked), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /**
     * A follow-up of a turn still running is refused once its wait is over: no end is written, so nothing says it made no
     * world. It waited first (the independent review of EA9.5): a Stop's turn may still be unwinding.
     */
    @Test
    void aFollowUpOfATurnStillRunningIsRefusedAfterItsWait() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC());
        start();
        // About six seconds of one call's stream: past the follow-up's wait of three.
        fake.chat = FakeMetaApi.sse(1_000, AgentRoutesTest.streamOf(AgentRoutesTest.READ, AgentRoutesTest.USAGE));
        List<ServerSentEvent<String>> seen = Collections.synchronizedList(new ArrayList<>());
        Disposable running = raw.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, anonymous("u1")).bodyValue(idea(IDEA))
                .retrieve().bodyToFlux(AgentRoutesTest.EVENTS).subscribe(seen::add);
        try {
            AgentRoutesTest.await(Duration.ofSeconds(10), () -> seen.stream().anyMatch(e -> "meta".equals(e.event())));
            String turnId = AgentRoutesTest.data(new ArrayList<>(seen), "meta").path("turnId").asText();
            int granted = admit.store().granted();
            long started = System.nanoTime();
            assertThat(refused(following(ANSWERED, turnId), anonymous("u1"), 409).path("code").asText()).isEqualTo("conflict");
            assertThat(Duration.ofNanos(System.nanoTime() - started)).as("it waited for the end first").isGreaterThan(Duration.ofMillis(2_500));
            assertThat(admit.store().followed()).isZero();
            assertThat(admit.store().granted()).isEqualTo(granted);
            assertThat(seen.stream().anyMatch(e -> "done".equals(e.event()) || "error".equals(e.event()))).as("the turn still running").isFalse();
        } finally {
            running.dispose();
        }
    }

    /**
     * A follow-up sent while the turn it follows still unwinds (a Stop, a client gone, its end not yet written: the
     * independent review of EA9.5, its mid): the admission waits for that end, then joins.
     */
    @Test
    void aFollowUpSentWhileItsTurnUnwindsWaitsForItsEnd() throws Exception {
        start();
        ai.wexy.forge.identity.Caller u1 = new ai.wexy.forge.identity.Caller("u1", true, false, "anonymous", TestAdmissions.NETWORK);
        String unwinding = ai.wexy.forge.records.Ulid.next(java.time.Instant.now());
        ai.wexy.forge.allowance.Grant entry = admit.admission().entry(u1, unwinding, IDEA, "turn");
        entry.spent();
        // Its end comes 400 ms after the follow-up is sent, as a cancelled turn's does once its call is disposed.
        Thread late = new Thread(() -> {
            try {
                Thread.sleep(400);
            } catch (InterruptedException e) {
                return;
            }
            entry.ended("cancelled", 1);
        });
        late.start();
        long started = System.nanoTime();
        ai.wexy.forge.allowance.Grant follow = admit.admission().followUp(u1, unwinding, ai.wexy.forge.records.Ulid.next(java.time.Instant.now()), ANSWERED);
        Duration took = Duration.ofNanos(System.nanoTime() - started);
        late.join();
        assertThat(follow).isNotNull();
        assertThat(follow.followUp()).isTrue();
        assertThat(follow.followed()).as("the end it waited for, and its calls")
                .isEqualTo(new ai.wexy.forge.allowance.Grant.Followed(unwinding, "cancelled", 1));
        assertThat(took).isBetween(Duration.ofMillis(300), Duration.ofMillis(2_900));
        assertThat(admit.store().followed()).isEqualTo(1);
        assertThat(admit.store().granted()).as("inside the one prompt").isEqualTo(1);
    }

    /** `retryOf` is a ULID, and never beside a base; one naming no turn of the caller's is refused, never granted. */
    @Test
    void retryOfIsAUlidNeverBesideABaseAndAnUnknownOneIsRefused() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        Map<String, Object> notUlid = following(ANSWERED, "turn-1");
        Map<String, Object> number = new HashMap<>(idea(ANSWERED));
        number.put("retryOf", 7);
        ObjectNode withBase = JSON.valueToTree(following(ANSWERED, "01JD0000000000000000000000"));
        withBase.set("base", AgentLoopTest.baseJson());

        assertThat(refused(notUlid, anonymous("u1"), 400).path("message").asText()).contains("retryOf is the turn this one follows");
        assertThat(refused(number, anonymous("u1"), 400).path("code").asText()).isEqualTo("bad-request");
        assertThat(refused(withBase, anonymous("u1"), 400).path("message").asText()).contains("retryOf is for a turn without a base");
        // A ULID that names no turn: refused, and the caller's one world is untouched (no fall-through to an entry).
        assertThat(refused(following(ANSWERED, "01JD0000000000000000000000"), anonymous("u1"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(fake.chatRequests()).isZero();
        assertThat(ledger.untouched()).isTrue();
        assertThat(store.snapshot()).isEmpty();
        assertThat(admit.store().granted()).isZero();
        assertThat(ended(idea(IDEA), anonymous("u1")).end()).isEqualTo("handed-off");
    }

    /** A revision's end is never written into its prompt: a world made, then a revision that fails, opens no follow-up. */
    @Test
    void aRevisionsEndOpensNoFollowUp() throws Exception {
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        String turnId = ended(idea(IDEA), anonymous("u1")).turnId();
        answers(NOT_AN_ACTION);
        ObjectNode revision = JSON.valueToTree(idea(IDEA));
        revision.set("base", AgentLoopTest.baseJson().put("turnId", turnId));
        List<ServerSentEvent<String>> failed = streamed(revision, anonymous("u1"));
        assertThat(AgentRoutesTest.names(failed)).contains("error");
        assertThat(grantOf(turnId)).containsEntry("end", "handed-off");

        assertThat(refused(following(ANSWERED, turnId), anonymous("u1"), 409).path("code").asText()).isEqualTo("conflict");
        String revisionId = AgentRoutesTest.data(failed, "meta").path("turnId").asText();
        assertThat(AgentRoutesTest.data(failed, "meta").has("followed")).as("a revision follows no turn").isFalse();
        assertThat(refused(following(ANSWERED, revisionId), anonymous("u1"), 409).path("code").asText()).isEqualTo("conflict");
        assertThat(admit.store().followed()).isZero();
    }

    // ---- the follow-up's count (the user, 2026-11-06: "yes u can go ahead with api change") -----------------------------

    /**
     * A follow-up's meta says the turn it follows as that turn wrote its end: its id, its end, and the model calls it
     * dispatched (its `call` events, seen by its client or not), so a client that never saw that end (a Stop, a drop, its
     * own deadline) counts those calls in its Q_C, not a whole turn's. Here the client leaves while its turn's second call
     * is still being charged: the loop counted that call, which never went out, so its end keeps one. A first turn's meta
     * names none.
     */
    @Test
    void aFollowUpsMetaSaysTheTurnItFollowsAndTheCallsItDispatched() throws Exception {
        admit = TestAdmissions.admit(TestAdmissions.wide(), Clock.systemUTC());
        meterDelay = 1_500;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        List<ServerSentEvent<String>> seen = Collections.synchronizedList(new ArrayList<>());
        Disposable leaving = raw.post().uri("/v1/agent/turn").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, anonymous("u1")).bodyValue(idea(IDEA))
                .retrieve().bodyToFlux(AgentRoutesTest.EVENTS).subscribe(seen::add);
        AgentRoutesTest.await(Duration.ofSeconds(20), () -> seen.stream().anyMatch(e -> "usage".equals(e.event())));
        leaving.dispose();
        JsonNode firstMeta = AgentRoutesTest.data(new ArrayList<>(seen), "meta");
        String stopped = firstMeta.path("turnId").asText();
        assertThat(firstMeta.has("followed")).as("a first turn follows none").isFalse();
        AgentRoutesTest.await(Duration.ofSeconds(20), () -> grantOf(stopped) != null && "cancelled".equals(grantOf(stopped).get("end")));
        assertThat(grantOf(stopped)).containsEntry("end", "cancelled").containsEntry("endCalls", "1");
        assertThat(new ArrayList<>(seen).stream().filter(e -> "call".equals(e.event())).count()).as("the one call it sent").isEqualTo(1);

        meterDelay = 0;
        start();
        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        List<ServerSentEvent<String>> second = streamed(following(IDEA, stopped), anonymous("u1"));
        JsonNode followed = AgentRoutesTest.data(second, "meta").path("followed");
        assertThat(followed.path("turnId").asText()).isEqualTo(stopped);
        assertThat(followed.path("end").asText()).isEqualTo("cancelled");
        assertThat(followed.path("calls").isInt()).isTrue();
        assertThat(followed.path("calls").asInt()).isEqualTo(1);
        assertThat(AgentRoutesTest.data(second, "done").path("status").asText()).isEqualTo("handed-off");
        // Its own end keeps its own two calls (READ, then the program); the prompt's one follow-up is spent.
        String secondId = AgentRoutesTest.data(second, "meta").path("turnId").asText();
        assertThat(grantOf(secondId)).containsEntry("end", "handed-off").containsEntry("endCalls", "2");
    }

    /**
     * An end a forge before the count wrote (a grant alive across the deploy, its calls not written): the follow-up's meta
     * says its calls are unknown (null), never a number it does not have, and the studio then counts that turn whole.
     */
    @Test
    void aFollowUpOfAnEndWrittenWithoutItsCallsSaysTheyAreUnknown() throws Exception {
        start();
        answers(ASK);
        Ended asked = ended(idea(IDEA), anonymous("u1"));
        assertThat(grantOf(asked.turnId())).containsEntry("end", "asked").containsEntry("endCalls", "1");
        admit.store().endedWithoutCalls(admit.store().grantOf(asked.turnId()), "asked");

        answers(AgentRoutesTest.READ, AgentRoutesTest.PROGRAM);
        List<ServerSentEvent<String>> answer = streamed(following(ANSWERED, asked.turnId()), anonymous("u1"));
        JsonNode followed = AgentRoutesTest.data(answer, "meta").path("followed");
        assertThat(followed.path("turnId").asText()).isEqualTo(asked.turnId());
        assertThat(followed.path("end").asText()).isEqualTo("asked");
        assertThat(followed.has("calls")).isTrue();
        assertThat(followed.path("calls").isNull()).as("unknown, never invented").isTrue();
    }
}
