package ai.wexy.forge.agent;

import ai.wexy.common.AgentTurn;

import java.util.ArrayList;
import java.util.List;

/**
 * A turn's budgets (the agent-loop design §5.5, decided as Q67): the loop checks every one before each call, and
 * none resets inside a turn (A1). Each is checked when made, so a configuration out of bounds stops the service at
 * startup (gate A): every value is positive, but revisions and repairs, which may be none, and a turn makes at most
 * {@link AgentTurn#MAX_CALLS} calls, what the gateway's agent buckets charge it.
 *
 * @param calls         model calls in all, repairs and revisions included
 * @param contextRounds {@code need_context} rounds whose reads run
 * @param perRound      reads a round
 * @param toolRequests  reads a turn
 * @param docBytes      bytes of read results a turn
 * @param revisions     revise rounds after a failed check
 * @param schemaRepairs answers that may miss the action schema before the turn fails
 * @param turnMicroUsd  what the turn may spend: spent so far plus the next call's bound
 * @param turnSeconds   the turn's time
 * @param promptBytes   the largest prompt a call may send
 */
public record AgentBudget(int calls, int contextRounds, int perRound, int toolRequests, int docBytes, int revisions,
                          int schemaRepairs, long turnMicroUsd, long turnSeconds, int promptBytes) {

    public AgentBudget {
        if (calls > AgentTurn.MAX_CALLS) {
            throw new IllegalArgumentException("wexy.agent.budget.calls: a turn makes at most " + AgentTurn.MAX_CALLS
                    + " model calls, what the gateway's agent buckets charge it, not " + calls);
        }
        List<String> wrong = new ArrayList<>();
        atLeast(wrong, "calls", calls, 1);
        atLeast(wrong, "context-rounds", contextRounds, 1);
        atLeast(wrong, "per-round", perRound, 1);
        atLeast(wrong, "tool-requests", toolRequests, 1);
        atLeast(wrong, "doc-bytes", docBytes, 1);
        atLeast(wrong, "revisions", revisions, 0);
        atLeast(wrong, "schema-repairs", schemaRepairs, 0);
        atLeast(wrong, "turn-micro-usd", turnMicroUsd, 1);
        atLeast(wrong, "turn-seconds", turnSeconds, 1);
        atLeast(wrong, "prompt-bytes", promptBytes, 1);
        if (!wrong.isEmpty()) {
            throw new IllegalArgumentException("wexy.agent.budget: every value is positive (revisions and schema-repairs may be 0), "
                    + "not " + String.join(", ", wrong));
        }
    }

    /** Q67's values. */
    public static AgentBudget defaults() {
        return new AgentBudget(AgentTurn.MAX_CALLS, 2, 6, 8, 65_536, 2, 2, 1_000_000L, 600L, 196_608);
    }

    private static void atLeast(List<String> wrong, String name, long value, long least) {
        if (value < least) {
            wrong.add(name + " " + value);
        }
    }

    /** The budgets as the model reads them, in the template's user part. */
    String describe() {
        return calls + " model calls in all; " + contextRounds + " rounds of need_context, " + toolRequests + " reads and "
                + docBytes / 1024 + " KiB of documents in all; " + revisions + " revisions after the host's check.";
    }
}
