package ai.wexy.platform.world;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the world routes answer (W3's contract, the creations platform design §10), as closed shapes: every key present,
 * in this order, nulls included. Never the owner, a key, a bucket, an object's key or version, or any request body.
 */
public final class WorldViews {

    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private WorldViews() {
    }

    /** A world's head revision as the world DTO carries it. */
    public record Head(String revisionId, String sha256, int bytes, String format, String line, Instant createdAt) {
    }

    /** A world as its owner sees it. */
    public record World(String worldId, String title, long rowVersion, Instant createdAt, Instant updatedAt, Head head) {
    }

    /** A retained revision with its exact text. */
    public record RevisionText(String worldId, Head head, String artifact) {
    }

    /** What an account holds and reserves, and its bounds. */
    public record Usage(long usedBytes, long reservedBytes, long worlds, long maxBytes, long maxWorlds) {
    }

    /** ISO-8601 UTC with milliseconds, as the contract says every time is written. */
    public static String time(Instant at) {
        return TIME.format(at.truncatedTo(ChronoUnit.MILLIS));
    }

    public static Map<String, Object> world(World w) {
        Map<String, Object> head = new LinkedHashMap<>();
        head.put("revisionId", w.head().revisionId());
        head.put("sha256", w.head().sha256());
        head.put("bytes", w.head().bytes());
        head.put("format", w.head().format());
        head.put("line", w.head().line());
        head.put("createdAt", time(w.head().createdAt()));
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("worldId", w.worldId());
        dto.put("title", w.title());
        dto.put("rowVersion", w.rowVersion());
        dto.put("createdAt", time(w.createdAt()));
        dto.put("updatedAt", time(w.updatedAt()));
        dto.put("head", head);
        return dto;
    }

    public static Map<String, Object> worlds(List<World> worlds, String next) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("worlds", worlds.stream().map(WorldViews::world).toList());
        dto.put("next", next);
        return dto;
    }

    public static Map<String, Object> revision(RevisionText r) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("worldId", r.worldId());
        dto.put("revisionId", r.head().revisionId());
        dto.put("sha256", r.head().sha256());
        dto.put("bytes", r.head().bytes());
        dto.put("format", r.head().format());
        dto.put("line", r.head().line());
        dto.put("createdAt", time(r.head().createdAt()));
        dto.put("artifact", r.artifact());
        return dto;
    }

    public static Map<String, Object> usage(Usage u) {
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("bytes", u.maxBytes());
        limits.put("worlds", u.maxWorlds());
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("usedBytes", u.usedBytes());
        dto.put("reservedBytes", u.reservedBytes());
        dto.put("worlds", u.worlds());
        dto.put("limits", limits);
        return dto;
    }

    /** An operation as its owner polls it: its state, and once it has one, the route's own answer. */
    public static Map<String, Object> operation(String operationId, String state, Integer status, Object result) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("operationId", operationId);
        dto.put("state", state);
        dto.put("status", status);
        dto.put("result", result);
        return dto;
    }

    /** A delete's answer, or a save's while it runs: the operation to poll. */
    public static Map<String, Object> accepted(String operationId, String state) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("operationId", operationId);
        dto.put("state", state);
        return dto;
    }
}
