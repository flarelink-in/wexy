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
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

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

    /** An entry request (a turn without a base): its grant, or the refusal. `route` names it in the log. */
    public Grant entry(Caller caller, String entryId, String text, String route) {
        grants.check(caller);
        checkSafety(text, route);
        return grants.grant(caller, entryId, sha256(text));
    }

    /** A creator's words refused (a revision's findings): theirs to say another way. */
    static final String WORDS_REFUSED = "These words can't be used here. Try saying the change another way.";
    /**
     * A world's own words refused (a revision's design or program): rephrasing an "Improve it" would not help, so it
     * travels as its own code, {@code world-refused}, for the studio to offer a new idea (the second EA9.4 review).
     */
    static final String WORLD_REFUSED = "This world can't be changed here. Try a different idea.";

    /**
     * A turn that revises the one its base names: inside that turn's prompt (null) when the caller has it, a revision is
     * left (three, the candidate's Q_C), and it carries the same prompt, which was checked when it was granted; an entry
     * otherwise.
     *
     * <p>Its base's words are screened (EA9.4; the frontend's agent-first studio design §12): every finding's text,
     * whatever it is called, the design's and the program's ({@code AgentBase.words()}). A creator's "Improve it" rides
     * there, and a client may send anything there, so they are screened as an idea is, before a revision is joined or
     * granted and before any model call. A refusal spends nothing: no revision is counted, no prompt granted. No verdict,
     * no revision.
     *
     * <p>Who may revise is read first, writing nothing (the EA9.4 review, its mid): a caller who can neither join the named
     * turn's prompt nor make an entry is refused as an entry is, at once, so no safety call is spent on a base it could
     * never send, and it hears the allowance's words, not a safety outage's. The join stays after the screening, atomic,
     * so a refused base spends no revision; a join lost to a concurrent one meanwhile is an entry, checked again.
     *
     * <p>The order (the second EA9.4 review): an entry's idea first, one short call, so an unsafe idea spends none of the
     * base's; then the creator's words, refused in the creator's terms; then the world's (its design and program),
     * refused as a world that cannot be changed.
     */
    public Grant revision(Caller caller, String namedTurnId, String turnId, String prompt, List<String> creatorWords,
                          List<String> worldWords) {
        String hash = sha256(prompt);
        boolean joinable = namedTurnId != null && grants.canJoin(caller, namedTurnId, PromptGrants.Kind.REVISION, hash);
        if (!joinable) {
            grants.check(caller);
            checkSafety(prompt, "turn");
        }
        checkSafety(creatorWords, "revision", ErrorCode.CONTENT_REFUSED, WORDS_REFUSED);
        checkSafety(worldWords, "revision", ErrorCode.WORLD_REFUSED, WORLD_REFUSED);
        if (joinable && grants.join(caller, namedTurnId, PromptGrants.Kind.REVISION, hash, turnId)) {
            return null;
        }
        if (!joinable) {
            // Its idea and its base screened above: the grant alone is left.
            return grants.grant(caller, turnId, hash);
        }
        return entry(caller, turnId, prompt, "turn");
    }

    /** A follow-up refused (Q120 (b)): never an entry, so the creator's next Create is one, and is told so first. */
    static final String CANNOT_FOLLOW = "This try can't be continued, so a new Create makes a new world.";
    /**
     * How long a follow-up waits for the end of the turn it follows when none is written yet, and how often it reads
     * again (the independent review of EA9.5, its mid): a creator's Stop, or a dropped connection, ends that turn only once
     * this service sees its client leave and the loop unwinds, so a second try pressed at once would find no end and be
     * refused for good. A turn still running past the wait is refused.
     */
    static final long UNWIND_WAIT_MILLIS = 3_000;
    static final long UNWIND_POLL_MILLIS = 100;

    /**
     * A turn that follows `namedTurnId`, a turn of the caller's that ended with no world (Q120 (b), the user, 2026-11-05:
     * "Build the follow-up"; EA9.5; the creations platform design §10, "Q120's follow-up"): inside that turn's prompt,
     * once, as its grant. In this order, before any record or charge:
     * <ol>
     *   <li>who may follow, read and writing nothing: the turn is the caller's (by uid, so a link keeps it), its prompt
     *       alive, its end written and without a world, its follow-up unspent. Otherwise {@code 409 conflict}, with no
     *       safety call spent on it, and never an entry: a refused follow-up never falls through to a fresh grant;</li>
     *   <li>its idea, when it differs from the prompt's (an answer to a question, a simpler idea): content safety, as an
     *       entry's ({@code 422 content-refused}, which spends nothing, the follow-up included). The same idea was checked
     *       when the prompt was granted;</li>
     *   <li>the join, atomic: the checks again, so a race's loser is {@code 409} too.</li>
     * </ol>
     * The grant is spent at the turn's first dispatched call and given back when it dispatched none, as an entry's. A turn
     * whose end is not written yet is waited for, up to {@link #UNWIND_WAIT_MILLIS}: it may be unwinding from a Stop.
     */
    public Grant followUp(Caller caller, String namedTurnId, String turnId, String prompt) {
        String hash = sha256(prompt);
        GrantStore.Follow may = grants.canFollow(caller, namedTurnId, hash);
        for (long waited = 0; may == GrantStore.Follow.OPEN && waited < UNWIND_WAIT_MILLIS; waited += UNWIND_POLL_MILLIS) {
            try {
                Thread.sleep(UNWIND_POLL_MILLIS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            may = grants.canFollow(caller, namedTurnId, hash);
        }
        if (may != GrantStore.Follow.SAME && may != GrantStore.Follow.CHANGED) {
            log.info("allowance.follow-up refused={}", may.name().toLowerCase());
            throw new ForgeException(ErrorCode.CONFLICT, CANNOT_FOLLOW);
        }
        if (may == GrantStore.Follow.CHANGED) {
            checkSafety(prompt, "follow-up");
        }
        Grant joined = grants.follow(caller, namedTurnId, turnId, hash);
        if (joined == null) {
            throw new ForgeException(ErrorCode.CONFLICT, CANNOT_FOLLOW);
        }
        return joined;
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
     * A model's review of the world on the stage (EA6.4): as a module call, inside its turn's prompt or refused, never an
     * entry of its own, carrying the prompt its turn was granted for, with a review left: {@code 404} as for a turn that is
     * not the caller's, {@code 429 rate} when the prompt's reviews are spent. Blocking.
     */
    public void review(Caller caller, String turnId, String prompt) {
        switch (grants.follow(caller, turnId, PromptGrants.Kind.REVIEW, sha256(prompt), null)) {
            case JOINED -> { }
            case FULL -> throw new ForgeException(ErrorCode.RATE, "This prompt has made all of its reviews.");
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

    /** One text (an idea, a follow-up's changed idea), with its joined words spelled out where it has any (the EA9.4 review). */
    private void checkSafety(String text, String route) {
        String spelled = JOINED.matcher(text).find() ? spelledOut(text) : "";
        ContentSafety.Verdict verdict = safety.check(spelled.isEmpty() || spelled.equals(text) ? text : text + "\n" + spelled);
        if (!verdict.allowed()) {
            // Categories and severities only: never the text (§13).
            log.info("safety.refused route={} categories={}", route, verdict.shown());
            throw new ForgeException(ErrorCode.CONTENT_REFUSED, "This idea can't be made here. Try a different one.");
        }
    }

    /**
     * Content safety over `words` (a revision's base, EA9.4), one a line, each joined one spelled out on the next (the
     * second EA9.4 review), in pieces of at most {@link #SAFETY_CHARS} characters, Azure's cap on one text, each reading
     * {@link #SAFETY_OVERLAP} of the one before again. Any piece refused refuses them all, as `code` with `refused`'s
     * words; a piece with no verdict is {@code 503}, as for an idea. Nothing to check is nothing refused.
     */
    private void checkSafety(List<String> words, String route, ErrorCode code, String refused) {
        for (String piece : pieces(withSpelled(words), SAFETY_CHARS, SAFETY_OVERLAP)) {
            ContentSafety.Verdict verdict = safety.check(piece);
            if (!verdict.allowed()) {
                log.info("safety.refused route={} categories={}", route, verdict.shown());
                throw new ForgeException(code, refused);
            }
        }
    }

    /** Azure AI Content Safety's cap on one text, in characters (UTF-16 units, so a surrogate pair counts as two). */
    static final int SAFETY_CHARS = 10_000;
    /** How much of a piece's end the next piece reads again, so a phrase across a cut is read whole (the second review). */
    static final int SAFETY_OVERLAP = 500;

    /** Words joined by anything but a space (snake, kebab, dotted, camel case): screened spelled out too. */
    static final Pattern JOINED = Pattern.compile("[\\p{L}\\p{N}][^\\p{L}\\p{N}\\s]+[\\p{L}\\p{N}]|[\\p{Ll}\\p{Nd}]\\p{Lu}");
    private static final Pattern CAPS_THEN_WORD = Pattern.compile("(\\p{Lu}+)(\\p{Lu}\\p{Ll})");
    private static final Pattern LOWER_THEN_UPPER = Pattern.compile("([\\p{Ll}\\p{Nd}])(\\p{Lu})");
    private static final Pattern NOT_A_WORD = Pattern.compile("[^\\p{L}\\p{N}]+");

    /**
     * `text` as words: every run of what is neither a letter nor a digit a space, and a word split where a capital starts
     * one ({@code _an_explicit-nüde.scene} → "an explicit nüde scene", {@code anEXPLICITNudeScene} → "an EXPLICIT Nude
     * Scene"). Content safety reads text; a phrase joined into an identifier is read this way too.
     */
    static String spelledOut(String text) {
        String s = CAPS_THEN_WORD.matcher(text).replaceAll("$1 $2");
        s = LOWER_THEN_UPPER.matcher(s).replaceAll("$1 $2");
        return NOT_A_WORD.matcher(s).replaceAll(" ").strip();
    }

    /** Each word, then, where it joins words, the same spelled out (blank words left out). */
    static List<String> withSpelled(List<String> words) {
        List<String> out = new ArrayList<>();
        for (String word : words) {
            if (word == null || word.isBlank()) {
                continue;
            }
            out.add(word);
            if (JOINED.matcher(word).find()) {
                String spelled = spelledOut(word);
                if (!spelled.isEmpty() && !spelled.equals(word)) {
                    out.add(spelled);
                }
            }
        }
        return out;
    }

    /** As {@link #pieces(List, int, int)}, with nothing read again. */
    static List<String> pieces(List<String> words, int max) {
        return pieces(words, max, 0);
    }

    /**
     * `words` as one text, a line each (blank ones left out), in pieces of at most `max` characters, in order: a piece ends
     * at its last line's end where one adds text, else at `max`, never inside a surrogate pair; the next starts `overlap`
     * characters before it ended (with none, at the next line), so a phrase across the cut is read whole there.
     *
     * @throws IllegalArgumentException unless `max` is at least 2 and `overlap` under half of it (each piece moves on)
     */
    static List<String> pieces(List<String> words, int max, int overlap) {
        if (max < 2 || overlap < 0 || 2 * overlap >= max) {
            throw new IllegalArgumentException("pieces of " + max + " characters cannot read " + overlap + " again");
        }
        StringBuilder all = new StringBuilder();
        for (String word : words) {
            if (word == null || word.isBlank()) {
                continue;
            }
            if (!all.isEmpty()) {
                all.append('\n');
            }
            all.append(word);
        }
        String text = all.toString();
        List<String> out = new ArrayList<>();
        int start = 0;
        int done = 0;
        while (done < text.length()) {
            int limit = Math.min(text.length(), start + max);
            int end = limit;
            if (limit < text.length()) {
                int line = text.lastIndexOf('\n', limit);
                if (line > done) {
                    end = line;
                } else if (Character.isHighSurrogate(text.charAt(limit - 1))) {
                    end = limit - 1;
                }
            }
            out.add(text.substring(start, end));
            done = end;
            if (end >= text.length()) {
                break;
            }
            int next = overlap > 0 ? Math.max(start + 1, end - overlap) : end + (text.charAt(end) == '\n' ? 1 : 0);
            if (next < text.length() && Character.isLowSurrogate(text.charAt(next))) {
                next++;
            }
            start = next;
        }
        return out;
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }
}
