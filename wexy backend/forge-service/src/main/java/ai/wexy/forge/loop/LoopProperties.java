package ai.wexy.forge.loop;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * The loop's limits (forge-loop design §5.1, §5.2, §5.3), under {@code wexy.loop.*}.
 *
 * @param caps          what a request may carry; over a cap is {@code 413 too-large} before any charge
 * @param heartbeat     the comment line's interval on a quiet stream (15 s: under Cloudflare's 100 s
 *                      and the gateway's 60 s idle timeouts)
 * @param store         the in-memory generation store's bounds
 * @param strictSchemas whether {@code response_format} asks Meta for {@code strict: true}. Off until
 *                      hour one shows Meta accepts the real schemas (Q24); Meta constrains the
 *                      answer to the schema either way, and the service validates it regardless
 */
@ConfigurationProperties(prefix = "wexy.loop")
public record LoopProperties(Caps caps, Duration heartbeat, Store store, boolean strictSchemas) {

    public LoopProperties {
        caps = caps == null ? new Caps(null, null, null, null, null, null, null, null, null, null, null) : caps;
        heartbeat = heartbeat == null ? Duration.ofSeconds(15) : heartbeat;
        store = store == null ? new Store(null, null) : store;
    }

    /**
     * Every cap of §5.1, with its default.
     *
     * @param promptChars     the longest idea, in characters (600)
     * @param minSeconds      the shortest film a plan is made for (4)
     * @param maxSeconds      the longest (30)
     * @param diagnostics     the most findings one repair carries (20)
     * @param diagnosticChars the longest finding message (300)
     * @param snippetChars    the longest line shown with a finding (200)
     * @param specBytes       the largest spec a direct call reads, as compact JSON (64 KB)
     * @param turnChars       the longest instruction to the director (400)
     * @param outcomeIds      the most generations one outcome report names (16)
     * @param ladderBytes     the largest ladder report, as compact JSON (4 KB)
     * @param labelChars      the longest adapter or browser label (64)
     */
    public record Caps(Integer promptChars, Integer minSeconds, Integer maxSeconds, Integer diagnostics,
                       Integer diagnosticChars, Integer snippetChars, Integer specBytes, Integer turnChars,
                       Integer outcomeIds, Integer ladderBytes, Integer labelChars) {

        public Caps {
            promptChars = promptChars == null ? 600 : promptChars;
            minSeconds = minSeconds == null ? 4 : minSeconds;
            maxSeconds = maxSeconds == null ? 30 : maxSeconds;
            diagnostics = diagnostics == null ? 20 : diagnostics;
            diagnosticChars = diagnosticChars == null ? 300 : diagnosticChars;
            snippetChars = snippetChars == null ? 200 : snippetChars;
            specBytes = specBytes == null ? 65_536 : specBytes;
            turnChars = turnChars == null ? 400 : turnChars;
            outcomeIds = outcomeIds == null ? 16 : outcomeIds;
            ladderBytes = ladderBytes == null ? 4_096 : ladderBytes;
            labelChars = labelChars == null ? 64 : labelChars;
        }
    }

    /**
     * @param maxEntries the most generations kept (10,000); the oldest go first
     * @param ttl        how long one is kept (2 h)
     */
    public record Store(Integer maxEntries, Duration ttl) {

        public Store {
            maxEntries = maxEntries == null ? 10_000 : maxEntries;
            ttl = ttl == null ? Duration.ofHours(2) : ttl;
        }
    }
}
