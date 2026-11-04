package ai.wexy.platform.world;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W3.1's canonical check against the studio's own output (the creations platform design §5, "Exact bytes"; PL-T4): the
 * doubles Node wrote with JSON.stringify ({@code numbers.json}, from the frontend's {@code dev/world-corpus.mjs}), the
 * castle as the studio saved it, and every way a text can be JSON yet not the studio's canonical form.
 */
class CanonicalTextTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static String resource(String name) throws IOException {
        return new ClassPathResource("world/" + name).getContentAsString(StandardCharsets.UTF_8);
    }

    @Test
    void everyDoubleIsWrittenAsNodeWritesIt() throws IOException {
        JsonNode numbers = JSON.readTree(resource("numbers.json")).get("numbers");
        assertThat(numbers.size()).isGreaterThanOrEqualTo(4000);
        int checked = 0;
        for (JsonNode pair : numbers) {
            double v = Double.longBitsToDouble(Long.parseUnsignedLong(pair.get(0).asText(), 16));
            String node = pair.get(1).asText();
            assertThat(CanonicalText.number(v)).as("bits %s", pair.get(0).asText()).isEqualTo(node);
            // And the number alone is a canonical text: read back as the same double.
            assertThat(CanonicalText.problem(node)).as(node).isNull();
            checked++;
        }
        assertThat(checked).isEqualTo(numbers.size());
    }

    @Test
    void theEdgeCasesTheSpecificationNames() {
        assertThat(CanonicalText.number(-0.0)).isEqualTo("0");
        assertThat(CanonicalText.number(1e21)).isEqualTo("1e+21");
        assertThat(CanonicalText.number(1e20)).isEqualTo("100000000000000000000");
        assertThat(CanonicalText.number(1e-7)).isEqualTo("1e-7");
        assertThat(CanonicalText.number(1e-6)).isEqualTo("0.000001");
        assertThat(CanonicalText.number(Double.MIN_VALUE)).isEqualTo("5e-324");
        assertThat(CanonicalText.number(0.1 + 0.2)).isEqualTo("0.30000000000000004");
        assertThat(CanonicalText.number(-1.5e-300)).isEqualTo("-1.5e-300");
        assertThat(CanonicalText.number(45)).isEqualTo("45");
    }

    @Test
    void theCastleAsTheStudioSavedItIsCanonical() throws IOException {
        String castle = resource("castle.wexy-world.json");
        assertThat(CanonicalText.problem(castle)).isNull();
        // A Jackson round trip is not the studio's form (the design's §5): this check would refuse what Jackson wrote.
        String jackson = JSON.writeValueAsString(JSON.readTree(castle));
        if (!jackson.equals(castle)) {
            assertThat(CanonicalText.problem(jackson)).isNotNull();
        }
    }

    @Test
    void stringsAreEscapedAsJsonStringifyEscapesThem() {
        assertThat(CanonicalText.problem("\"a\\\"b\\\\c\\n\\t\\r\\b\\f\"")).isNull();
        assertThat(CanonicalText.problem("\"\\u0001\\u001f\"")).isNull();
        // Literal where JSON.stringify leaves them literal: DEL, U+2028, non-ASCII, a surrogate pair.
        assertThat(CanonicalText.problem("\"\u007f\u2028é\uD83C\uDF0C\"")).isNull();
        // A lone surrogate is escaped, lowercase.
        assertThat(CanonicalText.problem("\"\\ud800\"")).isNull();
        assertThat(CanonicalText.problem("\"\\uD800\"")).isNotNull();
        // Not the studio's: an escape JSON.stringify never writes.
        assertThat(CanonicalText.problem("\"\\u00e9\"")).isNotNull();
        assertThat(CanonicalText.problem("\"\\/\"")).isNotNull();
        assertThat(CanonicalText.problem("\"\\u0041\"")).isNotNull();
        assertThat(CanonicalText.problem("\"\\u000a\"")).isNotNull();
    }

    @Test
    void keysAreSortedByUtf16CodeUnits() {
        assertThat(CanonicalText.problem("{\"B\":1,\"a\":2}")).isNull();
        assertThat(CanonicalText.problem("{\"a\":2,\"B\":1}")).isNotNull();
        // U+FF5E sorts after U+1F30C's high surrogate (0xD83C) in code units, though not in code points.
        assertThat(CanonicalText.problem("{\"\uD83C\uDF0C\":1,\"\uFF5E\":2}")).isNull();
        assertThat(CanonicalText.problem("{\"\uFF5E\":2,\"\uD83C\uDF0C\":1}")).isNotNull();
    }

    @Test
    void jsonThatIsNotTheStudiosFormIsRefused() {
        for (String text : new String[]{
                "{\"a\": 1}", " {}", "{}\n", "[1, 2]", "1.0", "1E3", "1e3", "-0", "0.10", "01", "+1", "1.", ".5",
                "{\"a\":1,\"a\":1}", "9007199254740992", "1e400", "NaN", "[1,]", "{\"a\":1,}", "'a'", "tru", "nul",
                "\"a", "\"\t\"", "[", "", "{\"a\"}", "[1]x", "{\"a\":1}{}",
                // Every double from 2^53 up is a whole number, and the browser's canonicalJson refuses to write one.
                "1e+21", "1.7976931348623157e+308",
        }) {
            assertThat(CanonicalText.problem(text)).as(text).isNotNull();
        }
        for (String text : new String[]{"{}", "[]", "0", "-1", "1.5", "1.5e-300", "5e-324", "true", "null", "\"\"", "{\"a\":[1,{\"b\":null}]}",
                "9007199254740991", "-9007199254740991"}) {
            assertThat(CanonicalText.problem(text)).as(text).isNull();
        }
    }

    /**
     * A duplicate key is refused by the comparison alone (the canonical form names each key once), so its own check is
     * what says why: a forged text is told what is wrong with it, not only that its bytes differ (W3's mutation run).
     */
    @Test
    void aDuplicateKeyIsSaidAsOne() {
        assertThat(CanonicalText.problem("{\"a\":1,\"a\":1}")).startsWith("a duplicate key");
        assertThat(CanonicalText.problem("{\"a\":{\"b\":1,\"b\":2}}")).startsWith("a duplicate key");
    }

    @Test
    void aDeepTextIsRefusedBeforeItCanReachTheStack() {
        String deep = "[".repeat(200_000) + "]".repeat(200_000);
        assertThat(CanonicalText.problem(deep)).contains("nested deeper than 32");
        String allowed = "[".repeat(33) + "]".repeat(33);
        assertThat(CanonicalText.problem(allowed)).isNull();
        assertThat(CanonicalText.problem("[" + allowed + "]")).contains("nested deeper");
    }
}
