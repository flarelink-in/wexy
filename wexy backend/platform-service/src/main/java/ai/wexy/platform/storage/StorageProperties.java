package ai.wexy.platform.storage;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * The private bucket's settings (W3.1; the creations platform design §8, §11), from the environment under the names the
 * user put in Infisical on 2026-11-03: {@code B2_ENDPOINT}, {@code B2_REGION}, {@code B2_BUCKET_KEY} (taken to be the
 * bucket's name: to confirm), {@code B2_ACCESS_KEY} and {@code B2_SECRET_KEY}. None is ever logged. With any missing,
 * the world routes answer 503 and accounts keep working.
 *
 * @param endpoint       B2's S3 endpoint, such as {@code https://s3.us-east-005.backblazeb2.com} (a bare host gets https)
 * @param region         its region, such as {@code us-east-005}
 * @param bucket         the private bucket's name: saved worlds only, never the public assets bucket
 * @param accessKey      the application key's id
 * @param secretKey      the application key
 * @param attemptTimeout one attempt's bound (§11: 5 s)
 * @param callTimeout    a call's bound, retries included
 */
@ConfigurationProperties(prefix = "wexy.storage.b2")
public record StorageProperties(String endpoint, String region, String bucket, String accessKey, String secretKey,
                                Duration attemptTimeout, Duration callTimeout) {

    public StorageProperties {
        attemptTimeout = attemptTimeout == null ? Duration.ofSeconds(5) : attemptTimeout;
        callTimeout = callTimeout == null ? Duration.ofSeconds(15) : callTimeout;
    }

    /** Whether every value is present. */
    public boolean complete() {
        return present(endpoint) && present(region) && present(bucket) && present(accessKey) && present(secretKey);
    }

    /** The names of the values that are missing, for the startup line: names, never values. */
    public String missing() {
        StringBuilder out = new StringBuilder();
        if (!present(endpoint)) out.append(" B2_ENDPOINT");
        if (!present(region)) out.append(" B2_REGION");
        if (!present(bucket)) out.append(" B2_BUCKET_KEY");
        if (!present(accessKey)) out.append(" B2_ACCESS_KEY");
        if (!present(secretKey)) out.append(" B2_SECRET_KEY");
        return out.toString().trim();
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }

    /** Never the keys. */
    @Override
    public String toString() {
        return "StorageProperties[endpoint=" + endpoint + ", region=" + region + ", bucket=" + bucket + ", keys=<withheld>]";
    }
}
