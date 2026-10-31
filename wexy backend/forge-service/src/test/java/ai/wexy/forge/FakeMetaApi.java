package ai.wexy.forge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Plays the Meta Model API on a local port: {@code GET /v1/models} and a streamed
 * {@code POST /v1/chat/completions}, answering the way OpenAI-compatible APIs document. Records
 * every request, so tests can assert on what was sent, and on whether anything was sent at all.
 */
public final class FakeMetaApi implements AutoCloseable {

    public record Request(String method, String path, Map<String, List<String>> headers, String body) {

        public String header(String name) {
            return headers.entrySet().stream()
                    .filter(entry -> entry.getKey().equalsIgnoreCase(name))
                    .flatMap(entry -> entry.getValue().stream())
                    .findFirst().orElse(null);
        }
    }

    /** Answers one request. */
    @FunctionalInterface
    public interface Responder {
        void respond(HttpExchange exchange, Request request) throws IOException;
    }

    public static final String OK_STREAM_CHUNKS = """
            {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
            {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"o"},"finish_reason":null}]}
            {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"k"},"finish_reason":null}]}
            {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
            {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":2,"total_tokens":23,"completion_tokens_details":{"reasoning_tokens":0}}}
            [DONE]""";

    private final List<Request> requests = new CopyOnWriteArrayList<>();
    private final AtomicBoolean clientWentAway = new AtomicBoolean();
    private final HttpServer server;
    private final ExecutorService threads = Executors.newCachedThreadPool();

    public volatile Responder models = json(200, "{\"object\":\"list\",\"data\":[{\"id\":\"m-1\"}]}");
    public volatile Responder chat = sse(0, OK_STREAM_CHUNKS.split("\n"));

    public FakeMetaApi() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.setExecutor(threads);
        server.createContext("/v1/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Request request = new Request(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
                    Map.copyOf(exchange.getRequestHeaders()), body);
            requests.add(request);
            try {
                if (request.path().endsWith("/models")) {
                    models.respond(exchange, request);
                } else if (request.path().endsWith("/chat/completions")) {
                    chat.respond(exchange, request);
                } else {
                    json(404, "{}").respond(exchange, request);
                }
            } catch (IOException e) {
                // The client closed the connection mid-answer.
                clientWentAway.set(true);
            } finally {
                exchange.close();
            }
        });
        server.start();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
    }

    public List<Request> requests() {
        return requests;
    }

    public long chatRequests() {
        return requests.stream().filter(r -> r.path().endsWith("/chat/completions")).count();
    }

    public boolean clientWentAway() {
        return clientWentAway.get();
    }

    public static Responder json(int status, String body) {
        return (exchange, request) -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        };
    }

    /** A server-sent event stream: one {@code data:} line per element, flushed, {@code delayMillis} apart. */
    public static Responder sse(long delayMillis, String... data) {
        return (exchange, request) -> {
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            OutputStream out = exchange.getResponseBody();
            for (String line : data) {
                out.write(("data: " + line + "\n\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
                pause(delayMillis);
            }
            out.close();
        };
    }

    /** Sends the first event, then goes quiet for {@code silenceMillis}. */
    public static Responder sseThenSilence(String first, long silenceMillis) {
        return (exchange, request) -> {
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            OutputStream out = exchange.getResponseBody();
            out.write(("data: " + first + "\n\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            pause(silenceMillis);
            out.close();
        };
    }

    public static String textChunk(String text) {
        return "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"" + text + "\"},\"finish_reason\":null}]}";
    }

    private static void pause(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        server.stop(0);
        threads.shutdownNow();
    }
}
