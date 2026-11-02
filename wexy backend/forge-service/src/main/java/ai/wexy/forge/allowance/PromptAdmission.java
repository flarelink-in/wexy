package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.safety.ContentSafety;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * What a request must pass before forge records or charges anything (W1; the creations platform design §11, I6, I11,
 * I12). An entry, in this order: the caller's allowance (refused at once when spent, so no safety check is spent on
 * it), the idea's content safety (refused with {@code 422 content-refused}, which spends nothing), then one atomic
 * grant. A follow-up that names its prompt runs inside it, within its budget. Blocking: call it off the event loop.
 */
@Component
public class PromptAdmission {

    private static final Logger log = LoggerFactory.getLogger(PromptAdmission.class);

    private final PromptGrants grants;
    private final ContentSafety safety;

    public PromptAdmission(PromptGrants grants, ContentSafety safety) {
        this.grants = grants;
        this.safety = safety;
    }

    /** An entry request (a plan, a turn without a base): its grant, or the refusal. `route` names it in the log. */
    public Grant entry(Caller caller, String entryId, String text, String route) {
        grants.check(caller);
        checkSafety(text, route);
        return grants.grant(caller, entryId, sha256(text));
    }

    /**
     * A turn that revises the one its base names: inside that turn's prompt (null) when the caller has it, a revision is
     * left (three, the candidate's Q_C), and it carries the same prompt, which was checked when it was granted; an entry
     * otherwise.
     */
    public Grant revision(Caller caller, String namedTurnId, String turnId, String prompt) {
        if (namedTurnId != null && grants.join(caller, namedTurnId, PromptGrants.Kind.REVISION, sha256(prompt), turnId)) {
            return null;
        }
        return entry(caller, turnId, prompt, "turn");
    }

    /**
     * A Director turn: its instruction is the creator's own words each time, so it is always checked; then inside its
     * plan's prompt (null) when it names one of the caller's with a turn left, an entry of its own otherwise.
     */
    public Grant director(Caller caller, String planId, String directId, String turn) {
        checkSafety(turn, "direct");
        if (planId != null && grants.join(caller, planId, PromptGrants.Kind.DIRECTOR, null, null)) {
            return null;
        }
        grants.check(caller);
        return grants.grant(caller, directId, sha256(turn));
    }

    private void checkSafety(String text, String route) {
        ContentSafety.Verdict verdict = safety.check(text);
        if (!verdict.allowed()) {
            // Categories and severities only: never the text (§13).
            log.info("safety.refused route={} categories={}", route, verdict.shown());
            throw new ForgeException(ErrorCode.CONTENT_REFUSED, "This idea can't be made here. Try a different one.");
        }
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }
}
