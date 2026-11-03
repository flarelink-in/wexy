package ai.wexy.forge.upstream;

import java.util.List;
import java.util.Objects;

/**
 * One message of a chat completion: {@code system}, {@code user} or {@code assistant}.
 *
 * <p>A user message may carry images after its text (EA6.4, the frontend's visual-review design §9.1): each a JPEG the
 * service checked and holds in memory for the one call, sent as a data URL, never a remote URL, and never written to a
 * record or a log. Meta takes images in user messages only, so no other role may carry one.
 */
public record ChatMessage(String role, String content, List<Image> images) {

    /**
     * A JPEG for the model to look at, with the most input tokens it may bill: the reservation adds that bound to the
     * text's ({@code ModelCatalog.inputTokenBound}), since a provider's image cost has no published formula and an image
     * charged as free is the unsafe side.
     *
     * @param jpeg        the bytes, checked by the caller to be a JPEG
     * @param boundTokens the most input tokens this image may bill; positive
     */
    public record Image(byte[] jpeg, long boundTokens) {

        public Image {
            Objects.requireNonNull(jpeg, "jpeg");
            if (jpeg.length == 0) {
                throw new IllegalArgumentException("An image has bytes.");
            }
            if (boundTokens <= 0) {
                throw new IllegalArgumentException("An image's token bound must be positive: an unbounded image would be charged as free.");
            }
        }
    }

    public ChatMessage {
        Objects.requireNonNull(role, "role");
        Objects.requireNonNull(content, "content");
        images = images == null ? List.of() : List.copyOf(images);
        if (!images.isEmpty() && !"user".equals(role)) {
            throw new IllegalArgumentException("Only a user message carries images (Meta's image understanding), not a " + role + " message.");
        }
    }

    public ChatMessage(String role, String content) {
        this(role, content, List.of());
    }

    public static ChatMessage system(String content) {
        return new ChatMessage("system", content);
    }

    public static ChatMessage user(String content) {
        return new ChatMessage("user", content);
    }

    /** A user message whose text is followed by images, in order (EA6.4). */
    public static ChatMessage user(String content, List<Image> images) {
        return new ChatMessage("user", content, images);
    }

    /** A turn the model already took, sent back so a loop's next call sees it (the agent loop). */
    public static ChatMessage assistant(String content) {
        return new ChatMessage("assistant", content);
    }
}
