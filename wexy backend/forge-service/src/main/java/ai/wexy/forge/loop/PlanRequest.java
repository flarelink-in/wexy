package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;

import java.util.Set;
import java.util.TreeSet;

/**
 * {@code POST /v1/forge/plan} (forge-loop design §5.1): a creator's idea, the style they chose and
 * the film's length. Nothing else a client sends reaches a model (I4).
 *
 * @param retryOf the plan this one replaces after the model failed it, its generation id (the W1 bug hunt, 2026-11-02:
 *                the studio's own retry, which runs inside that plan's prompt), or null for a first plan
 */
public record PlanRequest(String prompt, String style, Integer seconds, String retryOf) {

    static final Set<String> STYLES = Set.of("cinematic", "anime-cel", "cosmic", "brutalist", "auto");

    /** The request as the planner gets it, or the refusal: too long is 413, anything else wrong is 400. */
    public PlanRequest validated(LoopProperties.Caps caps) {
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
        if (retryOf != null && !DirectRequest.ULID.matcher(retryOf).matches()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "retryOf is the plan this one replaces, its generation id; leave it out for a first plan.");
        }
        return new PlanRequest(prompt.strip(), style, seconds, retryOf);
    }
}
