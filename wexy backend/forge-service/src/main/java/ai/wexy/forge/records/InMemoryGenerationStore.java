package ai.wexy.forge.records;

import ai.wexy.forge.loop.LoopProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * B0's generation store: in memory, bounded, and forgetful on purpose (forge-loop design §5.3). At
 * most {@code wexy.loop.store.max-entries} generations (the oldest go first), each for
 * {@code wexy.loop.store.ttl}, swept as new ones arrive. A restart forgets every plan, so an author
 * call then answers {@code 404} and the studio plans again: the honest outcome until B1's rows.
 */
@Component
public class InMemoryGenerationStore implements GenerationStore {

    private final int maxEntries;
    private final Duration ttl;
    private final Clock clock;
    private final Map<String, Generation> byId = new LinkedHashMap<>();

    @Autowired
    public InMemoryGenerationStore(LoopProperties loop) {
        this(loop.store().maxEntries(), loop.store().ttl(), Clock.systemUTC());
    }

    public InMemoryGenerationStore(int maxEntries, Duration ttl, Clock clock) {
        this.maxEntries = maxEntries;
        this.ttl = ttl;
        this.clock = clock;
    }

    @Override
    public synchronized Generation begin(Generation started) {
        sweep();
        while (byId.size() >= maxEntries) {
            Iterator<String> oldest = byId.keySet().iterator();
            oldest.next();
            oldest.remove();
        }
        byId.put(started.id(), started);
        return started;
    }

    @Override
    public synchronized void finish(String id, Generation.Finish finish) {
        Generation current = byId.get(id);
        if (current != null && current.status() == Generation.Status.RUNNING) {
            byId.put(id, current.finished(finish));
        }
    }

    @Override
    public synchronized Optional<Generation> find(String id) {
        Generation g = byId.get(id);
        if (g == null || expired(g)) {
            return Optional.empty();
        }
        return Optional.of(g);
    }

    @Override
    public synchronized List<Generation> children(String parentId) {
        return byId.values().stream().filter(g -> parentId.equals(g.parentId()) && !expired(g)).toList();
    }

    @Override
    public synchronized int okRepairDepth(String id) {
        int depth = 0;
        Generation g = byId.get(id);
        for (int hops = 0; g != null && g.kind() == Generation.Kind.REPAIR && hops < maxEntries; hops++) {
            if (g.status() == Generation.Status.OK) {
                depth++;
            }
            g = g.parentId() == null ? null : byId.get(g.parentId());
        }
        return depth;
    }

    private boolean expired(Generation g) {
        return g.createdAt().plus(ttl).isBefore(clock.instant());
    }

    /** Insertion order is creation order, so expired entries are all at the front. */
    private void sweep() {
        Iterator<Generation> it = byId.values().iterator();
        while (it.hasNext() && expired(it.next())) {
            it.remove();
        }
    }

    /** Every generation held, oldest first: for tests and diagnostics, never for a client. */
    public synchronized List<Generation> snapshot() {
        return List.copyOf(byId.values());
    }
}
