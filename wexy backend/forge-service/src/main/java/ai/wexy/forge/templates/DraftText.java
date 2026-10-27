package ai.wexy.forge.templates;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A plan in words, as the author, repair and director prompts show it: the {@code Params} struct the
 * browser will declare, each control with its range, what each random number is for, and the world
 * in a few lines. Pure and deterministic: the same JSON always gives the same text (P8).
 *
 * <p>It reads a planner's draft ({@code scene-draft.v1}, controls as an array) and the studio's
 * {@code SceneSpec} 2.0 (controls as a map); both keep their controls in order, and that order is
 * the order of the struct's fields, which the browser's uniform buffer follows.
 */
final class DraftText {

    private static final List<String> RANDOM_NUMBERS = List.of("x", "y", "z", "w");

    private DraftText() {
    }

    /** One control: its WGSL field name, its label, and its range and starting value. */
    record Control(String name, String label, JsonNode value, JsonNode min, JsonNode max) {
    }

    static List<Control> controls(JsonNode world) {
        JsonNode uniforms = world.path("uniforms");
        List<Control> controls = new ArrayList<>();
        if (uniforms.isArray()) {
            for (JsonNode u : uniforms) {
                controls.add(new Control(u.path("name").asText(), u.path("label").asText(), u.path("value"), u.path("min"), u.path("max")));
            }
        } else if (uniforms.isObject()) {
            for (Map.Entry<String, JsonNode> e : (Iterable<Map.Entry<String, JsonNode>>) uniforms::fields) {
                JsonNode u = e.getValue();
                controls.add(new Control(e.getKey(), u.path("label").asText(), u.path("value"), u.path("min"), u.path("max")));
            }
        }
        return controls;
    }

    /** The struct the browser declares: one f32 per control, in order. */
    static String params(JsonNode world) {
        List<Control> controls = controls(world);
        StringBuilder out = new StringBuilder("struct Params {\n");
        if (controls.isEmpty()) {
            out.append("    _unused: f32,\n");
        }
        for (Control c : controls) {
            out.append("    ").append(c.name()).append(": f32,\n");
        }
        return out.append("};").toString();
    }

    /** The same struct on one line, for an example's caption. */
    static String paramsInline(JsonNode world) {
        List<String> fields = new ArrayList<>();
        for (Control c : controls(world)) {
            fields.add(c.name() + ": f32");
        }
        return "struct Params { " + (fields.isEmpty() ? "_unused: f32" : String.join(", ", fields)) + " };";
    }

    /** One line per control: where it is read, what the creator sees, its range and where it starts. */
    static String controlLines(JsonNode world) {
        List<String> lines = new ArrayList<>();
        for (Control c : controls(world)) {
            lines.add("- params." + c.name() + ", \"" + c.label() + "\": from " + number(c.min()) + " to " + number(c.max())
                    + ", starting at " + number(c.value()));
        }
        return String.join("\n", lines);
    }

    /** What the planner said each random number is for, with how it is drawn. */
    static String spawn(JsonNode draft) {
        JsonNode spawn = draft.path("particles").path("spawn");
        List<String> lines = new ArrayList<>();
        for (String axis : RANDOM_NUMBERS) {
            JsonNode d = spawn.path(axis);
            String how = d.path("dist").asText() + " from " + number(d.path("min")) + " to " + number(d.path("max"))
                    + (d.has("power") ? ", power " + number(d.path("power")) : "");
            lines.add("- p.b." + axis + ": " + d.path("use").asText() + " (" + how + ")");
        }
        lines.add("- p.phase starts " + ("random-angle".equals(spawn.path("phase").asText()) ? "at a random angle" : "at 0"));
        return String.join("\n", lines);
    }

    /** The plan's world in a few lines: name, summary, style, size, sky, camera. */
    static String world(JsonNode draft) {
        JsonNode particles = draft.path("particles");
        JsonNode keyframes = draft.path("camera").path("keyframes");
        JsonNode first = keyframes.path(0);
        JsonNode last = keyframes.path(Math.max(0, keyframes.size() - 1));
        return "Title: " + draft.path("title").asText() + "\n"
                + "Summary: " + draft.path("summary").asText() + "\n"
                + "Style: " + draft.path("style").asText() + "; " + particles.path("count").asText() + " particles; warm-up "
                + number(particles.path("warmupSeconds")) + " s; sky: " + draft.path("sky").asText() + "\n"
                + "Camera: looking at (" + vector(first.path("target")) + ") from " + number(first.path("distance"))
                + " to " + number(last.path("distance")) + " units away; move: " + draft.path("camera").path("move").asText("none");
    }

    /**
     * A running world, for the director: name, controls with their current values, the finish, the
     * camera, and each function's code. Fields it does not know are left out, never guessed.
     */
    static String spec(JsonNode spec) {
        StringBuilder out = new StringBuilder("Title: ").append(spec.path("title").asText()).append('\n');
        if (spec.hasNonNull("summary")) {
            out.append("Summary: ").append(spec.path("summary").asText()).append('\n');
        }
        out.append("Controls now:\n");
        for (Control c : controls(spec)) {
            out.append("- uniforms.").append(c.name()).append(", \"").append(c.label()).append("\" = ").append(number(c.value()))
                    .append(", from ").append(number(c.min())).append(" to ").append(number(c.max())).append('\n');
        }
        out.append("Finish (post): ").append(spec.path("post")).append('\n');
        out.append("Camera: ").append(spec.path("camera")).append('\n');
        JsonNode functions = spec.path("functions");
        for (String fn : HostContract.FUNCTIONS) {
            if (functions.hasNonNull(fn)) {
                out.append("\nfn ").append(fn).append(", as it runs:\n```wgsl\n").append(functions.get(fn).asText().stripTrailing()).append("\n```\n");
            }
        }
        return out.toString().stripTrailing();
    }

    /** A number as the plan wrote it: no exponent, no trailing zeros. */
    static String number(JsonNode n) {
        if (n.isIntegralNumber()) {
            return n.asText();
        }
        if (n.isNumber()) {
            return n.decimalValue().stripTrailingZeros().toPlainString();
        }
        return n.asText();
    }

    private static String vector(JsonNode v) {
        List<String> parts = new ArrayList<>();
        v.forEach(x -> parts.add(number(x)));
        return String.join(", ", parts);
    }
}
