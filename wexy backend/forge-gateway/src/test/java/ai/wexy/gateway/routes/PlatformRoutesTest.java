package ai.wexy.gateway.routes;

import ai.wexy.common.InternalToken;
import ai.wexy.gateway.appcheck.AppCheckFilter;
import ai.wexy.gateway.auth.AuthorizationFilter;
import ai.wexy.gateway.shield.RateLimitFilter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2: the platform service's half of the gateway's table against the creations platform design §10. Its policies (P
 * public, N/A/O a real account, D the allow-list), each row's buckets, which rows spend App Check, where each route
 * leads, and the audience of the token it mints. The single-use set across both services is ForgeRoutesTest's.
 */
@SpringBootTest
@ActiveProfiles("test")
class PlatformRoutesTest {

    /** §10's signed-in rows, each with its bucket class (the address's; the account's is the same name + "-user"). */
    private static final Map<String, String> SIGNED_IN = Map.ofEntries(
            Map.entry("me-bootstrap", "account-bootstrap"),
            Map.entry("me-read", "account-read"),
            Map.entry("me-profile", "profile-write"),
            Map.entry("me-usage", "account-read"),
            Map.entry("me-operation", "account-read"),
            Map.entry("me-delete", "account-delete"),
            Map.entry("worlds-create", "world-write"),
            Map.entry("me-worlds", "account-read"),
            Map.entry("worlds-read", "account-read"),
            Map.entry("worlds-update", "world-write"),
            Map.entry("worlds-delete", "world-write"),
            Map.entry("worlds-revise", "world-write"),
            Map.entry("worlds-revision", "account-read"),
            Map.entry("worlds-poster", "media-write"),
            Map.entry("worlds-submit", "publish"),
            Map.entry("worlds-withdraw", "publish"));
    private static final List<String> PUBLIC_READS = List.of("profile-read", "profile-worlds", "showcase", "publication-read");
    private static final List<String> ADMIN = List.of("admin-submissions", "admin-submission-decide", "admin-publication-decide");

    @Autowired
    private RouteLocator routeLocator;

    @Autowired
    private AppCheckFilter appCheck;

    @Autowired
    private AuthorizationFilter authorization;

    @Value("${wexy.platform-service.url}")
    private String platform;

    @Value("${wexy.forge-service.url}")
    private String forge;

    @Test
    void everyPlatformRouteLeadsToThePlatformAndEveryOtherToForge() {
        for (Route route : routeLocator.getRoutes().collectList().block()) {
            URI expected = URI.create(ForgeRoutesTest.PLATFORM.contains(route.getId()) ? platform : forge);
            assertThat(route.getUri()).as(route.getId()).isEqualTo(expected);
        }
        assertThat(SIGNED_IN.size() + PUBLIC_READS.size() + ADMIN.size() + 1).isEqualTo(ForgeRoutesTest.PLATFORM.size());
    }

    /**
     * N, A and O at the gateway: a real account (an anonymous one is refused there, 403 account-required), a token for
     * the platform alone, and the row's two buckets. The account's status (A) and ownership (O) are the platform's.
     */
    @Test
    void signedInRowsNeedARealAccountAndMintForThePlatform() {
        AuthorizationFilter.PolicyFilter account = (AuthorizationFilter.PolicyFilter) authorization.platformAccount();
        assertThat(account.policy()).isEqualTo(AuthorizationFilter.Policy.ACCOUNT_REQUIRED);
        assertThat(account.audience()).isEqualTo(InternalToken.AUDIENCE_PLATFORM);
        SIGNED_IN.forEach((id, bucket) -> {
            List<GatewayFilter> filters = route(id).getFilters();
            assertThat(filters).as(id).contains(account)
                    .doesNotContain(authorization.anonymousAllowed(), authorization.accountRequired(), authorization.adminOnly());
            assertThat(buckets(filters)).as(id).containsExactly(bucket, bucket + "-user");
        });
    }

    /** PL-T17: a private world is the owner's, so its read signs the caller in; before W2 it was a public read. */
    @Test
    void aWorldIsNoLongerAPublicRead() {
        assertThat(route("worlds-read").getFilters()).contains(authorization.platformAccount(), appCheck);
        assertThat(route("worlds-read").getPredicate().toString()).contains("/v1/worlds/{id}").contains("GET");
    }

    @Test
    void theAccountsRoutesAreTheirMethodsAndPaths() {
        assertThat(route("me-bootstrap").getPredicate().toString()).contains("/v1/me]").contains("POST");
        assertThat(route("me-read").getPredicate().toString()).contains("/v1/me]").contains("GET");
        assertThat(route("me-profile").getPredicate().toString()).contains("/v1/me/profile").contains("PATCH");
        assertThat(route("me-delete").getPredicate().toString()).contains("/v1/me]").contains("DELETE");
    }

    /** Everyone browses the showcase and its profiles, signed in or not (Q92): no sign-in, no App Check, an address bucket. */
    @Test
    void publicReadsRunNeitherSignInNorAppCheck() {
        for (String id : PUBLIC_READS) {
            List<GatewayFilter> filters = route(id).getFilters();
            assertThat(filters).as(id).doesNotContain(appCheck, appCheck.singleUse());
            assertThat(filters).as(id).noneMatch(f -> f instanceof AuthorizationFilter.PolicyFilter);
            assertThat(buckets(filters)).as(id).containsExactly("public-read");
        }
    }

    /** The review queue is driven by the runbook (W4): the allow-list, a token for the platform, ahead of forge's admin. */
    @Test
    void theAdminRowsNeedTheAllowListAndComeBeforeForgesAdminRoute() {
        AuthorizationFilter.PolicyFilter admin = (AuthorizationFilter.PolicyFilter) authorization.platformAdmin();
        assertThat(admin.policy()).isEqualTo(AuthorizationFilter.Policy.ADMIN);
        assertThat(admin.audience()).isEqualTo(InternalToken.AUDIENCE_PLATFORM);
        for (String id : ADMIN) {
            assertThat(route(id).getFilters()).as(id).contains(admin).doesNotContain(authorization.adminOnly());
            assertThat(buckets(route(id).getFilters())).as(id).containsExactly("admin");
            assertThat(route(id).getOrder()).as(id).isEqualTo(PlatformRoutes.AHEAD_OF_FORGE).isLessThan(route("admin").getOrder());
        }
        List<String> order = routeLocator.getRoutes().map(Route::getId).collectList().block();
        assertThat(order.indexOf("admin-submission-decide")).as("tried before /v1/admin/**").isLessThan(order.indexOf("admin"));
    }

    /** The waitlist is public, but a script would repeat it: App Check spent once, and a slow bucket of its own (W6). */
    @Test
    void theWaitlistIsPublicButSpendsItsAppCheckToken() {
        List<GatewayFilter> filters = route("waitlist").getFilters();
        assertThat(filters).contains(appCheck.singleUse()).doesNotContain(appCheck);
        assertThat(filters).noneMatch(f -> f instanceof AuthorizationFilter.PolicyFilter);
        assertThat(buckets(filters)).containsExactly("waitlist");
    }

    private Route route(String id) {
        Route route = routeLocator.getRoutes()
                .filter(candidate -> candidate.getId().equals(id))
                .blockFirst();
        assertThat(route).as("route " + id).isNotNull();
        return route;
    }

    private static List<String> buckets(List<GatewayFilter> filters) {
        return filters.stream()
                .filter(f -> f instanceof RateLimitFilter)
                .map(f -> ((RateLimitFilter) f).bucket())
                .toList();
    }
}
