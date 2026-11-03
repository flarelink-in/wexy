package ai.wexy.gateway.routes;

import ai.wexy.gateway.appcheck.AppCheckFilter;
import ai.wexy.gateway.auth.AuthorizationFilter;
import ai.wexy.gateway.shield.RateLimits;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.GatewayFilterSpec;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.cloud.gateway.route.builder.UriSpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;

import java.util.function.Function;

/**
 * The platform service's routes (W2; the creations platform design §10): accounts, profiles, worlds, the showcase,
 * moderation and the waitlist, every one leading to the platform service. W2 serves the accounts; the rest are here so
 * the gateway's edge (policies, buckets, App Check, body caps) is §10's whole table now, and each later stage adds its
 * handlers behind routes that already exist. Until then the platform answers them 404.
 *
 * The chains, as forge's (ForgeRoutes), cheapest first:
 *
 * <ul>
 *   <li><b>publicRead</b> (§10's P): an address budget, no sign-in, no App Check: anyone browses the showcase.</li>
 *   <li><b>signedIn</b> (N, A and O): an address budget, App Check (spent once where §10 says so), a real account
 *       (never an anonymous one), then a per-account budget. An active account (A) and the owner (O) are the
 *       platform's checks: the gateway knows neither.</li>
 *   <li><b>admin</b> (D): an address budget and the allow-list, as forge's.</li>
 *   <li><b>waitlist</b>: public, so no sign-in, but App Check spent once and a bucket of its own (W6).</li>
 * </ul>
 *
 * Every token minted on these routes is for the platform alone (its audience), so a forge route's token opens
 * nothing here and the reverse. Four of these spend App Check tokens: POST /v1/me, DELETE /v1/me, a submission and
 * the waitlist; POST /v1/worlds, a single-use route before W2, now takes the cached token (ForgeRoutesTest pins the
 * whole set, and the frontend's http.ts the same list).
 */
@Configuration
public class PlatformRoutes {

    /**
     * Ahead of forge's catch-all admin route ({@code POST /v1/admin/**}, order 0), so the platform's own admin paths reach
     * the platform: the gateway tries routes in order.
     */
    public static final int AHEAD_OF_FORGE = -1;

