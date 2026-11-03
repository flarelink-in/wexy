package ai.wexy.platform.world;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.ErrorEnvelope;
import ai.wexy.common.Ulid;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.world.WorldViews.Head;
import ai.wexy.platform.world.WorldViews.Usage;
import ai.wexy.platform.world.WorldViews.World;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

/**
 * Saved worlds in MariaDB (W3; V2__worlds.sql; the creations platform design §7). A save is two short transactions with
 * B2's write between them, never one held across it:
 *
 * <ol>
 *   <li>{@link #begin}: the operation for (owner, route, key), inserted first so a race inserts once; the environment's
 *       usage row, then the account's, locked in that order; the caps; the reservation; the object's intent.</li>
 *   <li>{@link #commit}: the operation still running; the head's compare-and-set (a revision); the revision row; the old
 *       head queued for deletion (release 1 keeps the head alone: Q96); reserved bytes become used; the answer stored for
 *       a retry with the key.</li>
 * </ol>
 *
 * A write B2 failed ({@link #failWrite}), a conflict found at the commit, and a save whose process died (the reconciler,
 * {@link #failStale}) all queue their object's deletion and keep its reservation until B2 confirms it gone (I5): bytes
 * return to an account only on a confirmed delete ({@link #objectDeleted}). Locks are always taken in one order:
 * operation, then world, then objects, then usage. A deadlock's victim is tried again, as the accounts' store does.
 */
public class JdbcWorldStore {

    private static final Logger log = LoggerFactory.getLogger(JdbcWorldStore.class);

    /** The environment's usage row: 26 zeros, which no ULID is. */
    public static final String ENVIRONMENT = "00000000000000000000000000";
    static final String CREATE_ROUTE = "POST /v1/worlds";
    static final int DEADLOCK_ATTEMPTS = 4;

    public enum Kind { CREATE, REVISE }

    /** A save to begin: whose, which route and key, what it asks for, and the bytes it will hold. */
    public record Save(Kind kind, String ownerId, String route, String key, String requestHash, String worldId,
                       String baseRevisionId, long expectedVersion, int bytes, String sha256, Instant now) {
    }

    /** What beginning a save came to. */
    public sealed interface Begun permits Replay, Running, Started {
    }

    /** The key's request already has its answer: give it again. */
    public record Replay(int status, String json) implements Begun {
    }

    /** The key's request is still under way: its operation, to poll. */
    public record Running(String operationId) implements Begun {
    }

    /** Begun: the operation, and the ids and key the bytes go under. */
    public record Started(String operationId, String worldId, String revisionId, String objectId, String objectKey) implements Begun {
    }

    /** What committing a save came to: the world at its new head, or the reason it was not. */
    public sealed interface Committed permits Saved, Conflicted, Lost {
    }

    public record Saved(World world) implements Committed {
    }

    /** The head or the version moved while the bytes were written. */
    public record Conflicted() implements Committed {
    }

    /** The operation was failed meanwhile (the reconciler judged it dead): the bytes were queued for deletion. */
    public record Lost() implements Committed {
    }

    /** A job a worker holds under its lease. */
    public record Job(String id, String kind, String targetId, int attempts) {
    }

    /** An object as a cleanup job needs it. */
    public record StoredObject(String id, String ownerId, String key, String versionId, String state, String charge, long bytes) {
    }

    /** A retained revision's facts and where its bytes are. */
    public record RetainedRevision(String worldId, Head head, String objectKey, String versionId) {
    }

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final WorldProperties limits;

