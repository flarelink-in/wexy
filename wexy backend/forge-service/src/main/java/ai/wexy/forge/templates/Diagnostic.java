package ai.wexy.forge.templates;

/**
 * One finding of the browser's checks, as a repair request carries it (forge-loop design §5.1).
 * The request's caps (at most 20, each message and snippet bounded) are checked where it arrives;
 * the prompt shows them as they are.
 *
 * @param source  {@code tint} (the compiler), {@code contract} (a rule), {@code probe} (the cost) or
 *                {@code sanity} (the running world)
 * @param line    counted from the function's first line; 0 when the finding has no place
 * @param column  counted from 1; 0 when it has none
 * @param message what the check said
 * @param snippet the line as the browser compiled it, or empty
 */
public record Diagnostic(String source, int line, int column, String message, String snippet) {
}
