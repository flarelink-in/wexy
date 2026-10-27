package ai.wexy.forge.templates;

import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.upstream.ChatMessage;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Builds every message a model receives, from the templates and the request (forge-loop design §6).
 * Pure and deterministic: no clock, no randomness, no map whose order can change, so the same
 * request, template and host contract always give the same bytes (P8), and every call of one
 * template shares its system message byte for byte (P9).
 *
 * <p>Nothing a client sends becomes instructions (I4, coding principles §2). A creator's sentence or
 * turn is inserted as a JSON string, quoted and escaped, after the template's own text; the
 * templates call it data. Values are inserted in one pass and never scanned again, so text that
 * looks like a placeholder stays text.
 */
@Component
public class PromptBuilder {

    private final PromptTemplates templates;
    private final ObjectMapper json = new ObjectMapper();

    public PromptBuilder(PromptTemplates templates) {
        this.templates = templates;
    }

    /** The planner's call: a creator's idea, the style they chose, the film's length. */
    public Prompt plan(String idea, String style, int seconds) {
        return build("planner", Map.of("idea", quoted(idea), "style", style, "seconds", Integer.toString(seconds)),
                JsonSchemas.SCENE_DRAFT);
    }

    /** One author call: one function for the world a plan describes. */
    public Prompt author(String fn, String idea, JsonNode draft) {
        return build("author." + known(fn), Map.of(
                "idea", quoted(idea),
                "world", DraftText.world(draft),
                "spawn", DraftText.spawn(draft),
                "params", DraftText.params(draft),
                "controls", DraftText.controlLines(draft)), null);
    }

    /**
     * A repair: the function as the browser tried it (from the store, never from the client), what
     * the checks found, and which attempt of three this is. The repairer and the escalator share it.
     */
    public Prompt repair(String fn, JsonNode draft, String code, List<Diagnostic> diagnostics, int attempt) {
        return build("repair", Map.of(
                "fn", known(fn),
                "attempt", Integer.toString(attempt),
                "params", DraftText.params(draft),
                "code", code.stripTrailing(),
                "diagnostics", findings(diagnostics)), null);
    }

    /** The director's call: the world as it runs, and the creator's instruction. */
    public Prompt direct(JsonNode spec, String turn) {
        return build("director", Map.of("world", DraftText.spec(spec), "turn", quoted(turn)), JsonSchemas.EDIT_PLAN);
    }

    private Prompt build(String name, Map<String, String> fields, String responseSchema) {
        PromptTemplates.Template template = templates.get(name);
        String user = PromptTemplates.fillAll(template.user(), fields, template.path() + " (variable part)");
        return new Prompt(template.id(), HostContract.VERSION,
                List.of(ChatMessage.system(template.system()), ChatMessage.user(user)), responseSchema);
    }

    private static String known(String fn) {
        if (!HostContract.FUNCTIONS.contains(fn)) {
            throw new IllegalArgumentException("No function '" + fn + "'; known: " + HostContract.FUNCTIONS);
        }
        return fn;
    }

    private static String findings(List<Diagnostic> diagnostics) {
        List<String> lines = new ArrayList<>();
        for (Diagnostic d : diagnostics) {
            String place = d.line() > 0 ? " line " + d.line() + (d.column() > 0 ? ", column " + d.column() : "") + ":" : "";
            lines.add("- [" + d.source() + "]" + place + " " + d.message());
            if (d.snippet() != null && !d.snippet().isBlank()) {
                lines.add("    " + d.snippet().strip());
            }
        }
        return String.join("\n", lines);
    }

    /** A creator's text as a JSON string: quoted, escaped, unmistakably data. */
    private String quoted(String text) {
        try {
            return json.writeValueAsString(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("A string always serializes", e);
        }
    }
}
