package ai.wexy.forge.models;

import ai.wexy.forge.spend.InMemorySpendLedger;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.spend.SpendLanes;
import ai.wexy.forge.spend.SpendProperties;
import ai.wexy.forge.upstream.ChatMessage;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ModelCatalogTest {

    private static final ModelProperties.Role PLANNER =
            new ModelProperties.Role("muse-spark-1.3", "meta-spark", 1500, Duration.ofSeconds(20), null, null);
    private static final ModelProperties.Price SPARK =
            new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"));

    private static SpendGuard spendGuard() {
        // Built before stubbing: creating a mock inside another mock's when() is unfinished stubbing.
        StringRedisTemplate template = new InMemorySpendLedger().template();
        @SuppressWarnings("unchecked")
        ObjectProvider<StringRedisTemplate> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(template);
        return new SpendGuard(provider, new SpendProperties(null, new SpendProperties.Cap(10L, 10L),
                Map.of("meta-spark", new SpendProperties.Cap(10L, 10L)), SpendLanes.open()), new SimpleMeterRegistry());
    }

    private static ModelCatalog catalog(Map<String, ModelProperties.Role> roles, Map<String, ModelProperties.Price> prices) {
        return new ModelCatalog(new ModelProperties(roles, prices), spendGuard());
    }

    /** $1.25 and $4.25 per million tokens are 1.25 and 4.25 micro-dollars per token. */
    @Test
    void theUpperBoundIsEveryInputTokenPlusTheWholeOutputCapRoundedUp() {
        ModelCatalog catalog = catalog(Map.of("planner", PLANNER), Map.of("muse-spark-1.3", SPARK));

        // 2,000 × 1.25 + 500 × 4.25 = 2,500 + 2,125: plan §4's "$0.0046" for a plan.
        assertThat(catalog.upperBoundMicroUsd("muse-spark-1.3", 2_000, 500)).isEqualTo(4_625);
        // 1 × 1.25 + 1 × 4.25 = 5.5, rounded up: the meter never under-counts.
        assertThat(catalog.costMicroUsd("muse-spark-1.3", 1, 1)).isEqualTo(6);
        // Never zero, so a charge can never be free.
        assertThat(catalog.costMicroUsd("muse-spark-1.3", 0, 0)).isEqualTo(1);
    }

    /** The bound is one token a byte, plus the framing: more than any byte-level tokenizer can make. */
    @Test
    void theInputBoundIsOneTokenABytePlusTheFraming() {
        long tokens = ModelCatalog.inputTokenBound(List.of(
                ChatMessage.system("abcdef"), ChatMessage.user("fn evolve(p: Particle) -> Particle {}")));

        // 64 for the request, 16 a message, 6 and 37 bytes.
        assertThat(tokens).isEqualTo(64 + 16 + 6 + 16 + 37);
    }

    /** U8: bytes, not characters, so a non-English prompt is not under-counted; the schema is input too, at twice its bytes. */
    @Test
    void theBoundCountsBytesAndTheResponseFormat() {
        // "日本の銀河" is 5 characters and 15 UTF-8 bytes: 15 tokens, not 5.
        assertThat(ModelCatalog.inputTokenBound(List.of(ChatMessage.user("日本の銀河")))).isEqualTo(64 + 16 + 15);
        long bare = ModelCatalog.inputTokenBound(List.of(ChatMessage.user("plan")));
        Map<String, Object> format = Map.of("type", "json_schema", "json_schema", Map.of("name", "x", "schema", Map.of("type", "object")));
        long withSchema = ModelCatalog.inputTokenBound(List.of(ChatMessage.user("plan")), format);
        // The compact schema is 70 to 80 bytes, reserved at two tokens a byte.
        assertThat(withSchema - bare).isBetween(140L, 160L);
    }

    /**
     * EA6.4: an image adds its own bound, which its caller sets from configuration (Meta publishes no formula); its bytes
     * are not counted as text, so a large JPEG neither inflates nor stands in for that bound.
     */
    @Test
    void anImageAddsItsBoundAndNotItsBytes() {
        long text = ModelCatalog.inputTokenBound(List.of(ChatMessage.user("look")));
        byte[] jpeg = new byte[300_000];
        long two = ModelCatalog.inputTokenBound(List.of(ChatMessage.user("look", List.of(new ChatMessage.Image(jpeg, 1500),
                new ChatMessage.Image(jpeg, 1500)))));
        assertThat(two - text).isEqualTo(3000);
    }

    /** Cached input is billed at the cached price when one is configured, else as fresh input (over-counting). */
    @Test
    void cachedInputCostsTheCachedPrice() {
        ModelCatalog priced = catalog(Map.of("planner", PLANNER),
                Map.of("muse-spark-1.3", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"), new BigDecimal("0.15"))));
        ModelCatalog unpriced = catalog(Map.of("planner", PLANNER), Map.of("muse-spark-1.3", SPARK));
        ai.wexy.forge.upstream.ChatChunk.Usage usage = new ai.wexy.forge.upstream.ChatChunk.Usage(2_000, 100, 2_100, null, 1_000L);

        // 1,000 fresh × 1.25 + 1,000 cached × 0.15 + 100 × 4.25 = 1,250 + 150 + 425.
        assertThat(priced.costMicroUsd("muse-spark-1.3", usage)).isEqualTo(1_825);
        // Without a cached price every input token is fresh: 2,500 + 425.
        assertThat(unpriced.costMicroUsd("muse-spark-1.3", usage)).isEqualTo(2_925);
        // More cached than prompt tokens would be a reporting error: clamped, never negative.
        assertThat(priced.costMicroUsd("muse-spark-1.3", new ai.wexy.forge.upstream.ChatChunk.Usage(10, 0, 10, null, 50L))).isEqualTo(2);
        assertThatThrownBy(() -> catalog(Map.of("planner", PLANNER),
                Map.of("muse-spark-1.3", new ModelProperties.Price(new BigDecimal("1.25"), new BigDecimal("4.25"), BigDecimal.ZERO))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("cached");
    }

    @Test
    void aReasoningEffortMetaDoesNotKnowStopsStartup() {
        assertThatThrownBy(() -> catalog(Map.of("planner", new ModelProperties.Role("muse-spark-1.3", "meta-spark", 1500,
                Duration.ofSeconds(20), "none", null)), Map.of("muse-spark-1.3", SPARK)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("reasoning-effort is 'none'");
        assertThat(catalog(Map.of("planner", new ModelProperties.Role("muse-spark-1.3", "meta-spark", 1500,
                Duration.ofSeconds(20), "low", "scene-draft.v1")), Map.of("muse-spark-1.3", SPARK)).role("planner").reasoningEffort())
                .isEqualTo("low");
    }

    @Test
    void anUnpricedModelStopsStartupWithTheBracketedKeyToSet() {
        assertThatThrownBy(() -> catalog(Map.of("planner", PLANNER), Map.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("muse-spark-1.3")
                .hasMessageContaining("\"[muse-spark-1.3]\"");
    }

    @Test
    void aZeroPriceAProviderWithoutCeilingsOrAMissingCapStopStartup() {
        assertThatThrownBy(() -> catalog(Map.of("planner", PLANNER), Map.of("muse-spark-1.3",
                new ModelProperties.Price(BigDecimal.ZERO, new BigDecimal("4.25")))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("positive");
        assertThatThrownBy(() -> catalog(Map.of("planner", new ModelProperties.Role("muse-spark-1.3", "meta-code",
                1500, Duration.ofSeconds(20), null, null)), Map.of("muse-spark-1.3", SPARK)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("meta-code");
        assertThatThrownBy(() -> catalog(Map.of("planner", new ModelProperties.Role("muse-spark-1.3", "meta-spark",
                null, Duration.ofSeconds(20), null, null)), Map.of("muse-spark-1.3", SPARK)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("max-output-tokens");
        assertThatThrownBy(() -> catalog(Map.of(), Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("wexy.roles");
    }

    /**
     * The binder reads dots as path separators. Unbracketed, "muse-spark-1.3" would bind as a key
     * "muse-spark-1" holding a key "3", and the role's model would have no price (gotchas).
     */
    @Test
    void dottedModelIdsBindOnlyWhenBracketed() {
        Map<String, String> source = Map.of(
                "wexy.roles.planner.model", "muse-spark-1.3",
                "wexy.prices[muse-spark-1.3].input", "1.25",
                "wexy.prices[muse-spark-1.3].output", "4.25");

        ModelProperties bound = new Binder(new MapConfigurationPropertySource(source))
                .bind("wexy", ModelProperties.class).get();

        assertThat(bound.prices()).containsKey("muse-spark-1.3");
        assertThat(bound.prices().get("muse-spark-1.3").output()).isEqualByComparingTo("4.25");
    }
}
