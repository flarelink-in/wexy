package ai.wexy.forge.mock;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.GatewayStandIn;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.templates.Diagnostic;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.ChatRequest;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.FluxExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * R12, P7 (forge-loop design §12): the whole service under the mock profile, metering against a real
 * Redis container, behind a stand-in gateway. A plan and then its functions arrive as the recordings
 * say, byte for byte, through the real routes, filter, meter and stream; each scenario of §8 does
 * what it promises; and the mock refuses what Meta would refuse.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"test", "mock"})
@Testcontainers(disabledWithoutDocker = true)
class MockMetaApiTest {

    @Container
    private static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7.2-alpine")).withExposedPorts(6379);
    private static final GatewayStandIn GATEWAY = new GatewayStandIn();
    private static final int MOCK_PORT = freePort();
    private static final ParameterizedTypeReference<ServerSentEvent<String>> EVENTS = new ParameterizedTypeReference<>() {
    };
    private static final ObjectMapper JSON = new ObjectMapper();

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", REDIS::getHost);
        registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        registry.add("wexy.internal-jwt.jwks-uri", GATEWAY::jwksUri);
        registry.add("wexy.mock.port", () -> MOCK_PORT);
        registry.add("wexy.meta-api.base-url", () -> "http://127.0.0.1:" + MOCK_PORT + "/v1");
        registry.add("wexy.meta-api.api-key", () -> "mock-key-not-a-secret");
        // Instant streams, a short silence and a quick heartbeat, so the suite stays fast.
        registry.add("wexy.mock.tokens-per-second", () -> 0);
        registry.add("wexy.mock.slow-millis", () -> 300);
        registry.add("wexy.loop.heartbeat", () -> "50ms");
    }

    @AfterAll
    static void stopTheGateway() {
        GATEWAY.close();
    }

    @Autowired
    private WebTestClient client;
    @Autowired
    private MockMetaApi mock;
    @Autowired
    private InMemoryGenerationStore store;
    @Autowired
    private MetaApiClient api;
    @Autowired
    private PromptBuilder prompts;
    @Autowired
    private HostContract host;

    @BeforeEach
    void ok() {
        mock.scenario("ok");
        client = client.mutate().responseTimeout(Duration.ofSeconds(30)).build();
    }

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0, 0, InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** A recording as the mock streams it: LF line ends, no trailing blank lines. */
    private static String recording(String path) {
        try {
            return new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8).replace("\r\n", "\n").stripTrailing();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private String exemplar(String world, String fn) {
        return host.exemplars(fn).stream().filter(e -> e.world().equals(world)).findFirst().orElseThrow().code();
    }

    private List<ServerSentEvent<String>> stream(String path, String uid, Object body) {
        FluxExchangeResult<ServerSentEvent<String>> result = client.post().uri(path)
                .header(InternalToken.HEADER, GATEWAY.token(uid, true, false))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange()
                .expectStatus().isOk().returnResult(EVENTS);
        return result.getResponseBody().collectList().block(Duration.ofSeconds(30));
    }

    private WebTestClient.ResponseSpec post(String path, String uid, Object body) {
        return client.post().uri(path)
                .header(InternalToken.HEADER, GATEWAY.token(uid, true, false))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange();
    }

    private static List<String> names(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> e.event() != null).map(ServerSentEvent::event).toList();
    }

    private static String text(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> "delta".equals(e.event())).map(e -> data(e).path("text").asText()).collect(Collectors.joining());
    }

    private static JsonNode data(ServerSentEvent<String> event) {
        try {
            return JSON.readTree(event.data());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static JsonNode first(List<ServerSentEvent<String>> events, String name) {
        return data(events.stream().filter(e -> name.equals(e.event())).findFirst().orElseThrow());
    }

    private static Map<String, Object> plan(String idea) {
        return Map.of("prompt", idea, "style", "cosmic", "seconds", 12);
    }

    private String planId(List<ServerSentEvent<String>> events) {
        return first(events, "meta").path("generationId").asText();
    }

    /** R12, P7: the recorded plan, then the recorded function, byte for byte, each metered in Redis. */
    @Test
    void aPlanAndItsFunctionArriveByteForByteThroughTheRealService() {
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-r12", plan("a spiral galaxy, gold and blue"));

        assertThat(names(plan).get(0)).isEqualTo("meta");
        assertThat(names(plan).get(names(plan).size() - 1)).isEqualTo("done");
        assertThat(text(plan)).isEqualTo(recording("mock/plans/galaxy.json"));
        assertThat(first(plan, "meta").path("model").asText()).isEqualTo("muse-spark-1.3");
        assertThat(first(plan, "usage").path("out").asLong()).isEqualTo(MockMetaApi.tokens(recording("mock/plans/galaxy.json")));

        List<ServerSentEvent<String>> evolve = stream("/v1/forge/author", "uid-r12", Map.of("planId", planId(plan), "fn", "evolve"));
        assertThat(text(evolve)).isEqualTo(exemplar("galaxy", "evolve"));
        assertThat(names(evolve).get(names(evolve).size() - 1)).isEqualTo("done");

        List<Generation> ok = store.snapshot().stream().filter(g -> g.uid().equals("uid-r12")).toList();
        assertThat(ok).hasSize(2).allMatch(g -> g.status() == Generation.Status.OK)
                .allMatch(g -> g.chargedMicroUsd() > 0 && g.costMicroUsd() != null && g.costMicroUsd() > 0);
    }

    /** The second call of a template reads as cached, as Meta reports a cached prefix. */
    @Test
    void aTemplateStreamedBeforeReportsCachedTokens() {
        stream("/v1/forge/plan", "uid-cache", plan("a spiral galaxy"));
        List<ServerSentEvent<String>> again = stream("/v1/forge/plan", "uid-cache", plan("a spiral galaxy"));

        assertThat(first(again, "usage").path("cached").asLong()).isPositive();
    }

    @Test
    void aStormIdeaGetsTheStormPlanAndItsFunctions() {
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-storm", plan("a dark storm cloud with lightning inside"));

        assertThat(text(plan)).isEqualTo(recording("mock/plans/storm.json"));
        List<ServerSentEvent<String>> sky = stream("/v1/forge/author", "uid-storm", Map.of("planId", planId(plan), "fn", "sky"));
        assertThat(text(sky)).isEqualTo(exemplar("storm", "sky"));
    }

    /** The fault scenario: evolve comes back broken, the other functions as recorded. */
    @Test
    void theFaultScenarioServesTheBrokenEvolve() {
        mock.scenario("fault");
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-fault", plan("a spiral galaxy"));

        List<ServerSentEvent<String>> evolve = stream("/v1/forge/author", "uid-fault", Map.of("planId", planId(plan), "fn", "evolve"));
        assertThat(text(evolve)).isEqualTo(recording("mock/faults/galaxy.evolve.wgsl")).isNotEqualTo(exemplar("galaxy", "evolve"));
        List<ServerSentEvent<String>> look = stream("/v1/forge/author", "uid-fault", Map.of("planId", planId(plan), "fn", "look"));
        assertThat(text(look)).isEqualTo(exemplar("galaxy", "look"));
    }

    /** A repair of the fault answers with the world's exemplar: the fix. Through the mock alone; the route follows. */
    @Test
    void aRepairOfTheFaultAnswersWithTheFix() throws Exception {
        JsonNode draft = JSON.readTree(recording("mock/plans/galaxy.json"));
        Prompt prompt = prompts.repair("evolve", draft, recording("mock/faults/galaxy.evolve.wgsl"),
                List.of(new Diagnostic("compile", 11, 25, "type mismatch for argument 1 in call to 'hash11', expected 'f32', got 'u32'",
                        "let jitter = hash11(i) * 0.02;")), 1);

        String text = api.streamChat(new ChatRequest("muse-spark-1.3", prompt.messages(), 3000, null, "low", null))
                .map(ChatChunk::text).collect(Collectors.joining()).block(Duration.ofSeconds(10));

        assertThat(text).isEqualTo(exemplar("galaxy", "evolve"));
    }

    @Test
    void theDirectorGetsTheRecordedEdit() throws Exception {
        Prompt prompt = prompts.direct(JSON.readTree(recording("mock/plans/galaxy.json")), "make it glow more");

        String text = api.streamChat(new ChatRequest("muse-spark-1.3", prompt.messages(), 1500, null, "low", null))
                .map(ChatChunk::text).collect(Collectors.joining()).block(Duration.ofSeconds(10));

        assertThat(text).isEqualTo(recording("mock/edits/director.json"));
    }

    /** R3 across the real stack: Meta's in-stream error after the first chunk ends in exactly one error. */
    @Test
    void theErrorScenarioEndsTheStreamInOneUpstreamError() {
        mock.scenario("error-mid-stream");

        List<ServerSentEvent<String>> events = stream("/v1/forge/plan", "uid-error", plan("a spiral galaxy"));

        assertThat(names(events)).containsExactly("meta", "delta", "error");
        assertThat(first(events, "error").path("code").asText()).isEqualTo("upstream");
    }

    /** R4 across the real stack: a quiet model gets heartbeats and still finishes. */
    @Test
    void theSlowScenarioKeepsTheHeartbeatGoingAndFinishes() {
        mock.scenario("slow");

        List<ServerSentEvent<String>> events = stream("/v1/forge/plan", "uid-slow", plan("a spiral galaxy"));

        int firstHeartbeat = -1;
        for (int i = 0; i < events.size(); i++) {
            if ("hb".equals(events.get(i).comment())) {
                firstHeartbeat = i;
                break;
            }
        }
        assertThat(firstHeartbeat).isGreaterThan(-1);
        assertThat(names(events).get(names(events).size() - 1)).isEqualTo("done");
        assertThat(text(events)).isEqualTo(recording("mock/plans/galaxy.json"));
    }

    @Test
    void theModelsListIsTheConfiguredOnes() {
        assertThat(api.listModels().block(Duration.ofSeconds(5))).contains("muse-spark-1.3", "muse-wonder-1.0");
    }

    /** The cap is honoured as Meta honours it: the text is cut and the finish says length. */
    @Test
    void aRecordingLongerThanTheCapIsCutWithALengthFinish() {
        Prompt prompt = prompts.plan("a spiral galaxy", "cosmic", 12);

        List<ChatChunk> chunks = api.streamChat(new ChatRequest("muse-spark-1.3", prompt.messages(), 5, null, "low", null))
                .collectList().block(Duration.ofSeconds(10));

        String text = chunks.stream().map(ChatChunk::text).collect(Collectors.joining());
        assertThat(text).hasSize(20).isEqualTo(recording("mock/plans/galaxy.json").substring(0, 20));
        assertThat(chunks).anyMatch(c -> "length".equals(c.finishReason()));
        assertThat(chunks.stream().filter(c -> c.usage() != null).findFirst().orElseThrow().usage().completionTokens()).isEqualTo(5);
    }

    /** What Meta refuses, the mock refuses: a prompt that is not one of Wexy's templates, no reasoning, an unknown model. */
    @Test
    void aPromptThatIsNotATemplateIsRefused() {
        List<ChatMessage> free = List.of(ChatMessage.system("You are helpful."), ChatMessage.user("hello"));

        assertThatThrownBy(() -> api.streamChat(new ChatRequest("muse-spark-1.3", free, 100, null, "low", null)).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> {
                    assertThat(e.status()).isEqualTo(400);
                    assertThat(e.kind()).isEqualTo(UpstreamException.Kind.REJECTED);
                });
        Prompt prompt = prompts.plan("a spiral galaxy", "cosmic", 12);
        assertThatThrownBy(() -> api.streamChat(new ChatRequest("muse-spark-1.3", prompt.messages(), 100, null, "none", null)).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> assertThat(e.status()).isEqualTo(400));
        assertThatThrownBy(() -> api.streamChat(new ChatRequest("muse-code-9", prompt.messages(), 100, null, "low", null)).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> assertThat(e.status()).isEqualTo(404));
    }

    @Test
    void theScenarioMustBeAKnownOne() {
        assertThatThrownBy(() -> mock.scenario("chaos")).isInstanceOf(IllegalArgumentException.class);
        assertThat(mock.scenario()).isEqualTo("ok");
    }

    /** B0.4, R12 for repair: the fault scenario's evolve, repaired through the route, comes back as the exemplar, the fix. */
    @Test
    void aRepairOfTheFaultThroughTheRouteAnswersWithTheFix() {
        mock.scenario("fault");
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-repair", plan("a spiral galaxy"));
        List<ServerSentEvent<String>> evolve = stream("/v1/forge/author", "uid-repair", Map.of("planId", planId(plan), "fn", "evolve"));
        assertThat(text(evolve)).isEqualTo(recording("mock/faults/galaxy.evolve.wgsl"));
        mock.scenario("ok");

        List<ServerSentEvent<String>> repair = stream("/v1/forge/repair", "uid-repair", Map.of(
                "generationId", first(evolve, "meta").path("generationId").asText(),
                "diagnostics", List.of(Map.of("source", "tint", "line", 11, "column", 25,
                        "message", "type mismatch for argument 1 in call to 'hash11', expected 'f32', got 'u32'",
                        "snippet", "let jitter = hash11(i) * 0.02;"))));

        assertThat(names(repair).get(0)).isEqualTo("meta");
        assertThat(names(repair).get(names(repair).size() - 1)).isEqualTo("done");
        assertThat(first(repair, "meta").path("role").asText()).isEqualTo("repairer");
        assertThat(first(repair, "meta").path("fn").asText()).isEqualTo("evolve");
        assertThat(first(repair, "meta").path("promptVersion").asText()).isEqualTo("repair.v1");
        assertThat(text(repair)).isEqualTo(exemplar("galaxy", "evolve"));
        assertThat(store.find(first(repair, "meta").path("generationId").asText()).orElseThrow().status()).isEqualTo(Generation.Status.OK);
    }

    /** B0.4, R12 for direct: the recorded edit, validated, as one JSON document with the call's meta and usage. */
    @Test
    void theDirectorAnswersTheRecordedEditThroughTheRoute() throws Exception {
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-direct", plan("a spiral galaxy"));

        byte[] body = post("/v1/forge/direct", "uid-direct", Map.of("spec", JSON.readTree(text(plan)), "turn", "make it glow more"))
                .expectStatus().isOk().expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_JSON)
                .expectBody().returnResult().getResponseBody();
        JsonNode answer = JSON.readTree(body);

        assertThat(answer.path("edit")).isEqualTo(JSON.readTree(recording("mock/edits/director.json")).path("edit"));
        assertThat(answer.path("role").asText()).isEqualTo("director");
        assertThat(answer.path("model").asText()).isEqualTo("muse-spark-1.3");
        assertThat(answer.path("promptVersion").asText()).isEqualTo("director.v1");
        assertThat(answer.path("usage").path("out").asLong()).isEqualTo(MockMetaApi.tokens(recording("mock/edits/director.json")));
        Generation direct = store.find(answer.path("generationId").asText()).orElseThrow();
        assertThat(direct.kind()).isEqualTo(Generation.Kind.DIRECT);
        assertThat(direct.status()).isEqualTo(Generation.Status.OK);
        assertThat(direct.chargedMicroUsd()).isPositive();
    }

    /** B0.4, R10 through the real service: a report about one's own generations is accepted. */
    @Test
    void anOutcomeReportIsAccepted() {
        List<ServerSentEvent<String>> plan = stream("/v1/forge/plan", "uid-outcome", plan("a spiral galaxy"));

        post("/v1/forge/outcomes", "uid-outcome", Map.of("generationIds", List.of(planId(plan)),
                "ladder", Map.of("L0", Map.of("ok", true)), "firstPassOk", true, "repairs", 0, "autofixes", 0,
                "fps", 60.0, "adapter", "amd gcn-5", "browser", "chrome 155"))
                .expectStatus().isAccepted().expectBody().json("{}");
        post("/v1/forge/outcomes", "uid-outcome", Map.of("generationIds", List.of(planId(plan)),
                "ladder", Map.of("L0", Map.of("ok", true)), "firstPassOk", true, "repairs", 0, "autofixes", 0))
                .expectStatus().isAccepted();
    }
}
