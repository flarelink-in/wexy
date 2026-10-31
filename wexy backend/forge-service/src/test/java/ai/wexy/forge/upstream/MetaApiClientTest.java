package ai.wexy.forge.upstream;

import ai.wexy.forge.FakeMetaApi;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The transport against a fake OpenAI-compatible API: what is sent, what is read, how it fails. */
class MetaApiClientTest {

    private static final String KEY = "test-key-123";
    private static final ObjectMapper JSON = new ObjectMapper();

    private final FakeMetaApi fake = new FakeMetaApi();

    @AfterEach
    void stop() {
        fake.close();
    }

    private MetaApiClient client(String key, Duration readIdle) {
        return new MetaApiClient(new MetaApiProperties(fake.baseUrl(), key, Duration.ofSeconds(2), readIdle),
                JSON, WebClient.builder());
    }

    private MetaApiClient client() {
        return client(KEY, Duration.ofSeconds(2));
    }

    private static ChatRequest hello(Map<String, Object> responseFormat) {
        return new ChatRequest("m-1", List.of(ChatMessage.system("one word"), ChatMessage.user("say ok")), 64,
                responseFormat);
    }

    @Test
    void aStreamYieldsItsTextItsFinishAndItsUsage() {
        List<ChatChunk> chunks = client().streamChat(hello(null)).collectList().block(Duration.ofSeconds(10));

        assertThat(chunks.stream().map(ChatChunk::text).collect(Collectors.joining())).isEqualTo("ok");
        assertThat(chunks).anyMatch(chunk -> "stop".equals(chunk.finishReason()));
        ChatChunk.Usage usage = chunks.get(chunks.size() - 1).usage();
        assertThat(usage).isEqualTo(new ChatChunk.Usage(21, 2, 23, 0L, null));
    }

    @Test
    void aUsageWithoutWholeTokenCountsIsAbsentSoTheReservationStands() {
        // The outside review of 2026-10-28: "usage": {} was read as zero tokens, and the settlement refunded the
        // reservation down to one micro-dollar. A usage counts only with both counts whole and not negative (R18).
        MetaApiClient client = client();
        for (String usage : List.of("{}", "{\"prompt_tokens\":21}", "{\"completion_tokens\":2}",
                "{\"prompt_tokens\":-1,\"completion_tokens\":2}", "{\"prompt_tokens\":\"21\",\"completion_tokens\":2}",
                "{\"prompt_tokens\":21.5,\"completion_tokens\":2}", "{\"prompt_tokens\":null,\"completion_tokens\":2}",
                "{\"prompt_tokens\":21,\"completion_tokens\":true}")) {
            assertThat(client.chunk("{\"choices\":[],\"usage\":" + usage + "}").usage()).as(usage).isNull();
        }
        assertThat(client.chunk("{\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":0}}").usage())
                .isEqualTo(new ChatChunk.Usage(21, 0, 0, null, null));
        assertThat(client.chunk("{\"choices\":[],\"usage\":{\"prompt_tokens\":21.0,\"completion_tokens\":2,\"total_tokens\":23}}").usage())
                .isEqualTo(new ChatChunk.Usage(21, 2, 23, null, null));
    }

