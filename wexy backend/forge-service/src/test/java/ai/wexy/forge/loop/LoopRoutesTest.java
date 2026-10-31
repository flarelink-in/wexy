package ai.wexy.forge.loop;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.Ulid;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.test.web.reactive.server.FluxExchangeResult;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static ai.wexy.forge.loop.LoopTestServer.EVENTS;
import static ai.wexy.forge.loop.LoopTestServer.GALAXY;
import static ai.wexy.forge.loop.LoopTestServer.JSON;
import static ai.wexy.forge.loop.LoopTestServer.LENGTH;
import static ai.wexy.forge.loop.LoopTestServer.STOP;
import static ai.wexy.forge.loop.LoopTestServer.chunk;
import static ai.wexy.forge.loop.LoopTestServer.data;
import static ai.wexy.forge.loop.LoopTestServer.last;
import static ai.wexy.forge.loop.LoopTestServer.names;
import static ai.wexy.forge.loop.LoopTestServer.planBody;
import static ai.wexy.forge.loop.LoopTestServer.streamOf;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The loop's routes over a real Netty server, through the identity filter and the error envelope,
 * against a fake Meta API and the in-memory meter (forge-loop design §12: U6, R1 to R7, R11, R13).
 * {@code RepairDirectOutcomesTest} covers B0.4's routes and {@code LoopLifecycleTest} the record's
 * lifecycle, on the same fixture.
 */
class LoopRoutesTest {

    private final LoopTestServer s = new LoopTestServer();

    @AfterEach
    void down() {
        s.close();
    }

    /** R1, P2: meta, the deltas, usage, done, in order; the record OK with its tokens, cost and template. */
    @Test
    void aPlanStreamsInOrderAndIsRecorded() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 8, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        List<String> names = names(events);
        assertThat(names.get(0)).isEqualTo("meta");
        assertThat(names.subList(1, names.size() - 2)).isNotEmpty().allMatch("delta"::equals);
        assertThat(names.subList(names.size() - 2, names.size())).containsExactly("usage", "done");
        JsonNode meta = data(events.stream().filter(e -> "meta".equals(e.event())).findFirst().orElseThrow());
        assertThat(meta.path("role").asText()).isEqualTo("planner");
        assertThat(meta.path("promptVersion").asText()).isEqualTo("planner.v1");
        assertThat(meta.path("source").asText()).isEqualTo("live");
        assertThat(meta.path("model").asText()).isEqualTo("m-1");
        assertThat(meta.has("fn")).isFalse();
        String text = events.stream().filter(e -> "delta".equals(e.event())).map(e -> data(e).path("text").asText()).collect(Collectors.joining());
        assertThat(text).isEqualTo(GALAXY);
        JsonNode usage = data(events.stream().filter(e -> "usage".equals(e.event())).findFirst().orElseThrow());
        assertThat(usage.toString()).isEqualTo("{\"in\":2400,\"out\":900,\"reasoning\":300,\"cached\":2000}");

        Generation plan = s.only(Generation.Kind.PLAN);
        assertThat(plan.id()).isEqualTo(meta.path("generationId").asText());
        assertThat(plan.status()).isEqualTo(Generation.Status.OK);
        assertThat(plan.output()).isEqualTo(GALAXY);
        assertThat(plan.tokensIn()).isEqualTo(2400L);
        assertThat(plan.tokensOut()).isEqualTo(900L);
        assertThat(plan.tokensReasoning()).isEqualTo(300L);
        assertThat(plan.costMicroUsd()).isEqualTo(s.catalog.costMicroUsd("m-1", 2400, 900));
        // The reservation is the bound; the ledger is settled to the cost once the stream ends.
        assertThat(plan.chargedMicroUsd()).isGreaterThan(plan.costMicroUsd());
        LoopTestServer.await(Duration.ofSeconds(3), () -> s.ledger.totalForProvider("meta-spark") == plan.costMicroUsd());
        assertThat(s.ledger.totalForProvider("meta-spark")).isEqualTo(plan.costMicroUsd());
        assertThat(plan.promptVersion()).isEqualTo("planner.v1");
        assertThat(plan.hostVersion()).isEqualTo("h1");
        assertThat(plan.uid()).isEqualTo("uid-1");
        assertThat(JSON.readTree(plan.input()).path("prompt").asText()).isEqualTo("a spiral galaxy");

