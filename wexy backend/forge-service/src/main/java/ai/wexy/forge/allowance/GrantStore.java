package ai.wexy.forge.allowance;

import java.util.List;
import java.util.Map;

/**
 * Where prompt grants live (W1): the allowance counters, each grant's record and the index from a plan's or a turn's id
 * to its grant. Every step that checks and writes is one atomic step, so concurrent requests from one account or one
 * network grant at most what the counters allow (I11). {@link RedisGrantStore} is the real one; the tests' in-memory
 * store keeps the same decisions. Any method may throw when the store cannot answer: the caller then grants nothing.
 */
interface GrantStore {

    /** What a join found. */
    enum Join { JOINED, FULL, NONE }

    /** Each counter's value, 0 when absent, in order. */
    List<Long> counts(List<String> counters);

    /**
     * Checks every counter under its limit and, only if all are, adds one to each (giving a new one its lifetime), writes
     * the grant's record for its life and indexes it under `indexKey`.
     *
     * @return -1 when granted; otherwise the index of the first counter at its limit, with nothing written
     */
    int grant(List<String> counters, List<Long> limits, List<Long> lifetimesSeconds, String grantKey, String grantId, String indexKey,
              Map<String, String> record, long lifeSeconds);

    /** The grant id an index names, or null. */
    String lookup(String indexKey);

    /**
     * Adds one to a grant's `field` if the grant is `owner`'s, alive, under `limit`, and (when `prompt` is not null) its
     * prompt's hash is `prompt`; then, when `newIndexKey` is not null, indexes the grant under it too, for the grant's
     * remaining life.
     */
    Join join(String grantKey, String owner, String field, long limit, String prompt, String newIndexKey, String grantId);

    /**
     * What {@link #join} would answer now, writing nothing (the EA9.4 review): JOINED when the grant is `owner`'s, alive,
     * its `field` under `limit` and (when `prompt` is not null) its prompt's hash `prompt`; FULL and NONE as join's. A
     * check before costly work, never a reservation: the join itself may still answer otherwise after it.
     */
    Join probe(String grantKey, String owner, String field, long limit, String prompt);

    /** Marks a grant spent: its first model call was dispatched. */
    void dispatched(String grantKey);

    /**
     * Gives a grant back when it never dispatched a call: one off each of its counters and the record and its index gone.
     *
     * @return true when given back; false when it was spent, gone, or not the grant those counters belong to
     */
    boolean release(String grantKey, String indexKey, List<String> counters);
}
