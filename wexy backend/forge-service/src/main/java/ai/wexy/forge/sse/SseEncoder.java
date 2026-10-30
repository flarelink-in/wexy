package ai.wexy.forge.sse;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;

/**
 * Turns {@link SseEvent}s into server-sent events: the event's name, and its record as one line of
 * JSON. Spring's writer puts them on the wire as {@code event:delta} and {@code data:{"text":"x"}}
 * with a blank line after each, flushed one by one, which the studio's reader parses (with or
 * without the optional space after the colon).
 *
 * <p>A quiet stream gets a comment line, {@code :hb}, every heartbeat interval (15 s by default), so
 * Cloudflare's 100 s proxy timeout and the gateway's 60 s idle timeout never fire while the model is
 * still reasoning (gotchas). The heartbeat stops when the events end; a comment is not an event, so
 * the one that can race the terminal event is harmless to a reader.
 */
public final class SseEncoder {

    private static final ObjectMapper JSON = new ObjectMapper();

    private SseEncoder() {
    }

    public static ServerSentEvent<String> encode(SseEvent event) {
        String name = switch (event) {
            case SseEvent.Meta ignored -> "meta";
            case SseEvent.Delta ignored -> "delta";
            case SseEvent.Usage ignored -> "usage";
            case SseEvent.Done ignored -> "done";
            case SseEvent.Error ignored -> "error";
        };
        try {
            return ServerSentEvent.<String>builder().event(name).data(JSON.writeValueAsString(event)).build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("An event always serializes", e);
        }
    }

    public static ServerSentEvent<String> heartbeat() {
        return ServerSentEvent.<String>builder().comment("hb").build();
    }

    /** The events, encoded, with a heartbeat merged in until they end. */
    public static Flux<ServerSentEvent<String>> withHeartbeat(Flux<SseEvent> events, Duration every) {
        return heartbeats(events.map(SseEncoder::encode), every);
    }

    /** Events already encoded (the agent turn's own, §5.4 of its design), with the same heartbeat merged in. */
    public static Flux<ServerSentEvent<String>> heartbeats(Flux<ServerSentEvent<String>> encoded, Duration every) {
        return encoded.publish(shared -> Flux.merge(shared,
                Flux.interval(every, every).map(tick -> heartbeat()).takeUntilOther(shared.then(Mono.just(Boolean.TRUE)))));
    }
}
