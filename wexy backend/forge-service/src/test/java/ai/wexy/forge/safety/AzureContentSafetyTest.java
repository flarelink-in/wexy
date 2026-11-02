package ai.wexy.forge.safety;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PL-T18 (W1; the creations platform design §11, Q99): Azure AI Content Safety's call and its verdict, against a local
 * stand-in for the resource. The request is the documented one (2024-09-01's text:analyze, the key in its header, the
 * four categories at four levels); Sexual refuses at 2 and the others at 4; no verdict of any kind is a refusal to go
 * on (503), and startup stops without the resource or a threshold.
 */
class AzureContentSafetyTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Integer> Q99 = Map.of("hate", 4, "selfharm", 4, "sexual", 2, "violence", 4);

    private HttpServer server;
    private final List<String[]> seen = new CopyOnWriteArrayList<>();
    private final AtomicReference<Answer> answer = new AtomicReference<>(new Answer(200, severities(0, 0, 0, 0), 0));

    private record Answer(int status, String body, long delayMillis) {
    }

    private static String severities(int hate, int selfHarm, int sexual, int violence) {
        return "{\"blocklistsMatch\":[],\"categoriesAnalysis\":[{\"category\":\"Hate\",\"severity\":" + hate + "},"
                + "{\"category\":\"SelfHarm\",\"severity\":" + selfHarm + "},{\"category\":\"Sexual\",\"severity\":" + sexual + "},"
                + "{\"category\":\"Violence\",\"severity\":" + violence + "}]}";
    }

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            seen.add(new String[]{exchange.getRequestMethod(), exchange.getRequestURI().toString(),
                    exchange.getRequestHeaders().getFirst("Ocp-Apim-Subscription-Key"), body});
            Answer a = answer.get();
            try {
                Thread.sleep(a.delayMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            byte[] out = a.body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(a.status(), out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AzureContentSafety safety() {
        return safety(new ContentSafetyProperties("http://127.0.0.1:" + server.getAddress().getPort(), "the-key",
                Duration.ofMillis(800), Q99));
    }

    private static AzureContentSafety safety(ContentSafetyProperties properties) {
        return new AzureContentSafety(properties, WebClient.builder());
    }

    @Test
    void theCheckIsTheDocumentedRequest() throws Exception {
        assertThat(safety().check("a spiral galaxy").allowed()).isTrue();

        String[] request = seen.get(0);
        assertThat(request[0]).isEqualTo("POST");
        assertThat(request[1]).isEqualTo("/contentsafety/text:analyze?api-version=2024-09-01");
        assertThat(request[2]).isEqualTo("the-key");
        JsonNode body = JSON.readTree(request[3]);
        assertThat(body.path("text").asText()).isEqualTo("a spiral galaxy");
        assertThat(body.path("outputType").asText()).isEqualTo("FourSeverityLevels");
        assertThat(body.path("categories").toString()).isEqualTo("[\"Hate\",\"SelfHarm\",\"Sexual\",\"Violence\"]");
    }

    /** Q99 as recommended: Sexual refuses at 2 or more, the others at 4 or more. */
    @Test
    void eachCategoryRefusesAtItsThreshold() {
        AzureContentSafety safety = safety();
        answer.set(new Answer(200, severities(2, 2, 0, 2), 0));
        assertThat(safety.check("a storm at sea").allowed()).as("2 everywhere but Sexual").isTrue();
        answer.set(new Answer(200, severities(0, 0, 2, 0), 0));
        assertThat(safety.check("x").allowed()).as("Sexual at 2").isFalse();
        answer.set(new Answer(200, severities(0, 0, 0, 4), 0));
        ContentSafety.Verdict violent = safety.check("x");
        assertThat(violent.allowed()).as("Violence at 4").isFalse();
        assertThat(violent.shown()).isEqualTo("Hate:0,SelfHarm:0,Sexual:0,Violence:4");
        answer.set(new Answer(200, severities(6, 0, 0, 0), 0));
        assertThat(safety.check("x").allowed()).as("Hate at 6").isFalse();
    }

    /** No verdict, no call: an error status, a slow answer, a partial one or none at all are 503, never an allow. */
    @Test
    void noVerdictIsUnavailable() {
        AzureContentSafety safety = safety();
        for (Answer a : List.of(new Answer(401, "{\"error\":{\"code\":\"Unauthorized\",\"message\":\"no\"}}", 0),
                new Answer(429, "{}", 0), new Answer(500, "{}", 0), new Answer(200, "{\"categoriesAnalysis\":[]}", 0),
                new Answer(200, "{\"categoriesAnalysis\":[{\"category\":\"Hate\",\"severity\":0}]}", 0),
                new Answer(200, "not json", 0), new Answer(200, severities(0, 0, 0, 0), 2_000))) {
            answer.set(a);
            assertThatThrownBy(() -> safety.check("a galaxy")).as(a.status() + " " + a.body())
                    .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.UNAVAILABLE));
        }
        server.stop(0);
        assertThatThrownBy(() -> safety.check("a galaxy")).as("the resource unreachable")
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.UNAVAILABLE));
    }

    /** Startup stops without the endpoint, the key, an https endpoint (off loopback) or any category's threshold. */
    @Test
    void startupStopsWithoutTheResourceOrAThreshold() {
        assertThatThrownBy(() -> safety(new ContentSafetyProperties("", "k", Duration.ofSeconds(3), Q99)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("AZURE_CONTENT_SAFETY_ENDPOINT");
        assertThatThrownBy(() -> safety(new ContentSafetyProperties("https://x.cognitiveservices.azure.com", " ", Duration.ofSeconds(3), Q99)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("AZURE_CONTENT_SAFETY_KEY");
        assertThatThrownBy(() -> safety(new ContentSafetyProperties("http://x.cognitiveservices.azure.com", "k", Duration.ofSeconds(3), Q99)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("https");
        assertThatThrownBy(() -> safety(new ContentSafetyProperties("https://x.cognitiveservices.azure.com", "k", Duration.ofSeconds(3),
                Map.of("hate", 4, "selfharm", 4, "violence", 4))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("refuse-at.sexual");
        assertThat(safety(new ContentSafetyProperties("https://x.cognitiveservices.azure.com/", "k", Duration.ofSeconds(3), Q99))).isNotNull();
    }
}
