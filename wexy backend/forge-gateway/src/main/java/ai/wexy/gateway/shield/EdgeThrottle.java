package ai.wexy.gateway.shield;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The gateway-wide per-client throttle: one bucket every request passes through before route
 * matching, authentication or proxying.
 *
 * Copied from FlareLink's EdgeThrottle (pre-existing work); names, Redis keys and meters changed.
 * The route limiters shape traffic per endpoint; this one bounds the total cost of an abusive
 * client, including requests that match no route. Bucket check, violation counting and ban lookup
 * run in one Lua script, so an attack costs one Redis round trip per request, and once a client is
 * banned a local cache answers without Redis at all.
 */
@Component
public class EdgeThrottle {

    /**
     * @param allowed           whether the request may proceed
     * @param banned            true inside a temporary block window
     * @param retryAfterSeconds the hint for Retry-After
     * @param remainingTokens   tokens left in the client's bucket
     */
    public record Verdict(boolean allowed, boolean banned, long retryAfterSeconds, long remainingTokens) {
        static Verdict ok(long remaining) {
            return new Verdict(true, false, 0, remaining);
        }
    }

    private static final Logger log = LoggerFactory.getLogger(EdgeThrottle.class);

    private static final String LUA = """
            local tokens_key = KEYS[1]
            local ts_key = KEYS[2]
            local violations_key = KEYS[3]
            local ban_key = KEYS[4]

            local capacity = tonumber(ARGV[1])
            local rate = tonumber(ARGV[2])
            local cost = tonumber(ARGV[3])
            local now = tonumber(ARGV[4])
            local ttl = tonumber(ARGV[5])
            local ban_enabled = tonumber(ARGV[6])
            local ban_threshold = tonumber(ARGV[7])
            local ban_window = tonumber(ARGV[8])
            local ban_duration = tonumber(ARGV[9])

            if ban_enabled == 1 then
              local ban_ttl = redis.call('ttl', ban_key)
              if ban_ttl > 0 then
                return { 0, 1, ban_ttl, 0 }
              end
            end

            local last_tokens = tonumber(redis.call('get', tokens_key))
            if last_tokens == nil then last_tokens = capacity end

            local last_ts = tonumber(redis.call('get', ts_key))
            if last_ts == nil then last_ts = now end

            local delta = math.max(0, now - last_ts)
            local filled = math.min(capacity, last_tokens + (delta * rate))

            local allowed = 0
            local new_tokens = filled
            if filled >= cost then
              allowed = 1
              new_tokens = filled - cost
            end

            redis.call('setex', tokens_key, ttl, new_tokens)
            redis.call('setex', ts_key, ttl, now)

            if allowed == 1 then
              return { 1, 0, 0, math.floor(new_tokens) }
            end

            if ban_enabled == 1 then
              local violations = redis.call('incr', violations_key)
              if violations == 1 then
                redis.call('expire', violations_key, ban_window)
              end
              if violations >= ban_threshold then
                redis.call('setex', ban_key, ban_duration, '1')
                redis.call('del', violations_key)
                return { 0, 1, ban_duration, 0 }
              end
            end

            local retry = ttl
            if rate > 0 then
              retry = math.max(1, math.ceil((cost - new_tokens) / (rate * 1000)))
            end
            return { 0, 0, retry, 0 }
            """;

    private final ReactiveStringRedisTemplate redisTemplate;
    private final RedisScript<List<Long>> script;
    private final GatewayShieldProperties properties;
    private final GatewayShieldProperties.Bucket bucket;
    private final LocalTokenBucket localFallback;

    /** Banned clients answered without a Redis round trip; the value is the ban's end, epoch millis. */
    private final ConcurrentHashMap<String, Long> localBans = new ConcurrentHashMap<>();
    private final AtomicLong banSweepCounter = new AtomicLong();
    private final AtomicLong lastOutageLogMillis = new AtomicLong();

    // One meter per decision with one low-cardinality tag. Never tagged by client address: this
    // class exists to survive an attack from many addresses, and a per-address tag would turn that
    // attack into a cardinality explosion in Prometheus at exactly the wrong moment.
    private final Counter allowedMeter;
    private final Counter throttledMeter;
    private final Counter bannedMeter;
    private final Counter bannedCachedMeter;

    /** Redis round trips that failed, tagged with the policy applied instead. */
    private final Counter redisOutageMeter;

    /** Latency of the script. It runs before every request, so if it is slow, everything is. */
    private final Timer redisTimer;

    @SuppressWarnings("unchecked")
    public EdgeThrottle(ReactiveStringRedisTemplate redisTemplate,
                        GatewayShieldProperties properties,
                        MeterRegistry meterRegistry) {
        this.redisTemplate = redisTemplate;
        this.properties = properties;
        this.bucket = properties.getEdge();

        DefaultRedisScript<List<Long>> redisScript = new DefaultRedisScript<>();
        redisScript.setScriptText(LUA);
        redisScript.setResultType((Class<List<Long>>) (Class<?>) List.class);
        this.script = redisScript;

        this.localFallback = new LocalTokenBucket(
                bucket.getRefillPerSecond(), bucket.getBurstCapacity(), 100_000);

        // Registered eagerly so every series exists from startup: a counter created on its first
        // increment is indistinguishable from a quiet one, which matters most for `banned`.
        this.allowedMeter = decisionCounter(meterRegistry, "allowed");
        this.throttledMeter = decisionCounter(meterRegistry, "throttled");
        this.bannedMeter = decisionCounter(meterRegistry, "banned");
        this.bannedCachedMeter = decisionCounter(meterRegistry, "banned_cached");

        this.redisOutageMeter = Counter.builder("wexy.edge.redis.failures")
                .description("Edge throttle Redis round trips that failed and fell back to the outage policy")
                .tag("policy", properties.getRedisOutagePolicy().name().toLowerCase())
                .register(meterRegistry);

        this.redisTimer = Timer.builder("wexy.edge.redis.latency")
                .description("Latency of the edge throttle script, which runs before every request")
                .publishPercentileHistogram()
                .register(meterRegistry);

        Gauge.builder("wexy.edge.bans.active", localBans, Map::size)
                .description("Clients currently inside a temporary block window, per gateway instance")
                .register(meterRegistry);
    }

