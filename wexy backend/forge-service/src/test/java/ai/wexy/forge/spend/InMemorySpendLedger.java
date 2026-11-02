package ai.wexy.forge.spend;

import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The charge and adjust scripts' decisions, in memory, behind a mocked template: hermetic money
 * tests need no Redis and can never reach a model. Copied from FlareLink's SpendGuardTest
 * (pre-existing work). SpendGuardRedisTest runs the real scripts.
 */
public final class InMemorySpendLedger {

    private final Map<String, Long> totals = new HashMap<>();
    private final AtomicInteger reservations = new AtomicInteger();
    private final AtomicInteger settlements = new AtomicInteger();
    private final AtomicBoolean down = new AtomicBoolean();

    /** A template whose scripts answer from this ledger. */
    public StringRedisTemplate template() {
        return template(0);
    }

    /** As {@link #template()}, with every script answered after a pause: a slow meter, for the cancellation tests. */
    public StringRedisTemplate template(long delayMillis) {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        // Eight arguments since W1: the amount, the four ceilings, the two lifetimes, then the lane's ceiling.
        when(redis.execute(any(RedisScript.class), anyList(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> {
                    if (delayMillis > 0) {
                        Thread.sleep(delayMillis);
                    }
                    if (down.get()) {
                        throw new QueryTimeoutException("Redis command timed out");
                    }
                    return apply(invocation.getArgument(0) == SpendGuard.ADJUST,
                            invocation.getArgument(1),
                            invocation.getArgument(2), invocation.getArgument(3),
                            invocation.getArgument(4), invocation.getArgument(5),
                            invocation.getArgument(6), invocation.getArgument(9));
                });
        return redis;
    }

    /** A template whose every call fails, as with Redis down. */
    public static StringRedisTemplate failing() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(RedisScript.class), anyList(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new QueryTimeoutException("Redis command timed out"));
        return redis;
    }

    /** Takes this ledger's templates down, or brings them back: every script then fails, or works again. */
    public void down(boolean isDown) {
        down.set(isDown);
    }

    /** The charge script's decision, or the adjust script's signed, floored move; the lane's day is KEYS[5] (W1). */
    synchronized String apply(boolean adjust, List<String> keys, String amountRaw, String globalMonthCapRaw,
                              String providerMonthCapRaw, String globalDayCapRaw, String providerDayCapRaw, String laneDayCapRaw) {
        long amount = Long.parseLong(amountRaw);
        long globalMonthCap = Long.parseLong(globalMonthCapRaw);
        long providerMonthCap = Long.parseLong(providerMonthCapRaw);
        long globalDayCap = Long.parseLong(globalDayCapRaw);
        long providerDayCap = Long.parseLong(providerDayCapRaw);
        long laneDayCap = Long.parseLong(laneDayCapRaw);

        long globalMonth = value(keys.get(0));
        long providerMonth = value(keys.get(1));
        long globalDay = value(keys.get(2));
        long providerDay = value(keys.get(3));
        long laneDay = value(keys.get(4));

        if (adjust) {
            settlements.incrementAndGet();
        } else {
            reservations.incrementAndGet();
            String denial = denied("GLOBAL_MONTH", globalMonth, globalMonthCap, amount);
            if (denial == null) {
                denial = denied("PROVIDER_MONTH", providerMonth, providerMonthCap, amount);
            }
            if (denial == null) {
                denial = denied("GLOBAL_DAY", globalDay, globalDayCap, amount);
            }
            if (denial == null) {
                denial = denied("PROVIDER_DAY", providerDay, providerDayCap, amount);
            }
            if (denial == null) {
                denial = denied("LANE_DAY", laneDay, laneDayCap, amount);
            }
            if (denial != null) {
                return denial;
            }
        }

        globalMonth = move(keys.get(0), amount);
        providerMonth = move(keys.get(1), amount);
        globalDay = move(keys.get(2), amount);
        providerDay = move(keys.get(3), amount);
        laneDay = move(keys.get(4), amount);
        return "OK|" + providerMonth + "|" + providerMonthCap + "|" + providerDay + "|"
                + providerDayCap + "|" + globalMonth + "|" + globalMonthCap + "|" + globalDay + "|" + globalDayCap
                + "|" + laneDay + "|" + laneDayCap;
    }

    /** Today's total for one lane (W1). */
    public synchronized long totalForLane(String lane) {
        return totals.entrySet().stream()
                .filter(entry -> entry.getKey().contains(":d:") && entry.getKey().endsWith(":lane:" + lane))
                .mapToLong(Map.Entry::getValue)
                .sum();
    }

    private static String denied(String scope, long current, long cap, long cost) {
        return cap >= 0 && current + cost > cap ? "DENY|" + scope + "|" + current + "|" + cap : null;
    }

    private long value(String key) {
        return totals.getOrDefault(key, 0L);
    }

    private long move(String key, long amount) {
        long after = Math.max(0, value(key) + amount);
        totals.put(key, after);
        return after;
    }

    /** This month's total for one provider. */
    public synchronized long totalForProvider(String provider) {
        return totals.entrySet().stream()
                .filter(entry -> entry.getKey().contains(":m:") && entry.getKey().endsWith(":" + provider))
                .mapToLong(Map.Entry::getValue)
                .sum();
    }

    /** This month's total across providers. */
    public synchronized long globalTotal() {
        return totals.entrySet().stream()
                .filter(entry -> entry.getKey().contains(":m:") && entry.getKey().chars().filter(c -> c == ':').count() == 3)
                .mapToLong(Map.Entry::getValue)
                .sum();
    }

    /** How many times the charge script was asked. */
    public int reservations() {
        return reservations.get();
    }

    /** How many times the adjust script moved the windows. */
    public int settlements() {
        return settlements.get();
    }

    public synchronized boolean untouched() {
        return totals.isEmpty();
    }
}
