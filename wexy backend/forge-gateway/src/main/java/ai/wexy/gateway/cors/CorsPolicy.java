package ai.wexy.gateway.cors;

import ai.wexy.gateway.appcheck.AppCheckFilter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.reactive.CorsWebFilter;
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource;
import org.springframework.web.util.pattern.PathPatternParser;

import java.util.Arrays;
import java.util.List;

/**
 * One CORS policy; only the origins differ between environments (backend architecture §10: Wexy's
 * origins only).
 *
 * Adapted from FlareLink's CorsPolicies and its two configurations (pre-existing work), which
 * drifted: prod lost PATCH and failed preflight there alone. Here there is one class and one list
 * of methods and headers, and the origins come from {@code wexy.cors.allowed-origins}.
 */
@Configuration
public class CorsPolicy {

    private static final Logger log = LoggerFactory.getLogger(CorsPolicy.class);

    /** Every method the routes use, plus OPTIONS for preflight. Wexy's API has no PUT, PATCH or DELETE. */
    static final List<HttpMethod> ALLOWED_METHODS = List.of(HttpMethod.GET, HttpMethod.POST, HttpMethod.OPTIONS);

    /**
     * The App Check header is load-bearing: a custom header makes a request non-simple, and one
     * missing here fails the preflight, which the browser reports as an opaque CORS error.
     */
    static final List<String> ALLOWED_HEADERS = List.of(
            HttpHeaders.AUTHORIZATION, HttpHeaders.CONTENT_TYPE, AppCheckFilter.APP_CHECK_HEADER);

    /** Readable by the page, so a throttled client can back off instead of guessing. */
    static final List<String> EXPOSED_HEADERS = List.of(
            HttpHeaders.CONTENT_TYPE, HttpHeaders.RETRY_AFTER, "X-RateLimit-Remaining");

    /** One preflight per hour per origin instead of one per request. */
    static final long PREFLIGHT_MAX_AGE_SECONDS = 3600L;

    private final List<String> allowedOrigins;

    public CorsPolicy(@Value("${wexy.cors.allowed-origins}") String allowedOrigins) {
        this.allowedOrigins = Arrays.stream(allowedOrigins.split(","))
                .map(String::trim)
                .filter(origin -> !origin.isEmpty())
                .toList();

        // Both are configuration mistakes that would surface far from here: an empty list fails every
        // preflight (the whole API looks down), and a wildcard lets any site call the API from a
        // visitor's browser.
        if (this.allowedOrigins.isEmpty()) {
            throw new IllegalStateException("wexy.cors.allowed-origins is empty.");
        }
        if (this.allowedOrigins.contains("*")) {
            throw new IllegalStateException("wexy.cors.allowed-origins must list origins explicitly, not '*'.");
        }
    }

    public CorsConfiguration configuration() {
        CorsConfiguration config = new CorsConfiguration();
        allowedOrigins.forEach(config::addAllowedOrigin);
        ALLOWED_METHODS.forEach(config::addAllowedMethod);
        ALLOWED_HEADERS.forEach(config::addAllowedHeader);
        EXPOSED_HEADERS.forEach(config::addExposedHeader);
        config.setMaxAge(PREFLIGHT_MAX_AGE_SECONDS);
        return config;
    }

    /**
     * Ahead of the shield filters, so CORS headers are already on a refusal; otherwise a browser
     * reports a 429 as an opaque CORS failure instead of a readable one.
     */
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public CorsWebFilter corsWebFilter() {
        log.info("CORS allowing origins: {}", allowedOrigins);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource(new PathPatternParser());
        source.registerCorsConfiguration("/**", configuration());
        return new CorsWebFilter(source);
    }
}
