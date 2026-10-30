package ai.wexy.forge.loop;

import ai.wexy.forge.templates.WgslWords;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * What a plan must be beyond its schema, so a draft that would fail the browser's first rung never
 * reaches the studio as {@code done}: control names unique, never {@code quality} (the host's own),
 * never a WGSL reserved word (they become struct fields), and each control's range sound.
 *
 * <p>The reserved words are those Dawn refused as identifiers on 2026-10-27 (forge-loop design,
 * Results, B0.1), plus WGSL's own keywords, all that a control's name pattern can produce.
 */
final class DraftChecks {

    /** One set for the backend: the agent's module names refuse the same words. */
    static final Set<String> RESERVED = WgslWords.RESERVED;

    private DraftChecks() {
    }

    static List<String> problems(JsonNode draft) {
        List<String> problems = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        JsonNode uniforms = draft.path("uniforms");
        for (int i = 0; i < uniforms.size(); i++) {
            JsonNode u = uniforms.get(i);
            String name = u.path("name").asText();
            String at = "$.uniforms[" + i + "]";
            if (!seen.add(name)) {
                problems.add(at + ".name: '" + name + "' is used twice");
            }
            if (RESERVED.contains(name)) {
                problems.add(at + ".name: '" + name + "' is reserved");
            }
            double min = u.path("min").asDouble();
            double max = u.path("max").asDouble();
            double value = u.path("value").asDouble();
            if (!(min < max)) {
                problems.add(at + ": min " + min + " is not below max " + max);
            } else if (value < min || value > max) {
                problems.add(at + ".value: " + value + " is outside [" + min + ", " + max + "]");
            }
        }
        return problems;
    }
}
