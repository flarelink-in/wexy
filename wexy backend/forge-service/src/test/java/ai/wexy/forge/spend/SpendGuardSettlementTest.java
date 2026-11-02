package ai.wexy.forge.spend;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The settlement (forge-loop design §11, the reviews of 2026-10-27): a call's reservation is moved
 * to what it cost, down or up, in the windows it was made in; an overrun is counted beyond the
 * ceiling because the money is spent; an overrun the meter cannot count is a debt that pauses
 * every reservation until it is.
 */
class SpendGuardSettlementTest {

    /** The tests below are about the windows; their calls run in one lane (W1), open wide. */
    private static final String LANE = SpendGuard.LANE_EARLY_ACCESS;

    private final InMemorySpendLedger ledger = new InMemorySpendLedger();
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();

    private SpendGuard guard(StringRedisTemplate redis) {
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(redis);
        return new SpendGuard(provider, new SpendProperties("Asia/Kolkata", new SpendProperties.Cap(1_000L, 1_000L),
                Map.of("meta-spark", new SpendProperties.Cap(100L, 100L)), SpendLanes.open()), registry);
    }

    private double counted(String name, String tag, String value) {
        return registry.get(name).tags("provider", "meta-spark", tag, value).counter().count();
    }

    private double dayGauge() {
        return registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "provider", "window", "day", "provider", "meta-spark")
                .gauge().value();
    }

    /** The usual case: the call cost less than its bound, and the difference goes back to the ceilings. */
    @Test
    void theUnusedPartOfAReservationIsReturned() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 100, "a call");
        assertThat(receipt.allowed()).isTrue();
        // The four windows and the lane's day (W1).
        assertThat(receipt.keys()).hasSize(5);
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "no room")).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        assertThat(guard.settle(receipt, 40, "the same call")).isEqualTo(SpendGuard.Settlement.REFUNDED);

        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(40);
        assertThat(ledger.globalTotal()).isEqualTo(40);
        assertThat(ledger.settlements()).isEqualTo(1);
        assertThat(counted("wexy.spend.micro.usd", "kind", "refunded")).isEqualTo(60.0);
        assertThat(counted("wexy.spend.charges", "outcome", "overrun")).isZero();
        assertThat(dayGauge()).isEqualTo(40);
        // The room is back: the next call fits.
        assertThat(guard.tryCharge("meta-spark", LANE, 60, "the next call")).isEqualTo(SpendGuard.Charge.ALLOWED);
    }

    /** The ceiling is already full; the overrun is counted anyway, because the money is spent. */
    @Test
    void anOverrunIsCountedBeyondTheCeiling() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 100, "a call at the cap");

        assertThat(guard.settle(receipt, 160, "the same call")).isEqualTo(SpendGuard.Settlement.CHARGED);

        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(160);
        assertThat(ledger.globalTotal()).isEqualTo(160);
        assertThat(counted("wexy.spend.charges", "outcome", "overrun")).isEqualTo(1.0);
        assertThat(counted("wexy.spend.micro.usd", "kind", "overrun")).isEqualTo(60.0);
        assertThat(dayGauge()).isEqualTo(160);
        assertThat(guard.owed()).isZero();
        // The next call sees the true total and is refused.
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "after the overrun")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
    }

    @Test
    void aCallThatCostExactlyItsReservationSettlesNothing() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 50, "a call");

        assertThat(guard.settle(receipt, 50, "exact")).isEqualTo(SpendGuard.Settlement.NONE);

        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(50);
        assertThat(ledger.settlements()).isZero();
    }

    /** A settlement moves the windows the reservation was made in, and a window never goes below zero. */
    @Test
    void aSettlementMovesTheReservationsOwnWindowsAndNeverBelowZero() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 50, "a call");
        SpendGuard.Receipt yesterday = new SpendGuard.Receipt(SpendGuard.Charge.ALLOWED, "meta-spark", LANE, 80,
                List.of("wexy:spend:m:2026-09", "wexy:spend:m:2026-09:meta-spark", "wexy:spend:d:2026-09-30", "wexy:spend:d:2026-09-30:meta-spark",
                        "wexy:spend:d:2026-09-30:lane:early"));

        assertThat(guard.settle(yesterday, 0, "a call from before the window rolled")).isEqualTo(SpendGuard.Settlement.REFUNDED);

        // Today's windows are untouched by yesterday's refund, and yesterday's floor at zero.
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(50);
        assertThat(guard.settle(receipt, 0, "a call that cost nothing")).isEqualTo(SpendGuard.Settlement.REFUNDED);
        assertThat(ledger.totalForProvider("meta-spark")).isZero();
        assertThat(ledger.globalTotal()).isZero();
    }

    /** A refund the meter cannot apply is forgone: the reservation stands, which over-counts. */
    @Test
    void aRefundThatFailsLeavesTheReservation() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 100, "a call");
        ledger.down(true);

        assertThat(guard.settle(receipt, 40, "the same call")).isEqualTo(SpendGuard.Settlement.METER_UNAVAILABLE);

        ledger.down(false);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(100);
        assertThat(guard.owed()).isZero();
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "no room")).isEqualTo(SpendGuard.Charge.CAP_REACHED);
    }

    /** An overrun the meter cannot count is owed, pauses every reservation, and is counted first when the meter is back. */
    @Test
    void anOverrunThatCannotBeCountedIsADebtThatPausesReservations() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", LANE, 50, "a call");
        ledger.down(true);

        assertThat(guard.settle(receipt, 110, "the same call")).isEqualTo(SpendGuard.Settlement.METER_UNAVAILABLE);

        assertThat(guard.owed()).isEqualTo(60);
        assertThat(counted("wexy.spend.micro.usd", "kind", "debt")).isEqualTo(60.0);
        assertThat(registry.get("wexy.spend.debt.micro.usd").tag("provider", "meta-spark").gauge().value()).isEqualTo(60);
        // While the meter is down the debt cannot be counted, so nothing is reserved.
        ledger.down(false);
        ledger.down(true);
        assertThat(guard.reserve("meta-spark", LANE, 1, "during the outage").outcome()).isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
        assertThat(counted("wexy.spend.charges", "outcome", "denied_debt")).isEqualTo(1.0);

        // The meter is back: the debt is counted first (50 + 60 = 110 > the cap), so the call is refused by the cap, honestly.
        ledger.down(false);
        assertThat(guard.reserve("meta-spark", LANE, 1, "after the outage").outcome()).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(guard.owed()).isZero();
        assertThat(registry.get("wexy.spend.debt.micro.usd").tag("provider", "meta-spark").gauge().value()).isZero();
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(110);
        assertThat(ledger.settlements()).isEqualTo(1);
    }

    /** Without a meter at all, the same: counted as owed, and nothing is reserved. */
    @Test
    void anOverrunWithoutAMeterIsOwed() {
        SpendGuard guard = guard(null);
        SpendGuard.Receipt receipt = new SpendGuard.Receipt(SpendGuard.Charge.ALLOWED, "meta-spark", LANE, 100, List.of("a", "b", "c", "d", "e"));

        assertThat(guard.settle(receipt, 160, "a call")).isEqualTo(SpendGuard.Settlement.METER_UNAVAILABLE);

        assertThat(guard.owed()).isEqualTo(60);
        assertThat(counted("wexy.spend.charges", "outcome", "overrun")).isEqualTo(1.0);
        assertThat(guard.tryCharge("meta-spark", LANE, 1, "a call")).isEqualTo(SpendGuard.Charge.METER_UNAVAILABLE);
    }

    @Test
    void onlyAnAllowedReservationCanBeSettled() {
        SpendGuard guard = guard(ledger.template());
        guard.reserve("meta-spark", LANE, 100, "fill the cap");
        SpendGuard.Receipt refused = guard.reserve("meta-spark", LANE, 1, "over the cap");
        assertThat(refused.outcome()).isEqualTo(SpendGuard.Charge.CAP_REACHED);

        assertThatThrownBy(() -> guard.settle(refused, 1, "over the cap")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> guard.settle(guard.reserve("meta-spark", LANE, 0, "free"), 1, "free")).isInstanceOf(IllegalArgumentException.class);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(100);
    }

    /** W1: a settlement moves the lane's day as it moves the rest, so a lane is charged what its calls cost. */
    @Test
    void aSettlementMovesTheLaneToo() {
        SpendGuard guard = guard(ledger.template());
        SpendGuard.Receipt receipt = guard.reserve("meta-spark", SpendGuard.LANE_ANONYMOUS, 100, "an anonymous call");
        assertThat(ledger.totalForLane(SpendGuard.LANE_ANONYMOUS)).isEqualTo(100);

        assertThat(guard.settle(receipt, 30, "the same call")).isEqualTo(SpendGuard.Settlement.REFUNDED);

        assertThat(ledger.totalForLane(SpendGuard.LANE_ANONYMOUS)).isEqualTo(30);
        assertThat(ledger.totalForLane(SpendGuard.LANE_EARLY_ACCESS)).isZero();
        assertThat(registry.get("wexy.spend.window.spent.micro.usd").tags("scope", "lane", "window", "day", "provider", SpendGuard.LANE_ANONYMOUS)
                .gauge().value()).isEqualTo(30);
    }

    @Test
    void anUnknownProviderCannotBeReserved() {
        SpendGuard guard = guard(ledger.template());
        assertThatThrownBy(() -> guard.reserve("meta-code", LANE, 100, "a call"))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.spend.provider");
        assertThat(ledger.untouched()).isTrue();
    }
}
