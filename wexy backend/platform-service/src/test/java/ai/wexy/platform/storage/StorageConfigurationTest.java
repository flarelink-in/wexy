package ai.wexy.platform.storage;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W3's choice of object store (the creations platform design §8, §13): the private bucket only when all five values are
 * set, and never a public assets bucket, which the CDN Worker serves whole to anyone. Without a bucket, saving is 503
 * and accounts keep working (WorldRoutesTest). No call reaches B2 here: a client makes none until it is used.
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
    }

    @Test
    void requestsAreSignedForTheRegionB2sEndpointNames() {
        assertThat(with("p").signingRegion()).isEqualTo("us-east-005");
        assertThat(new StorageProperties("https://s3.us-east-005.backblazeb2.com", "us-east", "p", "k", "s", null, null).signingRegion())
                .as("Infisical dev's setting, overruled by the endpoint").isEqualTo("us-east-005");
        assertThat(new StorageProperties("http://127.0.0.1:9000", "local-1", "p", "k", "s", null, null).signingRegion())
                .as("another store: the setting").isEqualTo("local-1");
    }

    @Test
    void theSettingsNeverPrintTheKeys() {
        assertThat(with("wexy-private-dev").toString()).doesNotContain("key-id-not-a-secret").doesNotContain("key-not-a-secret");
    }
}
