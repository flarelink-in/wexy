package ai.wexy.platform.storage;

import ai.wexy.common.Ulid;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * W3.7's qualification of the real private bucket (the creations platform design §8, PL-T10, PL-T20), on the user's word
 * only (2026-11-03: "yes u can use infisical dev to use real B2 keys for testing as its dev env"). Not a test the build
 * runs: no Test suffix, so surefire runs it only when named.
 *
 * <pre>infisical run --env=dev -- ./mvnw -B -ntp -pl forge-common,platform-service -am test -Dtest=B2Qualification -Dsurefire.failIfNoSpecifiedTests=false</pre>
 *
 * It writes a few objects of a few bytes under {@code qualification/}, reads, refuses and deletes them, and erases every
 * version it wrote before it ends. It prints what B2 did, and the endpoint, region and bucket name (none a credential);
 * never a key. A few free Class A writes and deletes, a few Class B reads, a Class C listing or two.
 */
class B2Qualification {

    private static String env(String name) {
        String value = System.getenv(name);
        return value == null ? "" : value.trim();
    }

    private static String md5(byte[] bytes) throws Exception {
        return Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes));
    }

    private static void say(String line) {
        System.out.println("B2-QUALIFICATION " + line);
    }

    @Test
    void thePrivateBucketKeepsTheRulesThePlatformCountsOn() throws Exception {
        StorageProperties p = new StorageProperties(env("B2_ENDPOINT"), env("B2_REGION"), env("B2_PRIVATE_BUCKET_NAME"),
                env("B2_PRIVATE_ACCESS_KEY"), env("B2_PRIVATE_SECRET_KEY"), null, null);
        assertThat(p.complete()).as("missing: " + p.missing()).isTrue();
        say("endpoint=" + p.endpoint() + " region=" + p.region() + " (signed as " + p.signingRegion() + ") bucket=" + p.bucket()
                + " keys=<set, not shown>");
        assertThat(StorageConfiguration.PUBLIC_BUCKETS).as("never a public assets bucket").doesNotContain(p.bucket());
        String prefix = "qualification/" + Ulid.next(Instant.now()) + "/";
        String key = prefix + "world.json";
        byte[] first = "{\"qualification\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] second = "{\"qualification\":2}".getBytes(StandardCharsets.UTF_8);
        String ct = "application/json; charset=utf-8";
        List<String> written = new ArrayList<>(List.of(key, prefix + "altered.json", prefix + "bounded.json", prefix + "default-checksums.json"));
        try (B2ObjectStore b2 = new B2ObjectStore(p)) {
            try {
                ObjectStore.Written v1 = b2.put(key, first, ct, md5(first));
                say("put: version id " + (v1.versionId() == null ? "NONE" : "given"));
                assertThat(v1.versionId()).as("B2 names the version it wrote").isNotBlank();
                assertThat(b2.get(key, v1.versionId(), 1024)).isEqualTo(first);
                assertThat(b2.get(key, null, 1024)).isEqualTo(first);
                say("get: by version and latest, the bytes written");

                assertThatThrownBy(() -> b2.put(prefix + "altered.json", first, ct, md5(second)))
                        .isInstanceOf(ObjectStore.StorageUnavailable.class);
                assertThat(b2.get(prefix + "altered.json", null, 1024)).as("nothing kept under the altered write").isNull();
                say("put with another Content-MD5: refused, nothing kept");

                ObjectStore.Written v2 = b2.put(key, second, ct, md5(second));
                b2.delete(key, v1.versionId());
                assertThat(b2.get(key, v1.versionId(), 1024)).as("the first version erased by its id").isNull();
                assertThat(b2.get(key, null, 1024)).as("the second untouched").isEqualTo(second);
                say("delete by version id: that version gone, the other kept");

                byte[] big = new byte[2048];
                b2.put(prefix + "bounded.json", big, ct, md5(big));
                assertThatThrownBy(() -> b2.get(prefix + "bounded.json", null, 1024)).isInstanceOf(ObjectStore.StorageUnavailable.class);
                say("a read past its bound: refused");

                b2.delete(key, null);
                assertThat(b2.get(key, null, 1024)).as("every version erased").isNull();
                assertThat(v2.versionId()).isNotBlank();
                say("delete of every version: none left");
            } finally {
                for (String k : written) {
                    try {
                        b2.delete(k, null);
                    } catch (RuntimeException e) {
                        say("cleanup of " + k + " failed: " + e.getMessage());
                    }
                }
            }
        }

        // The SDK's newer default checksums, which B2 does not document ([S14]): recorded, so W3 can tell whether the
        // WHEN_REQUIRED precaution is still needed.
        String endpoint = p.endpoint().contains("://") ? p.endpoint() : "https://" + p.endpoint();
        try (S3Client defaults = S3Client.builder().endpointOverride(URI.create(endpoint)).region(Region.of(p.signingRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(p.accessKey(), p.secretKey())))
                .forcePathStyle(true)
                .httpClientBuilder(software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient.builder())
                .build()) {
            String k = prefix + "default-checksums.json";
            try {
                defaults.putObject(PutObjectRequest.builder().bucket(p.bucket()).key(k).build(), RequestBody.fromBytes(first));
                say("the SDK's default checksums: accepted by B2");
            } catch (RuntimeException e) {
                say("the SDK's default checksums: refused (" + e.getClass().getSimpleName() + ")");
            } finally {
                defaults.listObjectVersions(ListObjectVersionsRequest.builder().bucket(p.bucket()).prefix(k).build()).versions()
                        .forEach(v -> defaults.deleteObject(DeleteObjectRequest.builder().bucket(p.bucket()).key(k).versionId(v.versionId()).build()));
            }
        }

        // PL-T10: platform's key should reach its private bucket alone. A read of the public assets bucket's name tells.
        StorageProperties assets = new StorageProperties(p.endpoint(), p.region(), "wexy-assets-dev", p.accessKey(), p.secretKey(), null, null);
        try (B2ObjectStore other = new B2ObjectStore(assets)) {
            try {
                byte[] got = other.get("qualification/no-such-object", null, 1024);
                say("PL-T10: the key READS wexy-assets-dev (" + (got == null ? "404" : "an object") + "): it is not limited to its bucket");
            } catch (ObjectStore.StorageUnavailable refused) {
                say("PL-T10: the key is refused by wexy-assets-dev (" + refused.getMessage() + "): limited to its bucket");
            }
        }
    }
}
