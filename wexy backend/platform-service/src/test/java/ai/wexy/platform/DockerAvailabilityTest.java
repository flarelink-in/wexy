package ai.wexy.platform;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.DockerClientFactory;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The strict build must not turn missing Docker into a green, MariaDB-free verification (as forge's for Redis). Kept
 * apart from the container tests so their skip condition cannot disable this check.
 */
@EnabledIfSystemProperty(named = "wexy.require-docker", matches = "true")
class DockerAvailabilityTest {

    @Test
    void strictVerificationRequiresDocker() {
        assertThat(DockerClientFactory.instance().isDockerAvailable())
                .as("The redis-tests profile requires Docker (Redis and MariaDB): start Docker Desktop before verifying")
                .isTrue();
    }
}
