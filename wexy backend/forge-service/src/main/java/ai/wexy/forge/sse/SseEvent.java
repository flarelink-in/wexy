package ai.wexy.forge.sse;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The forge's stream events (forge-loop design §5.2, Q26), a closed set: one {@link Meta} first,
 * {@link Delta}s as the model writes, a {@link Usage} when the model reports it, and exactly one
 * {@link Done} or {@link Error} last (I3). Each record is the event's JSON, as the studio's reader
 * expects it; a field that is null is left out.
 */
public sealed interface SseEvent {

    /**
     * @param source        {@code live} or {@code archive}
     * @param role          the role that answered (h1's planner, author, repairer, escalator or director until EA9.6)
     * @param fn            the function an author or repair call wrote, or null
     * @param promptVersion the template that built the call, e.g. {@code module.author.v4}
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Meta(String generationId, String model, String source, String role, String fn, String promptVersion)
            implements SseEvent {
    }

    /** The model's visible text as it arrives, raw; empty chunks are never sent. */
    record Delta(String text) implements SseEvent {
    }

    /**
     * Token counts from the final chunk.
     *
     * @param reasoning output tokens spent reasoning, inside {@code out}; null when not reported
     * @param cached    input tokens served from the prompt cache, inside {@code in}; null when not reported
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Usage(long in, long out, Long reasoning, Long cached) implements SseEvent {
    }

    /** The answer is complete and, where it has a schema, valid. */
    record Done(String status) implements SseEvent {

        public static Done ok() {
            return new Done("ok");
        }
    }

    /** The call failed after the stream began; {@code code} is one of the closed set (backend §12). */
    record Error(String code, String message) implements SseEvent {
    }
}
