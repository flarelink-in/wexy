package ai.wexy.forge.allowance;

import ai.wexy.forge.identity.Caller;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@code GET /v1/forge/allowance} (W1; the creations platform design §10, I13): the caller's own allowance, and nobody
 * else's, as {@code {label, left, resetsAt}}: "Free" or "Early access" (an admin answers as early access, with its
 * own number), what is left in the window, and when the next opens, null where waiting opens nothing. Read only;
 * {@code no-store}; an allowance the store cannot read is {@code 503 unavailable}, never a zero. No role, limit or
 * usage of the caller's appears in any other response, and none of anyone else's here.
 */
@Component
public class AllowanceHandler {

    private final PromptGrants grants;

    public AllowanceHandler(PromptGrants grants) {
        this.grants = grants;
    }

    public Mono<ServerResponse> allowance(ServerRequest request) {
        Caller caller = Caller.of(request.exchange());
        return Mono.fromCallable(() -> grants.peek(caller))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(peek -> {
                    Map<String, Object> dto = new LinkedHashMap<>();
                    dto.put("label", peek.role().label());
                    dto.put("left", peek.left());
                    dto.put("resetsAt", peek.resetsAt() == null ? null : peek.resetsAt().toString());
                    return ServerResponse.ok().contentType(MediaType.APPLICATION_JSON)
                            .header(HttpHeaders.CACHE_CONTROL, "no-store").bodyValue(dto);
                });
    }

    /** The route; the internal token is required, as on every forge route but the public reads. */
    @Configuration
    public static class Routes {

        @Bean
        public RouterFunction<ServerResponse> allowanceRoutes(AllowanceHandler handler) {
            return RouterFunctions.route().GET("/v1/forge/allowance", handler::allowance).build();
        }
    }
}
