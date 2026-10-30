package ai.wexy.forge.paper;

import ai.wexy.forge.engine.EngineBundle;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.MetaApiClient;
import ai.wexy.forge.upstream.MeteredModelClient;
import ai.wexy.forge.upstream.UpstreamException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The paper test (the frontend's engine-aware design §13, EA2's preconditions): does Spark, given EA1's
 * knowledge of null-graph, plan worlds with the engine's real surface? Three requests, one metered call
 * each through the role {@code paper}, with the template {@code paper.v1}: its system message carries
 * the engine bundle's identity, the family index and the documents every request shares, the same bytes
 * for every call so the prompt cache serves them after the first; its user message carries the
 * request's own documents, then the request, last.
 *
 * <p>The answer must match {@code paper-action.v1} under {@code strict: true}, so the run is also the
 * design's schema probe (§6). When Meta refuses the strict call (a 4xx other than auth or rate), the
 * refusal is recorded and that request is asked once more without strict, so the planning question
 * still gets an answer. Nothing runs: the frontend's {@code dev/paper-check.mjs} checks every name in a
 * plan against the same bundle, and a person reads the plans.
 *
 * <p>About 4 to 9 cents a call at the listed prices; the charge reserves the upper bound first, like any
 * call. It needs the key and Redis, so it runs on the host, beside the service.
 */
@Component
@ConditionalOnProperty(name = "wexy.paper.enabled", havingValue = "true")
public class PaperProbe {

    private static final Logger log = LoggerFactory.getLogger(PaperProbe.class);

    static final String ROLE = "paper";
    static final String REQUESTS = "paper/requests.v1.json";
    static final String SCHEMA = "paper/paper-action.v1.json";
    /** Above the role's own deadline, which ends a call first (MeteredModelClient). */
    private static final Duration CALL_LIMIT = Duration.ofMinutes(6);

    /** One request: the sentence, quoted exactly, and the documents only it gets. */
    record Request(String id, String text, List<String> docs, String why) {
    }

    /** The requests file: the documents every request shares (the template's), and the requests in order. */
    record Requests(String version, String description, List<String> commonDocs, List<Request> requests) {
    }

    /** A call as the report keeps it, and whether Meta refused it as a request (a 4xx, not auth or rate). */
    private record Attempt(PaperReport.Call call, boolean refused) {
    }

    /** What the answer is: its kind when it is a JSON object, and where it leaves the schema. */
    private record Judged(String kind, List<String> problems, boolean fenced) {
    }

    private final MetaApiClient api;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final PromptBuilder prompts;
    private final ObjectMapper json;

    public PaperProbe(MetaApiClient api, MeteredModelClient models, ModelCatalog catalog, PromptBuilder prompts,
                      ObjectMapper json) {
        this.api = api;
        this.models = models;
        this.catalog = catalog;
        this.prompts = prompts;
        this.json = json;
    }

