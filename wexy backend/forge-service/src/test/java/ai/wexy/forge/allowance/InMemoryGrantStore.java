package ai.wexy.forge.allowance;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The grant scripts' decisions, in memory (W1), as InMemorySpendLedger keeps SpendGuard's: hermetic allowance tests need
 * no Redis and keep the same rules (each step atomic, all or nothing, lifetimes honoured by the given clock).
 * RedisGrantStoreTest runs the real scripts.
 */
public final class InMemoryGrantStore implements GrantStore {

    private record Entry(String value, Map<String, String> hash, Instant expires) {
    }

    private final Map<String, Entry> data = new HashMap<>();
    private final AtomicBoolean down = new AtomicBoolean();
    private final Clock clock;
    private int grants;
    private int releases;

    public InMemoryGrantStore(Clock clock) {
        this.clock = clock;
    }

    public InMemoryGrantStore() {
        this(Clock.systemUTC());
    }

    /** Takes the store down, or brings it back: every step then throws, or works again. */
    public void down(boolean isDown) {
        down.set(isDown);
    }

    /** How many grants were written, and how many given back. */
    public synchronized int granted() {
        return grants;
    }

    public synchronized int released() {
        return releases;
    }

    /** A counter's value, 0 when absent or expired: what a test reads to see what was taken. */
    public synchronized long value(String key) {
        Entry e = live(key);
        return e == null || e.value() == null ? 0 : Long.parseLong(e.value());
    }

    /** Every live key, for the tests that check what the store holds (never a raw uid or address). */
    public synchronized List<String> keys() {
        return data.keySet().stream().filter(k -> live(k) != null).sorted().toList();
    }

    private void check() {
        if (down.get()) {
            throw new IllegalStateException("Redis command timed out");
        }
    }

    private Entry live(String key) {
        Entry e = data.get(key);
        if (e != null && e.expires() != null && !clock.instant().isBefore(e.expires())) {
            data.remove(key);
            return null;
        }
        return e;
    }

    @Override
    public synchronized List<Long> counts(List<String> counters) {
        check();
        List<Long> out = new ArrayList<>();
        for (String c : counters) {
            out.add(value(c));
        }
        return out;
    }

    @Override
    public synchronized int grant(List<String> counters, List<Long> limits, List<Long> lifetimesSeconds, String grantKey, String grantId,
                                  String indexKey, Map<String, String> record, long lifeSeconds) {
        check();
        for (int i = 0; i < counters.size(); i++) {
            if (value(counters.get(i)) >= limits.get(i)) {
                return i;
            }
        }
        for (int i = 0; i < counters.size(); i++) {
            Entry e = live(counters.get(i));
            long next = (e == null ? 0 : Long.parseLong(e.value())) + 1;
            Instant expires = e == null || e.expires() == null ? clock.instant().plusSeconds(lifetimesSeconds.get(i)) : e.expires();
            data.put(counters.get(i), new Entry(Long.toString(next), null, expires));
        }
        Instant end = clock.instant().plusSeconds(lifeSeconds);
        data.put(grantKey, new Entry(null, new HashMap<>(record), end));
        data.put(indexKey, new Entry(grantId, null, end));
        grants++;
        return -1;
    }

    @Override
    public synchronized String lookup(String indexKey) {
        check();
        Entry e = live(indexKey);
        return e == null ? null : e.value();
    }

    @Override
    public synchronized Join join(String grantKey, String owner, String field, long limit, String prompt, String newIndexKey, String grantId) {
        check();
        Entry e = live(grantKey);
        if (e == null || !owner.equals(e.hash().get("owner"))) {
            return Join.NONE;
        }
        if (prompt != null && !prompt.equals(e.hash().get("prompt"))) {
            return Join.NONE;
        }
        long used = Long.parseLong(e.hash().getOrDefault(field, "0"));
        if (used >= limit) {
            return Join.FULL;
        }
        e.hash().put(field, Long.toString(used + 1));
        if (newIndexKey != null) {
            data.put(newIndexKey, new Entry(grantId, null, e.expires()));
        }
        return Join.JOINED;
    }

    @Override
    public synchronized Join probe(String grantKey, String owner, String field, long limit, String prompt) {
        check();
        Entry e = live(grantKey);
        if (e == null || !owner.equals(e.hash().get("owner"))) {
            return Join.NONE;
        }
        if (prompt != null && !prompt.equals(e.hash().get("prompt"))) {
            return Join.NONE;
        }
        return Long.parseLong(e.hash().getOrDefault(field, "0")) >= limit ? Join.FULL : Join.JOINED;
    }

    @Override
    public synchronized void dispatched(String grantKey) {
        check();
        Entry e = live(grantKey);
        if (e != null) {
            e.hash().put("dispatched", "1");
        }
    }

    @Override
    public synchronized boolean release(String grantKey, String indexKey, List<String> counters) {
        check();
        Entry e = live(grantKey);
        if (e == null || "1".equals(e.hash().get("dispatched")) || !String.join(" ", counters).equals(e.hash().get("counters"))) {
            return false;
        }
        for (String c : counters) {
            long next = value(c) - 1;
            if (next <= 0) {
                data.remove(c);
            } else {
                data.put(c, new Entry(Long.toString(next), null, data.get(c).expires()));
            }
        }
        data.remove(grantKey);
        data.remove(indexKey);
        releases++;
        return true;
    }

    /** A grant's record as stored, for the tests that check what it holds. */
    public synchronized Map<String, String> record(String grantId) {
        Entry e = live("wexy:grant:" + grantId);
        return e == null ? null : Map.copyOf(e.hash());
    }
}
