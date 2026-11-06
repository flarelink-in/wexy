package ai.wexy.forge.loop;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

/** EA9.6: only the public mode read remains; legacy creation POST routes are retired. */
@Configuration
public class LoopRouter {

    @Bean
    public RouterFunction<ServerResponse> loopRoutes() {
        return RouterFunctions.route()
                .GET("/v1/forge/mode", request -> ServerResponse.ok()
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .bodyValue("{\"mode\":\"live\",\"reason\":null}"))
                .build();
    }
}