    @Test
    void theRequestIsTheOpenAiShapeWithTheKeyAndUsageAskedFor() throws Exception {
        client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10));

        FakeMetaApi.Request request = fake.requests().get(0);
        assertThat(request.method()).isEqualTo("POST");
        assertThat(request.path()).isEqualTo("/v1/chat/completions");
        assertThat(request.header("Authorization")).isEqualTo("Bearer " + KEY);
        assertThat(request.header("Accept")).contains("text/event-stream");

        JsonNode body = JSON.readTree(request.body());
        assertThat(body.path("model").asText()).isEqualTo("m-1");
        assertThat(body.path("max_completion_tokens").asInt()).isEqualTo(64);
        // max_tokens is Meta's deprecated alias (forge-loop design §4.1); no reasoning effort or safety id unless set.
        assertThat(body.has("max_tokens")).isFalse();
        assertThat(body.has("reasoning_effort")).isFalse();
        assertThat(body.has("safety_identifier")).isFalse();
        assertThat(body.path("stream").asBoolean()).isTrue();
        assertThat(body.path("stream_options").path("include_usage").asBoolean()).isTrue();
        assertThat(body.path("messages").get(1).path("content").asText()).isEqualTo("say ok");
        assertThat(body.has("response_format")).isFalse();
    }

    @Test
    void aResponseFormatIsSentOnlyWhenAsked() throws Exception {
        client().streamChat(hello(Map.of("type", "json_object"))).blockLast(Duration.ofSeconds(10));

        assertThat(JSON.readTree(fake.requests().get(0).body()).path("response_format").path("type").asText())
                .isEqualTo("json_object");
    }

    @Test
    void aReasoningEffortAndASafetyIdentifierAreSentWhenSet() throws Exception {
        client().streamChat(new ChatRequest("m-1", List.of(ChatMessage.user("say ok")), 64, null, "low", "abc123"))
                .blockLast(Duration.ofSeconds(10));

        JsonNode body = JSON.readTree(fake.requests().get(0).body());
        assertThat(body.path("reasoning_effort").asText()).isEqualTo("low");
        assertThat(body.path("safety_identifier").asText()).isEqualTo("abc123");
    }

    /** Meta reports a failure inside a stream as {"type":"error",...}; it must end the stream, not vanish. */
    @Test
    void metasInStreamErrorEventFailsTheStreamWithItsCode() {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("o"),
                "{\"type\":\"error\",\"code\":\"server_error\",\"message\":\"overloaded\"}");

        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> {
                    assertThat(e.kind()).isEqualTo(UpstreamException.Kind.SERVER);
                    assertThat(e.excerpt()).isEqualTo("server_error: overloaded");
                });
    }

    @Test
    void modelIdsAreListed() {
        fake.models = FakeMetaApi.json(200, "{\"data\":[{\"id\":\"muse-spark-1.3\"},{\"id\":\"muse-wonder-1.0\"}]}");

        assertThat(client().listModels().block(Duration.ofSeconds(10))).containsExactly("muse-spark-1.3", "muse-wonder-1.0");
    }

    /** Some providers echo part of a refused key; the excerpt goes to logs and files, so it is scrubbed. */
    @Test
    void aRefusedKeyIsAuthAndTheExcerptNeverHoldsTheKey() {
        fake.chat = FakeMetaApi.json(401, "{\"error\":{\"message\":\"Incorrect API key provided: " + KEY + "\"}}");

        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class, e -> {
                    assertThat(e.kind()).isEqualTo(UpstreamException.Kind.AUTH);
                    assertThat(e.status()).isEqualTo(401);
                    assertThat(e.excerpt()).contains("<key>").doesNotContain(KEY);
                    assertThat(e.describe()).doesNotContain(KEY);
                });
    }

    @Test
    void rateLimitsAndServerErrorsAreToldApart() {
        fake.chat = FakeMetaApi.json(429, "{}");
        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.RATE_LIMITED));

        fake.chat = FakeMetaApi.json(503, "{}");
        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.SERVER));
    }

    @Test
    void anErrorInsideAStreamFailsIt() {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("o"), "{\"error\":{\"message\":\"overloaded\"}}");

        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.SERVER));
    }

    @Test
    void aStreamThatGoesQuietTimesOut() {
        fake.chat = FakeMetaApi.sseThenSilence(FakeMetaApi.textChunk("o"), 3_000);

        assertThatThrownBy(() -> client(KEY, Duration.ofMillis(500)).streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.TIMEOUT));
    }

    @Test
    void anAnswerThatIsNotAStreamIsMalformed() {
        fake.chat = FakeMetaApi.json(200, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");

        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.MALFORMED));
    }

    /** Cut after some text, with no finish reason and no [DONE]: a partial answer must not pass as whole. */
    @Test
    void aStreamCutBeforeTheModelFinishedIsMalformed() {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("o"));

        assertThatThrownBy(() -> client().streamChat(hello(null)).blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.MALFORMED));
    }

    /** A client that walks away must stop the model writing, and billing, for nobody. */
    @Test
    void cancellingAStreamClosesTheUpstreamConnection() throws Exception {
        String[] slow = new String[40];
        java.util.Arrays.fill(slow, FakeMetaApi.textChunk("x"));
        fake.chat = FakeMetaApi.sse(100, slow);

        client().streamChat(hello(null)).take(1).blockLast(Duration.ofSeconds(10));

        long deadline = System.currentTimeMillis() + 5_000;
        while (!fake.clientWentAway() && System.currentTimeMillis() < deadline) {
            Thread.sleep(50);
        }
        assertThat(fake.clientWentAway()).as("the fake saw the connection close mid-stream").isTrue();
    }
}
