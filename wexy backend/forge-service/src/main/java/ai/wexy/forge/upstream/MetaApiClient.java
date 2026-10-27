package ai.wexy.forge.upstream;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.netty.channel.ChannelOption;
import io.netty.handler.timeout.ReadTimeoutException;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.codec.CodecException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.UnsupportedMediaTypeException;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.HttpClient;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The Meta Model API's OpenAI-compatible chat completions (backend architecture §6.3), and nothing
 * more: it neither charges nor records. Every call to a model goes through {@link MeteredModelClient},
 * which does both; this class is its transport.
 *
 * Streams are read as server-sent events: {@code data:} lines of chunk JSON, ended by
 * {@code [DONE]}. Usage is asked for with {@code stream_options.include_usage}. Whether Meta's API
 * honours that, and how it names its models, is what the probe checks in hour one; nothing here
 * assumes it beyond the OpenAI shape.
 *
 * Cancelling a returned stream cancels the HTTP request, so a client that disconnects stops the
 * model writing (and billing) for nobody.
 */
@Component
public class MetaApiClient {

    private static final ParameterizedTypeReference<ServerSentEvent<String>> EVENTS =
            new ParameterizedTypeReference<>() {
            };

    private static final String DONE = "[DONE]";
    private static final int EXCERPT_CHARS = 500;

    private final MetaApiProperties properties;
    private final ObjectMapper json;
    private final WebClient client;

