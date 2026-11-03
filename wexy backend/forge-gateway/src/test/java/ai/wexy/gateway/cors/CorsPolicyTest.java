package ai.wexy.gateway.cors;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.web.cors.CorsConfiguration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Adapted from FlareLink's CorsPolicyTest (pre-existing work): one policy now, so it cannot drift. */
class CorsPolicyTest {

    /** Shaped like WEXY_CORS_ALLOWED_ORIGINS, spacing included. */
    private static CorsConfiguration policy() {
        return new CorsPolicy("https://wexy.ai, https://www.wexy.ai").configuration();
    }

    @Test
    void originsComeFromTheCommaSeparatedProperty() {
        assertThat(policy().getAllowedOrigins()).containsExactly("https://wexy.ai", "https://www.wexy.ai");
    }

    /** Every browser call would fail preflight, so the gateway refuses to start instead. */
    @Test
    void anEmptyOriginListIsRefused() {
        assertThatThrownBy(() -> new CorsPolicy(" , ")).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aWildcardOriginIsRefused() {
        assertThatThrownBy(() -> new CorsPolicy("https://wexy.ai,*")).isInstanceOf(IllegalStateException.class);
    }

    /**
     * The methods the routes use and no more: since W2 the platform's PATCH and DELETE (the creations platform design
     * §10, PL-T17); PUT is still surface nobody asked for.
     */
    @Test
    void exactlyTheMethodsTheRoutesUse() {
        assertThat(policy().getAllowedMethods())
                .containsExactlyInAnyOrder(HttpMethod.GET.name(), HttpMethod.POST.name(), HttpMethod.PATCH.name(),
                        HttpMethod.DELETE.name(), HttpMethod.OPTIONS.name());
    }

    /**
     * PL-T17: a PATCH or a DELETE with an Idempotency-Key passes preflight from a Wexy origin, and from no other: the
     * policy answers another origin's preflight with no allowance at all.
     */
    @Test
    void platformPreflightsPassFromWexyOriginsOnly() {
        CorsConfiguration policy = policy();
        for (HttpMethod method : new HttpMethod[]{HttpMethod.PATCH, HttpMethod.DELETE}) {
            assertThat(policy.checkOrigin("https://wexy.ai")).as(method.name()).isEqualTo("https://wexy.ai");
            assertThat(policy.checkHttpMethod(method)).as(method.name()).contains(method);
            assertThat(policy.checkHeaders(java.util.List.of("Idempotency-Key", "X-Firebase-AppCheck")))
                    .as(method.name()).containsExactlyInAnyOrder("Idempotency-Key", "X-Firebase-AppCheck");
            assertThat(policy.checkOrigin("https://evil.example")).as(method.name()).isNull();
        }
        assertThat(policy.checkHttpMethod(HttpMethod.PUT)).isNull();
    }

    /** A throttled client has to be able to read the back-off hint. */
    @Test
    void rateLimitHeadersAreReadableByTheBrowser() {
        assertThat(policy().getExposedHeaders()).contains("Retry-After", "X-RateLimit-Remaining");
    }

    /**
     * Every header the page sends must survive preflight. The App Check header is the one that bit
     * FlareLink: missing here, it failed every preflight with an opaque CORS error.
     */
    @Test
    void allowsEveryHeaderTheClientSends() {
        assertThat(policy().getAllowedHeaders()).contains("Authorization", "Content-Type", "X-Firebase-AppCheck", "Idempotency-Key");
    }
}
