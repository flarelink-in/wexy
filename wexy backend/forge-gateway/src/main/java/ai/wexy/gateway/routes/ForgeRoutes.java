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
 * Every public route, and the chain of filters each one runs: the API table of backend
 * architecture §11, as code. All of them lead to forge-service.
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
 *   <li><b>publishEntry</b> and <b>publish:</b> publishing a world (single-use App Check), then
 *       confirming uploads and reports.</li>
 *   <li><b>admin:</b> an address budget and the admin allow-list.</li>
 * </ul>
 *
 * Exactly two routes spend App Check tokens, forge-plan and worlds-publish; the frontend mints a
 * fresh token only for those (ForgeRoutesTest pins the set). Showcase publishing needs an account,
 * which forge-service checks from the token's {@code anon} claim when publishing (backend §7).
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

        Function<GatewayFilterSpec, UriSpec> publishEntry = f -> f
                .filter(rateLimits.byClient("publish"))
                .filter(appCheck.singleUse())
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUser("publish-user"));

        Function<GatewayFilterSpec, UriSpec> publish = f -> f
                .filter(rateLimits.byClient("publish"))
                .filter(appCheck)
                .filter(authorization.anonymousAllowed())
                .filter(rateLimits.byUser("publish-user"));

        Function<GatewayFilterSpec, UriSpec> admin = f -> f
                .filter(rateLimits.byClient("admin"))
                .filter(authorization.adminOnly());

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

                // --- Public reads ---
                .route("forge-mode", r -> r.path("/v1/forge/mode").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("archive-match", r -> r.path("/v1/archive/match").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("worlds-read", r -> r.path("/v1/worlds/{id}").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("showcase", r -> r.path("/v1/showcase").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))
                .route("stats", r -> r.path("/v1/stats").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(forgeService))

                // --- Worlds: publishing for share links ---
                .route("worlds-publish", r -> r.path("/v1/worlds").and().method(HttpMethod.POST)
                        .filters(publishEntry).uri(forgeService))
                .route("worlds-complete", r -> r.path("/v1/worlds/{id}/complete").and().method(HttpMethod.POST)
                        .filters(publish).uri(forgeService))
                .route("worlds-report", r -> r.path("/v1/worlds/{id}/report").and().method(HttpMethod.POST)
                        .filters(publish).uri(forgeService))

                // --- Operations: moderation, live or archive mode ---
                .route("admin", r -> r.path("/v1/admin/**").and().method(HttpMethod.POST)
                        .filters(admin).uri(forgeService))
                .build();
    }
}
