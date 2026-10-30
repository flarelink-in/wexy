package ai.wexy.forge.agent;

/**
 * A turn's documentation counters (the agent-loop design §7; `wexy.agent.budget`): requests a round, requests a turn,
 * bytes of results a turn, and bytes of error detail a turn. They only grow, and never past their limits, so what is
 * left is never negative (A1; gate A of §15.1). Errors have their own allowance, so a request refused after the
 * documents are spent still says why, within a bound, rather than being charged to an empty budget or left free.
 */
public final class ToolBudget {

    /** Error detail a turn when none is given: room for about ten refusals, each at most {@link AgentTools#MAX_ERROR_BYTES}. */
    public static final int DEFAULT_ERROR_BYTES = 4_096;

    private final int perRound;
    private final int maxRequests;
    private final int maxBytes;
    private final int maxErrorBytes;
    private int requests;
    private int bytes;
    private int errorBytes;

    public ToolBudget(int perRound, int maxRequests, int maxBytes) {
        this(perRound, maxRequests, maxBytes, DEFAULT_ERROR_BYTES);
    }

    public ToolBudget(int perRound, int maxRequests, int maxBytes, int maxErrorBytes) {
        if (perRound < 1 || maxRequests < 1 || maxBytes < 1 || maxErrorBytes < 1) {
            throw new IllegalArgumentException("A tool budget needs positive limits, not " + perRound + ", " + maxRequests + ", "
                    + maxBytes + ", " + maxErrorBytes);
        }
        this.perRound = perRound;
        this.maxRequests = maxRequests;
        this.maxBytes = maxBytes;
        this.maxErrorBytes = maxErrorBytes;
    }

    public int perRound() {
        return perRound;
    }

    public int maxRequests() {
        return maxRequests;
    }

    public int maxBytes() {
        return maxBytes;
    }

    public int requestsLeft() {
        return maxRequests - requests;
    }

    public int bytesLeft() {
        return maxBytes - bytes;
    }

    public int errorBytesLeft() {
        return maxErrorBytes - errorBytes;
    }

    void request() {
        if (requests < maxRequests) {
            requests++;
        }
    }

    void spend(int n) {
        bytes = Math.min(maxBytes, bytes + Math.max(0, n));
    }

    /** Charges an error's detail if it fits what is left; false, with nothing charged, when it does not. */
    boolean chargeError(int n) {
        if (n > errorBytesLeft()) {
            return false;
        }
        errorBytes += Math.max(0, n);
        return true;
    }
}
