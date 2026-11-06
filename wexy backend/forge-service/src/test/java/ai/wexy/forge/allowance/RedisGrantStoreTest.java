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

    /** A grant as PromptGrants writes one since Q120 (b): its entry's own id beside the rest. */
    private void granted(String id, String entry) {
        List<String> counters = List.of("wexy:allow:early:d:" + id);
        store.grant(counters, List.of(5L), List.of(3600L), "wexy:grant:" + id, id, "wexy:grant:of:" + entry,
                Map.of("owner", "o1", "prompt", "p1", "counters", String.join(" ", counters), "dispatched", "1", "entry", entry), 7200);
    }

    /**
     * Q120 (b), the real scripts: the probe and the join read the same checks (owner, follow-ups, an end written and
     * without a world, the idea); only the grant's own turn writes its end, with the calls it dispatched; a join moves the
     * idea, clears the end and its calls (answering both, for the follow-up's meta) and indexes the follow-up; a follow-up
     * that dispatched nothing is given back exactly, its end's calls included; one that dispatched is not.
     */
    @Test
    void theRealFollowUpScriptsFollowOnceGiveBackExactlyAndKeepTheirOrder() {
        granted("g5", "turn-1");
        assertThat(store.probeFollow("wexy:grant:none", "o1", 1, "p1")).isEqualTo(GrantStore.Follow.NONE);
        assertThat(store.probeFollow("wexy:grant:g5", "o2", 1, "p1")).as("another owner's").isEqualTo(GrantStore.Follow.NONE);
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p1")).as("no end written: running").isEqualTo(GrantStore.Follow.OPEN);

        assertThat(store.ended("wexy:grant:g5", "turn-9", "asked", 1)).as("another turn's end").isFalse();
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g5")).as("another's writes nothing").doesNotContainKeys("end", "endCalls");
        assertThat(store.ended("wexy:grant:g5", "turn-1", "handed-off", 3)).isTrue();
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p1")).as("it made a world").isEqualTo(GrantStore.Follow.WORLD);
        assertThat(store.follow("wexy:grant:g5", "o1", 1, "p2", "wexy:grant:of:turn-2", "g5", "turn-2"))
                .as("why not, with no end and no calls").isEqualTo(new GrantStore.Joined(GrantStore.Follow.WORLD, null, null));
        store.ended("wexy:grant:g5", "turn-1", "something-else", 2);
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p1")).as("an end no follow-up follows").isEqualTo(GrantStore.Follow.WORLD);

        store.ended("wexy:grant:g5", "turn-1", "asked", 2);
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g5")).containsEntry("end", "asked").containsEntry("endCalls", "2");
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p1")).isEqualTo(GrantStore.Follow.SAME);
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p2")).isEqualTo(GrantStore.Follow.CHANGED);
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 0, "p2")).as("no follow-ups at all").isEqualTo(GrantStore.Follow.FULL);
        assertThat(redis.opsForHash().get("wexy:grant:g5", "followups")).as("the probe writes nothing").isNull();

        assertThat(store.follow("wexy:grant:g5", "o2", 1, "p2", "wexy:grant:of:turn-2", "g5", "turn-2").result()).isEqualTo(GrantStore.Follow.NONE);
        assertThat(store.follow("wexy:grant:g5", "o1", 1, "p2", "wexy:grant:of:turn-2", "g5", "turn-2"))
                .as("joined: the end it cleared, and the calls that turn dispatched").isEqualTo(new GrantStore.Joined(GrantStore.Follow.JOINED, "asked", 2));
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g5")).containsEntry("followups", "1").containsEntry("prompt", "p2")
                .containsEntry("prevPrompt", "p1").containsEntry("prevEnd", "asked").containsEntry("prevEndCalls", "2").containsEntry("following", "turn-2")
                .doesNotContainKeys("end", "endCalls");
        assertThat(store.lookup("wexy:grant:of:turn-2")).isEqualTo("g5");
        assertThat(redis.getExpire("wexy:grant:of:turn-2")).isBetween(1L, 7200L);
        assertThat(store.follow("wexy:grant:g5", "o1", 1, "p3", "wexy:grant:of:turn-3", "g5", "turn-3").result()).as("one a prompt").isEqualTo(GrantStore.Follow.FULL);
        assertThat(store.ended("wexy:grant:g5", "turn-1", "failed", 1)).as("once followed, only the follow-up writes the end").isFalse();

        // Given back while it dispatched nothing: as it was before the join, the end's calls too, its index gone; then it
        // may join again.
        assertThat(store.unfollow("wexy:grant:g5", "wexy:grant:of:turn-9", "turn-9")).as("another follow-up's").isFalse();
        assertThat(store.unfollow("wexy:grant:g5", "wexy:grant:of:turn-2", "turn-2")).isTrue();
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g5")).containsEntry("followups", "0").containsEntry("prompt", "p1")
                .containsEntry("end", "asked").containsEntry("endCalls", "2")
                .doesNotContainKeys("following", "followDispatched", "prevPrompt", "prevEnd", "prevEndCalls");
        assertThat(redis.hasKey("wexy:grant:of:turn-2")).isFalse();
        assertThat(store.unfollow("wexy:grant:g5", "wexy:grant:of:turn-2", "turn-2")).as("given back once").isFalse();

        // Joined again and dispatched: spent, never given back; its own end is written, with its own calls.
        assertThat(store.follow("wexy:grant:g5", "o1", 1, "p2", "wexy:grant:of:turn-4", "g5", "turn-4"))
                .isEqualTo(new GrantStore.Joined(GrantStore.Follow.JOINED, "asked", 2));
        store.followDispatched("wexy:grant:g5", "turn-4");
        assertThat(store.unfollow("wexy:grant:g5", "wexy:grant:of:turn-4", "turn-4")).as("spent").isFalse();
        assertThat(store.ended("wexy:grant:g5", "turn-4", "asked", 5)).isTrue();
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g5")).containsEntry("end", "asked").containsEntry("endCalls", "5");
        assertThat(store.probeFollow("wexy:grant:g5", "o1", 1, "p2")).as("its one follow-up spent").isEqualTo(GrantStore.Follow.FULL);
    }

    /**
     * Q120 (b): an end a forge before the follow-up's count wrote (a grant alive across the deploy: no endCalls). The
     * join answers its calls as unknown, and a give-back restores the end without inventing a count.
     */
    @Test
    void theRealJoinOfAnEndWrittenWithoutItsCallsAnswersThemUnknown() {
        granted("g7", "turn-1");
        redis.opsForHash().put("wexy:grant:g7", "end", "cancelled");
        assertThat(store.follow("wexy:grant:g7", "o1", 1, "p2", "wexy:grant:of:turn-2", "g7", "turn-2"))
                .isEqualTo(new GrantStore.Joined(GrantStore.Follow.JOINED, "cancelled", null));
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g7")).containsEntry("prevEnd", "cancelled").doesNotContainKeys("prevEndCalls", "endCalls");
        assertThat(store.unfollow("wexy:grant:g7", "wexy:grant:of:turn-2", "turn-2")).isTrue();
        assertThat(redis.<String, String>opsForHash().entries("wexy:grant:g7")).containsEntry("end", "cancelled").doesNotContainKeys("endCalls", "prevEndCalls");
    }

    /** Q120 (b), the real join under a race: of twenty follow-ups of one prompt at once, one joins, and it alone says what it followed. */
    @Test
    void theRealFollowUpJoinsOneUnderARace() throws Exception {
        granted("g6", "turn-1");
        store.ended("wexy:grant:g6", "turn-1", "failed", 4);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<GrantStore.Joined>> tries = new ArrayList<>();
            for (int i = 0; i < 20; i++) {
                String turn = "turn-r" + i;
                tries.add(pool.submit(() -> {
                    go.await();
                    return store.follow("wexy:grant:g6", "o1", 1, "p" + turn, "wexy:grant:of:" + turn, "g6", turn);
                }));
            }
            go.countDown();
            int joined = 0;
            for (Future<GrantStore.Joined> t : tries) {
                GrantStore.Joined f = t.get();
                assertThat(f).isIn(new GrantStore.Joined(GrantStore.Follow.JOINED, "failed", 4), GrantStore.Joined.not(GrantStore.Follow.FULL));
                joined += f.result() == GrantStore.Follow.JOINED ? 1 : 0;
            }
            assertThat(joined).isEqualTo(1);
            assertThat(redis.opsForHash().get("wexy:grant:g6", "followups")).isEqualTo("1");
        } finally {
            pool.shutdownNow();
        }
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
