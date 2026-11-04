package ai.wexy.platform.world;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A saved world's text as the platform accepts it (W3.1; the creations platform design §5, §10, §11): an agent world
 * (Q123) in the wexy-world.v1 format, canonical, within 512 KiB, and the bytes its claimed hash names. The schema is the
 * studio's own text ({@code src/platform/wexy-world.v1.json}), kept here as {@code world/wexy-world.v1.json}; the studio's
 * test holds the two equal. Which compatibility line runs is the browser's to say (Q125): the line and the pins are
 * stored here, never judged. Every refusal names the rule, never the text.
 */
public final class WorldCheck {

    public static final String FORMAT = "wexy-world.v1";
    /** §11's bound on a world's text, in UTF-8 bytes. */
    public static final int MAX_BYTES = 512 * 1024;

    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
    /** A line's shape, as the studio's lines.ts holds it: a lower-case name, then {@code .v} and a number. */
    private static final Pattern LINE = Pattern.compile("[a-z][a-z0-9-]{0,15}\\.v[1-9][0-9]{0,3}");
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * What a checked text is: its format and line, its pins as canonical JSON (for {@code revision.pins_json}), its size
     * and its SHA-256, lowercase hex.
     */
    public record Facts(String format, String line, String pinsJson, int bytes, String sha256) {
    }

    private final JsonSchema schema;

    public WorldCheck() {
        try {
            String text = new ClassPathResource("world/" + FORMAT + ".json").getContentAsString(StandardCharsets.UTF_8);
            this.schema = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(JSON.readTree(text));
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read the world schema world/" + FORMAT + ".json", e);
        }
    }

    /**
     * The facts of `artifact`, or the refusal: 413 past the cap, 400 for anything else. `claimedSha256` is the hash the
     * request named for it, which must be the text's own.
     */
    public Facts check(String artifact, String claimedSha256) {
        byte[] bytes = artifact.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) {
            throw new PlatformException(ErrorCode.TOO_LARGE, "This world is too large to save: at most 512 KiB.");
        }
        String sha256 = sha256(bytes);
        if (!sha256.equals(claimedSha256)) {
            throw refused("The world's text is not the bytes its hash names.");
        }
        String problem = CanonicalText.problem(artifact);
        if (problem != null) {
            throw refused("The world's text is not canonical JSON: " + problem + ".");
        }
        JsonNode world;
        try {
            world = JSON.readTree(artifact);
        } catch (IOException e) {
            throw refused("The world's text is not JSON.");
        }
        if (!world.isObject() || !FORMAT.equals(world.path("format").asText(null))) {
            throw refused("This is not a " + FORMAT + " world.");
        }
        if ("h1".equals(world.path("kind").asText(null))) {
            throw refused("An h1 world is not saved here: the studio keeps its download.");
        }
        Set<ValidationMessage> problems = schema.validate(world);
        if (!problems.isEmpty()) {
            throw refused("The world does not fit " + FORMAT + ": " + first(problems) + ".");
        }
        String line = world.get("line").asText();
        if (!LINE.matcher(line).matches()) {
            throw refused("The world's line is not a line (name.vN).");
        }
        hex(world.get("graph"), "graph");
        hex(world.get("candidate"), "candidate");
        JsonNode pins = world.get("pins");
        for (String pin : new String[]{"bundle", "manifest", "policy"}) {
            hex(pins.get(pin), "pins." + pin);
        }
        int i = 0;
        for (JsonNode module : world.get("modules")) {
            hex(module.get("interfaceHash"), "modules[" + i + "].interfaceHash");
            hex(module.get("codeHash"), "modules[" + i + "].codeHash");
            i++;
        }
        return new Facts(FORMAT, line, pins.toString(), bytes.length, sha256);
    }

    /** The lowercase hex SHA-256 of `bytes`. */
    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }

    private static void hex(JsonNode value, String field) {
        if (value == null || !HEX64.matcher(value.asText()).matches()) {
            throw refused("The world's " + field + " is not 64 lowercase hex digits.");
        }
    }

    /** The first problem by path, so the same text always gets the same answer. */
    private static String first(Set<ValidationMessage> problems) {
        return problems.stream().map(ValidationMessage::getMessage).sorted().findFirst().orElse("a rule");
    }

    private static PlatformException refused(String message) {
        return new PlatformException(ErrorCode.BAD_REQUEST, message);
    }
}
