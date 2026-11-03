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

    /**
     * The most modules one candidate builds: the frontend's Q_C (its candidate-loop design §8; Q84, revised 2026-11-02
     * from 4 after the black hole starter needed about eight). Each compute stage, custom batch and fullscreen pass names a
     * module of its own, so the turn's check holds a program that names more, and the turn's own revision merges or drops
     * parts, before the browser would refuse it with the turn already spent.
     */
    public static final int MAX_MODULES = 12;

    /**
     * The most module calls one candidate makes (Q_C: an author for each of {@link #MAX_MODULES} modules and ten repairs
     * in all), and so what one attempt takes from the gateway's agent-module buckets, a token a call.
     */
    public static final int MODULE_CALLS = 22;

    /**
     * The most reviews by a model one candidate asks for (EA6.4; the frontend's Q_C, its visual-review design §9.1): one
     * before each of its two visual rounds and one after the last, each a model call of its own, and so what one attempt
     * takes from the gateway's agent-review buckets, a token a review.
     */
    public static final int REVIEWS = 3;

    private AgentTurn() {
    }
}
