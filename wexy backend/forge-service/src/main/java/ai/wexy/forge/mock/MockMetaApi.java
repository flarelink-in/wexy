package ai.wexy.forge.mock;

import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.templates.HostContract;
import ai.wexy.forge.templates.PromptTemplates;
import ai.wexy.forge.upstream.MetaApiProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.core.io.support.ResourcePatternResolver;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plays the Meta Model API on the loopback, under the {@code mock} profile only (forge-loop design
 * §8): {@code GET /v1/models} lists the configured models, and {@code POST /v1/chat/completions}
 * streams a recording as OpenAI-shaped chunks, with the usage on the final chunk and {@code [DONE]},
 * as the tests' {@code FakeMetaApi} does. Nothing else in the service changes: the roles, prices and
 * caps are the real ones, and every mock call is charged to Redis first (Q23), so a cap denial can
 * be rehearsed here with no key and no spend.
 *
 * <p><b>Which recording.</b> A request is matched to a template by its system message, byte for
 * byte: every call of a template sends the same system bytes (P9), and {@link PromptTemplates}
 * holds them, so the prompt needs no id line for the mock to route on. The planner gets
 * {@code mock/plans/<world>.json}, the world chosen by a word of its name in the idea, else the
 * first; an author gets the h1 exemplar of its function for the world the plan names; a repair gets
 * the exemplar whose fault it was sent; the director gets {@code mock/edits/director.json}. A system
 * message that matches no template is refused with 400: the mock answers Wexy's own prompts and
 * nothing else.
 *
 * <p><b>Scenarios</b> ({@code wexy.mock.scenario}, or {@code WEXY_MOCK_SCENARIO}): {@code ok};
 * {@code fault} serves {@code mock/faults/<world>.evolve.wgsl}, an evolve with one real WGSL
 * mistake, so the repair path runs end to end; {@code slow} goes quiet for
 * {@code wexy.mock.slow-millis} after the first chunk, for the heartbeat and the deadline;
 * {@code error-mid-stream} sends Meta's {@code {"type": "error", …}} event after the first chunk.
 *
 * <p>It honours {@code max_completion_tokens} (a recording longer than the cap is cut, with
 * {@code finish_reason: length}), refuses {@code reasoning_effort: none} and an unknown model as
 * Meta does, and reports {@code cached_tokens} for a system message it has streamed before, so a
 * day of mock runs reads like a live one. Four characters count as a token.
 *
 * <p>It refuses to start unless {@code wexy.meta-api.base-url} is {@code 127.0.0.1} on its own port:
 * a mock that answers a deployment is the one mistake it must make impossible. It logs which
 * recording it served, never a prompt (coding principles §11).
 */
@Component
@Profile("mock")
public class MockMetaApi {

    public static final Set<String> SCENARIOS = Set.of("ok", "fault", "slow", "error-mid-stream");

    private static final Logger log = LoggerFactory.getLogger(MockMetaApi.class);
    private static final int CHARS_PER_TOKEN = 4;
    private static final String PLANS = "classpath:mock/plans/*.json";
    private static final String FAULTS = "classpath:mock/faults/*.wgsl";
    private static final String EDIT = "classpath:mock/edits/director.json";
    /** The agent turn (agent-loop design §15, EA2.4): a read on its first call, then a program that passes the check. */
    private static final String AGENT_READ = "classpath:mock/agent/need-context.json";
    private static final String AGENT_PROGRAM = "classpath:mock/agent/program.json";
    private static final Pattern TITLE_LINE = Pattern.compile("^Title: (.+)$", Pattern.MULTILINE);
    private static final Pattern REPAIR_FN = Pattern.compile("^The function: (evolve|look|sky) ", Pattern.MULTILINE);

    private final MockProperties properties;
    private final ModelCatalog catalog;
    private final HostContract host;
    private final ObjectMapper json;
    /** The system message of each loaded template, to its name: how a request is routed. */
    private final Map<String, String> templatesBySystem = new LinkedHashMap<>();
    private final Map<String, Plan> plans = new LinkedHashMap<>();
    private final Map<String, String> faults = new LinkedHashMap<>();
    private final String edit;
    private final String agentRead;
    private final String agentProgram;
    private final Set<String> streamedSystems = ConcurrentHashMap.newKeySet();
    private final ExecutorService threads = Executors.newCachedThreadPool();
    private final HttpServer server;
    private volatile String scenario;

    /** One recorded plan: the world's file stem, its title, and its text as the mock streams it. */
    record Plan(String world, String title, String text) {
    }