        // What went to Meta: the planner's template, its schema, its effort, a hash of the caller.
        JsonNode sent = s.sent(0);
        assertThat(sent.path("messages").get(0).path("content").asText()).startsWith("You plan worlds for Wexy");
        assertThat(sent.path("messages").get(1).path("content").asText()).endsWith("Idea: \"a spiral galaxy\"");
        assertThat(sent.path("max_completion_tokens").asInt()).isEqualTo(2500);
        assertThat(sent.path("reasoning_effort").asText()).isEqualTo("low");
        assertThat(sent.path("response_format").path("json_schema").path("name").asText()).isEqualTo("scene_draft_v1");
        assertThat(sent.path("response_format").path("json_schema").path("strict").asBoolean()).isFalse();
        assertThat(sent.path("response_format").path("json_schema").path("schema").path("required")).isNotEmpty();
        assertThat(sent.path("safety_identifier").asText()).isEqualTo(
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest("uid-1".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void anAuthorCallWritesOneFunctionFromItsCallersPlan() {
        String planId = s.storedPlan("uid-1", GALAXY);
        String function = "fn evolve(p: Particle, i: u32) -> Particle {\n    return p;\n}";
        s.fake.chat = FakeMetaApi.sse(0, streamOf(function, 3, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "evolve"));

        assertThat(names(events).get(0)).isEqualTo("meta");
        assertThat(last(events).event()).isEqualTo("done");
        JsonNode meta = data(events.get(names(events).indexOf("meta")));
        assertThat(meta.path("role").asText()).isEqualTo("author");
        assertThat(meta.path("fn").asText()).isEqualTo("evolve");
        assertThat(meta.path("promptVersion").asText()).isEqualTo("author.evolve.v1");
        Generation author = s.only(Generation.Kind.AUTHOR);
        assertThat(author.parentId()).isEqualTo(planId);
        assertThat(author.fn()).isEqualTo("evolve");
        assertThat(author.output()).isEqualTo(function);
        assertThat(author.status()).isEqualTo(Generation.Status.OK);

        JsonNode sent = s.sent(0);
        String user = sent.path("messages").get(1).path("content").asText();
        assertThat(user).contains("\"a spiral galaxy\"", "params.spin, \"Spin speed\"", "p.b.x: orbit radius", "Write fn evolve for this world.");
        assertThat(sent.path("reasoning_effort").asText()).isEqualTo("medium");
        assertThat(sent.has("response_format")).isFalse();
    }

    /** R2, P1: a cap reached is an envelope before the stream, zero requests upstream, and a DENIED record. */
    @Test
    void aReachedCapIsABudgetEnvelopeAndNothingGoesUpstream() {
        s.restart(10L, 0);
        s.post("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"))
                .expectStatus().isEqualTo(503).expectBody().json("{\"code\":\"budget\"}");
        String planId = s.storedPlan("uid-1", GALAXY);
        s.post("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "look"))
                .expectStatus().isEqualTo(503).expectBody().json("{\"code\":\"budget\"}");

        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.only(Generation.Kind.AUTHOR).status()).isEqualTo(Generation.Status.DENIED);
        assertThat(s.store.snapshot()).filteredOn(g -> g.kind() == Generation.Kind.PLAN && g.status() == Generation.Status.DENIED)
                .hasSize(1).allMatch(g -> g.chargedMicroUsd() == 0);
    }

    /** R3, P3: Meta's in-stream error after one delta ends the stream with exactly one error, last. */
    @Test
    void anUpstreamFailureMidStreamEndsInOneError() {
        s.fake.chat = FakeMetaApi.sse(0, chunk("{\"ti"), "{\"type\":\"error\",\"code\":\"server_error\",\"message\":\"overloaded\"}");

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(names(events)).containsExactly("meta", "delta", "error");
        assertThat(data(last(events)).path("code").asText()).isEqualTo("upstream");
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.ERROR);
    }

