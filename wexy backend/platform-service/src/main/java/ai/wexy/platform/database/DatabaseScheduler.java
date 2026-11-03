package ai.wexy.platform.database;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * Where JDBC's blocking calls run (W2; the creations platform design §3): a bounded scheduler as wide as the connection
 * pool, so no more calls wait on a connection than the pool can serve, and a short queue behind it, past which a
 * call is refused at once ({@code 503 unavailable}) rather than queued without end. The event loop never blocks.
 *
 * {@code queued-calls} is the whole scheduler's queue. Reactor's bounded elastic caps each thread's queue, so each
 * thread is given its share (the independent W2 review: four threads had queued four times the bound).
 */
@Configuration
public class DatabaseScheduler {

    @Bean(name = "database", destroyMethod = "dispose")
    public Scheduler database(@Value("${spring.datasource.hikari.maximum-pool-size}") int poolSize,
                              @Value("${wexy.database.queued-calls}") int queuedCalls) {
        return Schedulers.newBoundedElastic(poolSize, Math.max(1, queuedCalls / poolSize), "platform-db");
    }
}
