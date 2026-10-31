package ai.wexy.forge.loop;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.records.Generation;
import ai.wexy.forge.records.Outcome;
import ai.wexy.forge.records.Ulid;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static ai.wexy.forge.loop.LoopTestServer.EDIT;
import static ai.wexy.forge.loop.LoopTestServer.FUNCTION;
import static ai.wexy.forge.loop.LoopTestServer.GALAXY;
import static ai.wexy.forge.loop.LoopTestServer.JSON;
import static ai.wexy.forge.loop.LoopTestServer.LENGTH;
import static ai.wexy.forge.loop.LoopTestServer.STOP;
import static ai.wexy.forge.loop.LoopTestServer.data;
import static ai.wexy.forge.loop.LoopTestServer.diagnostic;
import static ai.wexy.forge.loop.LoopTestServer.first;
import static ai.wexy.forge.loop.LoopTestServer.last;
import static ai.wexy.forge.loop.LoopTestServer.names;
import static ai.wexy.forge.loop.LoopTestServer.repairBody;
import static ai.wexy.forge.loop.LoopTestServer.streamOf;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * B0.4's routes (forge-loop design §12: R8 to R10, with R2, R11, R13 and U6 extended to them):
 * {@code repair} with its depth and escalation, {@code direct} answering one JSON document, and
 * {@code outcomes} storing what a browser found.
 */
class RepairDirectOutcomesTest {

    private static final String MISMATCH = "type mismatch for argument 1 in call to 'hash11', expected 'f32', got 'u32'";

    private final LoopTestServer s = new LoopTestServer();

    @AfterEach
    void down() {
        s.close();
    }

    private static String text(List<ServerSentEvent<String>> events) {
        return events.stream().filter(e -> "delta".equals(e.event())).map(e -> data(e).path("text").asText()).collect(Collectors.joining());
    }

    private String author(String uid) {
        String planId = s.storedPlan(uid, GALAXY);
        return s.stored(Generation.Kind.AUTHOR, planId, "evolve", uid, FUNCTION, Generation.Status.OK);
    }

    private Map<String, Object> directBody(JsonNode spec, String turn) {
        Map<String, Object> body = new HashMap<>();
        body.put("spec", spec);
        body.put("turn", turn);
        return body;
    }

    private Map<String, Object> outcomeBody(List<String> ids) {
        Map<String, Object> body = new HashMap<>();
        body.put("generationIds", ids);
        body.put("ladder", Map.of("L0", Map.of("ok", true, "ms", 0.4), "L3", Map.of("ok", true, "ms", 2.1)));
        body.put("firstPassOk", true);
        body.put("repairs", 0);
        body.put("autofixes", 1);
        body.put("probeMs", 12.5);
        body.put("predictedMs", 8.0);
        body.put("fps", 60.0);
        body.put("adapter", "amd gcn-5");
        body.put("browser", "chrome 155");
        return body;
    }

