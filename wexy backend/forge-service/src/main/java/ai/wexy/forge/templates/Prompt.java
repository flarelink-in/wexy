package ai.wexy.forge.templates;

import ai.wexy.forge.upstream.ChatMessage;

import java.util.List;

/**
 * One call's messages (forge-loop design §2: M), with what the record and the cache must know about
 * how they were made. The system message is the template's static part, identical for every call of
 * that template (P9), so Meta's prompt cache serves it; the user message carries the request.
 *
 * @param templateId     the template that built it, e.g. {@code author.evolve.v1}
 * @param hostVersion    the host contract it describes, e.g. {@code h1}
 * @param messages       system, then user
 * @param responseSchema the schema the answer must match ({@code scene-draft.v1}, {@code edit-plan.v1}),
 *                       or null when the answer is a function's text
 */
public record Prompt(String templateId, String hostVersion, List<ChatMessage> messages, String responseSchema) {

    public Prompt {
        messages = List.copyOf(messages);
    }

    public String system() {
        return messages.get(0).content();
    }

    public String user() {
        return messages.get(1).content();
    }
}
