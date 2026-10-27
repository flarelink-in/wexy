package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;

import java.util.Set;
import java.util.TreeSet;

/**
 * {@code POST /v1/forge/plan} (forge-loop design §5.1): a creator's idea, the style they chose and
 * the film's length. Nothing else a client sends reaches a model (I4).
 */
public record PlanRequest(String prompt, String style, Integer seconds) {

    static final Set<String> STYLES = Set.of("cinematic", "anime-cel", "cosmic", "brutalist", "auto");

    /** The request as the planner gets it, or the refusal: too long is 413, anything else wrong is 400. */
    PlanRequest validated(LoopProperties.Caps caps) {
        if (prompt == null || prompt.isBlank()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The request needs a prompt.");
        }
        if (prompt.codePointCount(0, prompt.length()) > caps.promptChars()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "The prompt is longer than " + caps.promptChars() + " characters.");
        }
        if (style == null || !STYLES.contains(style)) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The style must be one of " + new TreeSet<>(STYLES) + ".");
        }
        if (seconds == null || seconds < caps.minSeconds() || seconds > caps.maxSeconds()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST,
                    "seconds must be between " + caps.minSeconds() + " and " + caps.maxSeconds() + ".");
        }
        return new PlanRequest(prompt.strip(), style, seconds);
    }
}
