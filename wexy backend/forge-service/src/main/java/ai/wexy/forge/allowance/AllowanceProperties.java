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
 * @param authorCalls         a plan's author calls one prompt covers (8: the studio's most is three functions, each
 *                            retried once on an upstream error, so 6)
 * @param repairCalls         a plan's repair calls one prompt covers, siblings included (8: the studio's most is three
 *                            repairs, each retried once, so 6)
 * @param replans             plans that replace one the model failed, inside its prompt (1: the studio retries once)
 * @param accountMark         how long an anonymous account's spent mark is kept: "ever", bounded for Redis (400 days)
 * @param uidHmacHex          the uid key (WEXY_UID_HMAC_KEY): 32 bytes as 64 hex characters
 * @param uidKeyRequired      true in prod: startup stops without the uid key
 * @param reviewCalls         a model's reviews of the world on the stage one prompt covers, each carrying the prompt its
 *                            turn was granted for (6: two attempts of the candidate's Q_C, 3 reviews each; EA6.4)
 */
@ConfigurationProperties(prefix = "wexy.allowance")
public record AllowanceProperties(Integer anonymousPerAccount, Integer anonymousPerNetwork, Integer earlyAccessPerDay,
                                  Integer adminPerDay, Integer dayStartsAtHourUtc, Duration promptLife, Integer directorTurns,
                                  Integer revisions, Integer moduleCalls, Integer authorCalls, Integer repairCalls,
                                  Integer replans, Duration accountMark, String uidHmacHex, Boolean uidKeyRequired,
                                  Integer reviewCalls) {

    /** The same values, checked: every one set and in range, or startup stops. */
    public AllowanceProperties validated() {
        count("anonymous-per-account", anonymousPerAccount);
        count("anonymous-per-network", anonymousPerNetwork);
        count("early-access-per-day", earlyAccessPerDay);
        count("admin-per-day", adminPerDay);
        count("director-turns", directorTurns);
        count("revisions", revisions);
        count("module-calls", moduleCalls);
        count("author-calls", authorCalls);
        count("repair-calls", repairCalls);
        count("replans", replans);
        count("review-calls", reviewCalls);
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
