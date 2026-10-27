package ai.wexy.gateway.appcheck;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.GatewayRejection;

/**
 * An App Check refusal. The client sees {@code appcheck} either way; the reason is for the logs,
 * the meters and the tests, because a replayed genuine token (a script) and an invalid one (a stale
 * build, a forgery) are different incidents.
 */
public class AppCheckRejection extends GatewayRejection {

    public enum Reason { INVALID, REPLAYED }

    private final Reason reason;

    public AppCheckRejection(Reason reason) {
        super(ErrorCode.APPCHECK, "This request could not be verified as coming from the Wexy app.");
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
