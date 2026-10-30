package ai.wexy.common;

/**
 * What the gateway and forge-service must agree on about an agent turn (the agent-loop design §5.5, §10; Q66, Q67).
 * The gateway charges a turn {@link #MAX_CALLS} tokens of its buckets, one a possible model call; the service never
 * lets a turn make more calls than that. One constant for both, so the two cannot drift.
 */
public final class AgentTurn {

    /** The most model calls one turn may make, and what a turn costs in the gateway's agent buckets. */
    public static final int MAX_CALLS = 6;

    /**
     * The most characters (UTF-16 units, as both sides count a string) one event's data may carry on the turn's stream:
     * the frontend's SSE parser stops reading past it. The schema bounds a design's strings but not their escaping, and
     * a program's whole can pass a megabyte, so the service hands off nothing that would not fit (EA2.5's review).
     */
    public static final int MAX_EVENT_CHARS = 262_144;

    private AgentTurn() {
    }
}
