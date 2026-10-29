package ai.wexy.forge.loop;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

/**
 * The loop's routes (forge-loop design §10). Every one but the mode needs the gateway's internal token,
 * which {@code InternalTokenFilter} checks before routing; the gateway applies sign-in, App Check and the
 * buckets in front of them ({@code ForgeRoutes}). The mode is a public read.
 */
@Configuration
public class LoopRouter {

    @Bean
    public RouterFunction<ServerResponse> loopRoutes(LoopHandler handler) {
        return RouterFunctions.route()
                .POST("/v1/forge/plan", handler::plan)
                .POST("/v1/forge/author", handler::author)
                .POST("/v1/forge/repair", handler::repair)
                .POST("/v1/forge/direct", handler::direct)
                .POST("/v1/forge/outcomes", handler::outcomes)
                .GET("/v1/forge/mode", handler::mode)
                .build();
    }
}
