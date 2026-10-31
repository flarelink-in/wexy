package ai.wexy.forge.spend;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.DockerClientFactory;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The strict build must not turn missing Docker into a green, Redis-free verification.
 * Kept separate from the container tests so their skip condition cannot disable this check.
 */
@EnabledIfSystemProperty(named = "wexy.require-docker", matches = "true")
class DockerAvailabilityTest {

    @Test
    void strictVerificationRequiresDocker() {
        assertThat(DockerClientFactory.instance().isDockerAvailable())
                .as("The redis-tests profile requires Docker: start Docker Desktop before verifying")
                .isTrue();
    }
}