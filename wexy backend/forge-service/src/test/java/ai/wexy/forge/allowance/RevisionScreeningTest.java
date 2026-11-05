package ai.wexy.forge.allowance;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.safety.ContentSafety;
import ai.wexy.forge.safety.RecordedContentSafety;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * EA9.4 (the frontend's agent-first studio design §12; the user, 2026-11-04: "build screening now"): a revision's base
 * words pass content safety before its prompt is joined or a new one granted, in pieces Azure takes whole. The route's
 * own tests (AgentRoutesTest) hold the order end to end; these hold the pieces and the order against the grants.
 */
class RevisionScreeningTest {

    private static final Caller ANONYMOUS = new Caller("u1", true, false, "anonymous", "net-a");

    /** A revision whose base is `creatorWords` and no world's words: most cases need no more. */
    private static Grant revise(PromptAdmission admission, String named, String turnId, String prompt, List<String> creatorWords) {
        return admission.revision(ANONYMOUS, named, turnId, prompt, creatorWords, List.of());
    }

    /** Every text the safety was asked about, in order; refuses the recorded phrases. */
    private static final class Seen implements ContentSafety {
        final List<String> texts = new ArrayList<>();
        final RecordedContentSafety recorded = new RecordedContentSafety();

        @Override
        public Verdict check(String text) {
            texts.add(text);
            return recorded.check(text);
        }
    }

    @Test
    void wordsArePiecedAtLineEndsWithinTheCapAndALongLineIsCutWhole() {
        assertThat(PromptAdmission.pieces(List.of(), 10)).isEmpty();
        assertThat(PromptAdmission.pieces(List.of(" ", ""), 10)).as("nothing to check").isEmpty();
        assertThat(PromptAdmission.pieces(List.of("ab", "cd", "efg"), 10)).containsExactly("ab\ncd\nefg");
        // A piece ends at a line's end before the cap: "abcd\nefgh" is 9, a third line would make it 14.
        assertThat(PromptAdmission.pieces(List.of("abcd", "efgh", "ijkl"), 10)).containsExactly("abcd\nefgh", "ijkl");
        // A line past the cap alone is cut, at the cap, and its rest starts the next piece.
        assertThat(PromptAdmission.pieces(List.of("ab", "0123456789xyz", "cd"), 10)).containsExactly("ab", "0123456789", "xyz\ncd");
        // Never inside a surrogate pair: the castle emoji (two UTF-16 units) stays whole.
        String castle = new String(Character.toChars(0x1F3F0));
        assertThat(PromptAdmission.pieces(List.of("012345678" + castle), 10)).containsExactly("012345678", castle);
        for (String piece : PromptAdmission.pieces(List.of("x".repeat(25_000), "y".repeat(9_999)), PromptAdmission.SAFETY_CHARS)) {
            assertThat(piece.length()).isLessThanOrEqualTo(PromptAdmission.SAFETY_CHARS);
        }
    }

    @Test
    void anUnsafeBaseIsRefusedBeforeItsPromptIsJoinedOrANewOneGranted() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        Seen safety = new Seen();
        PromptAdmission admission = new PromptAdmission(grants, safety);
        Grant granted = admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        assertThat(granted).isNotNull();

        // The unsafe words sit in a long base, past one piece: the whole base is screened, not its first piece only.
        List<String> words = new ArrayList<>(List.of("ev-1.f1", "creator", "x".repeat(9_990)));
        words.add("the castle is a bloody massacre of villagers");
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-2", "a castle on a hill", words))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED));
        // The entry's idea, then the base's three pieces: the third holds the words and refuses.
        assertThat(safety.texts).hasSize(1 + 3);
        // No revision of the prompt's three was counted: three clean ones still join it.
        for (int i = 0; i < 3; i++) {
            assertThat(revise(admission, "turn-1", "turn-r" + i, "a castle on a hill", List.of("creator", "the towers are too tall")))
                    .as("revision %d joins the prompt", i + 1).isNull();
        }
        assertThat(store.granted()).isEqualTo(1);
    }

    @Test
    void aBaseNamingNoTurnIsScreenedBeforeItsOwnEntry() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptAdmission admission = new PromptAdmission(new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC()), new Seen());
        assertThatThrownBy(() -> revise(admission, null, "turn-2", "a castle on a hill", List.of("creator", "[recorded unsafe: hate]")))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED));
        assertThat(store.granted()).as("an entry refused for its base grants nothing").isZero();
    }

    /**
     * The EA9.4 review, its mid: a caller who may not revise (naming no turn, one it does not have, its turn under another
     * idea, or its prompt's revisions spent) and has no entry left is refused as an entry is, at once, with the
     * allowance's words, and no safety call is spent on the base it could never send.
     */
    @Test
    void aCallerWhoMayNotReviseIsRefusedBeforeItsBaseIsScreened() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        Seen safety = new Seen();
        PromptAdmission admission = new PromptAdmission(grants, safety);
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        List<String> words = List.of("creator", "the towers are too tall");
        int asked = safety.texts.size();

        for (String named : Arrays.asList(null, "turn-x")) {
            assertThatThrownBy(() -> revise(admission, named, "turn-2", "a castle on a hill", words))
                    .as("naming %s", named).isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        }
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-2", "a lighthouse on a cliff", words))
                .as("its own turn under another idea").isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(safety.texts).as("no screening asked of a base it could never send").hasSize(asked);

        // Its three revisions, each screened once; the fourth, past them, is refused before it is screened.
        for (int i = 0; i < 3; i++) {
            assertThat(revise(admission, "turn-1", "turn-r" + i, "a castle on a hill", words)).isNull();
        }
        assertThat(safety.texts).hasSize(asked + 3);
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-r4", "a castle on a hill", words))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(safety.texts).hasSize(asked + 3);
        assertThat(store.granted()).isEqualTo(1);
    }

    /** The eligibility read writes nothing: however often it is asked, the prompt's three revisions are all still there. */
    @Test
    void askingWhetherARevisionMayJoinCountsNothing() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        new PromptAdmission(grants, new Seen()).entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        String hash = PromptAdmission.sha256("a castle on a hill");
        for (int i = 0; i < 10; i++) {
            assertThat(grants.canJoin(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, hash)).isTrue();
        }
        for (int i = 0; i < 3; i++) {
            assertThat(grants.join(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, hash, "turn-r" + i)).as("revision %d", i + 1).isTrue();
        }
        assertThat(grants.canJoin(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, hash)).as("past its three").isFalse();
        assertThat(grants.canJoin(ANONYMOUS, "turn-1", PromptGrants.Kind.MODULE, hash)).as("another kind's budget is its own").isTrue();
        assertThat(grants.canJoin(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, PromptAdmission.sha256("a lighthouse"))).isFalse();
        assertThat(grants.canJoin(new Caller("u2", true, false, "anonymous", "net-b"), "turn-1", PromptGrants.Kind.MODULE, hash))
                .as("another caller's turn").isFalse();
        assertThat(grants.canJoin(ANONYMOUS, null, PromptGrants.Kind.REVISION, hash)).isFalse();
    }

    // ---- The second EA9.4 review ---------------------------------------------------------------------------------------

    /** Its L3: a revision that is an entry screens its idea first, one short call, so an unsafe idea spends no piece. */
    @Test
    void anEntrysIdeaIsScreenedBeforeItsBase() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        Seen safety = new Seen();
        PromptAdmission admission = new PromptAdmission(new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC()), safety);
        List<String> base = List.of("creator", "x".repeat(9_990), "the towers are too tall");
        assertThatThrownBy(() -> revise(admission, null, "turn-2", "a bloody massacre of villagers", base))
                .isInstanceOfSatisfying(ForgeException.class, e -> {
                    assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED);
                    assertThat(e.getMessage()).isEqualTo("This idea can't be made here. Try a different one.");
                });
        assertThat(safety.texts).as("the idea alone").hasSize(1);
        // A clean idea: the idea once, then the base (the grant's own entry does not ask again).
        assertThat(revise(admission, null, "turn-3", "a castle on a hill", base)).isNotNull();
        assertThat(safety.texts).hasSize(1 + 1 + 2);
        assertThat(store.granted()).isEqualTo(1);
    }

    /** Its M2: the creator's words first, refused in their terms; the world's (design, program), as a world unchangeable here. */
    @Test
    void theWorldsWordsAreRefusedAsAWorldTheCreatorCannotChangeByRephrasing() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        Seen safety = new Seen();
        PromptAdmission admission = new PromptAdmission(grants, safety);
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        assertThatThrownBy(() -> admission.revision(ANONYMOUS, "turn-1", "turn-2", "a castle on a hill",
                List.of("creator", "an explicit nude scene"), List.of("[recorded unsafe: hate]")))
                .isInstanceOfSatisfying(ForgeException.class, e -> {
                    assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED);
                    assertThat(e.getMessage()).isEqualTo(PromptAdmission.WORDS_REFUSED);
                });
        assertThatThrownBy(() -> admission.revision(ANONYMOUS, "turn-1", "turn-2", "a castle on a hill",
                List.of("creator", "the towers are too tall"), List.of("Blocks under a sepia film.", "[recorded unsafe: hate]")))
                .isInstanceOfSatisfying(ForgeException.class, e -> {
                    assertThat(e.code()).as("its own code: the studio offers a new idea").isEqualTo(ErrorCode.WORLD_REFUSED);
                    assertThat(e.getMessage()).isEqualTo(PromptAdmission.WORLD_REFUSED);
                });
        // Neither refusal counted a revision: the prompt's three are all still there.
        for (int i = 0; i < 3; i++) {
            assertThat(revise(admission, "turn-1", "turn-r" + i, "a castle on a hill", List.of("creator", "the towers are too tall"))).isNull();
        }
    }

    /** Its M1: words joined into an identifier are screened spelled out too, whatever the text: an idea, a finding, the world's. */
    @Test
    void joinedWordsAreScreenedSpelledOut() {
        assertThat(PromptAdmission.spelledOut("make_it_a_bloody_massacre_of_villagers")).isEqualTo("make it a bloody massacre of villagers");
        assertThat(PromptAdmission.spelledOut("_an_explicit-nüde.scene")).isEqualTo("an explicit nüde scene");
        assertThat(PromptAdmission.spelledOut("anEXPLICITNudeScene")).isEqualTo("an EXPLICIT Nude Scene");
        assertThat(PromptAdmission.spelledOut("placeBlocks")).isEqualTo("place Blocks");
        assertThat(PromptAdmission.withSpelled(List.of("A phrase, with spaces.", "snake_case", " ", "instance14")))
                .as("a plain phrase and a plain word stay one line; a joined one gains its spelling").containsExactly(
                        "A phrase, with spaces.", "snake_case", "snake case", "instance14");

        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        PromptAdmission admission = new PromptAdmission(grants, new Seen());
        assertThatThrownBy(() -> admission.entry(ANONYMOUS, "turn-0", "an_explicit_nude_scene", "turn"))
                .as("an idea").isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED));
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        assertThatThrownBy(() -> admission.revision(ANONYMOUS, "turn-1", "turn-2", "a castle on a hill",
                List.of("creator", "make_it_a_bloody_massacre_of_villagers"), List.of()))
                .as("the creator's").isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED));
        for (String world : List.of("_an_explicit_nude_scene", "anEXPLICITNudeScene")) {
            assertThatThrownBy(() -> admission.revision(ANONYMOUS, "turn-1", "turn-2", "a castle on a hill",
                    List.of("creator", "the towers are too tall"), List.of(world)))
                    .as("the world's %s", world).isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.WORLD_REFUSED));
        }
    }

    /**
     * Its test gap 3: a join lost while the base was screened (another revision took the prompt's last ones meanwhile) is
     * an entry, never a fourth revision: here a spent anonymous caller's, so refused.
     */
    @Test
    void aJoinLostWhileTheBaseWasScreenedIsAnEntry() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        String hash = PromptAdmission.sha256("a castle on a hill");
        int[] raced = {0};
        ContentSafety racing = text -> {
            if (text.contains("race now") && raced[0] == 0) {
                for (int i = 0; i < 3; i++) {
                    raced[0] += grants.join(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, hash, "turn-other" + i) ? 1 : 0;
                }
            }
            return new ContentSafety.Verdict(true, Map.of("Hate", 0, "SelfHarm", 0, "Sexual", 0, "Violence", 0));
        };
        PromptAdmission admission = new PromptAdmission(grants, racing);
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        assertThat(grants.canJoin(ANONYMOUS, "turn-1", PromptGrants.Kind.REVISION, hash)).isTrue();
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-2", "a castle on a hill", List.of("creator", "race now")))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ACCOUNT_REQUIRED));
        assertThat(raced[0]).as("the other revisions took all three").isEqualTo(3);
        assertThat(store.granted()).isEqualTo(1);
    }

    /** Its L1, through the admission: a phrase the 10,000-character cut falls inside is read whole in the next piece. */
    @Test
    void aPhraseACutFallsInsideIsReadWholeInTheNextPiece() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        Seen safety = new Seen();
        PromptAdmission admission = new PromptAdmission(grants, safety);
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        String phrase = "a bloody massacre of villagers";
        String line = "x".repeat(9_990) + " " + phrase;
        assertThat(line.indexOf(phrase)).as("the phrase starts before the cut at 10,000").isLessThan(PromptAdmission.SAFETY_CHARS);
        assertThat(line.indexOf(phrase) + phrase.length()).as("and ends after it").isGreaterThan(PromptAdmission.SAFETY_CHARS);
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-2", "a castle on a hill", List.of(line)))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CONTENT_REFUSED));
        assertThat(safety.texts.get(1)).doesNotContain("a bloody massacre of villagers");
        assertThat(safety.texts.get(2)).contains("a bloody massacre of villagers");
    }

    /** Its test gap 4 and its L1, L5: a piece sits exactly on the cap; the next reads the end of the one before again. */
    @Test
    void piecesSitOnTheCapReadTheirCutAgainAndRefuseArgumentsThatCannotMoveOn() {
        assertThat(PromptAdmission.pieces(List.of("abcd", "efghi"), 10)).as("exactly 10, newline counted").containsExactly("abcd\nefghi");
        assertThat(PromptAdmission.pieces(List.of("abcde", "efghi"), 10)).containsExactly("abcde", "efghi");
        assertThat(PromptAdmission.pieces(List.of("abcd", "efgh", "ijkl"), 10, 3)).as("a line across the cut, read again")
                .containsExactly("abcd\nefgh", "fgh\nijkl");
        assertThat(PromptAdmission.pieces(List.of("0123456789abcdef"), 10, 2)).containsExactly("0123456789", "89abcdef");
        // A phrase split across two words at a cut is whole in the next piece.
        List<String> words = List.of("x".repeat(9_980), "a bloody massacre", "of villagers");
        List<String> read = PromptAdmission.pieces(words, PromptAdmission.SAFETY_CHARS, PromptAdmission.SAFETY_OVERLAP);
        assertThat(read).anyMatch(p -> p.contains("a bloody massacre\nof villagers"));
        for (String p : PromptAdmission.pieces(List.of("x".repeat(25_000), "y".repeat(9_999), "z"), PromptAdmission.SAFETY_CHARS,
                PromptAdmission.SAFETY_OVERLAP)) {
            assertThat(p.length()).isLessThanOrEqualTo(PromptAdmission.SAFETY_CHARS);
        }
        String castle = new String(Character.toChars(0x1F3F0));
        for (String p : PromptAdmission.pieces(List.of(castle.repeat(30)), 7, 3)) {
            assertThat(Character.isLowSurrogate(p.charAt(0))).as("never starts inside a pair: %s", p).isFalse();
            assertThat(Character.isHighSurrogate(p.charAt(p.length() - 1))).as("never ends inside one").isFalse();
        }
        assertThatThrownBy(() -> PromptAdmission.pieces(List.of(castle), 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PromptAdmission.pieces(List.of("ab"), 10, 5)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void noVerdictNoRevision() {
        InMemoryGrantStore store = new InMemoryGrantStore(Clock.systemUTC());
        PromptGrants grants = new PromptGrants(store, TestAdmissions.strict(), Clock.systemUTC());
        boolean[] down = {false};
        PromptAdmission admission = new PromptAdmission(grants, text -> {
            if (down[0]) {
                throw new ForgeException(ErrorCode.UNAVAILABLE, "Live creation is unavailable right now: ideas cannot be checked.");
            }
            return new ContentSafety.Verdict(true, Map.of("Hate", 0, "SelfHarm", 0, "Sexual", 0, "Violence", 0));
        });
        admission.entry(ANONYMOUS, "turn-1", "a castle on a hill", "turn");
        down[0] = true;
        assertThatThrownBy(() -> revise(admission, "turn-1", "turn-2", "a castle on a hill", List.of("creator", "the towers are too tall")))
                .isInstanceOfSatisfying(ForgeException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.UNAVAILABLE));
        down[0] = false;
        for (int i = 0; i < 3; i++) {
            assertThat(revise(admission, "turn-1", "turn-r" + i, "a castle on a hill", List.of("creator", "the towers are too tall"))).isNull();
        }
    }
}
