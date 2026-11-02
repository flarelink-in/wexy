package ai.wexy.forge.allowance;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * The prompt allowances (W1; the creations platform design §11, Q92, Q95, Q98): how many prompts each role is granted,
 * and what one prompt covers. Every value is required; the service refuses to start without one (an unset allowance
 * must deny, never unlock: I6).
 *
 * @param anonymousPerAccount prompts an anonymous account is granted, ever (1)
 * @param anonymousPerNetwork anonymous prompts one network (an IPv4 address, an IPv6 /64) is granted a day (1; Q98)
 * @param earlyAccessPerDay   prompts a signed-in caller is granted a day (1)
 * @param adminPerDay         prompts an allow-listed admin is granted a day (20)
 * @param dayStartsAtHourUtc  the hour, in UTC, a day's allowance starts (0)
 * @param promptLife          how long a granted prompt's follow-ups may name it: the generation store's TTL (2 h)
 * @param directorTurns       Director turns one prompt covers (5)
 * @param revisions           program revision turns one prompt covers (3: the frontend candidate's Q_C since Q110)
 * @param moduleCalls         module calls one prompt covers, each carrying the prompt its turn was granted for (44: two
 *                            attempts of the candidate's Q_C, 12 authors and 10 repairs)
 * @param accountMark         how long an anonymous account's spent mark is kept: "ever", bounded for Redis (400 days)
 * @param uidHmacHex          the uid key (WEXY_UID_HMAC_KEY): 32 bytes as 64 hex characters
 * @param uidKeyRequired      true in prod: startup stops without the uid key
 */
@ConfigurationProperties(prefix = "wexy.allowance")
public record AllowanceProperties(Integer anonymousPerAccount, Integer anonymousPerNetwork, Integer earlyAccessPerDay,
                                  Integer adminPerDay, Integer dayStartsAtHourUtc, Duration promptLife, Integer directorTurns,
                                  Integer revisions, Integer moduleCalls, Duration accountMark, String uidHmacHex,
                                  Boolean uidKeyRequired) {

    /** The same values, checked: every one set and in range, or startup stops. */
    public AllowanceProperties validated() {
        count("anonymous-per-account", anonymousPerAccount);
        count("anonymous-per-network", anonymousPerNetwork);
        count("early-access-per-day", earlyAccessPerDay);
        count("admin-per-day", adminPerDay);
        count("director-turns", directorTurns);
        count("revisions", revisions);
        count("module-calls", moduleCalls);
        if (dayStartsAtHourUtc == null || dayStartsAtHourUtc < 0 || dayStartsAtHourUtc > 23) {
            throw new IllegalStateException("wexy.allowance.day-starts-at-hour-utc must be set, 0 to 23.");
        }
        positive("prompt-life", promptLife);
        positive("account-mark", accountMark);
        return this;
    }

    private static void count(String name, Integer value) {
        if (value == null || value < 0) {
            throw new IllegalStateException("wexy.allowance." + name + " must be set, 0 or more. An unset allowance must deny, "
                    + "never unlock.");
        }
    }

    private static void positive(String name, Duration value) {
        if (value == null || value.isNegative() || value.isZero()) {
            throw new IllegalStateException("wexy.allowance." + name + " must be set to a positive duration.");
        }
    }
}
