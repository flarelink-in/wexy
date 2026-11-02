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
    private final AtomicInteger state = new AtomicInteger(OPEN);

    Grant(String id, Role role, String recordKey, String indexKey, List<String> counters, GrantStore store) {
        this.id = id;
        this.role = role;
        this.recordKey = recordKey;
        this.indexKey = indexKey;
        this.counters = List.copyOf(counters);
        this.store = store;
    }

    public String id() {
        return id;
    }

    public Role role() {
        return role;
    }

    /** Its first model call was dispatched: the prompt is spent. Blocking (Redis): call off the event loop. */
    public void spent() {
        if (!state.compareAndSet(OPEN, SPENT)) {
            return;
        }
        try {
            store.dispatched(recordKey);
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
            if (!store.release(recordKey, indexKey, counters)) {
                log.warn("grant {} could not be given back (spent, gone or changed); it stays taken", id);
            } else {
                log.info("allowance.released grant={} role={}", id, role.lane());
            }
        } catch (RuntimeException e) {
            log.warn("grant {} could not be given back: the store did not answer; it stays taken", id, e);
        }
    }
}
