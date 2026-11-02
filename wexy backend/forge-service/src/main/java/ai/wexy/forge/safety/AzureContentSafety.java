package ai.wexy.forge.safety;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Content safety by Azure AI Content Safety (W1; the creations platform design §11, I12, Q99): {@code POST
 * {endpoint}/contentsafety/text:analyze?api-version=2024-09-01} with the four categories at four severity levels, the
 * key in {@code Ocp-Apim-Subscription-Key}. Written afresh (FlareLink's moderation classes were a read-only reference).
 *
 * <p>Fails closed. No verdict (no answer within the deadline, a status other than 2xx, an answer without all four
 * categories) is {@code 503 unavailable}: no verdict, no prompt, no call. A category at or past its threshold refuses
 * the text. The text goes to Azure and nowhere else, and no log line holds it, the key or Azure's own words: the
 * categories and severities, and a status. Startup stops without the endpoint, the key or any threshold. Active
 * wherever the local and test profiles are not, so a deployment can never run without it.
 */
@Component
@Profile("!local & !test")
public class AzureContentSafety implements ContentSafety {

    private static final Logger log = LoggerFactory.getLogger(AzureContentSafety.class);
    static final String API_VERSION = "2024-09-01";
    static final String PATH = "/contentsafety/text:analyze";
    static final String KEY_HEADER = "Ocp-Apim-Subscription-Key";
    static final List<String> CATEGORIES = List.of("Hate", "SelfHarm", "Sexual", "Violence");

    private final WebClient client;
    private final String key;
    private final Duration timeout;
    private final Map<String, Integer> refuseAt;

    public AzureContentSafety(ContentSafetyProperties properties, WebClient.Builder builder) {
        String endpoint = properties.endpoint() == null ? "" : properties.endpoint().strip();
        String key = properties.key() == null ? "" : properties.key().strip();
        if (endpoint.isEmpty() || key.isEmpty()) {
            throw new IllegalStateException("Content safety has no Azure resource: set AZURE_CONTENT_SAFETY_ENDPOINT and "
                    + "AZURE_CONTENT_SAFETY_KEY (wexy.content-safety.*). Without a verdict no prompt is granted, so forge "
                    + "refuses to start.");
        }
        URI uri;
        try {
            uri = URI.create(endpoint);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("wexy.content-safety.endpoint is not a URL.");
        }
        boolean loopback = "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost());
        if (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) && loopback)) {
            throw new IllegalStateException("wexy.content-safety.endpoint must be https (the key travels with every check).");
        }
        if (properties.timeout() == null || properties.timeout().isNegative() || properties.timeout().isZero()) {
            throw new IllegalStateException("wexy.content-safety.timeout must be set to a positive duration.");
        }
        Map<String, Integer> thresholds = new LinkedHashMap<>();
        for (String category : CATEGORIES) {
            Integer at = properties.refuseAt().get(category.toLowerCase(Locale.ROOT));
            if (at == null || at < 0 || at > 7) {
                throw new IllegalStateException("wexy.content-safety.refuse-at." + category.toLowerCase(Locale.ROOT)
                        + " must be set, 0 to 7: every category refuses somewhere.");
            }
            thresholds.put(category, at);
        }
        this.client = builder.clone().baseUrl(endpoint.replaceAll("/+$", "")).build();
        this.key = key;
        this.timeout = properties.timeout();
        this.refuseAt = Map.copyOf(thresholds);
        log.info("Content safety: Azure AI Content Safety, api-version {}, refusing at {}, {} deadline.", API_VERSION, refuseAt, timeout);
    }

    @Override
    public Verdict check(String text) {
        Map<String, Object> body = Map.of("text", text, "categories", CATEGORIES, "outputType", "FourSeverityLevels");
        JsonNode answer;
        try {
            answer = client.post()
                    .uri(u -> u.path(PATH).queryParam("api-version", API_VERSION).build())
                    .header(KEY_HEADER, key)
                    .contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.APPLICATION_JSON)
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(JsonNode.class)
                    .timeout(timeout)
                    .block();
        } catch (WebClientResponseException e) {
            throw unavailable("status " + e.getStatusCode().value());
        } catch (RuntimeException e) {
            throw unavailable(e.getClass().getSimpleName());
        }
        Map<String, Integer> severities = new LinkedHashMap<>();
        if (answer != null) {
            for (JsonNode item : answer.path("categoriesAnalysis")) {
                JsonNode severity = item.path("severity");
                if (item.path("category").isTextual() && severity.canConvertToInt()) {
                    severities.put(item.path("category").asText(), severity.asInt());
                }
            }
        }
        if (!severities.keySet().containsAll(CATEGORIES)) {
            throw unavailable("an answer without all four categories");
        }
        boolean allowed = CATEGORIES.stream().allMatch(c -> severities.get(c) < refuseAt.get(c));
        return new Verdict(allowed, severities);
    }

    private static ForgeException unavailable(String why) {
        log.warn("dependency.unavailable dep=azure op=content-safety: {}", why);
        return new ForgeException(ErrorCode.UNAVAILABLE, "Live creation is unavailable right now: ideas cannot be checked.");
    }
}
