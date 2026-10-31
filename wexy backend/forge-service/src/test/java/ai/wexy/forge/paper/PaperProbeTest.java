package ai.wexy.forge.paper;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendProperties;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MetaApiProperties;
import ai.wexy.forge.upstream.MeteredModelClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
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

/**
 * The paper test against the fake API, through the real meter and the real templates: the schema stays
 * in Meta's strict subset, the prompts quote what they say they quote with the request last, every call
 * is charged first and settled after, a strict refusal is asked once more without strict, and an answer
 * off the schema fails the run.
 */
class PaperProbeTest {

    /** An answer that matches paper-action.v1, as the fake streams it. */
    static final String VALID = """
            {"kind":"propose_design_and_program","context":null,
             "design":{"intent":"Blocks of terrain under a sepia film.","interpretation":"1870s film read as sepia grain and flicker.",
              "assumptions":[],"visualElements":[{"name":"terrain","description":"instanced cubes"}],"motion":"a slow pan",
              "techniques":[{"purpose":"draw the blocks","symbols":["core:NullGraph","materials:LambertMaterial"],"docIds":["api/core"]}],
              "resourceFlow":["instances feed the batch"],"cameraAndTiming":"a slow orbit","controls":[{"name":"grain","effect":"film grain strength"}],
              "successCriteria":["blocks stay readable"],"unresolved":[]},
             "program":{"objects":[{"id":"batch","symbol":"core:NullGraph","member":"createBatch","purpose":"the blocks","config":"{}","inputs":["instances"]}],
              "resources":[{"id":"instances","kind":"storage_buffer","purpose":"block instances","layout":"14 floats","strideFloats":14,"count":4096}],
              "modules":[],"schedule":[{"id":"draw","kind":"render","objectId":"batch","when":"frame","required":true,"reads":["instances"],"writes":[]}],
              "lifecycle":{"init":[],"fixedStep":[],"frame":[],"resize":[],"dispose":[]},"output":{"color":"batch","colorSpace":"srgb","depth":true},"controls":[]},
             "modules":null,"revision":null,"question":null,"finish":null}""";

    static final String USAGE = "{\"choices\":[],\"usage\":{\"prompt_tokens\":30000,\"completion_tokens\":2000,\"total_tokens\":32000,"
            + "\"completion_tokens_details\":{\"reasoning_tokens\":800},\"prompt_tokens_details\":{\"cached_tokens\":12000}}}";

