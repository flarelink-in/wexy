package ai.wexy.forge.agent;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
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
import com.sun.net.httpserver.HttpExchange;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The vision probe (EA6.4; the frontend's visual-review design §9.1) against the fake Meta API: its three calls go out as a
 * review's do, its frames are real 768 × 432 JPEGs, and its judgement and measurement are what the operator acts on. A
 * model that fails the floating cube for floating and not the resting one passes; one that calls everything floating, or
 * answers without seeing, does not; the frame's tokens are the two calls' difference, and twice that is recommended.
 */
class VisionProbeTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String FLOATING = "{\"verdict\":\"fail\",\"issues\":[{\"kind\":\"floating\",\"severity\":\"error\",\"sentence\":\"The cube hovers above"
            + " the floor.\",\"scope\":\"modules\",\"modules\":[\"cubePlace\"]}]}";
    static final String PASS = "{\"verdict\":\"pass\",\"issues\":[]}";

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();

    @AfterEach
    void stop() {
        fake.close();
    }

    VisionProbe probe() {
        StringRedisTemplate template = ledger.template(0);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, 5_000_000L)), SpendLanes.open()), new SimpleMeterRegistry());
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of(ReviewHandler.ROLE, new ModelProperties.Role("muse-spark-1.3", "meta-spark", 6000, Duration.ofSeconds(10), "low", null)),
                Map.of("muse-spark-1.3", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2), Duration.ofSeconds(5)),
                new ObjectMapper(), org.springframework.web.reactive.function.client.WebClient.builder());
        PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of(ReviewHandler.ROLE), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver()));
        return new VisionProbe(prompts, new MeteredModelClient(api, catalog, guard), catalog, new JsonSchemas(),
                new LoopProperties(null, Duration.ofMillis(50), null, false));
    }

    /** The fake answers each call by what it was sent: with an image, `withImage` (by which frame), without, a pass. */
    void answers(String floating, String resting, long imageTokens) {
        AtomicInteger n = new AtomicInteger();
        fake.chat = (HttpExchange exchange, FakeMetaApi.Request request) -> {
            JsonNode body = JSON.readTree(request.body());
            JsonNode content = body.path("messages").get(1).path("content");
            boolean image = content.isArray();
            String text = !image ? PASS : n.getAndIncrement() == 0 ? floating : resting;
            long prompt = 2000 + (image ? imageTokens : 0);
            String usage = "{\"choices\":[],\"usage\":{\"prompt_tokens\":" + prompt + ",\"completion_tokens\":200,\"total_tokens\":" + (prompt + 200) + "}}";
            FakeMetaApi.sse(0, AgentRoutesTest.streamOf(text, usage)).respond(exchange, request);
        };
    }

    @Test
    void theProbesFramesAreWhole768By432Jpegs() {
        for (boolean floating : new boolean[]{true, false}) {
            byte[] jpeg = VisionProbe.frame(floating);
            ReviewRequest.Jpeg whole = ReviewRequest.jpeg(jpeg);
            assertThat(new int[]{whole.width(), whole.height()}).containsExactly(768, 432);
            assertThat(ReviewRequest.undecodable(whole)).isNull();
            assertThat(jpeg.length).isLessThan(ReviewRequest.MAX_JPEG_BYTES);
        }
        assertThat(VisionProbe.frame(true)).isNotEqualTo(VisionProbe.frame(false));
    }

    @Test
    void aModelThatSeesBothCubesPassesAndTheFramesCostIsMeasured() throws Exception {
        answers(FLOATING, PASS, 640);
        VisionProbe.Report report = probe().run("vision-test");
        assertThat(report.passed()).as(report.findings().toString()).isTrue();
        assertThat(report.exitCode()).isZero();
        assertThat(report.imageTokensMeasured()).isEqualTo(640);
        assertThat(report.imageTokensRecommended()).isEqualTo(1300);
        assertThat(report.findings()).anyMatch(f -> f.contains("WEXY_REVIEW_IMAGE_TOKENS=1300"))
                .anyMatch(f -> f.contains("WEXY_REVIEW_VISION_PROBE=vision-test"));
        // Three calls of the review role: two with one image part each, one with none; each reserved and settled.
        assertThat(fake.chatRequests()).isEqualTo(3);
        assertThat(ledger.reservations()).isEqualTo(3);
        long withImages = fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions"))
                .filter(r -> r.body().contains("data:image/jpeg;base64,")).count();
        assertThat(withImages).isEqualTo(2);
    }

    @Test
    void aModelThatCallsEverythingFloatingFails() {
        answers(FLOATING, FLOATING, 640);
        VisionProbe.Report report = probe().run("vision-test");
        assertThat(report.passed()).isFalse();
        assertThat(report.exitCode()).isOne();
        assertThat(report.findings()).anyMatch(f -> f.contains("the resting cube was called floating"));
    }

    @Test
    void aModelThatDoesNotSeeTheFloatFails() {
        answers(PASS, PASS, 640);
        assertThat(probe().run("vision-test").passed()).isFalse();
    }

    @Test
    void anAnswerOffTheSchemaIsATransportFailure() {
        answers("{\"verdict\":\"floating\"}", PASS, 640);
        VisionProbe.Report report = probe().run("vision-test");
        assertThat(report.passed()).isFalse();
        assertThat(report.findings().get(0)).startsWith("transport: the floating frame: off review-verdict.v1");
    }

    /** As the review route's (the independent review of EA6.4): text after the verdict is no verdict, so the probe fails. */
    @Test
    void anAnswerWithTextAfterItsVerdictIsNoVerdict() {
        answers(FLOATING + " The cube floats, as I said.", PASS, 640);
        VisionProbe.Report report = probe().run("vision-test");
        assertThat(report.passed()).isFalse();
        assertThat(report.findings().get(0)).startsWith("transport: the floating frame: not JSON");
    }

    @Test
    void aFrameThatCostsNothingIsNotAMeasurement() {
        answers(FLOATING, PASS, 0);
        VisionProbe.Report report = probe().run("vision-test");
        assertThat(report.passed()).isFalse();
        assertThat(report.imageTokensRecommended()).isNull();
    }
}