    private static Counter decisionCounter(MeterRegistry registry, String decision) {
        return Counter.builder("wexy.edge.decisions")
                .description("Edge throttle verdicts for requests that were not exempt or allow-listed")
                .tag("decision", decision)
                .register(registry);
    }

    public Mono<Verdict> check(String clientIp) {
        if (!properties.isEnabled()) {
            return Mono.just(Verdict.ok((long) bucket.getBurstCapacity()));
        }

        Long banUntil = localBans.get(clientIp);
        if (banUntil != null) {
            long remainingMillis = banUntil - System.currentTimeMillis();
            if (remainingMillis > 0) {
                // Counted apart from `banned`: this path never touches Redis, so the split also
                // shows how much traffic the local cache absorbs for free.
                bannedCachedMeter.increment();
                return Mono.just(new Verdict(false, true, Math.max(1, remainingMillis / 1000), 0));
            }
            localBans.remove(clientIp, banUntil);
        }

        GatewayShieldProperties.Ban ban = properties.getBan();
        String hashTag = "{edge:" + clientIp + "}";
        List<String> keys = List.of(
                "wexy:shield:" + hashTag + ":t",
                "wexy:shield:" + hashTag + ":ts",
                "wexy:shield:" + hashTag + ":v",
                "wexy:shield:" + hashTag + ":ban"
        );
        List<String> args = Arrays.asList(
                String.valueOf(bucket.getBurstCapacity()),
                String.valueOf(bucket.getRefillPerSecond() / 1000.0d),
                String.valueOf(bucket.getRequestCost()),
                String.valueOf(System.currentTimeMillis()),
                String.valueOf(bucket.stateTtlSeconds()),
                ban.isEnabled() ? "1" : "0",
                String.valueOf(ban.getViolationThreshold()),
                String.valueOf(ban.getWindowSeconds()),
                String.valueOf(ban.getDurationSeconds())
        );

        Timer.Sample sample = Timer.start();
        return redisTemplate.execute(this.script, keys, args)
                .next()
                .map(result -> toVerdict(clientIp, result))
                .onErrorResume(error -> Mono.just(onRedisUnavailable(clientIp, error)))
                .doOnNext(this::record)
                .doFinally(signal -> sample.stop(redisTimer));
    }

    private void record(Verdict verdict) {
        if (verdict.allowed()) {
            allowedMeter.increment();
        } else if (verdict.banned()) {
            bannedMeter.increment();
        } else {
            throttledMeter.increment();
        }
    }

    private Verdict toVerdict(String clientIp, List<Long> result) {
        if (result == null || result.size() < 4) {
            return Verdict.ok((long) bucket.getBurstCapacity());
        }
        boolean allowed = result.get(0) == 1L;
        boolean banned = result.get(1) == 1L;
        long retryAfter = result.get(2);
        long remaining = result.get(3);

        if (banned) {
            rememberBan(clientIp, retryAfter);
        }
        return new Verdict(allowed, banned, retryAfter, remaining);
    }

    private void rememberBan(String clientIp, long retryAfterSeconds) {
        sweepBansIfNeeded();
        localBans.put(clientIp, System.currentTimeMillis() + (retryAfterSeconds * 1000L));
    }

    private void sweepBansIfNeeded() {
        if (banSweepCounter.incrementAndGet() % 256 != 0 && localBans.size() < 50_000) {
            return;
        }
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Long>> it = localBans.entrySet().iterator();
        while (it.hasNext()) {
            if (it.next().getValue() < now) {
                it.remove();
            }
        }
        if (localBans.size() > 50_000) {
            localBans.clear();
        }
    }

    private Verdict onRedisUnavailable(String clientIp, Throwable error) {
        long now = System.currentTimeMillis();
        long last = lastOutageLogMillis.get();
        if (now - last > 10_000 && lastOutageLogMillis.compareAndSet(last, now)) {
            log.error("Redis unavailable for the edge throttle, applying policy {}: {}",
                    properties.getRedisOutagePolicy(), error.toString());
        }
        redisOutageMeter.increment();

        return switch (properties.getRedisOutagePolicy()) {
            case ALLOW -> Verdict.ok((long) bucket.getBurstCapacity());
            case DENY -> new Verdict(false, false, bucket.stateTtlSeconds(), 0);
            case LOCAL_FALLBACK -> {
                LocalTokenBucket.Decision decision = localFallback.tryConsume(clientIp, bucket.getRequestCost());
                yield new Verdict(decision.allowed(), false,
                        decision.allowed() ? 0 : 1, (long) Math.max(0d, decision.remainingTokens()));
            }
        };
    }
}
