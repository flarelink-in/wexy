package ai.wexy.gateway.auth;

import ai.wexy.common.InternalToken;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Publishes the public half of the internal signing key, which forge-service fetches to verify the
 * internal token. Copied from FlareLink's InternalJwtConfiguration (pre-existing work). Only public
 * key material is served, and the path is on the shield's bypass list: throttling it would throttle
 * the service's ability to authenticate the gateway's own traffic.
 */
@RestController
public class JwksController {

    private final InternalSigningKey signingKey;

    public JwksController(InternalSigningKey signingKey) {
        this.signingKey = signingKey;
    }

    @GetMapping(value = InternalToken.JWKS_PATH, produces = MediaType.APPLICATION_JSON_VALUE)
    public String jwks() {
        return signingKey.getPublicJwkSetJson();
    }
}