    public MetaApiClient(MetaApiProperties properties, ObjectMapper json, WebClient.Builder builder) {
        this.properties = properties;
        this.json = json;
        HttpClient http = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, (int) properties.connectTimeout().toMillis())
                // Silence between reads, not a deadline: the role's deadline is MeteredModelClient's.
                .responseTimeout(properties.readIdleTimeout());
        this.client = builder.clone()
                .baseUrl(properties.baseUrl())
                .clientConnector(new ReactorClientHttpConnector(http))
                .build();
    }

    public boolean hasKey() {
        return properties.hasKey();
    }

    public String baseUrl() {
        return properties.baseUrl();
    }

    /** The model ids the key can see ({@code GET /models}). */
    public Mono<List<String>> listModels() {
        return client.get().uri("/models")
                .headers(this::authorize)
                .accept(MediaType.APPLICATION_JSON)
                .exchangeToMono(response -> response.statusCode().is2xxSuccessful()
                        ? response.bodyToMono(String.class).defaultIfEmpty("{}").map(this::modelIds)
                        : response.bodyToMono(String.class).defaultIfEmpty("")
                                .flatMap(body -> Mono.error(failure(response.statusCode().value(), body))))
                .onErrorMap(this::transportFailure);
    }

    /** One streamed chat completion, as chunks. */
    public Flux<ChatChunk> streamChat(ChatRequest request) {
        String body = requestBody(request);
        return client.post().uri("/chat/completions")
                .headers(this::authorize)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .bodyValue(body)
                .exchangeToFlux(response -> {
                    int status = response.statusCode().value();
                    if (!response.statusCode().is2xxSuccessful()) {
                        return response.bodyToMono(String.class).defaultIfEmpty("")
                                .flatMapMany(text -> Flux.error(failure(status, text)));
                    }
                    // A JSON answer to a streamed request decodes to an empty stream, silently: refuse it.
                    MediaType type = response.headers().contentType().orElse(null);
                    if (type == null || !MediaType.TEXT_EVENT_STREAM.isCompatibleWith(type)) {
                        return response.bodyToMono(String.class).defaultIfEmpty("")
                                .flatMapMany(text -> Flux.error(new UpstreamException(UpstreamException.Kind.MALFORMED,
                                        status, excerpt("expected text/event-stream, got " + type + ": " + text))));
                    }
                    // A stream that ends with neither [DONE] nor a finish reason was cut, not finished.
                    AtomicBoolean finished = new AtomicBoolean();
                    return response.bodyToFlux(EVENTS)
                            .mapNotNull(ServerSentEvent::data)
                            .map(String::trim)
                            .filter(data -> !data.isEmpty())
                            .takeUntil(DONE::equals)
                            .filter(data -> {
                                if (DONE.equals(data)) {
                                    finished.set(true);
                                    return false;
                                }
                                return true;
                            })
                            .map(this::chunk)
                            .doOnNext(chunk -> {
                                if (chunk.finishReason() != null) {
                                    finished.set(true);
                                }
                            })
                            .concatWith(Mono.defer(() -> finished.get() ? Mono.empty()
                                    : Mono.error(new UpstreamException(UpstreamException.Kind.MALFORMED, status,
                                            "the stream ended before the model finished"))));
                })
                .onErrorMap(this::transportFailure);
    }

    String requestBody(ChatRequest request) {
        ObjectNode body = json.createObjectNode();
        body.put("model", request.model());
        ArrayNode messages = body.putArray("messages");
        for (ChatMessage message : request.messages()) {
            messages.addObject().put("role", message.role()).put("content", message.content());
        }
        // max_tokens is Meta's deprecated alias (forge-loop design §4.1).
        body.put("max_completion_tokens", request.maxOutputTokens());
        if (request.reasoningEffort() != null) {
            body.put("reasoning_effort", request.reasoningEffort());
        }
        if (request.safetyIdentifier() != null) {
            body.put("safety_identifier", request.safetyIdentifier());
        }
        body.put("stream", true);
        body.putObject("stream_options").put("include_usage", true);
        if (request.responseFormat() != null) {
            body.set("response_format", json.valueToTree(request.responseFormat()));
        }
        return body.toString();
    }

    private void authorize(HttpHeaders headers) {
        headers.setBearerAuth(properties.apiKey());
    }

    private List<String> modelIds(String body) {
        JsonNode root = readTree(body);
        List<String> ids = new ArrayList<>();
        for (JsonNode model : root.path("data")) {
            if (model.path("id").isTextual()) {
                ids.add(model.path("id").textValue());
            }
        }
        return ids;
    }

    ChatChunk chunk(String data) {
        JsonNode node = readTree(data);
        if (node.has("error")) {
            throw new UpstreamException(UpstreamException.Kind.SERVER, 0, excerpt(node.path("error").toString()));
        }
        // Meta's own shape for a failure inside a stream: {"type": "error", "code", "message"}.
        if ("error".equals(node.path("type").asText())) {
            throw new UpstreamException(UpstreamException.Kind.SERVER, 0,
                    excerpt(node.path("code").asText("error") + ": " + node.path("message").asText("")));
        }
        JsonNode choice = node.path("choices").path(0);
        JsonNode content = choice.path("delta").path("content");
        JsonNode finish = choice.path("finish_reason");
        return new ChatChunk(
                content.isTextual() ? content.textValue() : "",
                finish.isTextual() ? finish.textValue() : null,
                usage(node.path("usage")));
    }

    private static ChatChunk.Usage usage(JsonNode usage) {
        if (!usage.isObject()) {
            return null;
        }
        JsonNode reasoning = usage.path("completion_tokens_details").path("reasoning_tokens");
        JsonNode cached = usage.path("prompt_tokens_details").path("cached_tokens");
        return new ChatChunk.Usage(
                usage.path("prompt_tokens").asLong(),
                usage.path("completion_tokens").asLong(),
                usage.path("total_tokens").asLong(),
                reasoning.isNumber() ? reasoning.asLong() : null,
                cached.isNumber() ? cached.asLong() : null);
    }

    private JsonNode readTree(String text) {
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new UpstreamException(UpstreamException.Kind.MALFORMED, 0, excerpt(text));
        }
    }

    private UpstreamException failure(int status, String body) {
        return new UpstreamException(UpstreamException.kindOf(status), status, excerpt(body));
    }

    private Throwable transportFailure(Throwable error) {
        if (error instanceof UpstreamException) {
            return error;
        }
        for (Throwable cause = error; cause != null && cause.getCause() != cause; cause = cause.getCause()) {
            if (cause instanceof ReadTimeoutException) {
                return new UpstreamException(UpstreamException.Kind.TIMEOUT, 0,
                        "no data within " + properties.readIdleTimeout());
            }
        }
        if (error instanceof WebClientRequestException) {
            return new UpstreamException(UpstreamException.Kind.NETWORK, 0, excerpt(error.getMessage()));
        }
        if (error instanceof UnsupportedMediaTypeException || error instanceof CodecException) {
            return new UpstreamException(UpstreamException.Kind.MALFORMED, 0, excerpt(error.getMessage()));
        }
        return error;
    }

    /**
     * The start of an upstream body, for logs and the probe, with the key removed: some providers
     * echo part of a refused key, and this text is written to files.
     */
    String excerpt(String text) {
        if (text == null) {
            return "";
        }
        String clean = properties.hasKey() ? text.replace(properties.apiKey(), "<key>") : text;
        return clean.length() > EXCERPT_CHARS ? clean.substring(0, EXCERPT_CHARS) + "..." : clean;
    }
}
