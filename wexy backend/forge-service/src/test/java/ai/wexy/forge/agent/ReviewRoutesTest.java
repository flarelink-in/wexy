package ai.wexy.forge.agent;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.allowance.Grant;
import ai.wexy.forge.allowance.TestAdmissions;
import ai.wexy.forge.error.ErrorEnvelopeHandler;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.identity.InternalTokenFilter;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.records.Ulid;
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
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * EA-VR6 and the route's half of EA-VR8 (the frontend's visual-review design §9, §9.1, §10; EA6.4): {@code GET} and
 * {@code POST /v1/agent/review} over a real server, through the identity filter and the error envelope, against the fake
 * Meta API and the in-memory meter.
 *
 * <p>EA-VR6: while any of Q62's gates is unverified, the terms say which, and a review is refused before any record,
 * reservation or upstream byte. A review's frames go to the model as image parts after its text, as inline JPEG data
 * URLs; its reservation carries each frame's bound; its answer is held to {@code review-verdict.v1} and the pass and fail
 * rules, and an answer that is not a verdict, or has no usage, is {@code 502}, never a pass. The record keeps ids and
 * hashes, never a frame or R. Each answer's wire is pinned under {@code agent/review-wire/} ({@code -Dwexy.wire.write=true}
 * writes them), which the frontend copies to its fixtures for its client.
 */
class ReviewRoutesTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String PROMPT = "a toon castle on a green hill";
    static final String USAGE = "{\"choices\":[],\"usage\":{\"prompt_tokens\":3100,\"completion_tokens\":420,\"total_tokens\":3520,"
            + "\"completion_tokens_details\":{\"reasoning_tokens\":300}}}";
    static final String FAIL = "{\"verdict\":\"fail\",\"issues\":[{\"kind\":\"floating\",\"severity\":\"error\",\"sentence\":\"The castle floats about"
            + " two units above the hill in the side view; its walls should stand on the hill.\",\"scope\":\"modules\",\"modules\":[\"castlePlace\"]},"
            + "{\"kind\":\"scale\",\"severity\":\"warning\",\"sentence\":\"The hill dwarfs the castle in the framed view.\",\"scope\":\"program\","
            + "\"modules\":[]}]}";
    static final String PASS = "{\"verdict\":\"pass\",\"issues\":[]}";
    static final Path RECORDINGS = Path.of("src/test/resources/agent/review-wire");
    static final boolean WRITE = Boolean.getBoolean("wexy.wire.write");
    static final HttpClient HTTP = HttpClient.newHttpClient();
    static final Caller CALLER = new Caller("uid-agent", true, false, "anonymous", TestAdmissions.NETWORK);
    /** Every gate verified, as an operator records them after the vision probe passed. */
    static final ReviewProperties OPEN = new ReviewProperties("vision-20261103-120000", "meta", "meta-standard.2026-11-03", 1500);

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();
    TestAdmissions.Admit admit = TestAdmissions.open();
    /** An admission that lets every review in, for the test of the owner's check on its own; null: W1's real one. */
    ai.wexy.forge.allowance.PromptAdmission permissive;
    /** The review role's model and deadline, as a test may set them before {@link #start}. */
    String reviewModel = "muse-spark-1.3";
    Duration roleTimeout = Duration.ofSeconds(10);
    InMemoryGenerationStore store;
    String turnId;
    String baseUrl;
    private DisposableServer server;

    @AfterEach
    void stop() {
        restart();
        fake.close();
    }

    /** The server alone taken down, for a test that starts it again under other properties; the fake stays up. */
    private void restart() {
        if (server != null) {
            server.disposeNow();
            server = null;
        }
    }

    private void start(ReviewProperties review) {
        StringRedisTemplate template = ledger.template(0);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(5_000_000L, 5_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(5_000_000L, 5_000_000L)), SpendLanes.open()), new SimpleMeterRegistry());
        ModelProperties.Price price = new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"));
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of(ReviewHandler.ROLE, new ModelProperties.Role(reviewModel, "meta-spark", 6000, roleTimeout, "low", null)),
                Map.of("muse-spark-1.3", price, "muse-spark-1.3-contributor", price)), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2),
                Duration.ofSeconds(5)), new ObjectMapper(), org.springframework.web.reactive.function.client.WebClient.builder());
        PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of(ReviewHandler.ROLE), "classpath:prompts/", new HostContract(),
                new PathMatchingResourcePatternResolver()));
        store = new InMemoryGenerationStore(100, Duration.ofHours(2), Clock.systemUTC());
        ReviewHandler handler = new ReviewHandler(prompts, new MeteredModelClient(api, catalog, guard), catalog, store,
                new LoopProperties(null, Duration.ofMillis(50), null, false), new JsonSchemas(), permissive != null ? permissive : admit.admission(), review);
        HttpHandler http = RouterFunctions.toHttpHandler(new AgentConfiguration().reviewRoutes(handler), HandlerStrategies.builder()
                .webFilter(new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(AgentRoutesTest.GATEWAY.toPublicJWK()))))
                .exceptionHandler(new ErrorEnvelopeHandler())
                .build());
        server = HttpServer.create().host("127.0.0.1").port(0).handle(new ReactorHttpHandlerAdapter(http)).bindNow();
        baseUrl = "http://127.0.0.1:" + server.port();
        // The caller's turn: one of its calls on record, as AgentHandler's caller records it, and its prompt granted.
        turnId = Ulid.next(Instant.now());
        store.begin(Generation.started(Ulid.next(Instant.now()), Generation.Kind.AGENT, turnId, "agent", "muse-spark-1.3", "agent.v6", "h1", null, "{}",
                Generation.Source.USER, "uid-agent", Instant.now()));
        Grant grant = admit.admission().entry(CALLER, turnId, PROMPT, "turn");
        grant.spent();
    }

    private void answers(String text) {
        fake.chat = FakeMetaApi.sse(0, AgentRoutesTest.streamOf(text, USAGE));
    }

    /** A valid review of the castle: ReviewRequestTest's request, for this test's turn and prompt. */
    ObjectNode review() {
        ObjectNode b = ReviewRequestTest.request();
        b.put("turnId", turnId);
        ((ObjectNode) b.path("request")).put("prompt", PROMPT);
        return b;
    }

    record Answer(int status, String body) {
    }

    private Answer send(String method, Object body, String uid) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/agent/review"))
                .header("Accept", "application/json").header(InternalToken.HEADER, AgentRoutesTest.token(uid)).timeout(Duration.ofSeconds(30));
        if ("GET".equals(method)) {
            request.GET();
        } else {
            request.header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body instanceof String s ? s : JSON.writeValueAsString(body), StandardCharsets.UTF_8));
        }
        HttpResponse<String> response = HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new Answer(response.statusCode(), response.body());
    }

    private Answer post(Object body) throws Exception {
        return send("POST", body, "uid-agent");
    }

    /**
     * A document's ids named, as the recordings hold them; the frames' hashes too, since a JDK's JPEG encoder may draw the
     * probe's frames to other bytes.
     */
    private String named(String text) {
        String out = text.replace(turnId, "turn-1");
        out = out.replace(ReviewRequest.sha256(ReviewRequestTest.JPEG), "1".repeat(64))
                .replace(ReviewRequest.sha256(VisionProbe.frame(false)), "2".repeat(64));
        Matcher id = Pattern.compile("\"generationId\":\"([0-9A-Z]{26})\"").matcher(out);
        return id.find() ? out.replace(id.group(1), "gen-1") : out;
    }

    private static void pin(String name, String text) throws Exception {
        String pretty = JSON.writerWithDefaultPrettyPrinter().writeValueAsString(JSON.readTree(text)).replace("\r\n", "\n") + "\n";
        Path file = RECORDINGS.resolve(name);
        if (WRITE) {
            Files.createDirectories(RECORDINGS);
            Files.writeString(file, pretty, StandardCharsets.UTF_8);
            return;
        }
        assertThat(file).as("the recording %s: write it with -Dwexy.wire.write=true", name).exists();
        assertThat(pretty).isEqualTo(Files.readString(file, StandardCharsets.UTF_8).replace("\r\n", "\n"));
    }

    private List<Generation> reviewRecords() {
        return store.children(turnId).stream().filter(g -> ReviewHandler.ROLE.equals(g.role())).toList();
    }

    @Test
    void theTermsSayEachGateAndTheFirstNotMet() throws Exception {
        start(new ReviewProperties(null, "meta", "meta-standard.2026-11-03", null));
        Answer shut = send("GET", null, "uid-agent");
        assertThat(shut.status()).isEqualTo(200);
        JsonNode t = JSON.readTree(shut.body());
        assertThat(t.path("available").asBoolean()).isFalse();
        assertThat(t.path("gate").asText()).isEqualTo("images");
        assertThat(t.path("gates").toString()).isEqualTo("{\"images\":\"unverified\",\"transport\":\"unverified\",\"privacy\":\"verified\",\"metering\":\"unverified\"}");
        assertThat(t.path("provider").asText()).isEqualTo("meta");
        assertThat(t.path("model").asText()).isEqualTo("muse-spark-1.3");
        assertThat(t.path("mode").asText()).isEqualTo("standard");
        assertThat(t.path("policyVersion").asText()).isEqualTo("meta-standard.2026-11-03");
        assertThat(t.path("limits").path("requestBytes").asInt()).isEqualTo(1_048_576);
        assertThat(fake.requests()).isEmpty();
        pin("terms-shut.json", shut.body());
    }

    @Test
    void theTermsOfAnOpenReview() throws Exception {
        start(OPEN);
        Answer open = send("GET", null, "uid-agent");
        JsonNode t = JSON.readTree(open.body());
        assertThat(t.path("available").asBoolean()).isTrue();
        assertThat(t.path("gate").isNull()).isTrue();
        pin("terms-open.json", open.body());
    }

    /** EA-VR6: each gate unverified in turn refuses before any record, reservation or upstream byte, naming it. */
    @Test
    void aReviewIsRefusedBeforeAnyCallWhileAGateIsUnverified() throws Exception {
        Map<String, ReviewProperties> shut = Map.of(
                "images", new ReviewProperties(null, "meta", "meta-standard.2026-11-03", 1500),
                "privacy", new ReviewProperties("vision-20261103-120000", "meta", null, 1500),
                "metering", new ReviewProperties("vision-20261103-120000", "meta", "meta-standard.2026-11-03", null));
        for (Map.Entry<String, ReviewProperties> gate : shut.entrySet()) {
            start(gate.getValue());
            answers(FAIL);
            Answer refused = post(review());
            assertThat(refused.status()).as(gate.getKey()).isEqualTo(503);
            assertThat(JSON.readTree(refused.body()).path("code").asText()).isEqualTo("unavailable");
            assertThat(JSON.readTree(refused.body()).path("message").asText()).startsWith("EA_VISION_UNAVAILABLE " + gate.getKey() + ": ");
            // The gate before a byte of the body is read (the independent review of EA6.4): none, or no JSON, is still it.
            assertThat(post("").status()).as(gate.getKey() + ", no body").isEqualTo(503);
            assertThat(post("not json").status()).as(gate.getKey() + ", no JSON").isEqualTo(503);
            assertThat(fake.chatRequests()).as(gate.getKey()).isZero();
            assertThat(ledger.reservations()).as(gate.getKey()).isZero();
            assertThat(reviewRecords()).as(gate.getKey()).isEmpty();
            if (gate.getKey().equals("images")) {
                pin("unavailable.json", refused.body());
            }
            restart();
        }
    }

    @Test
    void aReviewSendsItsFramesAsImagePartsAndAnswersTheVerdictJudged() throws Exception {
        start(OPEN);
        answers(FAIL);
        ObjectNode body = review();
        Answer answer = post(body);
        assertThat(answer.status()).as(answer.body()).isEqualTo(200);
        JsonNode doc = JSON.readTree(answer.body());
        assertThat(doc.path("reviewId").asText()).isEqualTo("review-1");
        assertThat(doc.path("subject")).isEqualTo(body.path("subject"));
        assertThat(doc.path("frames").get(0).path("id").asText()).isEqualTo("review-1.v1");
        assertThat(doc.path("frames").get(0).path("sha256").asText()).isEqualTo(body.path("frames").get(0).path("sha256").asText());
        assertThat(doc.path("frames").get(1).path("sha256").asText()).isEqualTo(body.path("frames").get(1).path("sha256").asText());
        assertThat(doc.path("promptVersion").asText()).isEqualTo("review.v1");
        assertThat(doc.path("verdict").path("verdict").asText()).isEqualTo("fail");
        assertThat(doc.path("verdict").path("issues")).hasSize(2);
        assertThat(doc.path("verdict").path("issues").get(0).path("n").asInt()).isEqualTo(1);
        assertThat(doc.path("verdict").path("issues").get(0).path("modules").get(0).asText()).isEqualTo("castlePlace");
        assertThat(doc.path("usage").path("in").asLong()).isEqualTo(3100);
        assertThat(doc.path("usage").path("costMicroUsd").asLong()).isPositive();

        // To Meta: the template's system message, then one user message whose text is followed by both frames as inline
        // JPEG data URLs, in order; the verdict's schema as the response format.
        JsonNode sent = JSON.readTree(fake.requests().stream().filter(r -> r.path().endsWith("/chat/completions")).findFirst().orElseThrow().body());
        JsonNode messages = sent.path("messages");
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).path("content").asText()).startsWith("You review one live 3D world for Wexy");
        JsonNode parts = messages.get(1).path("content");
        assertThat(parts.isArray()).isTrue();
        assertThat(parts).hasSize(3);
        assertThat(parts.get(0).path("type").asText()).isEqualTo("text");
        String user = parts.get(0).path("text").asText();
        assertThat(user).contains(JSON.writeValueAsString(PROMPT)).contains(body.path("design").toString())
                .contains("- \"castlePlace\"").contains("1. The framed view").contains("2. The side view")
                .contains("- EA_SCALE: \"hill#batch's largest side is 26 times the rest's.\"").doesNotContain("base64");
        for (int i = 0; i < 2; i++) {
            assertThat(parts.get(i + 1).path("type").asText()).isEqualTo("image_url");
            assertThat(parts.get(i + 1).path("image_url").path("url").asText())
                    .isEqualTo("data:image/jpeg;base64," + body.path("frames").get(i).path("jpeg").asText());
        }
        assertThat(sent.path("response_format").path("json_schema").path("name").asText()).isEqualTo("review_verdict_v1");
        assertThat(sent.path("reasoning_effort").asText()).isEqualTo("low");

        // One AGENT record of role review under the turn, OK; its input names the frames by id and hash, never R or a frame.
        List<Generation> records = reviewRecords();
        assertThat(records).hasSize(1);
        Generation g = records.get(0);
        assertThat(g.status()).isEqualTo(Generation.Status.OK);
        assertThat(g.promptVersion()).isEqualTo("review.v1");
        assertThat(g.hostVersion()).isEqualTo("review-verdict.v1");
        assertThat(g.input()).contains("\"reviewId\":\"review-1\"").contains(body.path("frames").get(0).path("sha256").asText())
                .doesNotContain(PROMPT).doesNotContain(body.path("frames").get(0).path("jpeg").asText().substring(0, 64));
        // The reservation held each frame's bound beside the text's: at least 2 × 1,500 tokens at the input price.
        assertThat(g.chargedMicroUsd()).isGreaterThanOrEqualTo(2 * 1500 * 125 / 100);
        pin("fail.json", named(answer.body()));
    }

    @Test
    void aPassHasNoIssues() throws Exception {
        start(OPEN);
        answers(PASS);
        Answer answer = post(review());
        assertThat(answer.status()).as(answer.body()).isEqualTo(200);
        assertThat(JSON.readTree(answer.body()).path("verdict").toString()).isEqualTo("{\"verdict\":\"pass\",\"issues\":[]}");
        pin("pass.json", named(answer.body()));
    }

    /** §9: an answer that is not a verdict is never a pass: a 502, the record ERROR, the call still counted. */
    @Test
    void anAnswerThatIsNoVerdictIsAnUpstreamError() throws Exception {
        List<String> answers = List.of(
                "not json",
                // The independent review of EA6.4: text after the verdict, a second object after it, and a module named
                // twice (the browser refuses that, so a 200 would spend a call on an answer it then discards).
                PASS + " The castle floats above the hill.",
                PASS + "\n" + FAIL,
                "{\"verdict\":\"fail\",\"issues\":[{\"kind\":\"floating\",\"severity\":\"error\",\"sentence\":\"It floats.\",\"scope\":\"modules\","
                        + "\"modules\":[\"castlePlace\",\"castlePlace\"]}]}",
                "{\"verdict\":\"maybe\",\"issues\":[]}",
                "{\"verdict\":\"pass\",\"issues\":[{\"kind\":\"scale\",\"severity\":\"warning\",\"sentence\":\"Big.\",\"scope\":\"program\",\"modules\":[]}]}",
                "{\"verdict\":\"fail\",\"issues\":[]}",
                "{\"verdict\":\"fail\",\"issues\":[{\"kind\":\"floating\",\"severity\":\"error\",\"sentence\":\"It floats.\",\"scope\":\"modules\","
                        + "\"modules\":[\"towerPlace\"]}]}",
                "{\"verdict\":\"fail\",\"issues\":[{\"kind\":\"floating\",\"severity\":\"error\",\"sentence\":\"  \",\"scope\":\"modules\",\"modules\":[]}]}");
        for (String text : answers) {
            start(OPEN);
            answers(text);
            int reserved = ledger.reservations();
            Answer answer = post(review());
            assertThat(answer.status()).as(text).isEqualTo(502);
            assertThat(JSON.readTree(answer.body()).path("message").asText()).isEqualTo("The review didn't come through.");
            assertThat(reviewRecords().get(0).status()).isEqualTo(Generation.Status.ERROR);
            assertThat(ledger.reservations()).as("the call was reserved and made").isEqualTo(reserved + 1);
            if (text.startsWith("{\"verdict\":\"pass\"")) {
                pin("invalid.json", answer.body());
            }
            restart();
        }
    }

    @Test
    void anAnswerWithoutUsageIsNotUsed() throws Exception {
        start(OPEN);
        fake.chat = FakeMetaApi.sse(0, AgentRoutesTest.streamOf(FAIL, null));
        Answer answer = post(review());
        assertThat(answer.status()).isEqualTo(502);
        assertThat(JSON.readTree(answer.body()).path("message").asText()).contains("cost was not reported");
        assertThat(reviewRecords().get(0).status()).isEqualTo(Generation.Status.ERROR);
    }

    @Test
    void aConsentToAnotherPolicyIsRefusedBeforeAnyCall() throws Exception {
        start(OPEN);
        answers(FAIL);
        ObjectNode body = review();
        ((ObjectNode) body.path("consent")).put("policyVersion", "meta-standard.2026-10-01");
        Answer answer = post(body);
        assertThat(answer.status()).isEqualTo(400);
        assertThat(JSON.readTree(answer.body()).path("message").asText()).contains("ask the creator again");
        assertThat(fake.chatRequests()).isZero();
        assertThat(ledger.reservations()).isZero();
        assertThat(reviewRecords()).isEmpty();
    }

    @Test
    void aTurnThatIsNotTheCallersIsNotFound() throws Exception {
        start(OPEN);
        answers(FAIL);
        Answer answer = send("POST", review(), "uid-someone-else");
        assertThat(answer.status()).isEqualTo(404);
        assertThat(fake.chatRequests()).isZero();
        ObjectNode unknown = review();
        unknown.put("turnId", Ulid.next(Instant.now()));
        assertThat(post(unknown).status()).isEqualTo(404);
        assertThat(fake.chatRequests()).isZero();
        // The owner is asked before the frames are decoded (the independent review of EA6.4): another caller's review with
        // a frame that is no image is a 404; the owner's own, a 400 for the frame.
        ObjectNode bad = review();
        byte[] bare = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xC0, 0x00, 0x08, 0x08, 0x01, (byte) 0xB0, 0x03, 0x00, (byte) 0xFF, (byte) 0xD9};
        ReviewRequestTest.frames(bad, 0).put("jpeg", java.util.Base64.getEncoder().encodeToString(bare)).put("sha256", ReviewRequest.sha256(bare));
        assertThat(send("POST", bad, "uid-someone-else").status()).isEqualTo(404);
        assertThat(post(bad).status()).isEqualTo(400);
        assertThat(fake.chatRequests()).isZero();
    }

    /**
     * The independent review of EA6.4: a contributor-mode model's content trains Meta's (coding principles §11, R13), so
     * pointing the review role at one keeps the privacy gate shut, whatever the operator's facts say, and says why.
     */
    @Test
    void aContributorModelKeepsThePrivacyGateShut() throws Exception {
        reviewModel = "muse-spark-1.3-contributor";
        start(OPEN);
        answers(FAIL);
        JsonNode t = JSON.readTree(send("GET", null, "uid-agent").body());
        assertThat(t.path("available").asBoolean()).isFalse();
        assertThat(t.path("gate").asText()).isEqualTo("privacy");
        assertThat(t.path("mode").asText()).isEqualTo("contributor");
        assertThat(t.path("gates").path("privacy").asText()).isEqualTo("unverified");
        Answer refused = post(review());
        assertThat(refused.status()).isEqualTo(503);
        assertThat(JSON.readTree(refused.body()).path("message").asText()).isEqualTo("EA_VISION_UNAVAILABLE privacy: the review model"
                + " muse-spark-1.3-contributor is in Meta's contributor mode, whose content trains Meta's models: no frame goes to it");
        assertThat(fake.chatRequests()).isZero();
        assertThat(ledger.reservations()).isZero();
        assertThat(reviewRecords()).isEmpty();
    }

    /**
     * Each frame's bound is in the reservation, exactly (the independent review of EA6.4: an image bound of one token
     * passed, the output cap alone being larger than the bound the test asked for): 1,500 tokens more a frame, two frames,
     * at 1.25 micro-USD a token, is 3,750 micro-USD more.
     */
    @Test
    void theReservationHoldsEachFramesBoundExactly() throws Exception {
        long[] charged = new long[2];
        int[] bounds = {1500, 3000};
        for (int i = 0; i < 2; i++) {
            start(new ReviewProperties("vision-20261103-120000", "meta", "meta-standard.2026-11-03", bounds[i]));
            answers(FAIL);
            assertThat(post(review()).status()).isEqualTo(200);
            charged[i] = reviewRecords().get(0).chargedMicroUsd();
            restart();
        }
        assertThat(charged[1] - charged[0]).isEqualTo(2L * 1500 * 125 / 100);
    }

    /** §9: an answer cut at its cap, or declined, is never a verdict: a 502 in its own words, the call counted. */
    @Test
    void aCutOrDeclinedAnswerIsAnUpstreamError() throws Exception {
        Map<String, String> finishes = Map.of("length", "The model ran out of room reviewing these frames.",
                "content_filter", "The model declined to review these frames.");
        for (Map.Entry<String, String> f : finishes.entrySet()) {
            start(OPEN);
            fake.chat = FakeMetaApi.sse(0, java.util.Arrays.stream(AgentRoutesTest.streamOf(FAIL, USAGE))
                    .map(line -> line.equals(AgentRoutesTest.STOP) ? line.replace("\"stop\"", "\"" + f.getKey() + "\"") : line).toArray(String[]::new));
            int reserved = ledger.reservations();
            Answer answer = post(review());
            assertThat(answer.status()).as(f.getKey()).isEqualTo(502);
            assertThat(JSON.readTree(answer.body()).path("message").asText()).as(f.getKey()).isEqualTo(f.getValue());
            assertThat(reviewRecords().get(0).status()).isEqualTo(Generation.Status.ERROR);
            assertThat(ledger.reservations()).as("the call was reserved and made").isEqualTo(reserved + 1);
            restart();
        }
    }

    /** A review past its role's deadline: a 504, the record TIMEOUT, its reservation kept (never refunded). */
    @Test
    void aReviewPastItsDeadlineIsATimeout() throws Exception {
        roleTimeout = Duration.ofMillis(300);
        start(OPEN);
        fake.chat = FakeMetaApi.sseThenSilence(FakeMetaApi.textChunk("partial"), 5_000);
        Answer answer = post(review());
        assertThat(answer.status()).as(answer.body()).isEqualTo(504);
        assertThat(JSON.readTree(answer.body()).path("code").asText()).isEqualTo("timeout");
        Generation g = reviewRecords().get(0);
        assertThat(g.status()).isEqualTo(Generation.Status.TIMEOUT);
        assertThat(g.chargedMicroUsd()).isPositive();
    }

    /** The independent review of EA6.4: only a vision report's name, as the probe writes it, verifies the probe's gates. */
    @Test
    void onlyAProbeReportsNameVerifiesTheProbesGates() {
        for (String value : List.of("pending", "none", "false", "vision-1", "vision-20261103")) {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ReviewProperties(value, "meta", "meta-standard.2026-11-03", 1500))
                    .as(value).isInstanceOf(IllegalStateException.class).hasMessageContaining("vision-yyyyMMdd-HHmmss");
        }
        assertThat(new ReviewProperties("vision-20261103-120000", "meta", "meta-standard.2026-11-03", 1500).unmet()).isNull();
        assertThat(new ReviewProperties("  ", "meta", "meta-standard.2026-11-03", 1500).unmet()).isEqualTo("images");
    }

    /**
     * The turn's owner is checked on its own, before the admission: another caller's review is refused even by an
     * admission that would let it in (W1's would refuse it too, so the two are tested apart).
     */
    @Test
    void anotherCallersTurnIsRefusedBeforeItsAdmission() throws Exception {
        permissive = mock(ai.wexy.forge.allowance.PromptAdmission.class);
        start(OPEN);
        answers(FAIL);
        Answer answer = send("POST", review(), "uid-someone-else");
        assertThat(answer.status()).isEqualTo(404);
        assertThat(fake.chatRequests()).isZero();
        org.mockito.Mockito.verifyNoInteractions(permissive);
        assertThat(post(review()).status()).as("the owner's own review, admitted").isEqualTo(200);
    }

    /** W1: a review runs inside its turn's prompt, within its reviews; past them, 429 before any call. */
    @Test
    void aPromptsReviewsAreBounded() throws Exception {
        admit = TestAdmissions.admit(new ai.wexy.forge.allowance.AllowanceProperties(1000, 1000, 1000, 1000, 0, Duration.ofHours(2), 1000, 1000,
                1000, 1000, 1000, 1000, Duration.ofDays(400), TestAdmissions.UID_KEY, false, 1), Clock.systemUTC());
        start(OPEN);
        answers(FAIL);
        assertThat(post(review()).status()).isEqualTo(200);
        Answer second = post(review());
        assertThat(second.status()).isEqualTo(429);
        assertThat(JSON.readTree(second.body()).path("message").asText()).isEqualTo("This prompt has made all of its reviews.");
        assertThat(fake.chatRequests()).isEqualTo(1);
        // Another prompt's text is not this turn's: as a module call carrying it, refused as unknown.
        ObjectNode other = review();
        ((ObjectNode) other.path("request")).put("prompt", "something else");
        assertThat(post(other).status()).isEqualTo(404);
    }

    @Test
    void aBodyPastItsBytesIsRefusedAsItIsRead() throws Exception {
        start(OPEN);
        String huge = "{\"pad\":\"" + "x".repeat(ReviewRequest.MAX_REQUEST_BYTES) + "\"}";
        Answer answer = post(huge);
        assertThat(answer.status()).isEqualTo(413);
        assertThat(JSON.readTree(answer.body()).path("message").asText()).startsWith("EA_REVIEW_SIZE request");
        assertThat(fake.chatRequests()).isZero();
    }

    /** The request the browser sends, its frames' bytes left out: the shape the frontend's client is held to (EA-VR8). */
    @Test
    void theRequestsShapeIsRecorded() throws Exception {
        ObjectNode shape = ReviewRequestTest.request();
        shape.put("turnId", "turn-1");
        for (JsonNode f : shape.path("frames")) {
            ((ObjectNode) f).put("jpeg", "<base64 of the JPEG>").put("sha256", "<sha256 of the JPEG>");
        }
        pin("request.json", shape.toString());
    }
}