    /** What a request gets: the recording's name, for the log, and its text. */
    record Recording(String name, String text) {
    }

    @Autowired
    public MockMetaApi(MockProperties properties, MetaApiProperties metaApi, ModelCatalog catalog,
                       PromptTemplates templates, HostContract host, ObjectMapper json) {
        this(properties, metaApi, catalog, templates, host, json, new PathMatchingResourcePatternResolver());
    }

    MockMetaApi(MockProperties properties, MetaApiProperties metaApi, ModelCatalog catalog, PromptTemplates templates,
                HostContract host, ObjectMapper json, ResourcePatternResolver resources) {
        this.properties = properties;
        this.catalog = catalog;
        this.host = host;
        this.json = json;
        this.scenario = checkedScenario(properties.scenario());

        URI base = URI.create(metaApi.baseUrl());
        if (!"127.0.0.1".equals(base.getHost()) || base.getPort() != properties.port() || !"/v1".equals(base.getPath())) {
            throw new IllegalStateException("The mock profile answers on the loopback only: wexy.meta-api.base-url must be "
                    + "http://127.0.0.1:" + properties.port() + "/v1, not " + metaApi.baseUrl()
                    + ". A mock must never answer a deployment.");
        }
        for (PromptTemplates.Template template : templates.all()) {
            templatesBySystem.put(template.system(), template.name());
        }
        for (Resource file : list(resources, PLANS)) {
            String text = read(file);
            plans.put(stem(file), new Plan(stem(file), title(text, file), text));
        }
        if (plans.isEmpty()) {
            throw new IllegalStateException("No recorded plans under mock/plans/: the mock has nothing to answer a planner with.");
        }
        for (Resource file : list(resources, FAULTS)) {
            faults.put(stem(file), read(file));
        }
        this.edit = read(resources.getResource(EDIT));
        this.agentRead = read(resources.getResource(AGENT_READ)).strip();
        this.agentProgram = read(resources.getResource(AGENT_PROGRAM)).strip();
        this.server = start(properties.port());
        log.warn("MOCK META API on 127.0.0.1:{} (scenario {}, {} tokens/s, {} plans): no model is called and nothing is spent, "
                + "but every call is metered in Redis as a live one would be.", port(), scenario, properties.tokensPerSecond(), plans.size());
    }

