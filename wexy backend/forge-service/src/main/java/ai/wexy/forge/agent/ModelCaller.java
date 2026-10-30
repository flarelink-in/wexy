package ai.wexy.forge.agent;

import ai.wexy.forge.upstream.ChatMessage;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * How the agent loop calls the model (the agent-loop design §3): through the metered client in a run (EA2.4), a script
 * in the tests. The loop asks the bound before each call, so a turn's money is checked before anything is reserved.
 */
public interface ModelCaller {

    /** What the call would reserve, in micro-USD: one token a prompt byte, plus the whole output cap. */
    long bound(List<ChatMessage> messages, Map<String, Object> responseFormat);

    /**
     * The {@code n}th call of the turn, from 1, with the whole answer once its stream ends. {@code charged} runs once the
     * meter has admitted the call and before anything streams; a refused call never runs it, so a turn refused at its
     * first call has said nothing, and the route can answer with a status rather than a stream (§5.4). {@code remaining}
     * is what is left of the turn's time: a call still running when it runs out is ended, with the code
     * {@code deadline}, so the turn's time is a deadline, not only a check before each call.
     *
     * @throws AgentCallFailure when the meter refuses it, upstream fails, a deadline passes or the client leaves
     */
    ModelAnswer call(int n, List<ChatMessage> messages, Map<String, Object> responseFormat, Runnable charged, Duration remaining);
}
