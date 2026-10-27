package ai.wexy.forge.upstream;

/**
 * One event of a streamed completion.
 *
 * @param text         the text it adds; empty for a chunk that only reports usage or a finish
 * @param finishReason why the model stopped ({@code stop}, {@code length}, …), or null
 * @param usage        token counts, usually on the last chunk only, or null
 */
public record ChatChunk(String text, String finishReason, Usage usage) {

    /**
     * Token counts as the API reports them.
     *
     * @param reasoningTokens output tokens spent reasoning, when the API breaks them out; null
     *                        otherwise. Meta bills them as output, inside the cap (forge-loop §4.1)
     * @param cachedTokens    input tokens served from Meta's prompt cache, billed at the cached
     *                        price; null when not reported
     */
    public record Usage(long promptTokens, long completionTokens, long totalTokens, Long reasoningTokens,
                        Long cachedTokens) {
    }
}
