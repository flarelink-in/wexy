package ai.wexy.forge.models;

import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The configured roles and prices, checked once at startup, and the money arithmetic every call
 * is reserved and settled by.
 *
 * Startup refuses a role whose model has no price, a price of zero, or a provider without spend
 * ceilings: an unpriced model would be counted as free (audit P0), and a call nobody can charge
 * must not be possible to configure (coding principles §1).
 */
@Component
public class ModelCatalog {

    /**
     * The chat framing of one message: a header with the role, separators, an end-of-message mark.
     * Llama's template spends five tokens on it; sixteen leaves room for a template this code has
     * not seen.
     */
    static final int TOKENS_PER_MESSAGE = 16;
    /**
     * The request's own framing: a beginning-of-text mark, the assistant's header, and whatever
     * short preamble the API adds on its side. Hour one's two calls bound the whole of it at
     * fifteen tokens (2026-10-27); sixty-four leaves room.
     */
    static final int TOKENS_PER_REQUEST = 64;
    /**
     * Tokens reserved per byte of a {@code response_format}: the API renders the schema into the
     * prompt in a form it does not document (hour one measured about one token per four bytes of
     * compact JSON); two per byte covers a pretty-printed rendering.
     */
    static final int TOKENS_PER_SCHEMA_BYTE = 2;
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Meta's reasoning efforts (forge-loop design §4.1); "none" is refused with a 400. */
    static final Set<String> REASONING_EFFORTS = Set.of("minimal", "low", "medium", "high", "xhigh", "max");

    private final ModelProperties models;

    public ModelCatalog(ModelProperties models, SpendGuard spendGuard) {
        this.models = models;
        if (models.roles().isEmpty()) {
            throw new IllegalStateException("No model roles configured under wexy.roles.*.");
        }
        models.roles().forEach((name, role) -> validate(name, role, spendGuard));
    }

    private void validate(String name, ModelProperties.Role role, SpendGuard spendGuard) {
        String path = "wexy.roles." + name;
        if (role.model() == null || role.model().isBlank()) {
            throw new IllegalStateException(path + ".model is not set.");
        }
        if (role.provider() == null || role.provider().isBlank()) {
            throw new IllegalStateException(path + ".provider is not set: every call must be charged somewhere.");
        }
        if (role.maxOutputTokens() == null || role.maxOutputTokens() <= 0) {
            throw new IllegalStateException(path + ".max-output-tokens must be positive: it bounds the charge.");
        }
        if (role.timeout() == null || role.timeout().isNegative() || role.timeout().isZero()) {
            throw new IllegalStateException(path + ".timeout must be positive.");
        }
        if (role.reasoningEffort() != null && !REASONING_EFFORTS.contains(role.reasoningEffort())) {
            throw new IllegalStateException(path + ".reasoning-effort is '" + role.reasoningEffort() + "'; Meta accepts "
                    + new TreeSet<>(REASONING_EFFORTS) + " (reasoning cannot be turned off), or leave it unset.");
        }
        ModelProperties.Price price = models.prices().get(role.model());
        if (price == null) {
            throw new IllegalStateException("Role '" + name + "' uses model '" + role.model() + "', which has no price "
                    + "under wexy.prices. Bracket the key in YAML (\"[" + role.model() + "]\"). An unpriced model "
                    + "would be counted as free.");
        }
        if (price.input() == null || price.output() == null
                || price.input().signum() <= 0 || price.output().signum() <= 0) {
            throw new IllegalStateException("wexy.prices[" + role.model() + "] needs a positive input and output price.");
        }
        if (price.cached() != null && price.cached().signum() <= 0) {
            throw new IllegalStateException("wexy.prices[" + role.model() + "].cached must be positive, or left unset.");
        }
        if (!spendGuard.knows(role.provider())) {
            throw new IllegalStateException("Role '" + name + "' is charged to provider '" + role.provider()
                    + "', which has no ceilings under wexy.spend.provider.*.");
        }
    }

