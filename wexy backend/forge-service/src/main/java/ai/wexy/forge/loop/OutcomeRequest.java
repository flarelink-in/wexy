package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.records.Ulid;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * {@code POST /v1/forge/outcomes} (forge-loop design §5.1; the frontend's core loop §11): what the
 * browser found when it verified and ran the generations it names. The ladder is kept as the
 * browser sent it, as JSON, for B1's rows and the stats; the numbers are read here only to be
 * checked.
 *
 * @param generationIds the generations this report is about: the plan, its functions, their repairs
 * @param ladder        the ladder's results and timings, as the frontend's §7 defines them
 * @param firstPassOk   whether every function compiled and ran before any repair
 * @param repairs       repairs made before the world ran
 * @param autofixes     one-line auto-fixes applied before compiling
 * @param probeMs       the cost probe's measured step, in milliseconds, or null
 * @param predictedMs   what the probe predicted a frame would cost, or null
 * @param fps           frames a second after settling, or null
 * @param adapter       the GPU's vendor and architecture, as WebGPU names them, or null
 * @param browser       the browser's name and version, or null
 */
public record OutcomeRequest(List<String> generationIds, JsonNode ladder, Boolean firstPassOk, Integer repairs,
                             Integer autofixes, Double probeMs, Double predictedMs, Double fps, String adapter,
                             String browser) {

    private static final int MAX_COUNT = 255;

    /** The report as it is stored, or the refusal: over a cap is 413, a missing or absurd value 400. */
    OutcomeRequest validated(LoopProperties.Caps caps) {
        if (generationIds == null || generationIds.isEmpty()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The report needs at least one generation id.");
        }
        if (generationIds.size() > caps.outcomeIds()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "More than " + caps.outcomeIds() + " generation ids.");
        }
        if (ladder == null || ladder.isNull() || ladder.isMissingNode()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The report needs a ladder.");
        }
        if (ladder.toString().getBytes(StandardCharsets.UTF_8).length > caps.ladderBytes()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "The ladder is larger than " + caps.ladderBytes() + " bytes.");
        }
        if (firstPassOk == null) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The report needs firstPassOk.");
        }
        if (!count(repairs) || !count(autofixes)) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "repairs and autofixes must be between 0 and " + MAX_COUNT + ".");
        }
        if (!measure(probeMs) || !measure(predictedMs) || !measure(fps)) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "probeMs, predictedMs and fps must be numbers of zero or more.");
        }
        if (!label(adapter, caps) || !label(browser, caps)) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "adapter and browser are at most " + caps.labelChars() + " characters.");
        }
        // An id this service could not have issued is simply not a generation it knows: 404, as for a stranger's.
        for (String id : generationIds) {
            if (!Ulid.looksLikeOne(id)) {
                throw LoopHandler.unknownWorld();
            }
        }
        return new OutcomeRequest(List.copyOf(generationIds), ladder, firstPassOk, repairs, autofixes, probeMs, predictedMs, fps,
                adapter == null ? null : adapter.strip(), browser == null ? null : browser.strip());
    }

    private static boolean count(Integer n) {
        return n != null && n >= 0 && n <= MAX_COUNT;
    }

    private static boolean measure(Double n) {
        return n == null || (!n.isNaN() && !n.isInfinite() && n >= 0);
    }

    private static boolean label(String s, LoopProperties.Caps caps) {
        return s == null || s.codePointCount(0, s.length()) <= caps.labelChars();
    }
}
