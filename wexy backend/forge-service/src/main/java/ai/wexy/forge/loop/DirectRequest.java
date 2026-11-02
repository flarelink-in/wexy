package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * {@code POST /v1/forge/direct} (forge-loop design §5.1): the world as the studio runs it, and the
 * creator's instruction about it. The spec is parsed and shown to the director in words
 * ({@code DraftText.spec}), never interpreted here; the turn is data, quoted into the prompt (I4).
 *
 * <p>W1 (2026-11-02; the creations platform design §10, §11): {@code planId} may name the plan whose
 * world the turn edits, its generation id, so the turn runs inside that plan's prompt. Only its
 * shape is checked here; whether the caller has that plan is the allowance's to judge. A turn
 * without one spends a prompt of its own.
 *
 * @param planId the plan whose world this edits, or null when the turn names none
 */
public record DirectRequest(JsonNode spec, String turn, String planId) {

    /** A generation id: a ULID, as the stream's meta named it. */
    static final Pattern ULID = Pattern.compile("[0-9A-HJKMNP-TV-Z]{26}");

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
        if (planId != null && !ULID.matcher(planId).matches()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "planId is the plan whose world this edits, its generation id; leave it out for a world no plan made.");
        }
        return new DirectRequest(spec, turn.strip(), planId);
    }
}
