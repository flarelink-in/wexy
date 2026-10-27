package ai.wexy.forge.probe;

import java.util.List;
import java.util.Map;

/**
 * What the hour-one probe found, written as JSON beside a short summary. Facts only: what was
 * asked, what came back, what it cost. The key is never in it.
 *
 * @param startedAt      ISO-8601, UTC
 * @param baseUrl        the API it talked to
 * @param keyPresent     whether a key was configured at all
 * @param models         the ids {@code GET /models} listed, or null if that failed
 * @param modelsError    why listing failed, or null
 * @param configured     each configured model: whether the API listed it (null if unknown)
 * @param codeModels     listed ids that look like Muse Code (R1: is it callable from an app?)
 * @param calls          one streamed call per configured model, and the structured-output check
 * @param findings       plain-language conclusions, in order
 * @param exitCode       0 if at least one call succeeded, 1 otherwise
 */
public record ProbeReport(String startedAt, String baseUrl, boolean keyPresent, List<String> models,
                          String modelsError, Map<String, Boolean> configured, List<String> codeModels,
                          List<Call> calls, List<String> findings, int exitCode) {

    /**
     * One metered call.
     *
     * @param purpose          {@code hello} or {@code structured-output}
     * @param maxOutputTokens  the cap sent as {@code max_tokens}
     * @param chargedMicroUsd  what SpendGuard was charged before the call (the upper bound)
     * @param costMicroUsd     what the reported usage costs at the configured price, or null
     * @param ttftMs           time to the first text, or null if none came
     * @param usageChunk       which chunk carried usage, counted from 1, or null if none did
     * @param outputTokensPerSecond completion tokens over the time after the first text, or null
     */
    public record Call(String purpose, String role, String model, boolean ok, String error, int maxOutputTokens,
                       long chargedMicroUsd, Long costMicroUsd, Long ttftMs, long totalMs, int chunks,
                       String text, String finishReason, Long promptTokens, Long completionTokens,
                       Long reasoningTokens, Integer usageChunk, Double outputTokensPerSecond) {
    }
}
