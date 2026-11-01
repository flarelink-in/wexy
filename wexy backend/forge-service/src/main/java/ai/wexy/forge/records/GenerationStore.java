package ai.wexy.forge.records;

import java.util.List;
import java.util.Optional;

/**
 * Where generations are kept (forge-loop design §5.3). B0 keeps them in memory; B1's
 * {@code JdbcGenerationStore} writes the same columns to MariaDB, and nothing in the loop changes.
 */
public interface GenerationStore {

    /** Records a call before it is charged, with status RUNNING. */
    Generation begin(Generation started);

    /** Records how a call ended. Only the first finish of a generation counts. */
    void finish(String id, Generation.Finish finish);

    Optional<Generation> find(String id);

    /**
     * Every generation recorded under a parent, oldest first: an agent turn's calls, and the module calls made on it
     * (EA4.2), so a module call can be held to its turn's owner. An expired parent's children are gone with it.
     */
    List<Generation> children(String parentId);

    /**
     * How many successful repairs lie between a generation and its author root: 0 for an author
     * generation, and a failed repair in the chain does not count (the escalation rule, §5.1).
     */
    int okRepairDepth(String id);
}
