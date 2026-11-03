package ai.wexy.gateway.shield;

import ai.wexy.common.AgentTurn;
import ai.wexy.common.InternalToken;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tunables for the gateway's volumetric-abuse protection ("shield").
 *
 * Adapted from FlareLink's GatewayShieldProperties (pre-existing work). Changed: the prefix; the
 * buckets are Wexy's route classes (backend architecture §4); the identity-lookup settings are gone
 * with the user-service lookup; one body limit for every route, but the few that carry a saved world
 * or a poster through the API (W2; the creations platform design §11), which have their own.
 *
 * Every value can be overridden per profile, or by environment variable
 * ({@code WEXY_SHIELD_EDGE_REFILLPERSECOND=…}), so limits tighten during an incident without a
 * rebuild.
 */
@ConfigurationProperties(prefix = "wexy.shield")
public class GatewayShieldProperties {

    /** What to do when Redis cannot answer a rate-limit check. */
    public enum RedisOutagePolicy {
        /** Fall back to a per-instance in-memory bucket. The effective limit becomes limit × instances. */
        LOCAL_FALLBACK,
        /** Let the request through. Only sensible if something upstream also limits. */
        ALLOW,
        /** Refuse the request. Safest, but a Redis outage becomes a full outage. */
        DENY
    }

    private boolean enabled = true;

    /**
     * How many reverse proxies sit in front of the gateway, counting only those that append to
     * X-Forwarded-For. 0 trusts the socket address only. Wrong in either direction is dangerous: too
     * high lets clients spoof their address and dodge every limit; too low makes every visitor share
     * the proxy's bucket. Consulted only when {@link #trustedClientIpHeader} is unset or absent.
     */
    private int trustedProxyCount = 0;

    /**
     * A single-value header carrying the true client address, tried before X-Forwarded-For. Behind
     * Cloudflare that is CF-Connecting-IP. Empty disables it, and empty is the right default: set it
     * only when the proxy in front of the gateway overwrites the header on every request, or a
     * client that reaches the origin directly chooses its own bucket.
     */
    private String trustedClientIpHeader = "";

    private RedisOutagePolicy redisOutagePolicy = RedisOutagePolicy.LOCAL_FALLBACK;

    /** Client addresses exempt from the edge limiter (monitoring, load tests). */
    private List<String> allowedClients = new ArrayList<>();

    /** Paths the edge limiter skips: the key set forge-service fetches, and health checks. */
    private List<String> bypassPaths = new ArrayList<>(List.of("/.well-known/**", "/actuator/**"));

    /**
     * Request headers that carry identity and must never be accepted from a client. The gateway
     * adds the internal token itself, after it has verified the caller.
     */
    private List<String> strippedHeaders = new ArrayList<>(List.of(InternalToken.HEADER));

    private final Bucket edge = new Bucket(25, 100);
    private final Ban ban = new Ban();
    private final Concurrency concurrency = new Concurrency();
    private final Body body = new Body();

