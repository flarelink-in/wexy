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

    /** Wexy's API uses GET and POST only; anything more is surface nobody asked for. */
    @Test
    void exactlyTheMethodsTheRoutesUse() {
        assertThat(policy().getAllowedMethods())
                .containsExactlyInAnyOrder(HttpMethod.GET.name(), HttpMethod.POST.name(), HttpMethod.OPTIONS.name());
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
        assertThat(policy().getAllowedHeaders()).contains("Authorization", "Content-Type", "X-Firebase-AppCheck");
    }
}
