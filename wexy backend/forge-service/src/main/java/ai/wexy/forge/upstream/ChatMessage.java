package ai.wexy.forge.upstream;

import java.util.Objects;

/** One message of a chat completion: {@code system}, {@code user} or {@code assistant}. */
public record ChatMessage(String role, String content) {

    public ChatMessage {
        Objects.requireNonNull(role, "role");
        Objects.requireNonNull(content, "content");
    }

    public static ChatMessage system(String content) {
        return new ChatMessage("system", content);
    }

    public static ChatMessage user(String content) {
        return new ChatMessage("user", content);
    }

    /** A turn the model already took, sent back so a loop's next call sees it (the agent loop). */
    public static ChatMessage assistant(String content) {
        return new ChatMessage("assistant", content);
    }
}
