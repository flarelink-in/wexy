package ai.wexy.forge.agent;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * How a turn ended (the agent-loop design §2).
 *
 * @param code         for EXHAUSTED the budget's diagnostic ({@code EA_TURN_BUDGET}, {@code EA_CONTEXT_LIMIT}); for
 *                     FAILED and DENIED an {@code ErrorCode} ({@code upstream}, {@code budget}…), or {@code finished}
 *                     when the model gave up; null otherwise
 * @param design       the checked design (HANDED_OFF)
 * @param program      the checked program (HANDED_OFF)
 * @param repairs      the checked notes to the program's modules (HANDED_OFF; agent-action.v3, EA6.3): a list, empty
 *                     when there are none, and always empty in a first turn
 * @param question     the model's question (ASKED)
 * @param calls        model calls made
 * @param costMicroUsd what they cost, as their usage reported
 */
public record AgentOutcome(Status status, String code, String reason, JsonNode design, JsonNode program, JsonNode repairs,
                           String question, int calls, long costMicroUsd) {

    public enum Status { HANDED_OFF, ASKED, EXHAUSTED, FAILED, CANCELLED, DENIED }
}
