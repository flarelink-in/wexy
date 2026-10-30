package ai.wexy.forge.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The frontend's engine bundle (EA1, its {@code src/contract/engine/}), embedded byte for byte under
 * {@code resources/engine/} and checked the way the frontend's tests check it ({@code verifyManifest}):
 * each file's hash against the manifest, the bundle hash over the package hash and the three files,
 * the document count, and every document's text against its own hash. A copy that drifted from its
 * manifest is refused, so what a prompt quotes is what was reviewed (the EA1 review, finding 1).
 * Hashes are over LF line ends, as the frontend writes and hashes them. The paper test quotes it
 * today (PaperProbe, the {@code paper} template); the agent loop of EA2 will.
 */
public final class EngineBundle {

    /** One bundled document: null-graph's own text, with where it was copied from. */
    public record Doc(String id, String title, String source, String sha256, int bytes, String text) {
    }

    /** One export of the installed package, as K records it: its declaration as written, and the documents naming it. */
    public record Symbol(String id, String family, String name, String kind, String summary, String declaration,
                         List<String> docIds) {
    }

    /** One family (a subpath): how a world relates to it ({@code world}, {@code host}, {@code external}), and its documents. */
    public record Family(String id, String subpath, String use, String reason, List<String> docs, List<String> examples) {
    }

    /** A family's entry in H: whether Wexy can run it yet, and why. */
    public record Support(String family, String status, String reason) {
    }

    public static final List<String> FILES = List.of("bundle.json", "capabilities.json", "docs.json", "support.json");

    private final String engineVersion;
    private final String bundleHash;
    private final String docsSource;
    private final String familyIndex;
    private final Map<String, Doc> docs;
    private final Map<String, Symbol> symbols;
    private final Map<String, Family> families;
    private final Map<String, Support> support;

    private EngineBundle(String engineVersion, String bundleHash, String docsSource, String familyIndex,
                         Map<String, Doc> docs, Map<String, Symbol> symbols, Map<String, Family> families,
                         Map<String, Support> support) {
        this.engineVersion = engineVersion;
        this.bundleHash = bundleHash;
        this.docsSource = docsSource;
        this.familyIndex = familyIndex;
        this.docs = docs;
        this.symbols = symbols;
        this.families = families;
        this.support = support;
    }

    /** The bundle on the classpath, verified; throws when any hash disagrees with the manifest. */
    public static EngineBundle load(ObjectMapper json) {
        Map<String, String> texts = new LinkedHashMap<>();
        for (String name : FILES) {
            try {
                texts.put(name, new ClassPathResource("engine/" + name).getContentAsString(StandardCharsets.UTF_8));
            } catch (IOException e) {
                throw new UncheckedIOException("Cannot read engine/" + name, e);
            }
        }
        return from(texts, json);
    }

    /** A bundle from its four files' texts, verified first. */
    static EngineBundle from(Map<String, String> texts, ObjectMapper json) {
        List<String> problems = problems(texts, json);
        if (!problems.isEmpty()) {
            throw new IllegalStateException("The engine bundle does not match its manifest: " + problems);
        }
        JsonNode bundle = tree(json, texts.get("bundle.json"));
        JsonNode capabilities = tree(json, texts.get("capabilities.json"));
        JsonNode documents = tree(json, texts.get("docs.json"));
        Map<String, Doc> docs = new LinkedHashMap<>();
        for (JsonNode d : documents.path("docs")) {
            docs.put(d.path("id").asText(), new Doc(d.path("id").asText(), d.path("title").asText(),
                    d.path("source").asText(), d.path("sha256").asText(), d.path("bytes").asInt(), d.path("text").asText()));
        }
        Map<String, Symbol> symbols = new LinkedHashMap<>();
        for (JsonNode s : capabilities.path("symbols")) {
            symbols.put(s.path("id").asText(), new Symbol(s.path("id").asText(), s.path("family").asText(), s.path("name").asText(),
                    s.path("kind").asText(), s.path("summary").asText(), s.path("declaration").asText(), strings(s.path("docIds"))));
        }
        Map<String, Family> families = new LinkedHashMap<>();
        for (JsonNode f : capabilities.path("families")) {
            families.put(f.path("id").asText(), new Family(f.path("id").asText(), f.path("subpath").asText(), f.path("use").asText(),
                    f.path("reason").isTextual() ? f.path("reason").asText() : null, strings(f.path("docs")), strings(f.path("examples"))));
        }
        Map<String, Support> support = new LinkedHashMap<>();
        for (JsonNode e : tree(json, texts.get("support.json")).path("entries")) {
            support.put(e.path("family").asText(), new Support(e.path("family").asText(), e.path("status").asText(), e.path("reason").asText()));
        }
        // Kept in the bundle's order (documents by id, symbols by subpath then name), so every answer built from them is deterministic.
        return new EngineBundle(bundle.path("engine").path("version").asText(), bundle.path("bundleHash").asText(),
                documents.path("source").asText(), capabilities.path("familyIndex").asText(), Collections.unmodifiableMap(docs),
                Collections.unmodifiableMap(symbols), Collections.unmodifiableMap(families), Collections.unmodifiableMap(support));
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(v -> out.add(v.asText()));
        return List.copyOf(out);
    }

