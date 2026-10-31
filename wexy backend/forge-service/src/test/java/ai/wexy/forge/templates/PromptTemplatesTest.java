package ai.wexy.forge.templates;

import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.upstream.ChatMessage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** U2: the templates load at startup, every configured role has its own, and a broken one stops the service. */
class PromptTemplatesTest {

    /** The roles the shipped configuration binds (application.yaml). */
    static final Set<String> ROLES = Set.of("planner", "author", "repairer", "escalator", "director");
    private static final HostContract HOST = new HostContract();

    static PromptTemplates shipped() {
        return new PromptTemplates(ROLES, "classpath:prompts/", HOST, new PathMatchingResourcePatternResolver());
    }

    private static PromptTemplates at(String folder, Set<String> roles) {
        return new PromptTemplates(roles, "classpath:prompts-test/" + folder + "/", HOST, new PathMatchingResourcePatternResolver());
    }

    @Test
    void everyConfiguredRoleHasItsTemplatesAndEachSystemMessageIsComplete() {
        PromptTemplates templates = shipped();
        assertThat(templates.all()).extracting(PromptTemplates.Template::id).containsExactly(
                "author.evolve.v1", "author.look.v1", "author.sky.v1", "director.v1", "planner.v1", "repair.v1");
        for (PromptTemplates.Template t : templates.all()) {
            assertThat(t.system()).as(t.id()).doesNotContain("{{").doesNotContain("<!--").isNotBlank();
            assertThat(t.user()).as(t.id()).isNotBlank();
        }
        // The author's view, rules and examples are in its system message, so the cache holds them.
        PromptTemplates.Template evolve = templates.get("author.evolve");
        assertThat(evolve.system()).contains("struct Particle {", "At most 40 lines.", "Example 1, from \"Spiral Galaxy\"",
                "Example 2, from \"Thunderhead\"", "fn evolve(p: Particle, i: u32) -> Particle {\n    // b.x orbit radius");
        assertThat(templates.get("author.sky").system()).contains("fn sky(dir: vec3f) -> vec3f").doesNotContain("struct Particle {");
        assertThat(templates.get("repair").system()).contains("struct Particle {", "fn sky(dir: vec3f) -> vec3f");
        assertThat(templates.get("planner").system()).contains("\"title\": \"Spiral Galaxy\"", "\"title\": \"Thunderhead\"");
        assertThat(templates.get("director").system()).contains("\"path\": \"post.bloom.intensity\"");
    }

    @Test
    void aMissingTemplateStopsStartupAndNamesThePathItExpected() {
        assertThatThrownBy(() -> at("missing", Set.of("planner", "author")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("classpath:prompts-test/missing/author.evolve.v<n>.md");
    }

    @Test
    void aRoleNoTemplateServesStopsStartup() {
        assertThatThrownBy(() -> at("missing", Set.of("planner", "bench")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Role 'bench'");
    }

    @Test
    void theHighestVersionIsTheOneLoaded() {
        PromptTemplates.Template planner = at("versions", Set.of("planner")).get("planner");
        assertThat(planner.id()).isEqualTo("planner.v2");
        assertThat(planner.system()).isEqualTo("Plan a world, the second way.");
    }

    @Test
    void aFirstLineThatDoesNotMatchItsFileStopsStartup() {
        assertThatThrownBy(() -> at("bad-id", Set.of("planner")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("prompts-test/bad-id/planner.v1.md must open with the line <!-- wexy prompt: planner v1 -->");
    }

    @Test
    void aPlaceholderNothingCanFillStopsStartup() {
        assertThatThrownBy(() -> at("unknown-static", Set.of("planner")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("planner.v1.md (static part) uses {{nope}}");
        assertThatThrownBy(() -> at("unknown-field", Set.of("planner")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("uses {{code}} in its variable part, which a planner request cannot fill");
    }

    @Test
    void aTemplateWithoutItsSplitLineStopsStartup() {
        assertThatThrownBy(() -> at("no-split", Set.of("planner")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("has no line '---'");
    }

    /**
     * The sizes for the design's Results: each system message (cached after the first call) and a
     * sample user message, in characters and in the meter's own estimate (three characters a token,
     * so above what the model will report).
     */
    @Test
    void printTheTemplateSizes() throws Exception {
        PromptBuilder builder = new PromptBuilder(shipped());
        JsonNode galaxy = new ObjectMapper().readTree(new ClassPathResource("mock/plans/galaxy.json").getContentAsString(StandardCharsets.UTF_8));
        List<Prompt> samples = List.of(
                builder.plan("two galaxies colliding, blue and gold", "cosmic", 12),
                builder.author("evolve", "a spiral galaxy", galaxy),
                builder.author("look", "a spiral galaxy", galaxy),
                builder.author("sky", "a spiral galaxy", galaxy),
                builder.repair("evolve", galaxy, HOST.exemplars("evolve").get(0).code(),
                        List.of(new Diagnostic("tint", 11, 25, "type mismatch for argument 1 in call to 'hash11', expected 'f32', got 'u32'",
                                "let jitter = hash11(i) * 0.02;")), 1),
                builder.direct(galaxy, "make it glow more"));
        System.out.println("template            system chars  system tokens (bound)  sample user chars");
        for (Prompt p : samples) {
            long tokens = ModelCatalog.inputTokenBound(List.of(ChatMessage.system(p.system())));
            System.out.printf("%-20s %12d %22d %18d%n", p.templateId(), p.system().length(), tokens, p.user().length());
            assertThat(p.system().length()).isPositive();
        }
    }
}
