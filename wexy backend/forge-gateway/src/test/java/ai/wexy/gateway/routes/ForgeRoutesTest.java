package ai.wexy.gateway.routes;

import ai.wexy.gateway.appcheck.AppCheckFilter;
import ai.wexy.gateway.auth.AuthorizationFilter;
import ai.wexy.gateway.shield.GatewayShieldProperties;
import ai.wexy.gateway.shield.RateLimitFilter;
import ai.wexy.gateway.shield.RateLimits;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The route table against the API table (backend architecture §11; since W2 with the platform's, the
 * creations platform design §10, whose policies PlatformRoutesTest checks), and the contract with the
 * frontend: the routes that spend App Check tokens are exactly the ones the page mints a fresh
 * token for. Adding one without the page breaks it the moment replay protection is enforced;
 * dropping one gives a lifted token back its hour of replays. Both must be deliberate, so the set
 * is pinned exactly (FlareLink's SingleUseAppCheckRoutesTest, adapted).
 */
@SpringBootTest
@ActiveProfiles("test")
class ForgeRoutesTest {

    private static final List<String> PUBLIC_READS = List.of("forge-mode", "archive-match", "stats");
    private static final List<String> SIGNED_IN = List.of("forge-plan", "forge-author", "forge-repair",
            "forge-direct", "forge-outcomes", "agent-turn", "agent-module", "forge-allowance");
    /** The platform's routes (W2; PlatformRoutes), all of §10's table. */
    static final List<String> PLATFORM = List.of("me-bootstrap", "me-read", "me-profile", "me-usage", "me-operation",
            "me-delete", "profile-read", "profile-worlds", "worlds-create", "me-worlds", "worlds-read", "worlds-update",
            "worlds-delete", "worlds-revise", "worlds-revision", "worlds-poster", "worlds-submit", "worlds-withdraw",
            "showcase", "publication-read", "admin-submissions", "admin-submission-decide", "admin-publication-decide",
            "waitlist");

    @Autowired
    private RouteLocator routeLocator;

    @Autowired
    private AppCheckFilter appCheck;

    @Autowired
    private AuthorizationFilter authorization;

    @Autowired
    private GatewayShieldProperties shield;

    @Test
    void theRoutesAreExactlyTheApiTable() {
        List<String> ids = routeLocator.getRoutes().map(Route::getId).collectList().block();

        List<String> forge = List.of("forge-plan", "forge-author", "forge-repair", "forge-direct",
                "forge-outcomes", "agent-turn", "agent-module", "forge-allowance", "forge-mode", "archive-match",
                "stats", "admin");
        // W2: the worlds and the showcase left forge for the platform (share links' complete and report are gone).
        assertThat(ids).containsExactlyInAnyOrderElementsOf(java.util.stream.Stream.concat(forge.stream(), PLATFORM.stream()).toList());
    }

    /**
     * The routes that spend App Check, as the frontend's SINGLE_USE_ROUTES names them (test/http.test.mjs pins the same
     * list): POST /v1/forge/plan, /v1/agent/turn and /v1/agent/module; since W2 (§10) POST /v1/me, DELETE /v1/me, POST
     * /v1/worlds/{id}/submissions and POST /v1/waitlist. POST /v1/worlds left the set: a save takes the cached token.
     */
    @Test
    void exactlyTheRoutesTheFrontendMintsFreshTokensForSpendThem() {
        List<String> spending = routeLocator.getRoutes()
                .filter(route -> route.getFilters().contains(appCheck.singleUse()))
                .map(Route::getId)
                .collectList()
                .block();

        assertThat(spending).containsExactlyInAnyOrder("forge-plan", "agent-turn", "agent-module",
                "me-bootstrap", "me-delete", "worlds-submit", "waitlist");

        // Spending includes the attestation, so neither runs the plain check as well.
        assertThat(route("forge-plan").getFilters()).doesNotContain(appCheck);
        assertThat(route("me-bootstrap").getFilters()).doesNotContain(appCheck);
        assertThat(route("worlds-create").getFilters()).contains(appCheck).doesNotContain(appCheck.singleUse());
    }

    /**
     * W1 (the creations platform design §10): the caller's own allowance is a signed-in read, anonymous callers
     * included, with the cached App Check token (it spends nothing, so it is not single-use), an address bucket and a
     * per-uid one. The single-use set above is unchanged by it.
     */
    @Test
    void theAllowanceIsASignedInReadWithTheCachedCheck() {
        List<GatewayFilter> filters = route("forge-allowance").getFilters();
        assertThat(filters).contains(appCheck, authorization.anonymousAllowed()).doesNotContain(appCheck.singleUse());
        assertThat(buckets(filters)).containsExactly("account-read", "account-read-user");
        assertThat(route("forge-allowance").getPredicate().toString()).contains("/v1/forge/allowance").contains("GET");
    }

    @Test
    void theOtherWritesKeepTheOrdinaryCheck() {
        for (String id : List.of("forge-author", "forge-repair", "forge-direct", "forge-outcomes")) {
            assertThat(route(id).getFilters()).as(id)
                    .contains(appCheck)
                    .doesNotContain(appCheck.singleUse());
        }
    }

    /** Share pages and crawlers carry neither a sign-in nor an App Check token. */
    @Test
    void publicReadsRunNeitherSignInNorAppCheck() {
        for (String id : PUBLIC_READS) {
            List<GatewayFilter> filters = route(id).getFilters();
            assertThat(filters).as(id).doesNotContain(appCheck, appCheck.singleUse());
            assertThat(filters).as(id).noneMatch(f -> f instanceof AuthorizationFilter.PolicyFilter);
            assertThat(buckets(filters)).as(id).containsExactly("public-read");
        }
    }

    /**
     * Anonymous Firebase users create (Q8); only the allow-list administers. Every forge route's token is for forge alone
     * (W2): none of the platform's filters is on a forge route.
     */
    @Test
    void everyWriteSignsTheCallerInUnderItsPolicy() {
        for (String id : SIGNED_IN) {
            assertThat(route(id).getFilters()).as(id).contains(authorization.anonymousAllowed())
                    .doesNotContain(authorization.platformAccount(), authorization.platformAdmin());
        }
        assertThat(route("admin").getFilters()).contains(authorization.adminOnly())
                .doesNotContain(authorization.anonymousAllowed(), authorization.platformAdmin());
        assertThat(((AuthorizationFilter.PolicyFilter) authorization.anonymousAllowed()).audience())
                .isEqualTo(ai.wexy.common.InternalToken.AUDIENCE_FORGE);
        assertThat(((AuthorizationFilter.PolicyFilter) authorization.adminOnly()).audience())
                .isEqualTo(ai.wexy.common.InternalToken.AUDIENCE_FORGE);
    }

    /** Before any signature check, every route is budgeted by address. */
    @Test
    void everyRouteHasAnAddressBudgetBeforeSignIn() {
        for (Route route : routeLocator.getRoutes().collectList().block()) {
            assertThat(route.getFilters()).as(route.getId())
                    .anyMatch(f -> f instanceof RateLimitFilter limit && limit.getOrder() == RateLimits.PRE_AUTH_ORDER);
        }
    }

    /** An anonymous account costs a script nothing, so creating gets a tighter per-account budget. */
    @Test
    void createRoutesAreTieredForAnonymousCallers() {
        for (String id : List.of("forge-plan", "forge-author")) {
            RateLimits.Tiered tiered = route(id).getFilters().stream()
                    .filter(f -> f instanceof RateLimits.Tiered)
                    .map(f -> (RateLimits.Tiered) f)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(id + " has no tiered limiter"));
            assertThat(tiered.signedIn().bucket()).isEqualTo("forge-create-user");
            assertThat(tiered.anonymous().bucket()).isEqualTo("forge-create-anonymous");
            assertThat(tiered.getOrder()).isEqualTo(RateLimits.POST_AUTH_ORDER);
        }
    }

    /** An agent turn makes up to six model calls, so it is tiered like a create and its buckets count calls (Q66). */
    @Test
    void theAgentTurnIsTieredAndItsBucketsCountModelCalls() {
        RateLimits.Tiered tiered = route("agent-turn").getFilters().stream()
                .filter(f -> f instanceof RateLimits.Tiered)
                .map(f -> (RateLimits.Tiered) f)
                .findFirst()
                .orElseThrow(() -> new AssertionError("agent-turn has no tiered limiter"));
        assertThat(tiered.signedIn().bucket()).isEqualTo("agent-turn-user");
        assertThat(tiered.anonymous().bucket()).isEqualTo("agent-turn-anonymous");
        for (String bucket : List.of("agent-turn", "agent-turn-user", "agent-turn-anonymous")) {
            assertThat(shield.getBuckets().get(bucket).getRequestCost()).as(bucket).isEqualTo(ai.wexy.common.AgentTurn.MAX_CALLS);
        }
        assertThat(shield.getBuckets().get("forge-create-user").getRequestCost()).isEqualTo(1);
    }

    /**
     * The EA4.4 review: a candidate's program revision is a second turn right after the first, and an anonymous bucket of
     * one turn refused it for two minutes. Every bucket on the route takes a turn and its revision at once, on the
     * gateway's own bucket and its default sizes; an anonymous creator's third turn then waits for the refill.
     */
    @Test
    void aTurnAndItsProgramRevisionGoAtOnceEvenAnonymous() {
        for (String name : List.of("agent-turn", "agent-turn-user", "agent-turn-anonymous")) {
            GatewayShieldProperties.Bucket b = shield.getBuckets().get(name);
            ai.wexy.gateway.shield.LocalTokenBucket bucket = new ai.wexy.gateway.shield.LocalTokenBucket(b.getRefillPerSecond(), b.getBurstCapacity(), 10);
            assertThat(bucket.tryConsume("uid", b.getRequestCost()).allowed()).as("%s: the turn", name).isTrue();
            assertThat(bucket.tryConsume("uid", b.getRequestCost()).allowed()).as("%s: its revision, at once", name).isTrue();
        }
        GatewayShieldProperties.Bucket anonymous = shield.getBuckets().get("agent-turn-anonymous");
        ai.wexy.gateway.shield.LocalTokenBucket bucket = new ai.wexy.gateway.shield.LocalTokenBucket(anonymous.getRefillPerSecond(), anonymous.getBurstCapacity(), 10);
        bucket.tryConsume("uid", anonymous.getRequestCost());
        bucket.tryConsume("uid", anonymous.getRequestCost());
        assertThat(bucket.tryConsume("uid", anonymous.getRequestCost()).allowed()).as("a third anonymous turn waits for the refill").isFalse();
        assertThat(anonymous.getRefillPerSecond() * 120).as("then one turn every two minutes")
                .isCloseTo(anonymous.getRequestCost(), org.assertj.core.api.Assertions.within(1e-9));
    }

    /**
     * A module call is one model call (EA4.2): tiered as a turn is, a token a request, at an attempt's module calls
     * (AgentTurn.MODULE_CALLS: 22 since Q84's revision on 2026-11-02, seven before), at the turns' pace.
     */
    @Test
    void theModuleCallIsTieredAndItsBucketsCountOneCallEach() {
        RateLimits.Tiered tiered = route("agent-module").getFilters().stream()
                .filter(f -> f instanceof RateLimits.Tiered)
                .map(f -> (RateLimits.Tiered) f)
                .findFirst()
                .orElseThrow(() -> new AssertionError("agent-module has no tiered limiter"));
        assertThat(tiered.signedIn().bucket()).isEqualTo("agent-module-user");
        assertThat(tiered.anonymous().bucket()).isEqualTo("agent-module-anonymous");
        for (String bucket : List.of("agent-module", "agent-module-user", "agent-module-anonymous")) {
            assertThat(shield.getBuckets().get(bucket).getRequestCost()).as(bucket).isEqualTo(1);
        }
        // Anonymous: one attempt at once, then one every two minutes; signed in: two, then one a minute; a client: four,
        // then two every 30 s.
        int attempt = ai.wexy.common.AgentTurn.MODULE_CALLS;
        assertThat(attempt).as("twelve authors and ten repairs (the frontend's Q_C)").isEqualTo(22);
        GatewayShieldProperties.Bucket anonymous = shield.getBuckets().get("agent-module-anonymous");
        GatewayShieldProperties.Bucket user = shield.getBuckets().get("agent-module-user");
        GatewayShieldProperties.Bucket client = shield.getBuckets().get("agent-module");
        assertThat(anonymous.getBurstCapacity()).isEqualTo(attempt);
        assertThat(anonymous.getRefillPerSecond() * 120).isCloseTo(attempt, org.assertj.core.api.Assertions.within(1e-9));
        assertThat(user.getBurstCapacity()).isEqualTo(2 * attempt);
        assertThat(user.getRefillPerSecond() * 60).isCloseTo(attempt, org.assertj.core.api.Assertions.within(1e-9));
        assertThat(client.getBurstCapacity()).isEqualTo(4 * attempt);
        assertThat(client.getRefillPerSecond() * 30).isCloseTo(2 * attempt, org.assertj.core.api.Assertions.within(1e-9));
        assertThat(route("agent-module").getFilters()).contains(appCheck.singleUse()).doesNotContain(appCheck);
    }

    /**
     * A profile that names a bucket replaces it whole, so one that forgets the agent's request cost (it falls to 1)
     * stops the gateway when the routes are built, rather than letting six times the turns through (gate A).
     */
    @Test
    void anAgentBucketThatChargesOtherThanATurnsCallsStopsTheGateway() {
        GatewayShieldProperties properties = new GatewayShieldProperties();
        new org.springframework.boot.context.properties.bind.Binder(
                new org.springframework.boot.context.properties.source.MapConfigurationPropertySource(java.util.Map.of(
                        "wexy.shield.buckets.agent-turn-user.refill-per-second", "30",
                        "wexy.shield.buckets.agent-turn-user.burst-capacity", "600")))
                .bind("wexy.shield", org.springframework.boot.context.properties.bind.Bindable.ofInstance(properties));

        // The profile's bucket replaced the default whole: its cost fell to 1, six times the turns.
        assertThat(properties.getBuckets().get("agent-turn-user").getRequestCost()).isEqualTo(1);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> properties.bucket("agent-turn-user"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("request-cost must be " + ai.wexy.common.AgentTurn.MAX_CALLS);
        assertThat(properties.bucket("agent-turn").getRequestCost()).isEqualTo(ai.wexy.common.AgentTurn.MAX_CALLS);
        assertThat(properties.bucket("forge-create-user").getRequestCost()).isEqualTo(1);
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
