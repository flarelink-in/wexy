package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.records.Ulid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Prompt grants by role (W1; the creations platform design §11, I6, I11, I13): an anonymous account is granted one
 * prompt, ever, and its network one anonymous prompt a day (Q98); a signed-in caller one a day (early access); an
 * admin its own number. A prompt is one entry request, a plan or a turn without a base, and the follow-ups that name
 * it: a revision of its turn, a Director turn on its plan's world, each within its budget and the prompt's life. One
 * naming none the caller has is a new prompt. Checking and counting are one atomic step ({@link GrantStore}).
 *
 * <p>The refusals: a spent anonymous allowance is {@code 403 account-required} (signing in is the way on, not
 * waiting); a spent day is {@code 429 quota} with {@code Retry-After} to the day's reset; a store that cannot answer is
 * {@code 503 unavailable}, and nothing is granted. Every Redis key holds the caller's uid key ({@link UidKey}) or
 * network key, never a uid or an address. Blocking: call it off the event loop.
 */
@Component
public class PromptGrants {

    /**
     * What a follow-up names, and so which of its grant's budgets it uses. A module call names its turn and carries its
     * prompt; a plan's author or repair call names the plan: each is inside that prompt or refused, never an entry of its
     * own. A re-plan names the plan the model failed and carries its idea: inside it, or an entry (the W1 review and its
     * bug hunt, 2026-11-02). A model's review of the world on the stage names its turn and carries its prompt, as a
     * module call does (EA6.4).
     */
    public enum Kind {
        DIRECTOR("director"), REVISION("revision"), MODULE("modules"), AUTHOR("authors"), REPAIR("repairs"), REPLAN("replans"),
        REVIEW("reviews");

        final String field;

        Kind(String field) {
            this.field = field;
        }
    }

    /**
     * What is left for a caller, read without writing.
     *
     * @param resetsAt when the next opens, or null where waiting opens nothing (an anonymous allowance)
     * @param spentBy  the counter that is spent ({@code account}, {@code network}, {@code day}), or null with some left
     */
    public record Peek(Role role, long left, Instant resetsAt, String spentBy) {
    }

    private static final Logger log = LoggerFactory.getLogger(PromptGrants.class);
    private static final String PREFIX = "wexy:allow:";
    private static final String GRANT = "wexy:grant:";
    private static final String INDEX = "wexy:grant:of:";
    /** A day counter's lifetime: past its own day, so it is never reclaimed while still current. */
    private static final long DAY_COUNTER_SECONDS = Duration.ofDays(2).toSeconds();

    private final GrantStore store;
    private final AllowanceProperties properties;
    private final UidKey uidKey;
    private final Clock clock;

    @Autowired
    public PromptGrants(GrantStore store, AllowanceProperties properties) {
        this(store, properties, Clock.systemUTC());
    }

    public PromptGrants(GrantStore store, AllowanceProperties properties, Clock clock) {
        this.properties = properties.validated();
        this.store = store;
        this.uidKey = new UidKey(properties.uidHmacHex(), Boolean.TRUE.equals(properties.uidKeyRequired()));
        this.clock = clock;
    }

    /** What is left for `caller`; {@code 503 unavailable} when the store cannot answer. Never writes. */
    public Peek peek(Caller caller) {
        Counters c = counters(caller);
        if (c == null) {
            return new Peek(Role.of(caller), 0, null, "network");
        }
        List<Long> used;
        try {
            used = store.counts(c.keys());
        } catch (RuntimeException e) {
            throw unavailable(e);
        }
        long left = Long.MAX_VALUE;
        String spentBy = null;
        for (int i = 0; i < used.size(); i++) {
            long room = Math.max(0, c.limits().get(i) - used.get(i));
            if (room < left) {
                left = room;
            }
            if (room == 0 && spentBy == null) {
                spentBy = c.names().get(i);
            }
        }
        return new Peek(c.role(), left, c.role() == Role.ANONYMOUS ? null : nextReset(), spentBy);
    }

    /** Refuses at once when `caller` has no prompt left, before anything costly (content safety) is asked. */
    public void check(Caller caller) {
        Peek peek = peek(caller);
        if (peek.left() <= 0) {
            throw refusal(peek.role(), peek.spentBy());
        }
    }

    /**
     * Grants one prompt for the entry request `entryId` (a plan's generation id or a turn's id), indexing it there, or
     * refuses. {@code promptHash} is the hash of the prompt's text, which a revision must carry to join it.
     */
    public Grant grant(Caller caller, String entryId, String promptHash) {
        Counters c = counters(caller);
        if (c == null) {
            log.info("allowance.denied role=anonymous reason=network");
            throw refusal(Role.ANONYMOUS, "network");
        }
        String id = Ulid.next(clock.instant());
        Map<String, String> record = new LinkedHashMap<>();
        record.put("owner", c.owner());
        record.put("role", c.role().lane());
        record.put("prompt", promptHash);
        record.put("counters", String.join(" ", c.keys()));
        record.put("dispatched", "0");
        int denied;
        try {
            denied = store.grant(c.keys(), c.limits(), c.lifetimes(), GRANT + id, id, INDEX + entryId, record,
                    properties.promptLife().toSeconds());
        } catch (RuntimeException e) {
            throw unavailable(e);
        }
        if (denied >= 0) {
            String by = c.names().get(denied);
            log.info("allowance.denied role={} reason={}", c.role().lane(), by);
            throw refusal(c.role(), by);
        }
        log.info("allowance.granted grant={} role={}", id, c.role().lane());
        return new Grant(id, c.role(), GRANT + id, INDEX + entryId, c.keys(), store);
    }

