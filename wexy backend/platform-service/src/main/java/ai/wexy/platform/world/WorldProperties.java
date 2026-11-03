package ai.wexy.platform.world;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * The saved worlds' bounds (W3; the creations platform design §11, every value a proposal for qualification).
 *
 * @param maxWorlds        an account's active worlds (50)
 * @param maxBytes         an account's bytes, used and reserved, overlap and queued deletions included (100 MiB)
 * @param environmentBytes the environment's bytes, beyond which saving is unavailable (1 GiB on dev)
 * @param pendingSaves     an account's saves under way at once (2)
 * @param operationLife    how long a save's answer is kept for a retry with its key (24 h)
 * @param staleAfter       a save still under way after this has died with its process: the reconciler fails it (2 min)
 * @param cleanupEvery     how often the cleanup worker looks for due jobs and stale saves (15 s)
 * @param cleanupBatch     jobs one look claims (10)
 * @param cleanupEnabled   false in tests, which call the worker's tick themselves
 */
@ConfigurationProperties(prefix = "wexy.worlds")
public record WorldProperties(int maxWorlds, long maxBytes, long environmentBytes, int pendingSaves, Duration operationLife,
                              Duration staleAfter, Duration cleanupEvery, int cleanupBatch, boolean cleanupEnabled) {

    public WorldProperties {
        if (maxWorlds < 1 || maxBytes < 1 || environmentBytes < maxBytes || pendingSaves < 1 || cleanupBatch < 1) {
            throw new IllegalStateException("wexy.worlds: every bound must be positive, the environment's at least an account's");
        }
        if (operationLife == null || staleAfter == null || cleanupEvery == null) {
            throw new IllegalStateException("wexy.worlds: operation-life, stale-after and cleanup-every are required");
        }
    }

    /** §11's proposals, for tests. */
    public static WorldProperties defaults() {
        return new WorldProperties(50, 100L * 1024 * 1024, 1024L * 1024 * 1024, 2, Duration.ofHours(24), Duration.ofMinutes(2),
                Duration.ofSeconds(15), 10, false);
    }
}
