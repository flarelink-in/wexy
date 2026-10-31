package ai.wexy.forge.schemas;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
        assertThat(JsonSchemas.strictSubsetProblems(SCHEMAS.schema(JsonSchemas.SCENE_DRAFT))).isEmpty();
        assertThat(JsonSchemas.strictSubsetProblems(SCHEMAS.schema(JsonSchemas.EDIT_PLAN))).isEmpty();
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

    @Test
    void theMocksPlansAndEditAreValidAnswers() throws Exception {
        assertThat(SCHEMAS.validate(JsonSchemas.SCENE_DRAFT, resource("mock/plans/galaxy.json"))).isEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.SCENE_DRAFT, resource("mock/plans/storm.json"))).isEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, resource("mock/edits/director.json"))).isEmpty();
    }

    /** What a log line gets for a bad plan: the path and the rule, never the answer. */
    @Test
    void aBadPlanSaysWhereAndWhy() throws Exception {
        ObjectNode plan = (ObjectNode) resource("mock/plans/galaxy.json");
        ((ObjectNode) plan.get("particles")).put("count", 12);
        plan.remove("title");
        plan.putObject("arrangement");
        ((ObjectNode) plan.withArray("uniforms").get(0)).put("name", "Spin Speed");
        List<String> messages = SCHEMAS.validate(JsonSchemas.SCENE_DRAFT, plan);
        assertThat(messages).anyMatch(m -> m.startsWith("$.particles.count") && m.contains("65536"))
                .anyMatch(m -> m.contains("title"))
                .anyMatch(m -> m.startsWith("$.arrangement"))
                .anyMatch(m -> m.startsWith("$.uniforms[0].name"));
    }

    @Test
    void anEditPlanIsExactlyOneOfItsFourKinds() throws Exception {
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, JSON.readTree("{\"edit\":{\"kind\":\"clarify\",\"question\":\"Which arm?\"}}"))).isEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, JSON.readTree(
                "{\"edit\":{\"kind\":\"rewrite\",\"functions\":[\"evolve\"],\"instruction\":\"collide\",\"ops\":[],\"summary\":\"They collide.\"}}"))).isEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, JSON.readTree("{\"edit\":{\"kind\":\"patch\",\"ops\":[],\"summary\":\"Nothing.\"}}"))).isNotEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, JSON.readTree("{\"edit\":{\"kind\":\"explode\"}}"))).isNotEmpty();
        assertThat(SCHEMAS.validate(JsonSchemas.EDIT_PLAN, JSON.readTree(
                "{\"edit\":{\"kind\":\"rewrite\",\"functions\":[\"arrange\"],\"instruction\":\"x\",\"ops\":[],\"summary\":\"x\"}}"))).isNotEmpty();
    }
}
