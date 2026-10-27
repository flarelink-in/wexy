package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.templates.Diagnostic;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * {@code POST /v1/forge/repair} (forge-loop design §5.1): which function to fix, by the generation
 * that wrote it, and what the browser's checks found. The function's text comes from the store,
 * never from the client (I4); the findings are the client's, capped and shown to the model as they
 * are.
 */
public record RepairRequest(String generationId, List<Diagnostic> diagnostics) {

    /** Where a finding comes from: the compiler, a rule, the cost probe, or the running world. */
    static final Set<String> SOURCES = Set.of("tint", "contract", "probe", "sanity");

    /** The request as the repairer gets it, or the refusal: over a cap is 413, anything else wrong is 400. */
    RepairRequest validated(LoopProperties.Caps caps) {
        if (diagnostics == null || diagnostics.isEmpty()) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "The request needs at least one diagnostic.");
        }
        if (diagnostics.size() > caps.diagnostics()) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "More than " + caps.diagnostics() + " diagnostics.");
        }
        List<Diagnostic> clean = new ArrayList<>(diagnostics.size());
        for (Diagnostic d : diagnostics) {
            if (d == null || d.source() == null || !SOURCES.contains(d.source())) {
                throw new ForgeException(ErrorCode.BAD_REQUEST, "Each diagnostic's source must be one of " + new TreeSet<>(SOURCES) + ".");
            }
            if (d.message() == null || d.message().isBlank()) {
                throw new ForgeException(ErrorCode.BAD_REQUEST, "Each diagnostic needs a message.");
            }
            if (d.message().codePointCount(0, d.message().length()) > caps.diagnosticChars()) {
                throw new ForgeException(ErrorCode.TOO_LARGE, "A diagnostic's message is longer than " + caps.diagnosticChars() + " characters.");
            }
            if (d.snippet() != null && d.snippet().codePointCount(0, d.snippet().length()) > caps.snippetChars()) {
                throw new ForgeException(ErrorCode.TOO_LARGE, "A diagnostic's snippet is longer than " + caps.snippetChars() + " characters.");
            }
            if (d.line() < 0 || d.column() < 0) {
                throw new ForgeException(ErrorCode.BAD_REQUEST, "Lines and columns count from 1, or are 0 when a finding has no place.");
            }
            clean.add(new Diagnostic(d.source(), d.line(), d.column(), d.message().strip(), d.snippet() == null ? "" : d.snippet().strip()));
        }
        // An id this service could not have issued is simply not a generation it knows: 404, as for a stranger's.
        if (!Ulid.looksLikeOne(generationId)) {
            throw LoopHandler.unknownWorld();
        }
        return new RepairRequest(generationId, List.copyOf(clean));
    }
}
