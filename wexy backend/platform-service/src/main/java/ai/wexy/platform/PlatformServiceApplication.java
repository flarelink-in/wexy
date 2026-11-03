package ai.wexy.platform;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Wexy's platform service, behind forge-gateway (the creations platform design §3, Q91): accounts and their public
 * profiles from W2, then saved worlds, the showcase and the waitlist in their stages. It owns its MariaDB schema alone
 * and calls no model: model calls, allowances and prompt safety stay forge's. Never publish its port: it trusts the
 * gateway's internal token.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class PlatformServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(PlatformServiceApplication.class, args);
    }
}