    public PaperReport run() {
        String startedAt = Instant.now().toString();
        String model = catalog.role(ROLE).model();
        List<String> findings = new ArrayList<>();

        EngineBundle bundle;
        try {
            bundle = EngineBundle.load(json);
        } catch (RuntimeException e) {
            findings.add("The engine bundle failed its check, so nothing was asked: " + e.getMessage());
            return new PaperReport(startedAt, api.baseUrl(), model, null, null, List.of(), findings, 1);
        }
        PaperReport.Bundle identity = new PaperReport.Bundle(bundle.engineVersion(), bundle.bundleHash(), bundle.docsSource());
        if (!api.hasKey()) {
            findings.add("No API key: run it where WEXY_META_API_KEY is set (on the host, under infisical run --env=prod --). "
                    + "Nothing was asked or charged.");
            return new PaperReport(startedAt, api.baseUrl(), model, identity, null, List.of(), findings, 1);
        }
        JsonNode schema = schema(json);
        List<String> outside = JsonSchemas.strictSubsetProblems(schema);
        if (!outside.isEmpty()) {
            findings.add(SCHEMA + " leaves Meta's strict subset, so nothing was asked: " + outside);
            return new PaperReport(startedAt, api.baseUrl(), model, identity, null, List.of(), findings, 1);
        }
        JsonSchema validator = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(schema);
        Requests requests = requests(json);

        List<PaperReport.Answer> answers = new ArrayList<>();
        String template = null;
        boolean allMatch = true;
        long cost = 0;
        long charged = 0;
        int calls = 0;
        for (Request request : requests.requests()) {
            Prompt prompt = prompts.paper(bundle.quote(request.docs()), request.text());
            template = prompt.templateId();
            Attempt strict = call(request.id(), true, prompt, schema);
            Attempt loose = strict.refused() ? call(request.id() + ":not-strict", false, prompt, schema) : null;
            PaperReport.Call answered = loose != null ? loose.call() : strict.call();
            Judged judged = judge(answered, validator);
            allMatch &= judged.kind() != null && judged.problems().isEmpty();

            List<PaperReport.Doc> docs = new ArrayList<>();
            for (String id : requests.commonDocs()) {
                EngineBundle.Doc d = bundle.doc(id);
                docs.add(new PaperReport.Doc(d.id(), d.sha256(), d.bytes(), "system"));
            }
            for (String id : request.docs()) {
                EngineBundle.Doc d = bundle.doc(id);
                docs.add(new PaperReport.Doc(d.id(), d.sha256(), d.bytes(), "user"));
            }
            answers.add(new PaperReport.Answer(request.id(), request.text(), docs, prompt.system().length(),
                    prompt.user().length(), strict.call(), loose == null ? null : loose.call(), judged.kind(), judged.problems()));
            findings.add(finding(request, strict, loose, judged));
            for (Attempt a : loose == null ? List.of(strict) : List.of(strict, loose)) {
                calls++;
                charged += a.call().chargedMicroUsd();
                cost += a.call().costMicroUsd() == null ? 0 : a.call().costMicroUsd();
            }
        }
        findings.add("In all: " + calls + " calls, " + cents(cost) + " at the listed prices (" + cents(charged)
                + " reserved before settlement). Next, in the frontend: node --import ./test/register.mjs "
                + "dev/paper-check.mjs <this report> checks every name against the same bundle.");
        String versions = template + ", " + requests.version() + ", " + schema.path("title").asText();
        return new PaperReport(startedAt, api.baseUrl(), model, identity, versions, answers, findings, allMatch ? 0 : 1);
    }

