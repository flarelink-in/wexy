package ai.wexy.forge.loop;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.records.Ulid;
import ai.wexy.forge.templates.HostContract;

/**
 * {@code POST /v1/forge/author} (forge-loop design §5.1): which plan, and which of its functions to
 * write. The plan's text comes from the store, never from the client (I4).
 */
public record AuthorRequest(String planId, String fn) {

    /** An id this service could not have issued is simply not a plan it knows: 404, as for a stranger's. */
    AuthorRequest validated() {
        if (fn == null || !HostContract.FUNCTIONS.contains(fn)) {
            throw new ForgeException(ErrorCode.BAD_REQUEST, "fn must be one of " + HostContract.FUNCTIONS + ".");
        }
        if (!Ulid.looksLikeOne(planId)) {
            throw LoopHandler.unknownWorld();
        }
        return this;
    }
}
