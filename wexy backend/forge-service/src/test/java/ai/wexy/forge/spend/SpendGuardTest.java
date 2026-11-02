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

    /** The tests about the four ceilings run their calls in one lane (W1), open wide. */
    private static final String LANE = SpendGuard.LANE_EARLY_ACCESS;

    private static final SpendProperties.Cap HUNDRED = new SpendProperties.Cap(100L, 100L);

    private final InMemorySpendLedger ledger = new InMemorySpendLedger();

    private static SpendProperties caps(long globalMonth, long globalDay) {
        return new SpendProperties("Asia/Kolkata", new SpendProperties.Cap(globalMonth, globalDay),
                Map.of("meta-spark", HUNDRED, "meta-wonder", HUNDRED), SpendLanes.open());
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

        assertThat(guard.tryCharge("meta-spark", LANE, 40, "plan")).isEqualTo(SpendGuard.Charge.ALLOWED);

        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "global", "window", "day").gauge().value()).isEqualTo(40);
        assertThat(registry.get("wexy.spend.window.cap.micro.usd").tags("scope", "global", "window", "day").gauge().value()).isEqualTo(500);
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "global", "window", "month").gauge().value()).isEqualTo(40);
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "provider", "window", "day", "provider", "meta-spark").gauge().value()).isEqualTo(40);
    }

    @Test
    void theExactProviderCapIsAcceptedAndTheNextChargeIsDenied() {
        SpendGuard guard = guard();
        for (int i = 0; i < 10; i++) {
            assertThat(guard.tryCharge("meta-spark", LANE, 10, "plan")).isEqualTo(SpendGuard.Charge.ALLOWED);
        }

        assertThat(guard.tryCharge("meta-spark", LANE, 1, "over the cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(100);
    }

    @Test
    void exhaustingOneProviderDoesNotStarveAnother() {
        SpendGuard guard = guard();
        assertThat(guard.tryCharge("meta-spark", LANE, 100, "use Spark's allowance")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "Spark over the cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        assertThat(guard.tryCharge("meta-wonder", LANE, 20, "an escalated repair")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(ledger.totalForProvider("meta-wonder")).isEqualTo(20);
    }

    @Test
    void theGlobalCapStopsProvidersEvenWhenTheirOwnCapsHaveRoom() {
        SpendGuard guard = guard(ledger.template(), caps(30, 30));

        assertThat(guard.tryCharge("meta-spark", LANE, 20, "first call")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-wonder", LANE, 20, "crosses the global cap")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.globalTotal()).isEqualTo(20);
        assertThat(ledger.totalForProvider("meta-wonder")).isZero();
    }

    /** A reached cap is the archive's {@code budget}; the studio switches with its label. */
    @Test
    void chargeOrThrowRaisesBudgetWhenACapIsReached() {
        SpendGuard guard = guard();
        guard.chargeOrThrow("meta-spark", LANE, 100, "fill the cap");

        assertThatThrownBy(() -> guard.chargeOrThrow("meta-spark", LANE, 1, "refused"))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.BUDGET));
    }

    /** No meter, no call: the fail-closed path, reported as paused rather than budget. */
    @Test
    void noRedisFailsClosedAsPaused() {
        SpendGuard guard = guard(null, caps(1_000, 1_000));

        assertThat(guard.tryCharge("meta-spark", LANE, 10, "must not escape unmetered"))
                .isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
        assertThatThrownBy(() -> guard.chargeOrThrow("meta-spark", LANE, 10, "refused"))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.PAUSED));
    }

    @Test
    void aRedisErrorFailsClosed() {
        SpendGuard guard = guard(InMemorySpendLedger.failing(), caps(1_000, 1_000));

        assertThat(guard.tryCharge("meta-spark", LANE, 10, "Redis timed out")).isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
    }

    /** "A billable call must never be counted as free" (FlareLink's own rule). */
    @Test
    void aFreeChargeIsABug() {
        SpendGuard guard = guard();
        assertThatThrownBy(() -> guard.tryCharge("meta-spark", LANE, 0, "free")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> guard.tryCharge("meta-spark", LANE, -5, "negative")).isInstanceOf(IllegalArgumentException.class);
        assertThat(ledger.untouched()).isTrue();
    }

    @Test
    void aProviderWithoutCeilingsIsRefused() {
        SpendGuard guard = guard();
        assertThatThrownBy(() -> guard.tryCharge("meta-code", LANE, 10, "an unconfigured provider"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("wexy.spend.provider");
        assertThat(ledger.untouched()).isTrue();
    }

    /** FlareLink's caps defaulted to -1, no ceiling; here a missing cap stops startup. */
    @Test
    void aMissingCapStopsStartup() {
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, null, Map.of(), SpendLanes.open())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.global");
        assertThatThrownBy(() -> guard(ledger.template(),
                new SpendProperties(null, new SpendProperties.Cap(null, 10L), Map.of(), SpendLanes.open())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.global");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED,
                Map.of("meta-spark", new SpendProperties.Cap(100L, null)), SpendLanes.open())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.provider.meta-spark");
    }

    @Test
    void aNegativeCapOrABadZoneStopsStartup() {
        assertThatThrownBy(() -> guard(ledger.template(),
                new SpendProperties(null, new SpendProperties.Cap(-1L, 10L), Map.of(), SpendLanes.open())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("negative");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties("Mars/Olympus", HUNDRED, Map.of(), SpendLanes.open())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.zone");
    }

    /** A zero cap is valid: it switches a provider off. */
    @Test
    void aZeroCapSwitchesAProviderOff() {
        SpendGuard guard = guard(ledger.template(), new SpendProperties(null, HUNDRED,
                Map.of("meta-spark", new SpendProperties.Cap(0L, 0L)), SpendLanes.open()));

        assertThat(guard.tryCharge("meta-spark", LANE, 1, "a switched-off provider")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
    }

    // W1 (2026-11-02; the creations platform design §11, I6, Q95): lanes inside the global day.

    private SpendGuard laned(long anonymous, long earlyAccess, long admin, SimpleMeterRegistry registry) {
        StringRedisTemplate template = ledger.template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        return new SpendGuard(provider, new SpendProperties("Asia/Kolkata", new SpendProperties.Cap(1_000L, 1_000L),
                Map.of("meta-spark", new SpendProperties.Cap(1_000L, 1_000L)), SpendLanes.of(anonymous, earlyAccess, admin)), registry);
    }

    /** PL-T12's lanes: a flood of anonymous calls spends the anonymous lane at most; early access's share and the admins' stay theirs. */
    @Test
    void aLaneAtItsCeilingDeniesItsGroupAloneWhileTheGlobalHasRoom() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        SpendGuard guard = laned(30, 500, 1_000, registry);

        for (int i = 0; i < 3; i++) {
            assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ANONYMOUS, 10, "anonymous")).isEqualTo(SpendGuard.Charge.ALLOWED);
        }
        int asked = ledger.reservations();
        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ANONYMOUS, 1, "one past the lane")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.reservations()).isEqualTo(asked + 1);
        // The refused call was counted nowhere: not in its lane, not in the global or the provider.
        assertThat(ledger.totalForLane(SpendGuard.LANE_ANONYMOUS)).isEqualTo(30);
        assertThat(ledger.globalTotal()).isEqualTo(30);

        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_EARLY_ACCESS, 400, "early access")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ADMIN, 100, "an admin")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(ledger.totalForLane(SpendGuard.LANE_EARLY_ACCESS)).isEqualTo(400);
        assertThat(ledger.globalTotal()).isEqualTo(530);
        assertThat(registry.get("wexy.spend.window.cap.micro.usd").tags("scope", "lane", "window", "day", "provider", SpendGuard.LANE_ANONYMOUS)
                .gauge().value()).isEqualTo(30);
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "lane", "window", "day", "provider", SpendGuard.LANE_EARLY_ACCESS)
                .gauge().value()).isEqualTo(400);
    }

    /** No lane passes the global: a lane with room is still refused by the global day. */
    @Test
    void theGlobalStillBindsALaneWithRoom() {
        SpendGuard guard = laned(SpendLanes.WIDE, SpendLanes.WIDE, SpendLanes.WIDE, new SimpleMeterRegistry());

        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ADMIN, 1_000, "the global day")).isEqualTo(SpendGuard.Charge.ALLOWED);
        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ANONYMOUS, 1, "past the global")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(ledger.totalForLane(SpendGuard.LANE_ANONYMOUS)).isZero();
    }

    /** A zero lane closes its group, and only it. */
    @Test
    void aZeroLaneClosesItsGroup() {
        SpendGuard guard = laned(0, 500, 500, new SimpleMeterRegistry());

        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_ANONYMOUS, 1, "a closed lane")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(guard.tryCharge("meta-spark", SpendGuard.LANE_EARLY_ACCESS, 1, "an open one")).isEqualTo(SpendGuard.Charge.ALLOWED);
    }

    /** I6: a call names its lane; none, or one that is not configured, is a bug, refused before the meter is asked. */
    @Test
    void aCallWithoutAConfiguredLaneIsRefused() {
        SpendGuard guard = guard();

        assertThatThrownBy(() -> guard.tryCharge("meta-spark", null, 10, "no lane")).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("wexy.spend.lane");
        assertThatThrownBy(() -> guard.tryCharge("meta-spark", "judges", 10, "an unknown lane")).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("No lane 'judges'");
        assertThat(ledger.untouched()).isTrue();
        assertThat(ledger.reservations()).isZero();
    }

    /** Every lane is required: a missing, mistyped or negative one stops startup, so a lane can never be unlimited by omission. */
    @Test
    void aMissingMistypedOrNegativeLaneStopsStartup() {
        Map<String, SpendProperties.Lane> missing = Map.of(SpendGuard.LANE_ANONYMOUS, new SpendProperties.Lane(10L),
                SpendGuard.LANE_ADMIN, new SpendProperties.Lane(10L));
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED, Map.of(), missing)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.lane.early");
        Map<String, SpendProperties.Lane> unset = Map.of(SpendGuard.LANE_ANONYMOUS, new SpendProperties.Lane(null),
                SpendGuard.LANE_EARLY_ACCESS, new SpendProperties.Lane(10L), SpendGuard.LANE_ADMIN, new SpendProperties.Lane(10L));
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED, Map.of(), unset)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.lane.anonymous");
        Map<String, SpendProperties.Lane> mistyped = new java.util.HashMap<>(SpendLanes.open());
        mistyped.put("early_access", new SpendProperties.Lane(10L));
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED, Map.of(), mistyped)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.lane.early_access is not a lane");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED, Map.of(), SpendLanes.of(-1, 10, 10))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("negative");
        assertThatThrownBy(() -> guard(ledger.template(), new SpendProperties(null, HUNDRED, Map.of(), null)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.lane.anonymous");
    }

    @Test
    void moneyIsShownToTheMicroDollar() {
        assertThat(SpendGuard.usd(4_600)).isEqualTo("$0.004600");
        assertThat(SpendGuard.usd(150_000_000)).isEqualTo("$150.000000");
    }
}
