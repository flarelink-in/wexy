package ai.wexy.forge.mock;

import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendLanes;
import ai.wexy.forge.spend.SpendProperties;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.ChatRequest;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MetaApiProperties;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.reactive.function.client.WebClient;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The mock Meta API of the {@code mock} profile, on its own (EA9.6's independent review: the Docker-backed test of it went
 * with h1's plan and functions, and with it the only test of what the profile answers). Hermetic: the real mock on a
 * loopback port, the real client and the real templates; no Redis, no service. The local evaluation and the drives run
 * against these answers: an agent turn's read then its program, a module's body (broken once under {@code fault}), a
 * review's verdict, and Meta's refusals.
 */
class MockMetaApiTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MODEL = "muse-spark-1.3";
    /** A JPEG's start and end markers: the mock checks how an image is sent, never its pixels. */
    private static final byte[] JPEG = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xD9};

    private final InMemorySpendLedger ledger = new InMemorySpendLedger();
    private ModelCatalog catalog;
    private PromptTemplates templates;
    private MockMetaApi mockApi;
    private MetaApiClient api;

    @BeforeEach
    void start() {
        int port = freePort();
        // Built first: the ledger's template is a stub of its own, and Mockito refuses one stubbed inside another.
        StringRedisTemplate redis = ledger.template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(redis);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(1_000_000L, 1_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(1_000_000L, 1_000_000L)), SpendLanes.open()), new SimpleMeterRegistry());
        ModelProperties.Role role = new ModelProperties.Role(MODEL, "meta-spark", 16000, Duration.ofSeconds(10), "high", null);
        catalog = new ModelCatalog(new ModelProperties(Map.of("agent", role, "module", role, "review", role),
                Map.of(MODEL, new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")))), guard);
        // The paper probe's template is loaded too: a template the mock has no recording for.
        templates = new PromptTemplates(Set.of("agent", "module", "review", "paper"), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver());
        MetaApiProperties meta = meta("http://127.0.0.1:" + port + "/v1");
        mockApi = new MockMetaApi(new MockProperties(port, 0, "ok", 300L), meta, catalog, templates, new HostContract(), JSON);
        api = new MetaApiClient(meta, new ObjectMapper(), WebClient.builder());
    }

    @AfterEach
    void stop() {
        if (mockApi != null) {
            mockApi.stop();
        }
    }

    private static MetaApiProperties meta(String baseUrl) {
        return new MetaApiProperties(baseUrl, "mock-key-not-a-secret", Duration.ofSeconds(2), Duration.ofSeconds(5));
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

    private String system(String template) {
        return templates.all().stream().filter(t -> t.name().equals(template)).findFirst().orElseThrow().system();
    }

    private static ChatRequest request(List<ChatMessage> messages) {
        return new ChatRequest(MODEL, messages, 16000, null, "high", null);
    }

    private String text(ChatRequest request) {
        return api.streamChat(request).map(ChatChunk::text).collect(Collectors.joining()).block(Duration.ofSeconds(10));
    }

    private List<ChatMessage> firstAgentCall() {
        return List.of(ChatMessage.system(system("agent")), ChatMessage.user("The idea, as data: \"a castle on a hill\""));
    }

    private List<ChatMessage> moduleCall(String template, String module) {
        return List.of(ChatMessage.system(system(template)), ChatMessage.user("The module: " + module + ", a compute stage.\n"));
    }

    private static void refused(ChatRequest request, MetaApiClient api, int status) {
        assertThatThrownBy(() -> api.streamChat(request).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> assertThat(e.status()).isEqualTo(status));
    }

    /** An agent turn's first call (two messages) asks for its documents; every later one gets the program. */
    @Test
    void anAgentTurnsFirstCallReadsAndItsNextGetsTheProgram() {
        assertThat(text(request(firstAgentCall()))).isEqualTo(recording("mock/agent/need-context.json"));

        List<ChatMessage> later = List.of(ChatMessage.system(system("agent")), ChatMessage.user("The idea, as data: \"a castle\""),
                ChatMessage.assistant(recording("mock/agent/need-context.json")), ChatMessage.user("The documents you asked for."));
        assertThat(text(request(later))).isEqualTo(recording("mock/agent/program.json"));
    }

    /** A module call gets its module's body; under `fault` an author gets the broken one once, a repair the right one. */
    @Test
    void aModuleCallGetsItsBodyAndTheFaultScenarioBreaksTheAuthors() {
        assertThat(text(request(moduleCall("module.author", "place")))).isEqualTo(recording("mock/modules/place.wgsl"));

        mockApi.scenario("fault");
        assertThat(text(request(moduleCall("module.author", "place")))).isEqualTo(recording("mock/modules/place.fault.wgsl"))
                .isNotEqualTo(recording("mock/modules/place.wgsl"));
        assertThat(text(request(moduleCall("module.repair", "place")))).isEqualTo(recording("mock/modules/place.wgsl"));
        // A module the mock has no body for is refused, as Meta refuses a request.
        refused(request(moduleCall("module.author", "nowhere")), api, 400);
    }

    /** A review gets the mock's verdict whatever its frames show; one without frames is refused. */
    @Test
    void aReviewGetsTheRecordedVerdictAndMustCarryItsFrames() {
        List<ChatMessage> review = List.of(ChatMessage.system(system("review")),
                ChatMessage.user("The world on the stage, two frames.", List.of(new ChatMessage.Image(JPEG, 600), new ChatMessage.Image(JPEG, 600))));
        assertThat(text(request(review))).isEqualTo(recording("mock/review/verdict.json"));

        refused(request(List.of(ChatMessage.system(system("review")), ChatMessage.user("No frames."))), api, 400);
    }

    /**
     * A template the mock has no recording for is refused with 400 (EA9.6's independent review): it was a thrown exception,
     * which closed the connection with no answer at all.
     */
    @Test
    void aTemplateWithoutARecordingIsRefusedNotDropped() {
        assertThatThrownBy(() -> api.streamChat(request(List.of(ChatMessage.system(system("paper")), ChatMessage.user("a request"))))
                .blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> {
                    assertThat(e.status()).isEqualTo(400);
                    assertThat(e.kind()).isEqualTo(UpstreamException.Kind.REJECTED);
                });
    }

    /** What Meta refuses, the mock refuses: a prompt that is not one of Wexy's templates, no reasoning, an unknown model. */
    @Test
    void aPromptThatIsNotATemplateIsRefused() {
        List<ChatMessage> free = List.of(ChatMessage.system("You are helpful."), ChatMessage.user("hello"));
        assertThatThrownBy(() -> api.streamChat(request(free)).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> {
                    assertThat(e.status()).isEqualTo(400);
                    assertThat(e.kind()).isEqualTo(UpstreamException.Kind.REJECTED);
                });
        refused(new ChatRequest(MODEL, firstAgentCall(), 100, null, "none", null), api, 400);
        refused(new ChatRequest("muse-code-9", firstAgentCall(), 100, null, "high", null), api, 404);
    }

    /** The cap is honoured as Meta honours it: the text is cut and the finish says length. */
    @Test
    void aRecordingLongerThanTheCapIsCutWithALengthFinish() {
        List<ChatChunk> chunks = api.streamChat(new ChatRequest(MODEL, firstAgentCall(), 5, null, "high", null))
                .collectList().block(Duration.ofSeconds(10));

        String text = chunks.stream().map(ChatChunk::text).collect(Collectors.joining());
        assertThat(text).hasSize(20).isEqualTo(recording("mock/agent/need-context.json").substring(0, 20));
        assertThat(chunks).anyMatch(c -> "length".equals(c.finishReason()));
        assertThat(chunks.stream().filter(c -> c.usage() != null).findFirst().orElseThrow().usage().completionTokens()).isEqualTo(5);
    }

    /** The second call of a template reads as cached, as Meta reports a cached prefix. */
    @Test
    void aTemplateStreamedBeforeReportsCachedTokens() {
        ChatChunk.Usage first = api.streamChat(request(firstAgentCall())).filter(c -> c.usage() != null).blockLast(Duration.ofSeconds(10)).usage();
        ChatChunk.Usage again = api.streamChat(request(firstAgentCall())).filter(c -> c.usage() != null).blockLast(Duration.ofSeconds(10)).usage();

        assertThat(first.cachedTokens() == null ? 0L : first.cachedTokens()).isZero();
        assertThat(again.cachedTokens()).isPositive();
    }

    /** Meta's in-stream error after the first chunk ends the stream in one upstream error. */
    @Test
    void theErrorScenarioEndsTheStreamAfterItsFirstChunk() {
        mockApi.scenario("error-mid-stream");
        List<String> seen = new CopyOnWriteArrayList<>();

        assertThatThrownBy(() -> api.streamChat(request(firstAgentCall())).doOnNext(c -> seen.add(c.text())).blockLast(Duration.ofSeconds(10)))
                .isInstanceOf(UpstreamException.class);
        assertThat(String.join("", seen)).isNotEmpty().isEqualTo(recording("mock/agent/need-context.json").substring(0, String.join("", seen).length()));
    }

    /** A quiet model: `slow` says nothing for its while after the first chunk, then finishes the recording. */
    @Test
    void theSlowScenarioGoesQuietThenFinishes() {
        mockApi.scenario("slow");
        long started = System.nanoTime();

        assertThat(text(request(firstAgentCall()))).isEqualTo(recording("mock/agent/need-context.json"));
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(300));
    }

    @Test
    void theModelsListIsTheConfiguredOnes() {
        assertThat(api.listModels().block(Duration.ofSeconds(5))).containsExactly(MODEL);
    }

    @Test
    void theScenarioMustBeAKnownOne() {
        assertThatThrownBy(() -> mockApi.scenario("chaos")).isInstanceOf(IllegalArgumentException.class);
        assertThat(mockApi.scenario()).isEqualTo("ok");
    }

    /** A mock must never answer a deployment: it starts only on the loopback base URL its own port makes. */
    @Test
    void theMockAnswersOnTheLoopbackOnly() {
        int port = freePort();
        for (String baseUrl : List.of("https://api.meta.ai/v1", "http://127.0.0.1:" + (port + 1) + "/v1", "http://127.0.0.1:" + port + "/v2")) {
            assertThatThrownBy(() -> new MockMetaApi(new MockProperties(port, 0, "ok", 300L), meta(baseUrl), catalog, templates,
                    new HostContract(), JSON)).as(baseUrl).isInstanceOf(IllegalStateException.class).hasMessageContaining("loopback");
        }
    }
}