    /** R4, P4: a model quiet for longer than the heartbeat still keeps the line warm, and still finishes. */
    @Test
    void aQuietModelStillGetsHeartbeatsAndFinishes() {
        s.fake.chat = FakeMetaApi.sse(150, streamOf(GALAXY, 3, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        int firstComment = -1;
        for (int i = 0; i < events.size(); i++) {
            if ("hb".equals(events.get(i).comment())) {
                firstComment = i;
                break;
            }
        }
        assertThat(firstComment).isGreaterThan(-1);
        assertThat(firstComment).isLessThan(events.indexOf(last(events)));
        assertThat(last(events).event()).isEqualTo("done");
    }

    /** R5, P5, I7: a client that leaves after one delta stops the model, and the record says so. */
    @Test
    void aClientThatLeavesCancelsTheModel() throws Exception {
        s.fake.chat = FakeMetaApi.sse(300, streamOf(GALAXY, 20, STOP));

        FluxExchangeResult<ServerSentEvent<String>> result = s.post("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"))
                .expectStatus().isOk().returnResult(EVENTS);
        result.getResponseBody().filter(e -> e.event() != null).take(2).blockLast(Duration.ofSeconds(10));

        LoopTestServer.await(Duration.ofSeconds(3),
                () -> s.fake.clientWentAway() && s.only(Generation.Kind.PLAN).status() == Generation.Status.CANCELLED);
        assertThat(s.fake.clientWentAway()).isTrue();
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.CANCELLED);
    }

