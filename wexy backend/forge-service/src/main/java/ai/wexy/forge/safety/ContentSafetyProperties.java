package ai.wexy.forge.safety;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.Map;

/**
 * Azure AI Content Safety (W1; the creations platform design §11, Q99 as recommended): the resource's endpoint and key,
 * from Infisical, the deadline of one check, and the severity at which each category refuses, on Azure's four levels
 * (0, 2, 4, 6). Q99: Sexual at 2 or more, Hate, SelfHarm and Violence at 4 or more.
 *
 * @param endpoint the resource's endpoint, {@code https://<resource>.cognitiveservices.azure.com}
 * @param key      the resource's key, sent as {@code Ocp-Apim-Subscription-Key}; never logged
 * @param timeout  one check's whole deadline (3 s): slower is no verdict, and no verdict is no call
 * @param refuseAt each category's refusal threshold, keyed in lowercase ({@code hate}, {@code selfharm}, {@code sexual},
 *                 {@code violence}): an environment variable's map key is lowercased anyway
 */
@ConfigurationProperties(prefix = "wexy.content-safety")
public record ContentSafetyProperties(String endpoint, String key, Duration timeout, Map<String, Integer> refuseAt) {

    public ContentSafetyProperties {
        refuseAt = refuseAt == null ? Map.of() : Map.copyOf(refuseAt);
    }
}
