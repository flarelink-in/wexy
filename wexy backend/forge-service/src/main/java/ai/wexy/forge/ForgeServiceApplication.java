package ai.wexy.forge;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Wexy's business service, behind forge-gateway (backend architecture §2, §6).
 *
 * What exists today is the foundation the core loop will stand on: the identity the gateway
 * vouches for, the money caps, the model roles and prices, and one metered door to Meta's models.
 * The loop's own endpoints (plan, author, repair, direct, outcomes) are not written yet.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class ForgeServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ForgeServiceApplication.class, args);
    }
}
