package ai.wexy.forge.safety;

import java.util.Map;

/**
 * Content safety for a prompt's user-written text (W1; the creations platform design §11, I12, Q99): a verdict before
 * any prompt is granted or any model call is made. No verdict, no call: an implementation that cannot answer throws
 * {@code ForgeException(UNAVAILABLE)}, and nothing is granted. Blocking: call it off the event loop.
 */
public interface ContentSafety {

    /**
     * What the check found.
     *
     * @param allowed    false when any category reached its refusal threshold
     * @param severities each category's severity, as the service named them; for the logs, never the text
     */
    record Verdict(boolean allowed, Map<String, Integer> severities) {

        public Verdict {
            severities = Map.copyOf(severities);
        }

        /** The categories that refused, as {@code Category:severity}, for a log line. */
        public String shown() {
            StringBuilder out = new StringBuilder();
            severities.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> {
                if (!out.isEmpty()) {
                    out.append(',');
                }
                out.append(e.getKey()).append(':').append(e.getValue());
            });
            return out.toString();
        }
    }

    /** The verdict on `text`. */
    Verdict check(String text);
}
