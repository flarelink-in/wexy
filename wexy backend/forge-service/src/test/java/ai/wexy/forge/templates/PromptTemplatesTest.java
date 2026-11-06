package ai.wexy.forge.templates;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** U2: the templates load at startup, every configured role has its own, and a broken one stops the service. */
class PromptTemplatesTest {

    /** The roles the shipped configuration binds (application.yaml). */
    static final Set<String> ROLES = Set.of("agent", "module", "review", "paper");
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
        assertThat(templates.all()).extracting(PromptTemplates.Template::name).containsExactlyInAnyOrder(
                "agent", "module.author", "module.repair", "review", "paper");
        for (PromptTemplates.Template t : templates.all()) {
            assertThat(t.system()).as(t.id()).doesNotContain("{{").doesNotContain("<!-- wexy prompt:").isNotBlank();
            assertThat(t.user()).as(t.id()).isNotBlank();
        }
    }

    @Test
    void aMissingTemplateStopsStartupAndNamesThePathItExpected() {
        assertThatThrownBy(() -> at("missing", Set.of("agent", "module")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("classpath:prompts-test/missing/module.author.v<n>.md");
    }

    @Test
    void aRoleNoTemplateServesStopsStartup() {
        assertThatThrownBy(() -> at("missing", Set.of("agent", "bench")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Role 'bench'");
    }

    @Test
    void theHighestVersionIsTheOneLoaded() {
        PromptTemplates.Template planner = at("versions", Set.of("agent")).get("agent");
        assertThat(planner.id()).isEqualTo("agent.v2");
        assertThat(planner.system()).isEqualTo("Plan a world, the second way.");
    }

    @Test
    void aFirstLineThatDoesNotMatchItsFileStopsStartup() {
        assertThatThrownBy(() -> at("bad-id", Set.of("agent")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("prompts-test/bad-id/agent.v1.md must open with the line <!-- wexy prompt: agent v1 -->");
    }

    @Test
    void aPlaceholderNothingCanFillStopsStartup() {
        assertThatThrownBy(() -> at("unknown-static", Set.of("agent")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("agent.v1.md (static part) uses {{nope}}");
        assertThatThrownBy(() -> at("unknown-field", Set.of("agent")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("uses {{code}} in its variable part, which a agent request cannot fill");
    }

    @Test
    void aTemplateWithoutItsSplitLineStopsStartup() {
        assertThatThrownBy(() -> at("no-split", Set.of("agent")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("has no line '---'");
    }

    /**
     * The sizes for the design's Results: each system message (cached after the first call) and a
     * sample user message, in characters and in the meter's own estimate (three characters a token,
     * so above what the model will report).
     */
}
