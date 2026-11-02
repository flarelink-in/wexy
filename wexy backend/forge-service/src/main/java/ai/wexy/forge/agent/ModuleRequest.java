package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.engine.AdapterManifest;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.schemas.JsonSchemas;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * One module call's request, as {@code POST /v1/agent/module} takes it (the frontend's candidate-loop design §5, §6;
 * EA4.2, Q78 (a)): the body of one module, written or repaired against the interface the browser derived for it.
 *
 * <p>Everything is checked here, before any record or charge: the fields, exactly; the sizes (the request, the
 * interface, the previous body, the findings); the versions the browser was built against, which must be this
 * server's; R within the planner's caps and S against {@code agent-action.v3}; each supplied node against its adapter
 * on its own, since a slice of a program has inputs whose nodes were left out (the browser checks the whole program);
 * exactly one of them owning the module, of the kind the interface says, naming the entries it says; and a repair's
 * previous body, whose hash must be its own. The server cannot derive the interface (only the browser has X), so the
 * interface is the client's data, quoted to the model as data; it can spend only the caller's own budget, and the
 * browser checks every body against its own copy. What the caller may do with a turn is the handler's to check.
 *
 * <p>An author call may carry a {@code note} (EA6.3; the frontend's visual-review design §8.2): what a program revision's
 * {@code revision.moduleRepairs} asked of this module, which the revision added or rewired, so its body is written with
 * the note once. A repair's note is one of its findings, so a repair's {@code note} is null. Either way the note is the
 * client's data, quoted to the model as data.
 */
public record ModuleRequest(String turnId, String jobId, JsonNode subject, JsonNode versions, String purpose, AgentRequest request,
                            JsonNode design, JsonNode nodes, String module, String kind, JsonNode iface, List<String> entries,
                            Previous previous, String note) {

    /** The fields of a request: no other is taken. */
    static final List<String> FIELDS = List.of("turnId", "jobId", "subject", "versions", "purpose", "request", "design", "nodes", "module", "previous",
            "note");
    /** A note's characters at most, as code points: the action's {@code revision.moduleRepairs[].message} (agent-action.v3). */
    static final int NOTE_CHARS = 300;
    /** The frontend's ABI (`interfaces.ts`, ABI_VERSION) and body checker (`bodies.ts`, BODY_CHECKER); its tests pin both here. */
    public static final String ABI = "ea-abi.v2";
    public static final String CHECKER = "ea4-body.v1";
    /** The whole request, in UTF-8: spring.codec's default in-memory limit, so either refusal is a 413. */
    static final int MAX_REQUEST_BYTES = 262_144;
    static final int MAX_INTERFACE_BYTES = 16_384;
    /** A body's characters, as the browser's dial counts them (`bodies.ts`, BODY_DIAL.maxChars). */
    public static final int MAX_BODY_CHARS = 12_000;
    static final int MAX_NODES = 32;
    static final int MAX_FINDINGS = 32;
    static final int FINDING_CHARS = 400;
    static final int MAX_EVIDENCE_IDS = 32;

    static final Pattern ULID = Pattern.compile("[0-9A-HJKMNP-TV-Z]{26}");
    static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");
    static final Pattern MODULE = Pattern.compile("[A-Za-z0-9_-]{1,40}");
    static final Pattern ENTRY = Pattern.compile("[a-z][A-Za-z0-9_]{0,39}");
    /** A generated name: a binding's or a constant's (`b_…`, `B_…`, `EA_…`, `camera`, `ecs`, `sim`). */
    static final Pattern NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,63}");
    /** An X resource (`blocks#buffer`, `@host#camera`) or a chunk's id (`materials:CommonChunks.CameraStruct`). */
    static final Pattern RESOURCE = Pattern.compile("@?[A-Za-z0-9_-]{1,64}#[A-Za-z0-9_-]{1,64}");
    static final Pattern CHUNK_ID = Pattern.compile("[A-Za-z]{1,32}:[A-Za-z0-9_.]{1,64}");
    /** A binding's declaration, one line as the preamble has it: `@group(g) @binding(b) var<…> name: type;`. */
    static final Pattern DECLARATION = Pattern.compile("@group\\(\\d\\) @binding\\(\\d{1,2}\\) var<[a-z_, ]{1,40}> [A-Za-z_][A-Za-z0-9_]{0,63}: [A-Za-z0-9_<>]{1,40};");
    /** A signature's parameters, `name: type` apart by `, `, and its return type: one line, no backtick, no other text. */
    static final String PARAM = "[a-z][A-Za-z0-9_]{0,39}: [A-Za-z][A-Za-z0-9_<>]{0,39}";
    static final Pattern SIGNATURE_TAIL = Pattern.compile("\\((?:" + PARAM + "(?:, " + PARAM + "){0,7})?\\)(?: -> [A-Za-z][A-Za-z0-9_<>]{0,39})?");
    /** The host's lighting chunk: a custom batch wired to lights includes it. */
    static final String LIGHTS_CHUNK = "lights:";
    /** An interface's kinds, each with the adapter that owns such a module, the config keys naming its entries, and each entry's stage and engine entry. */
    static final Map<String, Owner> OWNERS = Map.of(
            "compute", new Owner("ng.compute.stage", List.of("entry"), List.of("compute:cs_main")),
            "custom_batch", new Owner("ng.render.custom_batch", List.of("vertexEntry", "fragmentEntry"), List.of("vertex:vs_main", "fragment:fs_main")),
            "fullscreen", new Owner("ng.render.fullscreen", List.of("fragmentEntry"), List.of("fragment:fs_main")));
    static final List<String> INTERFACE_KEYS = List.of("abi", "preamble", "epilogue", "entries", "bindings", "constants", "workgroupSize",
            "chunks", "interfaceHash");
    static final List<String> BINDING_KEYS = List.of("group", "binding", "name", "declaration", "resource", "access", "version", "boundBy");
    static final List<String> SUBJECT_KEYS = List.of("attempt", "revision", "programHash", "graph", "candidate", "module", "interfaceHash", "codeHash");
    static final Set<String> FINDING_KEYS = Set.of("id", "rung", "code", "path", "line", "severity", "message");

    record Owner(String adapter, List<String> entryKeys, List<String> stages) {
    }

    /** A repair's body, exactly as the browser judged it, its hash, and what was found in it. */
    public record Previous(String body, String codeHash, List<String> evidenceIds, List<JsonNode> findings) {
    }

    /** The pins a request must name: this server's engine bundle, action contract, adapter manifest, ABI and checker. */
    static Map<String, String> pins(String bundleHash) {
        return Map.of("bundle", bundleHash, "actionSchema", JsonSchemas.AGENT_ACTION, "manifest", AdapterManifest.HASH, "abi", ABI,
                "checker", CHECKER);
    }

    // JSON.parse refuses text after the value, as NodeCheck's reader does.
    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /** The request's text, checked whole; a 413 or a 400 that says what is wrong, never anything charged. */
    static ModuleRequest validated(String text, LoopProperties.Caps caps, String bundleHash, JsonSchemas schemas, NodeCheck nodeCheck) {
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "A module request is at most " + MAX_REQUEST_BYTES + " bytes.");
        }
        JsonNode body;
        try {
            body = JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw bad("The request is not JSON.");
        }
        if (body == null || !body.isObject()) {
            throw bad("The request must be a JSON object.");
        }
        exactly(body, FIELDS, "A module request");

        String turnId = text(body, "turnId");
        if (turnId == null || !ULID.matcher(turnId).matches()) {
            throw bad("turnId is the turn's id, 26 characters.");
        }
        String jobId = text(body, "jobId");
        if (jobId == null || !ID.matcher(jobId).matches()) {
            throw bad("jobId is 1 to 64 letters, digits, - or _.");
        }

        // The versions first: a browser built for another contract is told so before anything else is judged.
        JsonNode versions = body.path("versions");
        Map<String, String> pinned = pins(bundleHash);
        exactly(versions, List.copyOf(new java.util.TreeSet<>(pinned.keySet())), "versions");
        for (Map.Entry<String, String> pin : pinned.entrySet()) {
            if (!pin.getValue().equals(versions.path(pin.getKey()).asText(null))) {
                throw bad("versions." + pin.getKey() + " is " + shown(versions.path(pin.getKey())) + "; this server speaks " + pin.getValue() + ".");
            }
        }

        String purpose = text(body, "purpose");
        if (!"author".equals(purpose) && !"repair".equals(purpose)) {
            throw bad("purpose is author or repair.");
        }
        if (!body.path("request").isObject()) {
            throw bad("request is the turn's own request, {prompt, style, seconds}.");
        }
        AgentRequest request = AgentHandler.validated(body.path("request"), caps);

        // S as the turn handed it off: the action contract's design, checked by the action schema itself.
        JsonNode design = body.path("design");
        if (!design.isObject()) {
            throw bad("design is the turn's design, an object.");
        }
        ObjectNode action = JSON.createObjectNode().put("kind", "propose_design").putNull("context");
        action.set("design", design);
        action.putNull("program").putNull("modules").putNull("revision").putNull("question").putNull("finish");
        List<String> designProblems = schemas.validate(JsonSchemas.AGENT_ACTION, action);
        if (!designProblems.isEmpty()) {
            throw bad("design does not fit " + JsonSchemas.AGENT_ACTION + ": " + clip(designProblems.get(0)));
        }

        JsonNode moduleNode = body.path("module");
        exactly(moduleNode, List.of("id", "kind", "interface"), "module");
        String module = text(moduleNode, "id");
        if (module == null || !MODULE.matcher(module).matches()) {
            throw bad("module.id is 1 to 40 letters, digits, - or _.");
        }
        String kind = text(moduleNode, "kind");
        Owner owner = kind == null ? null : OWNERS.get(kind);
        if (owner == null) {
            throw bad("module.kind is compute, custom_batch or fullscreen.");
        }
        JsonNode iface = moduleNode.path("interface");
        List<String> entries = checkedInterface(iface, owner);

        // The nodes: each on its own (a slice has inputs whose nodes were left out), and exactly one owning the module.
        JsonNode nodes = body.path("nodes");
        NodeCheck.Result alone = nodeCheck.alone(nodes, "/nodes", MAX_NODES);
        if (!alone.findings().isEmpty()) {
            Finding f = alone.findings().get(0);
            throw bad("nodes: " + f.path() + ": " + clip(f.message()));
        }
        List<NodeCheck.Node> owners = alone.nodes().stream().filter(n -> OWNERS.values().stream().anyMatch(o -> o.adapter().equals(n.adapter().id()))
                && module.equals(n.config().path("module").asText(null))).toList();
        if (owners.size() != 1) {
            throw bad("nodes must hold exactly one node whose module is " + module + ", not " + owners.size() + ".");
        }
        NodeCheck.Node own = owners.get(0);
        if (!own.adapter().id().equals(owner.adapter())) {
            throw bad("module " + module + " is a " + kind + ", but its node " + own.id() + " is " + own.adapter().id() + ".");
        }
        List<String> named = owner.entryKeys().stream().map(k -> own.config().path(k).asText()).toList();
        if (!named.equals(entries)) {
            throw bad("module.interface names the entries " + entries + ", but node " + own.id() + " names " + named + ".");
        }
        // Custom lighting stays gated until the host's lighting chunk and callable contract exist (the candidate-loop
        // design §6): the interface would hold a placeholder, so no body could call LightSystem's functions.
        if (own.inputs().stream().anyMatch(i -> "lights".equals(i.port()))) {
            throw bad("Custom lighting is not available yet: node " + own.id() + " is a custom batch wired to lights, and the host's lighting"
                    + " contract is not built (EA5). Light it with a stock material, or leave its lights unwired.");
        }

        JsonNode subject = body.path("subject");
        checkedSubject(subject, module, iface.path("interfaceHash").asText());

        JsonNode previousNode = body.path("previous");
        Previous previous = null;
        if ("author".equals(purpose)) {
            if (!previousNode.isNull()) {
                throw bad("An author call has no previous body: previous is null.");
            }
            if (!subject.path("codeHash").isNull()) {
                throw bad("An author call judges no body yet: subject.codeHash is null.");
            }
        } else {
            previous = checkedPrevious(previousNode);
            if (!previous.codeHash().equals(subject.path("codeHash").asText(null))) {
                throw bad("A repair's subject.codeHash is its previous body's.");
            }
        }
        return new ModuleRequest(turnId, jobId, subject, versions, purpose, request, design, nodes, module, kind, iface, entries, previous,
                checkedNote(body.path("note"), purpose));
    }

    /** An author's note from a program revision, or null; a repair's is always null, since its note is one of its findings. */
    private static String checkedNote(JsonNode note, String purpose) {
        if (note.isNull()) {
            return null;
        }
        if (!"author".equals(purpose)) {
            throw bad("A repair's note is one of its findings: note is null.");
        }
        String text = note.isTextual() ? note.asText() : null;
        if (text == null || blank(text) || codePoints(text) > NOTE_CHARS) {
            throw bad("note is null, or what a program revision asks of this module's code: 1 to " + NOTE_CHARS + " characters.");
        }
        return text;
    }

    /**
     * Whether a model's or a client's text says nothing: every character white space as either side counts it. Java's
     * {@code isBlank} keeps the non-breaking spaces (U+00A0, U+2007, U+202F) and the BOM (U+FEFF), which the browser's
     * {@code trim} drops, so a note of them passed here and broke the browser's reader (the independent review of EA6.3).
     * This is a superset of the browser's rule: whatever it calls blank, this does.
     */
    static boolean blank(String text) {
        return text.codePoints().allMatch(c -> Character.isWhitespace(c) || Character.isSpaceChar(c) || c == 0xFEFF);
    }

    /** A string's length in code points, as the action's schema and the browser count it: an emoji is one. */
    static int codePoints(String text) {
        return text.codePointCount(0, text.length());
    }

    /**
     * The interface, as the client's data: its shape, its ABI, its hash's form and its size, and each element of its
     * projection (the frontend's `interfaces.ts`, ModuleInterface): every binding, constant, chunk and entry of its own
     * shape, each enum one of its values, each entry the kind's stage and engine entry, each signature one line of WGSL
     * that only names its parameters and types. Its entries, in order.
     */
    private static List<String> checkedInterface(JsonNode iface, Owner owner) {
        exactly(iface, INTERFACE_KEYS, "module.interface");
        if (utf8(iface.toString()) > MAX_INTERFACE_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "module.interface is at most " + MAX_INTERFACE_BYTES + " bytes as JSON.");
        }
        if (!ABI.equals(iface.path("abi").asText(null))) {
            throw bad("module.interface.abi is " + shown(iface.path("abi")) + "; this server speaks " + ABI + ".");
        }
        if (!iface.path("interfaceHash").isTextual() || !HASH.matcher(iface.path("interfaceHash").asText()).matches()) {
            throw bad("module.interface.interfaceHash is 64 lower-case hex digits.");
        }
        for (String key : List.of("preamble", "epilogue")) {
            if (!iface.path(key).isTextual()) {
                throw bad("module.interface." + key + " is the host's generated WGSL, a string.");
            }
        }
        for (String key : List.of("bindings", "constants", "chunks")) {
            if (!iface.path(key).isArray() || iface.path(key).size() > 32) {
                throw bad("module.interface." + key + " is a list of at most 32.");
            }
        }
        for (JsonNode b : iface.path("bindings")) {
            exactly(b, BINDING_KEYS, "a binding of module.interface");
            if (!b.path("group").isInt() || b.path("group").asInt() < 0 || b.path("group").asInt() > 3
                    || !b.path("binding").isInt() || b.path("binding").asInt() < 0 || b.path("binding").asInt() > 15
                    || !matches(NAME, b.path("name")) || !matches(DECLARATION, b.path("declaration")) || !matches(RESOURCE, b.path("resource"))
                    || !oneOf(b.path("access"), "read", "read_write", "uniform") || !oneOf(b.path("boundBy"), "engine", "host")
                    || !(b.path("version").isNull() || oneOf(b.path("version"), "current", "next"))) {
                throw bad("A binding of module.interface has a group 0 to 3, a binding 0 to 15, a WGSL name, its one-line declaration, its resource,"
                        + " an access (read, read_write or uniform), a version (null, current or next) and boundBy (engine or host).");
            }
        }
        for (JsonNode c : iface.path("constants")) {
            exactly(c, List.of("name", "value"), "a constant of module.interface");
            if (!matches(NAME, c.path("name")) || !c.path("value").isInt() || c.path("value").asInt() < 0) {
                throw bad("A constant of module.interface has a WGSL name and a whole number value, 0 or more.");
            }
        }
        for (JsonNode c : iface.path("chunks")) {
            exactly(c, List.of("id", "hash"), "a chunk of module.interface");
            if (!matches(CHUNK_ID, c.path("id")) || !matches(HASH, c.path("hash"))) {
                throw bad("A chunk of module.interface has an id (family:Name) and a hash of 64 lower-case hex digits.");
            }
            if (c.path("id").asText().startsWith(LIGHTS_CHUNK)) {
                throw bad("Custom lighting is not available yet: module.interface includes " + c.path("id").asText() + ", and the host's lighting"
                        + " contract is not built (EA5). Light it with a stock material, or leave its lights unwired.");
            }
        }
        JsonNode size = iface.path("workgroupSize");
        if (!size.isNull() && !(size.isInt() && size.asInt() >= 1 && size.asInt() <= 256)) {
            throw bad("module.interface.workgroupSize is null or 1 to 256.");
        }
        JsonNode list = iface.path("entries");
        if (!list.isArray() || list.size() != owner.stages().size()) {
            throw bad("module.interface.entries is a list of " + owner.stages().size() + ": " + String.join(", ", owner.stages()) + ".");
        }
        List<String> entries = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            JsonNode e = list.get(i);
            exactly(e, List.of("stage", "entry", "signature", "engineEntry"), "an entry of module.interface");
            String stage = e.path("stage").isTextual() && e.path("engineEntry").isTextual()
                    ? e.path("stage").asText() + ":" + e.path("engineEntry").asText() : null;
            if (!owner.stages().get(i).equals(stage)) {
                throw bad("Entry " + i + " of module.interface is stage and engineEntry " + owner.stages().get(i).replace(":", " and ") + ".");
            }
            String entry = e.path("entry").isTextual() ? e.path("entry").asText() : null;
            String signature = e.path("signature").isTextual() ? e.path("signature").asText() : null;
            if (entry == null || !ENTRY.matcher(entry).matches() || signature == null || signature.length() > 200
                    || !signature.startsWith("fn " + entry) || !SIGNATURE_TAIL.matcher(signature.substring(3 + entry.length())).matches()) {
                throw bad("An entry is a WGSL name of its own, and its signature one line, fn <entry>(name: type, …) -> type, at most 200 characters.");
            }
            entries.add(entry);
        }
        return List.copyOf(entries);
    }

    /** §5's evidence subject: what the call is about, echoed in its meta. */
    private static void checkedSubject(JsonNode s, String module, String interfaceHash) {
        exactly(s, SUBJECT_KEYS, "subject");
        if (!s.path("attempt").isTextual() || !ID.matcher(s.path("attempt").asText()).matches()) {
            throw bad("subject.attempt is 1 to 64 letters, digits, - or _.");
        }
        if (!s.path("revision").isInt() || s.path("revision").asInt() < 0 || s.path("revision").asInt() > 10_000) {
            throw bad("subject.revision is a whole number, 0 to 10000.");
        }
        if (!s.path("programHash").isTextual() || !HASH.matcher(s.path("programHash").asText()).matches()) {
            throw bad("subject.programHash is 64 lower-case hex digits.");
        }
        for (String key : List.of("graph", "candidate", "codeHash")) {
            JsonNode v = s.path(key);
            if (!v.isNull() && !(v.isTextual() && HASH.matcher(v.asText()).matches())) {
                throw bad("subject." + key + " is null or 64 lower-case hex digits.");
            }
        }
        if (s.path("graph").isNull()) {
            throw bad("subject.graph is the X the interface was derived from: a module call follows a resolved program.");
        }
        if (!module.equals(s.path("module").asText(null)) || !interfaceHash.equals(s.path("interfaceHash").asText(null))) {
            throw bad("subject names the module and the interfaceHash of module.");
        }
    }

    private static Previous checkedPrevious(JsonNode p) {
        exactly(p, List.of("body", "codeHash", "evidenceIds", "findings"), "previous");
        String body = p.path("body").asText(null);
        if (body == null || body.isEmpty() || body.length() > MAX_BODY_CHARS) {
            throw bad("previous.body is the body repaired, 1 to " + MAX_BODY_CHARS + " characters.");
        }
        String codeHash = p.path("codeHash").asText(null);
        if (codeHash == null || !codeHash.equals(sha256(body))) {
            throw bad("previous.codeHash is the SHA-256 of previous.body, over UTF-8.");
        }
        JsonNode ids = p.path("evidenceIds");
        if (!ids.isArray() || ids.size() > MAX_EVIDENCE_IDS) {
            throw bad("previous.evidenceIds is a list of at most " + MAX_EVIDENCE_IDS + ".");
        }
        List<String> evidenceIds = new ArrayList<>();
        for (JsonNode id : ids) {
            if (!id.isTextual() || !ID.matcher(id.asText()).matches()) {
                throw bad("An evidence id is 1 to 64 letters, digits, - or _.");
            }
            evidenceIds.add(id.asText());
        }
        JsonNode list = p.path("findings");
        if (!list.isArray() || list.isEmpty() || list.size() > MAX_FINDINGS) {
            throw bad("previous.findings is 1 to " + MAX_FINDINGS + " findings: a repair answers what was found.");
        }
        List<JsonNode> findings = new ArrayList<>();
        for (JsonNode f : list) {
            Set<String> keys = new HashSet<>();
            f.fieldNames().forEachRemaining(keys::add);
            // A message's bound is in code points, as the browser cuts it (the independent review of EA6.3).
            if (!f.isObject() || !FINDING_KEYS.containsAll(keys) || !f.path("message").isTextual() || codePoints(f.path("message").asText()) > FINDING_CHARS
                    || !f.path("code").isTextual() || f.path("code").asText().length() > 40
                    || !(f.path("line").isMissingNode() || f.path("line").isNull() || f.path("line").isInt())) {
                throw bad("A finding has a code (at most 40 characters), a message of at most " + FINDING_CHARS + ", a line or null, and only "
                        + new java.util.TreeSet<>(FINDING_KEYS) + ".");
            }
            for (String key : List.of("id", "rung", "path", "severity")) {
                JsonNode v = f.path(key);
                if (!v.isMissingNode() && !v.isNull() && !(v.isTextual() && v.asText().length() <= 64)) {
                    throw bad("A finding's " + key + " is at most 64 characters.");
                }
            }
            findings.add(f);
        }
        return new Previous(body, codeHash, List.copyOf(evidenceIds), List.copyOf(findings));
    }

    /** Exactly these keys, no other and none missing; refused in the words a developer can act on (AgentBase uses it too). */
    static void exactly(JsonNode node, List<String> keys, String what) {
        if (!node.isObject()) {
            throw bad(what + " must be an object with " + String.join(", ", keys) + ".");
        }
        List<String> extra = new ArrayList<>();
        for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) {
            String key = it.next();
            if (!keys.contains(key)) {
                extra.add(key.length() > 40 ? key.substring(0, 40) : key);
            }
        }
        List<String> missing = keys.stream().filter(k -> !node.has(k)).toList();
        if (!extra.isEmpty() || !missing.isEmpty()) {
            throw bad(what + " takes exactly " + String.join(", ", keys) + (extra.isEmpty() ? "" : "; not " + String.join(", ", extra.subList(0, Math.min(5, extra.size()))))
                    + (missing.isEmpty() ? "" : "; " + String.join(", ", missing) + " missing") + ".");
        }
    }

    private static boolean matches(Pattern pattern, JsonNode v) {
        return v.isTextual() && pattern.matcher(v.asText()).matches();
    }

    private static boolean oneOf(JsonNode v, String... values) {
        return v.isTextual() && List.of(values).contains(v.asText());
    }

    private static String text(JsonNode node, String key) {
        return node.path(key).isTextual() ? node.path(key).asText() : null;
    }

    static String shown(JsonNode v) {
        String s = v.isTextual() ? v.asText() : v.isMissingNode() ? "missing" : v.toString();
        return "\"" + (s.length() > 64 ? s.substring(0, 64) : s) + "\"";
    }

    static String clip(String s) {
        return s.length() > 300 ? s.substring(0, 300) : s;
    }

    static int utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }

    static ForgeException bad(String message) {
        return new ForgeException(ErrorCode.BAD_REQUEST, message);
    }
}
