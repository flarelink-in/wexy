package ai.wexy.gateway.auth;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.GatewayRejection;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** What a dev token signs in as, what goes to Firebase instead, and that credentials switch them off. */
class DevTokenVerifierTest {

    private final AtomicInteger firebaseCalls = new AtomicInteger();
    private final FirebaseTokenVerifier firebase = token -> {
        firebaseCalls.incrementAndGet();
        return Mono.error(new GatewayRejection(ErrorCode.AUTH, "The sign-in token could not be verified."));
    };

    @Test
    void withoutFirebaseADevTokenSignsInAsItsUid() {
        DevTokenVerifier verifier = new DevTokenVerifier(() -> false, firebase);

        VerifiedCaller anonymous = verifier.verify("dev.anonymous.smoke-1").block();
        assertThat(anonymous.uid()).isEqualTo("smoke-1");
        assertThat(anonymous.anonymous()).isTrue();

        VerifiedCaller account = verifier.verify("dev.google.alice_2").block();
        assertThat(account.uid()).isEqualTo("alice_2");
        assertThat(account.provider()).isEqualTo("google.com");
        assertThat(account.anonymous()).isFalse();
        assertThat(firebaseCalls).hasValue(0);
    }

    @Test
    void anythingThatIsNotADevTokenGoesToFirebase() {
        DevTokenVerifier verifier = new DevTokenVerifier(() -> false, firebase);

        for (String token : new String[]{"h.payload.s", "dev.admin.x", "dev.anonymous.", "dev.anonymous.a b", "dev.anonymous." + "x".repeat(129)}) {
            assertThatThrownBy(() -> verifier.verify(token).block()).as(token)
                    .isInstanceOfSatisfying(GatewayRejection.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.AUTH));
        }
        assertThat(firebaseCalls).hasValue(5);
    }

    @Test
    void withFirebaseCredentialsDevTokensAreOff() {
        DevTokenVerifier verifier = new DevTokenVerifier(() -> true, firebase);

        assertThat(verifier.accepting()).isFalse();
        assertThatThrownBy(() -> verifier.verify("dev.anonymous.smoke-1").block())
                .isInstanceOfSatisfying(GatewayRejection.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.AUTH));
        assertThat(firebaseCalls).hasValue(1);
    }
}
