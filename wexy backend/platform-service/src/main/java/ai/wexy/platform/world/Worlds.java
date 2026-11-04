package ai.wexy.platform.world;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.account.Account;
import ai.wexy.platform.account.Accounts;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.identity.PlatformCaller;
import ai.wexy.platform.storage.ObjectStore;
import ai.wexy.platform.world.JdbcWorldStore.Begun;
import ai.wexy.platform.world.JdbcWorldStore.Committed;
import ai.wexy.platform.world.JdbcWorldStore.Conflicted;
import ai.wexy.platform.world.JdbcWorldStore.Kind;

import ai.wexy.platform.world.JdbcWorldStore.Replay;
import ai.wexy.platform.world.JdbcWorldStore.Running;
import ai.wexy.platform.world.JdbcWorldStore.Saved;
import ai.wexy.platform.world.JdbcWorldStore.Started;
import ai.wexy.platform.world.WorldViews.World;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * What the world routes do (W3.2; the creations platform design §7, §10), as blocking calls the handler runs on its
 * schedulers. The caller is always the gateway's verified one, mapped to its account here: no id, owner or field in a
 * request picks whose world is read or written (I1), and a world another account owns answers as a missing one does.
 *
 * <p>A save checks the text (WorldCheck), begins in the database (the operation, the caps, the reservation), writes the
 * bytes to B2 under a key the platform made, and commits (the head's compare-and-set). Every answer that has one is
 * stored on its operation, so a retry with the same Idempotency-Key gets it again rather than a second world.
 */
public final class Worlds {

    private static final Logger log = LoggerFactory.getLogger(Worlds.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9-]{16,64}");
    private static final Pattern ULID = Pattern.compile("[0-9A-HJKMNP-TV-Z]{26}");
    static final int TITLE_CODE_POINTS = 120;
    static final int DEFAULT_PAGE = 24;
    static final int MAX_PAGE = 50;

    /** A route's answer: its status and its JSON, already written (a replay's is the stored text). */
    public record Reply(int status, String json) {
    }

    private final Accounts accounts;
    private final JdbcWorldStore store;
    private final ObjectStore objects;
    private final WorldCheck check;
    private final Clock clock;

    public Worlds(Accounts accounts, JdbcWorldStore store, ObjectStore objects, WorldCheck check, Clock clock) {
        this.accounts = accounts;
        this.store = store;
        this.objects = objects;
        this.check = check;
        this.clock = clock;
    }

    // --- Saves ------------------------------------------------------------------------------------------------------

    /** {@code POST /v1/worlds}: a new world, its first revision the text given. */
    public Reply create(PlatformCaller caller, String key, JsonNode body) {
        idempotencyKey(key);
        exactly(body, "A world's save takes exactly title, artifact and sha256.", "title", "artifact", "sha256");
        String title = title(body.get("title"));
        WorldCheck.Facts facts = check.check(text(body.get("artifact"), "artifact"), text(body.get("sha256"), "sha256"));
        String owner = active(caller).id();
        String route = JdbcWorldStore.CREATE_ROUTE;
        Instant now = clock.instant();
        JdbcWorldStore.Save save = new JdbcWorldStore.Save(Kind.CREATE, owner, route, key,
                hash(route, title, facts.sha256()), null, null, 0, facts.bytes(), facts.sha256(), now);
        return save(save, title, facts, body.get("artifact").asText());
    }

    /** {@code POST /v1/worlds/{id}/revisions}: the world's next head, based on the head and version it was read at. */
    public Reply revise(PlatformCaller caller, String worldId, String key, JsonNode body) {
        idempotencyKey(key);
        concealUnlessUlid(worldId);
        exactly(body, "A revision takes exactly baseRevisionId, expectedVersion, artifact and sha256.",
                "baseRevisionId", "expectedVersion", "artifact", "sha256");
        String base = text(body.get("baseRevisionId"), "baseRevisionId");
        if (!ULID.matcher(base).matches()) {
            throw bad("The baseRevisionId is not a revision's id.");
        }
        long expected = version(body.get("expectedVersion"));
        WorldCheck.Facts facts = check.check(text(body.get("artifact"), "artifact"), text(body.get("sha256"), "sha256"));
        String owner = active(caller).id();
        String route = "POST /v1/worlds/" + worldId + "/revisions";
        Instant now = clock.instant();
        JdbcWorldStore.Save save = new JdbcWorldStore.Save(Kind.REVISE, owner, route, key,
                hash(route, base, Long.toString(expected), facts.sha256()), worldId, base, expected, facts.bytes(), facts.sha256(), now);
        return save(save, null, facts, body.get("artifact").asText());
    }

    private Reply save(JdbcWorldStore.Save save, String title, WorldCheck.Facts facts, String artifact) {
        if (!objects.configured()) {
            throw unavailable();
        }
        Begun begun = store.begin(save);
        if (begun instanceof Replay replay) {
            return new Reply(replay.status(), replay.json());
        }
        if (begun instanceof Running running) {
            return new Reply(202, json(WorldViews.accepted(running.operationId(), "PENDING")));
        }
        Started started = (Started) begun;
        byte[] bytes = artifact.getBytes(StandardCharsets.UTF_8);
        ObjectStore.Written written;
        try {
            written = objects.put(started.objectKey(), bytes, "application/json; charset=utf-8", md5(bytes));
        } catch (ObjectStore.StorageUnavailable e) {
            log.warn("dependency.unavailable dep=b2 op={} phase=write", started.operationId());
            store.failWrite(started, clock.instant());
            throw unavailable();
        }
        Committed committed = store.commit(save, started, title, facts, written.versionId(), w -> json(WorldViews.world(w)));
        if (committed instanceof Saved saved) {
            log.info("world.saved world={} revision={} op={} bytes={}", saved.world().worldId(), started.revisionId(),
                    started.operationId(), facts.bytes());
            return new Reply(201, json(WorldViews.world(saved.world())));
        }
        if (committed instanceof Conflicted) {
            throw new PlatformException(ErrorCode.CONFLICT, "This world changed since it was read. Read it again.");
        }
        // Lost: the reconciler judged the save dead while its bytes were written; they are queued for deletion.
        log.warn("save.lost op={}", started.operationId());
        throw unavailable();
    }

    // --- Edits ------------------------------------------------------------------------------------------------------

    /** {@code PATCH /v1/worlds/{id}}: a new title, at the version it was read at. */
    public Reply rename(PlatformCaller caller, String worldId, JsonNode body) {
        concealUnlessUlid(worldId);
        exactly(body, "A rename takes exactly expectedVersion and title.", "expectedVersion", "title");
        long expected = version(body.get("expectedVersion"));
        String title = title(body.get("title"));
        World world = store.rename(active(caller).id(), worldId, expected, title, clock.instant());
        return new Reply(200, json(WorldViews.world(world)));
    }

    /** {@code DELETE /v1/worlds/{id}?expectedVersion=}: hidden at once, its bytes erased by the cleanup jobs. */
    public Reply delete(PlatformCaller caller, String worldId, String key, String expectedVersion) {
        idempotencyKey(key);
        concealUnlessUlid(worldId);
        if (expectedVersion == null || !expectedVersion.matches("\\d{1,18}")) {
            throw bad("A deletion names the world's expectedVersion.");
        }
        String route = "DELETE /v1/worlds/" + worldId;
        String op = store.delete(active(caller).id(), worldId, Long.parseLong(expectedVersion), route, key,
                hash(route, expectedVersion), clock.instant());
        String state = store.operation(active(caller).id(), op).map(JdbcWorldStore.OperationRow::state).orElse("PENDING");
        return new Reply(202, json(WorldViews.accepted(op, state)));
    }

    // --- Reads ------------------------------------------------------------------------------------------------------

    /** {@code GET /v1/worlds/{id}}. */
    public Reply read(PlatformCaller caller, String worldId) {
        concealUnlessUlid(worldId);
        World world = store.world(active(caller).id(), worldId).orElseThrow(Worlds::notFound);
        return new Reply(200, json(WorldViews.world(world)));
    }

    /** {@code GET /v1/me/worlds?limit=&cursor=}: the history, the newest made first. */
    public Reply list(PlatformCaller caller, String limitText, String cursor) {
        int limit = DEFAULT_PAGE;
        if (limitText != null) {
            if (!limitText.matches("\\d{1,3}") || Integer.parseInt(limitText) < 1 || Integer.parseInt(limitText) > MAX_PAGE) {
                throw bad("The limit is 1 to " + MAX_PAGE + ".");
            }
            limit = Integer.parseInt(limitText);
        }
        Instant afterAt = null;
        String afterId = null;
        if (cursor != null) {
            String[] parts;
            try {
                parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.US_ASCII).split("\\.", -1);
            } catch (IllegalArgumentException e) {
                throw bad("The cursor is not one this list gave.");
            }
            if (parts.length != 2 || !parts[0].matches("\\d{1,15}") || !ULID.matcher(parts[1]).matches()) {
                throw bad("The cursor is not one this list gave.");
            }
            afterAt = Instant.ofEpochMilli(Long.parseLong(parts[0]));
            afterId = parts[1];
        }
        List<World> page = new ArrayList<>(store.worlds(active(caller).id(), afterAt, afterId, limit + 1));
        String next = null;
        if (page.size() > limit) {
            page = page.subList(0, limit);
            World last = page.get(limit - 1);
            next = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString((last.createdAt().toEpochMilli() + "." + last.worldId()).getBytes(StandardCharsets.US_ASCII));
        }
        return new Reply(200, json(WorldViews.worlds(page, next)));
    }

    /**
     * {@code GET /v1/worlds/{id}/revisions/{revisionId}}: a retained revision with its exact text, which is checked to
     * be the bytes its hash names before it leaves (§7's step 5). Missing or altered is 503, never an empty world.
     */
    public Reply revision(PlatformCaller caller, String worldId, String revisionId) {
        concealUnlessUlid(worldId);
        concealUnlessUlid(revisionId);
        JdbcWorldStore.RetainedRevision r = store.revision(active(caller).id(), worldId, revisionId).orElseThrow(Worlds::notFound);
        byte[] bytes;
        try {
            bytes = objects.get(r.objectKey(), r.versionId(), WorldCheck.MAX_BYTES);
        } catch (ObjectStore.StorageUnavailable e) {
            throw unavailable();
        }
        if (bytes == null || bytes.length != r.head().bytes() || !WorldCheck.sha256(bytes).equals(r.head().sha256())) {
            log.error("object.corrupt revision={} reason={}", revisionId, bytes == null ? "missing" : "not its hash");
            throw unavailable();
        }
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            log.error("object.corrupt revision={} reason=not-utf8", revisionId);
            throw unavailable();
        }
        return new Reply(200, json(WorldViews.revision(new WorldViews.RevisionText(r.worldId(), r.head(), text))));
    }

    /** {@code GET /v1/me/usage}: the caller's own (I13). */
    public Reply usage(PlatformCaller caller) {
        return new Reply(200, json(WorldViews.usage(store.usage(active(caller).id()))));
    }

    /** {@code GET /v1/me/operations/{id}}: any status may follow its own operations (N). */
    public Reply operation(PlatformCaller caller, String operationId) {
        concealUnlessUlid(operationId);
        JdbcWorldStore.OperationRow op = store.operation(accounts.read(caller).id(), operationId).orElseThrow(Worlds::notFound);
        boolean running = op.state().equals("PENDING");
        Object result = null;
        if (!running && op.json() != null) {
            try {
                result = JSON.readTree(op.json());
            } catch (JsonProcessingException e) {
                throw new PlatformException(ErrorCode.INTERNAL, "This operation's answer can't be read.");
            }
        }
        return new Reply(200, json(WorldViews.operation(op.id(), op.state(), running ? null : op.status(), result)));
    }

    // --- Checks -----------------------------------------------------------------------------------------------------

    private Account active(PlatformCaller caller) {
        Account account = accounts.read(caller);
        if (account.status() != Account.Status.ACTIVE) {
            log.info("account.refused account={} status={} route=worlds", account.id(), account.status());
            throw new PlatformException(ErrorCode.FORBIDDEN, "This account can't save or change worlds right now.");
        }
        return account;
    }

    private static void idempotencyKey(String key) {
        if (key == null || !KEY.matcher(key).matches()) {
            throw bad("This request needs an Idempotency-Key: 16 to 64 letters, digits and hyphens.");
        }
    }

    private static void concealUnlessUlid(String id) {
        if (id == null || !ULID.matcher(id).matches()) {
            throw notFound();
        }
    }

    /** `body` is an object with exactly `keys`, no more and no fewer. */
    private static void exactly(JsonNode body, String message, String... keys) {
        if (body == null || !body.isObject() || body.size() != keys.length) {
            throw bad(message);
        }
        Set<String> wanted = Set.of(keys);
        for (Iterator<String> names = body.fieldNames(); names.hasNext(); ) {
            if (!wanted.contains(names.next())) {
                throw bad(message);
            }
        }
    }

    private static String text(JsonNode value, String field) {
        if (value == null || !value.isTextual()) {
            throw bad("The " + field + " is text.");
        }
        return value.asText();
    }

    private static long version(JsonNode value) {
        if (value == null || !value.isIntegralNumber() || value.asLong() < 0 || !value.canConvertToLong()) {
            throw bad("The expectedVersion is a whole number from 0.");
        }
        return value.asLong();
    }

    /** A title: trimmed, 1 to 120 code points, one line with no control characters. */
    static String title(JsonNode value) {
        String title = text(value, "title").strip();
        int length = title.codePointCount(0, title.length());
        if (length < 1 || length > TITLE_CODE_POINTS) {
            throw bad("A title is 1 to " + TITLE_CODE_POINTS + " characters.");
        }
        if (title.codePoints().anyMatch(c -> Character.getType(c) == Character.CONTROL)) {
            throw bad("A title is one line, with no control characters.");
        }
        return title;
    }

    /** The request's hash for its key: its route and every value it asks for, each on its own line. */
    private static String hash(String... parts) {
        return WorldCheck.sha256(String.join("\n", parts).getBytes(StandardCharsets.UTF_8));
    }

    private static String md5(byte[] bytes) {
        try {
            return Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("MD5 is missing from this JVM", e);
        }
    }

    private static String json(Map<String, Object> dto) {
        try {
            return JSON.writeValueAsString(dto);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static PlatformException bad(String message) {
        return new PlatformException(ErrorCode.BAD_REQUEST, message);
    }

    private static PlatformException notFound() {
        return new PlatformException(ErrorCode.NOT_FOUND, "This world isn't available.");
    }

    private static PlatformException unavailable() {
        return new PlatformException(ErrorCode.UNAVAILABLE, "Saving worlds is unavailable right now.");
    }
}
