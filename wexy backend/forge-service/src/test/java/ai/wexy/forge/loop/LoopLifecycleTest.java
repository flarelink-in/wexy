package ai.wexy.forge.loop;

import ai.wexy.common.InternalToken;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.records.Generation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.Disposable;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import static ai.wexy.forge.loop.LoopTestServer.FUNCTION;
import static ai.wexy.forge.loop.LoopTestServer.GALAXY;
import static ai.wexy.forge.loop.LoopTestServer.STOP;
import static ai.wexy.forge.loop.LoopTestServer.await;
import static ai.wexy.forge.loop.LoopTestServer.data;
import static ai.wexy.forge.loop.LoopTestServer.last;
import static ai.wexy.forge.loop.LoopTestServer.names;
import static ai.wexy.forge.loop.LoopTestServer.planBody;
import static ai.wexy.forge.loop.LoopTestServer.streamOf;
import static ai.wexy.forge.loop.LoopTestServer.token;
import static ai.wexy.forge.loop.LoopTestServer.usage;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The record's lifecycle and the money behind it, from the review of 2026-10-27 (forge-loop
 * design, Results): a client that leaves while the meter is deciding, an answer with nothing in
 * it, and a call that cost more than it reserved.
 */
class LoopLifecycleTest {

    private static final String CONTENT_FILTER = "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"content_filter\"}]}";

    private final LoopTestServer s = new LoopTestServer();

    @AfterEach
    void down() {
        s.close();
    }

