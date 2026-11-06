package ai.wexy.forge.allowance;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The grants in Redis (W1), on SpendGuard's patterns: each step that checks and writes is one Lua script, every key it
 * touches passed in KEYS, a delimited string as the reply, the clock read in Java. Redis unreachable throws, and the
 * caller grants nothing (the fail-closed path). {@code EXPIRE ... NX} needs Redis 7, as SpendGuard's scripts do.
 */
@Component
class RedisGrantStore implements GrantStore {

    /**
     * KEYS: the n counters, the grant's record, its index. ARGV: n, the n limits, the n lifetimes, the grant's life, its
     * id, then the record's field and value pairs. All or nothing: a counter at its limit writes nothing.
     */
    static final RedisScript<String> GRANT = new DefaultRedisScript<>(
            "local n = tonumber(ARGV[1])\n"
            + "for i = 1, n do\n"
            + "  local used = tonumber(redis.call('GET', KEYS[i]) or '0')\n"
            + "  if used >= tonumber(ARGV[1 + i]) then return 'DENY|' .. (i - 1) end\n"
            + "end\n"
            + "for i = 1, n do\n"
            + "  redis.call('INCR', KEYS[i])\n"
            + "  redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1 + n + i]), 'NX')\n"
            + "end\n"
            + "local life = tonumber(ARGV[2 + 2 * n])\n"
            + "local record = KEYS[n + 1]\n"
            + "for j = 4 + 2 * n, #ARGV, 2 do\n"
            + "  redis.call('HSET', record, ARGV[j], ARGV[j + 1])\n"
            + "end\n"
            + "redis.call('EXPIRE', record, life)\n"
            + "redis.call('SET', KEYS[n + 2], ARGV[3 + 2 * n], 'EX', life)\n"
            + "return 'OK'\n",
            String.class);

    /**
     * KEYS: the grant's record, the new index (unused when ARGV[6] is 0). ARGV: owner, field, limit, the prompt's hash or
     * empty, the grant's id, 1 to index.
     */
    static final RedisScript<String> JOIN = new DefaultRedisScript<>(
            "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'NONE' end\n"
            + "if redis.call('HGET', record, 'owner') ~= ARGV[1] then return 'NONE' end\n"
            + "if ARGV[4] ~= '' and redis.call('HGET', record, 'prompt') ~= ARGV[4] then return 'NONE' end\n"
            + "local used = tonumber(redis.call('HGET', record, ARGV[2]) or '0')\n"
            + "if used >= tonumber(ARGV[3]) then return 'FULL' end\n"
            + "redis.call('HINCRBY', record, ARGV[2], 1)\n"
            + "if ARGV[6] == '1' then\n"
            + "  local ttl = redis.call('TTL', record)\n"
            + "  if ttl > 0 then redis.call('SET', KEYS[2], ARGV[5], 'EX', ttl) end\n"
            + "end\n"
            + "return 'JOINED'\n",
            String.class);

    /** {@link #JOIN}'s checks alone, in the same order, writing nothing. KEYS: the grant's record. ARGV: as JOIN's first four. */
    static final RedisScript<String> PROBE = new DefaultRedisScript<>(
            "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'NONE' end\n"
            + "if redis.call('HGET', record, 'owner') ~= ARGV[1] then return 'NONE' end\n"
            + "if ARGV[4] ~= '' and redis.call('HGET', record, 'prompt') ~= ARGV[4] then return 'NONE' end\n"
            + "local used = tonumber(redis.call('HGET', record, ARGV[2]) or '0')\n"
            + "if used >= tonumber(ARGV[3]) then return 'FULL' end\n"
            + "return 'JOINED'\n",
            String.class);

    /** KEYS: the grant's record. */
    static final RedisScript<String> DISPATCHED = new DefaultRedisScript<>(
            "if redis.call('EXISTS', KEYS[1]) == 0 then return 'GONE' end\n"
            + "redis.call('HSET', KEYS[1], 'dispatched', '1')\n"
            + "return 'OK'\n",
            String.class);

    /**
     * KEYS: the grant's record, its index, then its counters. ARGV: the counters as the record names them. Only an
     * unspent grant whose record names exactly these counters is given back.
     */
    static final RedisScript<String> RELEASE = new DefaultRedisScript<>(
            "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'GONE' end\n"
            + "if redis.call('HGET', record, 'dispatched') == '1' then return 'SPENT' end\n"
            + "if redis.call('HGET', record, 'counters') ~= ARGV[1] then return 'MISMATCH' end\n"
            + "for i = 3, #KEYS do\n"
            + "  local v = redis.call('DECR', KEYS[i])\n"
            + "  if v <= 0 then redis.call('DEL', KEYS[i]) end\n"
            + "end\n"
            + "redis.call('DEL', record, KEYS[2])\n"
            + "return 'RELEASED'\n",
            String.class);