    public JdbcWorldStore(JdbcClient jdbc, PlatformTransactionManager transactions, WorldProperties limits) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactions);
        this.limits = limits;
    }

    // --- A save, in two transactions -------------------------------------------------------------------------------

    public Begun begin(Save s) {
        return inTransaction(() -> {
            LocalDateTime now = at(s.now());
            String operationId = Ulid.next(s.now());
            boolean retrying = false;
            try {
                jdbc.sql("""
                                INSERT INTO operation (id, owner_id, route, idempotency_key, request_hash, state, created_at, updated_at, expires_at)
                                VALUES (:id, :owner, :route, :key, :hash, 'PENDING', :now, :now, :expires)
                                """)
                        .param("id", operationId).param("owner", s.ownerId()).param("route", s.route()).param("key", s.key())
                        .param("hash", s.requestHash()).param("now", now).param("expires", at(s.now().plus(limits.operationLife())))
                        .update();
            } catch (DuplicateKeyException exists) {
                OperationRow op = jdbc.sql("""
                                SELECT id, request_hash, state, response_status, response_json FROM operation
                                 WHERE owner_id = :owner AND route = :route AND idempotency_key = :key FOR UPDATE
                                """)
                        .param("owner", s.ownerId()).param("route", s.route()).param("key", s.key())
                        .query(JdbcWorldStore::operation).single();
                if (!op.requestHash().equals(s.requestHash())) {
                    log.warn("idempotency.mismatch op={}", op.id());
                    throw new PlatformException(ErrorCode.CONFLICT, "This Idempotency-Key was used for another request.");
                }
                switch (op.state()) {
                    case "DONE" -> {
                        return new Replay(op.status(), op.json());
                    }
                    case "PENDING" -> {
                        return new Running(op.id());
                    }
                    default -> {
                        // FAILED before it committed (B2 or the database lost): the same request runs again, its
                        // earlier object already queued for deletion.
                        operationId = op.id();
                        retrying = true;
                    }
                }
            }
            lockUsage(s.ownerId());
            long pending = jdbc.sql("""
                            SELECT COUNT(*) FROM operation
                             WHERE owner_id = :owner AND state = 'PENDING' AND route LIKE 'POST %' AND id <> :id
                            """)
                    .param("owner", s.ownerId()).param("id", operationId).query(Long.class).single();
            if (pending >= limits.pendingSaves()) {
                throw new PlatformException(ErrorCode.RATE, "Two saves are under way already. Try again in a moment.");
            }
            String worldId;
            if (s.kind() == Kind.CREATE) {
                long worlds = activeWorlds(s.ownerId()) + jdbc.sql("""
                                SELECT COUNT(*) FROM operation
                                 WHERE owner_id = :owner AND state = 'PENDING' AND route = :route AND id <> :id
                                """)
                        .param("owner", s.ownerId()).param("route", CREATE_ROUTE).param("id", operationId).query(Long.class).single();
                if (worlds >= limits.maxWorlds()) {
                    log.info("storage.denied account={} worlds={}", s.ownerId(), worlds);
                    throw storageFull();
                }
                worldId = Ulid.next(s.now());
            } else {
                WorldRow world = worldRow(s.ownerId(), s.worldId(), false).orElseThrow(JdbcWorldStore::notFound);
                if (!world.head().equals(s.baseRevisionId()) || world.rowVersion() != s.expectedVersion()) {
                    log.info("save.conflict world={} base={} head={}", s.worldId(), s.baseRevisionId(), world.head());
                    throw stale();
                }
                worldId = s.worldId();
            }
            UsageRow account = usageRow(s.ownerId());
            UsageRow environment = usageRow(ENVIRONMENT);
            if (account.used() + account.reserved() + s.bytes() > limits.maxBytes()) {
                log.info("storage.denied account={} used={} reserved={}", s.ownerId(), account.used(), account.reserved());
                throw storageFull();
            }
            if (environment.used() + environment.reserved() + s.bytes() > limits.environmentBytes()) {
                log.warn("storage.denied scope=environment used={} reserved={}", environment.used(), environment.reserved());
                throw new PlatformException(ErrorCode.UNAVAILABLE, "Saving worlds is unavailable right now.");
            }
            for (String owner : List.of(ENVIRONMENT, s.ownerId())) {
                jdbc.sql("UPDATE storage_usage SET reserved_bytes = reserved_bytes + :b, reserved_objects = reserved_objects + 1 WHERE owner_id = :owner")
                        .param("b", s.bytes()).param("owner", owner).update();
            }
            String revisionId = Ulid.next(s.now());
            String objectId = Ulid.next(s.now());
            String key = "worlds/" + s.ownerId() + "/" + worldId + "/revisions/" + revisionId + "/" + objectId + ".json";
            jdbc.sql("""
                            INSERT INTO stored_object (id, owner_id, operation_id, bucket, kind, object_key, sha256, bytes, media_type,
                                                       state, charge, created_at, updated_at)
                            VALUES (:id, :owner, :op, 'PRIVATE', 'ARTIFACT', :key, :sha, :bytes, 'application/json', 'RESERVED', 'RESERVED', :now, :now)
                            """)
                    .param("id", objectId).param("owner", s.ownerId()).param("op", operationId).param("key", key)
                    .param("sha", s.sha256()).param("bytes", s.bytes()).param("now", now).update();
            if (retrying) {
                jdbc.sql("UPDATE operation SET state = 'PENDING', response_status = NULL, response_json = NULL, updated_at = :now WHERE id = :id")
                        .param("now", now).param("id", operationId).update();
            }
            return new Started(operationId, worldId, revisionId, objectId, key);
        });
    }

    /**
     * The save's second transaction, once B2 holds the bytes under `started`'s key at `versionId`. `title` names a new
     * world; a revision's base and version are `save`'s. The world's answer is stored on the operation as `json`.
     */
    public Committed commit(Save save, Started started, String title, WorldCheck.Facts facts, String versionId,
                            java.util.function.Function<World, String> json) {
        return inTransaction(() -> {
            LocalDateTime now = at(save.now());
            String state = jdbc.sql("SELECT state FROM operation WHERE id = :id FOR UPDATE")
                    .param("id", started.operationId()).query(String.class).optional().orElse("GONE");
            if (!state.equals("PENDING")) {
                queueDeletion(started.objectId(), save.now());
                return new Lost();
            }
            int marked = jdbc.sql("UPDATE stored_object SET version_id = :v, updated_at = :now WHERE id = :id AND state = 'RESERVED'")
                    .param("v", versionId).param("now", now).param("id", started.objectId()).update();
            if (marked != 1) {
                return new Lost();
            }
            String oldHead = null;
            if (save.kind() == Kind.CREATE) {
                jdbc.sql("""
                                INSERT INTO creation (id, owner_id, title, head_revision_id, status, row_version, created_at, updated_at)
                                VALUES (:id, :owner, :title, NULL, 'ACTIVE', 0, :now, :now)
                                """)
                        .param("id", started.worldId()).param("owner", save.ownerId()).param("title", title).param("now", now).update();
            } else {
                Optional<WorldRow> world = worldRow(save.ownerId(), save.worldId(), true);
                if (world.isEmpty() || !world.get().head().equals(save.baseRevisionId())
                        || world.get().rowVersion() != save.expectedVersion()) {
                    log.info("save.conflict world={} base={} head={}", save.worldId(), save.baseRevisionId(),
                            world.map(WorldRow::head).orElse("none"));
                    queueDeletion(started.objectId(), save.now());
                    finish(started.operationId(), ErrorCode.CONFLICT.status(),
                            ErrorEnvelope.of(ErrorCode.CONFLICT, stale().getMessage()).toJson(), now);
                    return new Conflicted();
                }
                oldHead = world.get().head();
            }
            jdbc.sql("""
                            INSERT INTO revision (id, creation_id, artifact_id, artifact_format, line, sha256, bytes, pins_json, created_at)
                            VALUES (:id, :world, :object, :format, :line, :sha, :bytes, :pins, :now)
                            """)
                    .param("id", started.revisionId()).param("world", started.worldId()).param("object", started.objectId())
                    .param("format", facts.format()).param("line", facts.line()).param("sha", facts.sha256())
                    .param("bytes", facts.bytes()).param("pins", facts.pinsJson()).param("now", now).update();
            if (oldHead != null) {
                // Release 1 keeps the head alone (Q96); W4 keeps what a publication or a pending submission pins.
                String oldObject = jdbc.sql("SELECT artifact_id FROM revision WHERE id = :id").param("id", oldHead).query(String.class).single();
                queueDeletion(oldObject, save.now());
            }
            jdbc.sql("""
                            UPDATE creation SET head_revision_id = :head, row_version = row_version + :step, updated_at = :now
                             WHERE id = :id
                            """)
                    .param("head", started.revisionId()).param("step", save.kind() == Kind.CREATE ? 0 : 1).param("now", now)
                    .param("id", started.worldId()).update();
            jdbc.sql("UPDATE stored_object SET state = 'READY', charge = 'USED', updated_at = :now WHERE id = :id")
                    .param("now", now).param("id", started.objectId()).update();
            lockUsage(save.ownerId());
            for (String owner : List.of(ENVIRONMENT, save.ownerId())) {
                jdbc.sql("""
                                UPDATE storage_usage SET reserved_bytes = reserved_bytes - :b, reserved_objects = reserved_objects - 1,
                                                         used_bytes = used_bytes + :b, used_objects = used_objects + 1
                                 WHERE owner_id = :owner
                                """)
                        .param("b", facts.bytes()).param("owner", owner).update();
            }
            World world = worldRow(save.ownerId(), started.worldId(), false).map(JdbcWorldStore::view).orElseThrow();
            finish(started.operationId(), 201, json.apply(world), now);
            return new Saved(world);
        });
    }

    /** B2 did not take the bytes: the object is queued for deletion (it may exist), the operation failed (503). */
    public void failWrite(Started started, Instant now) {
        inTransaction(() -> {
            queueDeletion(started.objectId(), now);
            jdbc.sql("""
                            UPDATE operation SET state = 'FAILED', response_status = 503, response_json = :json, updated_at = :now
                             WHERE id = :id AND state = 'PENDING'
                            """)
                    .param("json", ErrorEnvelope.of(ErrorCode.UNAVAILABLE, "Saving worlds is unavailable right now.").toJson())
                    .param("now", at(now)).param("id", started.operationId()).update();
            return null;
        });
    }

    // --- Edits and reads --------------------------------------------------------------------------------------------

    public World rename(String ownerId, String worldId, long expectedVersion, String title, Instant now) {
        return inTransaction(() -> {
            int rows = jdbc.sql("""
                            UPDATE creation SET title = :title, row_version = row_version + 1, updated_at = :now
                             WHERE id = :id AND owner_id = :owner AND status = 'ACTIVE' AND row_version = :expected
                            """)
                    .param("title", title).param("now", at(now)).param("id", worldId).param("owner", ownerId)
                    .param("expected", expectedVersion).update();
            if (rows != 1) {
                throw worldRow(ownerId, worldId, false).isPresent() ? stale() : notFound();
            }
            return worldRow(ownerId, worldId, false).map(JdbcWorldStore::view).orElseThrow();
        });
    }

    /**
     * A world's deletion begun (its own key, as a save's): hidden at once, every retained object queued for deletion, and
     * a job that finishes it once B2 confirms them gone. The answer is the operation to poll, now and on a retry.
     */
    public String delete(String ownerId, String worldId, long expectedVersion, String route, String key, String requestHash, Instant now) {
        return inTransaction(() -> {
            LocalDateTime at = at(now);
            String operationId = Ulid.next(now);
            try {
                jdbc.sql("""
                                INSERT INTO operation (id, owner_id, route, idempotency_key, request_hash, state, response_status,
                                                       created_at, updated_at, expires_at)
                                VALUES (:id, :owner, :route, :key, :hash, 'PENDING', 202, :now, :now, :expires)
                                """)
                        .param("id", operationId).param("owner", ownerId).param("route", route).param("key", key).param("hash", requestHash)
                        .param("now", at).param("expires", at(now.plus(limits.operationLife()))).update();
            } catch (DuplicateKeyException exists) {
                OperationRow op = jdbc.sql("""
                                SELECT id, request_hash, state, response_status, response_json FROM operation
                                 WHERE owner_id = :owner AND route = :route AND idempotency_key = :key
                                """)
                        .param("owner", ownerId).param("route", route).param("key", key).query(JdbcWorldStore::operation).single();
                if (!op.requestHash().equals(requestHash)) {
                    throw new PlatformException(ErrorCode.CONFLICT, "This Idempotency-Key was used for another request.");
                }
                return op.id();
            }
            int rows = jdbc.sql("""
                            UPDATE creation SET status = 'DELETING', row_version = row_version + 1, updated_at = :now
                             WHERE id = :id AND owner_id = :owner AND status = 'ACTIVE' AND row_version = :expected
                            """)
                    .param("now", at).param("id", worldId).param("owner", ownerId).param("expected", expectedVersion).update();
            if (rows != 1) {
                throw worldRow(ownerId, worldId, false).isPresent() ? stale() : notFound();
            }
            List<String> objects = jdbc.sql("""
                            SELECT o.id FROM revision r JOIN stored_object o ON o.id = r.artifact_id
                             WHERE r.creation_id = :world AND o.state IN ('READY', 'DELETE_PENDING')
                            """)
                    .param("world", worldId).query(String.class).list();
            for (String object : objects) {
                queueDeletion(object, now);
            }
            insertJob("WORLD_FINISH", worldId, now);
            log.info("world.deleting world={} objects={}", worldId, objects.size());
            return operationId;
        });
    }

    /** The caller's active world, or empty: another's, a deleted one and a missing one are the same (I1). */
    public Optional<World> world(String ownerId, String worldId) {
        return worldRow(ownerId, worldId, false).map(JdbcWorldStore::view);
    }

    /** The caller's active worlds, the newest made first, after the cursor `(createdAt, id)` when one is given. */
    public List<World> worlds(String ownerId, Instant afterCreated, String afterId, int limit) {
        String after = afterCreated == null ? "" : " AND (c.created_at, c.id) < (:afterAt, :afterId)";
        JdbcClient.StatementSpec spec = jdbc.sql(WORLD_SELECT + " WHERE c.owner_id = :owner AND c.status = 'ACTIVE'" + after
                        + " ORDER BY c.created_at DESC, c.id DESC LIMIT :limit")
                .param("owner", ownerId).param("limit", limit);
        if (afterCreated != null) {
            spec = spec.param("afterAt", at(afterCreated)).param("afterId", afterId);
        }
        return spec.query(JdbcWorldStore::worldRow).list().stream().map(JdbcWorldStore::view).toList();
    }

    /** A revision of the caller's active world whose bytes are retained, or empty. */
    public Optional<RetainedRevision> revision(String ownerId, String worldId, String revisionId) {
        return jdbc.sql("""
                        SELECT r.id, r.sha256, r.bytes, r.artifact_format, r.line, r.created_at, o.object_key, o.version_id
                          FROM revision r
                          JOIN creation c ON c.id = r.creation_id
                          JOIN stored_object o ON o.id = r.artifact_id
                         WHERE r.id = :revision AND r.creation_id = :world AND c.owner_id = :owner AND c.status = 'ACTIVE'
                           AND o.state = 'READY'
                        """)
                .param("revision", revisionId).param("world", worldId).param("owner", ownerId)
                .query((row, i) -> new RetainedRevision(worldId,
                        new Head(row.getString("id"), row.getString("sha256"), row.getInt("bytes"), row.getString("artifact_format"),
                                row.getString("line"), instant(row, "created_at")),
                        row.getString("object_key"), row.getString("version_id")))
                .optional();
    }

    public Usage usage(String ownerId) {
        UsageRow u = jdbc.sql("SELECT used_bytes, reserved_bytes, used_objects, reserved_objects FROM storage_usage WHERE owner_id = :owner")
                .param("owner", ownerId).query(JdbcWorldStore::usage).optional().orElse(new UsageRow(0, 0));
        return new Usage(u.used(), u.reserved(), activeWorlds(ownerId), limits.maxBytes(), limits.maxWorlds());
    }

    /** An operation of the caller's, or empty: its state, status and stored answer. */
    public Optional<OperationRow> operation(String ownerId, String operationId) {
        return jdbc.sql("""
                        SELECT id, request_hash, state, response_status, response_json FROM operation
                         WHERE id = :id AND owner_id = :owner
                        """)
                .param("id", operationId).param("owner", ownerId).query(JdbcWorldStore::operation).optional();
    }

    // --- Cleanup and reconciliation ---------------------------------------------------------------------------------

    /** Claims up to `n` due jobs (or ones whose lease ran out) under `token` until `until`. */
    public List<Job> claim(String token, Instant now, Instant until, int n) {
        return inTransaction(() -> {
            jdbc.sql("""
                            UPDATE cleanup_job SET state = 'RUNNING', lease_token = :token, lease_until = :until,
                                                   attempts = attempts + 1, updated_at = :now
                             WHERE (state IN ('PENDING', 'RETRY') AND next_attempt_at <= :now)
                                OR (state = 'RUNNING' AND lease_until < :now)
                             ORDER BY next_attempt_at LIMIT :n
                            """)
                    .param("token", token).param("until", at(until)).param("now", at(now)).param("n", n).update();
            return jdbc.sql("SELECT id, kind, target_id, attempts FROM cleanup_job WHERE lease_token = :token AND state = 'RUNNING'")
                    .param("token", token)
                    .query((row, i) -> new Job(row.getString("id"), row.getString("kind"), row.getString("target_id"), row.getInt("attempts")))
                    .list();
        });
    }

    public Optional<StoredObject> object(String objectId) {
        return jdbc.sql("SELECT id, owner_id, object_key, version_id, state, charge, bytes FROM stored_object WHERE id = :id")
                .param("id", objectId)
                .query((row, i) -> new StoredObject(row.getString("id"), row.getString("owner_id"), row.getString("object_key"),
                        row.getString("version_id"), row.getString("state"), row.getString("charge"), row.getLong("bytes")))
                .optional();
    }

    /** A job with nothing left to do (its target gone): done, under its lease. */
    public void closeJob(Job job, String token, Instant now) {
        done(job, token, now);
    }

    /**
     * B2 confirmed `object` gone: it is marked deleted and its bytes return to the counter that held them, once, under
     * the job's lease (a worker whose lease ran out changes nothing).
     */
    public boolean objectDeleted(Job job, String token, StoredObject object, Instant now) {
        return inTransaction(() -> {
            if (!done(job, token, now)) {
                return false;
            }
            int rows = jdbc.sql("UPDATE stored_object SET state = 'DELETED', charge = 'NONE', updated_at = :now WHERE id = :id AND state <> 'DELETED'")
                    .param("now", at(now)).param("id", object.id()).update();
            if (rows == 1 && !object.charge().equals("NONE")) {
                String counter = object.charge().equals("USED") ? "used" : "reserved";
                lockUsage(object.ownerId());
                for (String owner : List.of(ENVIRONMENT, object.ownerId())) {
                    jdbc.sql("UPDATE storage_usage SET " + counter + "_bytes = " + counter + "_bytes - :b, "
                                    + counter + "_objects = " + counter + "_objects - 1 WHERE owner_id = :owner")
                            .param("b", object.bytes()).param("owner", owner).update();
                }
            }
            return true;
        });
    }

    /**
     * A deleted world's last step: once every object of its revisions is gone, it is DELETED and its deletion's operation
     * done. False while some remain: the job is tried again.
     */
    public boolean finishWorld(Job job, String token, Instant now) {
        return inTransaction(() -> {
            long left = jdbc.sql("""
                            SELECT COUNT(*) FROM revision r JOIN stored_object o ON o.id = r.artifact_id
                             WHERE r.creation_id = :world AND o.state <> 'DELETED'
                            """)
                    .param("world", job.targetId()).query(Long.class).single();
            if (left > 0) {
                return false;
            }
            if (!done(job, token, now)) {
                return true;
            }
            String owner = jdbc.sql("UPDATE creation SET status = 'DELETED', updated_at = :now WHERE id = :id AND status = 'DELETING'")
                    .param("now", at(now)).param("id", job.targetId()).update() == 1
                    ? jdbc.sql("SELECT owner_id FROM creation WHERE id = :id").param("id", job.targetId()).query(String.class).single()
                    : null;
            if (owner != null) {
                jdbc.sql("UPDATE operation SET state = 'DONE', updated_at = :now WHERE owner_id = :owner AND route = :route AND state = 'PENDING'")
                        .param("now", at(now)).param("owner", owner).param("route", "DELETE /v1/worlds/" + job.targetId()).update();
                log.info("world.deleted world={}", job.targetId());
            }
            return true;
        });
    }

    /** The job is tried again after `delay`, its lease given up (only by the worker that holds it). */
    public void retry(Job job, String token, java.time.Duration delay, Instant now) {
        jdbc.sql("""
                        UPDATE cleanup_job SET state = 'RETRY', lease_token = NULL, lease_until = NULL, next_attempt_at = :next, updated_at = :now
                         WHERE id = :id AND lease_token = :token AND state = 'RUNNING'
                        """)
                .param("next", at(now.plus(delay))).param("now", at(now)).param("id", job.id()).param("token", token).update();
    }

    /**
     * Saves still under way after `staleAfter` died with their process (I8): each one's object queued for deletion, the
     * operation failed (503), so a retry with its key runs again. Returns how many were failed.
     */
    public int failStale(Instant now) {
        List<String> stale = jdbc.sql("""
                        SELECT id FROM operation WHERE state = 'PENDING' AND route LIKE 'POST %' AND updated_at < :before
                         ORDER BY updated_at LIMIT 50
                        """)
                .param("before", at(now.minus(limits.staleAfter()))).query(String.class).list();
        int failed = 0;
        for (String id : stale) {
            Boolean did = inTransaction(() -> {
                String state = jdbc.sql("SELECT state FROM operation WHERE id = :id FOR UPDATE").param("id", id).query(String.class).single();
                if (!state.equals("PENDING")) {
                    return false;
                }
                for (String object : jdbc.sql("SELECT id FROM stored_object WHERE operation_id = :op AND state = 'RESERVED'")
                        .param("op", id).query(String.class).list()) {
                    queueDeletion(object, now);
                }
                jdbc.sql("UPDATE operation SET state = 'FAILED', response_status = 503, response_json = :json, updated_at = :now WHERE id = :id")
                        .param("json", ErrorEnvelope.of(ErrorCode.UNAVAILABLE, "Saving worlds is unavailable right now.").toJson())
                        .param("now", at(now)).param("id", id).update();
                return true;
            });
            if (Boolean.TRUE.equals(did)) {
                log.warn("save.reconciled op={} reason=stale", id);
                failed++;
            }
        }
        return failed;
    }

    /** Operations past their life, and finished jobs a day old: forgotten in batches. */
    public int forget(Instant now) {
        int ops = jdbc.sql("DELETE FROM operation WHERE expires_at < :now AND state <> 'PENDING' LIMIT 500").param("now", at(now)).update();
        int jobs = jdbc.sql("DELETE FROM cleanup_job WHERE state = 'DONE' AND updated_at < :before LIMIT 500")
                .param("before", at(now.minus(java.time.Duration.ofDays(1)))).update();
        return ops + jobs;
    }

    // --- Rows -------------------------------------------------------------------------------------------------------

    /** An operation's row: its hash, state, status and stored answer. */
    public record OperationRow(String id, String requestHash, String state, Integer status, String json) {
    }

    private record WorldRow(String id, String title, String head, long rowVersion, Instant createdAt, Instant updatedAt,
                            String headSha, int headBytes, String headFormat, String headLine, Instant headCreatedAt) {
    }

    private record UsageRow(long used, long reserved) {
    }

    private static final String WORLD_SELECT = """
            SELECT c.id, c.title, c.head_revision_id, c.row_version, c.created_at, c.updated_at,
                   r.sha256, r.bytes, r.artifact_format, r.line, r.created_at AS head_created_at
              FROM creation c
              JOIN revision r ON r.id = c.head_revision_id
            """;

    private Optional<WorldRow> worldRow(String ownerId, String worldId, boolean lock) {
        return jdbc.sql(WORLD_SELECT + " WHERE c.id = :id AND c.owner_id = :owner AND c.status = 'ACTIVE'" + (lock ? " FOR UPDATE" : ""))
                .param("id", worldId).param("owner", ownerId).query(JdbcWorldStore::worldRow).optional();
    }

    private long activeWorlds(String ownerId) {
        return jdbc.sql("SELECT COUNT(*) FROM creation WHERE owner_id = :owner AND status = 'ACTIVE'")
                .param("owner", ownerId).query(Long.class).single();
    }

    /**
     * The environment's usage row, then the account's, locked in that order (26 zeros sort first). Locked straight away:
     * an INSERT IGNORE first would take shared locks that two saves then both try to raise, a deadlock every time. Only
     * an account's first save inserts its row (V2 seeds the environment's).
     */
    private void lockUsage(String ownerId) {
        String lock = "SELECT owner_id FROM storage_usage WHERE owner_id IN (:env, :owner) ORDER BY owner_id FOR UPDATE";
        if (jdbc.sql(lock).param("env", ENVIRONMENT).param("owner", ownerId).query(String.class).list().size() < 2) {
            jdbc.sql("INSERT IGNORE INTO storage_usage (owner_id) VALUES (:env), (:owner)")
                    .param("env", ENVIRONMENT).param("owner", ownerId).update();
            jdbc.sql(lock).param("env", ENVIRONMENT).param("owner", ownerId).query(String.class).list();
        }
    }

    private UsageRow usageRow(String ownerId) {
        return jdbc.sql("SELECT used_bytes, reserved_bytes, used_objects, reserved_objects FROM storage_usage WHERE owner_id = :owner")
                .param("owner", ownerId).query(JdbcWorldStore::usage).single();
    }

    /** `objectId`'s bytes queued for deletion from B2 (its charge kept until B2 confirms it gone). */
    private void queueDeletion(String objectId, Instant now) {
        jdbc.sql("UPDATE stored_object SET state = 'DELETE_PENDING', updated_at = :now WHERE id = :id AND state IN ('RESERVED', 'READY')")
                .param("now", at(now)).param("id", objectId).update();
        insertJob("OBJECT_DELETE", objectId, now);
    }

    private void insertJob(String kind, String target, Instant now) {
        jdbc.sql("""
                        INSERT IGNORE INTO cleanup_job (id, kind, target_id, state, attempts, next_attempt_at, created_at, updated_at)
                        VALUES (:id, :kind, :target, 'PENDING', 0, :now, :now, :now)
                        """)
                .param("id", Ulid.next(now)).param("kind", kind).param("target", target).param("now", at(now)).update();
    }

    private boolean done(Job job, String token, Instant now) {
        return jdbc.sql("""
                        UPDATE cleanup_job SET state = 'DONE', lease_token = NULL, lease_until = NULL, updated_at = :now
                         WHERE id = :id AND lease_token = :token AND state = 'RUNNING'
                        """)
                .param("now", at(now)).param("id", job.id()).param("token", token).update() == 1;
    }

    private void finish(String operationId, int status, String json, LocalDateTime now) {
        jdbc.sql("UPDATE operation SET state = 'DONE', response_status = :status, response_json = :json, updated_at = :now WHERE id = :id")
                .param("status", status).param("json", json).param("now", now).param("id", operationId).update();
    }

    private static World view(WorldRow w) {
        return new World(w.id(), w.title(), w.rowVersion(), w.createdAt(), w.updatedAt(),
                new Head(w.head(), w.headSha(), w.headBytes(), w.headFormat(), w.headLine(), w.headCreatedAt()));
    }

    private static WorldRow worldRow(ResultSet row, int i) throws SQLException {
        return new WorldRow(row.getString("id"), row.getString("title"), row.getString("head_revision_id"), row.getLong("row_version"),
                instant(row, "created_at"), instant(row, "updated_at"), row.getString("sha256"), row.getInt("bytes"),
                row.getString("artifact_format"), row.getString("line"), instant(row, "head_created_at"));
    }

    private static OperationRow operation(ResultSet row, int i) throws SQLException {
        // wasNull() speaks of the last column read, so it is asked at once: read after `state`, a pending operation's
        // NULL status came back as 0 (the review of 11-03).
        int raw = row.getInt("response_status");
        Integer status = row.wasNull() ? null : raw;
        return new OperationRow(row.getString("id"), row.getString("request_hash"), row.getString("state"), status,
                row.getString("response_json"));
    }

    private static UsageRow usage(ResultSet row, int i) throws SQLException {
        return new UsageRow(row.getLong("used_bytes"), row.getLong("reserved_bytes"));
    }

    private static Instant instant(ResultSet row, String column) throws SQLException {
        return row.getObject(column, LocalDateTime.class).toInstant(ZoneOffset.UTC);
    }

    static LocalDateTime at(Instant instant) {
        return LocalDateTime.ofInstant(instant.truncatedTo(ChronoUnit.MILLIS), ZoneOffset.UTC);
    }

    private static PlatformException stale() {
        return new PlatformException(ErrorCode.CONFLICT, "This world changed since it was read. Read it again.");
    }

    private static PlatformException notFound() {
        return new PlatformException(ErrorCode.NOT_FOUND, "This world isn't available.");
    }

    private static PlatformException storageFull() {
        return new PlatformException(ErrorCode.STORAGE_FULL, "Your saved-world storage is full. Delete a saved world you no longer need.");
    }

    /** `work` in one transaction, tried again while InnoDB makes it a deadlock's victim (its rollback is whole). */
    private <T> T inTransaction(Supplier<T> work) {
        for (int attempt = 1; ; attempt++) {
            try {
                return transactions.execute(status -> work.get());
            } catch (PessimisticLockingFailureException deadlock) {
                if (attempt >= DEADLOCK_ATTEMPTS) {
                    throw deadlock;
                }
                try {
                    Thread.sleep(ThreadLocalRandom.current().nextLong(5, 20L * attempt));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw deadlock;
                }
            }
        }
    }
}
