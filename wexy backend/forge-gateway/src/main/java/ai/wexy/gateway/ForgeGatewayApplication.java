package ai.wexy.gateway;

import ai.wexy.gateway.shield.GatewayShieldProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * Wexy's edge. Every request from the studio and the share page passes through here before it
 * reaches forge-service: the shield (edge throttle, body and concurrency limits), App Check on the
 * routes a script would repeat, Firebase sign-in, per-account limits, and the internal token that
 * tells the service who is calling (backend architecture §2, §4).
 */
@SpringBootApplication
@EnableConfigurationProperties(GatewayShieldProperties.class)
public class ForgeGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(ForgeGatewayApplication.class, args);
    }
}
