package ai.wexy.forge.probe;

import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.models.ModelProperties;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MeteredModelClient;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Hour one with the key (plan §4): turns the model facts the plan assumes into measurements.
 *
 * 1. {@code GET /models}: do the configured ids exist, and is anything Muse Code-like listed?
 * 2. One small streamed call per configured model, through {@link MeteredModelClient}, so each is
 *    charged first like any other: time to first text, total time, whether usage arrives in the
 *    stream and on which chunk, and whether output tokens stayed within {@code max_completion_tokens}
 *    (reasoning tokens might not).
 * 3. Structured output on the planner's model: is a {@code json_schema} response format honoured?
 * 4. (B0.5, Q24) The planner's real template and {@code scene-draft.v1} under {@code strict: true}:
 *    does Meta accept the schema, and does the draft that comes back validate? Its outcome decides
 *    {@code wexy.loop.strict-schemas}.
 *
 * Four calls: three short ones and one real plan, about two cents at the listed prices. It needs
 * Redis for the meter: with the meter down every call is refused, which the report says.
 */
@Component
@ConditionalOnProperty(name = "wexy.probe.enabled", havingValue = "true")
public class HourOneProbe {

    static final int HELLO_MAX_OUTPUT_TOKENS = 256;
    private static final Duration CALL_LIMIT = Duration.ofSeconds(90);

    private static final List<ChatMessage> HELLO = List.of(
            ChatMessage.system("You are a connectivity test. Answer with one word."),
            ChatMessage.user("Reply with exactly: ok"));

    private static final List<ChatMessage> STRUCTURED = List.of(
            ChatMessage.system("Answer only with JSON."),
            ChatMessage.user("Return a JSON object with one boolean field named ok, set to true."));

    private static final Map<String, Object> RESPONSE_FORMAT = Map.of(
            "type", "json_schema",
            "json_schema", Map.of(
                    "name", "probe",
                    "strict", true,
                    "schema", Map.of(
                            "type", "object",
                            "properties", Map.of("ok", Map.of("type", "boolean")),
                            "required", List.of("ok"),
                            "additionalProperties", false)));

    private static final String DRAFT_IDEA = "a spiral galaxy, gold at the core and blue along the arms";

    private final MetaApiClient api;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final ObjectMapper json;
    private final PromptBuilder prompts;
    private final JsonSchemas schemas;

    public HourOneProbe(MetaApiClient api, MeteredModelClient models, ModelCatalog catalog, ObjectMapper json,
                        PromptBuilder prompts, JsonSchemas schemas) {
        this.api = api;
        this.models = models;
        this.catalog = catalog;
        this.json = json;
        this.prompts = prompts;
        this.schemas = schemas;
    }