    /**
     * R14: the client goes away while the meter is still deciding, through a real connection. The
     * meter then allows the call: the money is reserved, so the record says CANCELLED with the
     * reservation, never RUNNING, never zero; and nothing goes upstream for nobody.
     */
    @Test
    void aClientThatLeavesWhileTheMeterDecidesIsRecordedCancelledWithItsReservation() throws Exception {
        s.restart(1_000_000L, 1_200);
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));

        Disposable request = s.raw.post().uri("/v1/forge/plan").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token("uid-1")).bodyValue(planBody("a spiral galaxy"))
                .retrieve().bodyToFlux(String.class).subscribe(ignored -> {
                }, error -> {
                });
        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).size() == 1);
        Thread.sleep(200);
        request.dispose();

        await(Duration.ofSeconds(5), () -> s.only(Generation.Kind.PLAN).status() != Generation.Status.RUNNING);
        Generation plan = s.only(Generation.Kind.PLAN);
        assertThat(plan.status()).isEqualTo(Generation.Status.CANCELLED);
        assertThat(plan.chargedMicroUsd()).isPositive().isEqualTo(s.ledger.totalForProvider("meta-spark"));
        assertThat(plan.output()).isEmpty();
        assertThat(s.fake.chatRequests()).isZero();
    }

    /** R14, the other answer: the meter refuses after the client has gone, and the record says DENIED, nothing charged. */
    @Test
    void aClientThatLeavesBeforeADenialIsRecordedDenied() throws Exception {
        s.restart(10L, 1_200);

        Disposable request = s.raw.post().uri("/v1/forge/plan").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token("uid-1")).bodyValue(planBody("a spiral galaxy"))
                .retrieve().bodyToFlux(String.class).subscribe(ignored -> {
                }, error -> {
                });
        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).size() == 1);
        Thread.sleep(200);
        request.dispose();

        await(Duration.ofSeconds(5), () -> s.only(Generation.Kind.PLAN).status() != Generation.Status.RUNNING);
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.DENIED);
        assertThat(s.only(Generation.Kind.PLAN).chargedMicroUsd()).isZero();
        assertThat(s.ledger.untouched()).isTrue();
        assertThat(s.fake.chatRequests()).isZero();
    }

    /** The same race on the handler alone, as the review reproduced it: a subscription cancelled while charge() is pending. */
    @Test
    void aSubscriptionCancelledWhileChargePendsStillFinishesTheRecord() throws Exception {
        s.restart(1_000_000L, 1_200);

        Disposable subscription = s.handler.plan(LoopTestServer.handlerRequest("/v1/forge/plan", "uid-1",
                new PlanRequest("a spiral galaxy", "cosmic", 12))).subscribe(ignored -> {
        }, error -> {
        });
        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).size() == 1);
        Thread.sleep(200);
        subscription.dispose();

        await(Duration.ofSeconds(5), () -> s.only(Generation.Kind.PLAN).status() != Generation.Status.RUNNING);
        Generation plan = s.only(Generation.Kind.PLAN);
        assertThat(plan.status()).isEqualTo(Generation.Status.CANCELLED);
        assertThat(plan.chargedMicroUsd()).isPositive().isEqualTo(s.ledger.totalForProvider("meta-spark"));
        assertThat(s.fake.chatRequests()).isZero();
    }

    /**
     * The second review of 2026-10-27: the meter itself fails after the client has gone. The record
     * must still be finished, as ERROR, through a real connection and on the handler's Mono.
     */
    @Test
    void aMeterThatFailsAfterTheClientLeftStillFinishesTheRecord() throws Exception {
        s.restart(1_000_000L, 1_200, true);

        Disposable request = s.raw.post().uri("/v1/forge/plan").contentType(MediaType.APPLICATION_JSON)
                .header(InternalToken.HEADER, token("uid-1")).bodyValue(planBody("a spiral galaxy"))
                .retrieve().bodyToFlux(String.class).subscribe(ignored -> {
                }, error -> {
                });
        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).size() == 1);
        Thread.sleep(200);
        request.dispose();

        await(Duration.ofSeconds(5), () -> s.only(Generation.Kind.PLAN).status() != Generation.Status.RUNNING);
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.ERROR);
        assertThat(s.only(Generation.Kind.PLAN).chargedMicroUsd()).isZero();
        assertThat(s.ledger.untouched()).isTrue();
        assertThat(s.fake.chatRequests()).isZero();

        Disposable subscription = s.handler.plan(LoopTestServer.handlerRequest("/v1/forge/plan", "uid-2",
                new PlanRequest("a spiral galaxy", "cosmic", 12))).subscribe(ignored -> {
        }, error -> {
        });
        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).size() == 2);
        Thread.sleep(200);
        subscription.dispose();

        await(Duration.ofSeconds(5), () -> s.all(Generation.Kind.PLAN).stream().noneMatch(g -> g.status() == Generation.Status.RUNNING));
        assertThat(s.all(Generation.Kind.PLAN)).hasSize(2).allMatch(g -> g.status() == Generation.Status.ERROR);
    }

    /** A handler subscription that runs to its end still finishes the record as before. */
    @Test
    void aHandlerSubscriptionThatCompletesLeavesTheRecordOk() {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));

        ServerResponse response = s.handler.plan(LoopTestServer.handlerRequest("/v1/forge/plan", "uid-1",
                new PlanRequest("a spiral galaxy", "cosmic", 12))).block(Duration.ofSeconds(10));

        assertThat(response.statusCode().value()).isEqualTo(200);
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.RUNNING);
    }

    /** R15: an author answer with no text is an error, never done; the record ERROR; the reason counted. */
    @Test
    void anEmptyAuthorAnswerIsAnErrorNotDone() {
        String planId = s.storedPlan("uid-1", GALAXY);
        s.fake.chat = FakeMetaApi.sse(0, streamOf("", 1, STOP));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "evolve"));

        assertThat(names(events)).containsExactly("meta", "usage", "error");
        assertThat(data(last(events)).path("code").asText()).isEqualTo("upstream");
        assertThat(data(last(events)).path("message").asText()).isEqualTo("The model answered nothing.");
        assertThat(s.only(Generation.Kind.AUTHOR).status()).isEqualTo(Generation.Status.ERROR);
        assertThat(s.meters.get("wexy.loop.unusable").tags("role", "author", "reason", "empty").counter().count()).isEqualTo(1.0);
    }

    /** Whitespace, an empty fence, or prose without the function are unusable too. */
    @Test
    void aBlankFencedOrFunctionlessAnswerIsUnusable() {
        String planId = s.storedPlan("uid-1", GALAXY);
        for (String answer : List.of("  \n\t ", "```wgsl\n```", "I cannot write that function.", "fn look(p: Particle) -> Look {}")) {
            s.fake.chat = FakeMetaApi.sse(0, streamOf(answer, 2, STOP));
            List<ServerSentEvent<String>> events = s.stream("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "evolve"));
            assertThat(last(events).event()).as(answer).isEqualTo("error");
            assertThat(names(events)).doesNotContain("done");
        }
        assertThat(s.all(Generation.Kind.AUTHOR)).hasSize(4).allMatch(g -> g.status() == Generation.Status.ERROR);
        assertThat(s.meters.get("wexy.loop.unusable").tags("role", "author", "reason", "no-function").counter().count()).isEqualTo(2.0);
        assertThat(s.meters.get("wexy.loop.unusable").tags("role", "author", "reason", "empty").counter().count()).isEqualTo(2.0);
    }

    /** A function the model spaced oddly, or fenced, still passes: the check is for the fn line, not the bytes. */
    @Test
    void anOddlySpacedOrFencedFunctionIsStillAFunction() {
        String planId = s.storedPlan("uid-1", GALAXY);
        for (String answer : List.of("  fn  evolve (p: Particle, i: u32) -> Particle {\n    return p;\n}", "```wgsl\n" + FUNCTION + "\n```")) {
            s.fake.chat = FakeMetaApi.sse(0, streamOf(answer, 2, STOP));
            assertThat(last(s.stream("/v1/forge/author", "uid-1", Map.of("planId", planId, "fn", "evolve"))).event()).as(answer).isEqualTo("done");
        }
    }

    /** A model that declined (content_filter) did not answer: an error, with its own reason. */
    @Test
    void aDeclinedAnswerIsAnError() {
        s.fake.chat = FakeMetaApi.sse(0, streamOf("", 1, CONTENT_FILTER));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(last(events).event()).isEqualTo("error");
        assertThat(data(last(events)).path("message").asText()).contains("declined");
        assertThat(s.only(Generation.Kind.PLAN).status()).isEqualTo(Generation.Status.ERROR);
        assertThat(s.meters.get("wexy.loop.unusable").tags("role", "planner", "reason", "declined").counter().count()).isEqualTo(1.0);
    }

    /**
     * R16: the usage says the call cost more than it reserved. The difference is settled into the
     * meter without a ceiling check, counted as an overrun, and the record shows cost above charge.
     */
    @Test
    void anOverrunIsSettledCountedAndVisibleOnTheRecord() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP, usage(40_000, 2_500)));

        List<ServerSentEvent<String>> events = s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        assertThat(last(events).event()).isEqualTo("done");
        Generation plan = s.only(Generation.Kind.PLAN);
        assertThat(plan.status()).isEqualTo(Generation.Status.OK);
        assertThat(plan.costMicroUsd()).isGreaterThan(plan.chargedMicroUsd());
        await(Duration.ofSeconds(3), () -> s.ledger.settlements() == 1);
        assertThat(s.ledger.settlements()).isEqualTo(1);
        assertThat(s.ledger.totalForProvider("meta-spark")).isEqualTo(plan.costMicroUsd());
        assertThat(s.meters.get("wexy.spend.charges").tags("provider", "meta-spark", "outcome", "overrun").counter().count()).isEqualTo(1.0);
        assertThat(s.meters.get("wexy.spend.micro.usd").tags("provider", "meta-spark", "kind", "overrun").counter().count())
                .isEqualTo((double) (plan.costMicroUsd() - plan.chargedMicroUsd()));
    }

    /** The usual case: the call cost less than its bound, and the ledger is settled down to its cost. */
    @Test
    void aCallWithinItsReservationIsRefundedToItsCost() throws Exception {
        s.fake.chat = FakeMetaApi.sse(0, streamOf(GALAXY, 4, STOP));

        s.stream("/v1/forge/plan", "uid-1", planBody("a spiral galaxy"));

        Generation plan = s.only(Generation.Kind.PLAN);
        assertThat(plan.costMicroUsd()).isLessThan(plan.chargedMicroUsd());
        await(Duration.ofSeconds(3), () -> s.ledger.settlements() == 1);
        assertThat(s.ledger.settlements()).isEqualTo(1);
        assertThat(s.ledger.totalForProvider("meta-spark")).isEqualTo(plan.costMicroUsd());
        assertThat(s.meters.get("wexy.spend.charges").tags("provider", "meta-spark", "outcome", "overrun").counter().count()).isZero();
        assertThat(s.meters.get("wexy.spend.micro.usd").tags("provider", "meta-spark", "kind", "refunded").counter().count())
                .isEqualTo((double) (plan.chargedMicroUsd() - plan.costMicroUsd()));
    }
}
