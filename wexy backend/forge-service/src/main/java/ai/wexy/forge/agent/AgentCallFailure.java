package ai.wexy.forge.agent;

/**
 * A call that did not answer. {@code code} is one of {@code ErrorCode}'s ({@code budget}, {@code paused},
 * {@code upstream}, {@code timeout}, {@code internal}), {@code cancelled} when the client left mid-call, or
 * {@code deadline} when the turn's time ran out before or during it.
 */
public final class AgentCallFailure extends RuntimeException {

    private final String code;

    public AgentCallFailure(String code, String message) {
        super(message, null, false, false);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