    public ProbeReport run() {
        String startedAt = Instant.now().toString();
        List<String> findings = new ArrayList<>();

        if (!api.hasKey()) {
            findings.add("No API key: add WEXY_META_API_KEY to Infisical and run the probe under `infisical run --env=dev --` (docs/work/README.md).");
            return new ProbeReport(startedAt, api.baseUrl(), false, null, null, Map.of(), List.of(), List.of(),
                    findings, 1);
        }

        List<String> listed = null;
        String modelsError = null;
        try {
            listed = api.listModels().block(Duration.ofSeconds(30));
        } catch (UpstreamException e) {
            modelsError = e.describe();
            if (e.kind() == UpstreamException.Kind.AUTH) {
                findings.add("The API refused the key (HTTP " + e.status() + "). Check the key, and whether the "
                        + "credit is active. Nothing was charged.");
                return new ProbeReport(startedAt, api.baseUrl(), true, null, modelsError, Map.of(), List.of(),
                        List.of(), findings, 1);
            }
            findings.add("Listing models failed (" + e.describe() + "); trying the configured models anyway.");
        }

        // The first role that uses each configured model.
        Map<String, String> roleForModel = new LinkedHashMap<>();
        for (String role : catalog.roleNames().stream().sorted().toList()) {
            roleForModel.putIfAbsent(catalog.role(role).model(), role);
        }

        Map<String, Boolean> configured = new LinkedHashMap<>();
        List<String> codeModels = new ArrayList<>();
        if (listed != null) {
            for (String model : roleForModel.keySet()) {
                configured.put(model, listed.contains(model));
                if (!listed.contains(model)) {
                    findings.add("Configured model '" + model + "' is not listed by the API: set the real id in "
                            + "wexy.roles.* and wexy.prices.");
                }
            }
            for (String id : listed) {
                if (id.toLowerCase().contains("code")) {
                    codeModels.add(id);
                }
            }
            findings.add(codeModels.isEmpty()
                    ? "No Muse Code model is listed: Spark writes the functions (R1, Q1)."
                    : "Code models listed: " + codeModels + ". Whether they take chat completions is untested here.");
        } else {
            roleForModel.keySet().forEach(model -> configured.put(model, null));
        }

        List<ProbeReport.Call> calls = new ArrayList<>();
        for (Map.Entry<String, String> entry : roleForModel.entrySet()) {
            if (Boolean.FALSE.equals(configured.get(entry.getKey()))) {
                continue;
            }
            ProbeReport.Call call = call("hello", entry.getValue(), HELLO,
                    new MeteredModelClient.CallOptions(HELLO_MAX_OUTPUT_TOKENS, null));
            calls.add(call);
            findings.addAll(conclusions(call));
        }

        String plannerRole = catalog.roleNames().contains("planner") ? "planner" : null;
        if (plannerRole != null && !Boolean.FALSE.equals(configured.get(catalog.role(plannerRole).model()))) {
            ProbeReport.Call structured = call("structured-output", plannerRole, STRUCTURED,
                    new MeteredModelClient.CallOptions(HELLO_MAX_OUTPUT_TOKENS, RESPONSE_FORMAT));
            calls.add(structured);
            findings.add(structuredOutputFinding(structured));

            Prompt prompt = prompts.plan(DRAFT_IDEA, "cosmic", 12);
            Map<String, Object> strictDraft = Map.of("type", "json_schema", "json_schema", Map.of(
                    "name", "scene_draft_v1", "schema", schemas.schema(JsonSchemas.SCENE_DRAFT), "strict", true));
            ProbeReport.Call draft = call("strict-draft", plannerRole, prompt.messages(),
                    new MeteredModelClient.CallOptions(null, strictDraft));
            calls.add(draft);
            findings.add(strictDraftFinding(draft));
        }

        int exitCode = calls.stream().anyMatch(ProbeReport.Call::ok) ? 0 : 1;
        return new ProbeReport(startedAt, api.baseUrl(), true, listed, modelsError, configured, codeModels, calls,
                findings, exitCode);
    }

    private ProbeReport.Call call(String purpose, String roleName, List<ChatMessage> messages,
                                  MeteredModelClient.CallOptions options) {
        ModelProperties.Role role = catalog.role(roleName);
        MeteredModelClient.Metered metered = models.prepare(roleName, messages, options, "probe:" + purpose);

        long start = System.nanoTime();
        long[] firstText = {-1};
        int[] chunks = {0};
        Integer[] usageChunk = {null};
        StringBuilder text = new StringBuilder();
        String[] finish = {null};
        ChatChunk.Usage[] usage = {null};
        String error = null;
        try {
            metered.chunks().doOnNext(chunk -> {
                chunks[0]++;
                if (!chunk.text().isEmpty()) {
                    if (firstText[0] < 0) {
                        firstText[0] = System.nanoTime();
                    }
                    text.append(chunk.text());
                }
                if (chunk.finishReason() != null) {
                    finish[0] = chunk.finishReason();
                }
                if (chunk.usage() != null) {
                    usage[0] = chunk.usage();
                    usageChunk[0] = chunks[0];
                }
            }).blockLast(CALL_LIMIT);
        } catch (ForgeException e) {
            error = e.code().code() + ": " + e.getMessage();
        } catch (UpstreamException e) {
            error = e.describe();
        } catch (RuntimeException e) {
            error = e.toString();
        }
        long end = System.nanoTime();

        Long ttft = firstText[0] < 0 ? null : (firstText[0] - start) / 1_000_000;
        Long cost = usage[0] == null ? null : catalog.costMicroUsd(role.model(), usage[0]);
        Double rate = null;
        if (usage[0] != null && firstText[0] > 0 && end > firstText[0]) {
            rate = usage[0].completionTokens() / ((end - firstText[0]) / 1e9);
        }
        // A draft is kept whole: it is the first live recording, and the schema check needs all of it.
        String shown = purpose.equals("strict-draft") || text.length() <= 200 ? text.toString() : text.substring(0, 200) + "...";

        return new ProbeReport.Call(purpose, roleName, role.model(), error == null, error, metered.maxOutputTokens(),
                metered.chargedMicroUsd(), cost, ttft, (end - start) / 1_000_000, chunks[0], shown, finish[0],
                usage[0] == null ? null : usage[0].promptTokens(),
                usage[0] == null ? null : usage[0].completionTokens(),
                usage[0] == null ? null : usage[0].reasoningTokens(),
                usageChunk[0], rate);
    }

