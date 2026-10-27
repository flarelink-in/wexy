package ai.wexy.forge.records;

import java.util.List;

/**
 * Where the browsers' outcome reports are kept (forge-loop design §5.1). B0 keeps them in memory;
 * B1's JDBC store writes one row per generation named, and nothing in the loop changes.
 */
public interface OutcomeStore {

    void record(Outcome outcome);

    /** Every report that names a generation, oldest first. */
    List<Outcome> forGeneration(String generationId);
}