    /** R8: repairer, repairer, then the escalator on Wonder; a fourth repair is refused, and nothing is called for it. */
    @Test
    void threeRepairsEscalateAndTheFourthIsRefused() throws Exception {
        String authorId = author("uid-1");
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 3, STOP));

        List<ServerSentEvent<String>> first = s.stream("/v1/forge/repair", "uid-1", repairBody(authorId, diagnostic(MISMATCH)));
        assertThat(names(first).get(0)).isEqualTo("meta");
        assertThat(last(first).event()).isEqualTo("done");
        assertThat(text(first)).isEqualTo(FUNCTION);
        JsonNode meta = first(first, "meta");
        assertThat(meta.path("role").asText()).isEqualTo("repairer");
        assertThat(meta.path("fn").asText()).isEqualTo("evolve");
        assertThat(meta.path("promptVersion").asText()).isEqualTo("repair.v1");
        assertThat(meta.path("model").asText()).isEqualTo("m-1");
        String firstId = meta.path("generationId").asText();

        List<ServerSentEvent<String>> second = s.stream("/v1/forge/repair", "uid-1", repairBody(firstId, diagnostic(MISMATCH)));
        assertThat(first(second, "meta").path("role").asText()).isEqualTo("repairer");
        String secondId = first(second, "meta").path("generationId").asText();

        List<ServerSentEvent<String>> third = s.stream("/v1/forge/repair", "uid-1", repairBody(secondId, diagnostic(MISMATCH)));
        assertThat(first(third, "meta").path("role").asText()).isEqualTo("escalator");
        assertThat(first(third, "meta").path("model").asText()).isEqualTo("m-2");
        String thirdId = first(third, "meta").path("generationId").asText();

        s.post("/v1/forge/repair", "uid-1", repairBody(thirdId, diagnostic(MISMATCH)))
                .expectStatus().isBadRequest().expectBody().json("{\"code\":\"bad-request\"}");

        // The models the fake saw: Spark, Spark, Wonder; the attempts counted up; the findings shown.
        assertThat(s.fake.chatRequests()).isEqualTo(3);
        assertThat(s.sent(0).path("model").asText()).isEqualTo("m-1");
        assertThat(s.sent(1).path("model").asText()).isEqualTo("m-1");
        assertThat(s.sent(2).path("model").asText()).isEqualTo("m-2");
        assertThat(s.sent(2).path("reasoning_effort").asText()).isEqualTo("high");
        for (int i = 0; i < 3; i++) {
            String user = s.sent(i).path("messages").get(1).path("content").asText();
            assertThat(user).contains("The function: evolve · Attempt " + (i + 1) + " of 3")
                    .contains("- [tint] line 11, column 25: " + MISMATCH)
                    .contains("    let jitter = hash11(i) * 0.02;")
                    .contains(FUNCTION)
                    .contains("struct Params {");
        }
        List<Generation> repairs = s.all(Generation.Kind.REPAIR);
        assertThat(repairs).hasSize(3).allMatch(g -> g.status() == Generation.Status.OK).allMatch(g -> "evolve".equals(g.fn()));
        assertThat(repairs.get(0).parentId()).isEqualTo(authorId);
        assertThat(repairs.get(1).parentId()).isEqualTo(firstId);
        assertThat(repairs.get(2).parentId()).isEqualTo(secondId);
        assertThat(repairs.get(2).role()).isEqualTo("escalator");
        assertThat(JSON.readTree(repairs.get(0).input()).path("diagnostics").get(0).path("message").asText()).isEqualTo(MISMATCH);
        LoopTestServer.await(Duration.ofSeconds(3), () -> s.ledger.totalForProvider("meta-wonder") == repairs.get(2).costMicroUsd());
        assertThat(s.ledger.totalForProvider("meta-wonder")).isEqualTo(repairs.get(2).costMicroUsd()).isPositive();
        assertThat(repairs.get(2).chargedMicroUsd()).isGreaterThan(repairs.get(2).costMicroUsd());
    }

    /** A failed repair does not count: the studio may repair the same function again, at the same attempt. */
    @Test
    void aFailedRepairDoesNotCountTowardsEscalation() {
        String authorId = author("uid-1");
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 3, STOP));
        String firstId = first(s.stream("/v1/forge/repair", "uid-1", repairBody(authorId, diagnostic(MISMATCH))), "meta")
                .path("generationId").asText();

        s.fake.chat = FakeMetaApi.sse(0, LoopTestServer.chunk("fn ev"), "{\"type\":\"error\",\"code\":\"server_error\",\"message\":\"overloaded\"}");
        List<ServerSentEvent<String>> failed = s.stream("/v1/forge/repair", "uid-1", repairBody(firstId, diagnostic(MISMATCH)));
        assertThat(last(failed).event()).isEqualTo("error");
        String failedId = first(failed, "meta").path("generationId").asText();

        // The failed repair cannot be repaired (it has no usable function), and repairing its parent is still attempt 2.
        s.post("/v1/forge/repair", "uid-1", repairBody(failedId, diagnostic(MISMATCH))).expectStatus().isNotFound();
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 3, STOP));
        List<ServerSentEvent<String>> again = s.stream("/v1/forge/repair", "uid-1", repairBody(firstId, diagnostic(MISMATCH)));
        assertThat(first(again, "meta").path("role").asText()).isEqualTo("repairer");
        assertThat(s.sent(2).path("messages").get(1).path("content").asText()).contains("Attempt 2 of 3");
    }

    /** The function the model fenced is unfenced before it is shown to the repairer. */
    @Test
    void aFencedFunctionIsUnfencedForTheRepairer() {
        String planId = s.storedPlan("uid-1", GALAXY);
        String authorId = s.stored(Generation.Kind.AUTHOR, planId, "look", "uid-1", "```wgsl\n" + FUNCTION + "\n```\n", Generation.Status.OK);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 3, STOP));

        s.stream("/v1/forge/repair", "uid-1", repairBody(authorId, diagnostic(MISMATCH)));

        String user = s.sent(0).path("messages").get(1).path("content").asText();
        assertThat(user).contains("```wgsl\n" + FUNCTION + "\n```").doesNotContain("```wgsl\n```wgsl");
        assertThat(user).contains("The function: look ");
    }

    /** R7 for repairs: a stranger's, an unknown, a failed or a plan generation is not found; nothing is called. */
    @Test
    void aRepairOfAStrangersUnknownFailedOrPlanGenerationIsNotFound() {
        String foreign = author("someone-else");
        String planId = s.storedPlan("uid-1", GALAXY);
        String failed = s.stored(Generation.Kind.AUTHOR, planId, "evolve", "uid-1", "fn ev", Generation.Status.ERROR);
        for (String id : List.of(foreign, Ulid.next(Instant.now()), failed, planId, "abc")) {
            s.post("/v1/forge/repair", "uid-1", repairBody(id, diagnostic(MISMATCH)))
                    .expectStatus().isNotFound().expectBody().json("{\"code\":\"not-found\"}");
        }
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.all(Generation.Kind.REPAIR)).isEmpty();
    }

    /** U6 for repairs: 20 diagnostics pass, 21 are 413; a long message or snippet is 413; a bad one is 400. */
    @Test
    void theRepairCapsHoldAtTheirBoundaries() {
        String authorId = author("uid-1");
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 3, STOP));
        List<Map<String, Object>> twenty = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            twenty.add(diagnostic("finding " + i));
        }
        assertThat(last(s.stream("/v1/forge/repair", "uid-1", Map.of("generationId", authorId, "diagnostics", twenty))).event()).isEqualTo("done");
        List<Map<String, Object>> twentyOne = new ArrayList<>(twenty);
        twentyOne.add(diagnostic("one too many"));
        s.post("/v1/forge/repair", "uid-1", Map.of("generationId", authorId, "diagnostics", twentyOne))
                .expectStatus().isEqualTo(413).expectBody().json("{\"code\":\"too-large\"}");
        s.post("/v1/forge/repair", "uid-1", repairBody(authorId, diagnostic("m".repeat(301)))).expectStatus().isEqualTo(413);
        s.post("/v1/forge/repair", "uid-1", repairBody(authorId, Map.of("source", "tint", "line", 1, "column", 1,
                "message", "x", "snippet", "s".repeat(201)))).expectStatus().isEqualTo(413);
        s.post("/v1/forge/repair", "uid-1", repairBody(authorId, Map.of("source", "vibes", "line", 1, "column", 1, "message", "x")))
                .expectStatus().isBadRequest().expectBody().json("{\"code\":\"bad-request\"}");
        s.post("/v1/forge/repair", "uid-1", repairBody(authorId, Map.of("source", "tint", "line", -1, "column", 1, "message", "x")))
                .expectStatus().isBadRequest();
        s.post("/v1/forge/repair", "uid-1", Map.of("generationId", authorId, "diagnostics", List.of())).expectStatus().isBadRequest();
        s.post("/v1/forge/repair", "uid-1", Map.of("generationId", authorId)).expectStatus().isBadRequest();
        assertThat(s.fake.chatRequests()).isEqualTo(1);
    }

    /** R9: the director's edit, validated, comes back as one JSON document with the call's meta and usage. */
    @Test
    void aDirectCallAnswersTheValidatedEditPlanAsJson() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(EDIT, 3, STOP));

        byte[] body = s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "make it glow more"))
                .expectStatus().isOk()
                .expectHeader().contentTypeCompatibleWith("application/json")
                .expectHeader().valueEquals("Cache-Control", "no-store")
                .expectBody().returnResult().getResponseBody();
        JsonNode answer = JSON.readTree(body);

        Generation direct = s.only(Generation.Kind.DIRECT);
        assertThat(answer.path("generationId").asText()).isEqualTo(direct.id());
        assertThat(answer.path("model").asText()).isEqualTo("m-1");
        assertThat(answer.path("source").asText()).isEqualTo("live");
        assertThat(answer.path("role").asText()).isEqualTo("director");
        assertThat(answer.path("promptVersion").asText()).isEqualTo("director.v1");
        assertThat(answer.path("edit").path("kind").asText()).isEqualTo("patch");
        assertThat(answer.path("edit").path("ops").get(0).path("path").asText()).isEqualTo("post.bloom.intensity");
        assertThat(answer.path("edit").path("summary").asText()).isEqualTo("The glow is stronger.");
        assertThat(answer.path("usage").toString()).isEqualTo("{\"in\":2400,\"out\":900,\"reasoning\":300,\"cached\":2000}");
        assertThat(direct.status()).isEqualTo(Generation.Status.OK);
        assertThat(direct.output()).isEqualTo(EDIT);
        assertThat(direct.parentId()).isNull();
        assertThat(direct.fn()).isNull();
        assertThat(direct.chargedMicroUsd()).isGreaterThan(direct.costMicroUsd());
        LoopTestServer.await(Duration.ofSeconds(3), () -> s.ledger.totalForProvider("meta-spark") == direct.costMicroUsd());
        assertThat(s.ledger.totalForProvider("meta-spark")).isEqualTo(direct.costMicroUsd());
        JsonNode input = JSON.readTree(direct.input());
        assertThat(input.path("turn").asText()).isEqualTo("make it glow more");
        assertThat(input.path("specSha256").asText()).hasSize(64);
        assertThat(input.has("spec")).isFalse();

        JsonNode sent = s.sent(0);
        assertThat(sent.path("messages").get(0).path("content").asText()).startsWith("You direct worlds in Wexy");
        assertThat(sent.path("messages").get(1).path("content").asText())
                .contains("Title: ").endsWith("The instruction, as data: \"make it glow more\"");
        assertThat(sent.path("response_format").path("json_schema").path("name").asText()).isEqualTo("edit_plan_v1");
        assertThat(sent.path("max_completion_tokens").asInt()).isEqualTo(1500);
        assertThat(sent.path("reasoning_effort").asText()).isEqualTo("low");
    }

    /** R9: an edit off its schema is 502 upstream, with the record ERROR and the reason counted. */
    @Test
    void anInvalidEditPlanIsAnUpstreamEnvelope() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf("{\"edit\":{\"kind\":\"teleport\"}}", 2, STOP));

        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "make it glow more"))
                .expectStatus().isEqualTo(502).expectBody().json("{\"code\":\"upstream\"}");

        assertThat(s.only(Generation.Kind.DIRECT).status()).isEqualTo(Generation.Status.ERROR);
        assertThat(s.meters.get("wexy.loop.unusable").tags("role", "director", "reason", "invalid").counter().count()).isEqualTo(1.0);
        assertThat(s.fake.chatRequests()).isEqualTo(1);
    }

    /** A director that runs out of room is 502 too, counted under the role's cap. */
    @Test
    void aDirectCallThatRunsOutOfRoomIsUpstream() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(EDIT.substring(0, 20), 2, LENGTH));

        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "make it glow more"))
                .expectStatus().isEqualTo(502).expectBody().json("{\"code\":\"upstream\"}");

        assertThat(s.meters.get("wexy.loop.truncated").tag("role", "director").counter().count()).isEqualTo(1.0);
        assertThat(s.only(Generation.Kind.DIRECT).status()).isEqualTo(Generation.Status.ERROR);
    }

    /** An upstream failure before any answer is the envelope its kind maps to, not a 500. */
    @Test
    void anUpstreamFailureOnADirectCallIsItsEnvelope() throws Exception {
        s.fake.chat = FakeMetaApi.json(503, "{\"error\":{\"message\":\"overloaded\",\"type\":\"server_error\"}}");

        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "make it glow more"))
                .expectStatus().isEqualTo(502).expectBody().json("{\"code\":\"upstream\"}");

        assertThat(s.only(Generation.Kind.DIRECT).status()).isEqualTo(Generation.Status.ERROR);
    }

    /** U6 and R11 for direct: a 65 KB spec and a 300 KB body are 413; a bad turn or spec is 400; nothing is called. */
    @Test
    void theDirectCapsHoldAtTheirBoundaries() throws Exception {
        ObjectNode big = (ObjectNode) JSON.readTree(GALAXY);
        big.put("summary", "x".repeat(66_000));
        s.post("/v1/forge/direct", "uid-1", directBody(big, "brighter"))
                .expectStatus().isEqualTo(413).expectBody().json("{\"code\":\"too-large\"}");
        ObjectNode huge = (ObjectNode) JSON.readTree(GALAXY);
        huge.put("summary", "x".repeat(300_000));
        s.post("/v1/forge/direct", "uid-1", directBody(huge, "brighter")).expectStatus().isEqualTo(413);
        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "b".repeat(401))).expectStatus().isEqualTo(413);
        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "  ")).expectStatus().isBadRequest();
        s.post("/v1/forge/direct", "uid-1", Map.of("spec", "not an object", "turn", "brighter")).expectStatus().isBadRequest();
        s.post("/v1/forge/direct", "uid-1", Map.of("turn", "brighter")).expectStatus().isBadRequest();
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.store.snapshot()).isEmpty();
    }

    /** R10: a report about the caller's own generations is accepted and stored with the caller's uid. */
    @Test
    void anOutcomeIsStoredWithTheCallersUid() {
        String planId = s.storedPlan("uid-1", GALAXY);
        String authorId = s.stored(Generation.Kind.AUTHOR, planId, "evolve", "uid-1", FUNCTION, Generation.Status.OK);

        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(List.of(planId, authorId)))
                .expectStatus().isAccepted().expectBody().json("{}");

        assertThat(s.outcomes.snapshot()).hasSize(1);
        Outcome outcome = s.outcomes.forGeneration(authorId).get(0);
        assertThat(outcome.uid()).isEqualTo("uid-1");
        assertThat(outcome.generationIds()).containsExactly(planId, authorId);
        assertThat(outcome.firstPassOk()).isTrue();
        assertThat(outcome.repairs()).isZero();
        assertThat(outcome.autofixes()).isEqualTo(1);
        assertThat(outcome.fps()).isEqualTo(60.0);
        assertThat(outcome.adapter()).isEqualTo("amd gcn-5");
        assertThat(outcome.ladder()).contains("\"L3\"");
        assertThat(s.outcomes.forGeneration(planId)).hasSize(1);
        assertThat(s.fake.chatRequests()).isZero();
    }

    /** A report naming a stranger's or an unknown generation is not found, and nothing is stored. */
    @Test
    void anOutcomeForAStrangersGenerationIsNotFoundAndNothingIsStored() {
        String own = s.storedPlan("uid-1", GALAXY);
        String foreign = s.storedPlan("someone-else", GALAXY);
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(List.of(own, foreign))).expectStatus().isNotFound();
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(List.of(Ulid.next(Instant.now())))).expectStatus().isNotFound();
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(List.of("abc"))).expectStatus().isNotFound();
        assertThat(s.outcomes.snapshot()).isEmpty();
    }

    /** U6 for outcomes: 16 ids pass, 17 are 413; a big ladder or a long label is 413; a missing or absurd value is 400. */
    @Test
    void theOutcomeCapsHoldAtTheirBoundaries() {
        List<String> sixteen = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            sixteen.add(s.storedPlan("uid-1", GALAXY));
        }
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(sixteen)).expectStatus().isAccepted();
        List<String> seventeen = new ArrayList<>(sixteen);
        seventeen.add(s.storedPlan("uid-1", GALAXY));
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(seventeen)).expectStatus().isEqualTo(413);

        String planId = sixteen.get(0);
        Map<String, Object> bigLadder = outcomeBody(List.of(planId));
        bigLadder.put("ladder", Map.of("notes", "x".repeat(4_100)));
        s.post("/v1/forge/outcomes", "uid-1", bigLadder).expectStatus().isEqualTo(413);
        Map<String, Object> longLabel = outcomeBody(List.of(planId));
        longLabel.put("adapter", "a".repeat(65));
        s.post("/v1/forge/outcomes", "uid-1", longLabel).expectStatus().isEqualTo(413);
        Map<String, Object> noLadder = outcomeBody(List.of(planId));
        noLadder.remove("ladder");
        s.post("/v1/forge/outcomes", "uid-1", noLadder).expectStatus().isBadRequest();
        Map<String, Object> absurd = outcomeBody(List.of(planId));
        absurd.put("repairs", 300);
        s.post("/v1/forge/outcomes", "uid-1", absurd).expectStatus().isBadRequest();
        Map<String, Object> negative = outcomeBody(List.of(planId));
        negative.put("fps", -1.0);
        s.post("/v1/forge/outcomes", "uid-1", negative).expectStatus().isBadRequest();
        s.post("/v1/forge/outcomes", "uid-1", outcomeBody(List.of())).expectStatus().isBadRequest();
        assertThat(s.outcomes.snapshot()).hasSize(1);
    }

    /** R2, P1 for repair and direct: a cap reached is a budget envelope, zero requests upstream, a DENIED record. */
    @Test
    void aReachedCapDeniesRepairAndDirectBeforeAnyUpstreamByte() throws Exception {
        s.restart(10L, 0);
        String authorId = author("uid-1");
        s.post("/v1/forge/repair", "uid-1", repairBody(authorId, diagnostic(MISMATCH)))
                .expectStatus().isEqualTo(503).expectBody().json("{\"code\":\"budget\"}");
        s.post("/v1/forge/direct", "uid-1", directBody(JSON.readTree(GALAXY), "brighter"))
                .expectStatus().isEqualTo(503).expectBody().json("{\"code\":\"budget\"}");

        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.only(Generation.Kind.REPAIR).status()).isEqualTo(Generation.Status.DENIED);
        assertThat(s.only(Generation.Kind.DIRECT).status()).isEqualTo(Generation.Status.DENIED);
        assertThat(s.only(Generation.Kind.DIRECT).chargedMicroUsd()).isZero();
    }

    /** R13: the new routes need the gateway's token too. */
    @Test
    void withoutTheGatewaysTokenTheNewRoutesAreAuth() throws Exception {
        s.post("/v1/forge/repair", null, repairBody(Ulid.next(Instant.now()), diagnostic(MISMATCH)))
                .expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        s.post("/v1/forge/direct", null, directBody(JSON.readTree(GALAXY), "brighter"))
                .expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        s.post("/v1/forge/outcomes", null, outcomeBody(List.of(Ulid.next(Instant.now()))))
                .expectStatus().isUnauthorized().expectBody().json("{\"code\":\"auth\"}");
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.outcomes.snapshot()).isEmpty();
    }
}
