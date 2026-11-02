package ai.wexy.forge.loop;

import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.allowance.TestAdmissions;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;

import java.time.Clock;
import java.util.List;
import java.util.Map;

import static ai.wexy.forge.loop.LoopTestServer.FUNCTION;
import static ai.wexy.forge.loop.LoopTestServer.GALAXY;
import static ai.wexy.forge.loop.LoopTestServer.EDIT;
import static ai.wexy.forge.loop.LoopTestServer.JSON;
import static ai.wexy.forge.loop.LoopTestServer.STOP;
import static ai.wexy.forge.loop.LoopTestServer.planBody;
import static ai.wexy.forge.loop.LoopTestServer.streamOf;
import static ai.wexy.forge.loop.LoopTestServer.token;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The allowances on the loop's routes (W1; the creations platform design §11; PL-T1, PL-T12, PL-T13, PL-T14, PL-T18's
 * order, PL-T19): a plan is an entry request, admitted before any record or charge, with W1's numbers; its authors and
 * a Director turn that names it run inside it; a refusal sends nothing upstream.
 */
class AllowanceRoutesTest {

    private final LoopTestServer s = new LoopTestServer();

    @BeforeEach
    void strict() {
        s.admit = TestAdmissions.admit(TestAdmissions.strict(), Clock.systemUTC());
        s.restart(1_000_000L, 0);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));
    }

    @AfterEach
    void down() {
        s.close();
    }

    private static String anonymous(String uid) {
        return token(uid, true, false, TestAdmissions.NETWORK);
    }

    private static String google(String uid) {
        return token(uid, false, false, TestAdmissions.NETWORK);
    }

    private String plannedBy(String token) {
        List<ServerSentEvent<String>> events = s.postAs("/v1/forge/plan", token, planBody("a spiral galaxy"))
                .expectStatus().isOk().returnResult(LoopTestServer.EVENTS).getResponseBody().collectList().block();
        return LoopTestServer.data(events.get(0)).path("generationId").asText();
    }

    private JsonNode refusal(String path, String token, Object body, int status) throws Exception {
        byte[] answer = s.postAs(path, token, body).expectStatus().isEqualTo(status).expectBody().returnResult().getResponseBody();
        return JSON.readTree(answer);
    }

    /** PL-T1: an anonymous caller's first world streams; its second is account-required, before any record or upstream request. */
    @Test
    void anAnonymousCallersSecondPlanIsAccountRequiredWithNothingSentUpstream() throws Exception {
        plannedBy(anonymous("u1"));
        int records = s.store.snapshot().size();

        JsonNode second = refusal("/v1/forge/plan", anonymous("u1"), planBody("another galaxy"), 403);
        assertThat(second.path("code").asText()).isEqualTo("account-required");
        assertThat(s.fake.chatRequests()).isEqualTo(1);
        assertThat(s.store.snapshot()).hasSize(records);
        // Another anonymous account on the same network: its first prompt is the network's second today.
        assertThat(refusal("/v1/forge/plan", anonymous("u2"), planBody("a galaxy"), 403).path("code").asText()).isEqualTo("account-required");
    }

    /** PL-T1, PL-T12: once linked (the same uid, a token that says Google), early access: one a day, then quota with its reset. */
    @Test
    void earlyAccessIsOneADayAndItsSecondIsQuotaWithRetryAfter() throws Exception {
        plannedBy(anonymous("u1"));
        plannedBy(google("u1"));

        var result = s.postAs("/v1/forge/plan", google("u1"), planBody("a third")).expectStatus().isEqualTo(429)
                .expectHeader().exists("Retry-After").expectBody().returnResult();
        assertThat(JSON.readTree(result.getResponseBody()).path("code").asText()).isEqualTo("quota");
        long wait = Long.parseLong(result.getResponseHeaders().getFirst("Retry-After"));
        assertThat(wait).isBetween(1L, 86_400L);
        assertThat(s.fake.chatRequests()).isEqualTo(2);
    }

    /** PL-T18's order: an unsafe idea is refused before any grant or upstream request, and spends nothing. */
    @Test
    void anUnsafeIdeaIsRefusedBeforeAnyGrantAndSpendsNothing() throws Exception {
        JsonNode refused = refusal("/v1/forge/plan", anonymous("u1"), planBody("a bloody massacre of villagers at dawn"), 422);
        assertThat(refused.path("code").asText()).isEqualTo("content-refused");
        assertThat(refused.path("message").asText()).doesNotContain("massacre");
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.admit.store().granted()).isZero();
        assertThat(s.store.snapshot()).isEmpty();
        // Nothing was spent: the caller's one world is still there.
        plannedBy(anonymous("u1"));
    }

    /** A spent allowance is refused before content safety is asked, so a refused caller costs no safety check. */
    @Test
    void aSpentAllowanceIsRefusedBeforeTheSafetyCheck() throws Exception {
        plannedBy(anonymous("u1"));
        assertThat(refusal("/v1/forge/plan", anonymous("u1"), planBody("a bloody massacre of villagers"), 403).path("code").asText())
                .isEqualTo("account-required");
    }

    /** PL-T14: a store that cannot answer grants nothing: 503 unavailable, nothing recorded, nothing sent upstream. */
    @Test
    void aStoreThatCannotAnswerIsUnavailable() throws Exception {
        s.admit.store().down(true);
        assertThat(refusal("/v1/forge/plan", anonymous("u1"), planBody("a galaxy"), 503).path("code").asText()).isEqualTo("unavailable");
        assertThat(s.fake.chatRequests()).isZero();
        assertThat(s.store.snapshot()).isEmpty();
    }

    /** PL-T12: a first call the meter refuses (a reached cap) gives the prompt back: the caller still has their world. */
    @Test
    void aRefusedFirstCallGivesThePromptBack() throws Exception {
        s.restart(10L, 0);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));
        assertThat(refusal("/v1/forge/plan", anonymous("u1"), planBody("a galaxy"), 503).path("code").asText()).isEqualTo("budget");
        LoopTestServer.await(java.time.Duration.ofSeconds(3), () -> s.admit.store().released() == 1);
        assertThat(s.admit.store().released()).isEqualTo(1);

        s.restart(1_000_000L, 0);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));
        plannedBy(anonymous("u1"));
    }

    /** PL-T13: a plan's authors run inside its prompt, with the allowance spent. */
    @Test
    void aPlansAuthorsRunInsideItsPrompt() {
        String planId = plannedBy(anonymous("u1"));
        s.fake.chat = FakeMetaApi.sse(0, streamOf(FUNCTION, 2, STOP));

        s.postAs("/v1/forge/author", anonymous("u1"), Map.of("planId", planId, "fn", "evolve")).expectStatus().isOk();
    }

    /** PL-T13: a Director turn naming its plan runs inside its prompt; naming none, it is an entry, refused with the allowance spent. */
    @Test
    void aDirectorTurnNamingItsPlanRunsInsideItsPrompt() throws Exception {
        String planId = plannedBy(anonymous("u1"));
        s.fake.chat = FakeMetaApi.sse(0, streamOf(EDIT, 3, STOP));
        JsonNode spec = JSON.readTree(GALAXY);

        s.postAs("/v1/forge/direct", anonymous("u1"), Map.of("spec", spec, "turn", "make it glow more", "planId", planId)).expectStatus().isOk();
        assertThat(refusal("/v1/forge/direct", anonymous("u1"), Map.of("spec", spec, "turn", "make it glow more"), 403)
                .path("code").asText()).isEqualTo("account-required");
        // Another caller's plan is none of this caller's: an entry too.
        assertThat(refusal("/v1/forge/direct", anonymous("u9"), Map.of("spec", spec, "turn", "brighter", "planId", planId), 403)
                .path("code").asText()).isEqualTo("account-required");
    }

    /** A Director turn's instruction is the creator's own words: checked even inside its plan's prompt. */
    @Test
    void aDirectorTurnIsCheckedInsideItsPromptToo() throws Exception {
        String planId = plannedBy(anonymous("u1"));
        JsonNode refused = refusal("/v1/forge/direct", anonymous("u1"),
                Map.of("spec", JSON.readTree(GALAXY), "turn", "add a bloody massacre of villagers", "planId", planId), 422);
        assertThat(refused.path("code").asText()).isEqualTo("content-refused");
        assertThat(s.fake.chatRequests()).isEqualTo(1);
    }

    /** PL-T19: the allowance is the caller's own, exactly {label, left, resetsAt}, never cached; unknown is 503, never a zero. */
    @Test
    void theAllowanceIsTheCallersOwn() throws Exception {
        JsonNode fresh = JSON.readTree(s.allowance(anonymous("u1")).expectStatus().isOk()
                .expectHeader().valueEquals("Cache-Control", "no-store").expectBody().returnResult().getResponseBody());
        assertThat(fresh.toString()).isEqualTo("{\"label\":\"Free\",\"left\":1,\"resetsAt\":null}");

        plannedBy(anonymous("u1"));
        assertThat(JSON.readTree(s.allowance(anonymous("u1")).expectBody().returnResult().getResponseBody()).path("left").asLong()).isZero();

        JsonNode early = JSON.readTree(s.allowance(google("u1")).expectStatus().isOk().expectBody().returnResult().getResponseBody());
        assertThat(early.path("label").asText()).isEqualTo("Early access");
        assertThat(early.path("left").asLong()).isEqualTo(1);
        assertThat(early.path("resetsAt").asText()).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z");
        assertThat(early.size()).isEqualTo(3);

        // An anonymous caller the gateway gave no network: nothing left, sign in.
        assertThat(JSON.readTree(s.allowance(token("u5", true, false, null)).expectBody().returnResult().getResponseBody())
                .path("left").asLong()).isZero();

        s.admit.store().down(true);
        s.allowance(anonymous("u1")).expectStatus().isEqualTo(503).expectBody().jsonPath("$.code").isEqualTo("unavailable");
    }

    /** The allowance is never a public read: without the gateway's token there is no caller, so no answer. */
    @Test
    void theAllowanceNeedsTheGatewaysToken() {
        s.client.get().uri("/v1/forge/allowance").exchange().expectStatus().isUnauthorized()
                .expectBody().jsonPath("$.code").isEqualTo("auth");
    }

    /** I13: a plan's own answer carries no allowance, role or usage: only the allowance route says what is left. */
    @Test
    void noOtherAnswerCarriesTheAllowance() {
        List<ServerSentEvent<String>> events = s.postAs("/v1/forge/plan", anonymous("u1"), planBody("a spiral galaxy"))
                .expectStatus().isOk().returnResult(LoopTestServer.EVENTS).getResponseBody().collectList().block();
        String all = events.stream().map(e -> String.valueOf(e.data())).reduce("", String::concat);
        assertThat(all).doesNotContain("\"left\"").doesNotContain("Early access").doesNotContain("\"label\"").doesNotContain("early");
    }
}