    /** {@link GrantStore#FOLLOWABLE} as a Lua set, so the scripts and the Java side read one list. */
    private static final String FOLLOWABLE_LUA = "local followable = {"
            + FOLLOWABLE.stream().sorted().map(end -> "['" + end + "']=true").collect(Collectors.joining(", ")) + "}\n";

    /**
     * Q120 (b): a follow-up's checks, writing nothing. KEYS: the grant's record. ARGV: owner, the follow-ups' limit, the
     * follow-up's prompt hash.
     */
    static final RedisScript<String> PROBE_FOLLOW = new DefaultRedisScript<>(
            FOLLOWABLE_LUA
            + "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'NONE' end\n"
            + "if redis.call('HGET', record, 'owner') ~= ARGV[1] then return 'NONE' end\n"
            + "if tonumber(redis.call('HGET', record, 'followups') or '0') >= tonumber(ARGV[2]) then return 'FULL' end\n"
            + "local ended = redis.call('HGET', record, 'end')\n"
            + "if not ended then return 'OPEN' end\n"
            + "if not followable[ended] then return 'WORLD' end\n"
            + "if redis.call('HGET', record, 'prompt') == ARGV[3] then return 'SAME' end\n"
            + "return 'CHANGED'\n",
            String.class);

    /**
     * Q120 (b): the follow-up joined, all or nothing. KEYS: the grant's record, the follow-up's index. ARGV: owner, the
     * follow-ups' limit, the follow-up's prompt hash, the grant's id, the follow-up's turn id.
     */
    static final RedisScript<String> FOLLOW = new DefaultRedisScript<>(
            FOLLOWABLE_LUA
            + "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'NONE' end\n"
            + "if redis.call('HGET', record, 'owner') ~= ARGV[1] then return 'NONE' end\n"
            + "local used = tonumber(redis.call('HGET', record, 'followups') or '0')\n"
            + "if used >= tonumber(ARGV[2]) then return 'FULL' end\n"
            + "local ended = redis.call('HGET', record, 'end')\n"
            + "if not ended then return 'OPEN' end\n"
            + "if not followable[ended] then return 'WORLD' end\n"
            + "local prompt = redis.call('HGET', record, 'prompt')\n"
            + "if not prompt then return 'NONE' end\n"
            + "redis.call('HSET', record, 'followups', tostring(used + 1), 'following', ARGV[5], 'followDispatched', '0',\n"
            + "  'prevPrompt', prompt, 'prevEnd', ended, 'prompt', ARGV[3])\n"
            + "redis.call('HDEL', record, 'end')\n"
            + "local ttl = redis.call('TTL', record)\n"
            + "if ttl > 0 then redis.call('SET', KEYS[2], ARGV[4], 'EX', ttl) end\n"
            + "return 'JOINED'\n",
            String.class);

    /** Q120 (b): the follow-up's first call went out. KEYS: the grant's record. ARGV: the follow-up's turn id. */
    static final RedisScript<String> FOLLOW_DISPATCHED = new DefaultRedisScript<>(
            "if redis.call('EXISTS', KEYS[1]) == 0 then return 'GONE' end\n"
            + "if redis.call('HGET', KEYS[1], 'following') ~= ARGV[1] then return 'OTHER' end\n"
            + "redis.call('HSET', KEYS[1], 'followDispatched', '1')\n"
            + "return 'OK'\n",
            String.class);

    /**
     * Q120 (b): a follow-up that dispatched nothing, given back. KEYS: the grant's record, the follow-up's index. ARGV: the
     * follow-up's turn id.
     */
    static final RedisScript<String> UNFOLLOW = new DefaultRedisScript<>(
            "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'GONE' end\n"
            + "if redis.call('HGET', record, 'following') ~= ARGV[1] then return 'OTHER' end\n"
            + "if redis.call('HGET', record, 'followDispatched') == '1' then return 'SPENT' end\n"
            + "local prompt = redis.call('HGET', record, 'prevPrompt')\n"
            + "local ended = redis.call('HGET', record, 'prevEnd')\n"
            + "if not prompt or not ended then return 'OTHER' end\n"
            + "local used = tonumber(redis.call('HGET', record, 'followups') or '0')\n"
            + "redis.call('HSET', record, 'followups', tostring(math.max(0, used - 1)), 'prompt', prompt, 'end', ended)\n"
            + "redis.call('HDEL', record, 'following', 'followDispatched', 'prevPrompt', 'prevEnd')\n"
            + "redis.call('DEL', KEYS[2])\n"
            + "return 'RELEASED'\n",
            String.class);

