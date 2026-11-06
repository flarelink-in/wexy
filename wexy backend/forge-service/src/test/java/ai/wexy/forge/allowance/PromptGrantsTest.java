package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The allowances' rules (W1; the creations platform design §11; PL-T1, PL-T12, PL-T13, PL-T14, PL-T19) over the
 * in-memory store, which keeps the scripts' decisions; RedisGrantStoreTest runs the scripts themselves.
 */
class PromptGrantsTest {

    /** 2026-11-02 18:30 UTC: the day's reset (00:00 UTC) is 5.5 hours away. */
    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-02T18:30:00Z"));
    private final InMemoryGrantStore store = new InMemoryGrantStore(clock);
    private final PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), clock);

    private static Caller anonymous(String uid, String network) {
        return new Caller(uid, true, false, "anonymous", network);
    }

    private static Caller signedIn(String uid) {
        return new Caller(uid, false, false, "google.com", "net-a");
    }

    private static Caller admin(String uid) {
        return new Caller(uid, false, true, "google.com", "net-a");
    }

    private static void refused(Runnable run, ErrorCode code) {
        assertThatThrownBy(run::run).isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(code));
    }

    /** PL-T1: an anonymous account's one prompt, ever; its second is account-required, which sign-in answers. */
    @Test
    void anAnonymousAccountGetsOnePromptEverThenSignInIsTheWayOn() {
        grants.grant(anonymous("u1", "net-a"), "plan-1", "h").spent();

        refused(() -> grants.grant(anonymous("u1", "net-b"), "plan-2", "h"), ErrorCode.ACCOUNT_REQUIRED);
        clock.advanceDays(30);
        refused(() -> grants.grant(anonymous("u1", "net-c"), "plan-3", "h"), ErrorCode.ACCOUNT_REQUIRED);
        // The same uid, linked to Google: early access, counted apart.
        grants.grant(signedIn("u1"), "plan-4", "h");
    }

    /** Q98 as recommended: one anonymous prompt per network a day; another account on it must sign in; tomorrow it opens. */
    @Test
    void aNetworkGetsOneAnonymousPromptADay() {
        grants.grant(anonymous("u1", "net-a"), "plan-1", "h");

        refused(() -> grants.grant(anonymous("u2", "net-a"), "plan-2", "h"), ErrorCode.ACCOUNT_REQUIRED);
        grants.grant(anonymous("u3", "net-b"), "plan-3", "h");
        clock.advanceHours(6);
        grants.grant(anonymous("u4", "net-a"), "plan-4", "h");
    }

    /**
     * Q98, revised (the user, 2026-11-04): a shared IPv4 address gets three anonymous prompts a day, an IPv6 /64 one, and
     * a key that names no family (a gateway from before) the stricter one; each is refused past it as the network's.
     */
    @Test
    void anIpv4AddressGetsThreeAnonymousPromptsADayAnIpv6Slash64One() {
        String v4 = "v4." + "a".repeat(64);
        String v6 = "v6." + "b".repeat(64);
        grants.grant(anonymous("u1", v4), "plan-1", "h");
        grants.grant(anonymous("u2", v4), "plan-2", "h");
        grants.grant(anonymous("u3", v4), "plan-3", "h");
        refused(() -> grants.grant(anonymous("u4", v4), "plan-4", "h"), ErrorCode.ACCOUNT_REQUIRED);
        assertThat(grants.peek(anonymous("u5", v4)).spentBy()).isEqualTo("network");
        // Said as the network's day, which an IPv4 address may have shared (the account-guards review): not "its world".
        assertThatThrownBy(() -> grants.grant(anonymous("u5", v4), "plan-5", "h")).isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.getMessage())
                .isEqualTo("This network has made today's free worlds. Sign in with Google for early access: one world a day."));

        grants.grant(anonymous("u6", v6), "plan-6", "h");
        refused(() -> grants.grant(anonymous("u7", v6), "plan-7", "h"), ErrorCode.ACCOUNT_REQUIRED);

        // Tomorrow each opens again.
        clock.advanceHours(6);
        grants.grant(anonymous("u8", v4), "plan-8", "h");
        grants.grant(anonymous("u9", v6), "plan-9", "h");
    }

    /** No network key (the gateway could not resolve the address, or has no key): no anonymous prompt. */
    @Test
    void anAnonymousCallerWithoutANetworkGetsNoPrompt() {
        refused(() -> grants.grant(anonymous("u1", null), "plan-1", "h"), ErrorCode.ACCOUNT_REQUIRED);
        assertThat(grants.peek(anonymous("u1", null)).left()).isZero();
        assertThat(store.granted()).isZero();
    }

    /** PL-T12: early access's second world of the day is quota, with the time to the reset; tomorrow it opens. */
    @Test
    void earlyAccessGetsOneADayAndItsRefusalSaysWhenTheNextOpens() {
        grants.grant(signedIn("u1"), "plan-1", "h");

        assertThatThrownBy(() -> grants.grant(signedIn("u1"), "plan-2", "h")).isInstanceOfSatisfying(ForgeException.class, e -> {
            assertThat(e.code()).isEqualTo(ErrorCode.QUOTA);
            assertThat(e.retryAfterSeconds()).isEqualTo(5 * 3600 + 30 * 60);
        });
        assertThat(grants.peek(signedIn("u1"))).isEqualTo(new PromptGrants.Peek(Role.EARLY_ACCESS, 0,
                Instant.parse("2026-11-03T00:00:00Z"), "day"));
        clock.advanceHours(6);
        grants.grant(signedIn("u1"), "plan-3", "h");
    }

    /** An admin gets its own number, and its refusal is quota too. */
    @Test
    void anAdminGetsItsOwnNumber() {
        for (int i = 0; i < 20; i++) {
            grants.grant(admin("a1"), "plan-" + i, "h");
        }
        refused(() -> grants.grant(admin("a1"), "plan-20", "h"), ErrorCode.QUOTA);
        assertThat(grants.peek(admin("a1")).role().label()).isEqualTo("Early access");
    }

    /** PL-T12: a prompt with no dispatched call goes back; a spent one does not; either happens once. */
    @Test
    void aPromptWithNoDispatchedCallIsGivenBack() {
        Grant refused = grants.grant(anonymous("u1", "net-a"), "plan-1", "h");
        refused.release();
        refused.release();
        assertThat(store.released()).isEqualTo(1);

        Grant spent = grants.grant(anonymous("u1", "net-a"), "plan-2", "h");
        spent.spent();
        spent.release();
        assertThat(store.released()).isEqualTo(1);
        refused(() -> grants.grant(anonymous("u1", "net-a"), "plan-3", "h"), ErrorCode.ACCOUNT_REQUIRED);
    }

    /** PL-T13: a revision naming its turn runs inside its prompt, twice; a third, another caller's, another prompt's or a forged id is an entry. */
    @Test
    void followUpsRunInsideTheirPromptWithinItsBudget() {
        Caller u1 = anonymous("u1", "net-a");
        grants.grant(u1, "turn-1", "prompt-hash").spent();

        // Each refused while the budget still has room, so it is refused for what it names, not for the budget.
        assertThat(grants.join(u1, "turn-1", PromptGrants.Kind.REVISION, "other-hash", null)).as("another prompt").isFalse();
        assertThat(grants.join(anonymous("u2", "net-a"), "turn-1", PromptGrants.Kind.REVISION, "prompt-hash", null)).as("another caller's").isFalse();
        assertThat(grants.join(anonymous("u2", "net-a"), "turn-1", PromptGrants.Kind.DIRECTOR, null, null)).as("another caller's Director").isFalse();
        assertThat(grants.join(u1, "unknown", PromptGrants.Kind.DIRECTOR, null, null)).as("a forged id").isFalse();
        assertThat(grants.join(u1, null, PromptGrants.Kind.REVISION, "prompt-hash", null)).as("none named").isFalse();

        // Three revisions, the candidate's Q_C since Q110, each naming the turn before it; a fourth is a new prompt.
        assertThat(grants.join(u1, "turn-1", PromptGrants.Kind.REVISION, "prompt-hash", "turn-2")).isTrue();
        assertThat(grants.join(u1, "turn-2", PromptGrants.Kind.REVISION, "prompt-hash", "turn-3")).as("naming the revision").isTrue();
        assertThat(grants.join(u1, "turn-3", PromptGrants.Kind.REVISION, "prompt-hash", "turn-4")).as("a third").isTrue();
        assertThat(grants.join(u1, "turn-4", PromptGrants.Kind.REVISION, "prompt-hash", "turn-5")).as("a fourth").isFalse();

        for (int i = 0; i < 5; i++) {
            assertThat(grants.join(u1, "turn-1", PromptGrants.Kind.DIRECTOR, null, null)).isTrue();
        }
        assertThat(grants.join(u1, "turn-1", PromptGrants.Kind.DIRECTOR, null, null)).as("a sixth Director turn").isFalse();
    }

    /**
     * A module call (the W1 review, 2026-11-02) runs inside its turn's prompt only when it carries that prompt's text, the
     * grant is the caller's and alive, and a module call is left; it is never an entry, so the store says why not.
     */
    @Test
    void aModuleCallRunsInsideItsTurnsPromptOrNowhere() {
        PromptGrants two = new PromptGrants(store, TestAdmissions.wide(2), clock);
        Caller u1 = anonymous("u1", "net-a");
        two.grant(u1, "turn-1", "prompt-hash").spent();

        // Each refused while the budget still has room, so it is refused for what it carries or names.
        assertThat(two.follow(u1, "turn-1", PromptGrants.Kind.MODULE, "other-hash", null)).as("another idea").isEqualTo(GrantStore.Join.NONE);
        assertThat(two.follow(anonymous("u2", "net-a"), "turn-1", PromptGrants.Kind.MODULE, "prompt-hash", null)).as("another caller's")
                .isEqualTo(GrantStore.Join.NONE);
        assertThat(two.follow(u1, "turn-9", PromptGrants.Kind.MODULE, "prompt-hash", null)).as("a turn with no prompt").isEqualTo(GrantStore.Join.NONE);

        assertThat(two.follow(u1, "turn-1", PromptGrants.Kind.MODULE, "prompt-hash", null)).isEqualTo(GrantStore.Join.JOINED);
        assertThat(two.follow(u1, "turn-1", PromptGrants.Kind.MODULE, "prompt-hash", null)).isEqualTo(GrantStore.Join.JOINED);
        assertThat(two.follow(u1, "turn-1", PromptGrants.Kind.MODULE, "prompt-hash", null)).as("a third of two").isEqualTo(GrantStore.Join.FULL);
        // Its own budget: a revision still joins, and its turn answers to the same, spent, module budget.
        assertThat(two.join(u1, "turn-1", PromptGrants.Kind.REVISION, "prompt-hash", "turn-2")).isTrue();
        assertThat(two.follow(u1, "turn-2", PromptGrants.Kind.MODULE, "prompt-hash", null)).as("the revision's turn").isEqualTo(GrantStore.Join.FULL);
        clock.advanceMinutes(121);
        assertThat(two.follow(u1, "turn-1", PromptGrants.Kind.MODULE, "prompt-hash", null)).as("past the prompt's life")
                .isEqualTo(GrantStore.Join.NONE);
    }

    /**
     * A plan's own follow-ups (the W1 bug hunt, 2026-11-02): its authors and its repairs each stop at their budget,
     * siblings included, so one prompt cannot drain a lane; one re-plan of the same idea runs inside it, and the
     * re-plan's id answers to the same prompt and the same spent budgets.
     */
    @Test
    void aPlansAuthorsRepairsAndReplanRunWithinItsBudgets() {
        Caller u1 = signedIn("u1");
        grants.grant(u1, "plan-1", "idea-hash").spent();

        for (int i = 0; i < 8; i++) {
            assertThat(grants.follow(u1, "plan-1", PromptGrants.Kind.AUTHOR, null, null)).isEqualTo(GrantStore.Join.JOINED);
        }
        assertThat(grants.follow(u1, "plan-1", PromptGrants.Kind.AUTHOR, null, null)).as("a ninth author").isEqualTo(GrantStore.Join.FULL);
        for (int i = 0; i < 8; i++) {
            assertThat(grants.follow(u1, "plan-1", PromptGrants.Kind.REPAIR, null, null)).isEqualTo(GrantStore.Join.JOINED);
        }
        assertThat(grants.follow(u1, "plan-1", PromptGrants.Kind.REPAIR, null, null)).as("a ninth repair").isEqualTo(GrantStore.Join.FULL);
        assertThat(grants.follow(anonymous("u2", "net-a"), "plan-1", PromptGrants.Kind.AUTHOR, null, null)).as("another caller's")
                .isEqualTo(GrantStore.Join.NONE);

        assertThat(grants.join(u1, "plan-1", PromptGrants.Kind.REPLAN, "other-hash", "plan-2")).as("a re-plan of another idea").isFalse();
        assertThat(grants.join(u1, "plan-1", PromptGrants.Kind.REPLAN, "idea-hash", "plan-2")).isTrue();
        assertThat(grants.join(u1, "plan-2", PromptGrants.Kind.REPLAN, "idea-hash", "plan-3")).as("a second re-plan").isFalse();
        assertThat(grants.follow(u1, "plan-2", PromptGrants.Kind.AUTHOR, null, null)).as("the re-plan's authors").isEqualTo(GrantStore.Join.FULL);
    }

    /** Retry-After is rounded up (the W1 review, 2026-11-02): waiting it never ends before the reset, nor does a time shown from it. */
    @Test
    void aQuotasRetryAfterNeverEndsBeforeTheReset() {
        clock.set(Instant.parse("2026-11-02T18:30:00.300Z"));
        grants.grant(signedIn("u1"), "plan-1", "h");
        assertThatThrownBy(() -> grants.grant(signedIn("u1"), "plan-2", "h")).isInstanceOfSatisfying(ForgeException.class, e -> {
            assertThat(e.retryAfterSeconds()).isEqualTo(5 * 3600 + 30 * 60);
            assertThat(clock.instant().plusSeconds(e.retryAfterSeconds())).isAfterOrEqualTo(Instant.parse("2026-11-03T00:00:00Z"));
        });
    }

    /** A prompt lives two hours: a follow-up after that is a new prompt. */
    @Test
    void anExpiredPromptIsNoneToJoin() {
        Caller u1 = signedIn("u1");
        grants.grant(u1, "plan-1", "h").spent();
        clock.advanceMinutes(121);
        assertThat(grants.join(u1, "plan-1", PromptGrants.Kind.DIRECTOR, null, null)).isFalse();
    }

    /** PL-T14: a store that cannot answer grants nothing and says unavailable: never a free prompt, never a zero. */
    @Test
    void aStoreThatCannotAnswerGrantsNothing() {
        store.down(true);
        refused(() -> grants.grant(anonymous("u1", "net-a"), "plan-1", "h"), ErrorCode.UNAVAILABLE);
        refused(() -> grants.peek(signedIn("u1")), ErrorCode.UNAVAILABLE);
        refused(() -> grants.join(signedIn("u1"), "plan-1", PromptGrants.Kind.DIRECTOR, null, null), ErrorCode.UNAVAILABLE);
        store.down(false);
        assertThat(store.granted()).isZero();
    }

    /** PL-T19: what is stored names no uid and no address; the peek is the caller's own. */
    @Test
    void theStoreHoldsKeysNeverUidsOrAddresses() {
        grants.grant(anonymous("firebase-uid-123", "net-a"), "plan-1", "h");
        assertThat(store.keys()).isNotEmpty().allSatisfy(key -> assertThat(key).doesNotContain("firebase-uid-123"));
        assertThat(String.join(" ", store.keys())).contains("wexy:allow:anon:", "wexy:allow:net:2026-11-02:net-a");
        assertThat(grants.peek(anonymous("someone-else", "net-b"))).isEqualTo(new PromptGrants.Peek(Role.ANONYMOUS, 1, null, null));
    }

    /** I11: concurrent entries from one anonymous account grant one prompt, and from one network one too. */
    @Test
    void concurrentEntriesGrantOnePrompt() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<Boolean>> tries = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                String uid = i % 2 == 0 ? "same-account" : "account-" + i;
                int n = i;
                tries.add(pool.submit(() -> {
                    go.await();
                    try {
                        grants.grant(anonymous(uid, "one-network"), "plan-" + n, "h");
                        return true;
                    } catch (ForgeException e) {
                        return false;
                    }
                }));
            }
            go.countDown();
            int granted = 0;
            for (Future<Boolean> t : tries) {
                granted += t.get() ? 1 : 0;
            }
            assertThat(granted).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    /** Startup stops without every allowance, and without a well-formed uid key. */
    @Test
    void anUnsetAllowanceOrABadKeyStopsStartup() {
        assertThatThrownBy(() -> new PromptGrants(store, new AllowanceProperties(null, 3, 1, 1, 20, 0, java.time.Duration.ofHours(2), 5, 2, 44, 8, 8, 1,
                java.time.Duration.ofDays(400), TestAdmissions.UID_KEY, false, 6, 1), clock))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("anonymous-per-account");
        assertThatThrownBy(() -> new PromptGrants(store, new AllowanceProperties(1, 3, 1, 1, 20, 0, java.time.Duration.ofHours(2), 5, 2, 44, 8, 8, 1,
                java.time.Duration.ofDays(400), "abc", false, 6, 1), clock))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("uid-hmac-hex");
        assertThatThrownBy(() -> new PromptGrants(store, new AllowanceProperties(1, 3, 1, 1, 20, 0, java.time.Duration.ofHours(2), 5, 2, 44, 8, 8, 1,
                java.time.Duration.ofDays(400), "", true, 6, 1), clock))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("WEXY_UID_HMAC_KEY");
        // A missing key where none is required counts no one: nothing is granted.
        PromptGrants keyless = new PromptGrants(store, new AllowanceProperties(1, 3, 1, 1, 20, 0, java.time.Duration.ofHours(2), 5, 2, 44, 8, 8, 1,
                java.time.Duration.ofDays(400), "", false, 6, 1), clock);
        refused(() -> keyless.grant(signedIn("u1"), "plan-1", "h"), ErrorCode.UNAVAILABLE);
    }

    /** The day starts at the configured hour, in UTC. */
    @Test
    void theDayStartsAtTheConfiguredHour() {
        PromptGrants six = new PromptGrants(store, new AllowanceProperties(1, 3, 1, 1, 20, 6, java.time.Duration.ofHours(2), 5, 2, 44, 8, 8, 1,
                java.time.Duration.ofDays(400), TestAdmissions.UID_KEY, false, 6, 1), clock);
        assertThat(six.nextReset()).isEqualTo(Instant.parse("2026-11-03T06:00:00Z"));
        clock.set(Instant.parse("2026-11-03T05:59:00Z"));
        assertThat(six.day()).hasToString("2026-11-02");
        clock.set(Instant.parse("2026-11-03T06:00:00Z"));
        assertThat(six.day()).hasToString("2026-11-03");
    }

    /** A clock a test moves. */
    static final class MutableClock extends Clock {

        private final AtomicReference<Instant> now;

        MutableClock(Instant start) {
            this.now = new AtomicReference<>(start);
        }

        void set(Instant at) {
            now.set(at);
        }

        void advanceDays(long days) {
            now.updateAndGet(t -> t.plusSeconds(days * 86_400));
        }

        void advanceHours(long hours) {
            now.updateAndGet(t -> t.plusSeconds(hours * 3600));
        }

        void advanceMinutes(long minutes) {
            now.updateAndGet(t -> t.plusSeconds(minutes * 60));
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now.get();
        }
    }
}
