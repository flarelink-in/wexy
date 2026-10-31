package ai.wexy.forge.probe;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
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
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.reactive.function.client.WebClient;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** The probe against a fake API: what it asks, what it concludes, and that it charges like any call. */
class HourOneProbeTest {

    private final FakeMetaApi fake = new FakeMetaApi();
    private final InMemorySpendLedger ledger = new InMemorySpendLedger();
    private final ObjectMapper json = new ObjectMapper();

    @AfterEach
    void stop() {
        fake.close();
    }

    private HourOneProbe probe(String key) {
        // Built before stubbing: creating a mock inside another mock's when() is unfinished stubbing.
        StringRedisTemplate template = ledger.template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> redis = mock(ObjectProvider.class);
        when(redis.getIfAvailable()).thenReturn(template);
        Map<String, SpendProperties.Cap> providers = Map.of(
                "meta-spark", new SpendProperties.Cap(1_000_000L, 1_000_000L),
                "meta-wonder", new SpendProperties.Cap(1_000_000L, 1_000_000L));
        SpendGuard guard = new SpendGuard(redis, new SpendProperties(null,
                new SpendProperties.Cap(2_000_000L, 2_000_000L), providers), new SimpleMeterRegistry());
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of("planner", new ModelProperties.Role("muse-spark-1.3", "meta-spark", 1500, Duration.ofSeconds(5), null, null),
                        "escalator", new ModelProperties.Role("muse-wonder-1.0", "meta-wonder", 1500, Duration.ofSeconds(5), null, null)),
                Map.of("muse-spark-1.3", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")),
                        "muse-wonder-1.0", new ModelProperties.Price(new BigDecimal("4.00"), new BigDecimal("20.00")))),
                guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), key, Duration.ofSeconds(2),
                Duration.ofSeconds(2)), json, WebClient.builder());
        PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of("planner"), "classpath:prompts/",
                new HostContract(), new PathMatchingResourcePatternResolver()));
        return new HourOneProbe(api, new MeteredModelClient(api, catalog, guard), catalog, json, prompts, new JsonSchemas());
    }

    @Test
    void aWorkingKeyYieldsTheFactsThePlanNeeds() throws Exception {
        fake.models = FakeMetaApi.json(200,
                "{\"data\":[{\"id\":\"muse-spark-1.3\"},{\"id\":\"muse-wonder-1.0\"},{\"id\":\"muse-code-1\"}]}");
        // The structured-output request (it carries response_format) gets JSON back; the others "ok".
        FakeMetaApi.Responder hello = FakeMetaApi.sse(0, FakeMetaApi.OK_STREAM_CHUNKS.split("\n"));
        FakeMetaApi.Responder structured = FakeMetaApi.sse(0, FakeMetaApi.textChunk("{\\\"ok\\\": true}"),
                "{\"choices\":[],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":6,\"total_tokens\":36}}", "[DONE]");
        fake.chat = (exchange, request) -> (request.body().contains("response_format") ? structured : hello)
                .respond(exchange, request);

        ProbeReport report = probe("real-looking-key").run();

        assertThat(report.exitCode()).isZero();
        assertThat(report.configured()).containsEntry("muse-spark-1.3", true).containsEntry("muse-wonder-1.0", true);
        assertThat(report.codeModels()).containsExactly("muse-code-1");
        assertThat(report.calls()).hasSize(4).allMatch(ProbeReport.Call::ok);

        ProbeReport.Call spark = report.calls().stream()
                .filter(c -> c.purpose().equals("hello") && c.model().equals("muse-spark-1.3")).findFirst().orElseThrow();
        assertThat(spark.text()).isEqualTo("ok");
        assertThat(spark.usageChunk()).isEqualTo(spark.chunks());
        assertThat(spark.completionTokens()).isEqualTo(2);
        assertThat(spark.chargedMicroUsd()).isGreaterThan(spark.costMicroUsd());
        assertThat(report.findings()).anyMatch(f -> f.startsWith("Structured output: honoured"));
        // The fake answers {"ok": true} to the real planner call too: JSON, but not a draft.
        assertThat(report.findings()).anyMatch(f -> f.startsWith("Strict draft: JSON came back, but off the schema"));
        ProbeReport.Call draft = report.calls().stream().filter(c -> c.purpose().equals("strict-draft")).findFirst().orElseThrow();
        assertThat(draft.maxOutputTokens()).isEqualTo(1500);
        assertThat(fake.requests().stream().filter(r -> r.body().contains("scene_draft_v1") && r.body().contains("\"strict\":true")).count()).isEqualTo(1);

        // Every call went through the meter, and was settled to what its usage cost.
        long costs = report.calls().stream().mapToLong(ProbeReport.Call::costMicroUsd).sum();
        long deadline = System.currentTimeMillis() + 3_000;
        while (ledger.totalForProvider("meta-spark") + ledger.totalForProvider("meta-wonder") != costs && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertThat(ledger.totalForProvider("meta-spark") + ledger.totalForProvider("meta-wonder")).isEqualTo(costs);
        assertThat(ledger.reservations()).isEqualTo(4);
        assertThat(report.toString()).doesNotContain("real-looking-key");
    }

    @Test
    void withoutAKeyNothingIsAskedOrCharged() {
        ProbeReport report = probe("").run();

        assertThat(report.exitCode()).isEqualTo(1);
        assertThat(report.findings()).anyMatch(f -> f.contains("WEXY_META_API_KEY"));
        assertThat(fake.requests()).isEmpty();
        assertThat(ledger.untouched()).isTrue();
    }

    @Test
    void aRefusedKeyStopsBeforeAnyChargedCall() {
        fake.models = FakeMetaApi.json(401, "{\"error\":{\"message\":\"invalid key\"}}");

        ProbeReport report = probe("revoked-key").run();

        assertThat(report.exitCode()).isEqualTo(1);
        assertThat(report.findings()).anyMatch(f -> f.contains("refused the key"));
        assertThat(fake.chatRequests()).isZero();
        assertThat(ledger.untouched()).isTrue();
    }

    @Test
    void aConfiguredModelTheApiDoesNotListIsSkippedAndSaidSo() {
        fake.models = FakeMetaApi.json(200, "{\"data\":[{\"id\":\"muse-spark-1.3\"}]}");

        ProbeReport report = probe("real-looking-key").run();

        assertThat(report.configured()).containsEntry("muse-wonder-1.0", false);
        assertThat(report.calls()).noneMatch(c -> c.model().equals("muse-wonder-1.0"));
        assertThat(report.findings()).anyMatch(f -> f.contains("'muse-wonder-1.0' is not listed"));
    }
}
