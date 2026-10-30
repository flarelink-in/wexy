package ai.wexy.forge.agent;

import java.util.Map;

/**
 * One event of a turn's stream (the agent-loop design §5.4): {@code call}, {@code usage}, {@code tools}, {@code check},
 * {@code design}, {@code program} or {@code question}, in the order they happen. The route adds {@code meta} first and
 * {@code done} or {@code error} last, from the outcome.
 */
public record AgentEvent(String name, Map<String, Object> data) {
}
