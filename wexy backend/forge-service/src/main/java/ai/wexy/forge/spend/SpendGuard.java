package ai.wexy.forge.spend;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A hard money ceiling on every call to a model: no meter, no call.
 *
 * Copied from FlareLink's SpendGuard (pre-existing work). Changed for Wexy: micro-USD instead of
 * paise; every cap required, so there is no "unlimited" and no master switch; a charge of zero or
 * less is a bug and refused; the result says whether a cap was reached or the meter was lost, so
 * the studio can tell {@code budget} from {@code paused}; keys and meters under {@code wexy}.
 *
 * Since the reviews of 2026-10-27 (forge-loop design §11), a call is a reservation and a
 * settlement. {@link #reserve} claims the call's bound against the ceilings, inside one script, and
 * hands back a {@link Receipt} naming the windows it landed in. {@link #settle} moves those windows
 * to what the API's usage says the call cost: down for the unused part of the bound, up for an
 * overrun. An overrun the meter cannot count at once becomes a {@link Debt}, retried before every
 * later reservation, and no call is reserved while a debt stands: the ledger never runs behind the
 * invoice.
 *
 * Design notes worth keeping, from FlareLink:
 *
 * 1. Check and increment happen inside one Lua script. Two round trips would let N concurrent
 *    callers all read a total below the ceiling and all proceed, at exactly the moment a cap matters.
 *
 * 2. It fails CLOSED. If Redis is unreachable the charge is refused and the feature stops. An
 *    unmetered billable call is the failure this class exists to prevent, so losing the meter has
 *    to mean losing the call. A feature outage is recoverable; the invoice is not.
 *
 * 3. The window string is computed in Java: Redis Lua must stay deterministic, so the clock is not
 *    read inside the script, and the time zone decision stays in one place.
 *
 * The scripts use {@code EXPIRE ... NX}, which needs Redis 7.0 or newer. On an older Redis every
 * charge fails, closed (gotchas).
 *
 * The template is blocking: callers on an event loop run {@link #reserve} and {@link #settle} on
 * boundedElastic.
 */
@Component
public class SpendGuard {

    /** What a reservation found. */
    public enum Charge { ALLOWED, CAP_REACHED, METER_UNAVAILABLE }

    /** What settling a finished call did. */
    public enum Settlement { NONE, REFUNDED, CHARGED, METER_UNAVAILABLE }

    /**
     * A reservation as the meter made it: the outcome, and the amount and the windows it landed in
     * when allowed, so the settlement moves the same windows whatever the clock says by then.
     */
    public record Receipt(Charge outcome, String provider, long microUsd, List<String> keys) {

        public Receipt {
            keys = List.copyOf(keys);
        }

        public boolean allowed() {
            return outcome == Charge.ALLOWED;
        }
    }

    /** Money a finished call spent beyond its reservation that the meter has not counted yet. */
    record Debt(String provider, List<String> keys, long microUsd, String detail) {
    }

    private static final Logger logger = LoggerFactory.getLogger(SpendGuard.class);

    private static final String KEY_PREFIX = "wexy:spend:";
    private static final DateTimeFormatter MONTH = DateTimeFormatter.ofPattern("yyyy-MM");
    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    /** Generous enough that a window is never reclaimed while it is still the current one. */
    private static final long MONTH_TTL_SECONDS = 40L * 24 * 60 * 60;
    private static final long DAY_TTL_SECONDS = 3L * 24 * 60 * 60;

    /** Utilisation points worth a log line on the way up. */
    private static final int[] ALERT_PERCENTS = {50, 80, 95};

    /**
     * Returns a delimited string rather than a Lua table on purpose: a table comes back as a mixed
     * array whose decoding depends on the template's serializer. One string parses the same way
     * everywhere.
     */
    static final RedisScript<String> CHARGE = new DefaultRedisScript<>(
            "local cost     = tonumber(ARGV[1])\n"
            + "local gmCap    = tonumber(ARGV[2])\n"
            + "local pmCap    = tonumber(ARGV[3])\n"
            + "local gdCap    = tonumber(ARGV[4])\n"
            + "local pdCap    = tonumber(ARGV[5])\n"
            + "local monthTtl = tonumber(ARGV[6])\n"
            + "local dayTtl   = tonumber(ARGV[7])\n"
            + "local function n(v) return string.format('%d', v) end\n"
            + "local gm = tonumber(redis.call('GET', KEYS[1]) or '0')\n"
            + "local pm = tonumber(redis.call('GET', KEYS[2]) or '0')\n"
            + "local gd = tonumber(redis.call('GET', KEYS[3]) or '0')\n"
            + "local pd = tonumber(redis.call('GET', KEYS[4]) or '0')\n"
            + "if gmCap >= 0 and gm + cost > gmCap then\n"
            + "  return 'DENY|GLOBAL_MONTH|' .. n(gm) .. '|' .. n(gmCap)\n"
            + "end\n"
            + "if pmCap >= 0 and pm + cost > pmCap then\n"
            + "  return 'DENY|PROVIDER_MONTH|' .. n(pm) .. '|' .. n(pmCap)\n"
            + "end\n"
            + "if gdCap >= 0 and gd + cost > gdCap then\n"
            + "  return 'DENY|GLOBAL_DAY|' .. n(gd) .. '|' .. n(gdCap)\n"
            + "end\n"
            + "if pdCap >= 0 and pd + cost > pdCap then\n"
            + "  return 'DENY|PROVIDER_DAY|' .. n(pd) .. '|' .. n(pdCap)\n"
            + "end\n"
            + "gm = redis.call('INCRBY', KEYS[1], cost)\n"
            + "redis.call('EXPIRE', KEYS[1], monthTtl, 'NX')\n"
            + "pm = redis.call('INCRBY', KEYS[2], cost)\n"
            + "redis.call('EXPIRE', KEYS[2], monthTtl, 'NX')\n"
            + "gd = redis.call('INCRBY', KEYS[3], cost)\n"
            + "redis.call('EXPIRE', KEYS[3], dayTtl, 'NX')\n"
            + "pd = redis.call('INCRBY', KEYS[4], cost)\n"
            + "redis.call('EXPIRE', KEYS[4], dayTtl, 'NX')\n"
            + "return 'OK|' .. n(pm) .. '|' .. n(pmCap) .. '|' .. n(pd) .. '|' .. n(pdCap)\n"
            + "          .. '|' .. n(gm) .. '|' .. n(gmCap) .. '|' .. n(gd) .. '|' .. n(gdCap)\n",
            String.class);

    /**
     * Moves every window of a finished call by a signed amount: down for the unused part of its
     * reservation, up for an overrun. No ceiling check, because the money is already spent or
     * already returned; a window never goes below zero. The same keys, the same arguments and the
     * same reply as {@link #CHARGE}, so the two are read the same way.
     */
    static final RedisScript<String> ADJUST = new DefaultRedisScript<>(
            "local delta    = tonumber(ARGV[1])\n"
            + "local gmCap    = tonumber(ARGV[2])\n"
            + "local pmCap    = tonumber(ARGV[3])\n"
            + "local gdCap    = tonumber(ARGV[4])\n"
            + "local pdCap    = tonumber(ARGV[5])\n"
            + "local monthTtl = tonumber(ARGV[6])\n"
            + "local dayTtl   = tonumber(ARGV[7])\n"
            + "local function n(v) return string.format('%d', v) end\n"
            + "local function move(key, ttl)\n"
            + "  local v = redis.call('INCRBY', key, delta)\n"
            + "  if v < 0 then\n"
            + "    redis.call('SET', key, '0')\n"
            + "    v = 0\n"
            + "  end\n"
            + "  redis.call('EXPIRE', key, ttl, 'NX')\n"
            + "  return v\n"
            + "end\n"
            + "local gm = move(KEYS[1], monthTtl)\n"
            + "local pm = move(KEYS[2], monthTtl)\n"
            + "local gd = move(KEYS[3], dayTtl)\n"
            + "local pd = move(KEYS[4], dayTtl)\n"
            + "return 'OK|' .. n(pm) .. '|' .. n(pmCap) .. '|' .. n(pd) .. '|' .. n(pdCap)\n"
            + "          .. '|' .. n(gm) .. '|' .. n(gmCap) .. '|' .. n(gd) .. '|' .. n(gdCap)\n",
            String.class);

    private final StringRedisTemplate redis;
    private final SpendProperties properties;
    private final ZoneId zone;
    private final MeterRegistry meterRegistry;

    /**
     * Meters per configured provider. Cardinality stays tiny: providers come from configuration,
     * never from a caller's string.
     */
    private final Map<String, Counter> chargeCounters = new ConcurrentHashMap<>();
    private final Map<String, Counter> moneyCounters = new ConcurrentHashMap<>();

    /**
     * Live budget state, scraped as gauges: how much of each ceiling is left, which is the number
     * worth alerting on. Values come from the script's reply, so they hold across instances.
     */
    private final Map<String, AtomicLong> windowSpent = new ConcurrentHashMap<>();
    private final Map<String, AtomicLong> windowCap = new ConcurrentHashMap<>();

    /** Overruns the meter could not count yet, oldest first, and their sum per provider as a gauge. */
    private final Queue<Debt> debts = new ConcurrentLinkedQueue<>();
    private final Map<String, AtomicLong> debtOwed = new ConcurrentHashMap<>();

    public SpendGuard(ObjectProvider<StringRedisTemplate> redisProvider,
                      SpendProperties properties,
                      MeterRegistry meterRegistry) {
        this.zone = validate(properties);
        this.redis = redisProvider.getIfAvailable();
        this.properties = properties;
        this.meterRegistry = meterRegistry;

        // Registered eagerly for every provider, so the series exist from startup: an absent series
        // is indistinguishable from a quiet one, which matters most for `denied_cap` and `overrun`.
        for (String provider : properties.provider().keySet()) {
            for (String outcome : new String[]{"allowed", "denied_cap", "denied_no_meter", "denied_error", "denied_debt", "overrun"}) {
                chargeCounter(provider, outcome);
            }
            for (String kind : new String[]{"spent", "refused", "refunded", "overrun", "debt"}) {
                moneyCounter(provider, kind);
            }
            debtGauge(provider);
        }

        if (this.redis == null) {
            logger.error("SpendGuard has no Redis connection. Every model call will be REFUSED until Redis is "
                    + "reachable: this is the fail-closed path, not a crash.");
        } else {
            logger.info("SpendGuard active. Global ceiling {}/month, {}/day, rolling in {}.",
                    usd(properties.global().monthlyMicroUsd()), usd(properties.global().dailyMicroUsd()), zone);
        }
    }

    /** Refuses to start without every ceiling: a missing cap must deny, never unlock. */
    private static ZoneId validate(SpendProperties properties) {
        ZoneId zone;
        try {
            zone = ZoneId.of(properties.zone());
        } catch (DateTimeException e) {
            throw new IllegalStateException("wexy.spend.zone is not a time zone: " + properties.zone(), e);
        }
        requireCap("wexy.spend.global", properties.global());
        properties.provider().forEach((name, cap) -> requireCap("wexy.spend.provider." + name, cap));
        return zone;
    }

    private static void requireCap(String path, SpendProperties.Cap cap) {
        if (cap == null || cap.monthlyMicroUsd() == null || cap.dailyMicroUsd() == null) {
            throw new IllegalStateException("No spend ceiling at " + path + ": set both monthly-micro-usd and "
                    + "daily-micro-usd. There is no unlimited; a missing cap must deny, never unlock.");
        }
        if (cap.monthlyMicroUsd() < 0 || cap.dailyMicroUsd() < 0) {
            throw new IllegalStateException(path + " has a negative ceiling. Use 0 to switch a provider off.");
        }
    }

    /** True when ceilings are configured for this provider key. */
    public boolean knows(String provider) {
        return properties.provider().containsKey(provider);
    }

    /** As {@link #reserve}, answering the outcome alone. */
    public Charge tryCharge(String provider, long microUsd, String detail) {
        return reserve(provider, microUsd, detail).outcome();
    }

    /**
     * Claims {@code microUsd} against the ceilings, or refuses. Any overrun still owed is counted
     * first; while one cannot be, nothing is reserved (the ledger must not run behind the invoice).
     *
     * @param provider a key of {@code wexy.spend.provider.*}
     * @param microUsd what this call can cost at most, already resolved to an integer
     * @param detail   what is being paid for, for the log line when it is refused
     */
    public Receipt reserve(String provider, long microUsd, String detail) {
        if (microUsd <= 0) {
            throw new IllegalArgumentException("A billable call must never be counted as free: " + microUsd
                    + " micro-USD for " + detail);
        }
        SpendProperties.Cap providerCap = properties.provider().get(provider);
        if (providerCap == null) {
            throw new IllegalStateException("No spend ceiling for provider '" + provider
                    + "' under wexy.spend.provider.*; refusing " + detail);
        }
        if (redis == null) {
            chargeCounter(provider, "denied_no_meter").increment();
            moneyCounter(provider, "refused").increment(microUsd);
            logger.error("Refusing model call [{}] {}: SpendGuard has no Redis to meter against.", provider, detail);
            return new Receipt(Charge.METER_UNAVAILABLE, provider, microUsd, List.of());
        }
        if (!settleDebts()) {
            chargeCounter(provider, "denied_debt").increment();
            moneyCounter(provider, "refused").increment(microUsd);
            logger.error("Refusing model call [{}] {}: {} of overrun is still uncounted, and no call is reserved until it is.",
                    provider, detail, usd(owed()));
            return new Receipt(Charge.METER_UNAVAILABLE, provider, microUsd, List.of());
        }

        List<String> keys = windowKeys(provider);
        String result;
        try {
            result = redis.execute(CHARGE, keys, arguments(microUsd, providerCap));
        } catch (RuntimeException e) {
            // Fail closed. Counted apart from denied_cap: a cap hit is the design working, this is the
            // design unavailable, and the caller's symptom is the same.
            chargeCounter(provider, "denied_error").increment();
            moneyCounter(provider, "refused").increment(microUsd);
            logger.error("Refusing model call [{}] {}: SpendGuard could not reach Redis.", provider, detail, e);
            return new Receipt(Charge.METER_UNAVAILABLE, provider, microUsd, keys);
        }

        if (result == null) {
            chargeCounter(provider, "denied_error").increment();
            moneyCounter(provider, "refused").increment(microUsd);
            logger.error("Refusing model call [{}] {}: SpendGuard's script returned nothing.", provider, detail);
            return new Receipt(Charge.METER_UNAVAILABLE, provider, microUsd, keys);
        }

        String[] parts = result.split("\\|");

        if ("DENY".equals(parts[0])) {
            chargeCounter(provider, "denied_cap").increment();
            moneyCounter(provider, "refused").increment(microUsd);
            observeDeniedWindow(provider, parts);
            logger.error("SPEND CAP HIT [{}]: refused {} because the {} ceiling is exhausted ({} of {} spent). "
                            + "Live creation stays off until the window rolls. Raise wexy.spend.* only after "
                            + "confirming the spend is legitimate.",
                    provider, detail, parts[1], usd(Long.parseLong(parts[2])), usd(Long.parseLong(parts[3])));
            return new Receipt(Charge.CAP_REACHED, provider, microUsd, keys);
        }

        chargeCounter(provider, "allowed").increment();
        moneyCounter(provider, "spent").increment(microUsd);
        observeAllowedWindows(provider, parts);
        warnOnThresholdCrossing(provider, microUsd, parts);
        return new Receipt(Charge.ALLOWED, provider, microUsd, keys);
    }

    /**
     * Moves a finished call's windows from its reservation to what its reported usage cost: down
     * for the unused part (returned to the ceilings), up for an overrun. An overrun means the bound
     * the call was reserved at was wrong ({@code ModelCatalog.inputTokenBound}): it is counted
     * ({@code wexy.spend.charges{outcome=overrun}}) and logged at ERROR as {@code SPEND OVERRUN}.
     * An overrun the meter cannot count now is kept as a debt that every later reservation retries
     * first, and refuses on; a refund the meter cannot apply is simply forgone (the reservation
     * stands, which over-counts).
     *
     * @param receipt        the allowed reservation the call was made under
     * @param actualMicroUsd what the reported usage cost at the configured prices
     */
    public Settlement settle(Receipt receipt, long actualMicroUsd, String detail) {
        if (!receipt.allowed()) {
            throw new IllegalArgumentException("Only an allowed reservation can be settled: " + detail);
        }
        if (actualMicroUsd < 0) {
            throw new IllegalArgumentException("A call cannot have cost less than nothing: " + actualMicroUsd + " for " + detail);
        }
        long delta = actualMicroUsd - receipt.microUsd();
        if (delta == 0) {
            return Settlement.NONE;
        }
        String provider = receipt.provider();
        SpendProperties.Cap providerCap = properties.provider().get(provider);
        if (delta > 0) {
            chargeCounter(provider, "overrun").increment();
            moneyCounter(provider, "overrun").increment(delta);
            logger.error("SPEND OVERRUN [{}] {}: the call cost {} against {} reserved; {} is being counted. The input "
                            + "bound under-counts this kind of input (ModelCatalog.inputTokenBound): compare the reported "
                            + "prompt tokens with the bound in the call's summary line.",
                    provider, detail, usd(actualMicroUsd), usd(receipt.microUsd()), usd(delta));
        } else {
            moneyCounter(provider, "refunded").increment(-delta);
        }
        Settlement applied = adjust(provider, receipt.keys(), delta, providerCap, detail);
        if (applied == Settlement.METER_UNAVAILABLE) {
            if (delta > 0) {
                owe(new Debt(provider, receipt.keys(), delta, detail));
            } else {
                logger.warn("The unused {} of {}'s reservation could not be returned: the reservation stands.",
                        usd(-delta), detail);
            }
        }
        return applied;
    }

    /** What is owed and not yet counted, across providers. */
    public long owed() {
        long total = 0;
        for (AtomicLong owed : debtOwed.values()) {
            total += owed.get();
        }
        return total;
    }

    /** As {@link #tryCharge}, raising the studio's code instead of returning. */
    public void chargeOrThrow(String provider, long microUsd, String detail) {
        switch (tryCharge(provider, microUsd, detail)) {
            case ALLOWED -> {
            }
            case CAP_REACHED -> throw new ForgeException(ErrorCode.BUDGET,
                    "Live creation has reached its spending limit for now.");
            case METER_UNAVAILABLE -> throw new ForgeException(ErrorCode.PAUSED,
                    "Live creation is paused: the spend meter is unavailable.");
        }
    }

    /** Runs the adjust script; which way it moved, or that the meter was lost. */
    private Settlement adjust(String provider, List<String> keys, long delta, SpendProperties.Cap providerCap, String detail) {
        if (redis == null) {
            logger.error("Cannot settle {} ({}): SpendGuard has no Redis.", detail, usd(delta));
            return Settlement.METER_UNAVAILABLE;
        }
        String result;
        try {
            result = redis.execute(ADJUST, keys, arguments(delta, providerCap));
        } catch (RuntimeException e) {
            logger.error("Cannot settle {} ({}): SpendGuard could not reach Redis.", detail, usd(delta), e);
            return Settlement.METER_UNAVAILABLE;
        }
        if (result == null || !result.startsWith("OK|")) {
            logger.error("Cannot settle {} ({}): the adjust script answered {}.", detail, usd(delta), result);
            return Settlement.METER_UNAVAILABLE;
        }
        observeAllowedWindows(provider, result.split("\\|"));
        return delta > 0 ? Settlement.CHARGED : Settlement.REFUNDED;
    }

    private void owe(Debt debt) {
        debts.add(debt);
        debtGauge(debt.provider()).addAndGet(debt.microUsd());
        moneyCounter(debt.provider(), "debt").increment(debt.microUsd());
        logger.error("SPEND DEBT [{}] {}: {} of overrun could not be counted; no call is reserved until it is.",
                debt.provider(), debt.detail(), usd(debt.microUsd()));
    }

    /**
     * Counts every owed overrun, oldest first; false while any remains. One at a time, so two
     * reservations cannot count the same debt twice.
     */
    synchronized boolean settleDebts() {
        Debt debt;
        while ((debt = debts.peek()) != null) {
            SpendProperties.Cap providerCap = properties.provider().get(debt.provider());
            if (adjust(debt.provider(), debt.keys(), debt.microUsd(), providerCap, debt.detail()) == Settlement.METER_UNAVAILABLE) {
                return false;
            }
            debts.remove(debt);
            debtGauge(debt.provider()).addAndGet(-debt.microUsd());
            logger.warn("SPEND DEBT [{}] {}: {} counted now.", debt.provider(), debt.detail(), usd(debt.microUsd()));
        }
        return true;
    }

    /** The four windows a charge lands in: this month and today, across providers and for this one. */
    private List<String> windowKeys(String provider) {
        LocalDate today = LocalDate.now(zone);
        String month = MONTH.format(today);
        String day = DAY.format(today);
        return List.of(
                KEY_PREFIX + "m:" + month,
                KEY_PREFIX + "m:" + month + ":" + provider,
                KEY_PREFIX + "d:" + day,
                KEY_PREFIX + "d:" + day + ":" + provider);
    }

    /** Both scripts' arguments: the amount, the four ceilings, the two lifetimes. */
    private Object[] arguments(long microUsd, SpendProperties.Cap providerCap) {
        SpendProperties.Cap globalCap = properties.global();
        return new Object[]{
                Long.toString(microUsd),
                Long.toString(globalCap.monthlyMicroUsd()),
                Long.toString(providerCap.monthlyMicroUsd()),
                Long.toString(globalCap.dailyMicroUsd()),
                Long.toString(providerCap.dailyMicroUsd()),
                Long.toString(MONTH_TTL_SECONDS),
                Long.toString(DAY_TTL_SECONDS)};
    }

    private Counter chargeCounter(String provider, String outcome) {
        return chargeCounters.computeIfAbsent(provider + "|" + outcome, key ->
                Counter.builder("wexy.spend.charges")
                        .description("Attempts to claim a model call against the spend ceilings")
                        .tag("provider", provider)
                        .tag("outcome", outcome)
                        .register(meterRegistry));
    }

    /**
     * Money, in micro-USD: `spent` is what was reserved and `refunded` what came back unused, so
     * the two together are the invoice; `refused` is what the ceiling prevented, the only evidence
     * the control earns its keep; `overrun` is what calls cost beyond their reservations, and
     * `debt` the part of it the meter could not count at once; both should stay at zero.
     */
    private Counter moneyCounter(String provider, String kind) {
        return moneyCounters.computeIfAbsent(provider + "|" + kind, key ->
                Counter.builder("wexy.spend.micro.usd")
                        .description("Money claimed against the spend ceilings, in micro-USD")
                        .tag("provider", provider)
                        .tag("kind", kind)
                        .register(meterRegistry));
    }

    private AtomicLong debtGauge(String provider) {
        return debtOwed.computeIfAbsent(provider, key -> {
            AtomicLong holder = new AtomicLong();
            Gauge.builder("wexy.spend.debt.micro.usd", holder, AtomicLong::get)
                    .description("Overrun the meter has not counted yet, in micro-USD; no call is reserved while it is above zero")
                    .tag("provider", provider)
                    .register(meterRegistry);
            return holder;
        });
    }

    /**
     * OK|providerMonth|providerMonthCap|providerDay|providerDayCap|globalMonth|globalMonthCap|globalDay|globalDayCap.
     * The global day is the ceiling that bites first in development ($10 a day), so it has a gauge
     * and threshold warnings like the others (forge-loop design §4.2).
     */
    private void observeAllowedWindows(String provider, String[] parts) {
        if (parts.length < 9) {
            return;
        }
        observeWindow("provider", "month", provider, parts[1], parts[2]);
        observeWindow("provider", "day", provider, parts[3], parts[4]);
        observeWindow("global", "month", "all", parts[5], parts[6]);
        observeWindow("global", "day", "all", parts[7], parts[8]);
    }

    /** DENY|WHICH_CEILING|spent|cap */
    private void observeDeniedWindow(String provider, String[] parts) {
        if (parts.length < 4) {
            return;
        }
        switch (parts[1]) {
            case "GLOBAL_MONTH" -> observeWindow("global", "month", "all", parts[2], parts[3]);
            case "GLOBAL_DAY" -> observeWindow("global", "day", "all", parts[2], parts[3]);
            case "PROVIDER_MONTH" -> observeWindow("provider", "month", provider, parts[2], parts[3]);
            case "PROVIDER_DAY" -> observeWindow("provider", "day", provider, parts[2], parts[3]);
            default -> {
            }
        }
    }

    /** Spent and cap both, not a ratio: the cap is configuration, and a graph should show it move. */
    private void observeWindow(String scope, String window, String provider, String spentRaw, String capRaw) {
        long spent;
        long cap;
        try {
            spent = Long.parseLong(spentRaw);
            cap = Long.parseLong(capRaw);
        } catch (NumberFormatException e) {
            return;
        }

        Tags tags = Tags.of("scope", scope, "window", window, "provider", provider);
        String key = scope + "|" + window + "|" + provider;

        windowSpent.computeIfAbsent(key, k -> {
            AtomicLong holder = new AtomicLong();
            Gauge.builder("wexy.spend.window.spent.micro.usd", holder, AtomicLong::get)
                    .description("Spent so far in the current window, in micro-USD")
                    .tags(tags)
                    .register(meterRegistry);
            return holder;
        }).set(spent);

        windowCap.computeIfAbsent(key, k -> {
            AtomicLong holder = new AtomicLong();
            Gauge.builder("wexy.spend.window.cap.micro.usd", holder, AtomicLong::get)
                    .description("The ceiling for the current window, in micro-USD")
                    .tags(tags)
                    .register(meterRegistry);
            return holder;
        }).set(cap);
    }

    /** Logs once as utilisation crosses each threshold, on the call that crossed it. */
    private void warnOnThresholdCrossing(String provider, long microUsd, String[] parts) {
        if (parts.length < 9) {
            return;
        }
        reportCrossing(provider + " monthly", microUsd, parts[1], parts[2]);
        reportCrossing(provider + " daily", microUsd, parts[3], parts[4]);
        reportCrossing("GLOBAL monthly", microUsd, parts[5], parts[6]);
        reportCrossing("GLOBAL daily", microUsd, parts[7], parts[8]);
    }

    private void reportCrossing(String label, long microUsd, String afterRaw, String capRaw) {
        long after = Long.parseLong(afterRaw);
        long cap = Long.parseLong(capRaw);
        if (cap <= 0) {
            return;
        }
        long before = after - microUsd;
        for (int percent : ALERT_PERCENTS) {
            long threshold = cap * percent / 100;
            if (before < threshold && after >= threshold) {
                logger.warn("Spend alert: {} budget is {}% consumed ({} of {}).", label, percent, usd(after), usd(cap));
            }
        }
    }

    /** Micro-USD as dollars, to the micro-dollar: "$0.004600"; a negative amount keeps its sign. */
    static String usd(long microUsd) {
        return String.format("%s$%d.%06d", microUsd < 0 ? "-" : "", Math.abs(microUsd) / 1_000_000, Math.abs(microUsd % 1_000_000));
    }
}
