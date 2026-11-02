package ai.wexy.forge.loop;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.error.ErrorEnvelopeHandler;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.allowance.AllowanceHandler;
import ai.wexy.forge.allowance.TestAdmissions;
import ai.wexy.forge.identity.InternalTokenFilter;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.InMemoryGenerationStore;
import ai.wexy.forge.records.InMemoryOutcomeStore;
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
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.reactive.function.server.MockServerRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.test.web.reactive.server.FluxExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

/**
 * The loop's routes over a real Netty server, through the identity filter and the error envelope,
 * against a fake Meta API and the in-memory meter (forge-loop design §12): the fixture that
 * {@code LoopRoutesTest}, {@code RepairDirectOutcomesTest} and {@code LoopLifecycleTest} share.
 * Every role is configured: Spark-priced {@code m-1} for all but the escalator, which runs on
 * {@code m-2}, Wonder-priced, charged to {@code meta-wonder}.
 */
final class LoopTestServer implements AutoCloseable {

    static final ObjectMapper JSON = new ObjectMapper();
    static final ParameterizedTypeReference<ServerSentEvent<String>> EVENTS = new ParameterizedTypeReference<>() {
    };
    static final String GALAXY = resource("mock/plans/galaxy.json");
    static final String EDIT = resource("mock/edits/director.json");
    static final String FUNCTION = "fn evolve(p: Particle, i: u32) -> Particle {\n    return p;\n}";
    static final String STOP = "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";
    static final String LENGTH = "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}";
    static final String USAGE = usage(2400, 900);

    private static final RSAKey GATEWAY = key();

    final FakeMetaApi fake = new FakeMetaApi();
    final InMemorySpendLedger ledger = new InMemorySpendLedger();
    /**
     * The admission every entry request passes (W1): wide by default, so a test about something else is never decided by
     * the allowances; a test about them sets a strict one, then {@link #restart}s.
     */
    TestAdmissions.Admit admit = TestAdmissions.open();
    InMemoryGenerationStore store;
    InMemoryOutcomeStore outcomes;
    ModelCatalog catalog;
    SimpleMeterRegistry meters;
    LoopHandler handler;
    WebTestClient client;
    /** A plain client, for a request that must be cancelled before any answer arrives. */
    WebClient raw;
    private DisposableServer server;

    LoopTestServer() {
        this(1_000_000L, 0);
    }

    /**
     * @param providerDailyCapMicroUsd Spark's daily ceiling; 10 denies every call
     * @param meterDelayMillis         how long the meter takes to answer; 0 answers at once
     */
    LoopTestServer(long providerDailyCapMicroUsd, long meterDelayMillis) {
        start(providerDailyCapMicroUsd, meterDelayMillis, false);
    }

    void restart(long providerDailyCapMicroUsd, long meterDelayMillis) {
        restart(providerDailyCapMicroUsd, meterDelayMillis, false);
    }

    /** @param meterThrows whether the meter, after its delay, fails with its own exception instead of answering */
    void restart(long providerDailyCapMicroUsd, long meterDelayMillis, boolean meterThrows) {
        server.disposeNow();
        start(providerDailyCapMicroUsd, meterDelayMillis, meterThrows);
    }

