package ai.wexy.forge.upstream;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.FakeMetaApi;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

/**
 * The one door to a model. The test that matters most (coding principles §13): a refused charge
 * sends zero requests upstream. Since the reviews of 2026-10-27: the meter's answer, or its
 * failure, reaches the listener even after a cancel; a call is settled to its usage exactly once.
 */
class MeteredModelClientTest {

    private static final List<ChatMessage> HELLO = List.of(ChatMessage.user("say ok"));
    private static final String STOP = "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";

    private final FakeMetaApi fake = new FakeMetaApi();
    private final InMemorySpendLedger ledger = new InMemorySpendLedger();

    @AfterEach
    void stop() {
        fake.close();
    }

    private MeteredModelClient client(String key, StringRedisTemplate redis, long providerDailyCap, Duration roleTimeout) {
        return client(key, redis, providerDailyCap, roleTimeout, UnaryOperator.identity());
    }

    private MeteredModelClient client(String key, StringRedisTemplate redis, long providerDailyCap, Duration roleTimeout,
                                      UnaryOperator<SpendGuard> wrap) {
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(redis);
        SpendGuard guard = new SpendGuard(provider, new SpendProperties(null,
                new SpendProperties.Cap(1_000_000L, 1_000_000L),
                Map.of("meta-spark", new SpendProperties.Cap(1_000_000L, providerDailyCap))), new SimpleMeterRegistry());
        ModelCatalog catalog = new ModelCatalog(new ModelProperties(
                Map.of("planner", new ModelProperties.Role("m-1", "meta-spark", 100, roleTimeout, null, null)),
                Map.of("m-1", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25")))), guard);
        MetaApiClient api = new MetaApiClient(new MetaApiProperties(fake.baseUrl(), key, Duration.ofSeconds(2),
                Duration.ofSeconds(2)), new ObjectMapper(), WebClient.builder());
        return new MeteredModelClient(api, catalog, wrap.apply(guard));
    }

    private MeteredModelClient client() {
        return client("test-key", ledger.template(), 1_000_000L, Duration.ofSeconds(5));
    }

    private static void await(Duration atMost, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + atMost.toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
            Thread.sleep(25);
        }
    }

    private static String usage(long promptTokens, long completionTokens) {
        return "{\"choices\":[],\"usage\":{\"prompt_tokens\":" + promptTokens + ",\"completion_tokens\":" + completionTokens
                + ",\"total_tokens\":" + (promptTokens + completionTokens) + "}}";
    }

    @Test
    void anAllowedCallIsReservedAtItsBoundThenStreamsThenSettlesToItsCost() throws Exception {
        MeteredModelClient.Metered metered = client().prepare("planner", HELLO,
                MeteredModelClient.CallOptions.defaults(), "test");

        String text = metered.chunks().map(ChatChunk::text).collect(Collectors.joining()).block(Duration.ofSeconds(10));

        assertThat(text).isEqualTo("ok");
        assertThat(fake.chatRequests()).isEqualTo(1);
        // The whole output cap and the whole input bound are reserved, not the tokens used.
        long bound = ModelCatalogBound.of(ModelCatalog.inputTokenBound(HELLO), 100);
        assertThat(metered.chargedMicroUsd()).isEqualTo(bound);
        assertThat(metered.inputTokenBound()).isEqualTo(ModelCatalog.inputTokenBound(HELLO));
        // The fake reported 21 prompt and 2 completion tokens: the ledger settles to that.
        long cost = ModelCatalogBound.of(21, 2);
        assertThat(cost).isLessThan(bound);
        await(Duration.ofSeconds(3), () -> ledger.totalForProvider("meta-spark") == cost);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(cost);
        assertThat(ledger.settlements()).isEqualTo(1);
    }

    @Test
    void aReachedCapSendsZeroRequestsUpstream() {
        MeteredModelClient client = client("test-key", ledger.template(), 10L, Duration.ofSeconds(5));

        assertThatThrownBy(() -> client.stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.BUDGET));
        assertThat(fake.chatRequests()).isZero();
    }

    /** charge() answers before any stream starts, so an endpoint can refuse with an envelope (forge-loop §7). */
    @Test
    void chargeRefusesBeforeAnyStreamAndAPaidCallIsNotChargedAgain() throws Exception {
        MeteredModelClient capped = client("test-key", ledger.template(), 10L, Duration.ofSeconds(5));
        assertThatThrownBy(() -> capped.charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .block(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.BUDGET));
        assertThat(fake.chatRequests()).isZero();

        MeteredModelClient.Metered paid = client().charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .block(Duration.ofSeconds(10));
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(paid.chargedMicroUsd());
        int reservations = ledger.reservations();
        assertThat(fake.chatRequests()).isZero();
        assertThat(paid.chunks().map(ChatChunk::text).collect(Collectors.joining()).block(Duration.ofSeconds(10))).isEqualTo("ok");
        assertThat(fake.chatRequests()).isEqualTo(1);
        // Streaming reserves nothing more; it only settles what was reserved.
        assertThat(ledger.reservations()).isEqualTo(reservations);
        await(Duration.ofSeconds(3), () -> ledger.settlements() == 1);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(ModelCatalogBound.of(21, 2));
    }

    /** The listener hears exactly what the meter decided, once, with the bound either way. */
    @Test
    void theListenerHearsTheMetersAnswerOnce() {
        List<MeteredModelClient.Reservation> heard = new CopyOnWriteArrayList<>();
        MeteredModelClient.Metered paid = client().charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test", heard::add)
                .block(Duration.ofSeconds(10));

        assertThat(heard).hasSize(1);
        assertThat(heard.get(0).allowed()).isTrue();
        assertThat(heard.get(0).microUsd()).isEqualTo(paid.chargedMicroUsd());
        assertThat(heard.get(0).inputTokens()).isEqualTo(ModelCatalog.inputTokenBound(HELLO));

        List<MeteredModelClient.Reservation> refused = new CopyOnWriteArrayList<>();
        MeteredModelClient capped = client("test-key", ledger.template(), 10L, Duration.ofSeconds(5));
        assertThatThrownBy(() -> capped.charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test", refused::add)
                .block(Duration.ofSeconds(10))).isInstanceOf(ForgeException.class);
        assertThat(refused).hasSize(1);
        assertThat(refused.get(0).outcome()).isEqualTo(SpendGuard.Charge.CAP_REACHED);
        assertThat(refused.get(0).microUsd()).isEqualTo(paid.chargedMicroUsd());
        assertThat(fake.chatRequests()).isZero();
    }

    /** A cancel cannot undo an increment in Redis: the listener still learns the call reserved money. */
    @Test
    void aCancelWhileTheMeterDecidesStillReachesTheListener() throws Exception {
        List<MeteredModelClient.Reservation> heard = new CopyOnWriteArrayList<>();
        MeteredModelClient slow = client("test-key", ledger.template(800), 1_000_000L, Duration.ofSeconds(5));

        Disposable subscription = slow.charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test", heard::add)
                .subscribe(metered -> {
                }, error -> {
                });
        Thread.sleep(150);
        subscription.dispose();

        await(Duration.ofSeconds(3), () -> !heard.isEmpty());
        assertThat(heard).hasSize(1);
        assertThat(heard.get(0).allowed()).isTrue();
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(heard.get(0).microUsd());
        assertThat(fake.chatRequests()).isZero();
    }

    /** The meter's own failure after a cancel reaches the listener too (the second review of 2026-10-27). */
    @Test
    void aMeterThatFailsAfterACancelStillTellsTheListener() throws Exception {
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        List<MeteredModelClient.Reservation> heard = new CopyOnWriteArrayList<>();
        MeteredModelClient.ChargeListener listener = new MeteredModelClient.ChargeListener() {
            @Override
            public void charged(MeteredModelClient.Reservation reservation) {
                heard.add(reservation);
            }

            @Override
            public void failed(Throwable error) {
                failures.add(error);
            }
        };
        MeteredModelClient broken = client("test-key", ledger.template(), 1_000_000L, Duration.ofSeconds(5), guard -> {
            SpendGuard spied = spy(guard);
            doAnswer(invocation -> {
                Thread.sleep(600);
                throw new IllegalStateException("the meter's own bug");
            }).when(spied).reserve(anyString(), anyLong(), anyString());
            return spied;
        });

        Disposable subscription = broken.charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test", listener)
                .subscribe(metered -> {
                }, error -> {
                });
        Thread.sleep(150);
        subscription.dispose();

        await(Duration.ofSeconds(3), () -> !failures.isEmpty());
        assertThat(failures).hasSize(1);
        assertThat(failures.get(0)).isInstanceOf(IllegalStateException.class);
        assertThat(heard).isEmpty();
        assertThat(ledger.untouched()).isTrue();
        assertThat(fake.chatRequests()).isZero();
    }

    /** A listener that throws is a bug in the caller, not a refund: the reservation and the call stand. */
    @Test
    void aListenerThatThrowsDoesNotUnchargeTheCall() {
        MeteredModelClient.Metered paid = client().charge("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test",
                reservation -> {
                    throw new IllegalStateException("a broken listener");
                }).block(Duration.ofSeconds(10));

        assertThat(paid).isNotNull();
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(paid.chargedMicroUsd());
    }

    /** The final chunk says the call cost more than its bound: the difference is counted, apart from the stream. */
    @Test
    void anOverrunOnTheFinalChunkIsSettled() throws Exception {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("ok"), STOP, usage(5000, 100), "[DONE]");
        MeteredModelClient.Metered metered = client().prepare("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test");

        metered.chunks().blockLast(Duration.ofSeconds(10));

        long cost = ModelCatalogBound.of(5000, 100);
        assertThat(cost).isGreaterThan(metered.chargedMicroUsd());
        await(Duration.ofSeconds(3), () -> ledger.settlements() == 1);
        assertThat(ledger.settlements()).isEqualTo(1);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(cost);
    }

