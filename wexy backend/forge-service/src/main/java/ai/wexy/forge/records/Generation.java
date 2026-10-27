package ai.wexy.forge.records;

import java.time.Instant;

/**
 * One model call, whatever became of it (forge-loop design §5.3; backend §5.1's {@code generation}
 * row, column for column): what was asked, by whom, from which template and host contract, what
 * came back, what it cost and how long it took. Every call is one, denied, cancelled and failed ones
 * included (I5).
 *
 * @param input           the request's own fields as JSON (the creator's sentence, ids), never the prompt
 * @param output          the model's text, raw, as streamed; null until finished
 * @param chargedMicroUsd the upper bound charged before the call (0 when denied)
 * @param costMicroUsd    what the reported usage cost at the configured prices; null without usage
 * @param uid             the caller's Firebase uid (in memory only; B1 stores an HMAC)
 */
public record Generation(String id, Kind kind, String parentId, String role, String model, String promptVersion,
                         String hostVersion, String fn, String input, String output, Long tokensIn, Long tokensOut,
                         Long tokensReasoning, long chargedMicroUsd, Long costMicroUsd, Long ttftMs, Long latencyMs,
                         Status status, Source source, String uid, Instant createdAt) {

    public enum Kind { PLAN, AUTHOR, REPAIR, DIRECT }

    public enum Status { RUNNING, OK, ERROR, TIMEOUT, CANCELLED, DENIED }

    /** Whose call it was, so the evidence is split by source (coding principles §3). */
    public enum Source { USER, BENCH, DEMO }

    /** A call about to be charged: everything known before the model answers. */
    public static Generation started(String id, Kind kind, String parentId, String role, String model, String promptVersion,
                                     String hostVersion, String fn, String input, Source source, String uid, Instant createdAt) {
        return new Generation(id, kind, parentId, role, model, promptVersion, hostVersion, fn, input, null, null, null,
                null, 0, null, null, null, Status.RUNNING, source, uid, createdAt);
    }

    /**
     * How a call ended.
     *
     * @param output the raw text, or what had arrived
     */
    public record Finish(String output, Long tokensIn, Long tokensOut, Long tokensReasoning, long chargedMicroUsd,
                         Long costMicroUsd, Long ttftMs, Long latencyMs, Status status) {
    }

    Generation finished(Finish f) {
        return new Generation(id, kind, parentId, role, model, promptVersion, hostVersion, fn, input, f.output(),
                f.tokensIn(), f.tokensOut(), f.tokensReasoning(), f.chargedMicroUsd(), f.costMicroUsd(), f.ttftMs(),
                f.latencyMs(), f.status(), source, uid, createdAt);
    }
}
