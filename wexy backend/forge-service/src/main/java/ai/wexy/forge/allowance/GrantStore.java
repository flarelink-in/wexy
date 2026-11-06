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

    /**
     * What a follow-up's step found (Q120 (b); the creations platform design §10, "Q120's follow-up"). The probe says
     * SAME or CHANGED when one may run (its idea's hash the grant's, or another); the join says JOINED. Why not: FULL, the
     * grant's follow-up is spent; OPEN, the turn it follows has no end written (still running, or never written); WORLD,
     * that turn ended with a world (`handed-off`, or an end no follow-up may follow); NONE, no live grant of the owner's.
     */
    enum Follow { JOINED, SAME, CHANGED, FULL, OPEN, WORLD, NONE }

    /**
     * What a follow-up's join found: JOINED with the turn it follows as that turn wrote its end, its end and the model
     * calls it dispatched (null when its end was written without them, by a forge before the follow-up's count), or why
     * not, with neither.
     */
    record Joined(Follow result, String end, Integer calls) {
        static Joined not(Follow why) {
            return new Joined(why, null, null);
        }
    }

    /** The ends a turn writes into its grant from which a follow-up may run: every end without a world. */
    java.util.Set<String> FOLLOWABLE = java.util.Set.of("asked", "declined", "exhausted", "failed", "cancelled");

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

    /**
     * Whether a follow-up may run inside a grant now (Q120 (b)), writing nothing: SAME or CHANGED (`prompt`, the follow-up's
     * idea's hash, is the grant's, or not) when the grant is `owner`'s, alive, its follow-ups under `limit`, and its `end`
     * written and one of {@link #FOLLOWABLE}; FULL, OPEN, WORLD or NONE otherwise, checked in that order after NONE.
     */
    Follow probeFollow(String grantKey, String owner, long limit, String prompt);

    /**
     * The follow-up `turnId` joins the grant, in one atomic step: the probe's checks again; then its follow-up counted,
     * the grant's prompt hash set to `prompt` and its end and that end's calls cleared (all kept, to give back), `turnId`
     * recorded as its follow-up, and the grant indexed under `newIndexKey` for its remaining life. JOINED with the end and
     * the calls it cleared, or why not with nothing written.
     */
    Joined follow(String grantKey, String owner, long limit, String prompt, String newIndexKey, String grantId, String turnId);

    /** The follow-up `turnId` dispatched its first call: it is spent, and stays counted. */
    void followDispatched(String grantKey, String turnId);

    /**
     * Gives back the follow-up `turnId` when it never dispatched a call: its count, and the grant's prompt hash, end and
     * that end's calls as they were before it; its index gone.
     *
     * @return true when given back; false when it was spent, gone, or not this follow-up's
     */
    boolean unfollow(String grantKey, String indexKey, String turnId);

    /**
     * Writes the end of the turn `turnId` into its grant (Q120 (b)), and the model calls it dispatched (the `call` events
     * its stream carried, seen or not): what a follow-up of it may be, and what that follow-up's meta says it followed.
     * Only the grant's own turn writes it, its entry or, once one joined, its follow-up; another's end, or a grant gone,
     * writes nothing.
     *
     * @return true when written
     */
    boolean ended(String grantKey, String turnId, String end, int calls);
}