    private final FakeMetaApi fake = new FakeMetaApi();
    private final InMemorySpendLedger ledger = new InMemorySpendLedger();
    private final ObjectMapper json = new ObjectMapper();
    private final PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of("paper"), "classpath:prompts/",
            new HostContract(), new PathMatchingResourcePatternResolver()));

    @AfterEach
    void stop() {
        fake.close();
    }

    private PaperProbe probe(String key) {
        StringRedisTemplate template = ledger.template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> redis = mock(ObjectProvider.class);
        when(redis.getIfAvailable()).thenReturn(template);
        // Room for six whole reservations: a refused call keeps its reservation (it ends without usage, Q43).
        SpendGuard guard = new SpendGuard(redis, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, 5_000_000L))), new SimpleMeterRegistry());
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of("paper", new ModelProperties.Role("muse-spark-1.3", "meta-spark", 16000, Duration.ofSeconds(10), "medium", null)),
                Map.of("muse-spark-1.3", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"), new BigDecimal("0.15")))),
                guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), key, Duration.ofSeconds(2),
                Duration.ofSeconds(5)), json, WebClient.builder());
        return new PaperProbe(api, new MeteredModelClient(api, catalog, guard), catalog, prompts, json);
    }

    /** The answer in three text chunks, a stop and the usage, as Meta streams it. */
    private FakeMetaApi.Responder streams(String answer) throws Exception {
        int third = answer.length() / 3;
        return FakeMetaApi.sse(0, content(answer.substring(0, third)), content(answer.substring(third, 2 * third)),
                content(answer.substring(2 * third)),
                "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}", USAGE, "[DONE]");
    }

    private String content(String text) throws Exception {
        return "{\"choices\":[{\"index\":0,\"delta\":{\"content\":" + json.writeValueAsString(text) + "},\"finish_reason\":null}]}";
    }

    private void awaitSettled(long costs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 3_000;
        while (ledger.totalForProvider("meta-spark") != costs && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
    }

    @Test
    void theSchemaStaysInMetasStrictSubsetAndTheValidAnswerMatchesIt() {
        var schema = PaperProbe.schema(json);
        assertThat(JsonSchemas.strictSubsetProblems(schema)).isEmpty();
        var validator = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(schema);
        assertThat(validator.validate(readTree(VALID))).isEmpty();
        assertThat(validator.validate(readTree("{\"kind\":\"propose_design_and_program\"}"))).isNotEmpty();
    }

    private com.fasterxml.jackson.databind.JsonNode readTree(String text) {
        try {
            return json.readTree(text);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void thePromptsQuoteTheIndexAndTheDocumentsAndEndWithTheRequest() {
        EngineBundle bundle = EngineBundle.load(json);
        PaperProbe.Requests requests = PaperProbe.requests(json);
        assertThat(requests.requests()).extracting(PaperProbe.Request::id).containsExactly("block-film", "galaxy", "foggy-dusk");

        String system = null;
        for (PaperProbe.Request request : requests.requests()) {
            Prompt prompt = prompts.paper(bundle.quote(request.docs()), request.text());
            assertThat(prompt.templateId()).isEqualTo("paper.v1");
            // One system message for every request, byte for byte, so the prompt cache can serve it.
            system = system == null ? prompt.system() : system;
            assertThat(prompt.system()).isEqualTo(system);
            assertThat(prompt.system()).contains(bundle.familyIndex().strip()).contains("null-graph 1.2.0").contains(bundle.bundleHash())
                    .contains("<document id=\"agent/guide\" sha256=\"" + bundle.doc("agent/guide").sha256() + "\"")
                    .contains("<document id=\"api/materials\"").doesNotContain("{{").doesNotContain("<!-- wexy prompt");
            assertThat(prompt.user()).endsWith("\"" + request.text() + "\"");
            for (String id : request.docs()) {
                assertThat(prompt.user()).contains("<document id=\"" + id + "\"");
            }
            // The cost stays bounded: about 30,000 tokens a call, and the charge's bound is one token per byte.
            assertThat(prompt.system().length() + prompt.user().length()).isLessThan(150_000);
        }
    }

    @Test
    void eachRequestIsAskedOnceUnderStrictThroughTheMeterAndItsAnswerReported() throws Exception {
        fake.chat = streams(VALID);

        PaperReport report = probe("real-looking-key").run();

        assertThat(report.exitCode()).isZero();
        assertThat(report.bundle().engineVersion()).isEqualTo("1.2.0");
        assertThat(report.template()).isEqualTo("paper.v1, paper-requests.v1, Wexy agent action, paper test v1");
        assertThat(report.answers()).hasSize(3).allSatisfy(a -> {
            assertThat(a.kind()).isEqualTo("propose_design_and_program");
            assertThat(a.schemaProblems()).isEmpty();
            assertThat(a.strict().ok()).isTrue();
            assertThat(a.strict().text()).isEqualTo(VALID);
            assertThat(a.strict().cachedTokens()).isEqualTo(12000);
            assertThat(a.notStrict()).isNull();
            assertThat(a.documents()).extracting(PaperReport.Doc::placed).startsWith("system", "system", "system", "system").endsWith("user");
        });
        assertThat(report.findings()).anyMatch(f -> f.startsWith("galaxy: propose_design_and_program, matching paper-action.v1 under strict"));
        assertThat(fake.chatRequests()).isEqualTo(3);
        assertThat(fake.requests()).filteredOn(r -> r.path().endsWith("/chat/completions")).hasSize(3)
                .allMatch(r -> r.body().contains("paper_action_v1") && r.body().contains("\"strict\":true"))
                .anyMatch(r -> r.body().contains("make minecraft 1870s film style"));

        // Each call was reserved first and settled to what its usage cost.
        long costs = report.answers().stream().mapToLong(a -> a.strict().costMicroUsd()).sum();
        awaitSettled(costs);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(costs);
        assertThat(ledger.reservations()).isEqualTo(3);
        assertThat(report.answers().get(0).strict().chargedMicroUsd()).isGreaterThan(report.answers().get(0).strict().costMicroUsd());
        assertThat(report.toString()).doesNotContain("real-looking-key");
    }

    @Test
    void aStrictRefusalIsRecordedAndAskedOnceMoreWithoutStrict() throws Exception {
        FakeMetaApi.Responder refused = FakeMetaApi.json(400, "{\"error\":{\"message\":\"response_format: schema not supported\"}}");
        FakeMetaApi.Responder answered = streams(VALID);
        fake.chat = (exchange, request) -> (request.body().contains("\"strict\":true") ? refused : answered).respond(exchange, request);

        PaperReport report = probe("real-looking-key").run();

        assertThat(report.exitCode()).isZero();
        assertThat(fake.chatRequests()).isEqualTo(6);
        assertThat(report.answers()).allSatisfy(a -> {
            assertThat(a.strict().ok()).isFalse();
            assertThat(a.notStrict()).isNotNull();
            assertThat(a.notStrict().strict()).isFalse();
            assertThat(a.notStrict().ok()).isTrue();
            assertThat(a.kind()).isEqualTo("propose_design_and_program");
        });
        assertThat(report.findings()).anyMatch(f -> f.startsWith("block-film: Meta refused paper-action.v1 under strict"));
    }

    @Test
    void anAnswerOffTheSchemaIsReportedAndFailsTheRun() throws Exception {
        fake.chat = streams("{\"kind\":\"propose_design_and_program\"}");

        PaperReport report = probe("real-looking-key").run();

        assertThat(report.exitCode()).isEqualTo(1);
        assertThat(report.answers()).allSatisfy(a -> assertThat(a.schemaProblems()).isNotEmpty());
        assertThat(report.findings()).anyMatch(f -> f.contains("but off paper-action.v1"));
    }

    @Test
    void withoutAKeyNothingIsAskedOrCharged() {
        PaperReport report = probe("").run();

        assertThat(report.exitCode()).isEqualTo(1);
        assertThat(report.answers()).isEmpty();
        assertThat(report.bundle().bundleHash()).matches("[0-9a-f]{64}");
        assertThat(report.findings()).anyMatch(f -> f.contains("WEXY_META_API_KEY"));
        assertThat(fake.requests()).isEmpty();
        assertThat(ledger.untouched()).isTrue();
    }
}