    @Bean
    public RouteLocator platformRouteLocator(RouteLocatorBuilder builder,
                                             RateLimits rateLimits,
                                             AppCheckFilter appCheck,
                                             AuthorizationFilter authorization,
                                             @Value("${wexy.platform-service.url}") String platform) {

        Function<GatewayFilterSpec, UriSpec> publicRead = f -> f
                .filter(rateLimits.byClient("public-read"));

        Function<GatewayFilterSpec, UriSpec> admin = f -> f
                .filter(rateLimits.byClient("admin"))
                .filter(authorization.platformAdmin());

        Function<GatewayFilterSpec, UriSpec> waitlist = f -> f
                .filter(rateLimits.byClient("waitlist"))
                .filter(appCheck.singleUse());

        GatewayFilter cached = appCheck;
        GatewayFilter spent = appCheck.singleUse();

        return builder.routes()
                // --- Accounts (W2) ---
                .route("me-bootstrap", r -> r.path("/v1/me").and().method(HttpMethod.POST)
                        .filters(signedIn(rateLimits, spent, authorization, "account-bootstrap")).uri(platform))
                .route("me-read", r -> r.path("/v1/me").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("me-profile", r -> r.path("/v1/me/profile").and().method(HttpMethod.PATCH)
                        .filters(signedIn(rateLimits, cached, authorization, "profile-write")).uri(platform))
                .route("me-usage", r -> r.path("/v1/me/usage").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("me-operation", r -> r.path("/v1/me/operations/{id}").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("me-delete", r -> r.path("/v1/me").and().method(HttpMethod.DELETE)
                        .filters(signedIn(rateLimits, spent, authorization, "account-delete")).uri(platform))

                // --- Public profiles (W4) ---
                .route("profile-read", r -> r.path("/v1/profiles/{handle}").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(platform))
                .route("profile-worlds", r -> r.path("/v1/profiles/{handle}/worlds").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(platform))

                // --- Worlds, private to their owner (W3) ---
                .route("worlds-create", r -> r.path("/v1/worlds").and().method(HttpMethod.POST)
                        .filters(signedIn(rateLimits, cached, authorization, "world-write")).uri(platform))
                .route("me-worlds", r -> r.path("/v1/me/worlds").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("worlds-read", r -> r.path("/v1/worlds/{id}").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("worlds-update", r -> r.path("/v1/worlds/{id}").and().method(HttpMethod.PATCH)
                        .filters(signedIn(rateLimits, cached, authorization, "world-write")).uri(platform))
                .route("worlds-delete", r -> r.path("/v1/worlds/{id}").and().method(HttpMethod.DELETE)
                        .filters(signedIn(rateLimits, cached, authorization, "world-write")).uri(platform))
                .route("worlds-revise", r -> r.path("/v1/worlds/{id}/revisions").and().method(HttpMethod.POST)
                        .filters(signedIn(rateLimits, cached, authorization, "world-write")).uri(platform))
                .route("worlds-revision", r -> r.path("/v1/worlds/{id}/revisions/{revisionId}").and().method(HttpMethod.GET)
                        .filters(signedIn(rateLimits, cached, authorization, "account-read")).uri(platform))
                .route("worlds-poster", r -> r.path("/v1/worlds/{id}/posters").and().method(HttpMethod.POST)
                        .filters(signedIn(rateLimits, cached, authorization, "media-write")).uri(platform))

                // --- The showcase (W4) ---
                .route("worlds-submit", r -> r.path("/v1/worlds/{id}/submissions").and().method(HttpMethod.POST)
                        .filters(signedIn(rateLimits, spent, authorization, "publish")).uri(platform))
                .route("worlds-withdraw", r -> r.path("/v1/worlds/{id}/publication").and().method(HttpMethod.DELETE)
                        .filters(signedIn(rateLimits, cached, authorization, "publish")).uri(platform))
                .route("showcase", r -> r.path("/v1/showcase").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(platform))
                .route("publication-read", r -> r.path("/v1/publications/{id}").and().method(HttpMethod.GET)
                        .filters(publicRead).uri(platform))

                // --- Moderation (W4), by the runbook: ahead of forge's /v1/admin/** ---
                .route("admin-submissions", r -> r.order(AHEAD_OF_FORGE).path("/v1/admin/submissions").and()
                        .method(HttpMethod.GET).filters(admin).uri(platform))
                .route("admin-submission-decide", r -> r.order(AHEAD_OF_FORGE).path("/v1/admin/submissions/{id}/decisions").and()
                        .method(HttpMethod.POST).filters(admin).uri(platform))
                .route("admin-publication-decide", r -> r.order(AHEAD_OF_FORGE).path("/v1/admin/publications/{id}/decisions").and()
                        .method(HttpMethod.POST).filters(admin).uri(platform))

                // --- The waitlist (W6) ---
                .route("waitlist", r -> r.path("/v1/waitlist").and().method(HttpMethod.POST)
                        .filters(waitlist).uri(platform))
                .build();
    }

    /**
     * A signed-in route of class `bucket`: its address bucket, the App Check `check` (cached, or spent once), a real
     * account for the platform, then the account's bucket, `bucket` + {@code -user}.
     */
    private static Function<GatewayFilterSpec, UriSpec> signedIn(RateLimits rateLimits, GatewayFilter check,
                                                                 AuthorizationFilter authorization, String bucket) {
        return f -> f
                .filter(rateLimits.byClient(bucket))
                .filter(check)
                .filter(authorization.platformAccount())
                .filter(rateLimits.byUser(bucket + "-user"));
    }
}
