package ai.wexy.gateway.shield;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.filter.ratelimit.AbstractRateLimiter;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import reactor.core.publisher.Mono;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A distributed token bucket backed by a single Redis round trip.
 *
 * Copied from FlareLink's TokenBucketRateLimiter (pre-existing work); the Redis keys are now under
 * {@code wexy:}. FlareLink's {@code token_bucket.lua} resource was the older script this one
 * replaced, and is not copied. Why it is shaped this way:
 *  - millisecond refill, so sub-second rates are not rounded away;
 *  - the key TTL covers a full refill, so pausing cannot reset a bucket to full;
 *  - a Redis failure follows an explicit policy instead of silently allowing everything.
 */
public class TokenBucketRateLimiter extends AbstractRateLimiter<Object> {

    private static final Logger log = LoggerFactory.getLogger(TokenBucketRateLimiter.class);

    private static final String LUA = """
            local tokens_key = KEYS[1]
            local ts_key = KEYS[2]

            local capacity = tonumber(ARGV[1])
            local rate = tonumber(ARGV[2])
            local cost = tonumber(ARGV[3])
            local now = tonumber(ARGV[4])
            local ttl = tonumber(ARGV[5])

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

            return { allowed, math.floor(new_tokens) }
            """;

    private final ReactiveStringRedisTemplate redisTemplate;
    private final RedisScript<List<Long>> script;
    private final String keyPrefix;
    private final GatewayShieldProperties.Bucket bucket;
    private final GatewayShieldProperties.RedisOutagePolicy outagePolicy;
    private final boolean shieldEnabled;
    private final LocalTokenBucket localFallback;

    private final AtomicLong lastOutageLogMillis = new AtomicLong();

    @SuppressWarnings("unchecked")
    public TokenBucketRateLimiter(ReactiveStringRedisTemplate redisTemplate,
                                  String keyPrefix,
                                  GatewayShieldProperties.Bucket bucket,
                                  GatewayShieldProperties properties) {
        super(Object.class, "wexy-token-bucket", null);
        this.redisTemplate = redisTemplate;
        this.keyPrefix = keyPrefix;
        this.bucket = bucket;
        this.outagePolicy = properties.getRedisOutagePolicy();
        this.shieldEnabled = properties.isEnabled();

        DefaultRedisScript<List<Long>> redisScript = new DefaultRedisScript<>();
        redisScript.setScriptText(LUA);
        redisScript.setResultType((Class<List<Long>>) (Class<?>) List.class);
        this.script = redisScript;

        this.localFallback = new LocalTokenBucket(
                bucket.getRefillPerSecond(), bucket.getBurstCapacity(), 100_000);
    }

    @Override
    public Mono<Response> isAllowed(String routeId, String id) {
        if (!shieldEnabled) {
            return Mono.just(new Response(true, headers(bucket.getBurstCapacity())));
        }

        String hashTag = "{" + keyPrefix + ":" + id + "}";
        List<String> keys = List.of("wexy:shield:" + hashTag + ":t", "wexy:shield:" + hashTag + ":ts");
        List<String> args = Arrays.asList(
                String.valueOf(bucket.getBurstCapacity()),
                String.valueOf(bucket.getRefillPerSecond() / 1000.0d),
                String.valueOf(bucket.getRequestCost()),
                String.valueOf(System.currentTimeMillis()),
                String.valueOf(bucket.stateTtlSeconds())
        );

        return redisTemplate.execute(this.script, keys, args)
                .next()
                .map(result -> {
                    boolean allowed = !result.isEmpty() && result.get(0) == 1L;
                    double remaining = result.size() > 1 ? result.get(1) : 0d;
                    if (!allowed && log.isDebugEnabled()) {
                        log.debug("Rate limit hit on '{}' for key '{}'", keyPrefix, id);
                    }
                    return new Response(allowed, headers(remaining));
                })
                .onErrorResume(error -> Mono.just(onRedisUnavailable(id, error)));
    }

    private Response onRedisUnavailable(String id, Throwable error) {
        // At most once every 10 s: an outage during an attack must not add its own log flood.
        long now = System.currentTimeMillis();
        long last = lastOutageLogMillis.get();
        if (now - last > 10_000 && lastOutageLogMillis.compareAndSet(last, now)) {
            log.error("Redis unavailable for rate limiting on '{}', applying policy {}: {}",
                    keyPrefix, outagePolicy, error.toString());
        }

        return switch (outagePolicy) {
            case ALLOW -> new Response(true, headers(bucket.getBurstCapacity()));
            case DENY -> new Response(false, headers(0));
            case LOCAL_FALLBACK -> {
                LocalTokenBucket.Decision decision = localFallback.tryConsume(id, bucket.getRequestCost());
                yield new Response(decision.allowed(), headers(decision.remainingTokens()));
            }
        };
    }

    private Map<String, String> headers(double remaining) {
        Map<String, String> headers = new HashMap<>();
        headers.put("X-RateLimit-Remaining", String.valueOf(Math.max(0L, (long) remaining)));
        headers.put("X-RateLimit-Burst-Capacity", String.valueOf((long) bucket.getBurstCapacity()));
        headers.put("X-RateLimit-Replenish-Rate", String.valueOf(bucket.getRefillPerSecond()));
        if (remaining < bucket.getRequestCost()) {
            headers.put("Retry-After", String.valueOf(retryAfterSeconds(remaining)));
        }
        return headers;
    }

    private long retryAfterSeconds(double remaining) {
        if (bucket.getRefillPerSecond() <= 0) {
            return bucket.stateTtlSeconds();
        }
        double deficit = Math.max(0d, bucket.getRequestCost() - remaining);
        return Math.max(1L, (long) Math.ceil(deficit / bucket.getRefillPerSecond()));
    }
}
