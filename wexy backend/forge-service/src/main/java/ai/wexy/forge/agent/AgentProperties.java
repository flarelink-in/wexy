package ai.wexy.forge.agent;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code wexy.agent}: the turn's budgets (the agent-loop design §5.5, Q67). An unset value keeps Q67's, so a profile
 * names only what it changes.
 */
@ConfigurationProperties(prefix = "wexy.agent")
public record AgentProperties(Budget budget) {

    public record Budget(Integer calls, Integer contextRounds, Integer perRound, Integer toolRequests, Integer docBytes,
                         Integer revisions, Integer schemaRepairs, Long turnMicroUsd, Long turnSeconds, Integer promptBytes) {
    }

    /** The budgets, Q67's where unset. */
    public AgentBudget toBudget() {
        AgentBudget d = AgentBudget.defaults();
        if (budget == null) {
            return d;
        }
        return new AgentBudget(or(budget.calls(), d.calls()), or(budget.contextRounds(), d.contextRounds()),
                or(budget.perRound(), d.perRound()), or(budget.toolRequests(), d.toolRequests()), or(budget.docBytes(), d.docBytes()),
                or(budget.revisions(), d.revisions()), or(budget.schemaRepairs(), d.schemaRepairs()),
                or(budget.turnMicroUsd(), d.turnMicroUsd()), or(budget.turnSeconds(), d.turnSeconds()),
                or(budget.promptBytes(), d.promptBytes()));
    }

    private static <T> T or(T value, T fallback) {
        return value == null ? fallback : value;
    }
}
