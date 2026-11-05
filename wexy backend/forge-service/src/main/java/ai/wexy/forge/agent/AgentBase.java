package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.schemas.JsonSchemas;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A program revision's base (the frontend's candidate-loop design §8; Q82 (a), decided 2026-11-01; EA4.4): the design
 * and the program a turn handed off, which the browser then refused (its resolver, its checks on X, its interfaces), and
 * what it found. {@code POST /v1/agent/turn} takes it beside R's three fields; the turn's first call asks for a revise
 * of that program, and its design stays as given.
 *
 * <p>Nothing in it is taken on the browser's word. It is checked here, before any record or charge: its keys, exactly;
 * its size, so a revision's first prompt fits the turn's prompt bytes beside the template; the versions the browser
 * built it under, which must be this server's; the design and the program against {@code agent-action.v3}, as a revise
 * carries them; the program through the host's own check, which it must pass as a hand-off does (a base no turn could
 * have handed off is refused, not revised); and the findings, 1 to 32 of a closed shape, each capped. The findings are
 * the browser's words about its own checks, which this server cannot run (only the browser has X): data, quoted to the
 * model as data. Ownership is not asked: a base is a program this server judges again, and the revision is a turn like
 * any other, under the caller's own buckets and caps.
 *
 * <p>W1 (2026-11-02; the creations platform design §10, §11): a base may name the turn it revises, {@code turnId}, as
 * that turn's meta gave it. Only its shape is checked here; whether the caller has that turn, and its prompt a revision
 * left, is the allowance's to judge. A base without it, or naming a turn the caller does not have, spends a new prompt.
 *
 * <p>EA9.4 (2026-11-04; the frontend's agent-first studio design §12, the user: "build screening now"): a base's words
 * are a caller's to write, whatever they are called. A creator's "Improve it" rides as a finding ({@code code: "creator"}),
 * a model's review issue as another, and a client may send any finding under any code, or any design it likes back,
 * or a program whose ids and names say anything a valid identifier can (the EA9.4 reviews). {@link #creatorWords()} and
 * {@link #worldWords()} name them all, and content safety screens them before a grant is joined or a model called
 * ({@code PromptAdmission.revision}). A config is quoted to the model as the canonical text of the tree that was checked
 * and screened, never as the caller sent it (the second EA9.4 review, its high: a key named twice hid its first value).
 *
 * @param turnId the turn this one revises, or null when the base names none
 */
public record AgentBase(String turnId, JsonNode design, JsonNode program, List<BaseFinding> findings) {

    /** A base's keys: no other is taken. */
    static final List<String> FIELDS = List.of("versions", "design", "program", "findings");
    /** The key a base may add (W1): the turn it revises. */
    static final String TURN_ID = "turnId";
    /** The pins a base names, in the order a mismatch is told: the action contract, the engine bundle, the adapter manifest. */
    static final List<String> VERSION_KEYS = List.of("actionSchema", "bundle", "manifest");
    /**
     * The whole base as JSON, in UTF-8. The agent template's system message is about 60 KB and the turn's prompt bytes
     * 192 KiB, so a revision's first call always fits, with room left for its reads and answers.
     */
    static final int MAX_BASE_BYTES = 65_536;
    /**
     * What a hand-off leaves of {@link #MAX_BASE_BYTES} for the rest of its revision's base: the pins, the base's own keys
     * and at least one finding (the browser cuts its findings to what is left). The loop holds every hand-off's design and
     * program to the remainder (the EA4.4 review), so no world the server hands off is too large to revise.
     */
    static final int RESERVE_BYTES = 2_048;
    static final int MAX_FINDINGS = 32;
    static final int ID_CHARS = 64;
    static final int CODE_CHARS = 40;
    static final int PATH_CHARS = 200;
    static final int MESSAGE_CHARS = 400;
    static final List<String> FINDING_KEYS = List.of("id", "code", "path", "message");

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One finding the revision answers: its id in the browser's evidence, its code, its JSON pointer or none, its message. */
    public record BaseFinding(String id, String code, String path, String message) {
    }

    /** What a base's versions must name: this server's action contract, engine bundle and adapter manifest. */
    static Map<String, String> pins(String bundleHash) {
        return Map.of("actionSchema", JsonSchemas.AGENT_ACTION, "bundle", bundleHash, "manifest", AdapterManifest.HASH);
    }

    /** The base, checked whole; a 400 or a 413 that says what is wrong, never anything recorded or charged. */
    static AgentBase validated(JsonNode base, String bundleHash, JsonSchemas schemas, ProgramCheck check) {
        if (!base.isObject()) {
            throw ModuleRequest.bad("base is a revision's versions, design, program and findings, an object; a first turn leaves it out.");
        }
        if (ModuleRequest.utf8(base.toString()) > MAX_BASE_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "base is at most " + MAX_BASE_BYTES + " bytes as JSON.");
        }
        ModuleRequest.exactly(base, FIELDS, List.of(TURN_ID), "base");
        String turnId = null;
        if (base.has(TURN_ID)) {
            JsonNode id = base.path(TURN_ID);
            if (!id.isTextual() || !ModuleRequest.ULID.matcher(id.asText()).matches()) {
                throw ModuleRequest.bad("base.turnId is the turn this one revises, a ULID as its meta named it, not " + ModuleRequest.shown(id) + ".");
            }
            turnId = id.asText();
        }

        // The versions first: a browser built for another contract is told so before anything else is judged.
        JsonNode versions = base.path("versions");
        ModuleRequest.exactly(versions, VERSION_KEYS, "base.versions");
        Map<String, String> pinned = pins(bundleHash);
        for (String key : VERSION_KEYS) {
            if (!pinned.get(key).equals(versions.path(key).asText(null))) {
                throw ModuleRequest.bad("base.versions." + key + " is " + ModuleRequest.shown(versions.path(key)) + "; this server speaks "
                        + pinned.get(key) + ".");
            }
        }

        // S and W as a revise carries them: the action schema itself judges both, then the host's check judges the program.
        JsonNode design = base.path("design");
        JsonNode program = base.path("program");
        if (!design.isObject() || !program.isObject()) {
            throw ModuleRequest.bad("base.design and base.program are the turn's design and program, each an object.");
        }
        ObjectNode action = JSON.createObjectNode().put("kind", "revise").putNull("context");
        action.set("design", design);
        action.set("program", program);
        action.putNull("modules").putNull("revision").putNull("question").putNull("finish");
        List<String> problems = schemas.validate(JsonSchemas.AGENT_ACTION, action);
        if (!problems.isEmpty()) {
            throw ModuleRequest.bad("base does not fit " + JsonSchemas.AGENT_ACTION + ": " + ModuleRequest.clip(problems.get(0)));
        }
        List<Finding> failing = check.check(action).stream().filter(Finding::fails).toList();
        if (!failing.isEmpty()) {
            Finding f = failing.get(0);
            throw ModuleRequest.bad("base.program does not pass the host's check, so no turn could have handed it off: " + f.code() + " at "
                    + f.path() + ": " + ModuleRequest.clip(f.message()));
        }
        return new AgentBase(turnId, design.deepCopy(), canonical(program), findings(base.path("findings")));
    }

    /**
     * The program with each node's config as the canonical text of its tree: what the host's check judged and content
     * safety screens is what the model reads, with no escape, spacing or repeated key between them.
     */
    private static JsonNode canonical(JsonNode program) {
        JsonNode copy = program.deepCopy();
        for (JsonNode node : copy.path("nodes")) {
            JsonNode config = config(node.path("config"));
            if (config != null && node.isObject()) {
                ((ObjectNode) node).put("config", config.toString());
            }
        }
        return copy;
    }

    /**
     * The creator's words, one a line, for content safety (EA9.4): each finding's id, code, path and message, whatever
     * its code (never only {@code creator}: a renamed finding is screened the same). Screened first, and refused in the
     * creator's terms (PromptAdmission.revision).
     */
    public List<String> creatorWords() {
        List<String> out = new ArrayList<>();
        for (BaseFinding f : findings) {
            out.add(f.id());
            out.add(f.code());
            if (f.path() != null) {
                out.add(f.path());
            }
            out.add(f.message());
        }
        out.removeIf(String::isBlank);
        return List.copyOf(out);
    }

    /**
     * The world's words, one a line, for content safety (EA9.4 and its reviews): every string the design holds, then
     * each node's id and every key and string its config holds. A closed shape is not a closed vocabulary: an id is any
     * lower-case identifier of up to 40 characters, a module or an entry any name, and the revision's prompt quotes them
     * all. Screening reads each joined identifier spelled out too (PromptAdmission.spelledOut). A client may send any
     * design or program back, so they are screened as a creator's words are, and refused as a world that cannot be
     * changed, since rephrasing an "Improve it" would not help.
     */
    public List<String> worldWords() {
        List<String> out = new ArrayList<>();
        strings(design, out);
        for (JsonNode node : program.path("nodes")) {
            out.add(node.path("id").asText(""));
            JsonNode config = config(node.path("config"));
            if (config == null) {
                out.add(node.path("config").asText(""));
            } else {
                configStrings(config, out);
            }
        }
        out.removeIf(String::isBlank);
        return List.copyOf(out);
    }

    /** All of the base's words: the creator's, then the world's. */
    public List<String> words() {
        List<String> out = new ArrayList<>(creatorWords());
        out.addAll(worldWords());
        return List.copyOf(out);
    }

    /**
     * Config text read as NodeCheck reads it: a key twice is no config, nor is text after the value (the second EA9.4
     * review, its high).
     */
    private static final ObjectMapper CONFIG = com.fasterxml.jackson.databind.json.JsonMapper.builder()
            .enable(com.fasterxml.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    /** A node's config as JSON (the schema holds it as JSON text), or null when it is not JSON: then its text is screened. */
    private static JsonNode config(JsonNode text) {
        if (!text.isTextual()) {
            return text.isContainerNode() ? text : null;
        }
        try {
            return CONFIG.readTree(text.asText());
        } catch (Exception e) {
            return null;
        }
    }

    /** Every key and string value under a config, in document order. */
    private static void configStrings(JsonNode node, List<String> out) {
        if (node.isTextual()) {
            out.add(node.asText());
        } else if (node.isObject()) {
            node.fields().forEachRemaining(e -> {
                out.add(e.getKey());
                configStrings(e.getValue(), out);
            });
        } else if (node.isArray()) {
            node.forEach(child -> configStrings(child, out));
        }
    }

    /** Every string value under `node`, in document order; an object's keys are the schema's, never the caller's. */
    private static void strings(JsonNode node, List<String> out) {
        if (node.isTextual()) {
            if (!node.asText().isBlank()) {
                out.add(node.asText());
            }
        } else if (node.isContainerNode()) {
            node.forEach(child -> strings(child, out));
        }
    }

    /** The browser's findings: 1 to 32, each exactly an id, a code, a path or null, and a message, each within its cap. */
    private static List<BaseFinding> findings(JsonNode list) {
        if (!list.isArray() || list.isEmpty() || list.size() > MAX_FINDINGS) {
            throw ModuleRequest.bad("base.findings is 1 to " + MAX_FINDINGS + " findings: a revision answers what the browser found.");
        }
        List<BaseFinding> out = new ArrayList<>();
        for (JsonNode f : list) {
            ModuleRequest.exactly(f, FINDING_KEYS, "a finding of base.findings");
            String id = text(f, "id", ID_CHARS);
            String code = text(f, "code", CODE_CHARS);
            String message = text(f, "message", MESSAGE_CHARS);
            JsonNode path = f.path("path");
            if (id == null || code == null || message == null || !(path.isNull() || (path.isTextual() && path.asText().length() <= PATH_CHARS))) {
                throw ModuleRequest.bad("A finding of base.findings has an id (1 to " + ID_CHARS + " characters), a code (1 to " + CODE_CHARS
                        + "), a path (a JSON pointer of at most " + PATH_CHARS + ", or null) and a message (1 to " + MESSAGE_CHARS + ").");
            }
            out.add(new BaseFinding(id, code, path.isNull() ? null : path.asText(), message));
        }
        return List.copyOf(out);
    }

    /**
     * A non-empty string within its cap, or null. The cap is in code points, as the browser cuts a finding (the
     * independent review of EA6.3): a creator's or a model's emoji is one character, and never half of one.
     */
    private static String text(JsonNode node, String key, int max) {
        JsonNode v = node.path(key);
        return v.isTextual() && !v.asText().isEmpty() && ModuleRequest.codePoints(v.asText()) <= max ? v.asText() : null;
    }
}