    /**
     * A follow-up naming `namedId` (a turn it revises, a plan whose world it edits): true when it runs inside that
     * prompt, which then counts it against its `kind`'s budget and, when `newId` is not null, answers to it too; false
     * when it names no live prompt of the caller's, one past its budget, or (when `promptHash` is not null) another
     * prompt's text: it is then a new prompt. {@code 503 unavailable} when the store cannot answer.
     */
    public boolean join(Caller caller, String namedId, Kind kind, String promptHash, String newId) {
        return follow(caller, namedId, kind, promptHash, newId) == GrantStore.Join.JOINED;
    }

    /**
     * As {@link #join}, saying why not: {@code FULL} when the named prompt's `kind` budget is spent, {@code NONE} when it
     * names no live prompt of the caller's or (with `promptHash`) another prompt's text. {@code 503} when the store
     * cannot answer.
     */
    GrantStore.Join follow(Caller caller, String namedId, Kind kind, String promptHash, String newId) {
        String owner = uidKey.of(caller.uid());
        if (owner == null || namedId == null) {
            return GrantStore.Join.NONE;
        }
        try {
            String grantId = store.lookup(INDEX + namedId);
            if (grantId == null) {
                return GrantStore.Join.NONE;
            }
            long limit = switch (kind) {
                case DIRECTOR -> properties.directorTurns();
                case REVISION -> properties.revisions();
                case MODULE -> properties.moduleCalls();
                case AUTHOR -> properties.authorCalls();
                case REPAIR -> properties.repairCalls();
                case REPLAN -> properties.replans();
                case REVIEW -> properties.reviewCalls();
            };
            GrantStore.Join join = store.join(GRANT + grantId, owner, kind.field, limit, promptHash, newId == null ? null : INDEX + newId, grantId);
            log.info("allowance.follow-up kind={} grant={} {}", kind.field, grantId, join.name().toLowerCase());
            return join;
        } catch (RuntimeException e) {
            throw unavailable(e);
        }
    }

    /** The counters a caller's role takes, with their limits and lifetimes; null for an anonymous caller with no network. */
    private Counters counters(Caller caller) {
        Role role = Role.of(caller);
        String owner = uidKey.of(caller.uid());
        if (owner == null) {
            throw unavailable(new IllegalStateException("no uid key"));
        }
        String day = day().toString();
        long mark = properties.accountMark().toSeconds();
        return switch (role) {
            case ANONYMOUS -> caller.ipk() == null ? null : new Counters(role, owner,
                    List.of(PREFIX + "anon:" + owner, PREFIX + "net:" + day + ":" + caller.ipk()),
                    List.of((long) properties.anonymousPerAccount(), (long) properties.anonymousPerNetwork()),
                    List.of(mark, DAY_COUNTER_SECONDS), List.of("account", "network"));
            case EARLY_ACCESS -> new Counters(role, owner, List.of(PREFIX + "early:" + day + ":" + owner),
                    List.of((long) properties.earlyAccessPerDay()), List.of(DAY_COUNTER_SECONDS), List.of("day"));
            case ADMIN -> new Counters(role, owner, List.of(PREFIX + "admin:" + day + ":" + owner),
                    List.of((long) properties.adminPerDay()), List.of(DAY_COUNTER_SECONDS), List.of("day"));
        };
    }

    /** Today, as the allowance counts days: the UTC date of the time the day started. */
    LocalDate day() {
        return clock.instant().minus(Duration.ofHours(properties.dayStartsAtHourUtc())).atZone(ZoneOffset.UTC).toLocalDate();
    }

    /** When tomorrow's allowance opens. */
    Instant nextReset() {
        return day().plusDays(1).atStartOfDay(ZoneOffset.UTC).plusHours(properties.dayStartsAtHourUtc()).toInstant();
    }

    /** The refusal a spent allowance answers: sign in (anonymous), or the time to the reset (signed in). */
    private ForgeException refusal(Role role, String spentBy) {
        if (role == Role.ANONYMOUS) {
            return new ForgeException(ErrorCode.ACCOUNT_REQUIRED, "network".equals(spentBy)
                    ? "This network has made its free world today. Sign in with Google for early access: one world a day."
                    : "You've made your free world. Sign in with Google for early access: one world a day.");
        }
        // Whole seconds rounded up: a client that waits this long is never early, and a reset time shown from it is never
        // before the reset (the studio said 5:29 for a 5:30 reset when this was floored).
        long millis = Duration.between(clock.instant(), nextReset()).toMillis();
        long seconds = Math.max(1, Math.ceilDiv(millis, 1000L));
        return new ForgeException(ErrorCode.QUOTA, "Today's world is made; the next opens at the day's reset.", seconds);
    }

    private static ForgeException unavailable(RuntimeException cause) {
        log.warn("dependency.unavailable dep=redis op=allowance: {}", cause.toString());
        return new ForgeException(ErrorCode.UNAVAILABLE, "Live creation is unavailable right now: the allowance cannot be checked.");
    }

    private record Counters(Role role, String owner, List<String> keys, List<Long> limits, List<Long> lifetimes, List<String> names) {
    }
}