    /**
     * Q120 (b): a turn's end, written by the grant's own turn only (its entry, or once one joined, its follow-up). KEYS: the
     * grant's record. ARGV: the turn's id, its end.
     */
    static final RedisScript<String> ENDED = new DefaultRedisScript<>(
            "local record = KEYS[1]\n"
            + "if redis.call('EXISTS', record) == 0 then return 'GONE' end\n"
            + "local following = redis.call('HGET', record, 'following')\n"
            + "if following then\n"
            + "  if following ~= ARGV[1] then return 'OTHER' end\n"
            + "elseif redis.call('HGET', record, 'entry') ~= ARGV[1] then return 'OTHER' end\n"
            + "redis.call('HSET', record, 'end', ARGV[2])\n"
            + "return 'OK'\n",
            String.class);

    private final StringRedisTemplate redis;

    RedisGrantStore(ObjectProvider<StringRedisTemplate> redisProvider) {
        this.redis = redisProvider.getIfAvailable();
    }

    private StringRedisTemplate redis() {
        if (redis == null) {
            throw new IllegalStateException("No Redis connection: the allowances cannot be checked.");
        }
        return redis;
    }

    @Override
    public List<Long> counts(List<String> counters) {
        List<String> values = redis().opsForValue().multiGet(counters);
        if (values == null || values.size() != counters.size()) {
            throw new IllegalStateException("Redis answered no counts.");
        }
        List<Long> out = new ArrayList<>(values.size());
        for (String v : values) {
            out.add(v == null ? 0L : Long.parseLong(v));
        }
        return out;
    }

    @Override
    public int grant(List<String> counters, List<Long> limits, List<Long> lifetimesSeconds, String grantKey, String grantId,
                     String indexKey, Map<String, String> record, long lifeSeconds) {
        List<String> keys = new ArrayList<>(counters);
        keys.add(grantKey);
        keys.add(indexKey);
        List<Object> args = new ArrayList<>();
        args.add(Integer.toString(counters.size()));
        limits.forEach(l -> args.add(Long.toString(l)));
        lifetimesSeconds.forEach(t -> args.add(Long.toString(t)));
        args.add(Long.toString(lifeSeconds));
        args.add(grantId);
        record.forEach((field, value) -> {
            args.add(field);
            args.add(value);
        });
        String reply = redis().execute(GRANT, keys, args.toArray());
        if ("OK".equals(reply)) {
            return -1;
        }
        if (reply != null && reply.startsWith("DENY|")) {
            return Integer.parseInt(reply.substring(5));
        }
        throw new IllegalStateException("The grant script answered " + reply);
    }

    @Override
    public String lookup(String indexKey) {
        return redis().opsForValue().get(indexKey);
    }

    @Override
    public Join join(String grantKey, String owner, String field, long limit, String prompt, String newIndexKey, String grantId) {
        String reply = redis().execute(JOIN, List.of(grantKey, newIndexKey == null ? grantKey : newIndexKey),
                owner, field, Long.toString(limit), prompt == null ? "" : prompt, grantId, newIndexKey == null ? "0" : "1");
        if (reply == null) {
            throw new IllegalStateException("The join script answered nothing.");
        }
        return Join.valueOf(reply);
    }

    @Override
    public Join probe(String grantKey, String owner, String field, long limit, String prompt) {
        String reply = redis().execute(PROBE, List.of(grantKey), owner, field, Long.toString(limit), prompt == null ? "" : prompt);
        if (reply == null) {
            throw new IllegalStateException("The probe script answered nothing.");
        }
        return Join.valueOf(reply);
    }

    @Override
    public void dispatched(String grantKey) {
        redis().execute(DISPATCHED, List.of(grantKey));
    }

    @Override
    public boolean release(String grantKey, String indexKey, List<String> counters) {
        List<String> keys = new ArrayList<>();
        keys.add(grantKey);
        keys.add(indexKey);
        keys.addAll(counters);
        return "RELEASED".equals(redis().execute(RELEASE, keys, String.join(" ", counters)));
    }

    @Override
    public Follow probeFollow(String grantKey, String owner, long limit, String prompt) {
        return follow(redis().execute(PROBE_FOLLOW, List.of(grantKey), owner, Long.toString(limit), prompt), "probe");
    }

    @Override
    public Follow follow(String grantKey, String owner, long limit, String prompt, String newIndexKey, String grantId, String turnId) {
        return follow(redis().execute(FOLLOW, List.of(grantKey, newIndexKey), owner, Long.toString(limit), prompt, grantId, turnId), "join");
    }

    private static Follow follow(String reply, String script) {
        if (reply == null) {
            throw new IllegalStateException("The follow-up's " + script + " script answered nothing.");
        }
        return Follow.valueOf(reply);
    }

    @Override
    public void followDispatched(String grantKey, String turnId) {
        redis().execute(FOLLOW_DISPATCHED, List.of(grantKey), turnId);
    }

    @Override
    public boolean unfollow(String grantKey, String indexKey, String turnId) {
        return "RELEASED".equals(redis().execute(UNFOLLOW, List.of(grantKey, indexKey), turnId));
    }

    @Override
    public boolean ended(String grantKey, String turnId, String end) {
        return "OK".equals(redis().execute(ENDED, List.of(grantKey), turnId, end));
    }
}
