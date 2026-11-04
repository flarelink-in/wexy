package ai.wexy.platform.storage;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W3's choice of object store (the creations platform design §8, §13): the private bucket only when its own five values
 * are set, each used as set, and never a public assets bucket, which the CDN Worker serves whole to anyone. Without a
 * bucket, saving is 503 and accounts keep working (WorldRoutesTest). No call reaches B2 here: a client makes none until
 * it is used.
 */
class StorageConfigurationTest {

    private static StorageProperties with(String bucket) {
        return new StorageProperties("s3.us-east-005.backblazeb2.com", "us-east-005", bucket, "key-id-not-a-secret",
                "key-not-a-secret", null, null);
    }

    @Test
    void thePrivateBucketWithAllFiveValuesIsB2() {
        ObjectStore store = new StorageConfiguration().objectStore(with("wexy-private-dev"));
        assertThat(store).isInstanceOf(B2ObjectStore.class);
        assertThat(store.configured()).isTrue();
        ((B2ObjectStore) store).close();
    }

    @Test
    void aMissingValueOrAPublicBucketIsNoStoreAtAll() {
        assertThat(new StorageConfiguration().objectStore(with("")).configured()).isFalse();
        assertThat(new StorageConfiguration().objectStore(with("wexy-assets-dev")).configured()).isFalse();
        assertThat(new StorageConfiguration().objectStore(with(" wexy-assets-prod ")).configured()).isFalse();
        assertThat(with(null).missing()).isEqualTo("B2_PRIVATE_BUCKET_NAME");
        assertThat(new StorageProperties(null, " ", "p", "k", "s", null, null).missing())
                .isEqualTo("B2_PRIVATE_ENDPOINT B2_PRIVATE_REGION");
    }

    @Test
    void aRegionTheEndpointDoesNotNameIsUsedAsSet() {
        // Infisical dev's B2_PRIVATE_REGION, us-east, beside the endpoint's us-east-005: B2 answered a signature for it
        // (W3.7's qualification, 2026-11-04), so it is neither refused nor replaced.
        for (String region : new String[]{"us-east", " us-east-005 "}) {
            ObjectStore store = new StorageConfiguration().objectStore(new StorageProperties("https://s3.us-east-005.backblazeb2.com",
                    region, "wexy-private-dev", "k", "s", null, null));
            assertThat(store.configured()).as(region).isTrue();
            ((B2ObjectStore) store).close();
        }
    }

    /**
     * The service's own application.yaml, bound beside both buckets' names as Infisical dev holds them: the private
     * bucket's five are read, and none of the assets bucket's (W4's), whatever they say.
     */
    @Test
    void theServiceReadsThePrivateBucketsOwnFiveNamesAlone() throws Exception {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("infisical", Map.of(
                "B2_PRIVATE_ENDPOINT", "private-endpoint", "B2_PRIVATE_REGION", "private-region",
                "B2_PRIVATE_BUCKET_NAME", "private-bucket", "B2_PRIVATE_ACCESS_KEY", "private-key-id",
                "B2_PRIVATE_SECRET_KEY", "private-key",
                "B2_ENDPOINT", "assets-endpoint", "B2_REGION", "assets-region", "B2_BUCKET_NAME", "wexy-assets-dev",
                "B2_ACCESS_KEY", "assets-key-id", "B2_SECRET_KEY", "assets-key")));
        for (PropertySource<?> yaml : new YamlPropertySourceLoader().load("application.yaml", new ClassPathResource("application.yaml"))) {
            environment.getPropertySources().addLast(yaml);
        }
        StorageProperties p = Binder.get(environment).bind("wexy.storage.b2", StorageProperties.class).get();
        assertThat(List.of(p.endpoint(), p.region(), p.bucket(), p.accessKey(), p.secretKey()))
                .containsExactly("private-endpoint", "private-region", "private-bucket", "private-key-id", "private-key");
    }

    @Test
    void theSettingsNeverPrintTheKeys() {
        assertThat(with("wexy-private-dev").toString()).doesNotContain("key-id-not-a-secret").doesNotContain("key-not-a-secret");
    }
}
