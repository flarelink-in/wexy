package ai.wexy.platform.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.client.config.ClientOverrideConfiguration;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest;
import software.amazon.awssdk.services.s3.model.ListObjectVersionsResponse;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectResponse;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/**
 * The private bucket on Backblaze B2, through the AWS SDK v2's S3 client (W3.1; the creations platform design §8, [S7],
 * [S14]): B2's S3 endpoint and region, platform's application key as static credentials, path-style requests, and the
 * SDK's newer default checksums off ({@code WHEN_REQUIRED}), since B2 does not document them; W3.7's qualification
 * (PL-T20) checks what B2 accepts. Integrity never rests on them: every write carries Content-MD5, so B2 refuses bytes
 * that arrive altered, and the platform keeps each object's SHA-256 and checks it on every read.
 *
 * <p>The URL-connection HTTP client, not Netty's or Apache's: a few calls at a time, on the storage scheduler, in a
 * 640 MB container. One attempt is bounded at 5 s and a call at 15 s (§11). Logs name the call, B2's status and its
 * error code, never a key, a value or the object's key.
 */
public final class B2ObjectStore implements ObjectStore, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(B2ObjectStore.class);

    private final S3Client s3;
    private final String bucket;

    public B2ObjectStore(StorageProperties p) {
        String endpoint = p.endpoint().contains("://") ? p.endpoint() : "https://" + p.endpoint();
        this.bucket = p.bucket();
        this.s3 = S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of(p.region()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(p.accessKey(), p.secretKey())))
                .forcePathStyle(true)
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder()
                        .connectionTimeout(p.attemptTimeout())
                        .socketTimeout(p.attemptTimeout()))
                .overrideConfiguration(ClientOverrideConfiguration.builder()
                        .apiCallAttemptTimeout(p.attemptTimeout())
                        .apiCallTimeout(p.callTimeout())
                        .build())
                .build();
    }

    @Override
    public boolean configured() {
        return true;
    }

    @Override
    public Written put(String key, byte[] bytes, String contentType, String md5Base64) {
        try {
            PutObjectResponse r = s3.putObject(PutObjectRequest.builder()
                    .bucket(bucket).key(key).contentType(contentType).contentMD5(md5Base64).contentLength((long) bytes.length)
                    .build(), RequestBody.fromBytes(bytes));
            return new Written(r.versionId());
        } catch (SdkException e) {
            throw unavailable("put", e);
        }
    }

    @Override
    public byte[] get(String key, String versionId, int maxBytes) {
        GetObjectRequest.Builder request = GetObjectRequest.builder().bucket(bucket).key(key);
        if (versionId != null) {
            request.versionId(versionId);
        }
        try (ResponseInputStream<GetObjectResponse> in = s3.getObject(request.build())) {
            Long length = in.response().contentLength();
            if (length != null && length > maxBytes) {
                throw new StorageUnavailable("b2 get: the object is " + length + " bytes, past " + maxBytes, null);
            }
            return readAtMost(in, maxBytes);
        } catch (NoSuchKeyException missing) {
            return null;
        } catch (S3Exception e) {
            if (e.statusCode() == 404) {
                return null;
            }
            throw unavailable("get", e);
        } catch (SdkException e) {
            throw unavailable("get", e);
        } catch (IOException e) {
            throw new StorageUnavailable("b2 get: the read failed: " + e.getClass().getSimpleName(), e);
        }
    }

    @Override
    public void delete(String key, String versionId) {
        try {
            List<String> versions = new ArrayList<>();
            if (versionId != null) {
                versions.add(versionId);
            } else {
                // Every version of this exact key, delete markers included: the bytes leave, not just their name.
                ListObjectVersionsResponse listed = s3.listObjectVersions(ListObjectVersionsRequest.builder()
                        .bucket(bucket).prefix(key).maxKeys(100).build());
                listed.versions().stream().filter(v -> key.equals(v.key())).forEach(v -> versions.add(v.versionId()));
                listed.deleteMarkers().stream().filter(m -> key.equals(m.key())).forEach(m -> versions.add(m.versionId()));
            }
            for (String version : versions) {
                try {
                    s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).versionId(version).build());
                } catch (NoSuchKeyException gone) {
                    // Already erased: a repeated job.
                } catch (S3Exception e) {
                    if (e.statusCode() != 404) {
                        throw e;
                    }
                }
            }
        } catch (SdkException e) {
            throw unavailable("delete", e);
        }
    }

    private static byte[] readAtMost(InputStream in, int maxBytes) throws IOException {
        byte[] bytes = in.readNBytes(maxBytes + 1);
        if (bytes.length > maxBytes) {
            throw new StorageUnavailable("b2 get: the object is past " + maxBytes + " bytes", null);
        }
        return bytes;
    }

    private static StorageUnavailable unavailable(String call, SdkException e) {
        String detail = e instanceof S3Exception s3e
                ? "status=" + s3e.statusCode() + " code=" + (s3e.awsErrorDetails() == null ? "none" : s3e.awsErrorDetails().errorCode())
                : "kind=" + e.getClass().getSimpleName();
        log.warn("dependency.unavailable dep=b2 call={} {}", call, detail);
        return new StorageUnavailable("b2 " + call + ": " + detail, e);
    }

    @Override
    public void close() {
        s3.close();
    }
}
