package ai.wexy.forge.records;

import java.time.Instant;
import java.util.List;

/**
 * What one browser found when it verified and ran a world (forge-loop design §5.1; backend §5.1's
 * {@code outcome} row, one per generation in B1; here one report naming its generations). The
 * backend stores it and never runs anything: the evidence numbers (§8) are read from these.
 *
 * @param ladder the ladder's results and timings as the browser sent them, JSON text
 * @param uid    the reporting caller's Firebase uid (in memory only; B1 stores an HMAC)
 */
public record Outcome(String id, List<String> generationIds, String uid, String ladder, boolean firstPassOk, int repairs,
                      int autofixes, Double probeMs, Double predictedMs, Double fps, String adapter, String browser,
                      Instant createdAt) {

    public Outcome {
        generationIds = List.copyOf(generationIds);
    }
}
