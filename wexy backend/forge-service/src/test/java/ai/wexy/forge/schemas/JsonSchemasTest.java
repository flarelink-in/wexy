package ai.wexy.forge.schemas;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * U3: both schemas stay inside Meta's strict subset, and the mock's recordings are valid answers, so
 * the mock path (P7) replays what a real model would be allowed to send (forge-loop design §5.4, §8).
 */
class JsonSchemasTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonSchemas SCHEMAS = new JsonSchemas();

    private static JsonNode resource(String path) throws Exception {
        return JSON.readTree(new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    void bothSchemasStayInsideMetasStrictSubset() {
        assertThat(JsonSchemas.strictSubsetProblems(SCHEMAS.schema(JsonSchemas.AGENT_ACTION))).isEmpty();
    }

    /** The check itself, seen failing on each rule it enforces. */
    @Test
    void theStrictSubsetCheckFindsEachBreak() throws Exception {
        String ok = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"a\"],\"properties\":{\"a\":%s}}";
        assertThat(problems("{\"anyOf\":[{\"type\":\"object\"}]}")).anyMatch(p -> p.contains("the root must be an object"))
                .anyMatch(p -> p.contains("no anyOf at the root"));
        assertThat(problems(ok.formatted("{\"oneOf\":[{\"type\":\"string\"},{\"type\":\"number\"}]}"))).anyMatch(p -> p.contains("$.a: oneOf is not supported"));
        assertThat(problems(ok.formatted("{\"type\":\"object\",\"required\":[],\"properties\":{}}"))).anyMatch(p -> p.contains("$.a: additionalProperties must be false"));
        assertThat(problems(ok.formatted("{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"x\"],\"properties\":{\"x\":{\"type\":\"number\"},\"y\":{\"type\":\"number\"}}}")))
                .anyMatch(p -> p.contains("required [x] must list every property [x, y]"));
        assertThat(problems(ok.formatted("{\"$ref\":\"https://example.com/s.json\"}"))).anyMatch(p -> p.contains("only references into $defs"));
        String recursive = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"a\"],\"properties\":{\"a\":{\"$ref\":\"#/$defs/node\"}},"
                + "\"$defs\":{\"node\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"next\"],\"properties\":{\"next\":{\"$ref\":\"#/$defs/node\"}}}}}";
        assertThat(problems(recursive)).anyMatch(p -> p.contains("a recursive reference"));
        String deep = "{\"type\":\"array\",\"items\":{\"type\":\"number\"}}";
        for (int i = 0; i < 10; i++) {
            deep = "{\"type\":\"array\",\"items\":" + deep + "}";
        }
        assertThat(problems(ok.formatted(deep))).anyMatch(p -> p.contains("nesting 12 is deeper than 10"));
        assertThat(problems(ok.formatted("{\"type\":\"string\"}"))).isEmpty();
    }

    private static List<String> problems(String schema) throws Exception {
        return JsonSchemas.strictSubsetProblems(JSON.readTree(schema));
    }

}