    private static List<String> conclusions(ProbeReport.Call call) {
        List<String> out = new ArrayList<>();
        String who = call.model() + " (" + call.role() + ")";
        if (!call.ok()) {
            out.add(who + " failed: " + call.error());
            if (call.error() != null && call.error().startsWith("paused")) {
                out.add("If the meter is the cause, start Redis: docker compose -f compose.local.yaml up -d redis");
            }
            return out;
        }
        out.add(who + " answered in " + call.totalMs() + " ms, first text after " + call.ttftMs() + " ms.");
        if (call.usageChunk() == null) {
            out.add(who + " reported no usage in the stream: costs must come from estimates (plan §4).");
        } else if (call.usageChunk() != call.chunks()) {
            out.add(who + " reported usage on chunk " + call.usageChunk() + " of " + call.chunks() + ", not the last.");
        }
        if (call.completionTokens() != null && call.completionTokens() > call.maxOutputTokens()) {
            out.add(who + " billed " + call.completionTokens() + " output tokens for a cap of " + call.maxOutputTokens()
                    + ": reasoning tokens escape max_completion_tokens, so the charge's upper bound under-counts (gotchas).");
        }
        if (call.reasoningTokens() != null && call.reasoningTokens() > 0) {
            out.add(who + " spent " + call.reasoningTokens() + " reasoning tokens on a one-word answer.");
        }
        if ("length".equals(call.finishReason()) && call.text().isBlank()) {
            out.add(who + " hit the output cap before writing anything: raise max-output-tokens for this role.");
        }
        return out;
    }

    /** Q24: whether the real planner call under strict mode is accepted, and whether its draft validates. */
    private String strictDraftFinding(ProbeReport.Call call) {
        if (!call.ok()) {
            return "Strict draft: the planner's call with scene-draft.v1 under strict: true failed (" + call.error()
                    + "). If Meta refused the schema (a 400), keep wexy.loop.strict-schemas false (Q24) and note why.";
        }
        if ("length".equals(call.finishReason())) {
            return "Strict draft: the model ran out of room at " + call.maxOutputTokens() + " tokens (" + call.reasoningTokens()
                    + " reasoning): raise the planner's max-output-tokens before judging the schema.";
        }
        try {
            JsonNode draft = json.readTree(call.text());
            List<String> problems = draft != null && draft.isObject() ? schemas.validate(JsonSchemas.SCENE_DRAFT, draft)
                    : List.of("not a JSON object");
            if (problems.isEmpty()) {
                return "Strict draft: honoured; a valid scene-draft.v1 came back in " + call.totalMs() + " ms ("
                        + call.promptTokens() + " tokens in, " + call.completionTokens() + " out, " + call.reasoningTokens()
                        + " reasoning): set wexy.loop.strict-schemas true (Q24).";
            }
            return "Strict draft: JSON came back, but off the schema (" + problems.get(0) + "): keep strict-schemas false "
                    + "and look at the template.";
        } catch (Exception e) {
            return "Strict draft: the reply was not JSON. Keep strict-schemas false and look at the template.";
        }
    }

    private String structuredOutputFinding(ProbeReport.Call call) {
        if (!call.ok()) {
            return "Structured output: the request failed (" + call.error() + "). If it says the response_format "
                    + "is not supported, the planner validates its JSON itself and retries once (backend §6.3).";
        }
        try {
            JsonNode node = json.readTree(call.text());
            boolean ok = node.path("ok").isBoolean();
            return ok ? "Structured output: honoured (valid JSON with the required field)."
                    : "Structured output: JSON came back, but without the required field.";
        } catch (Exception e) {
            return "Structured output: ignored (the reply was not JSON). The planner must validate and retry.";
        }
    }
}
