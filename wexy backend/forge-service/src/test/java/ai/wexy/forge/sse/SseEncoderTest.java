package ai.wexy.forge.sse;

import org.junit.jupiter.api.Test;
import org.springframework.core.ResolvableType;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.http.codec.ServerSentEventHttpMessageWriter;
import org.springframework.mock.http.server.reactive.MockServerHttpResponse;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** U5: the events on the wire, as the studio's reader parses them; and the heartbeat on a quiet stream. */
class SseEncoderTest {

    private static String wire(Flux<ServerSentEvent<String>> events) {
        MockServerHttpResponse response = new MockServerHttpResponse();
        new ServerSentEventHttpMessageWriter().write(events, ResolvableType.forClass(ServerSentEvent.class),
                MediaType.TEXT_EVENT_STREAM, response, Map.of()).block(Duration.ofSeconds(5));
        return response.getBodyAsString().block(Duration.ofSeconds(5));
    }

    @Test
    void eachEventIsItsNameAndOneLineOfJson() {
        String text = wire(Flux.just(
                SseEncoder.encode(new SseEvent.Meta("01J0000000000000000000000A", "m-1", "live", "author", "evolve", "author.evolve.v1")),
                SseEncoder.encode(new SseEvent.Delta("fn evolve(\n\"x\"")),
                SseEncoder.encode(new SseEvent.Usage(2400, 900, 300L, null)),
                SseEncoder.encode(SseEvent.Done.ok()),
                SseEncoder.heartbeat()));

        assertThat(text).isEqualTo(
                "event:meta\ndata:{\"generationId\":\"01J0000000000000000000000A\",\"model\":\"m-1\",\"source\":\"live\","
                        + "\"role\":\"author\",\"fn\":\"evolve\",\"promptVersion\":\"author.evolve.v1\"}\n\n"
                        + "event:delta\ndata:{\"text\":\"fn evolve(\\n\\\"x\\\"\"}\n\n"
                        + "event:usage\ndata:{\"in\":2400,\"out\":900,\"reasoning\":300}\n\n"
                        + "event:done\ndata:{\"status\":\"ok\"}\n\n"
                        + ":hb\n\n");
    }

    @Test
    void aPlanHasNoFunctionAndAnErrorCarriesItsCode() {
        String text = wire(Flux.just(
                SseEncoder.encode(new SseEvent.Meta("01J0000000000000000000000A", "m-1", "live", "planner", null, "planner.v1")),
                SseEncoder.encode(new SseEvent.Error("upstream", "The model provider failed."))));

        assertThat(text).contains("\"role\":\"planner\",\"promptVersion\":\"planner.v1\"}").doesNotContain("\"fn\"")
                .endsWith("event:error\ndata:{\"code\":\"upstream\",\"message\":\"The model provider failed.\"}\n\n");
    }

    /** P4 in small: a model thinking quietly still sends a comment before its first word, and none after the end. */
    @Test
    void aQuietStreamGetsHeartbeatsUntilItEnds() {
        Flux<SseEvent> slow = Flux.concat(
                Flux.just((SseEvent) new SseEvent.Delta("a")),
                Flux.just((SseEvent) SseEvent.Done.ok()).delayElements(Duration.ofMillis(180)));

        List<ServerSentEvent<String>> out = SseEncoder.withHeartbeat(slow, Duration.ofMillis(50))
                .collectList().block(Duration.ofSeconds(5));

        assertThat(out).anyMatch(e -> "hb".equals(e.comment()));
        assertThat(out.get(0).event()).isEqualTo("delta");
        ServerSentEvent<String> lastEvent = out.stream().filter(e -> e.event() != null).reduce((a, b) -> b).orElseThrow();
        assertThat(lastEvent.event()).isEqualTo("done");
        assertThat(out.stream().filter(e -> e.event() != null)).hasSize(2);
    }
}
