package ai.wexy.gateway.auth;

import reactor.core.publisher.Mono;

/**
 * Verifies a Firebase ID token. An interface so the authorization filter can be tested without
 * Google; the production implementation is {@link FirebaseAdminTokenVerifier}.
 */
public interface FirebaseTokenVerifier {

    /** The caller the token vouches for, or an error (a {@code GatewayRejection} with {@code auth}). */
    Mono<VerifiedCaller> verify(String idToken);
}
