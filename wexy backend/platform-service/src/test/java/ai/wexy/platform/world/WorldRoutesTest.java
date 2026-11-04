package ai.wexy.platform.world;

import ai.wexy.common.InternalToken;
import ai.wexy.platform.GatewayKeys;
import ai.wexy.platform.TestDatabase;
import ai.wexy.platform.account.AccountHandler;
import ai.wexy.platform.account.Accounts;
import ai.wexy.platform.account.Handle;
import ai.wexy.platform.account.JdbcAccountStore;
import ai.wexy.platform.account.SubjectKey;
import ai.wexy.platform.error.ErrorEnvelopeHandler;
import ai.wexy.platform.identity.InternalTokenFilter;
import ai.wexy.platform.storage.InMemoryObjectStore;
import ai.wexy.platform.storage.ObjectStore;
import ai.wexy.platform.storage.StorageConfiguration;
import ai.wexy.platform.storage.StorageProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W3's world routes end to end, but for B2 (the creations platform design §7, §10; PL-T2, PL-T4 to PL-T8): through the
 * platform's token filter, its error envelope and the real stores on a real MariaDB, with a B2 that keeps its rules
 * (InMemoryObjectStore). A save and its exact bytes back; another account seeing none of it; a retry with its key;
 * the head's compare-and-set between two tabs; retention, the caps and their release only on B2's confirmed delete; a
 * write B2 refused, a process that died mid-save, a corrupt object; rename, the history's pages, deletion. Skipped, and
 * reported as skipped, when Docker is not running.
 */
@Testcontainers(disabledWithoutDocker = true)
class WorldRoutesTest {

    @Container
    private static final GenericContainer<?> MARIADB = TestDatabase.container();
    private static final String KEY = "7465737474657374746573747465737474657374746573747465737474657374";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static HikariDataSource pool;

    private final GatewayKeys gateway = new GatewayKeys();
    private final TestClock clock = new TestClock(Instant.parse("2026-11-03T12:00:00Z"));
    private InMemoryObjectStore b2;
    private JdbcClient jdbc;
    private JdbcWorldStore store;
    private CleanupWorker cleanup;
    private WebTestClient client;
    private final Map<String, String> accounts = new HashMap<>();

    @BeforeAll
    static void migrate() {
        TestDatabase.awaitConnection(MARIADB);
        Flyway.configure().dataSource(TestDatabase.url(MARIADB), TestDatabase.USER, TestDatabase.PASSWORD)
                .locations("classpath:db/migration").load().migrate();
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(TestDatabase.url(MARIADB));
        config.setUsername(TestDatabase.USER);
        config.setPassword(TestDatabase.PASSWORD);
        config.setMaximumPoolSize(6);
        pool = new HikariDataSource(config);
    }

    @AfterAll
    static void close() {
        pool.close();
    }

    @BeforeEach
    void open() {
        jdbc = JdbcClient.create(pool);
        jdbc.sql("DELETE FROM cleanup_job").update();
        jdbc.sql("DELETE FROM operation").update();
        jdbc.sql("UPDATE creation SET head_revision_id = NULL").update();
        jdbc.sql("DELETE FROM revision").update();
        jdbc.sql("DELETE FROM creation").update();
        jdbc.sql("DELETE FROM stored_object").update();
        jdbc.sql("DELETE FROM storage_usage WHERE owner_id <> :env").param("env", JdbcWorldStore.ENVIRONMENT).update();
        jdbc.sql("UPDATE storage_usage SET used_bytes = 0, reserved_bytes = 0, used_objects = 0, reserved_objects = 0").update();
        jdbc.sql("DELETE FROM profile").update();
        jdbc.sql("DELETE FROM account").update();
        build(WorldProperties.defaults(), new InMemoryObjectStore());
    }

