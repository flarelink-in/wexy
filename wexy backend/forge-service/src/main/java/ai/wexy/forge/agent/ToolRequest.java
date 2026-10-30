package ai.wexy.forge.agent;

/**
 * One documentation request of a {@code need_context} action, with the action's typed fields (the agent-loop design
 * §5.2): each is null when its tool does not use it, so a request needs no parsing of free text.
 *
 * @param tool      {@code read_doc}, {@code inspect_api}, {@code search_docs} or {@code read_example}
 * @param docId     a bundled document's id ({@code api/post}, {@code example/instancing})
 * @param symbolId  an export as {@code family:Name}
 * @param query     the words to search for
 * @param family    a family to search within, or null for every document
 * @param startLine the first line of a read, from 1; null for the first
 * @param lineCount how many lines, 1 to 160; null for 160
 * @param why       the model's reason, kept for the record and never acted on
 */
public record ToolRequest(String tool, String docId, String symbolId, String query, String family,
                          Integer startLine, Integer lineCount, String why) {
}
