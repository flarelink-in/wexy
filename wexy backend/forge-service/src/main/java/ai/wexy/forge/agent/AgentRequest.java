package ai.wexy.forge.agent;

import ai.wexy.forge.loop.LoopProperties;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;

import java.util.Set;
import java.util.TreeSet;

/** Agent creation input, validated before admission or model calls (EA9.6). */
public record AgentRequest(String prompt, String style, Integer seconds) {

    static final Set<String> STYLES = Set.of("cinematic", "anime-cel", "cosmic", "brutalist", "auto");

    /** The request as the planner gets it, or the refusal: too long is 413, anything else wrong is 400. */
    public AgentRequest validated(LoopProperties.Caps caps) {
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
        return new AgentRequest(prompt.strip(), style, seconds);
    }
}
