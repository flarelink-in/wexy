package ai.wexy.forge.mock;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The mock upstream's settings (forge-loop design §8), under {@code wexy.mock.*}. Set by
 * {@code application-mock.yaml}, and each one overridable as an environment variable
 * ({@code WEXY_MOCK_SCENARIO=fault}). Bound under every profile; read only by the {@code mock} one.
 *
 * @param port            the loopback port the mock listens on (8420); {@code wexy.meta-api.base-url}
 *                        must point at it
 * @param tokensPerSecond how fast it streams: 80 is about a model's pace, so the studio's progress
 *                        can be watched; 0 answers at once
 * @param scenario        {@code ok}, {@code fault}, {@code slow} or {@code error-mid-stream}
 * @param slowMillis      how long the {@code slow} scenario stays quiet after its first chunk (40 s:
 *                        past the planner's deadline, under the author's)
 */
@ConfigurationProperties(prefix = "wexy.mock")
public record MockProperties(Integer port, Integer tokensPerSecond, String scenario, Long slowMillis) {

    public MockProperties {
        port = port == null ? 8420 : port;
        tokensPerSecond = tokensPerSecond == null ? 80 : tokensPerSecond;
        scenario = scenario == null || scenario.isBlank() ? "ok" : scenario.trim();
        slowMillis = slowMillis == null ? 40_000L : slowMillis;
    }
}
