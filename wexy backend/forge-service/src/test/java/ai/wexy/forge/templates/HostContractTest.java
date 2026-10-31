package ai.wexy.forge.templates;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Host h1 as the model sees it and as the browser compiles it agree, and the exemplars keep the rules
 * they teach (forge-loop design §5.5). Whether the exemplars compile and run is checked on a GPU,
 * under Dawn, outside Maven (the design's Results, B0.1); FE1 makes that check permanent.
 */
class HostContractTest {

    private static final HostContract HOST = new HostContract();
    private static final Pattern HELPER = Pattern.compile("^fn ([a-z][a-z0-9_]*)\\(([^)]*)\\)\\s*->\\s*([A-Za-z0-9<>]+)", Pattern.MULTILINE);
    private static final Pattern CONSTANT = Pattern.compile("^const [A-Z]+: f32 = [0-9.]+;$", Pattern.MULTILINE);

    @Test
    void everyFunctionHasTwoExemplarsAndEachIsAWholeFunction() {
        for (String fn : HostContract.FUNCTIONS) {
            assertThat(HOST.exemplars(fn)).as(fn).hasSizeGreaterThanOrEqualTo(2);
            for (HostContract.Exemplar e : HOST.exemplars(fn)) {
                assertThat(e.code()).as(e.world() + "." + fn).startsWith("fn " + fn + "(").endsWith("}");
            }
        }
    }

    /** An exemplar that breaks a rule teaches the model to break it. */
    @Test
    void theExemplarsKeepTheRulesTheyTeach() {
        Pattern forBound = Pattern.compile("for\\s*\\([^;]*;[^;<]*<=?\\s*([^;]+);");
        for (String fn : HostContract.FUNCTIONS) {
            for (HostContract.Exemplar e : HOST.exemplars(fn)) {
                String name = e.world() + "." + fn;
                assertThat(e.code().split("\n")).as(name + ": at most 40 lines").hasSizeLessThanOrEqualTo(40);
                assertThat(e.code()).as(name + ": no loop or while").doesNotContainPattern("\\b(loop|while)\\b");
                assertThat(e.code()).as(name + ": no attributes, bindings or address spaces").doesNotContain("@").doesNotContain("var<");
                assertThat(e.code()).as(name + ": no GLSL").doesNotContainPattern("\\b(mod|vec3|float)\\s*\\(");
                Matcher loop = forBound.matcher(e.code());
                while (loop.find()) {
                    assertThat(loop.group(1).strip()).as(name + ": a literal bound").matches("[0-9]+u?");
                    assertThat(Integer.parseInt(loop.group(1).strip().replace("u", ""))).as(name + ": bound at most 32").isLessThanOrEqualTo(32);
                }
            }
        }
    }

    /** Every helper the model is told about exists, with the same signature, and none is hidden. */
    @Test
    void bothViewsListEveryHelperWithItsSignature() {
        Map<String, String> library = signatures(HOST.helpers(), true);
        assertThat(library).containsKeys("hash11", "hash31", "noise3", "fbm3", "curl3", "palette", "rot_axis", "qmul", "qrot",
                "smin", "sd_sphere", "sd_box", "sd_torus", "ease_in", "ease_out", "ease_in_out");
        assertThat(signatures(HOST.particles(), false)).isEqualTo(library);
        assertThat(signatures(HOST.sky(), false)).isEqualTo(library);
        assertThat(constants(HOST.particles())).isEqualTo(constants(HOST.helpers()));
        assertThat(constants(HOST.sky())).isEqualTo(constants(HOST.helpers()));
    }

    @Test
    void theViewsDeclareWhatTheFunctionsReceiveAndReturn() {
        assertThat(HOST.particles()).contains("struct Sim {", "struct Params {", "struct Particle {", "struct Look {",
                "fn evolve(p: Particle, i: u32) -> Particle", "fn look(p: Particle, i: u32) -> Look");
        assertThat(HOST.sky()).contains("struct Sim {", "struct Params {", "fn sky(dir: vec3f) -> vec3f");
        assertThat(HOST.contractFor("evolve")).isSameAs(HOST.particles());
        assertThat(HOST.contractFor("look")).isSameAs(HOST.particles());
        assertThat(HOST.contractFor("sky")).isSameAs(HOST.sky());
        assertThatThrownBy(() -> HOST.contractFor("arrange")).isInstanceOf(IllegalArgumentException.class);
        assertThat(HOST.version()).isEqualTo("h1");
    }

    /** name to "(parameters) -> return", whitespace collapsed; the library's own wx_ names are skipped. */
    private static Map<String, String> signatures(String wgsl, boolean library) {
        Map<String, String> found = new TreeMap<>();
        Matcher m = HELPER.matcher(wgsl);
        while (m.find()) {
            String name = m.group(1);
            if (name.startsWith("wx_") || (!library && HostContract.FUNCTIONS.contains(name))) {
                continue;
            }
            found.put(name, ("(" + m.group(2) + ") -> " + m.group(3)).replaceAll("\\s+", " "));
        }
        return found;
    }

    private static String constants(String wgsl) {
        StringBuilder out = new StringBuilder();
        Matcher m = CONSTANT.matcher(wgsl);
        while (m.find()) {
            out.append(m.group()).append('\n');
        }
        return out.toString();
    }
}
