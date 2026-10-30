package ai.wexy.forge.agent;

/**
 * What one request gave: the block the model reads next ({@code <tool_result>} or {@code <tool_error>}), and its
 * summary for the turn's {@code tools} event (the agent-loop design §5.3, §5.4).
 *
 * @param target what it named: the document, the symbol or the query
 * @param error  why it was refused, in words the model can act on; null when it answered
 * @param bytes  what it took from the turn's document bytes (0 for an error)
 */
public record ToolResult(String tool, String target, boolean ok, String error, int bytes, String text) {
}
