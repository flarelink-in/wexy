package ai.wexy.forge.models;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Map;

/**
 * Model roles and prices, bound from configuration (backend architecture §6.1): a model is
 * swapped by configuration and a restart, never in code (R1: Muse Code may not be callable).
 *
 * A price key is a model id, and model ids contain dots ({@code muse-spark-1.3}), which Spring's
 * binder reads as path separators. Such keys must be bracketed in YAML: {@code "[muse-spark-1.3]"}
 * (gotchas; ModelCatalogTest pins it).
 *
 * @param roles  by role name: planner, author, repairer, escalator, director
 * @param prices by model id, in USD per million tokens
 */
@ConfigurationProperties(prefix = "wexy")
public record ModelProperties(Map<String, Role> roles, Map<String, Price> prices) {

    public ModelProperties {
        roles = roles == null ? Map.of() : Map.copyOf(roles);
        prices = prices == null ? Map.of() : Map.copyOf(prices);
    }

    /**
     * @param model           the model id sent to the API
     * @param provider        the spend-ceiling key this role's calls are charged to
     * @param maxOutputTokens the output cap per call, sent as {@code max_completion_tokens}. Meta bills
     *                        reasoning as output inside it (forge-loop design §4.1), so it must hold
     *                        the reasoning and the answer; it also bounds the charge
     * @param timeout         the whole call's deadline
     * @param reasoningEffort Meta's {@code reasoning_effort}: minimal, low, medium, high, xhigh or max;
     *                        null lets the model choose. Reasoning cannot be turned off
     * @param response        the schema the answer must match ({@code scene-draft.v1},
     *                        {@code edit-plan.v1}), or null when the answer is text
     */
    public record Role(String model, String provider, Integer maxOutputTokens, Duration timeout,
                       String reasoningEffort, String response) {
    }

    /**
     * USD per million tokens, which is exactly micro-USD per token.
     *
     * @param cached the price of an input token served from Meta's prompt cache (forge-loop design
     *               §4.1), or null to price cached input as fresh input, which over-counts
     */
    public record Price(BigDecimal input, BigDecimal output, BigDecimal cached) {

        /** The binder's constructor: a record with two constructors binds nothing unless one is named. */
        @ConstructorBinding
        public Price {
        }

        public Price(BigDecimal input, BigDecimal output) {
            this(input, output, null);
        }
    }
}
