package ai.wexy.platform.database;

import org.junit.jupiter.api.Test;
import reactor.core.scheduler.Scheduler;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The database scheduler's bound (the independent W2 review): `queued-calls` is the whole scheduler's, not each
 * thread's (Reactor's bounded elastic caps each thread's queue). With two threads busy and two calls queued, the next
 * is refused at once, which the envelope answers 503.
 */
class DatabaseSchedulerTest {

    @Test
    void theQueueBoundIsTheSchedulersNotEachThreads() throws Exception {
        Scheduler database = new DatabaseScheduler().database(2, 2);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch running = new CountDownLatch(2);
        Runnable hold = () -> {
            running.countDown();
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };
        try {
            database.schedule(hold);
            database.schedule(hold);
            assertThat(running.await(5, TimeUnit.SECONDS)).as("both threads busy").isTrue();
            database.schedule(hold);
            database.schedule(hold);
            assertThatThrownBy(() -> database.schedule(hold)).as("two queued in all, the third refused")
                    .isInstanceOf(RejectedExecutionException.class);
        } finally {
            release.countDown();
            database.dispose();
        }
    }
}