    /** The requests, in order: which documents each gets, and the sentence itself. */
    static Requests requests(ObjectMapper json) {
        try {
            return json.readValue(resource(REQUESTS), Requests.class);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + REQUESTS, e);
        }
    }

    /** {@code paper-action.v1}, sent as the response format and validated against here. */
    static JsonNode schema(ObjectMapper json) {
        try {
            return json.readTree(resource(SCHEMA));
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + SCHEMA, e);
        }
    }

    private Attempt call(String purpose, boolean strict, Prompt prompt, JsonNode schema) {
        Map<String, Object> format = Map.of("type", "json_schema", "json_schema",
                Map.of("name", "paper_action_v1", "schema", schema, "strict", strict));
        MeteredModelClient.Metered metered = models.prepare(ROLE, prompt.messages(),
                new MeteredModelClient.CallOptions(null, format), "paper:" + purpose);
        log.info("paper: asking {} ({}strict; up to {} output tokens, {} reserved)", purpose, strict ? "" : "not ",
                metered.maxOutputTokens(), cents(metered.chargedMicroUsd()));

        long start = System.nanoTime();
        long[] firstText = {-1};
        int[] chunks = {0};
        StringBuilder text = new StringBuilder();
        String[] finish = {null};
        ChatChunk.Usage[] usage = {null};
        String error = null;
        boolean refused = false;
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
                }
            }).blockLast(CALL_LIMIT);
        } catch (ForgeException e) {
            error = e.code().code() + ": " + e.getMessage();
        } catch (UpstreamException e) {
            error = e.describe();
            refused = e.kind() == UpstreamException.Kind.REJECTED;
        } catch (RuntimeException e) {
            error = e.toString();
        }
        long end = System.nanoTime();

        Long ttft = firstText[0] < 0 ? null : (firstText[0] - start) / 1_000_000;
        Long cost = usage[0] == null ? null : catalog.costMicroUsd(metered.model(), usage[0]);
        Double rate = null;
        if (usage[0] != null && firstText[0] > 0 && end > firstText[0]) {
            rate = usage[0].completionTokens() / ((end - firstText[0]) / 1e9);
        }
        PaperReport.Call call = new PaperReport.Call(purpose, strict, error == null, error, metered.maxOutputTokens(),
                metered.inputTokenBound(), metered.chargedMicroUsd(), cost, ttft, (end - start) / 1_000_000, chunks[0],
                finish[0], usage[0] == null ? null : usage[0].promptTokens(),
                usage[0] == null ? null : usage[0].completionTokens(),
                usage[0] == null ? null : usage[0].reasoningTokens(),
                usage[0] == null ? null : usage[0].cachedTokens(), rate, text.toString());
        log.info("paper: {} {} in {} ms ({} chars, finish {}, cost {})", purpose, call.ok() ? "answered" : "failed: " + error,
                call.totalMs(), text.length(), finish[0], cost == null ? "unknown" : cents(cost));
        return new Attempt(call, refused);
    }

    private Judged judge(PaperReport.Call call, JsonSchema validator) {
        if (!call.ok()) {
            return new Judged(null, List.of("no answer: " + call.error()), false);
        }
        String text = call.text().strip();
        boolean fenced = text.startsWith("```");
        if (fenced) {
            // Without strict a model may fence its JSON; the plan inside is still what was asked.
            text = text.substring(text.indexOf('\n') + 1);
            text = text.endsWith("```") ? text.substring(0, text.length() - 3) : text;
        }
        if (text.isBlank()) {
            return new Judged(null, List.of("no answer: the text is empty (finish " + call.finishReason() + ")"), fenced);
        }
        JsonNode answer;
        try {
            answer = json.readTree(text);
        } catch (IOException e) {
            return new Judged(null, List.of("not JSON"), fenced);
        }
        if (answer == null || !answer.isObject()) {
            return new Judged(null, List.of("not a JSON object"), fenced);
        }
        List<String> problems = validator.validate(answer).stream().map(ValidationMessage::getMessage).sorted().toList();
        return new Judged(answer.path("kind").isTextual() ? answer.path("kind").asText() : null, problems, fenced);
    }

    private static String finding(Request request, Attempt strict, Attempt loose, Judged judged) {
        StringBuilder f = new StringBuilder(request.id()).append(": ");
        if (loose != null) {
            f.append("Meta refused paper-action.v1 under strict (").append(strict.call().error())
                    .append("), so the schema needs changing before EA2 sends it strict; asked again without strict: ");
        }
        PaperReport.Call c = loose != null ? loose.call() : strict.call();
        if (!c.ok()) {
            return f.append("failed (").append(c.error()).append(").").toString();
        }
        if ("length".equals(c.finishReason()) || (c.text().isBlank() && c.finishReason() == null)) {
            f.append("the model ran out of room at ").append(c.maxOutputTokens()).append(" output tokens (")
                    .append(c.reasoningTokens()).append(" reasoning) before it finished: raise the paper role's max-output-tokens. ");
        }
        if (judged.kind() == null) {
            f.append("no plan came back (").append(String.join("; ", judged.problems())).append(")");
        } else if (!judged.problems().isEmpty()) {
            f.append(judged.kind()).append(", but off paper-action.v1 (").append(judged.problems().get(0))
                    .append(judged.problems().size() > 1 ? "; " + judged.problems().size() + " in all" : "").append(")");
        } else {
            f.append(judged.kind()).append(", matching paper-action.v1").append(c.strict() ? " under strict" : "")
                    .append(judged.kind().equals("propose_design_and_program") ? "" : ", not the plan asked for");
        }
        if (judged.fenced()) {
            f.append(", inside a code fence");
        }
        return f.append(", in ").append(c.totalMs()).append(" ms (").append(c.promptTokens()).append(" tokens in, ")
                .append(c.cachedTokens()).append(" cached; ").append(c.completionTokens()).append(" out, ")
                .append(c.reasoningTokens()).append(" reasoning), ")
                .append(c.costMicroUsd() == null ? "cost unknown" : cents(c.costMicroUsd())).append('.').toString();
    }

    static String cents(long microUsd) {
        return String.format(Locale.ROOT, "%.2f cents", microUsd / 10_000.0);
    }

    private static String resource(String path) {
        try {
            return new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + path, e);
        }
    }
}