    private HttpServer start(int port) {
        try {
            HttpServer created = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            created.setExecutor(threads);
            created.createContext("/v1/", this::handle);
            created.start();
            return created;
        } catch (BindException e) {
            throw new IllegalStateException("Port " + port + " on 127.0.0.1 is taken: another forge-service under the mock "
                    + "profile is running, or set wexy.mock.port and wexy.meta-api.base-url together.", e);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @PreDestroy
    public void stop() {
        server.stop(0);
        threads.shutdownNow();
    }

    public int port() {
        return server.getAddress().getPort();
    }

    public String scenario() {
        return scenario;
    }

    /** Switches the scenario while running, for tests and tools; the configured one applies at startup. */
    public void scenario(String scenario) {
        this.scenario = checkedScenario(scenario);
    }

    private static String checkedScenario(String scenario) {
        if (!SCENARIOS.contains(scenario)) {
            throw new IllegalArgumentException("wexy.mock.scenario is '" + scenario + "'; it must be one of " + new TreeSet<>(SCENARIOS) + ".");
        }
        return scenario;
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if ("GET".equals(method) && "/v1/models".equals(path)) {
                models(exchange);
            } else if ("POST".equals(method) && "/v1/chat/completions".equals(path)) {
                chat(exchange, body);
            } else {
                error(exchange, 404, "not_found", "The mock serves GET /v1/models and POST /v1/chat/completions.");
            }
        } catch (IOException e) {
            // The client closed the connection mid-answer: the service cancelled the call (I7).
        } finally {
            exchange.close();
        }
    }

    private void models(HttpExchange exchange) throws IOException {
        ObjectNode list = json.createObjectNode().put("object", "list");
        for (String id : modelIds()) {
            list.withArray("data").addObject().put("id", id).put("object", "model");
        }
        answer(exchange, 200, list.toString());
    }

    private void chat(HttpExchange exchange, String body) throws IOException {
        JsonNode request;
        try {
            request = json.readTree(body);
        } catch (IOException e) {
            error(exchange, 400, "invalid_request_error", "The request body is not JSON.");
            return;
        }
        String model = request.path("model").asText("");
        if (!modelIds().contains(model)) {
            error(exchange, 404, "model_not_found", "The model '" + model + "' is not one of the configured models " + modelIds() + ".");
            return;
        }
        if ("none".equals(request.path("reasoning_effort").asText())) {
            error(exchange, 400, "invalid_request_error", "reasoning_effort 'none' is refused: reasoning is always on (forge-loop design §4.1).");
            return;
        }
        JsonNode messages = request.path("messages");
        String system = messages.path(0).path("content").asText("");
        String user = messages.path(1).path("content").asText("");
        String template = templatesBySystem.get(system);
        if (template == null) {
            error(exchange, 400, "invalid_request_error", "The mock answers only Wexy's own templates, and this system message "
                    + "matches none of " + new TreeSet<>(templatesBySystem.values()) + ".");
            return;
        }
        // An agent turn sends its first call with two messages and every later one with more (agent-loop design §2).
        Recording recording = template.equals("agent")
                ? messages.size() <= 2 ? new Recording("agent/need-context", agentRead) : new Recording("agent/program", agentProgram)
                : pick(template, user);
        int cap = request.path("max_completion_tokens").asInt(0);
        long cachedTokens = streamedSystems.add(system) ? 0 : tokens(system);
        stream(exchange, model, template, recording, cap > 0 ? cap : Integer.MAX_VALUE, tokens(system) + tokens(user), cachedTokens);
    }

    private Recording pick(String template, String user) {
        if (template.equals("planner")) {
            Plan plan = planFor(user);
            return new Recording("plans/" + plan.world(), plan.text());
        }
        if (template.startsWith("author.")) {
            String fn = template.substring("author.".length());
            String world = worldNamed(user);
            String fault = faults.get(world + "." + fn);
            if ("fault".equals(scenario) && fault != null) {
                return new Recording("faults/" + world + "." + fn, fault);
            }
            return new Recording("exemplars/" + world + "." + fn, exemplar(world, fn));
        }
        if (template.equals("repair")) {
            Matcher named = REPAIR_FN.matcher(user);
            String fn = named.find() ? named.group(1) : "evolve";
            // The function it was sent is one of the faults: answer with that world's exemplar, the fix.
            String world = faults.entrySet().stream()
                    .filter(entry -> user.contains(entry.getValue()))
                    .map(entry -> entry.getKey().substring(0, entry.getKey().indexOf('.')))
                    .findFirst()
                    .orElse(plans.keySet().iterator().next());
            return new Recording("exemplars/" + world + "." + fn, exemplar(world, fn));
        }
        if (template.equals("director")) {
            return new Recording("edits/director", edit);
        }
        throw new IllegalStateException("No recording for the template " + template + ".");
    }

    /** The plan whose world's name, or a word of its title, is in the idea; else the first. */
    private Plan planFor(String user) {
        String idea = user.toLowerCase(Locale.ROOT);
        for (Plan plan : plans.values()) {
            if (idea.contains(plan.world())) {
                return plan;
            }
            for (String word : plan.title().toLowerCase(Locale.ROOT).split("[^a-z]+")) {
                if (word.length() >= 4 && idea.contains(word)) {
                    return plan;
                }
            }
        }
        return plans.values().iterator().next();
    }

    /** The world whose plan the author's message names on its {@code Title:} line; else the first. */
    private String worldNamed(String user) {
        Matcher title = TITLE_LINE.matcher(user);
        if (title.find()) {
            String named = title.group(1).strip();
            for (Plan plan : plans.values()) {
                if (plan.title().equalsIgnoreCase(named)) {
                    return plan.world();
                }
            }
        }
        return plans.keySet().iterator().next();
    }

    private String exemplar(String world, String fn) {
        return host.exemplars(fn).stream()
                .filter(exemplar -> exemplar.world().equals(world))
                .map(HostContract.Exemplar::code)
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("No exemplar " + world + "." + fn + " under host/h1/exemplars/."));
    }

