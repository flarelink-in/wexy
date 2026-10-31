package ai.wexy.forge.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The embedded engine bundle is the frontend's, whole: its manifest recomputed, and a changed copy refused. */
class EngineBundleTest {

    private final ObjectMapper json = new ObjectMapper();

    private Map<String, String> texts() throws Exception {
        Map<String, String> texts = new LinkedHashMap<>();
        for (String name : EngineBundle.FILES) {
            texts.put(name, new ClassPathResource("engine/" + name).getContentAsString(StandardCharsets.UTF_8));
        }
        return texts;
    }

    @Test
    void theEmbeddedBundleIsWholeAndCarriesTheIndexAndTheDocuments() throws Exception {
        EngineBundle bundle = EngineBundle.load(json);

        assertThat(EngineBundle.problems(texts(), json)).isEmpty();
        assertThat(bundle.engineVersion()).isEqualTo("1.2.0");
        assertThat(bundle.bundleHash()).matches("[0-9a-f]{64}");
        assertThat(bundle.docsSource()).startsWith("null-graph@");
        assertThat(bundle.familyIndex()).contains("## core · null-graph ·").contains("## post · null-graph/post ·");
        assertThat(bundle.doc("agent/guide").text()).contains("NullGraph");
        assertThatThrownBy(() -> bundle.doc("agent/nope")).hasMessageContaining("No document 'agent/nope'");
    }

    @Test
    void aQuotedDocumentCarriesItsIdHashAndSourceAndItsWholeText() {
        EngineBundle bundle = EngineBundle.load(json);
        EngineBundle.Doc guide = bundle.doc("agent/guide");

        String quoted = bundle.quote(List.of("agent/guide", "api/core"));

        assertThat(quoted).startsWith("<document id=\"agent/guide\" sha256=\"" + guide.sha256() + "\" source=\"" + guide.source() + "\">\n")
                .contains(guide.text().strip()).contains("</document>\n\n<document id=\"api/core\"").endsWith("</document>");
        assertThatThrownBy(() -> bundle.quote(List.of("api/nope"))).hasMessageContaining("No document 'api/nope'");
    }

    @Test
    void aChangedDocumentOrAZeroedHashIsRefused() throws Exception {
        Map<String, String> changed = texts();
        String docs = changed.get("docs.json");
        assertThat(docs).contains("NullGraph is a direct-to-GPU");
        changed.put("docs.json", docs.replace("NullGraph is a direct-to-GPU", "NuliGraph is a direct-to-GPU"));
        assertThat(EngineBundle.problems(changed, json)).contains("docs.json: its hash is not the manifest's")
                .anyMatch(p -> p.endsWith(": its text is not its hash"));
        assertThatThrownBy(() -> EngineBundle.from(changed, json)).hasMessageContaining("does not match its manifest");

        Map<String, String> zeroed = texts();
        zeroed.put("bundle.json", zeroed.get("bundle.json").replaceFirst("\"bundleHash\": \"[0-9a-f]{64}\"", "\"bundleHash\": \"" + "0".repeat(64) + "\""));
        assertThat(EngineBundle.problems(zeroed, json)).containsExactly("bundleHash: not the hash of the package and the three files");
    }
}