    /** R6: a plan that is not a valid draft ends in an error, never done, and is not retried here. */
    @Test
    void anInvalidPlanEndsInErrorAndIsNotRetried() {
        s.fake.chat = FakeMetaApi.sse(0, streamOf("this is not a plan", 2, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(last(events).event()).isEqualTo("error");
        assertThat(data(last(events)).path("code").asText()).isEqualTo("upstream");
        assertThat(names(events)).doesNotContain("done");
        assertThat(s.fake.chatRequests()).isEqualTo(1);
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.ERROR);
    }

    /** A plan that parses but leaves its schema (12 particles) is refused: a model's JSON is data, not truth. */
    @Test
    void aPlanOffItsSchemaEndsInError() throws Exception {
        ObjectNode draft = (ObjectNode) JSON.readTree(GALAXY);
        ((ObjectNode) draft.get("particles")).put("count", 12);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(draft.toString(), 4, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(last(events).event()).isEqualTo("error");
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.ERROR);
    }

    /** A plan whose controls are unsound (here, a reserved name) is refused too: the schema is not enough. */
    @Test
    void aPlanWithAReservedControlNameEndsInError() throws Exception {
        ObjectNode draft = (ObjectNode) JSON.readTree(GALAXY);
        ((ObjectNode) draft.withArray("uniforms").get(0)).put("name", "target");
        s.fake.chat = FakeMetaApi.sse(0, streamOf(draft.toString(), 4, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(last(events).event()).isEqualTo("error");
    }

    /** A truncated answer is unusable: an error, and a count, because its fix is the role's cap. */
    @Test
    void aLengthFinishIsAnErrorAndIsCounted() {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY.substring(0, 400), 2, LENGTH));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(data(last(events)).path("message").asText()).contains("ran out of room");
        assertThat(s.meters.get("wexy.loop.truncated").tag("role", "planner").counter().count()).isEqualTo(1.0);
    }

    /** R7: a plan that does not exist, is malformed, or is someone else's, is not found; nothing is called. */
    @Test
    void anUnknownMalformedOrForeignPlanIsNotFound() {
        String foreign = s.storedPlan("someone-else", GALAXY);
        for (String planId : List.of(Ulid.next(Instant.now()), "abc", foreign)) {
            s.post("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "evolve"))
                    .expectStatus().isNotFound().expectBody().json("{\"code\":\"not-found\"}");
        }
        assertThat(s.fake.chatRequests()).isZero();
    }

    /** R11: a body over the service's own limit is 413, not 500, and costs nothing. */
    @Test
    void anOversizeBodyIsTooLarge() {
        s.post("/v1/forge/plan", "uid-1", planBody("x".repeat(300_000)))
                .expectStatus().isEqualTo(413).expectBody().json("{\"code\":\"too-large\"}");
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.store.snapshot()).isEmpty();
    }

    /** R13: nothing reaches a handler without the gateway's token. */
    @Test
    void withoutTheGatewaysTokenEveryRouteIsAuth() {
        s.post("/v1/forge/plan", null, planBody("a spiral galaxy")).expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        s.post("/v1/forge/author", null, Map.of("planId", Ulid.next(Instant.now()), "fn", "evolve"))
                .expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        assertThat(s.fake.chatRequests()).isZero();
    }

    /** U6, P6: each cap at its boundary; over a cap is 413, a bad value 400, both before any charge. */
    @Test
    void theCapsHoldAtTheirBoundaries() {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 2, STOP));
        assertThat(last(s.stream("/v1/forge/plan", "uid-1", planBody("é".repeat(600)))).event()).isEqualTo("done");
        s.post("/v1/forge/plan", "uid-1", planBody("é".repeat(601))).expectStatus().isEqualTo(413).expectBody().json("{\"code\":\"too-large\"}");
        s.post("/v1/forge/plan", "uid-1", planBody("  ")).expectStatus().isBadRequest().expectBody().json("{\"code\":\"bad-request\"}");
        s.post("/v1/forge/plan", "uid-1", Map.of("prompt", "a reef", "style", "neon", "seconds", 12)).expectStatus().isBadRequest();
        s.post("/v1/forge/plan", "uid-1", Map.of("prompt", "a reef", "style", "auto", "seconds", 3)).expectStatus().isBadRequest();
        s.post("/v1/forge/plan", "uid-1", Map.of("prompt", "a reef", "style", "auto", "seconds", 31)).expectStatus().isBadRequest();
        s.post("/v1/forge/plan", "uid-1", Map.of("prompt", "a reef", "style", "auto")).expectStatus().isBadRequest();
        s.post("/v1/forge/author", "uid-1", Map.of("planId", s.storedPlan("uid-1", GALAXY), "fn", "arrange")).expectStatus().isBadRequest();
        assertThat(s.fake.chatRequests()).isEqualTo(1);
    }

    @Test
    void aBlackSkyHasNoSkyFunction() throws Exception {
        ObjectNode draft = (ObjectNode) JSON.readTree(GALAXY);
        draft.put("sky", "black");
        s.post("/v1/forge/author", "uid-1", Map.of("planId", s.storedPlan("uid-1", draft.toString()), "fn", "sky"))
                .expectStatus().isBadRequest().expectBody().json("{\"code\":\"bad-request\"}");
        assertThat(s.fake.chatRequests()).isZero();
    }

    /**
     * The mode, a public read with no token (records design §5.3): live until B4's archive. It is what the
     * frontend's drives check readiness with where the actuator is private (its pass-graph design, F8).
     */
    @Test
    void theModeIsLiveAndNeedsNoToken() {
        s.client.get().uri("/v1/forge/mode").exchange()
                .expectStatus().isOk()
                .expectBody(String.class).isEqualTo("{\"mode\":\"live\",\"reason\":null}");
        assertThat(s.fake.chatRequests()).isZero();
    }
}
