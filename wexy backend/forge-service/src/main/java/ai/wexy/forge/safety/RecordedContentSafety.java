package ai.wexy.forge.safety;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Content safety for the local and test profiles (W1): the recorded refusals in {@code mock/safety-refusals.txt}, a
 * phrase each with the category and severity Azure would give it, refused wherever the text holds the phrase; every
 * other text allowed. Never a deployment's: the profiles it runs under never deploy, and production uses
 * {@link AzureContentSafety}, which refuses to start without its endpoint and key. It says so at startup.
 */
@Component
@Profile({"local", "test"})
public class RecordedContentSafety implements ContentSafety {

    private static final Logger log = LoggerFactory.getLogger(RecordedContentSafety.class);
    static final String RESOURCE = "mock/safety-refusals.txt";

    private record Refusal(String phrase, String category, int severity) {
    }

    private final List<Refusal> refusals;

    public RecordedContentSafety() {
        this.refusals = load();
        log.warn("CONTENT SAFETY IS RECORDED: local and test profiles only. {} recorded refusals ({}); every other text is "
                + "allowed. A deployment checks with Azure AI Content Safety.", refusals.size(), RESOURCE);
    }

    @Override
    public Verdict check(String text) {
        String lower = text.toLowerCase(Locale.ROOT);
        for (Refusal r : refusals) {
            if (lower.contains(r.phrase())) {
                return new Verdict(false, Map.of(r.category(), r.severity()));
            }
        }
        return new Verdict(true, Map.of("Hate", 0, "SelfHarm", 0, "Sexual", 0, "Violence", 0));
    }

    /** Lines of {@code Category severity phrase…}; blank lines and {@code #} comments skipped. */
    private static List<Refusal> load() {
        String text;
        try {
            text = new ClassPathResource(RESOURCE).getContentAsString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("The recorded refusals are missing: " + RESOURCE, e);
        }
        List<Refusal> out = new ArrayList<>();
        for (String line : text.split("\\R")) {
            String l = line.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            String[] parts = l.split("\\s+", 3);
            if (parts.length < 3) {
                throw new IllegalStateException("A recorded refusal is a category, a severity and a phrase: " + l);
            }
            out.add(new Refusal(parts[2].toLowerCase(Locale.ROOT), parts[0], Integer.parseInt(parts[1])));
        }
        return List.copyOf(out);
    }
}