    /** What is wrong with the bundle, one message per finding, in the frontend's words; empty when it is whole. */
    static List<String> problems(Map<String, String> texts, ObjectMapper json) {
        List<String> problems = new ArrayList<>();
        for (String name : FILES) {
            if (texts.get(name) == null) {
                problems.add(name + ": missing");
            }
        }
        if (!problems.isEmpty()) {
            return problems;
        }
        JsonNode bundle = tree(json, texts.get("bundle.json"));
        Map<String, String> recorded = new LinkedHashMap<>();
        recorded.put("capabilities.json", bundle.path("capabilities").path("hash").asText());
        recorded.put("docs.json", bundle.path("docs").path("hash").asText());
        recorded.put("support.json", bundle.path("support").path("hash").asText());
        for (Map.Entry<String, String> file : recorded.entrySet()) {
            if (!file.getValue().equals(sha256(lf(texts.get(file.getKey()))))) {
                problems.add(file.getKey() + ": its hash is not the manifest's");
            }
        }
        String expected = sha256(String.join("\n", bundle.path("engine").path("packageHash").asText(),
                sha256(lf(texts.get("capabilities.json"))), sha256(lf(texts.get("docs.json"))),
                sha256(lf(texts.get("support.json")))));
        if (!expected.equals(bundle.path("bundleHash").asText())) {
            problems.add("bundleHash: not the hash of the package and the three files");
        }
        JsonNode documents = tree(json, texts.get("docs.json"));
        if (bundle.path("docs").path("count").asInt(-1) != documents.path("docs").size()) {
            problems.add("the manifest's document count is not the bundle's");
        }
        for (JsonNode d : documents.path("docs")) {
            if (!sha256(d.path("text").asText()).equals(d.path("sha256").asText())) {
                problems.add(d.path("id").asText() + ": its text is not its hash");
            }
        }
        return problems;
    }

    public String engineVersion() {
        return engineVersion;
    }

    public String bundleHash() {
        return bundleHash;
    }

    /** {@code null-graph@<commit>}: the checkout the documents were copied from. */
    public String docsSource() {
        return docsSource;
    }

    /** Every family in one prompt-sized text, within its 12 KiB (the frontend's design §5.1). */
    public String familyIndex() {
        return familyIndex;
    }

    /** Every document, by id, in the bundle's order. */
    public Map<String, Doc> docs() {
        return docs;
    }

    /** Every export, by {@code family:Name}, in the package's order. */
    public Map<String, Symbol> symbols() {
        return symbols;
    }

    /** Every family, by id, in the package's subpath order. */
    public Map<String, Family> families() {
        return families;
    }

    /** A family's entry in H; every family has one (the frontend's EA-H). */
    public Support support(String family) {
        return support.get(family);
    }

    /** One document by id; throws for an id the bundle does not have. */
    public Doc doc(String id) {
        Doc doc = docs.get(id);
        if (doc == null) {
            throw new IllegalArgumentException("No document '" + id + "' in the engine bundle");
        }
        return doc;
    }

    /** The documents whole, in order, each inside a tag with its id, hash and source: quoted as data, for a prompt. */
    public String quote(List<String> ids) {
        List<String> quoted = new ArrayList<>();
        for (String id : ids) {
            Doc d = doc(id);
            quoted.add("<document id=\"" + d.id() + "\" sha256=\"" + d.sha256() + "\" source=\"" + d.source() + "\">\n"
                    + d.text().strip() + "\n</document>");
        }
        return String.join("\n\n", quoted);
    }

    static String lf(String text) {
        return text.replace("\r\n", "\n");
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }

    private static JsonNode tree(ObjectMapper json, String text) {
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("The engine bundle holds a file that is not JSON: " + e.getOriginalMessage(), e);
        }
    }
}
