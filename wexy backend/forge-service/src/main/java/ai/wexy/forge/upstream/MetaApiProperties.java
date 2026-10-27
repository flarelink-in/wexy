package ai.wexy.forge.upstream;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * Where the Meta Model API is, and the key to it (backend architecture §6.1). The key comes from
 * the environment only, and never reaches a browser, a log or a report.
 *
 * @param baseUrl         OpenAI-compatible, per Meta's docs: {@code https://api.meta.ai/v1}
 * @param apiKey          the secret; empty when not configured
 * @param connectTimeout  for opening a connection
 * @param readIdleTimeout the longest silence between two reads of a response
 */
@ConfigurationProperties(prefix = "wexy.meta-api")
public record MetaApiProperties(String baseUrl, String apiKey, Duration connectTimeout, Duration readIdleTimeout) {

    public MetaApiProperties {
        baseUrl = baseUrl == null || baseUrl.isBlank() ? "https://api.meta.ai/v1" : stripTrailingSlash(baseUrl.trim());
        apiKey = apiKey == null ? "" : apiKey.trim();
        connectTimeout = connectTimeout == null ? Duration.ofSeconds(5) : connectTimeout;
        readIdleTimeout = readIdleTimeout == null ? Duration.ofSeconds(30) : readIdleTimeout;
    }

    public boolean hasKey() {
        return !apiKey.isEmpty();
    }

    /** Overridden so that logging this record, ever, cannot print the key. */
    @Override
    public String toString() {
        return "MetaApiProperties[baseUrl=" + baseUrl + ", apiKey=" + (hasKey() ? "(set)" : "(missing)")
                + ", connectTimeout=" + connectTimeout + ", readIdleTimeout=" + readIdleTimeout + "]";
    }

    private static String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
