package ai.wexy.forge.spend;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The real charge and adjust scripts against a real Redis: the hermetic tests mirror their
 * decisions, this checks the scripts themselves, their key lifetimes, and the version trap.
 * Skipped, and reported as skipped, when Docker is not running.
 */
@Testcontainers(disabledWithoutDocker = true)
class SpendGuardRedisTest {

    private static final String LANE = SpendGuard.LANE_EARLY_ACCESS;

    @Container
    private static final GenericContainer<?> REDIS_7 =
            new GenericContainer<>(DockerImageName.parse("redis:7.2-alpine")).withExposedPorts(6379);

    @Container
    private static final GenericContainer<?> REDIS_6 =
            new GenericContainer<>(DockerImageName.parse("redis:6.2-alpine")).withExposedPorts(6379);

    private static StringRedisTemplate template(GenericContainer<?> redis) {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(redis.getHost(), redis.getMappedPort(6379));
        factory.afterPropertiesSet();
        StringRedisTemplate template = new StringRedisTemplate(factory);
        template.afterPropertiesSet();
        return template;
    }

    private static SpendGuard guard(StringRedisTemplate redis, String provider) {
        return guard(redis, provider, SpendLanes.open());
    }

    private static SpendGuard guard(StringRedisTemplate redis, String provider, Map<String, SpendProperties.Lane> lanes) {
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> redisProvider = mock(ObjectProvider.class);
        when(redisProvider.getIfAvailable()).thenReturn(redis);
        SpendProperties caps = new SpendProperties("Asia/Kolkata", new SpendProperties.Cap(1_000L, 1_000L),
                Map.of(provider, new SpendProperties.Cap(100L, 100L)), lanes);
        return new SpendGuard(redisProvider, caps, new SimpleMeterRegistry());
    }

    private static String monthKey(String provider) {
        String month = DateTimeFormatter.ofPattern("yyyy-MM").format(LocalDate.now(ZoneId.of("Asia/Kolkata")));
        return "wexy:spend:m:" + month + ":" + provider;
    }

    @Test
    void theRealScriptEnforcesTheExactCapAndSetsWindowLifetimes() {
        StringRedisTemplate redis = template(REDIS_7);
        SpendGuard guard = guard(redis, "meta-spark");

        for (int i = 0; i < 10; i++) {
            assertThat(guard.tryCharge("meta-spark", LANE, 10, "plan")).isEqualTo(SpendGuard.Charge.ALLOWED);
        }
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "over")).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        String key = monthKey("meta-spark");
        assertThat(redis.opsForValue().get(key)).isEqualTo("100");
        // EXPIRE ... NX gave the window a lifetime, and a later charge did not reset it.
        assertThat(redis.getExpire(key)).isBetween(1L, 40L * 24 * 60 * 60);
    }

    /** The adjust script returns the unused part, counts an overrun past a full ceiling, and never goes below zero. */
    @Test
    void theRealAdjustScriptRefundsCountsOverrunsAndFloorsAtZero() {
        StringRedisTemplate redis = template(REDIS_7);
        SpendGuard guard = guard(redis, "meta-adjust");
        String key = monthKey("meta-adjust");

        SpendGuard.Receipt first = guard.reserve("meta-adjust", LANE, 100, "a call at the cap");
        assertThat(first.allowed()).isTrue();
        assertThat(guard.settle(first, 40, "the same call")).isEqualTo(SpendGuard.Settlement.REFUNDED);
        assertThat(redis.opsForValue().get(key)).isEqualTo("40");
        assertThat(redis.getExpire(key)).isBetween(1L, 40L * 24 * 60 * 60);

        SpendGuard.Receipt second = guard.reserve("meta-adjust", LANE, 60, "a call that fits again");
        assertThat(second.allowed()).isTrue();
        assertThat(guard.settle(second, 120, "the same call, over its bound")).isEqualTo(SpendGuard.Settlement.CHARGED);
        assertThat(redis.opsForValue().get(key)).isEqualTo("160");
        assertThat(guard.tryCharge("meta-adjust", LANE, 1, "after the overrun")).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        SpendGuard.Receipt stale = new SpendGuard.Receipt(SpendGuard.Charge.ALLOWED, "meta-adjust", LANE, 500,
                List.of("wexy:spend:m:2026-09", "wexy:spend:m:2026-09:meta-adjust", "wexy:spend:d:2026-09-30", "wexy:spend:d:2026-09-30:meta-adjust",
                        "wexy:spend:d:2026-09-30:lane:early"));
        assertThat(guard.settle(stale, 0, "a call from a window that rolled")).isEqualTo(SpendGuard.Settlement.REFUNDED);
        assertThat(redis.opsForValue().get("wexy:spend:m:2026-09:meta-adjust")).isEqualTo("0");
        assertThat(redis.opsForValue().get(key)).isEqualTo("160");
    }

    /**
     * W1: the real script holds a lane at its ceiling in the same atomic step as the four, while the global and the
     * provider still have room, and gives the lane's day a lifetime; another lane is untouched.
     */
    @Test
    void theRealScriptHoldsALaneAtItsCeiling() {
        StringRedisTemplate redis = template(REDIS_7);
        SpendGuard guard = guard(redis, "meta-lane", SpendLanes.of(30, SpendLanes.WIDE, SpendLanes.WIDE));
        String day = DateTimeFormatter.ofPattern("yyyy-MM-dd").format(LocalDate.now(ZoneId.of("Asia/Kolkata")));

        assertThat(guard.tryCharge("meta-lane", SpendGuard.LANE_ANONYMOUS, 30, "the lane's day")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-lane", SpendGuard.LANE_ANONYMOUS, 1, "one past")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(guard.tryCharge("meta-lane", SpendGuard.LANE_EARLY_ACCESS, 30, "another lane")).isEqualTo(SpendGuard.Charge.ALLOWED);

        String lane = "wexy:spend:d:" + day + ":lane:anonymous";
        assertThat(redis.opsForValue().get(lane)).isEqualTo("30");
        assertThat(redis.getExpire(lane)).isBetween(1L, 3L * 24 * 60 * 60);
        assertThat(redis.opsForValue().get(monthKey("meta-lane"))).as("the refused call counted nowhere").isEqualTo("60");
    }

    /** EXPIRE ... NX needs Redis 7: on 6.2 the scripts fail, and the meter fails closed (gotchas). */
    @Test
    void onRedis6EveryChargeFailsClosed() {
        SpendGuard guard = guard(template(REDIS_6), "meta-spark");

        assertThat(guard.tryCharge("meta-spark", LANE, 10, "plan")).isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
        SpendGuard.Receipt receipt = new SpendGuard.Receipt(SpendGuard.Charge.ALLOWED, "meta-spark", LANE, 10, List.of("a", "b", "c", "d", "e"));
        assertThat(guard.settle(receipt, 20, "plan")).isEqualTo(SpendGuard.Settlement.METER_UNAVAILABLE);
        assertThat(guard.owed()).isEqualTo(10);
    }
}
