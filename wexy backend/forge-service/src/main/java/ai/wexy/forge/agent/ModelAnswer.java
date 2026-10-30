package ai.wexy.forge.agent;

/**
 * One call's answer: its record's id, its whole text, and what it used (null where the stream reported nothing).
 *
 * @param costMicroUsd what its usage cost at the configured prices; its reservation when no usage came
 */
public record ModelAnswer(String generationId, String text, String finishReason, Long promptTokens, Long completionTokens,
                          Long reasoningTokens, Long cachedTokens, long costMicroUsd) {
}
