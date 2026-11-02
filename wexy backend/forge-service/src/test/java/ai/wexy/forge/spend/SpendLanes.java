package ai.wexy.forge.spend;

import java.util.Map;

/** The lanes a test's SpendGuard runs with (W1): every one is required, so every test names them. */
public final class SpendLanes {

    /** A ceiling no test reaches unless it means to. */
    public static final long WIDE = 1_000_000_000_000L;

    private SpendLanes() {
    }

    /** Every lane at {@link #WIDE}: for the tests that are about something else, so a lane never decides them. */
    public static Map<String, SpendProperties.Lane> open() {
        return of(WIDE, WIDE, WIDE);
    }

    /** Each lane's daily ceiling, in micro-USD. */
    public static Map<String, SpendProperties.Lane> of(long anonymous, long earlyAccess, long admin) {
        return Map.of(SpendGuard.LANE_ANONYMOUS, new SpendProperties.Lane(anonymous),
                SpendGuard.LANE_EARLY_ACCESS, new SpendProperties.Lane(earlyAccess),
                SpendGuard.LANE_ADMIN, new SpendProperties.Lane(admin));
    }
}
