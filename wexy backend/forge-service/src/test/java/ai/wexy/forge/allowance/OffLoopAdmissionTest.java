package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.safety.RecordedContentSafety;
import org.junit.jupiter.api.Test;
import org.reactivestreams.Subscription;
import reactor.core.Disposable;
import reactor.core.publisher.BaseSubscriber;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The W1 review's first mid finding (2026-11-02): a request cancelled while its admission runs (content safety, then the
 * grant in Redis) must not keep the prompt that admission grants, since no model call can follow it (§11). And the
 * admission is never interrupted: an interrupt inside the grant's own Redis step could leave it written with no
 * {@link Grant} to give back. Each ordering of the cancel against the admission is driven by a store that holds the grant
 * step until the test lets it go.
 */
class OffLoopAdmissionTest {

    private static final Caller ANONYMOUS = new Caller("u1", true, false, "anonymous", "net-a");

    private final HeldStore store = new HeldStore();
    private final PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
    private final PromptAdmission admission = new PromptAdmission(grants, new RecordedContentSafety());

    private reactor.core.publisher.Mono<Optional<Grant>> entry() {
        return PromptAdmission.offLoop(() -> admission.entry(ANONYMOUS, "plan-1", "a spiral galaxy", "plan"));
    }

    /** The client leaves while the grant is being written: the grant, made after, goes back, and nothing is delivered. */
    @Test
    void aGrantMadeAfterItsRequestWasCancelledGoesBack() throws Exception {
        AtomicReference<Object> delivered = new AtomicReference<>();
        Disposable request = entry().subscribe(delivered::set, delivered::set);
        assertThat(store.entered.await(10, TimeUnit.SECONDS)).as("the grant step began").isTrue();

        request.dispose();
        store.proceed.countDown();

        assertThat(store.released.await(10, TimeUnit.SECONDS)).as("the grant went back").isTrue();
        assertThat(grants.peek(ANONYMOUS).left()).as("the anonymous account's one prompt").isEqualTo(1);
        assertThat(store.interrupted).as("the admission was never interrupted").isFalse();
        assertThat(delivered.get()).as("nothing reached the cancelled request").isNull();
    }

    /**
     * The grant is made and handed over, but the request has asked for nothing yet when it is cancelled: the handed-over
     * grant is dropped, and goes back too. The pause after the grant step lets the admission reach its hand-over first;
     * in every ordering the grant goes back.
     */
    @Test
    void aGrantHandedOverButNeverTakenGoesBack() throws Exception {
        store.proceed.countDown();
        BaseSubscriber<Optional<Grant>> idle = new BaseSubscriber<>() {
            @Override
            protected void hookOnSubscribe(Subscription subscription) {
                // Asks for nothing: what the admission hands over waits in the sink.
            }
        };
        entry().subscribe(idle);
        assertThat(store.granted.await(10, TimeUnit.SECONDS)).as("the grant was made").isTrue();
        Thread.sleep(200);

        idle.dispose();

        assertThat(store.released.await(10, TimeUnit.SECONDS)).as("the grant went back").isTrue();
        assertThat(grants.peek(ANONYMOUS).left()).isEqualTo(1);
    }

    /** A request that stays: its grant is delivered and kept. */
    @Test
    void aGrantItsRequestTakesIsKept() {
        store.proceed.countDown();
        Optional<Grant> grant = entry().block(Duration.ofSeconds(10));
        assertThat(grant).isPresent();
        assertThat(store.released.getCount()).as("never given back").isEqualTo(1);
        assertThat(grants.peek(ANONYMOUS).left()).isZero();
    }

    /** A refusal is the request's error, with its code, and nothing is granted. */
    @Test
    void aRefusalIsTheRequestsError() {
        store.proceed.countDown();
        grants.grant(ANONYMOUS, "plan-0", "h").spent();
        assertThatThrownBy(() -> entry().block(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(store.inner.granted()).isEqualTo(1);
    }

    /**
     * The in-memory store, with its grant step held until {@link #proceed} opens: the wait cannot be interrupted, and an
     * attempt to is recorded.
     */
    static final class HeldStore implements GrantStore {

        final InMemoryGrantStore inner = new InMemoryGrantStore();
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch proceed = new CountDownLatch(1);
        final CountDownLatch granted = new CountDownLatch(1);
        final CountDownLatch released = new CountDownLatch(1);
        final AtomicBoolean interrupted = new AtomicBoolean();

        @Override
        public List<Long> counts(List<String> counters) {
            return inner.counts(counters);
        }

        @Override
        public int grant(List<String> counters, List<Long> limits, List<Long> lifetimesSeconds, String grantKey, String grantId,
                         String indexKey, Map<String, String> record, long lifeSeconds) {
            entered.countDown();
            while (true) {
                try {
                    if (proceed.await(10, TimeUnit.SECONDS)) {
                        break;
                    }
                    throw new IllegalStateException("the test never let the grant step go");
                } catch (InterruptedException e) {
                    interrupted.set(true);
                }
            }
            int denied = inner.grant(counters, limits, lifetimesSeconds, grantKey, grantId, indexKey, record, lifeSeconds);
            granted.countDown();
            return denied;
        }

        @Override
        public String lookup(String indexKey) {
            return inner.lookup(indexKey);
        }

        @Override
        public Join join(String grantKey, String owner, String field, long limit, String prompt, String newIndexKey, String grantId) {
            return inner.join(grantKey, owner, field, limit, prompt, newIndexKey, grantId);
        }

        @Override
        public void dispatched(String grantKey) {
            inner.dispatched(grantKey);
        }

        @Override
        public boolean release(String grantKey, String indexKey, List<String> counters) {
            boolean given = inner.release(grantKey, indexKey, counters);
            released.countDown();
            return given;
        }
    }
}
