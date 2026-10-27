package ai.wexy.forge.spend;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.Map;

/**
 * Spend ceilings, in micro-USD (a millionth of a dollar).
 *
 * Adapted from FlareLink's BillingProperties (pre-existing work), which counted paise. Integers,
 * because they are added up with INCRBY inside a Lua script, and Redis integers are exact where a
 * float would drift. Micro-USD, because Meta prices models in dollars per million tokens, which is
 * exactly micro-USD per token: a price converts without rounding.
 *
 * Two windows stop different things: the month bounds the credit, the day bounds how fast it can
 * go (one bad night must not spend the month). Per-provider ceilings keep one runaway model from
 * starving the others.
 *
 * Changed from FlareLink: there is no "unlimited". FlareLink's caps defaulted to -1, no ceiling;
 * here every cap must be set, and the service refuses to start otherwise (SpendGuard), because a
 * missing cap must deny, never unlock (coding principles §1).
 *
 * @param zone     the day boundary; the meter rolls in this zone
 * @param global   the ceiling across every provider
 * @param provider the ceiling per provider key ({@code meta-spark}, {@code meta-wonder}, …)
 */
@ConfigurationProperties(prefix = "wexy.spend")
public record SpendProperties(String zone, Cap global, Map<String, Cap> provider) {

    public SpendProperties {
        zone = zone == null || zone.isBlank() ? "Asia/Kolkata" : zone;
        provider = provider == null ? Map.of() : Map.copyOf(provider);
    }

    /** A monthly and a daily ceiling. Null means unset, which is refused at startup. */
    public record Cap(Long monthlyMicroUsd, Long dailyMicroUsd) {
    }
}