    private void build(WorldProperties limits, ObjectStore objects) {
        b2 = objects instanceof InMemoryObjectStore memory ? memory : null;
        DataSourceTransactionManager transactions = new DataSourceTransactionManager(pool);
        Accounts accountService = new Accounts(new JdbcAccountStore(jdbc, transactions), new SubjectKey(KEY, 1, true),
                Handle.reservedFromResource(), 1, clock);
        store = new JdbcWorldStore(jdbc, transactions, limits);
        Worlds worlds = new Worlds(accountService, store, objects, new WorldCheck(), clock);
        cleanup = new CleanupWorker(store, objects, limits, Schedulers.immediate(), clock);
        WorldHandler handler = new WorldHandler(worlds, Schedulers.boundedElastic(), Schedulers.boundedElastic());
        client = WebTestClient.bindToRouterFunction(new AccountHandler.Routes().accountRoutes(new AccountHandler(accountService,
                                Schedulers.boundedElastic()))
                        .and(new WorldHandler.Routes().worldRoutes(handler)))
                .handlerStrategies(HandlerStrategies.builder()
                        .webFilter(new InternalTokenFilter(gateway.keySet()))
                        .exceptionHandler(new ErrorEnvelopeHandler())
                        .codecs(c -> c.defaultCodecs().maxInMemorySize(768 * 1024))
                        .build())
                .configureClient()
                .responseTimeout(Duration.ofSeconds(30))
                .build();
    }

    // --- Helpers ----------------------------------------------------------------------------------------------------

