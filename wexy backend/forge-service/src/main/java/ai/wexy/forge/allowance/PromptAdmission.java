package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.safety.ContentSafety;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;

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

    /**
     * A module call (the W1 review, 2026-11-02): inside its turn's prompt or refused, never an entry of its own. It must
     * carry the prompt its turn was granted for, whose text was checked then, so it is not checked again; the grant must
     * still be alive and the caller's, with a module call left. Otherwise nothing is recorded or sent: {@code 404} as for
     * a turn that is not the caller's, or {@code 429 rate} when the prompt's module calls are spent (the studio says it as
     * too many, never as a sign-in failure). Blocking.
     */
    public void module(Caller caller, String turnId, String prompt) {
        switch (grants.follow(caller, turnId, PromptGrants.Kind.MODULE, sha256(prompt), null)) {
            case JOINED -> { }
            case FULL -> throw new ForgeException(ErrorCode.RATE, "This prompt has made all of its module calls.");
            case NONE -> throw new ForgeException(ErrorCode.NOT_FOUND, "This turn isn't available.");
        }
    }

    /**
     * Runs an admission off the event loop (Redis, content safety): its grant, empty for a follow-up inside its prompt, or
     * the refusal as an error. A request cancelled meanwhile gets nothing, and the grant goes back at once, since no model
     * call can follow it (§11: given back while nothing was dispatched). The admission runs in a task the cancel does not
     * interrupt: an interrupt inside the grant's own Redis step could leave it written with no {@link Grant} to give back
     * (the W1 review, 2026-11-02).
     */
    public static Mono<Optional<Grant>> offLoop(Callable<Grant> admit) {
        return Mono.<Optional<Grant>>create(sink -> {
                    AtomicBoolean cancelled = new AtomicBoolean();
                    sink.onCancel(() -> cancelled.set(true));
                    Schedulers.boundedElastic().schedule(() -> {
                        Grant grant;
                        try {
                            grant = admit.call();
                        } catch (Throwable e) {
                            sink.error(e);
                            return;
                        }
                        if (cancelled.get()) {
                            if (grant != null) {
                                grant.release();
                            }
                            return;
                        }
                        sink.success(Optional.ofNullable(grant));
                    });
                })
                // A cancel between that check and the delivery: the sink drops the value, and its grant goes back too,
                // off the canceller's thread (the release is a Redis step).
                .doOnDiscard(Optional.class, dropped -> dropped.ifPresent(grant ->
                        Schedulers.boundedElastic().schedule(((Grant) grant)::release)));
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
