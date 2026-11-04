package ai.wexy.forge.upstream;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The service's own configuration holds together. On 2026-11-04 the upstream idle limit was found at 65 s while the agent
 * and module roles allowed 120 s: Meta streams nothing while a model reasons, so every call that reasoned silently past
 * 65 s was cut, and a role's deadline above the idle limit could never be reached. Nothing checked it.
 */
class ConfigurationInvariantsTest {

    private static final Pattern DURATION = Pattern.compile("(\\d+)(ms|s|m)");

    @SuppressWarnings("unchecked")
    private static Map<String, Object> yaml(String name) throws Exception {
        return (Map<String, Object>) new Yaml().load(Files.readString(Path.of("src/main/resources", name)));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> parent, String key) {
        Object value = parent == null ? null : parent.get(key);
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    private static Duration duration(Object value) {
        Matcher m = DURATION.matcher(String.valueOf(value));
        assertThat(m.matches()).as("a duration: %s", value).isTrue();
        long n = Long.parseLong(m.group(1));
        return switch (m.group(2)) {
            case "ms" -> Duration.ofMillis(n);
            case "s" -> Duration.ofSeconds(n);
            default -> Duration.ofMinutes(n);
        };
    }

    /** Every role's deadline, under `wexy.meta-api.read-idle-timeout`, so the deadline is what ends a silent call. */
    private static void idleAboveEveryRole(String profile, Map<String, Object> wexy, Map<String, Object> roles) {
        Duration idle = duration(map(wexy, "meta-api").get("read-idle-timeout"));
        assertThat(roles).as(profile).isNotEmpty();
        for (Map.Entry<String, Object> role : roles.entrySet()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> r = (Map<String, Object>) role.getValue();
            assertThat(idle).as("%s: the upstream idle limit over the %s role's deadline", profile, role.getKey())
                    .isGreaterThan(duration(r.get("timeout")));
        }
    }

    @Test
    void theUpstreamIdleLimitIsAboveEveryRolesDeadline() throws Exception {
        Map<String, Object> main = map(yaml("application.yaml"), "wexy");
        idleAboveEveryRole("application.yaml", main, map(main, "roles"));

        // The paper profile runs on top of the main one: its idle limit and roles, the main's where it sets none.
        Map<String, Object> paper = map(yaml("application-paper.yaml"), "wexy");
        Map<String, Object> merged = new LinkedHashMap<>(main);
        Map<String, Object> metaApi = new LinkedHashMap<>(map(main, "meta-api"));
        metaApi.putAll(map(paper, "meta-api"));
        merged.put("meta-api", metaApi);
        Map<String, Object> roles = new LinkedHashMap<>(map(main, "roles"));
        roles.putAll(map(paper, "roles"));
        idleAboveEveryRole("application-paper.yaml", merged, roles);
    }

    /** The turn's budgets the tests run on (`AgentBudget.defaults()`) are the ones production configures. */
    @Test
    void theAgentBudgetsDefaultsAreTheConfiguredOnes() throws Exception {
        Map<String, Object> budget = map(map(map(yaml("application.yaml"), "wexy"), "agent"), "budget");
        ai.wexy.forge.agent.AgentBudget d = ai.wexy.forge.agent.AgentBudget.defaults();
        Map<String, Object> expected = new LinkedHashMap<>();
        expected.put("calls", d.calls());
        expected.put("context-rounds", d.contextRounds());
        expected.put("per-round", d.perRound());
        expected.put("tool-requests", d.toolRequests());
        expected.put("doc-bytes", d.docBytes());
        expected.put("revisions", d.revisions());
        expected.put("schema-repairs", d.schemaRepairs());
        expected.put("turn-micro-usd", d.turnMicroUsd());
        expected.put("turn-seconds", d.turnSeconds());
        expected.put("prompt-bytes", d.promptBytes());
        for (Map.Entry<String, Object> e : expected.entrySet()) {
            assertThat(String.valueOf(budget.get(e.getKey()))).as("wexy.agent.budget.%s", e.getKey()).isEqualTo(String.valueOf(e.getValue()));
        }
    }

    @Test
    void theTurnHoldsACallAtItsDeadline() throws Exception {
        Map<String, Object> main = map(yaml("application.yaml"), "wexy");
        @SuppressWarnings("unchecked")
        Map<String, Object> agent = (Map<String, Object>) map(main, "roles").get("agent");
        Object seconds = map(map(main, "agent"), "budget").get("turn-seconds");
        assertThat(Duration.ofSeconds(Long.parseLong(String.valueOf(seconds))))
                .as("a turn's seconds hold at least one agent call at its deadline").isGreaterThanOrEqualTo(duration(agent.get("timeout")));
    }
}
