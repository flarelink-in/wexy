package ai.wexy.gateway.routes;

import ai.wexy.gateway.appcheck.AppCheckFilter;
import ai.wexy.gateway.auth.AuthorizationFilter;
import ai.wexy.gateway.shield.RateLimits;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.GatewayFilterSpec;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.cloud.gateway.route.builder.UriSpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;

import java.util.function.Function;

/**
 * Forge's routes, and the chain of filters each one runs: the API table of backend architecture §11,
 * as code. All of them lead to forge-service; the accounts, worlds and showcase routes are the platform
 * service's since W2 (PlatformRoutes).
 *
 * The chains, cheapest first (each filter's order puts it in place, whatever the order here):
 *
 * <ul>
 *   <li><b>publicRead:</b> an address budget. No sign-in, no App Check: share pages and crawlers
 *       carry neither.</li>
 *   <li><b>forgeEntry:</b> plan, the call that starts a world and the one a script would repeat.
 *       Address budget, App Check spent once, sign-in (anonymous allowed), then a per-account
 *       budget that is tighter for anonymous accounts.</li>
 *   <li><b>forgeCreate:</b> author, the parallel calls that follow a plan. As above, with the cached
 *       App Check token.</li>
 *   <li><b>forgeEdit:</b> repair, direct and outcomes.</li>
 *   <li><b>admin:</b> an address budget and the admin allow-list.</li>
 * </ul>
 *
 * Three of forge's routes spend App Check tokens, forge-plan, agent-turn and agent-module; with the
 * platform's (PlatformRoutes) they are the routes the frontend mints a fresh token for (ForgeRoutesTest
 * pins the whole set). Every token minted here is for forge alone (W2's audience).
 */
@Configuration
public class ForgeRoutes {

    @Bean
    public RouteLocator forgeRouteLocator(RouteLocatorBuilder builder,
                                          RateLimits rateLimits,
                                          AppCheckFilter appCheck,
                                          AuthorizationFilter authorization,
                                          @Value("${wexy.forge-service.url}") String forgeService) {

        Function<GatewayFilterSpec, UriSpec> publicRead = f -> f
                .filter(rateLimits.byClient("public-read"));

        Function<GatewayFilterSpec, UriSpec> forgeEntry = f -> f
                .filter(rateLimits.byClient("forge-create"))
                .filter(appCheck.singleUse())
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUserTiered("forge-create-user", "forge-create-anonymous"));

        // The agent turn (the agent-loop design §10): an expensive entry, like a plan, whose buckets count model calls (Q66).
        Function<GatewayFilterSpec, UriSpec> agentEntry = f -> f
                .filter(rateLimits.byClient("agent-turn"))
                .filter(appCheck.singleUse())
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUserTiered("agent-turn-user", "agent-turn-anonymous"));

        // A module call (EA4.2, the frontend's candidate-loop design §6): one metered call each, with its own buckets and
        // a single-use App Check token, as the turn has.
        Function<GatewayFilterSpec, UriSpec> agentModule = f -> f
                .filter(rateLimits.byClient("agent-module"))
                .filter(appCheck.singleUse())
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUserTiered("agent-module-user", "agent-module-anonymous"));

        Function<GatewayFilterSpec, UriSpec> forgeCreate = f -> f
                .filter(rateLimits.byClient("forge-create"))
                .filter(appCheck)
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUserTiered("forge-create-user", "forge-create-anonymous"));

        Function<GatewayFilterSpec, UriSpec> forgeEdit = f -> f
                .filter(rateLimits.byClient("forge-edit"))
                .filter(appCheck)
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUser("forge-edit-user"));

        Function<GatewayFilterSpec, UriSpec> admin = f -> f
                .filter(rateLimits.byClient("admin"))
                .filter(authorization.adminOnly());

        // W1 (the creations platform design §10): the caller's own allowance. Signed in, anonymous included, with the
        // cached App Check token (nothing is spent), an address bucket and a per-uid one.
        Function<GatewayFilterSpec, UriSpec> accountRead = f -> f
                .filter(rateLimits.byClient("account-read"))
                .filter(appCheck)
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUser("account-read-user"));

        return builder.routes()
                // --- Forge: the model calls (streamed) and the browser's reports ---
                .route("forge-plan", r -> r.path("/v1/forge/plan").and().method(HttpMethod.POST)
                        .filters(forgeEntry).uri(forgeService))
                .route("forge-author", r -> r.path("/v1/forge/author").and().method(HttpMethod.POST)
                        .filters(forgeCreate).uri(forgeService))
                .route("forge-repair", r -> r.path("/v1/forge/repair").and().method(HttpMethod.POST)
                        .filters(forgeEdit).uri(forgeService))
                .route("forge-direct", r -> r.path("/v1/forge/direct").and().method(HttpMethod.POST)
                        .filters(forgeEdit).uri(forgeService))
                .route("forge-outcomes", r -> r.path("/v1/forge/outcomes").and().method(HttpMethod.POST)
                        .filters(forgeEdit).uri(forgeService))
                .route("agent-turn", r -> r.path("/v1/agent/turn").and().method(HttpMethod.POST)
                        .filters(agentEntry).uri(forgeService))
                .route("agent-module", r -> r.path("/v1/agent/module").and().method(HttpMethod.POST)
                        .filters(agentModule).uri(forgeService))
                .route("forge-allowance", r -> r.path("/v1/forge/allowance").and().method(HttpMethod.GET)
                        .filters(accountRead).uri(forgeService))

                // --- Public reads ---
                .route("forge-mode", r -> r.path("/v1/forge/mode").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("archive-match", r -> r.path("/v1/archive/match").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("stats", r -> r.path("/v1/stats").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))

                // The worlds and the showcase went to the platform service in W2 (PlatformRoutes); the share links'
                // complete and report stay unavailable until they are designed again (the platform design §10).

                // --- Operations: moderation, live or archive mode (the platform's own admin routes come first) ---
                .route("admin", r -> r.path("/v1/admin/**").and().method(HttpMethod.POST)
                        .filters(admin).uri(forgeService))
                .build();
    }
}
