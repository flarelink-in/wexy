package ai.wexy.platform.storage;

import ai.wexy.common.Ulid;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest;
import software.amazon.awssdk.services.s3.model.ListObjectVersionsResponse;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

/**
 * W3.7's qualification of the real private bucket (the creations platform design §8, PL-T10, PL-T20), on the user's word
 * only (2026-11-03: "yes u can use infisical dev to use real B2 keys for testing as its dev env"; 2026-11-04: "u could
 * carry on B2 testing"). Not a test the build runs: no Test suffix, so surefire runs it only when named. From {@code
 * wexy backend}, through Git Bash, since {@code infisical run} starts its command through cmd.exe on Windows, and with
 * the Windows certificate store for the forked JVM's HTTPS (the gotchas' Avast):
 *
 * <pre>infisical run --env=dev -- "C:/Program Files/Git/usr/bin/bash.exe" -c "JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT ./mvnw -B -o -ntp -pl forge-common,platform-service -am test -Dtest=B2Qualification -Dsurefire.failIfNoSpecifiedTests=false"</pre>
 *
 * <p>(Forward slashes: a backslash before a {@code u} is a Unicode escape to javac, even in a comment.)
 *
 * <p>First what it can learn without writing, every finding reported together: the key and the bucket as B2's native API
 * describes them (which buckets the key reaches, the bucket's type, its lifecycle rules: the S3 API says none of these),
 * the assets bucket's key, and B2's answer to a signature for another region than the endpoint's. Only then, with all of
 * that as required, it writes a few objects of a few bytes under {@code qualification/}, reads, refuses and erases them,
 * and checks that no version is left. It prints what B2 did, and the endpoint, region and bucket name (none a
 * credential); never a key or a token. About twenty transactions, inside B2's free daily allowances.
 */
class B2Qualification {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private static final String CT = "application/json; charset=utf-8";

    /** Whatever must never be printed: every line passes through {@link #say}, which withholds them. */
    private final List<String> secrets = new ArrayList<>();

    /** What b2_authorize_account says of a key; {@code buckets} null when the key reaches every bucket. */
    private record Authorized(String accountId, String token, String apiUrl, String downloadUrl, List<String> buckets,
                              List<String> capabilities, String namePrefix) {

        /** The rights platform never uses: changing a bucket's settings (its type among them), or sharing its files. */
        List<String> beyondItsNeeds() {
            return capabilities.stream().filter(c -> c.equals("shareFiles") || c.startsWith("write") && !c.equals("writeFiles")).toList();
        }
    }

    private static String env(String name) {
        String value = System.getenv(name);
        return value == null ? "" : value.trim();
    }