    private void start(long providerDailyCapMicroUsd, long meterDelayMillis, boolean meterThrows) {
        // Built before stubbing: a mock made inside another mock's when() is unfinished stubbing (gotchas).
        StringRedisTemplate template = ledger.template(meterDelayMillis);
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        meters = new SimpleMeterRegistry();
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(1_000_000L, 1_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(1_000_000L, providerDailyCapMicroUsd),
                        "meta-wonder", new SpendProperties.Cap(1_000_000L, 1_000_000L)), SpendLanes.open()), meters);
        if (meterThrows) {
            guard = spy(guard);
            doAnswer(invocation -> {
                Thread.sleep(meterDelayMillis);
                throw new IllegalStateException("the meter's own bug");
            }).when(guard).reserve(anyString(), anyString(), anyLong(), anyString());
        }
        catalog = new ModelCatalog(new ModelProperties(Map.of(
                "planner", new ModelProperties.Role("m-1", "meta-spark", 2500, Duration.ofSeconds(10), "low", "scene-draft.v1"),
                "author", new ModelProperties.Role("m-1", "meta-spark", 3000, Duration.ofSeconds(10), "medium", null),
                "repairer", new ModelProperties.Role("m-1", "meta-spark", 3000, Duration.ofSeconds(10), "low", null),
                "escalator", new ModelProperties.Role("m-2", "meta-wonder", 4000, Duration.ofSeconds(10), "high", null),
                "director", new ModelProperties.Role("m-1", "meta-spark", 1500, Duration.ofSeconds(10), "low", "edit-plan.v1")),
                Map.of("m-1", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")),
                        "m-2", new ModelProperties.Price(new BigDecimal("4.00"), new BigDecimal("20.00")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), "test-key", Duration.ofSeconds(2),
                Duration.ofSeconds(5)), new ObjectMapper(), WebClient.builder());
        PromptBuilder prompts = new PromptBuilder(new PromptTemplates(Set.of("planner", "author", "repairer", "escalator", "director"),
                "classpath:prompts/", new HostContract(), new PathMatchingResourcePatternResolver()));
        store = new InMemoryGenerationStore(100, Duration.ofHours(2), Clock.systemUTC());
        outcomes = new InMemoryOutcomeStore(100, Duration.ofHours(2), Clock.systemUTC());
        handler = new LoopHandler(prompts, new MeteredModelClient(api, catalog, guard), store, outcomes, new JsonSchemas(),
                catalog, new LoopProperties(null, Duration.ofMillis(50), null, false), meters, admit.admission());
        HttpHandler http = RouterFunctions.toHttpHandler(new LoopRouter().loopRoutes(handler)
                .and(new AllowanceHandler.Routes().allowanceRoutes(new AllowanceHandler(admit.grants()))), HandlerStrategies.builder()
                .webFilter(new InternalTokenFilter(new ImmutableJWKSet<>(new JWKSet(GATEWAY.toPublicJWK()))))
                .exceptionHandler(new ErrorEnvelopeHandler())
                .build());
        server = HttpServer.create().host("127.0.0.1").port(0).handle(new ReactorHttpHandlerAdapter(http)).bindNow();
        String baseUrl = "http://127.0.0.1:" + server.port();
        client = WebTestClient.bindToServer().baseUrl(baseUrl).responseTimeout(Duration.ofSeconds(20)).build();
        raw = WebClient.builder().baseUrl(baseUrl).build();
    }

    @Override
    public void close() {
        server.disposeNow();
        fake.close();
    }

    private static RSAKey key() {
        try {
            return new RSAKeyGenerator(2048).keyID("gateway").generate();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String resource(String path) {
        try {
            return new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String token(String uid) {
        return token(uid, true, false, TestAdmissions.NETWORK);
    }

    /** The gateway's token for `uid`: anonymous or signed in with Google, on the admin list or not, from network `ipk` (none when null). */
    static String token(String uid, boolean anonymous, boolean admin, String ipk) {
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder().issuer(InternalToken.ISSUER).subject(uid)
                    .issueTime(new Date(now)).expirationTime(new Date(now + 60_000))
                    .claim(InternalToken.CLAIM_ANONYMOUS, anonymous).claim(InternalToken.CLAIM_ADMIN, admin)
                    .claim(InternalToken.CLAIM_PROVIDER, anonymous ? "anonymous" : "google.com");
            if (ipk != null) {
                builder.claim(InternalToken.CLAIM_IPK, ipk);
            }
            JWTClaimsSet claims = builder.build();
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(GATEWAY.getKeyID())
                    .type(JOSEObjectType.JWT).build(), claims);
            jwt.sign(new RSASSASigner(GATEWAY));
            return jwt.serialize();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** The usage chunk as Meta sends it, with reasoning and cached counts. */
    static String usage(long promptTokens, long completionTokens) {
        return "{\"choices\":[],\"usage\":{\"prompt_tokens\":" + promptTokens + ",\"completion_tokens\":" + completionTokens
                + ",\"total_tokens\":" + (promptTokens + completionTokens)
                + ",\"completion_tokens_details\":{\"reasoning_tokens\":300},\"prompt_tokens_details\":{\"cached_tokens\":2000}}}";
    }

    /** One text chunk, as OpenAI-compatible APIs stream it. */
    static String chunk(String text) {
        ObjectNode node = JSON.createObjectNode();
        ObjectNode choice = node.putArray("choices").addObject();
        choice.put("index", 0).putObject("delta").put("content", text);
        choice.putNull("finish_reason");
        return node.toString();
    }

    /** The text in a few chunks, then the finish, the usage and [DONE]. */
    static String[] streamOf(String text, int pieces, String finish) {
        return streamOf(text, pieces, finish, USAGE);
    }

    static String[] streamOf(String text, int pieces, String finish, String usage) {
        List<String> lines = new ArrayList<>();
        int size = Math.max(1, (text.length() + pieces - 1) / pieces);
        for (int i = 0; i < text.length(); i += size) {
            lines.add(chunk(text.substring(i, Math.min(text.length(), i + size))));
        }
        lines.add(finish);
        lines.add(usage);
        lines.add("[DONE]");
        return lines.toArray(String[]::new);
    }

    WebTestClient.ResponseSpec post(String path, String uid, Object body) {
        return postAs(path, uid == null ? null : token(uid), body);
    }

    /** As {@link #post}, under a token the test minted ({@link #token(String, boolean, boolean, String)}). */
    WebTestClient.ResponseSpec postAs(String path, String token, Object body) {
        WebTestClient.RequestBodySpec spec = client.post().uri(path).contentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            spec.header(InternalToken.HEADER, token);
        }
        return spec.bodyValue(body).exchange();
    }

    /** {@code GET /v1/forge/allowance} under `token` (W1). */
    WebTestClient.ResponseSpec allowance(String token) {
        return client.get().uri("/v1/forge/allowance").header(InternalToken.HEADER, token).exchange();
    }

    List<ServerSentEvent<String>> stream(String path, String uid, Object body) {
        FluxExchangeResult<ServerSentEvent<String>> result = post(path, uid, body).expectStatus().isOk().returnResult(EVENTS);
        assertThat(result.getResponseHeaders().getContentType()).isNotNull();
        assertThat(result.getResponseHeaders().getContentType().isCompatibleWith(MediaType.TEXT_EVENT_STREAM)).isTrue();
        return result.getResponseBody().collectList().block(Duration.ofSeconds(20));
    }

    /** A handler's request, as a test calls it without a server: the caller vouched for, the body given. */
    static <T> ServerRequest handlerRequest(String path, String uid, T body) {
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post(path));
        exchange.getAttributes().put(InternalTokenFilter.CALLER_ATTRIBUTE, new Caller(uid, true, false, "anonymous", TestAdmissions.NETWORK));
        return MockServerRequest.builder().exchange(exchange).method(org.springframework.http.HttpMethod.POST)
                .uri(java.net.URI.create(path)).body(Mono.just(body));
    }

    static List<String> names(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> e.event() != null).map(ServerSentEvent::event).toList();
    }

    static JsonNode data(ServerSentEvent<String> event) {
        try {
            return JSON.readTree(event.data());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static JsonNode first(List<ServerSentEvent<String>> events, String name) {
        return data(events.stream().filter(e -> name.equals(e.event())).findFirst().orElseThrow());
    }

    static ServerSentEvent<String> last(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> e.event() != null).reduce((a, b) -> b).orElseThrow();
    }

    static Map<String, Object> planBody(String prompt) {
        return Map.of("prompt", prompt, "style", "cosmic", "seconds", 12);
    }

    static Map<String, Object> diagnostic(String message) {
        return Map.of("source", "tint", "line", 11, "column", 25, "message", message, "snippet", "let jitter = hash11(i) * 0.02;");
    }

    static Map<String, Object> repairBody(String generationId, Map<String, Object>... diagnostics) {
        return Map.of("generationId", generationId, "diagnostics", List.of(diagnostics));
    }

    /** The request sent to the fake, as JSON. */
    JsonNode sent(int index) {
        try {
            return JSON.readTree(fake.requests().get(index).body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** An OK plan in the store, as the plan route leaves it, with its prompt granted to `uid` (its authors and repairs join it). */
    String storedPlan(String uid, String draft) {
        String id = stored(Generation.Kind.PLAN, null, null, uid, draft, Generation.Status.OK);
        admit.admission().entry(new Caller(uid, true, false, "anonymous", TestAdmissions.NETWORK), id, "a spiral galaxy", "plan").spent();
        return id;
    }

    /** A finished generation in the store, as an earlier call would have left it. */
    String stored(Generation.Kind kind, String parentId, String fn, String uid, String output, Generation.Status status) {
        Instant now = Instant.now();
        String id = Ulid.next(now);
        String role = switch (kind) {
            case PLAN -> "planner";
            case AUTHOR -> "author";
            case REPAIR -> "repairer";
            case DIRECT -> "director";
            case AGENT -> "agent";
        };
        String template = switch (kind) {
            case PLAN -> "planner.v1";
            case AUTHOR -> "author." + fn + ".v1";
            case REPAIR -> "repair.v1";
            case DIRECT -> "director.v1";
            case AGENT -> "agent.v3";
        };
        store.begin(Generation.started(id, kind, parentId, role, "m-1", template, "h1", fn,
                "{\"prompt\":\"a spiral galaxy\",\"style\":\"cosmic\",\"seconds\":12}", Generation.Source.USER, uid, now));
        store.finish(id, new Generation.Finish(output, 1L, 1L, null, 1, 1L, 1L, 1L, status));
        return id;
    }

    Generation only(Generation.Kind kind) {
        List<Generation> found = all(kind);
        assertThat(found).hasSize(1);
        return found.get(0);
    }

    List<Generation> all(Generation.Kind kind) {
        return store.snapshot().stream().filter(g -> g.kind() == kind).toList();
    }

    /** Waits for a condition the server reaches on its own threads, up to the given time. */
    static void await(Duration atMost, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + atMost.toNanos();
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) {
                return;
            }
            Thread.sleep(25);
        }
    }
}
