package ai.wexy.forge.agent;

/** A turn's request, as `POST /v1/agent/turn` takes it (the agent-loop design §5.1), already within its caps. */
public record AgentRequest(String prompt, String style, int seconds) {
}
