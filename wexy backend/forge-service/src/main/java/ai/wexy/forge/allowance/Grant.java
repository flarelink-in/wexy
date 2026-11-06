package ai.wexy.forge.allowance;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One granted prompt, G (W1; the creations platform design §2, §11): the entry request it was granted for and the
 * counters it took. It is spent when its first model call is dispatched, and given back when none ever was (an
 * allowance or lane denial, budget, paused, a fault before the call, a cancel before the first word): each happens at
 * most once, and after either the other does nothing. A failure to tell the store is logged and never thrown: a grant
 * that could not be given back stays taken, the safe direction for money.
 *
 * <p>A follow-up (Q120 (b); the creations platform design §10, "Q120's follow-up") is held the same way: a turn that
 * joined the prompt of one that ended with no world. Spent at its first dispatched call; given back when it dispatched
 * none, so its prompt's follow-up, idea and end are as they were. Either kind writes its turn's end into the prompt
 * ({@link #ended}), which is what a later follow-up reads.
 */
public final class Grant {

    private static final Logger log = LoggerFactory.getLogger(Grant.class);
    private static final int OPEN = 0;
    private static final int SPENT = 1;
    private static final int RELEASED = 2;

    private final String id;
    private final Role role;
    private final String recordKey;
    private final String indexKey;
    private final List<String> counters;
    private final GrantStore store;
    /** The turn (or plan) this grant runs: the entry it was granted for, or the follow-up that joined it. */
    private final String turnId;
    private final boolean followUp;
    private final AtomicInteger state = new AtomicInteger(OPEN);

    Grant(String id, Role role, String recordKey, String indexKey, List<String> counters, GrantStore store, String turnId) {
        this(id, role, recordKey, indexKey, counters, store, turnId, false);
    }

    private Grant(String id, Role role, String recordKey, String indexKey, List<String> counters, GrantStore store, String turnId,
                  boolean followUp) {
        this.id = id;
        this.role = role;
        this.recordKey = recordKey;
        this.indexKey = indexKey;
        this.counters = List.copyOf(counters);
        this.store = store;
        this.turnId = turnId;
        this.followUp = followUp;
    }

    /** The follow-up `turnId`, joined to the grant `id` and indexed at `indexKey` (Q120 (b)). */
    static Grant followUp(String id, Role role, String recordKey, String indexKey, String turnId, GrantStore store) {
        return new Grant(id, role, recordKey, indexKey, List.of(), store, turnId, true);
    }

    public String id() {
        return id;
    }

    public Role role() {
        return role;
    }

    /** It is a follow-up's (Q120 (b)), not an entry's own grant. */
    public boolean followUp() {
        return followUp;
    }

    /** Its first model call was dispatched: the prompt is spent. Blocking (Redis): call off the event loop. */
    public void spent() {
        if (!state.compareAndSet(OPEN, SPENT)) {
            return;
        }
        try {
            if (followUp) {
                store.followDispatched(recordKey, turnId);
            } else {
                store.dispatched(recordKey);
            }
        } catch (RuntimeException e) {
            log.warn("grant {} spent, but the store could not be told; it stays taken", id, e);
        }
    }

    /** No model call was dispatched for it: the prompt is given back. Blocking (Redis): call off the event loop. */
    public void release() {
        if (!state.compareAndSet(OPEN, RELEASED)) {
            return;
        }
        try {
            boolean given = followUp ? store.unfollow(recordKey, indexKey, turnId) : store.release(recordKey, indexKey, counters);
            if (!given) {
                log.warn("grant {} could not be given back (spent, gone or changed); it stays taken", id);
            } else {
                log.info("allowance.released grant={} role={}{}", id, role.lane(), followUp ? " follow-up" : "");
            }
        } catch (RuntimeException e) {
            log.warn("grant {} could not be given back: the store did not answer; it stays taken", id, e);
        }
    }

    /**
     * Writes how its turn ended into the prompt (Q120 (b)), before the turn's last event: one of {@code handed-off},
     * {@code asked}, {@code declined}, {@code exhausted}, {@code failed}, {@code cancelled}. A failure is logged, never
     * thrown: an end not written lets no follow-up run, the safe direction. Blocking (Redis): call off the event loop.
     */
    public void ended(String end) {
        try {
            if (!store.ended(recordKey, turnId, end)) {
                log.info("grant {}: the end {} of {} was not written (the grant is gone, or another turn's)", id, end, turnId);
            }
        } catch (RuntimeException e) {
            log.warn("grant {}: the end {} could not be written; no follow-up of it can run", id, end, e);
        }
    }
}
