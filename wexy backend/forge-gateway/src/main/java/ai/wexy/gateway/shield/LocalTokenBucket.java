package ai.wexy.gateway.shield;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * An in-JVM token bucket, used when Redis is unreachable.
 *
 * Copied from FlareLink's LocalTokenBucket (pre-existing work). Deliberately per instance and
 * approximate: a Redis outage degrades the gateway to "limit × instances" instead of removing rate
 * limiting at the moment an attack is most likely under way.
 */
public class LocalTokenBucket {

    /** The outcome of one check. {@code remainingTokens} is meaningful only when allowed. */
    public record Decision(boolean allowed, double remainingTokens) {
    }

    private record State(double tokens, long lastRefillMillis) {
    }

    private final ConcurrentHashMap<String, State> buckets = new ConcurrentHashMap<>();
    private final AtomicLong callsSinceSweep = new AtomicLong();

    private final double refillPerMilli;
    private final double capacity;
    private final long idleEvictMillis;
    private final int maxEntries;

    public LocalTokenBucket(double refillPerSecond, double capacity, int maxEntries) {
        this.refillPerMilli = refillPerSecond / 1000.0d;
        this.capacity = capacity;
        this.maxEntries = maxEntries;
        // Once a bucket has had time to refill completely, its state equals a fresh one, so it can
        // be evicted without loosening the limit.
        this.idleEvictMillis = refillPerSecond > 0
                ? (long) Math.ceil(capacity / refillPerSecond * 1000d) + 1000L
                : 60_000L;
    }

    public Decision tryConsume(String key, double cost) {
        maybeSweep();

        // compute() runs atomically for this key, so the holder is only written by the thread
        // about to read it.
        boolean[] allowed = new boolean[1];
        State updated = buckets.compute(key, (k, current) -> {
            long now = System.currentTimeMillis();
            double tokens = capacity;
            if (current != null) {
                long delta = Math.max(0L, now - current.lastRefillMillis());
                tokens = Math.min(capacity, current.tokens() + (delta * refillPerMilli));
            }
            if (tokens >= cost) {
                allowed[0] = true;
                return new State(tokens - cost, now);
            }
            allowed[0] = false;
            return new State(tokens, now);
        });

        return new Decision(allowed[0], updated.tokens());
    }

    private void maybeSweep() {
        if (callsSinceSweep.incrementAndGet() % 1000 != 0 && buckets.size() < maxEntries) {
            return;
        }
        long cutoff = System.currentTimeMillis() - idleEvictMillis;
        Iterator<Map.Entry<String, State>> it = buckets.entrySet().iterator();
        while (it.hasNext()) {
            if (it.next().getValue().lastRefillMillis() < cutoff) {
                it.remove();
            }
        }
        // A hard ceiling: a key-rotating flood must not grow this map without bound.
        if (buckets.size() > maxEntries) {
            buckets.clear();
        }
    }
}
