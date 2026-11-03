package ai.wexy.platform.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The object store and where its blocking calls run (W3.1). With the five B2 values present, the private bucket; without
 * any of them, a store that answers every call as unavailable, so the world routes say 503 and accounts keep working
 * (the creations platform design §13: "B2 failure gates storage, not unrelated profile reads"). The startup line names
 * what is missing, never a value.
 */
@Configuration
public class StorageConfiguration {

    private static final Logger log = LoggerFactory.getLogger(StorageConfiguration.class);

    @Bean
    public ObjectStore objectStore(StorageProperties properties) {
        if (!properties.complete()) {
            log.warn("storage.unconfigured missing={}: saving worlds answers 503 until they are set", properties.missing());
            return new UnconfiguredObjectStore();
        }
        log.info("storage.b2 endpoint={} region={} bucket={}", properties.endpoint(), properties.region(), properties.bucket());
        return new B2ObjectStore(properties);
    }

    /** Bounded as the database's (DatabaseScheduler): a few B2 calls at a time, a short queue, then 503 at once. */
    @Bean(name = "storage", destroyMethod = "dispose")
    public Scheduler storage(@Value("${wexy.storage.threads:4}") int threads, @Value("${wexy.storage.queued-calls:32}") int queued) {
        return Schedulers.newBoundedElastic(threads, Math.max(1, queued / threads), "platform-b2");
    }

    /** No bucket: every call is unavailable. */
    static final class UnconfiguredObjectStore implements ObjectStore {
        @Override
        public boolean configured() {
            return false;
        }

        @Override
        public Written put(String key, byte[] bytes, String contentType, String md5Base64) {
            throw new StorageUnavailable("B2 is not configured", null);
        }

        @Override
        public byte[] get(String key, String versionId, int maxBytes) {
            throw new StorageUnavailable("B2 is not configured", null);
        }

        @Override
        public void delete(String key, String versionId) {
            throw new StorageUnavailable("B2 is not configured", null);
        }
    }
}