    private void stream(HttpExchange exchange, String model, String template, Recording recording, int cap,
                        long promptTokens, long cachedTokens) throws IOException {
        List<String> pieces = pieces(recording.text());
        boolean truncated = pieces.size() > cap;
        List<String> sent = truncated ? pieces.subList(0, cap) : pieces;
        long pauseNanos = properties.tokensPerSecond() <= 0 ? 0 : 1_000_000_000L / properties.tokensPerSecond();
        String scenario = this.scenario;
        String id = "mock-" + Long.toHexString(System.nanoTime());
        log.info("mock {} answered with {}: {} tokens{}, scenario {}", template, recording.name(), sent.size(),
                truncated ? " of " + pieces.size() + ", cut at the cap" : "", scenario);

        exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            write(out, chunk(id, model, json.createObjectNode().put("role", "assistant").put("content", ""), null));
            int n = 0;
            for (String piece : sent) {
                write(out, chunk(id, model, json.createObjectNode().put("content", piece), null));
                n++;
                if (n == 1) {
                    if ("slow".equals(scenario)) {
                        pause(properties.slowMillis() * 1_000_000L);
                    }
                    if ("error-mid-stream".equals(scenario)) {
                        write(out, json.createObjectNode().put("type", "error").put("code", "server_error")
                                .put("message", "The mock failed on purpose (scenario error-mid-stream).").toString());
                        return;
                    }
                }
                pause(pauseNanos);
            }
            write(out, chunk(id, model, json.createObjectNode(), truncated ? "length" : "stop"));
            write(out, usage(id, model, promptTokens, n, cachedTokens));
            write(out, "[DONE]");
        }
    }

    private String chunk(String id, String model, ObjectNode delta, String finishReason) {
        ObjectNode chunk = json.createObjectNode().put("id", id).put("object", "chat.completion.chunk").put("model", model);
        ObjectNode choice = chunk.putArray("choices").addObject().put("index", 0);
        choice.set("delta", delta);
        if (finishReason == null) {
            choice.putNull("finish_reason");
        } else {
            choice.put("finish_reason", finishReason);
        }
        return chunk.toString();
    }

    private String usage(String id, String model, long promptTokens, long completionTokens, long cachedTokens) {
        ObjectNode chunk = json.createObjectNode().put("id", id).put("object", "chat.completion.chunk").put("model", model);
        chunk.putArray("choices");
        ObjectNode usage = chunk.putObject("usage")
                .put("prompt_tokens", promptTokens)
                .put("completion_tokens", completionTokens)
                .put("total_tokens", promptTokens + completionTokens);
        usage.putObject("completion_tokens_details").put("reasoning_tokens", 0);
        usage.putObject("prompt_tokens_details").put("cached_tokens", cachedTokens);
        return chunk.toString();
    }

    private static void write(OutputStream out, String data) throws IOException {
        out.write(("data: " + data + "\n\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        ObjectNode body = json.createObjectNode();
        body.putObject("error").put("message", message).put("type", "invalid_request_error").putNull("param").put("code", code);
        answer(exchange, status, body.toString());
    }

    private static void answer(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private Set<String> modelIds() {
        Set<String> ids = new TreeSet<>();
        for (String role : catalog.roleNames()) {
            ids.add(catalog.role(role).model());
        }
        return ids;
    }

    /** The text in token-sized pieces: four characters, never splitting a surrogate pair. */
    static List<String> pieces(String text) {
        List<String> pieces = new ArrayList<>();
        int i = 0;
        while (i < text.length()) {
            int end = i;
            for (int n = 0; n < CHARS_PER_TOKEN && end < text.length(); n++) {
                end += Character.charCount(text.codePointAt(end));
            }
            pieces.add(text.substring(i, end));
            i = end;
        }
        return pieces;
    }

    static long tokens(String text) {
        return (text.length() + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN;
    }

    private static void pause(long nanos) {
        if (nanos <= 0) {
            return;
        }
        try {
            Thread.sleep(nanos / 1_000_000, (int) (nanos % 1_000_000));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static List<Resource> list(ResourcePatternResolver resources, String pattern) {
        try {
            List<Resource> found = new ArrayList<>(Arrays.asList(resources.getResources(pattern)));
            found.sort(Comparator.comparing(Resource::getFilename));
            return found;
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot list " + pattern, e);
        }
    }

    /** A recording's text with LF line ends and no trailing blank lines: the same bytes on every OS. */
    private static String read(Resource resource) {
        try {
            return resource.getContentAsString(StandardCharsets.UTF_8).replace("\r\n", "\n").stripTrailing();
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + resource.getDescription(), e);
        }
    }

    /** {@code galaxy.json} is the world {@code galaxy}; {@code galaxy.evolve.wgsl} is the fault {@code galaxy.evolve}. */
    private static String stem(Resource resource) {
        String name = String.valueOf(resource.getFilename());
        return name.substring(0, name.lastIndexOf('.'));
    }

    private String title(String planText, Resource file) {
        try {
            return json.readTree(planText).path("title").asText("");
        } catch (IOException e) {
            throw new IllegalStateException("The recorded plan " + file.getDescription() + " is not JSON.", e);
        }
    }
}
