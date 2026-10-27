package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;

/**
 * {@code POST /v1/forge/direct} (forge-loop design §5.1): the world as the studio runs it, and the
 * creator's instruction about it. The spec is parsed and shown to the director in words
 * ({@code DraftText.spec}), never interpreted here; the turn is data, quoted into the prompt (I4).
 */
public record DirectRequest(JsonNode spec, String turn) {

    /** The request as the director gets it, or the refusal: over a cap is 413, anything else wrong is 400. */
    DirectRequest validated(LoopProperties.Caps caps) {
        if (turn == null || turn.isBlank()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a turn.");
        }
        if (turn.codePointCount(0, turn.length()) > caps.turnChars()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "The turn is longer than " + caps.turnChars() + " characters.");
        }
        if (spec == null || !spec.isObject()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a spec object.");
        }
        if (spec.toString().getBytes(StandardCharsets.UTF_8).length > caps.specBytes()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "The spec is larger than " + caps.specBytes() + " bytes.");
        }
        return new DirectRequest(spec, turn.strip());
    }
}
