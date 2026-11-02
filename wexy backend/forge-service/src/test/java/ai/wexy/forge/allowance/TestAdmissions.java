package ai.wexy.forge.allowance;

import ai.wexy.forge.safety.RecordedContentSafety;

import java.time.Clock;
import java.time.Duration;

/** Admissions for the tests (W1): the real PromptGrants and PromptAdmission over the in-memory store and the recorded safety. */
public final class TestAdmissions {

    /** A uid key for tests, not a secret. */
    public static final String UID_KEY = "7465737474657374746573747465737474657374746573747465737474657374";
    /** The network key the tests' tokens and callers carry. */
    public static final String NETWORK = "test-network";

    /** An admission, with the grants it counts with and the store they keep, for the routes and the assertions. */
    public record Admit(PromptAdmission admission, PromptGrants grants, InMemoryGrantStore store) {
    }

    private TestAdmissions() {
    }

    /**
     * W1's numbers: one anonymous prompt per account and network, one a day signed in, twenty for an admin; three
     * revisions, five Director turns, 44 module calls.
     */
    public static AllowanceProperties strict() {
        return new AllowanceProperties(1, 1, 1, 20, 0, Duration.ofHours(2), 5, 3, 44, Duration.ofDays(400), UID_KEY, false);
    }

    /** Room for the tests about something else: every allowance at a thousand, so none of them decides a test. */
    public static AllowanceProperties wide() {
        return wide(1000);
    }

    /** As {@link #wide()}, with `moduleCalls` module calls a prompt. */
    public static AllowanceProperties wide(int moduleCalls) {
        return new AllowanceProperties(1000, 1000, 1000, 1000, 0, Duration.ofHours(2), 1000, 1000, moduleCalls, Duration.ofDays(400),
                UID_KEY, false);
    }

    /** An admission under `properties`, over a new in-memory store on `clock`, with the recorded content safety. */
    public static Admit admit(AllowanceProperties properties, Clock clock) {
        InMemoryGrantStore store = new InMemoryGrantStore(clock);
        PromptGrants grants = new PromptGrants(store, properties, clock);
        return new Admit(new PromptAdmission(grants, new RecordedContentSafety()), grants, store);
    }

    /** One that grants every test that is not about the allowances. */
    public static Admit open() {
        return admit(wide(), Clock.systemUTC());
    }
}