    private static String md5(byte[] bytes) throws Exception {
        return Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes));
    }

    private static String https(String endpoint) {
        String e = endpoint.endsWith("/") ? endpoint.substring(0, endpoint.length() - 1) : endpoint;
        return e.contains("://") ? e : "https://" + e;
    }

    private void say(String line) {
        String out = line;
        for (String s : secrets) {
            if (!s.isBlank()) {
                out = out.replace(s, "<withheld>");
            }
        }
        System.out.println("B2-QUALIFICATION " + out);
    }

    private static String detail(S3Exception e) {
        return "status=" + e.statusCode() + " code=" + (e.awsErrorDetails() == null ? "none" : e.awsErrorDetails().errorCode())
                + " message=" + (e.awsErrorDetails() == null ? "none" : e.awsErrorDetails().errorMessage());
    }

    /** A client as B2ObjectStore's, signed for {@code region}; with the SDK's own default checksums when {@code defaults}. */
    private static S3Client client(StorageProperties p, String region, boolean defaults) {
        S3ClientBuilder b = S3Client.builder().endpointOverride(URI.create(https(p.endpoint()))).region(Region.of(region))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(p.accessKey(), p.secretKey())))
                .forcePathStyle(true)
                .httpClientBuilder(UrlConnectionHttpClient.builder());
        if (!defaults) {
            b.requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                    .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED);
        }
        return b.build();
    }

    /** B2's native b2_authorize_account (v3), or null with what B2 said when it refuses the key. */
    private Authorized authorize(String who, String keyId, String key) throws Exception {
        String basic = Base64.getEncoder().encodeToString((keyId + ":" + key).getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create("https://api.backblazeb2.com/b2api/v3/b2_authorize_account"))
                .header("Authorization", "Basic " + basic).timeout(Duration.ofSeconds(15)).GET().build(), HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() != 200) {
            say(who + ": refused at b2_authorize_account, status=" + r.statusCode() + " " + r.body());
            return null;
        }
        JsonNode body = JSON.readTree(r.body());
        secrets.add(body.path("authorizationToken").asText());
        // v3 as B2 answered it on 2026-11-04: a key's restriction under apiInfo.storageApi, a bucket key's as its
        // bucketName (a key of several buckets, should B2 give one, as a list of them).
        JsonNode api = body.path("apiInfo").path("storageApi");
        List<String> buckets = null;
        if (api.path("bucketName").isTextual()) {
            buckets = List.of(api.path("bucketName").asText());
        } else if (api.path("buckets").isArray()) {
            buckets = new ArrayList<>();
            for (JsonNode b : api.path("buckets")) {
                buckets.add(b.path("name").asText());
            }
        }
        List<String> capabilities = new ArrayList<>();
        api.path("capabilities").forEach(c -> capabilities.add(c.asText()));
        return new Authorized(body.path("accountId").asText(), body.path("authorizationToken").asText(), api.path("apiUrl").asText(),
                api.path("downloadUrl").asText(), buckets, capabilities.stream().sorted().toList(), api.path("namePrefix").toString());
    }

    /** The bucket as b2_list_buckets describes it, or null with what B2 said when the key may not list it. */
    private JsonNode bucket(Authorized a, String name) throws Exception {
        String request = JSON.writeValueAsString(Map.of("accountId", a.accountId(), "bucketName", name));
        HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(a.apiUrl() + "/b2api/v3/b2_list_buckets"))
                .header("Authorization", a.token()).timeout(Duration.ofSeconds(15))
                .POST(HttpRequest.BodyPublishers.ofString(request)).build(), HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() != 200) {
            say("b2_list_buckets: refused, status=" + r.statusCode() + " " + r.body());
            return null;
        }
        JsonNode found = JSON.readTree(r.body()).path("buckets").path(0);
        return found.isMissingNode() ? null : found;
    }

    private static HttpResponse<byte[]> download(URI uri, String token) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(15)).GET();
        if (token != null) {
            request.header("Authorization", token);
        }
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    @Test
    void thePrivateBucketKeepsTheRulesThePlatformCountsOn() throws Exception {
        StorageProperties p = new StorageProperties(env("B2_PRIVATE_ENDPOINT"), env("B2_PRIVATE_REGION"),
                env("B2_PRIVATE_BUCKET_NAME"), env("B2_PRIVATE_ACCESS_KEY"), env("B2_PRIVATE_SECRET_KEY"), null, null);
        String assetsKeyId = env("B2_ACCESS_KEY");
        String assetsKey = env("B2_SECRET_KEY");
        secrets.addAll(List.of(p.accessKey(), p.secretKey(), assetsKeyId, assetsKey));
        assertThat(p.complete()).as("missing: " + p.missing()).isTrue();
        say("endpoint=" + p.endpoint() + " region=" + p.region() + " bucket=" + p.bucket() + " keys=<set, not shown>");
        assertThat(StorageConfiguration.PUBLIC_BUCKETS).as("never a public assets bucket").doesNotContain(p.bucket());

        // ---- What can be learned without writing anything; every finding reported together. ----
        SoftAssertions softly = new SoftAssertions();

        Authorized granted = authorize("the private key", p.accessKey(), p.secretKey());
        assertThat(granted).as("B2 knows the private key").isNotNull();
        say("PL-T10 the private key: buckets=" + (granted.buckets() == null ? "EVERY BUCKET" : granted.buckets())
                + " capabilities=" + granted.capabilities() + " namePrefix=" + granted.namePrefix());
        say("PL-T10 the private key's rights beyond platform's needs (recorded, not refused): " + granted.beyondItsNeeds());
        softly.assertThat(granted.buckets()).as("PL-T10: platform's key reaches its private bucket alone").containsExactly(p.bucket());
        softly.assertThat(granted.downloadUrl()).as("B2's download URL, for the anonymous read below").startsWith("https://");

        JsonNode bucket = bucket(granted, p.bucket());
        if (bucket == null) {
            say("PL-T20 the bucket's type and lifecycle rules: not readable with this key; anonymous reads are still tried below");
        } else {
            JsonNode rules = bucket.path("lifecycleRules");
            say("PL-T20 the bucket: type=" + bucket.path("bucketType").asText() + " lifecycleRules=" + rules);
            softly.assertThat(bucket.path("bucketType").asText()).as("a private bucket: nothing read without a key").isEqualTo("allPrivate");
            boolean oneDay = false;
            boolean hidesLiveFiles = false;
            for (JsonNode rule : rules) {
                oneDay |= rule.path("fileNamePrefix").asText().isEmpty() && rule.path("daysFromHidingToDeleting").asInt(-1) == 1;
                hidesLiveFiles |= rule.hasNonNull("daysFromUploadingToHiding");
            }
            softly.assertThat(oneDay).as("PL-T20: a rule on every name erasing a hidden or older version after 1 day").isTrue();
            softly.assertThat(hidesLiveFiles).as("no rule hides a file some days after its upload: that would erase saved worlds").isFalse();
        }

        Authorized assets = null;
        if (assetsKeyId.isEmpty() || assetsKey.isEmpty()) {
            say("PL-T10 the assets bucket's key: not set here, not tried");
        } else {
            assets = authorize("the assets bucket's key", assetsKeyId, assetsKey);
            if (assets != null) {
                say("PL-T10 the assets bucket's key: buckets=" + (assets.buckets() == null ? "EVERY BUCKET" : assets.buckets())
                        + " capabilities=" + assets.capabilities() + " namePrefix=" + assets.namePrefix());
            }
        }

        // The region: B2_PRIVATE_REGION is used as set (2026-11-04), so what B2 does with a signature for another region
        // than the one its endpoint names is recorded here: the setting itself, and one of another continent.
        java.util.regex.Matcher host = java.util.regex.Pattern.compile("(?:https?://)?s3\\.([a-z0-9-]+)\\.backblazeb2\\.com/?").matcher(p.endpoint());
        String named = host.matches() ? host.group(1) : "none";
        for (String region : new String[]{p.region(), "eu-central-003"}) {
            try (S3Client signed = client(p, region, false)) {
                signed.getObject(GetObjectRequest.builder().bucket(p.bucket()).key("qualification/no-such-object").build()).close();
                say("a signature for " + region + " (the endpoint names " + named + "): answered, an object read");
            } catch (S3Exception e) {
                say("a signature for " + region + " (the endpoint names " + named + "): "
                        + (e.statusCode() == 404 ? "answered (404, no such object)" : "refused, " + detail(e)));
            }
        }
        softly.assertAll();

        // ---- Only now, the bucket, its key and its region as required: writes, reads, refusals, erasures. ----
        String prefix = "qualification/" + Ulid.next(Instant.now()) + "/";
        String k = prefix + "world.json";
        byte[] first = "{\"qualification\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] second = "{\"qualification\":2}".getBytes(StandardCharsets.UTF_8);
        List<String> written = List.of(k, prefix + "altered.json", prefix + "bounded.json", prefix + "default-checksums.json");
        try (B2ObjectStore b2 = new B2ObjectStore(p)) {
            try {
                ObjectStore.Written v1 = b2.put(k, first, CT, md5(first));
                say("put: version id " + (v1.versionId() == null ? "NONE" : "given"));
                assertThat(v1.versionId()).as("B2 names the version it wrote").isNotBlank();
                assertThat(b2.get(k, v1.versionId(), 1024)).isEqualTo(first);
                assertThat(b2.get(k, null, 1024)).isEqualTo(first);
                say("get: by version and latest, the bytes written");

                ObjectStore.Written retried = b2.put(k, first, CT, md5(first));
                assertThat(retried.versionId()).as("a version of its own").isNotBlank().isNotEqualTo(v1.versionId());
                assertThat(b2.get(k, null, 1024)).isEqualTo(first);
                say("PL-T10 a retried put: the identical bytes under the same key, as a second version");

                // Nobody without platform's key reads it: not anonymously, not with the assets bucket's key.
                HttpResponse<byte[]> anonymous = download(URI.create(granted.downloadUrl() + "/file/" + p.bucket() + "/" + k), null);
                say("PL-T10 an anonymous download through B2's download URL: status " + anonymous.statusCode());
                assertThat(anonymous.statusCode()).as("no bytes without a key").isNotEqualTo(200);
                assertThat(anonymous.body()).isNotEqualTo(first);
                HttpResponse<byte[]> unsigned = download(URI.create(https(p.endpoint()) + "/" + p.bucket() + "/" + k), null);
                say("PL-T10 an unsigned S3 read: status " + unsigned.statusCode());
                assertThat(unsigned.statusCode()).as("no bytes without a signature").isNotEqualTo(200);
                assertThat(unsigned.body()).isNotEqualTo(first);
                if (assets != null) {
                    HttpResponse<byte[]> other = download(URI.create(assets.downloadUrl() + "/file/" + p.bucket() + "/" + k), assets.token());
                    say("PL-T10 the assets bucket's key downloading it: status " + other.statusCode());
                    assertThat(other.statusCode()).as("the assets bucket's key reads no private object").isNotEqualTo(200);
                }

                assertThatThrownBy(() -> b2.put(prefix + "altered.json", first, CT, md5(second)))
                        .isInstanceOf(ObjectStore.StorageUnavailable.class);
                assertThat(b2.get(prefix + "altered.json", null, 1024)).as("nothing kept under the altered write").isNull();
                say("put with another Content-MD5: refused, nothing kept");

                ObjectStore.Written v2 = b2.put(k, second, CT, md5(second));
                b2.delete(k, v1.versionId());
                assertThat(b2.get(k, v1.versionId(), 1024)).as("the first version erased by its id").isNull();
                assertThat(b2.get(k, null, 1024)).as("the newest untouched").isEqualTo(second);
                say("delete by version id: that version gone, the others kept");

                byte[] big = new byte[2048];
                b2.put(prefix + "bounded.json", big, CT, md5(big));
                assertThatThrownBy(() -> b2.get(prefix + "bounded.json", null, 1024)).isInstanceOf(ObjectStore.StorageUnavailable.class);
                say("a read past its bound: refused");

                b2.delete(k, null);
                assertThat(b2.get(k, null, 1024)).as("every version erased").isNull();
                assertThat(v2.versionId()).isNotBlank();
                say("delete of every version: none left");
            } finally {
                for (String w : written) {
                    try {
                        b2.delete(w, null);
                    } catch (RuntimeException e) {
                        say("cleanup of " + w + " failed: " + e.getMessage());
                    }
                }
            }
        }

        // The SDK's newer default checksums, which B2 does not document ([S14]): recorded, so W3 can tell whether the
        // WHEN_REQUIRED precaution is still needed.
        try (S3Client defaults = client(p, p.region(), true)) {
            String d = prefix + "default-checksums.json";
            try {
                defaults.putObject(PutObjectRequest.builder().bucket(p.bucket()).key(d).build(), RequestBody.fromBytes(first));
                say("the SDK's default checksums: accepted by B2");
            } catch (S3Exception e) {
                say("the SDK's default checksums: refused, " + detail(e));
            } finally {
                defaults.listObjectVersions(ListObjectVersionsRequest.builder().bucket(p.bucket()).prefix(d).build()).versions()
                        .forEach(v -> defaults.deleteObject(DeleteObjectRequest.builder().bucket(p.bucket()).key(d).versionId(v.versionId()).build()));
            }
        }

        // PL-T10 the other way: platform's private key against the public assets bucket.
        StorageProperties assetsBucket = new StorageProperties(p.endpoint(), p.region(), "wexy-assets-dev", p.accessKey(), p.secretKey(), null, null);
        try (B2ObjectStore other = new B2ObjectStore(assetsBucket)) {
            Throwable refused = catchThrowable(() -> other.get("qualification/no-such-object", null, 1024));
            say("PL-T10 the private key against wexy-assets-dev: "
                    + (refused == null ? "READ (404): not limited to its bucket" : "refused (" + refused.getMessage() + ")"));
            assertThat(refused).as("platform's private key is refused by the assets bucket").isInstanceOf(ObjectStore.StorageUnavailable.class);
        }

        // PL-T20: nothing of this run survives, not a version, not a delete marker.
        try (S3Client s3 = client(p, p.region(), false)) {
            ListObjectVersionsResponse left = s3.listObjectVersions(ListObjectVersionsRequest.builder().bucket(p.bucket()).prefix(prefix).build());
            say("PL-T20 after the erasures: " + left.versions().size() + " versions and " + left.deleteMarkers().size()
                    + " delete markers under " + prefix);
            assertThat(left.versions()).isEmpty();
            assertThat(left.deleteMarkers()).isEmpty();
        }
    }
}
