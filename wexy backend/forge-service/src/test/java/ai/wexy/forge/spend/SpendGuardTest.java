package ai.wexy.forge.spend;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Hermetic money tests, ported from FlareLink's SpendGuardTest (pre-existing work), plus what Wexy
 * changed: every cap required, no free charge, and a lost meter told apart from a reached cap.
 */
class SpendGuardTest {

    private static final SpendProperties.Cap HUNDRED = new SpendProperties.Cap(100L, 100L);

    private final InMemorySpendLedger ledger = new InMemorySpendLedger();

    private static SpendProperties caps(long globalMonth, long globalDay) {
        return new SpendProperties("Asia/Kolkata", new SpendProperties.Cap(globalMonth, globalDay),
                Map.of("meta-spark", HUNDRED, "meta-wonder", HUNDRED));
    }

    private static SpendGuard guard(StringRedisTemplate redis, SpendProperties properties) {
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(redis);
        return new SpendGuard(provider, properties, new SimpleMeterRegistry());
    }

    private SpendGuard guard() {
        return guard(ledger.template(), caps(1_000, 1_000));
    }

    /** The global day bites first in development ($10 a day), so an allowed charge reports it too (forge-loop §4.2). */
    @Test
    void anAllowedChargeGaugesEveryWindowTheGlobalDayIncluded() {
        // Built before stubbing: a mock made inside another mock's when() is unfinished stubbing (gotchas).
        StringRedisTemplate template = ledger.template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        SpendGuard guard = new SpendGuard(provider, caps(1_000, 500), registry);

        assertThat(guard.tryCharge("meta-spark", 40, "plan")).isEqualTo(SpendGuard.Charge.ALLOWED);

        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "global", "window", "day").gauge().value()).isEqualTo(40);
        assertThat(registry.get("wexy.spend.window.cap.micro.usd").tags("scope", "global", "window", "day").gauge().value()).isEqualTo(500);
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "global", "window", "month").gauge().value()).isEqualTo(40);
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "provider", "window", "day", "provider", "meta-spark").gauge().value()).isEqualTo(40);
    }

    @Test
    void theExactProviderCapIsAcceptedAndTheNextChargeIsDenied() {
        SpendGuard guard = guard();
        for (int i = 0; i < 10; i++) {
            assertThat(guard.tryCharge("meta-spark", 10, "plan")).isEqualTo(SpendGuard.Charge.ALLOWED);
        }

        assertThat(guard.tryCharge("meta-spark", 1, "over the cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(100);
    }

    @Test
    void exhaustingOneProviderDoesNotStarveAnother() {
        SpendGuard guard = guard();
        assertThat(guard.tryCharge("meta-spark", 100, "use Spark's allowance")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-spark", 1, "Spark over the cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        assertThat(guard.tryCharge("meta-wonder", 20, "an escalated repair")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(ledger.totalForProvider("meta-wonder")).isEqualTo(20);
    }

    @Test
    void theGlobalCapStopsProvidersEvenWhenTheirOwnCapsHaveRoom() {
        SpendGuard guard = guard(ledger.template(), caps(30, 30));

        assertThat(guard.tryCharge("meta-spark", 20, "first call")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-wonder", 20, "crosses the global cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.globalTotal()).isEqualTo(20);
        assertThat(ledger.totalForProvider("meta-wonder")).isZero();
    }

    /** A reached cap is the archive's {@code budget}; the studio switches with its label. */
    @Test
    void chargeOrThrowRaisesBudgetWhenACapIsReached() {
        SpendGuard guard = guard();
        guard.chargeOrThrow("meta-spark", 100, "fill the cap");

        assertThatThrownBy(() -> guard.chargeOrThrow("meta-spark", 1, "refused"))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.BUDGET));
    }

    /** No meter, no call: the fail-closed path, reported as paused rather than budget. */
    @Test
    void noRedisFailsClosedAsPaused() {
        SpendGuard guard = guard(null, caps(1_000, 1_000));

        assertThat(guard.tryCharge("meta-spark", 10, "must not escape unmetered"))
                .isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
        assertThatThrownBy(() -> guard.chargeOrThrow("meta-spark", 10, "refused"))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.PAUSED));
    }

    @Test
    void aRedisErrorFailsClosed() {
        SpendGuard guard = guard(InMemorySpendLedger.failing(), caps(1_000, 1_000));

        assertThat(guard.tryCharge("meta-spark", 10, "Redis timed out")).isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
    }

    /** "A billable call must never be counted as free" (FlareLink's own rule). */
    @Test
    void aFreeChargeIsABug() {
        SpendGuard guard = guard();
        assertThatThrownBy(() -> guard.tryCharge("meta-spark", 0, "free")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> guard.tryCharge("meta-spark", -5, "negative")).isInstanceOf(IllegalArgumentException.class);
        assertThat(ledger.untouched()).isTrue();
    }

    @Test
    void aProviderWithoutCeilingsIsRefused() {
        SpendGuard guard = guard();
        assertThatThrownBy(() -> guard.tryCharge("meta-code", 10, "an unconfigured provider"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("wexy.spend.provider");
        assertThat(ledger.untouched()).isTrue();
    }

    /** FlareLink's caps defaulted to -1, no ceiling; here a missing cap stops startup. */
    @Test
    void aMissingCapStopsStartup() {
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, null, Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.global");
        assertThatThrownBy(() -> guard(ledger.template(),
                new SpendProperties(null, new SpendProperties.Cap(null, 10L), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.global");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED,
                Map.of("meta-spark", new SpendProperties.Cap(100L, null)))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.provider.meta-spark");
    }

    @Test
    void aNegativeCapOrABadZoneStopsStartup() {
        assertThatThrownBy(() -> guard(ledger.template(),
                new SpendProperties(null, new SpendProperties.Cap(-1L, 10L), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("negative");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties("Mars/Olympus", HUNDRED, Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.zone");
    }

    /** A zero cap is valid: it switches a provider off. */
    @Test
    void aZeroCapSwitchesAProviderOff() {
        SpendGuard guard = guard(ledger.template(), new SpendProperties(null, HUNDRED,
                Map.of("meta-spark", new SpendProperties.Cap(0L, 0L))));

        assertThat(guard.tryCharge("meta-spark", 1, "a switched-off provider")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
    }

    @Test
    void moneyIsShownToTheMicroDollar() {
        assertThat(SpendGuard.usd(4_600)).isEqualTo("$0.004600");
        assertThat(SpendGuard.usd(150_000_000)).isEqualTo("$150.000000");
    }
}
