package ai.wexy.forge.paper;

import java.util.List;

/**
 * What the paper test asked and what came back, written as JSON for the frontend's
 * {@code dev/paper-check.mjs} and a person to read. Facts only: the prompts' sizes and documents, each
 * call's text, usage, cost and time. The key is never in it.
 *
 * @param startedAt ISO-8601, UTC
 * @param baseUrl   the API it talked to
 * @param model     the paper role's model
 * @param bundle    the engine bundle the prompts quote, verified before any call
 * @param template  the prompt templates and the schema, by version
 * @param answers   one per request, in order
 * @param findings  plain-language conclusions, in order
 * @param exitCode  0 when every request got an answer that matches the schema, 1 otherwise
 */
public record PaperReport(String startedAt, String baseUrl, String model, Bundle bundle, String template,
                          List<Answer> answers, List<String> findings, int exitCode) {

    /** The bundle's identity, which the frontend's check compares with its own before it reads anything. */
    public record Bundle(String engineVersion, String bundleHash, String docsSource) {
    }

    /**
     * One quoted document.
     *
     * @param placed {@code system} for the documents every request shares, {@code user} for the request's own
     */
    public record Doc(String id, String sha256, int bytes, String placed) {
    }

    /**
     * One metered call.
     *
     * @param purpose         the request's id, and {@code :not-strict} for a retry without strict
     * @param strict          whether {@code strict: true} was sent
     * @param inputTokenBound the input the charge allowed for (one token per byte, the framing, twice the schema)
     * @param chargedMicroUsd what SpendGuard reserved before the call (the upper bound)
     * @param costMicroUsd    what the reported usage costs at the configured prices, or null
     * @param text            the whole answer, as it came
     */
    public record Call(String purpose, boolean strict, boolean ok, String error, int maxOutputTokens,
                       long inputTokenBound, long chargedMicroUsd, Long costMicroUsd, Long ttftMs, long totalMs,
                       int chunks, String finishReason, Long promptTokens, Long completionTokens,
                       Long reasoningTokens, Long cachedTokens, Double outputTokensPerSecond, String text) {
    }

    /**
     * One request and its answer.
     *
     * @param strict         the call with {@code strict: true}
     * @param notStrict      the retry without strict when Meta refused the strict one, or null
     * @param kind           the action's kind, or null when no JSON came back
     * @param schemaProblems where the answer leaves {@code paper-action.v0}; empty when it matches
     */
    public record Answer(String id, String request, List<Doc> documents, int systemChars, int userChars,
                         Call strict, Call notStrict, String kind, List<String> schemaProblems) {
    }
}
