package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.GatewayRejection;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.FirebaseToken;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.Map;

/**
 * Verifies ID tokens with the Firebase Admin SDK.
 *
 * Adapted from FlareLink's InternalIdentityService.verifyFirebaseToken (pre-existing work).
 * Verification can fetch Google's public keys, so it is blocking work and runs on
 * boundedElastic, never on an event-loop thread.
 */
@Component
public class FirebaseAdminTokenVerifier implements FirebaseTokenVerifier {

    private final FirebaseCredentials credentials;

    public FirebaseAdminTokenVerifier(FirebaseCredentials credentials) {
        this.credentials = credentials;
    }

    @Override
    public Mono<VerifiedCaller> verify(String idToken) {
        if (!credentials.configured()) {
            return Mono.error(new GatewayRejection(ErrorCode.AUTH, "Sign-in is not configured on this gateway."));
        }
        return Mono.fromCallable(() -> FirebaseAuth.getInstance().verifyIdToken(idToken))
                .subscribeOn(Schedulers.boundedElastic())
                .map(FirebaseAdminTokenVerifier::toCaller)
                .onErrorMap(FirebaseAuthException.class, e ->
                        new GatewayRejection(ErrorCode.AUTH, "The sign-in token could not be verified."));
    }

    /** Firebase puts the provider under the {@code firebase} claim: {@code {"sign_in_provider": …}}. */
    static VerifiedCaller toCaller(FirebaseToken token) {
        Object firebase = token.getClaims().get("firebase");
        String provider = null;
        if (firebase instanceof Map<?, ?> claims && claims.get("sign_in_provider") instanceof String value) {
            provider = value;
        }
        return new VerifiedCaller(token.getUid(), provider);
    }
}
