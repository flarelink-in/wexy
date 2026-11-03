package ai.wexy.platform.world;

import ai.wexy.common.Ulid;
import ai.wexy.platform.storage.ObjectStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * The work that outlives a request (W3.3; the creations platform design §7's step 5, I5, I8), every few seconds on the
 * storage scheduler: saves whose process died are failed and their objects queued for deletion (the reconciler); due
 * jobs are claimed under a lease with a fencing token; an object is erased from B2, and only then are its bytes given
 * back to its account; a deleted world is finished once its objects are gone; old operations and jobs are forgotten.
 * A job that fails is tried again with a growing pause, and one still failing after ten tries is logged as stuck. A
 * repeated delete, or a missing object, is success. Off in tests, which call {@link #tick} themselves.
 */
@Component
public class CleanupWorker implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(CleanupWorker.class);
    static final Duration LEASE = Duration.ofSeconds(60);
    static final int STUCK_AFTER = 10;

    private final JdbcWorldStore store;
    private final ObjectStore objects;
    private final WorldProperties properties;
    private final Scheduler storage;
    private final Clock clock;
    private volatile Disposable running;

    /** The service's: the system clock. Marked, since a second constructor (the tests', with their clock) leaves Spring a choice. */
    @Autowired
    public CleanupWorker(JdbcWorldStore store, ObjectStore objects, WorldProperties properties, @Qualifier("storage") Scheduler storage) {
        this(store, objects, properties, storage, Clock.systemUTC());
    }

    CleanupWorker(JdbcWorldStore store, ObjectStore objects, WorldProperties properties, Scheduler storage, Clock clock) {
        this.store = store;
        this.objects = objects;
        this.properties = properties;
        this.storage = storage;
        this.clock = clock;
    }

    /** What one look did, for its log line and the tests. */
    public record Tick(int failedStale, int claimed, int erased, int finished, int retried, int forgotten) {
    }

    /** One look: the reconciler, then the due jobs. Never throws: a database or B2 lost is tried at the next look. */
    public Tick tick() {
        Instant now = clock.instant();
        int stale = 0;
        int forgotten = 0;
        int claimed = 0;
        int erased = 0;
        int finished = 0;
        int retried = 0;
        try {
            stale = store.failStale(now);
            forgotten = store.forget(now);
            String token = Ulid.next(now);
            List<JdbcWorldStore.Job> jobs = store.claim(token, now, now.plus(LEASE), properties.cleanupBatch());
            claimed = jobs.size();
            for (JdbcWorldStore.Job job : jobs) {
                boolean ok = switch (job.kind()) {
                    case "OBJECT_DELETE" -> erase(job, token, now);
                    case "WORLD_FINISH" -> store.finishWorld(job, token, now);
                    default -> false;
                };
                if (ok) {
                    if (job.kind().equals("OBJECT_DELETE")) {
                        erased++;
                    } else {
                        finished++;
                    }
                } else {
                    retried++;
                    // A world waiting on its objects' deletion looks again soon; a failed delete backs off.
                    Duration pause = job.kind().equals("WORLD_FINISH") ? Duration.ofSeconds(30) : backoff(job.attempts());
                    store.retry(job, token, pause, now);
                    if (job.attempts() >= STUCK_AFTER) {
                        log.error("cleanup.stuck job={} kind={} attempts={}", job.id(), job.kind(), job.attempts());
                    }
                }
            }
        } catch (RuntimeException e) {
            log.warn("cleanup.tick failed kind={}: tried again at the next look", e.getClass().getSimpleName());
        }
        if (stale + claimed > 0) {
            log.info("cleanup.tick stale={} claimed={} erased={} finished={} retried={}", stale, claimed, erased, finished, retried);
        }
        return new Tick(stale, claimed, erased, finished, retried, forgotten);
    }

    /** The object erased from B2 (every version, or the one its bytes were written as), then charged back once. */
    private boolean erase(JdbcWorldStore.Job job, String token, Instant now) {
        Optional<JdbcWorldStore.StoredObject> found = store.object(job.targetId());
        if (found.isEmpty()) {
            store.closeJob(job, token, now);
            return true;
        }
        JdbcWorldStore.StoredObject object = found.get();
        if (!object.state().equals("DELETED")) {
            try {
                objects.delete(object.key(), object.versionId());
            } catch (ObjectStore.StorageUnavailable e) {
                return false;
            }
        }
        store.objectDeleted(job, token, object, now);
        return true;
    }

    /** 30 s, doubling with each try, at most an hour. */
    static Duration backoff(int attempts) {
        long seconds = 30L << Math.min(Math.max(0, attempts - 1), 7);
        return Duration.ofSeconds(Math.min(seconds, 3600));
    }

    @Override
    public void start() {
        if (properties.cleanupEnabled() && running == null) {
            running = Flux.interval(properties.cleanupEvery(), storage)
                    .onBackpressureDrop()
                    .concatMap(i -> Mono.fromCallable(this::tick).subscribeOn(storage), 1)
                    .subscribe();
        }
    }

    @Override
    public void stop() {
        Disposable r = running;
        if (r != null) {
            r.dispose();
            running = null;
        }
    }

    @Override
    public boolean isRunning() {
        return running != null;
    }
}
