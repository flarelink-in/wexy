package ai.wexy.forge.agent;

import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.PromptBuilder;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

/**
 * The agent loop's beans and routes (the agent-loop design §3, §10): the engine bundle and the adapter manifest, each
 * verified once at startup, the loop over them with the turn's budgets, {@code POST /v1/agent/turn}, and
 * {@code POST /v1/agent/module} (EA4.2: one module's body for a turn's program, the frontend's candidate-loop design
 * §6). The internal token guards both like every forge route ({@code InternalTokenFilter}); the gateway puts sign-in,
 * App Check and its buckets in front.
 */
@Configuration
public class AgentConfiguration {

    @Bean
    public EngineBundle engineBundle(ObjectMapper json) {
        return EngineBundle.load(json);
    }

    /** The frontend's adapter manifest, embedded and verified against its pinned hash (EA3.6). */
    @Bean
    public AdapterManifest adapterManifest(ObjectMapper json) {
        return AdapterManifest.load(json);
    }

    @Bean
    public AgentLoop agentLoop(EngineBundle bundle, AdapterManifest manifest, JsonSchemas schemas, PromptBuilder prompts,
                               AgentProperties properties) {
        return new AgentLoop(new AgentTools(bundle), new ProgramCheck(bundle, manifest), schemas, prompts, properties.toBudget(),
                System::currentTimeMillis);
    }

    @Bean
    public RouterFunction<ServerResponse> agentRoutes(AgentHandler handler) {
        return RouterFunctions.route().POST("/v1/agent/turn", handler::turn).build();
    }

    /** One module's body for a turn's program (EA4.2); WebFlux combines it with the turn's route. */
    @Bean
    public RouterFunction<ServerResponse> moduleRoutes(ModuleHandler handler) {
        return RouterFunctions.route().POST("/v1/agent/module", handler::module).build();
    }
}
