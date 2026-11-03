package ai.wexy.forge.agent;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * A model's review of the world on the stage (EA6.4; the frontend's visual-review design §9.1, Q62's four gates): the
 * facts an operator records once each gate is verified. None has a default that opens a gate, and nothing here turns
 * one on by itself: an unset value is an unverified gate, and the route refuses before any record or charge.
 *
 * @param visionProbe   the vision probe report that passed (its name, as the probe printed it), which verifies two gates:
 *                      the model reads images, and this service's image part reaches it ({@code images}, {@code transport})
 * @param provider      who receives the frames, as the browser's disclosure names it ({@code meta})
 * @param policyVersion the disclosure the creator consents to, word for word in the browser's copy; a change asks again
 *                      ({@code privacy})
 * @param imageTokens   the most input tokens one 768 × 432 JPEG may bill, from the probe's measured usage with a margin
 *                      ({@code metering}): a provider's image cost has no published formula, and an unknown price denies
 */
@ConfigurationProperties(prefix = "wexy.review")
public record ReviewProperties(String visionProbe, String provider, String policyVersion, Integer imageTokens) {

    /** The gates, in the design's order: the first one not met is the one the studio names. */
    public static final String[] GATES = {"images", "transport", "privacy", "metering"};
    /** An operator's value: a name, not a sentence. */
    static final Pattern VALUE = Pattern.compile("[A-Za-z0-9._:+-]{1,128}");
    /**
     * A vision report's name as the probe writes it ({@code VisionRunner}: {@code vision-<yyyyMMdd>-<HHmmss>}, UTC): only
     * that verifies the probe's two gates (the independent review of EA6.4: "pending" or "false" opened them).
     */
    static final Pattern PROBE_REPORT = Pattern.compile("vision-\\d{8}-\\d{6}");
    /** Beyond this an image bound is a typo, not a measurement (Meta's docs: about 1,500 tokens for a 1280 px image). */
    static final int MAX_IMAGE_TOKENS = 100_000;

    public ReviewProperties {
        for (Map.Entry<String, String> e : Map.of("vision-probe", nullToEmpty(visionProbe), "provider", nullToEmpty(provider),
                "policy-version", nullToEmpty(policyVersion)).entrySet()) {
            if (!e.getValue().isEmpty() && !VALUE.matcher(e.getValue()).matches()) {
                throw new IllegalStateException("wexy.review." + e.getKey() + " is a name of 1 to 128 letters, digits and . _ : + -, or unset.");
            }
        }
        if (imageTokens != null && (imageTokens <= 0 || imageTokens > MAX_IMAGE_TOKENS)) {
            throw new IllegalStateException("wexy.review.image-tokens is 1 to " + MAX_IMAGE_TOKENS + " (the bound of one frame), or unset.");
        }
        String probe = nullToEmpty(visionProbe);
        if (!probe.isEmpty() && !PROBE_REPORT.matcher(probe).matches()) {
            throw new IllegalStateException("wexy.review.vision-probe is the name of a vision report that passed, as the probe printed it"
                    + " (vision-yyyyMMdd-HHmmss), or unset.");
        }
    }

    /** Each gate and whether it is verified, in order. */
    public Map<String, Boolean> gates() {
        Map<String, Boolean> gates = new LinkedHashMap<>();
        boolean probed = !nullToEmpty(visionProbe).isEmpty();
        gates.put("images", probed);
        gates.put("transport", probed);
        gates.put("privacy", !nullToEmpty(provider).isEmpty() && !nullToEmpty(policyVersion).isEmpty());
        gates.put("metering", imageTokens != null);
        return gates;
    }

    /** The first gate not verified, or null when every one is. */
    public String unmet() {
        return gates().entrySet().stream().filter(e -> !e.getValue()).map(Map.Entry::getKey).findFirst().orElse(null);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s.strip();
    }
}