    /** A usage chunk sent twice settles once; a cumulative one settles at its last value (the second review). */
    @Test
    void aRepeatedOrCumulativeUsageIsSettledOnceAtItsLastValue() throws Exception {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("ok"), STOP, usage(21, 2), usage(21, 2), "[DONE]");
        client().stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test").blockLast(Duration.ofSeconds(10));
        await(Duration.ofSeconds(3), () -> ledger.settlements() == 1);
        Thread.sleep(200);
        assertThat(ledger.settlements()).isEqualTo(1);
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(ModelCatalogBound.of(21, 2));

        InMemorySpendLedger cumulative = new InMemorySpendLedger();
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("ok"), usage(21, 1), FakeMetaApi.textChunk("!"), STOP, usage(21, 2), "[DONE]");
        client("test-key", cumulative.template(), 1_000_000L, Duration.ofSeconds(5))
                .stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test").blockLast(Duration.ofSeconds(10));
        await(Duration.ofSeconds(3), () -> cumulative.settlements() == 1);
        Thread.sleep(200);
        assertThat(cumulative.settlements()).isEqualTo(1);
        assertThat(cumulative.totalForProvider("meta-spark")).isEqualTo(ModelCatalogBound.of(21, 2));
    }

    /** A stream that ends without usage keeps its reservation: the safe side. */
    @Test
    void aStreamWithoutUsageKeepsItsReservation() throws Exception {
        fake.chat = FakeMetaApi.sse(0, FakeMetaApi.textChunk("ok"), STOP, "[DONE]");
        MeteredModelClient.Metered metered = client().prepare("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test");

        metered.chunks().blockLast(Duration.ofSeconds(10));

        Thread.sleep(300);
        assertThat(ledger.settlements()).isZero();
        assertThat(ledger.totalForProvider("meta-spark")).isEqualTo(metered.chargedMicroUsd());
    }

    @Test
    void aLostMeterSendsZeroRequestsUpstream() {
        MeteredModelClient client = client("test-key", InMemorySpendLedger.failing(), 1_000_000L, Duration.ofSeconds(5));

        assertThatThrownBy(() -> client.stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.PAUSED));
        assertThat(fake.chatRequests()).isZero();
    }

    @Test
    void noKeyMeansPausedAndNothingIsCharged() {
        MeteredModelClient client = client("", ledger.template(), 1_000_000L, Duration.ofSeconds(5));

        assertThatThrownBy(() -> client.stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.PAUSED));
        assertThat(ledger.untouched()).isTrue();
        assertThat(fake.chatRequests()).isZero();
    }

    /** Assembling a call costs nothing; only subscribing charges and calls. */
    @Test
    void nothingIsChargedUntilTheStreamIsSubscribed() {
        Flux<ChatChunk> stream = client().stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test");

        assertThat(ledger.untouched()).isTrue();
        assertThat(fake.chatRequests()).isZero();
        stream.blockLast(Duration.ofSeconds(10));
        assertThat(fake.chatRequests()).isEqualTo(1);
    }

    @Test
    void aCallerCannotRaiseTheRolesOutputCap() throws Exception {
        MeteredModelClient.Metered metered = client().prepare("planner", HELLO,
                new MeteredModelClient.CallOptions(10_000, null), "test");
        metered.chunks().blockLast(Duration.ofSeconds(10));

        assertThat(metered.maxOutputTokens()).isEqualTo(100);
        assertThat(new ObjectMapper().readTree(fake.requests().get(0).body()).path("max_completion_tokens").asInt()).isEqualTo(100);
    }

    /** Each event arrives inside the idle timeout, yet the whole call still ends at the role's deadline. */
    @Test
    void theRoleDeadlineCoversTheWholeStream() {
        String[] trickle = new String[30];
        java.util.Arrays.fill(trickle, FakeMetaApi.textChunk("x"));
        fake.chat = FakeMetaApi.sse(200, trickle);
        MeteredModelClient client = client("test-key", ledger.template(), 1_000_000L, Duration.ofMillis(1_000));

        long started = System.nanoTime();
        assertThatThrownBy(() -> client.stream("planner", HELLO, MeteredModelClient.CallOptions.defaults(), "test")
                .blockLast(Duration.ofSeconds(10)))
                .isInstanceOfSatisfying(UpstreamException.class,
                        e -> assertThat(e.kind()).isEqualTo(UpstreamException.Kind.TIMEOUT));
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(3_000));
    }

    /** The bound the catalog would compute for m-1 at $1.25 / $4.25 per million tokens. */
    private static final class ModelCatalogBound {
        static long of(long inputTokens, long outputTokens) {
            return new BigDecimal("1.25").multiply(BigDecimal.valueOf(inputTokens))
                    .add(new BigDecimal("4.25").multiply(BigDecimal.valueOf(outputTokens)))
                    .setScale(0, java.math.RoundingMode.CEILING).longValueExact();
        }
    }
}
