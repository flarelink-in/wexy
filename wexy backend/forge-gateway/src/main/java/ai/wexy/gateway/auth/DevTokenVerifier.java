package ai.wexy.gateway.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local sign-in for the loop (forge-loop design §9, Q22): under the {@code local} profile, and only
 * while the gateway has no Firebase credentials, {@code Bearer dev.anonymous.<uid>} and
 * {@code Bearer dev.google.<uid>} sign a caller in as that uid, anonymous or with an account. Two
 * dots, so {@link InternalTokenMinter#extractBearerToken} passes them. Anything else, and every
 * token once credentials are present, goes to the Firebase verifier, which then refuses dev tokens
 * as it refuses any string that is not a signed ID token.
 *
 * <p>The bean exists under {@code local} alone ({@code DevTokenVerifierProfileTest} pins it, and a
 * mutation removes the condition): a deployment can never accept a token anyone can type. The studio
 * sends one from a development build on a loopback page with no Firebase config
 * ({@code forge-client/identity.ts}), as the frontend's local drives do ({@code dev/drive-allowance.mjs}).
 */
@Component
@Primary
@Profile("local")
public class DevTokenVerifier implements FirebaseTokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(DevTokenVerifier.class);

    /** A Firebase uid is at most 128 characters; these are typed by hand or made by the studio. */
    static final Pattern DEV_TOKEN = Pattern.compile("dev\\.(anonymous|google)\\.([A-Za-z0-9_-]{1,128})");

    private final BooleanSupplier firebaseConfigured;
    private final FirebaseTokenVerifier firebase;

    @Autowired
    public DevTokenVerifier(FirebaseCredentials credentials, FirebaseAdminTokenVerifier firebase) {
        this(credentials::configured, firebase);
    }

    DevTokenVerifier(BooleanSupplier firebaseConfigured, FirebaseTokenVerifier firebase) {
        this.firebaseConfigured = firebaseConfigured;
        this.firebase = firebase;
        if (accepting()) {
            log.warn("DEV TOKENS ACCEPTED: local profile only. 'Bearer dev.anonymous.<uid>' and 'Bearer dev.google.<uid>' "
                    + "sign in without Firebase, because no Firebase credentials are configured.");
        } else {
            log.info("Firebase credentials are configured: dev tokens are off, and sign-in needs a real ID token.");
        }
    }

    /** True while dev tokens sign in: the local profile without Firebase credentials. */
    public boolean accepting() {
        return !firebaseConfigured.getAsBoolean();
    }

    @Override
    public Mono<VerifiedCaller> verify(String idToken) {
        if (accepting()) {
            Matcher dev = DEV_TOKEN.matcher(idToken);
            if (dev.matches()) {
                String provider = "anonymous".equals(dev.group(1)) ? VerifiedCaller.ANONYMOUS_PROVIDER : "google.com";
                return Mono.just(new VerifiedCaller(dev.group(2), provider));
            }
        }
        return firebase.verify(idToken);
    }
}
