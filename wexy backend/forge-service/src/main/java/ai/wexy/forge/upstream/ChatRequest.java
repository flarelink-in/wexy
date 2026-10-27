package ai.wexy.forge.upstream;

import java.util.List;
import java.util.Map;

/**
 * One streamed chat completion, as Wexy asks for it.
 *
 * @param model            the model id
 * @param messages         the conversation, built from the service's own templates, never a
 *                         client's prompt (coding principles §2)
 * @param maxOutputTokens  the output cap, reasoning included, sent as {@code max_completion_tokens}
 * @param responseFormat   an OpenAI-style {@code response_format}, or null
 * @param reasoningEffort  Meta's {@code reasoning_effort}, or null to let the model choose
 * @param safetyIdentifier a stable hash of the caller, at most 64 characters, or null; Meta's
 *                         replacement for {@code user}
 */
public record ChatRequest(String model, List<ChatMessage> messages, int maxOutputTokens,
                          Map<String, Object> responseFormat, String reasoningEffort, String safetyIdentifier) {

    public ChatRequest {
        messages = List.copyOf(messages);
    }

    public ChatRequest(String model, List<ChatMessage> messages, int maxOutputTokens, Map<String, Object> responseFormat) {
        this(model, messages, maxOutputTokens, responseFormat, null, null);
    }
}
