package ai.wexy.forge.records;

import ai.wexy.forge.loop.LoopProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * B0's outcome store: in memory, bounded and forgetful like {@link InMemoryGenerationStore}, with
 * the same limits ({@code wexy.loop.store.*}). A restart forgets every report, which is the honest
 * outcome until B1's rows.
 */
@Component
public class InMemoryOutcomeStore implements OutcomeStore {

    private final int maxEntries;
    private final Duration ttl;
    private final Clock clock;
    private final Map<String, Outcome> byId = new LinkedHashMap<>();

    @Autowired
    public InMemoryOutcomeStore(LoopProperties loop) {
        this(loop.store().maxEntries(), loop.store().ttl(), Clock.systemUTC());
    }

    public InMemoryOutcomeStore(int maxEntries, Duration ttl, Clock clock) {
        this.maxEntries = maxEntries;
        this.ttl = ttl;
        this.clock = clock;
    }

    @Override
    public synchronized void record(Outcome outcome) {
        sweep();
        while (byId.size() >= maxEntries) {
            Iterator<String> oldest = byId.keySet().iterator();
            oldest.next();
            oldest.remove();
        }
        byId.put(outcome.id(), outcome);
    }

    @Override
    public synchronized List<Outcome> forGeneration(String generationId) {
        List<Outcome> found = new ArrayList<>();
        for (Outcome outcome : byId.values()) {
            if (!expired(outcome) && outcome.generationIds().contains(generationId)) {
                found.add(outcome);
            }
        }
        return found;
    }

    /** Every report held, oldest first: for tests and diagnostics, never for a client. */
    public synchronized List<Outcome> snapshot() {
        return List.copyOf(byId.values());
    }

    private boolean expired(Outcome outcome) {
        return outcome.createdAt().plus(ttl).isBefore(clock.instant());
    }

    private void sweep() {
        Iterator<Outcome> it = byId.values().iterator();
        while (it.hasNext() && expired(it.next())) {
            it.remove();
        }
    }
}
