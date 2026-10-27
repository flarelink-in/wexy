package ai.wexy.forge.templates;

/**
 * The fence rule (forge-loop design §5.2). The templates ask for a function with no code fence;
 * when a model fences it anyway, the first fenced block is the answer and the rest is dropped. The
 * frontend's contract module applies the same rule before it compiles, so both sides agree on what
 * was answered.
 *
 * <p>A fence is a line whose first non-blank characters are three backticks; the rest of that line
 * (a language tag) is ignored. The block runs to the next fence line, or to the end of the text when
 * a stream was cut before its closing fence. Text with no fence comes back unchanged. Streams are
 * forwarded and recorded raw; this applies only where a function's text is used.
 */
public final class CodeBlocks {

    private static final String FENCE = "```";

    private CodeBlocks() {
    }

    public static String unfence(String text) {
        String[] lines = text.split("\n", -1);
        int open = 0;
        while (open < lines.length && !isFence(lines[open])) {
            open++;
        }
        if (open == lines.length) {
            return text;
        }
        StringBuilder block = new StringBuilder();
        for (int i = open + 1; i < lines.length && !isFence(lines[i]); i++) {
            block.append(i > open + 1 ? "\n" : "").append(lines[i]);
        }
        return block.toString();
    }

    private static boolean isFence(String line) {
        return line.stripLeading().startsWith(FENCE);
    }
}