    /**
     * Per-route-class buckets, referenced by name from the routes. A class keyed by address before
     * authentication is named plainly; its per-account twin, keyed by the verified uid, ends in
     * {@code -user}; anonymous Firebase users get a tighter one where it matters.
     *
     * One world costs about four forge-create requests at once (a plan, then the functions in
     * parallel), so no create bucket may hold fewer than that. These are starting values, tuned
     * after the Day-2 benchmark; money is capped by SpendGuard, not here.
     *
     * An agent turn (the agent-loop design, Q66) makes up to {@link AgentTurn#MAX_CALLS} model calls, so its buckets
     * count calls: a request costs that many tokens, the constant forge-service caps a turn's calls at, so the two
     * cannot drift. Signed in, two turns at once, then one a minute; anonymous, two at once too, then one every two
     * minutes: a candidate's program revision (EA4.4) is a second turn right after the first, and one turn's room
     * refused it for two minutes (the EA4.4 review; Q66 amended 2026-11-01).
     */
    private final Map<String, Bucket> buckets = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("public-read", new Bucket(15, 45)),
            Map.entry("forge-create", new Bucket(0.5, 20)),
            Map.entry("forge-create-user", new Bucket(0.1, 12)),
            Map.entry("forge-create-anonymous", new Bucket(0.05, 8)),
            Map.entry("forge-edit", new Bucket(1, 30)),
            Map.entry("forge-edit-user", new Bucket(0.5, 15)),
            Map.entry("agent-turn", new Bucket(AgentTurn.MAX_CALLS / 30.0, 4 * AgentTurn.MAX_CALLS, AgentTurn.MAX_CALLS)),
            Map.entry("agent-turn-user", new Bucket(AgentTurn.MAX_CALLS / 60.0, 2 * AgentTurn.MAX_CALLS, AgentTurn.MAX_CALLS)),
            Map.entry("agent-turn-anonymous", new Bucket(AgentTurn.MAX_CALLS / 120.0, 2 * AgentTurn.MAX_CALLS, AgentTurn.MAX_CALLS)),
            // A module call is one model call (EA4.2). An attempt makes at most AgentTurn.MODULE_CALLS of them (Q84, revised
            // 2026-11-02: twelve authors and ten repairs; seven before), so these keep the turns' pace: signed in, two attempts
            // at once, then one a minute; anonymous, one, then one every two minutes; a client, four, then two every 30 s.
            Map.entry("agent-module", new Bucket(2.0 * AgentTurn.MODULE_CALLS / 30.0, 4 * AgentTurn.MODULE_CALLS)),
            Map.entry("agent-module-user", new Bucket(AgentTurn.MODULE_CALLS / 60.0, 2 * AgentTurn.MODULE_CALLS)),
            Map.entry("agent-module-anonymous", new Bucket(AgentTurn.MODULE_CALLS / 120.0, AgentTurn.MODULE_CALLS)),
            // Submitting a world to the showcase and withdrawing it (W4; the creations platform design §10).
            Map.entry("publish", new Bucket(0.1, 10)),
            Map.entry("publish-user", new Bucket(0.05, 5)),
            // W1: the caller's own allowance, read after each Create and sign-in (GET /v1/forge/allowance): cheap reads,
            // paced so a loop of them cannot hammer Redis; an address, then the uid. W2: the account's own reads too
            // (GET /v1/me, then W3's library and usage), which the studio makes at a sign-in, a reload and a claim.
            Map.entry("account-read", new Bucket(2, 30)),
            Map.entry("account-read-user", new Bucket(0.5, 10)),
            // W2 (§10's classes): an account's bootstrap (POST /v1/me, once a sign-in), its profile's writes (a handle
            // claimed once, its text), and its deletion (W5): rare by nature, so a loop of them is refused early.
            Map.entry("account-bootstrap", new Bucket(0.2, 10)),
            Map.entry("account-bootstrap-user", new Bucket(0.05, 5)),
            Map.entry("profile-write", new Bucket(0.5, 10)),
            Map.entry("profile-write-user", new Bucket(0.1, 5)),
            Map.entry("account-delete", new Bucket(0.05, 5)),
            Map.entry("account-delete-user", new Bucket(0.01, 3)),
            // Saves, renames and deletes of worlds (W3), and their posters (W4): one Save a few seconds apart is a lot.
            Map.entry("world-write", new Bucket(1, 20)),
            Map.entry("world-write-user", new Bucket(0.2, 10)),
            Map.entry("media-write", new Bucket(0.2, 10)),
            Map.entry("media-write-user", new Bucket(0.05, 5)),
            // The waitlist's form (W6): public, so an address alone, and slow.
            Map.entry("waitlist", new Bucket(0.05, 5)),
            Map.entry("admin", new Bucket(1, 10))
    ));

    public static class Bucket {
        /** Sustained tokens added per second. Fractions are allowed (0.05 is one every 20 s). */
        private double refillPerSecond;
        /** The most tokens the bucket holds: the largest burst tolerated. */
        private double burstCapacity;
        /** Tokens one request costs. */
        private double requestCost = 1;

        public Bucket() {
        }

        public Bucket(double refillPerSecond, double burstCapacity) {
            this.refillPerSecond = refillPerSecond;
            this.burstCapacity = burstCapacity;
        }

        /** A bucket whose request costs {@code requestCost} tokens: the agent turn's, which counts model calls. */
        public Bucket(double refillPerSecond, double burstCapacity, double requestCost) {
            this(refillPerSecond, burstCapacity);
            this.requestCost = requestCost;
        }

        public double getRefillPerSecond() {
            return refillPerSecond;
        }

        public void setRefillPerSecond(double refillPerSecond) {
            this.refillPerSecond = refillPerSecond;
        }

        public double getBurstCapacity() {
            return burstCapacity;
        }

        public void setBurstCapacity(double burstCapacity) {
            this.burstCapacity = burstCapacity;
        }

        public double getRequestCost() {
            return requestCost;
        }

        public void setRequestCost(double requestCost) {
            this.requestCost = requestCost;
        }

        /**
         * How long bucket state must survive in Redis. If the key expires while the bucket is still
         * draining, the next request sees a full bucket again, which is the bypass this closes; so
         * the TTL covers a full refill.
         */
        public long stateTtlSeconds() {
            if (refillPerSecond <= 0) {
                return 3600;
            }
            return Math.max(60, (long) Math.ceil(burstCapacity / refillPerSecond) + 10);
        }
    }

    public static class Ban {
        /** Temporarily block clients that keep hammering after being limited. */
        private boolean enabled = true;
        /** Rate-limit rejections within the window before the client is blocked. */
        private int violationThreshold = 40;
        /** The window over which violations accumulate. */
        private long windowSeconds = 60;
        /** How long a block lasts. */
        private long durationSeconds = 600;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getViolationThreshold() {
            return violationThreshold;
        }

        public void setViolationThreshold(int violationThreshold) {
            this.violationThreshold = violationThreshold;
        }

        public long getWindowSeconds() {
            return windowSeconds;
        }

        public void setWindowSeconds(long windowSeconds) {
            this.windowSeconds = windowSeconds;
        }

        public long getDurationSeconds() {
            return durationSeconds;
        }

        public void setDurationSeconds(long durationSeconds) {
            this.durationSeconds = durationSeconds;
        }
    }

    public static class Concurrency {
        private boolean enabled = true;
        /**
         * In-flight requests allowed from one client. A studio holds a few model streams open at
         * once (one per function being written), so this stays well above that.
         */
        private int maxInFlightPerClient = 50;
        /** In-flight requests allowed across all clients on this instance. */
        private int maxInFlightTotal = 1000;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getMaxInFlightPerClient() {
            return maxInFlightPerClient;
        }

        public void setMaxInFlightPerClient(int maxInFlightPerClient) {
            this.maxInFlightPerClient = maxInFlightPerClient;
        }

        public int getMaxInFlightTotal() {
            return maxInFlightTotal;
        }

        public void setMaxInFlightTotal(int maxInFlightTotal) {
            this.maxInFlightTotal = maxInFlightTotal;
        }
    }

    public static class Body {
        private boolean enabled = true;
        /**
         * The cap for every request body but the routes below. The largest legitimate one elsewhere is a turn with its
         * base or diagnostics; nothing else comes close.
         */
        private long maxBytes = 256 * 1024;

        /**
         * Caps for single routes, by {@code "<METHOD> <path pattern>"} (W2; the creations platform design §10, §11): a
         * world's save carries its artifact (at most 512 KiB) as escaped JSON text, so its envelope may reach 768 KiB,
         * and a poster is at most 1 MiB of image. A pattern's {@code {id}} matches one path segment. Every other route,
         * and a path that matches none, keeps {@link #maxBytes}: the safe side. A profile's entries join these (Spring
         * merges maps), written bracketed in YAML, e.g. {@code "[POST /v1/worlds]": 786432}.
         */
        private Map<String, Long> routes = new LinkedHashMap<>(Map.of(
                "POST /v1/worlds", 768L * 1024,
                "POST /v1/worlds/{id}/revisions", 768L * 1024,
                "POST /v1/worlds/{id}/posters", 1024L * 1024));

        /** {@link #routes}, parsed once for each map that was set. */
        private volatile ParsedRoutes parsed;

        private record RouteCap(String method, org.springframework.web.util.pattern.PathPattern pattern, long bytes) {
        }

        private record ParsedRoutes(Map<String, Long> source, List<RouteCap> caps) {
        }

        /** The cap for one request: its route's, when one of {@link #routes} matches, else the default. */
        public long limitFor(String method, String path) {
            org.springframework.http.server.PathContainer container = org.springframework.http.server.PathContainer.parsePath(path);
            for (RouteCap cap : caps()) {
                if (cap.method().equals(method) && cap.pattern().matches(container)) {
                    return cap.bytes();
                }
            }
            return maxBytes;
        }

        /** Parses every route's key, so a malformed one stops the gateway at startup instead of capping nothing. */
        public void validate() {
            caps();
        }

        private List<RouteCap> caps() {
            ParsedRoutes current = parsed;
            if (current != null && current.source() == routes) {
                return current.caps();
            }
            List<RouteCap> caps = new ArrayList<>();
            for (Map.Entry<String, Long> route : routes.entrySet()) {
                String[] parts = route.getKey().trim().split(" ", -1);
                if (parts.length != 2 || !parts[0].matches("[A-Z]+") || !parts[1].startsWith("/") || route.getValue() == null
                        || route.getValue() <= 0) {
                    throw new IllegalStateException("wexy.shield.body.routes: \"" + route.getKey()
                            + "\" must be \"<METHOD> <path>\" with a positive byte count");
                }
                caps.add(new RouteCap(parts[0],
                        org.springframework.web.util.pattern.PathPatternParser.defaultInstance.parse(parts[1]), route.getValue()));
            }
            List<RouteCap> frozen = List.copyOf(caps);
            parsed = new ParsedRoutes(routes, frozen);
            return frozen;
        }

        public Map<String, Long> getRoutes() {
            return routes;
        }

        public void setRoutes(Map<String, Long> routes) {
            this.routes = routes;
        }

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public long getMaxBytes() {
            return maxBytes;
        }

        public void setMaxBytes(long maxBytes) {
            this.maxBytes = maxBytes;
        }
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public int getTrustedProxyCount() {
        return trustedProxyCount;
    }

    public void setTrustedProxyCount(int trustedProxyCount) {
        this.trustedProxyCount = trustedProxyCount;
    }

    public String getTrustedClientIpHeader() {
        return trustedClientIpHeader;
    }

    public void setTrustedClientIpHeader(String trustedClientIpHeader) {
        this.trustedClientIpHeader = trustedClientIpHeader;
    }

    public RedisOutagePolicy getRedisOutagePolicy() {
        return redisOutagePolicy;
    }

    public void setRedisOutagePolicy(RedisOutagePolicy redisOutagePolicy) {
        this.redisOutagePolicy = redisOutagePolicy;
    }

    public List<String> getAllowedClients() {
        return allowedClients;
    }

    public void setAllowedClients(List<String> allowedClients) {
        this.allowedClients = allowedClients;
    }

    public List<String> getBypassPaths() {
        return bypassPaths;
    }

    public void setBypassPaths(List<String> bypassPaths) {
        this.bypassPaths = bypassPaths;
    }

    public List<String> getStrippedHeaders() {
        return strippedHeaders;
    }

    public void setStrippedHeaders(List<String> strippedHeaders) {
        this.strippedHeaders = strippedHeaders;
    }

    public Bucket getEdge() {
        return edge;
    }

    public Ban getBan() {
        return ban;
    }

    public Concurrency getConcurrency() {
        return concurrency;
    }

    public Body getBody() {
        return body;
    }

    public Map<String, Bucket> getBuckets() {
        return buckets;
    }

    /**
     * Looks up a named bucket, failing at startup rather than silently running unlimited, or letting an agent turn's
     * bucket charge other than the calls a turn may make (a profile that names a bucket replaces it whole).
     */
    public Bucket bucket(String name) {
        Bucket bucket = buckets.get(name);
        if (bucket == null) {
            throw new IllegalStateException("No rate-limit bucket configured under wexy.shield.buckets." + name);
        }
        if (name.startsWith("agent-turn") && bucket.getRequestCost() != AgentTurn.MAX_CALLS) {
            throw new IllegalStateException("wexy.shield.buckets." + name + ".request-cost must be " + AgentTurn.MAX_CALLS
                    + ", the model calls forge-service lets a turn make, not " + bucket.getRequestCost());
        }
        return bucket;
    }
}
