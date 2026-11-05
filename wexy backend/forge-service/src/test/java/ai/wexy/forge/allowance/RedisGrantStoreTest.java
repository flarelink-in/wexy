package ai.wexy.forge.allowance;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The real grant scripts against a real Redis (W1): what InMemoryGrantStore mirrors, checked at the source: all or
 * nothing, lifetimes set, one grant under a race, a spent grant never given back. Skipped, and reported as skipped,
 * when Docker is not running.
 */
@Testcontainers(disabledWithoutDocker = true)
class RedisGrantStoreTest {

    @Container
    private static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:7.2-alpine")).withExposedPorts(6379);

    private StringRedisTemplate redis;
    private RedisGrantStore store;

    @BeforeEach
    void connect() {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
        factory.afterPropertiesSet();
        redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
        redis.getConnectionFactory().getConnection().serverCommands().flushAll();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(redis);
        store = new RedisGrantStore(provider);
    }

    private int grant(List<String> counters, List<Long> limits, String id, String index) {
        return store.grant(counters, limits, counters.stream().map(c -> 3600L).toList(), "wexy:grant:" + id, id, index,
                Map.of("owner", "o1", "prompt", "p1", "counters", String.join(" ", counters), "dispatched", "0"), 7200);
    }

    @Test
    void theRealScriptGrantsAllOrNothingAndSetsLifetimes() {
        List<String> counters = List.of("wexy:allow:anon:o1", "wexy:allow:net:d:n1");
        assertThat(grant(counters, List.of(1L, 1L), "g1", "wexy:grant:of:plan-1")).isEqualTo(-1);
        assertThat(redis.opsForValue().get("wexy:allow:anon:o1")).isEqualTo("1");
        assertThat(redis.getExpire("wexy:allow:anon:o1")).isBetween(1L, 3600L);
        assertThat(redis.opsForValue().get("wexy:grant:of:plan-1")).isEqualTo("g1");
        assertThat(redis.<String, String>opsForHash().get("wexy:grant:g1", "owner")).isEqualTo("o1");

        // Another account on the same network: the second counter is at its limit, so nothing is taken.
        assertThat(grant(List.of("wexy:allow:anon:o2", "wexy:allow:net:d:n1"), List.of(1L, 1L), "g2", "wexy:grant:of:plan-2")).isEqualTo(1);
        assertThat(redis.hasKey("wexy:allow:anon:o2")).isFalse();
        assertThat(redis.hasKey("wexy:grant:g2")).isFalse();
    }

    @Test
    void theRealScriptGrantsOneUnderARace() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<Integer>> tries = new ArrayList<>();
            for (int i = 0; i < 20; i++) {
                String id = "g" + i;
                tries.add(pool.submit(() -> {
                    go.await();
                    return grant(List.of("wexy:allow:anon:same"), List.of(1L), id, "wexy:grant:of:" + id);
                }));
            }
            go.countDown();
            int granted = 0;
            for (Future<Integer> t : tries) {
                granted += t.get() == -1 ? 1 : 0;
            }
            assertThat(granted).isEqualTo(1);
            assertThat(redis.opsForValue().get("wexy:allow:anon:same")).isEqualTo("1");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theRealScriptsGiveBackOnlyAnUnspentGrantAndJoinWithinItsBudget() {
        List<String> counters = List.of("wexy:allow:early:d:o1");
        grant(counters, List.of(5L), "g1", "wexy:grant:of:plan-1");
        assertThat(store.release("wexy:grant:g1", "wexy:grant:of:plan-1", List.of("wexy:allow:other"))).as("not its counters").isFalse();
        assertThat(store.release("wexy:grant:g1", "wexy:grant:of:plan-1", counters)).isTrue();
        assertThat(redis.hasKey("wexy:allow:early:d:o1")).as("one back to nothing").isFalse();
        assertThat(redis.hasKey("wexy:grant:of:plan-1")).isFalse();

        grant(counters, List.of(5L), "g2", "wexy:grant:of:plan-2");
        store.dispatched("wexy:grant:g2");
        assertThat(store.release("wexy:grant:g2", "wexy:grant:of:plan-2", counters)).as("spent").isFalse();
        assertThat(redis.opsForValue().get("wexy:allow:early:d:o1")).isEqualTo("1");

        assertThat(store.lookup("wexy:grant:of:plan-2")).isEqualTo("g2");
        assertThat(store.join("wexy:grant:g2", "o2", "revision", 2, "p1", null, "g2")).isEqualTo(GrantStore.Join.NONE);
        assertThat(store.join("wexy:grant:g2", "o1", "revision", 2, "p2", null, "g2")).isEqualTo(GrantStore.Join.NONE);
        assertThat(store.join("wexy:grant:g2", "o1", "revision", 2, "p1", "wexy:grant:of:turn-2", "g2")).isEqualTo(GrantStore.Join.JOINED);
        assertThat(store.lookup("wexy:grant:of:turn-2")).isEqualTo("g2");
        assertThat(redis.getExpire("wexy:grant:of:turn-2")).isBetween(1L, 7200L);
        assertThat(store.join("wexy:grant:g2", "o1", "revision", 2, "p1", null, "g2")).isEqualTo(GrantStore.Join.JOINED);
        assertThat(store.join("wexy:grant:g2", "o1", "revision", 2, "p1", null, "g2")).isEqualTo(GrantStore.Join.FULL);
        assertThat(store.counts(List.of("wexy:allow:early:d:o1", "wexy:allow:none"))).containsExactly(1L, 0L);
    }

    /** The probe (the EA9.4 review): join's checks, in its order, writing nothing; and join's answer after it. */
    @Test
    void theRealProbeAnswersAsJoinWouldAndWritesNothing() {
        grant(List.of("wexy:allow:early:d:o1"), List.of(5L), "g3", "wexy:grant:of:plan-3");
        assertThat(store.probe("wexy:grant:none", "o1", "revision", 2, "p1")).as("no such grant").isEqualTo(GrantStore.Join.NONE);
        assertThat(store.probe("wexy:grant:g3", "o2", "revision", 2, "p1")).as("another owner's").isEqualTo(GrantStore.Join.NONE);
        assertThat(store.probe("wexy:grant:g3", "o1", "revision", 2, "p2")).as("another prompt").isEqualTo(GrantStore.Join.NONE);
        for (int i = 0; i < 5; i++) {
            assertThat(store.probe("wexy:grant:g3", "o1", "revision", 2, "p1")).isEqualTo(GrantStore.Join.JOINED);
        }
        assertThat(redis.opsForHash().get("wexy:grant:g3", "revision")).as("nothing counted").isNull();
        assertThat(store.probe("wexy:grant:g3", "o1", "revision", 2, null)).as("no prompt asked").isEqualTo(GrantStore.Join.JOINED);
        assertThat(store.join("wexy:grant:g3", "o1", "revision", 2, "p1", null, "g3")).isEqualTo(GrantStore.Join.JOINED);
        assertThat(store.join("wexy:grant:g3", "o1", "revision", 2, "p1", null, "g3")).isEqualTo(GrantStore.Join.JOINED);
        assertThat(store.probe("wexy:grant:g3", "o1", "revision", 2, "p1")).as("its budget spent").isEqualTo(GrantStore.Join.FULL);
        assertThat(redis.opsForHash().get("wexy:grant:g3", "revision")).isEqualTo("2");
    }
}