    public ModelProperties.Role role(String name) {
        ModelProperties.Role role = models.roles().get(name);
        if (role == null) {
            throw new IllegalArgumentException("No model role '" + name + "'; configured: " + models.roles().keySet());
        }
        return role;
    }

    public Set<String> roleNames() {
        return models.roles().keySet();
    }

    /**
     * The most a call can cost: every input token the bound allows, plus every output token the
     * cap allows, rounded up. Prices are dollars per million tokens, which is micro-dollars per
     * token, so this is exact before the rounding. Never less than one micro-dollar.
     */
    public long upperBoundMicroUsd(String model, long inputTokens, long maxOutputTokens) {
        return costMicroUsd(model, inputTokens, maxOutputTokens);
    }

    /** What a call cost, from the usage the API reported, with no cached input. */
    public long costMicroUsd(String model, long inputTokens, long outputTokens) {
        return costMicroUsd(model, inputTokens, outputTokens, 0);
    }

    /**
     * What a call cost, from the usage the API reported: cached input at the cached price when one
     * is configured, else as fresh input (which over-counts, the safe side).
     */
    public long costMicroUsd(String model, ChatChunk.Usage usage) {
        return costMicroUsd(model, usage.promptTokens(), usage.completionTokens(),
                usage.cachedTokens() == null ? 0 : usage.cachedTokens());
    }

    long costMicroUsd(String model, long inputTokens, long outputTokens, long cachedTokens) {
        ModelProperties.Price price = models.prices().get(model);
        if (price == null) {
            throw new IllegalStateException("No price for model '" + model + "'.");
        }
        long cached = price.cached() == null ? 0 : Math.max(0, Math.min(cachedTokens, inputTokens));
        BigDecimal cost = price.input().multiply(BigDecimal.valueOf(inputTokens - cached))
                .add(cached == 0 ? BigDecimal.ZERO : price.cached().multiply(BigDecimal.valueOf(cached)))
                .add(price.output().multiply(BigDecimal.valueOf(outputTokens)));
        return Math.max(1L, cost.setScale(0, RoundingMode.CEILING).longValueExact());
    }

    /**
     * The most input tokens a prompt can be billed, reserved before the call. It is a bound, not an
     * estimate (forge-loop design §11, the reviews of 2026-10-27): a byte-level tokenizer, as
     * Meta's models use, makes at most one token per UTF-8 byte of text, because every token
     * stands for one or more bytes and the tokens spell the text exactly; a sentence-piece
     * tokenizer makes at most one per character plus one. So each message is reserved at its byte
     * count, plus the chat framing's tokens; the request adds its own framing; and a
     * {@code response_format} is reserved at twice its compact bytes, because the API renders the
     * schema into the prompt in an undocumented form. Hour one's two reported counts sit well
     * inside it (28 for a bound of 168; 72 for 544, with a schema), and the first live calls of
     * every template are checked against it (the per-call summary line).
     *
     * <p>The reservation is settled to the reported usage when the call ends
     * ({@code MeteredModelClient}, {@code SpendGuard.settle}), so the bound costs nothing lasting;
     * what it buys is that no call can cost more than the meter admitted. Should the API ever
     * report more than the bound, the difference is still counted, as a debt that pauses further
     * calls until it is reconciled, and logged as {@code SPEND OVERRUN}: the assumption above
     * would then be wrong, and these constants are where to raise it.
     */
    public static long inputTokenBound(List<ChatMessage> messages) {
        return inputTokenBound(messages, null);
    }

    /** As {@link #inputTokenBound(List)}, with the {@code response_format} the call sends. */
    public static long inputTokenBound(List<ChatMessage> messages, Map<String, Object> responseFormat) {
        long tokens = TOKENS_PER_REQUEST;
        for (ChatMessage message : messages) {
            tokens += message.content().getBytes(StandardCharsets.UTF_8).length + TOKENS_PER_MESSAGE;
        }
        if (responseFormat != null) {
            try {
                tokens += (long) TOKENS_PER_SCHEMA_BYTE * JSON.writeValueAsBytes(responseFormat).length;
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("A response format must serialize to be sent", e);
            }
        }
        return tokens;
    }
}
