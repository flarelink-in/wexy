package ai.wexy.gateway.auth;

import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Base64;
import java.util.Optional;

/**
 * Initialises the Firebase Admin SDK from Wexy's own service account (backend architecture §10).
 *
 * Adapted from FlareLink's FireBaseConfiguration (pre-existing work). Changed: there is no
 * classpath fallback, because a key file on the classpath is a key file in the repository; and
 * the credential may be absent when {@code wexy.firebase.required} is false (the local profile),
 * so the gateway runs before the Firebase project exists. Then every route that needs sign-in
 * answers 401, which is the honest outcome, and App Check tokens are spent on this instance's
 * ledger alone. Everywhere else, a missing or unreadable credential stops startup.
 *
 * Base64 rather than raw JSON because the JSON holds '$' characters that Docker Compose would try
 * to interpolate, and newlines that survive shell and env-var round trips poorly.
 */
@Component
public class FirebaseCredentials {

    private static final Logger log = LoggerFactory.getLogger(FirebaseCredentials.class);

    private final GoogleCredentials credentials;

    public FirebaseCredentials(@Value("${wexy.firebase.service-account-b64:}") String serviceAccountBase64,
                               @Value("${wexy.firebase.required:true}") boolean required) {
        if (!StringUtils.hasText(serviceAccountBase64)) {
            if (required) {
                throw new IllegalStateException("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_B64 to the "
                        + "base64 of Wexy's service account JSON, or run with the local profile, where sign-in "
                        + "is off.");
            }
            log.warn("Firebase is not configured (wexy.firebase.required=false): every route that needs sign-in "
                    + "answers 401, and single-use App Check tokens are spent on this instance's ledger only.");
            this.credentials = null;
            return;
        }

        try (InputStream in = new ByteArrayInputStream(Base64.getDecoder().decode(serviceAccountBase64.trim()))) {
            this.credentials = GoogleCredentials.fromStream(in);
        } catch (IOException | IllegalArgumentException e) {
            throw new IllegalStateException("FIREBASE_SERVICE_ACCOUNT_B64 could not be read as a base64 service "
                    + "account JSON.", e);
        }

        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseApp.initializeApp(FirebaseOptions.builder()
                    .setCredentials(credentials)
                    .build());
        }
        log.info("Firebase credentials loaded from wexy.firebase.service-account-b64.");
    }

    /**
     * The service account, for the one Firebase API the Java Admin SDK does not wrap: App Check's
     * verifyAppCheckToken, which spends single-use tokens.
     */
    public Optional<GoogleCredentials> credentials() {
        return Optional.ofNullable(credentials);
    }

    public boolean configured() {
        return credentials != null;
    }
}