    private String account(String uid) {
        return accounts.computeIfAbsent(uid, u -> json(client.post().uri("/v1/me").header(InternalToken.HEADER, gateway.account(u))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of()).exchange().expectStatus().isCreated()).get("accountId").asText());
    }

    private static String castle() {
        try {
            return new ClassPathResource("world/castle.wexy-world.json").getContentAsString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Another canonical world: the castle with its view at `n`. */
    private static String variant(int n) {
        try {
            ObjectNode w = (ObjectNode) JSON.readTree(castle());
            ObjectNode view = w.putObject("view");
            view.putArray("target").add(0).add(0).add(n);
            view.put("distance", 12).put("azimuth", 0).put("polar", 60).put("fov", 45);
            return WorldCheckTest.Canonical.write(w);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String sha(String text) {
        return WorldCheck.sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String key() {
        return UUID.randomUUID().toString();
    }

    private WebTestClient.ResponseSpec create(String uid, String key, String title, String text) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("artifact", text);
        body.put("sha256", sha(text));
        WebTestClient.RequestBodySpec spec = client.post().uri("/v1/worlds").header(InternalToken.HEADER, gateway.account(uid));
        if (key != null) {
            spec.header(WorldHandler.IDEMPOTENCY_KEY, key);
        }
        return spec.contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange();
    }

    private WebTestClient.ResponseSpec revise(String uid, String worldId, String key, String base, long version, String text) {
        return client.post().uri("/v1/worlds/" + worldId + "/revisions").header(InternalToken.HEADER, gateway.account(uid))
                .header(WorldHandler.IDEMPOTENCY_KEY, key).contentType(MediaType.APPLICATION_JSON)
                .bodyValue(Map.of("baseRevisionId", base, "expectedVersion", version, "artifact", text, "sha256", sha(text))).exchange();
    }

    private WebTestClient.ResponseSpec get(String uid, String path) {
        return client.get().uri(path).header(InternalToken.HEADER, gateway.account(uid)).exchange();
    }

    private WebTestClient.ResponseSpec rename(String uid, String worldId, Object version, String title) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("expectedVersion", version);
        body.put("title", title);
        return client.patch().uri("/v1/worlds/" + worldId).header(InternalToken.HEADER, gateway.account(uid))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange();
    }

    private WebTestClient.ResponseSpec delete(String uid, String worldId, String key, long version) {
        return client.delete().uri("/v1/worlds/" + worldId + "?expectedVersion=" + version).header(InternalToken.HEADER, gateway.account(uid))
                .header(WorldHandler.IDEMPOTENCY_KEY, key).exchange();
    }

    private static JsonNode json(WebTestClient.ResponseSpec response) {
        try {
            return JSON.readTree(response.expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                    .expectBody(String.class).returnResult().getResponseBody());
        } catch (IOException e) {
            throw new AssertionError(e);
        }
    }

    private static void refused(WebTestClient.ResponseSpec response, int status, String code) {
        response.expectStatus().isEqualTo(status).expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                .expectBody().jsonPath("$.code").isEqualTo(code);
    }

    private JsonNode usage(String uid) {
        return json(get(uid, "/v1/me/usage").expectStatus().isOk());
    }

    private static List<String> names(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    // --- The tests --------------------------------------------------------------------------------------------------

    @Test
    void aSaveMakesAWorldOnlyItsOwnerSeesAndItsTextComesBackByteForByte() {
        String owner = account("uid-a");
        account("uid-b");
        String text = castle();
        JsonNode world = json(create("uid-a", key(), "  The castle on the hill  ", text).expectStatus().isCreated());

        assertThat(names(world)).containsExactly("worldId", "title", "rowVersion", "createdAt", "updatedAt", "head");
        assertThat(names(world.get("head"))).containsExactly("revisionId", "sha256", "bytes", "format", "line", "createdAt");
        assertThat(world.get("title").asText()).isEqualTo("The castle on the hill");
        assertThat(world.get("rowVersion").asLong()).isZero();
        assertThat(world.get("createdAt").asText()).isEqualTo("2026-11-03T12:00:00.000Z");
        JsonNode head = world.get("head");
        assertThat(head.get("sha256").asText()).isEqualTo(sha(text));
        assertThat(head.get("bytes").asInt()).isEqualTo(20541);
        assertThat(head.get("format").asText()).isEqualTo("wexy-world.v1");
        assertThat(head.get("line").asText()).isEqualTo("ea.v1");
        String id = world.get("worldId").asText();
        String revision = head.get("revisionId").asText();
        // The key is the platform's: the owner, the world, the revision, a new object id. No client word in it.
        assertThat(b2.keys()).singleElement().asString()
                .startsWith("worlds/" + owner + "/" + id + "/revisions/" + revision + "/").endsWith(".json");

        JsonNode list = json(get("uid-a", "/v1/me/worlds").expectStatus().isOk());
        assertThat(names(list)).containsExactly("worlds", "next");
        assertThat(list.get("worlds")).hasSize(1);
        assertThat(list.get("worlds").get(0)).isEqualTo(world);
        assertThat(list.get("next").isNull()).isTrue();
        assertThat(json(get("uid-a", "/v1/worlds/" + id).expectStatus().isOk())).isEqualTo(world);

        JsonNode saved = json(get("uid-a", "/v1/worlds/" + id + "/revisions/" + revision).expectStatus().isOk());
        assertThat(names(saved)).containsExactly("worldId", "revisionId", "sha256", "bytes", "format", "line", "createdAt", "artifact");
        assertThat(saved.get("artifact").asText()).isEqualTo(text);

        JsonNode usage = usage("uid-a");
        assertThat(names(usage)).containsExactly("usedBytes", "reservedBytes", "worlds", "limits");
        assertThat(usage.get("usedBytes").asLong()).isEqualTo(20541);
        assertThat(usage.get("reservedBytes").asLong()).isZero();
        assertThat(usage.get("worlds").asLong()).isEqualTo(1);
        assertThat(usage.get("limits").get("worlds").asLong()).isEqualTo(50);

        // PL-T2: another account swapping in every id gets the same 404 as an unknown id, and writes nothing.
        refused(get("uid-b", "/v1/worlds/" + id), 404, "not-found");
        refused(get("uid-b", "/v1/worlds/" + id + "/revisions/" + revision), 404, "not-found");
        refused(rename("uid-b", id, 0, "Mine now"), 404, "not-found");
        refused(delete("uid-b", id, key(), 0), 404, "not-found");
        refused(revise("uid-b", id, key(), revision, 0, variant(1)), 404, "not-found");
        assertThat(json(get("uid-b", "/v1/me/worlds").expectStatus().isOk()).get("worlds")).isEmpty();
        assertThat(usage("uid-b").get("usedBytes").asLong()).isZero();
        assertThat(json(get("uid-a", "/v1/worlds/" + id).expectStatus().isOk())).isEqualTo(world);
        assertThat(b2.objects()).isEqualTo(1);
    }

    @Test
    void aRetryWithItsKeyIsAnsweredAsTheFirstAndAnotherBodyUnderItIsAConflict() {
        account("uid-a");
        String k = key();
        String first = create("uid-a", k, "The castle", castle()).expectStatus().isCreated().expectBody(String.class).returnResult().getResponseBody();
        String again = create("uid-a", k, "The castle", castle()).expectStatus().isCreated().expectBody(String.class).returnResult().getResponseBody();
        assertThat(again).isEqualTo(first);
        assertThat(b2.puts.get()).as("one write, not two").isEqualTo(1);
        assertThat(json(get("uid-a", "/v1/me/worlds")).get("worlds")).hasSize(1);
        refused(create("uid-a", k, "Another title", castle()), 409, "conflict");
        refused(create("uid-a", null, "The castle", castle()), 400, "bad-request");
        refused(create("uid-a", "short", "The castle", castle()), 400, "bad-request");
        assertThat(b2.puts.get()).isEqualTo(1);
    }

    @Test
    void aRevisionMovesTheHeadAndTheOldBytesLeaveOnlyOnceB2ConfirmsTheirDelete() {
        account("uid-a");
        JsonNode first = json(create("uid-a", key(), "The castle", castle()).expectStatus().isCreated());
        String id = first.get("worldId").asText();
        String old = first.get("head").get("revisionId").asText();
        String text = variant(1);
        clock.advance(Duration.ofSeconds(5));
        JsonNode second = json(revise("uid-a", id, key(), old, 0, text).expectStatus().isCreated());
        assertThat(second.get("worldId").asText()).isEqualTo(id);
        assertThat(second.get("rowVersion").asLong()).isEqualTo(1);
        assertThat(second.get("head").get("revisionId").asText()).isNotEqualTo(old);
        assertThat(second.get("head").get("sha256").asText()).isEqualTo(sha(text));
        assertThat(second.get("updatedAt").asText()).isEqualTo("2026-11-03T12:00:05.000Z");
        // Release 1 keeps the head alone (Q96): the old head is not readable, but its bytes are charged until B2 says
        // they are gone (I5).
        refused(get("uid-a", "/v1/worlds/" + id + "/revisions/" + old), 404, "not-found");
        assertThat(b2.objects()).isEqualTo(2);
        long both = 20541L + text.getBytes(StandardCharsets.UTF_8).length;
        assertThat(usage("uid-a").get("usedBytes").asLong()).isEqualTo(both);

        b2.failDeletes.set(1);
        CleanupWorker.Tick failed = cleanup.tick();
        assertThat(failed.retried()).isEqualTo(1);
        assertThat(usage("uid-a").get("usedBytes").asLong()).as("a failed delete keeps the charge").isEqualTo(both);
        clock.advance(Duration.ofMinutes(1));
        CleanupWorker.Tick done = cleanup.tick();
        assertThat(done.erased()).isEqualTo(1);
        assertThat(b2.objects()).isEqualTo(1);
        assertThat(usage("uid-a").get("usedBytes").asLong()).isEqualTo(text.getBytes(StandardCharsets.UTF_8).length);
        assertThat(json(get("uid-a", "/v1/worlds/" + id + "/revisions/" + second.get("head").get("revisionId").asText()))
                .get("artifact").asText()).isEqualTo(text);
        // A stale base is a conflict, and writes nothing.
        refused(revise("uid-a", id, key(), old, 1, variant(2)), 409, "conflict");
        refused(revise("uid-a", id, key(), second.get("head").get("revisionId").asText(), 0, variant(2)), 409, "conflict");
        assertThat(b2.objects()).isEqualTo(1);
    }

    @Test
    void twoTabsSavingOnOneHeadCommitOnceAndTheOtherIsAConflict() throws Exception {
        account("uid-a");
        JsonNode first = json(create("uid-a", key(), "The castle", castle()).expectStatus().isCreated());
        String id = first.get("worldId").asText();
        String base = first.get("head").get("revisionId").asText();
        ExecutorService tabs = Executors.newFixedThreadPool(2);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Integer>> statuses = new ArrayList<>();
        for (int tab = 1; tab <= 2; tab++) {
            String text = variant(tab);
            statuses.add(tabs.submit(() -> {
                go.await();
                return revise("uid-a", id, key(), base, 0, text).returnResult(String.class).getStatus().value();
            }));
        }
        go.countDown();
        List<Integer> got = new ArrayList<>();
        for (Future<Integer> f : statuses) {
            got.add(f.get());
        }
        tabs.shutdown();
        assertThat(got).containsExactlyInAnyOrder(201, 409);
        JsonNode now = json(get("uid-a", "/v1/worlds/" + id));
        assertThat(now.get("rowVersion").asLong()).isEqualTo(1);
        cleanup.tick();
        assertThat(b2.objects()).as("the winner's bytes alone: the old head and the loser's are erased").isEqualTo(1);
        assertThat(usage("uid-a").get("reservedBytes").asLong()).isZero();
    }

    /**
     * I4 at the commit, in a fixed order the routes cannot force: two saves begin on one head (both pass the begin's
     * check), the first commits, and the second's commit finds the head moved. It is a conflict, its answer stored for a
     * retry with its key, and its bytes queued for deletion with their reservation kept until B2 confirms.
     */
    @Test
    void aSaveBegunOnAHeadThatMovesBeforeItCommitsIsAConflict() {
        String owner = account("uid-a");
        JsonNode first = json(create("uid-a", key(), "The castle", castle()).expectStatus().isCreated());
        String id = first.get("worldId").asText();
        String base = first.get("head").get("revisionId").asText();
        String route = "POST /v1/worlds/" + id + "/revisions";
        WorldCheck check = new WorldCheck();
        String textA = variant(1);
        String textB = variant(2);
        WorldCheck.Facts a = check.check(textA, sha(textA));
        WorldCheck.Facts b = check.check(textB, sha(textB));
        JdbcWorldStore.Save saveA = new JdbcWorldStore.Save(JdbcWorldStore.Kind.REVISE, owner, route, key(), "a".repeat(64), id, base, 0,
                a.bytes(), a.sha256(), clock.instant());
        JdbcWorldStore.Save saveB = new JdbcWorldStore.Save(JdbcWorldStore.Kind.REVISE, owner, route, key(), "b".repeat(64), id, base, 0,
                b.bytes(), b.sha256(), clock.instant());
        JdbcWorldStore.Started startedA = (JdbcWorldStore.Started) store.begin(saveA);
        JdbcWorldStore.Started startedB = (JdbcWorldStore.Started) store.begin(saveB);
        assertThat(store.commit(saveA, startedA, null, a, "va", w -> "{}")).isInstanceOf(JdbcWorldStore.Saved.class);
        assertThat(store.commit(saveB, startedB, null, b, "vb", w -> "{}")).isInstanceOf(JdbcWorldStore.Conflicted.class);
        JsonNode now = json(get("uid-a", "/v1/worlds/" + id));
        assertThat(now.get("rowVersion").asLong()).isEqualTo(1);
        assertThat(now.get("head").get("revisionId").asText()).isEqualTo(startedA.revisionId());
        JdbcWorldStore.OperationRow lost = store.operation(owner, startedB.operationId()).orElseThrow();
        assertThat(lost.state()).isEqualTo("DONE");
        assertThat(lost.status()).isEqualTo(409);
        assertThat(usage("uid-a").get("reservedBytes").asLong()).as("kept until B2 confirms").isEqualTo(b.bytes());
        cleanup.tick();
        assertThat(usage("uid-a").get("reservedBytes").asLong()).isZero();
        assertThat(usage("uid-a").get("usedBytes").asLong()).isEqualTo(a.bytes());
    }

    @Test
    void aFullStorageIsRefusedWithNoWaitAndDeletingAWorldMakesRoom() {
        build(new WorldProperties(2, 100L * 1024 * 1024, 1024L * 1024 * 1024, 2, Duration.ofHours(24), Duration.ofMinutes(2),
                Duration.ofSeconds(15), 10, false), new InMemoryObjectStore());
        account("uid-a");
        String one = json(create("uid-a", key(), "One", variant(1)).expectStatus().isCreated()).get("worldId").asText();
        create("uid-a", key(), "Two", variant(2)).expectStatus().isCreated();
        create("uid-a", key(), "Three", variant(3)).expectStatus().isForbidden()
                .expectHeader().doesNotExist("Retry-After")
                .expectBody().jsonPath("$.code").isEqualTo("storage-full");
        assertThat(b2.puts.get()).isEqualTo(2);
        JsonNode deleting = json(delete("uid-a", one, key(), 0).expectStatus().isAccepted());
        assertThat(names(deleting)).containsExactly("operationId", "state");
        assertThat(json(get("uid-a", "/v1/me/worlds")).get("worlds")).hasSize(1);
        create("uid-a", key(), "Three", variant(3)).expectStatus().isCreated();

        // Bytes: the world's own size is the cap, so its revision needs the old head's bytes back first.
        int size = castle().getBytes(StandardCharsets.UTF_8).length;
        build(new WorldProperties(50, size + 100, 1024L * 1024 * 1024, 2, Duration.ofHours(24), Duration.ofMinutes(2),
                Duration.ofSeconds(15), 10, false), new InMemoryObjectStore());
        account("uid-c");
        JsonNode world = json(create("uid-c", key(), "Castle", castle()).expectStatus().isCreated());
        refused(revise("uid-c", world.get("worldId").asText(), key(), world.get("head").get("revisionId").asText(), 0, variant(9)),
                403, "storage-full");
    }

    @Test
    void aWriteB2RefusedFailsTheSaveKeepsItsReservationUntilB2SaysAndItsRetryRunsAgain() {
        account("uid-a");
        String k = key();
        b2.failPuts.set(1);
        refused(create("uid-a", k, "The castle", castle()), 503, "unavailable");
        assertThat(json(get("uid-a", "/v1/me/worlds")).get("worlds")).isEmpty();
        assertThat(usage("uid-a").get("reservedBytes").asLong()).as("kept until B2 confirms").isEqualTo(20541);
        cleanup.tick();
        assertThat(usage("uid-a").get("reservedBytes").asLong()).isZero();
        create("uid-a", k, "The castle", castle()).expectStatus().isCreated();
        assertThat(b2.objects()).isEqualTo(1);
        assertThat(usage("uid-a").get("usedBytes").asLong()).isEqualTo(20541);
    }

    @Test
    void aSaveWhoseProcessDiedIsFailedByTheReconcilerAndItsRetryThenRuns() {
        account("uid-a");
        String k = key();
        b2.crashAfterPuts.set(1);
        create("uid-a", k, "The castle", castle()).expectStatus().is5xxServerError();
        // Its bytes are in B2, its operation still running: a retry is told to wait, and nothing is written twice.
        JsonNode waiting = json(create("uid-a", k, "The castle", castle()).expectStatus().isAccepted());
        assertThat(waiting.get("state").asText()).isEqualTo("PENDING");
        String op = waiting.get("operationId").asText();
        assertThat(json(get("uid-a", "/v1/me/operations/" + op)).get("status").isNull()).isTrue();
        // The store's own row, not only the route's answer: a running operation has no status yet (the review of 11-03).
        assertThat(store.operation(accounts.get("uid-a"), op).orElseThrow().status()).isNull();
        assertThat(b2.objects()).isEqualTo(1);
        assertThat(cleanup.tick().failedStale()).as("not stale yet").isZero();
        clock.advance(Duration.ofMinutes(3));
        CleanupWorker.Tick tick = cleanup.tick();
        assertThat(tick.failedStale()).isEqualTo(1);
        assertThat(tick.erased()).isEqualTo(1);
        assertThat(b2.objects()).isZero();
        assertThat(usage("uid-a").get("reservedBytes").asLong()).isZero();
        JsonNode failed = json(get("uid-a", "/v1/me/operations/" + op));
        assertThat(failed.get("state").asText()).isEqualTo("FAILED");
        assertThat(failed.get("status").asInt()).isEqualTo(503);
        create("uid-a", k, "The castle", castle()).expectStatus().isCreated();
        assertThat(json(get("uid-a", "/v1/me/operations/" + op)).get("state").asText()).isEqualTo("DONE");
    }

    @Test
    void aMissingOrAlteredObjectIsUnavailableNeverAnEmptyWorld() {
        account("uid-a");
        JsonNode world = json(create("uid-a", key(), "The castle", castle()).expectStatus().isCreated());
        String path = "/v1/worlds/" + world.get("worldId").asText() + "/revisions/" + world.get("head").get("revisionId").asText();
        b2.failGets.set(1);
        refused(get("uid-a", path), 503, "unavailable");
        b2.corrupt(b2.keys().get(0));
        refused(get("uid-a", path), 503, "unavailable");
    }

    @Test
    void aRenameIsAtItsVersionTheHistoryPagesNewestFirstAndADeletionFinishesOnceB2HasErasedIt() {
        account("uid-a");
        List<String> ids = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            ids.add(json(create("uid-a", key(), "World " + i, variant(i)).expectStatus().isCreated()).get("worldId").asText());
            clock.advance(Duration.ofSeconds(1));
        }
        JsonNode renamed = json(rename("uid-a", ids.get(0), 0, "The first").expectStatus().isOk());
        assertThat(renamed.get("title").asText()).isEqualTo("The first");
        assertThat(renamed.get("rowVersion").asLong()).isEqualTo(1);
        refused(rename("uid-a", ids.get(0), 0, "Stale"), 409, "conflict");
        for (String bad : new String[]{"", "   ", "x".repeat(121), "two\nlines", "tab\there"}) {
            refused(rename("uid-a", ids.get(0), 1, bad), 400, "bad-request");
        }
        assertThat(json(rename("uid-a", ids.get(0), 1, "🌌".repeat(120)).expectStatus().isOk()).get("rowVersion").asLong())
                .as("120 code points, not UTF-16 units").isEqualTo(2);

        JsonNode page = json(get("uid-a", "/v1/me/worlds?limit=2"));
        assertThat(page.get("worlds")).extracting(w -> w.get("worldId").asText()).containsExactly(ids.get(2), ids.get(1));
        JsonNode rest = json(get("uid-a", "/v1/me/worlds?limit=2&cursor=" + page.get("next").asText()));
        assertThat(rest.get("worlds")).extracting(w -> w.get("worldId").asText()).containsExactly(ids.get(0));
        assertThat(rest.get("next").isNull()).isTrue();
        refused(get("uid-a", "/v1/me/worlds?cursor=not-a-cursor"), 400, "bad-request");
        refused(get("uid-a", "/v1/me/worlds?limit=0"), 400, "bad-request");
        refused(get("uid-a", "/v1/me/worlds?limit=51"), 400, "bad-request");

        String gone = ids.get(1);
        refused(delete("uid-a", gone, key(), 5), 409, "conflict");
        String k = key();
        JsonNode deleting = json(delete("uid-a", gone, k, 0).expectStatus().isAccepted());
        String op = deleting.get("operationId").asText();
        assertThat(json(delete("uid-a", gone, k, 0).expectStatus().isAccepted()).get("operationId").asText())
                .as("its retry names the same operation").isEqualTo(op);
        refused(get("uid-a", "/v1/worlds/" + gone), 404, "not-found");
        assertThat(json(get("uid-a", "/v1/me/worlds")).get("worlds")).hasSize(2);
        assertThat(json(get("uid-a", "/v1/me/operations/" + op)).get("state").asText()).isEqualTo("PENDING");
        cleanup.tick();
        clock.advance(Duration.ofMinutes(1));
        cleanup.tick();
        assertThat(json(get("uid-a", "/v1/me/operations/" + op)).get("state").asText()).isEqualTo("DONE");
        assertThat(b2.objects()).isEqualTo(2);
        assertThat(jdbc.sql("SELECT status FROM creation WHERE id = :id").param("id", gone).query(String.class).single()).isEqualTo("DELETED");
        assertThat(usage("uid-a").get("worlds").asLong()).isEqualTo(2);
    }

    @Test
    void nothingIsStoredForASaveRefusedAtTheDoor() throws IOException {
        account("uid-a");
        ObjectNode h1 = (ObjectNode) JSON.readTree(castle());
        h1.put("kind", "h1");
        refused(create("uid-a", key(), "An h1 world", WorldCheckTest.Canonical.write(h1)), 400, "bad-request");
        refused(create("uid-a", key(), "Spaced", castle().replace("\"kind\":\"agent\"", "\"kind\": \"agent\"")), 400, "bad-request");
        Map<String, Object> wrongHash = Map.of("title", "x", "artifact", castle(), "sha256", "e".repeat(64));
        refused(client.post().uri("/v1/worlds").header(InternalToken.HEADER, gateway.account("uid-a")).header(WorldHandler.IDEMPOTENCY_KEY, key())
                .contentType(MediaType.APPLICATION_JSON).bodyValue(wrongHash).exchange(), 400, "bad-request");
        Map<String, Object> extra = new LinkedHashMap<>(Map.of("title", "x", "artifact", castle(), "sha256", sha(castle())));
        extra.put("ownerId", "someone-else");
        refused(client.post().uri("/v1/worlds").header(InternalToken.HEADER, gateway.account("uid-a")).header(WorldHandler.IDEMPOTENCY_KEY, key())
                .contentType(MediaType.APPLICATION_JSON).bodyValue(extra).exchange(), 400, "bad-request");
        refused(create("uid-a", key(), "x".repeat(121), castle()), 400, "bad-request");
        assertThat(b2.puts.get()).isZero();
        assertThat(usage("uid-a").get("reservedBytes").asLong()).isZero();
        // No account yet; and no token at all.
        refused(create("uid-new", key(), "The castle", castle()), 404, "not-found");
        refused(client.get().uri("/v1/me/worlds").exchange(), 401, "auth");
        // A suspended account reads its status (W2) but saves nothing.
        jdbc.sql("UPDATE account SET status = 'SUSPENDED' WHERE id = :id").param("id", accounts.get("uid-a")).update();
        refused(create("uid-a", key(), "The castle", castle()), 403, "forbidden");
    }

    @Test
    void withoutB2EverySaveIsUnavailableAndAccountsStillWork() {
        build(WorldProperties.defaults(), new StorageConfiguration().objectStore(new StorageProperties(null, null, null, null, null, null, null)));
        account("uid-a");
        refused(create("uid-a", key(), "The castle", castle()), 503, "unavailable");
        assertThat(json(get("uid-a", "/v1/me/worlds")).get("worlds")).isEmpty();
        get("uid-a", "/v1/me").expectStatus().isOk();
    }

    @Test
    void twoSavesUnderWayAtOnceAreTheMostAnAccountGets() {
        account("uid-a");
        b2.crashAfterPuts.set(2);
        create("uid-a", key(), "One", variant(1)).expectStatus().is5xxServerError();
        create("uid-a", key(), "Two", variant(2)).expectStatus().is5xxServerError();
        refused(create("uid-a", key(), "Three", variant(3)), 429, "rate");
        clock.advance(Duration.ofMinutes(3));
        cleanup.tick();
        create("uid-a", key(), "Three", variant(3)).expectStatus().isCreated();
    }

    /** A clock the tests move. */
    static final class TestClock extends Clock {
        private volatile Instant now;

        TestClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
