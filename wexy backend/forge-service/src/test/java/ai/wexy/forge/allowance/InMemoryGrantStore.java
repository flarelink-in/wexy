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
    private int follows;
    private int unfollows;

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

    @Override
    public synchronized Follow probeFollow(String grantKey, String owner, long limit, String prompt) {
        check();
        Follow why = followable(grantKey, owner, limit);
        if (why != null) {
            return why;
        }
        return prompt.equals(live(grantKey).hash().get("prompt")) ? Follow.SAME : Follow.CHANGED;
    }

    @Override
    public synchronized Joined follow(String grantKey, String owner, long limit, String prompt, String newIndexKey, String grantId, String turnId) {
        check();
        Follow why = followable(grantKey, owner, limit);
        if (why != null) {
            return Joined.not(why);
        }
        Entry e = live(grantKey);
        Map<String, String> h = e.hash();
        if (h.get("prompt") == null) {
            return Joined.not(Follow.NONE);
        }
        String ended = h.get("end");
        String calls = h.get("endCalls");
        h.put("followups", Long.toString(Long.parseLong(h.getOrDefault("followups", "0")) + 1));
        h.put("following", turnId);
        h.put("followDispatched", "0");
        h.put("prevPrompt", h.get("prompt"));
        h.put("prevEnd", ended);
        if (calls != null) {
            h.put("prevEndCalls", calls);
        }
        h.put("prompt", prompt);
        h.remove("end");
        h.remove("endCalls");
        data.put(newIndexKey, new Entry(grantId, null, e.expires()));
        follows++;
        return new Joined(Follow.JOINED, ended, RedisGrantStore.calls(calls));
    }

    /** The probe's and the join's checks, in the scripts' order: null when a follow-up may run. */
    private Follow followable(String grantKey, String owner, long limit) {
        Entry e = live(grantKey);
        if (e == null || !owner.equals(e.hash().get("owner"))) {
            return Follow.NONE;
        }
        if (Long.parseLong(e.hash().getOrDefault("followups", "0")) >= limit) {
            return Follow.FULL;
        }
        String end = e.hash().get("end");
        if (end == null) {
            return Follow.OPEN;
        }
        return FOLLOWABLE.contains(end) ? null : Follow.WORLD;
    }

    @Override
    public synchronized void followDispatched(String grantKey, String turnId) {
        check();
        Entry e = live(grantKey);
        if (e != null && turnId.equals(e.hash().get("following"))) {
            e.hash().put("followDispatched", "1");
        }
    }

    @Override
    public synchronized boolean unfollow(String grantKey, String indexKey, String turnId) {
        check();
        Entry e = live(grantKey);
        if (e == null || !turnId.equals(e.hash().get("following")) || "1".equals(e.hash().get("followDispatched"))) {
            return false;
        }
        Map<String, String> h = e.hash();
        if (h.get("prevPrompt") == null || h.get("prevEnd") == null) {
            return false;
        }
        h.put("followups", Long.toString(Math.max(0, Long.parseLong(h.getOrDefault("followups", "0")) - 1)));
        h.put("prompt", h.remove("prevPrompt"));
        h.put("end", h.remove("prevEnd"));
        String calls = h.remove("prevEndCalls");
        if (calls != null) {
            h.put("endCalls", calls);
        } else {
            h.remove("endCalls");
        }
        h.remove("following");
        h.remove("followDispatched");
        data.remove(indexKey);
        unfollows++;
        return true;
    }

    @Override
    public synchronized boolean ended(String grantKey, String turnId, String end, int calls) {
        check();
        Entry e = live(grantKey);
        if (e == null) {
            return false;
        }
        String following = e.hash().get("following");
        if (following != null ? !following.equals(turnId) : !turnId.equals(e.hash().get("entry"))) {
            return false;
        }
        e.hash().put("end", end);
        e.hash().put("endCalls", Integer.toString(Math.max(0, calls)));
        return true;
    }

    /**
     * Writes an end as a forge before the follow-up's count wrote it, without its calls (a grant alive across the deploy):
     * what a follow-up's meta must then say it does not know.
     */
    public synchronized void endedWithoutCalls(String grantId, String end) {
        Entry e = live("wexy:grant:" + grantId);
        if (e != null) {
            e.hash().put("end", end);
            e.hash().remove("endCalls");
        }
    }

    /** How many follow-ups joined, and how many were given back (Q120 (b)). */
    public synchronized int followed() {
        return follows;
    }

    public synchronized int unfollowed() {
        return unfollows;
    }

    /** A grant's record as stored, for the tests that check what it holds. */
    public synchronized Map<String, String> record(String grantId) {
        Entry e = live("wexy:grant:" + grantId);
        return e == null ? null : Map.copyOf(e.hash());
    }

    /** The grant id an index names, for the tests (`lookup` without the store's own failure). */
    public synchronized String grantOf(String turnId) {
        Entry e = live("wexy:grant:of:" + turnId);
        return e == null ? null : e.value();
    }
}
