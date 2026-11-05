// "Shape it" for an agent world, in the creator's words (EA9.4; agent-first-studio-design.md §9; Q121, and the user's Q118
// answer of 11-03: "a chat window style new prompt to ask them to improve if any missed and then show again just like we
// have in agent=1"). It is `?agent=1`'s review flow (loop/review.ts's StageReviews) over the same controller, in plain
// words:
//   - an ask, then a thread: each change the creator asked for, and what came of it;
//   - "Looks right": a pass, recorded, nothing spent;
//   - the composer: the creator's words, sent as one round of "Improve it" (a program revision inside the world's grant,
//     which the backend screens first, EA9.4), while the Journey shows the work; then Show it, the GPU go (Q115 (a)), the
//     world before it drawing until then;
//   - how many improvements are left (Q_C's rounds): a count, never a percentage (design guidelines §2).
// A world with no session to improve it (a starter, a saved world reopened, a saved attempt replayed) says it was made
// earlier; one whose own words content safety refused (the backend's `world-refused`) says it can't be changed here, and
// offers no change again. Only the creator's own words are shown, as text; no frame, finding, code, id or model name
// (§2's P5). Neither
// the panel nor "Improve it" sends a frame anywhere: a model's review stays in Developer view, behind its own consent.

import { IMPROVE_WORDS } from '../../loop/candidate';
import { COPY } from '../../loop/copy';
import type { CreationController, CreationState } from '../../loop/creation';
import { sentenceOf, type ReviewRecord, type StageReviews } from '../../loop/review';
import { h } from '../../shared/dom';

/** What is on the stage, as this panel needs it: a creation's world (improvable), or one made earlier (not here). */
export type StagedKind = 'creation' | 'earlier';

export interface ImproveParts {
    readonly reviews: StageReviews;
    readonly creation: CreationController;
    /** The device was lost: nothing more is shown until a reload. */
    lost(): boolean;
}

interface Entry {
    readonly who: 'creator' | 'studio';
    readonly text: string;
}

/** At most this many entries are kept in a world's thread; the oldest go first. */
const THREAD = 12;
let ids = 0;

/** `el`'s text, replaced only when it differs. */
const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
};

export class ImproveView {
    readonly el: HTMLElement;
    private readonly parts: ImproveParts;
    private readonly thread = h('ol', { class: 'imp-thread', 'aria-label': 'What you asked for' });
    private readonly status = h('p', { class: 'imp-status', role: 'status', 'aria-live': 'polite' });
    private readonly showBtn = h('button', { type: 'button', class: 'btn btn-sm imp-show', hidden: true }, COPY.improve.show);
    private readonly lookBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', hidden: true }, COPY.improve.lookAgain);
    private readonly looksBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet imp-looks' }, COPY.improve.looksRight);
    private readonly wordsId = `imp-words-${++ids}`;
    private readonly words = h('textarea', {
        id: this.wordsId, class: 'imp-words', rows: '3', maxlength: String(IMPROVE_WORDS), placeholder: COPY.improve.placeholder,
    }) as HTMLTextAreaElement;
    private readonly sendBtn = h('button', { type: 'button', class: 'btn btn-sm imp-send' }, COPY.improve.send);
    private readonly left = h('p', { class: 'imp-left' });
    private readonly composer: HTMLElement;
    /** What is on the stage: set at each install by the studio; null for none, h1's world or the backdrop. */
    private staged: StagedKind | null = null;
    private entries: Entry[] = [];
    /** A press of "Improve it" from its click until its round answers: a second press in between does nothing. */
    private pressing = false;
    /** What the status line last said, so a screen reader hears each change once, never a repeat (E6). */
    private said = '';
    /** Each world put on the stage, counted: a round's answer that comes after another world arrived is not this one's. */
    private installs = 0;

    constructor(parts: ImproveParts) {
        this.parts = parts;
        this.looksBtn.addEventListener('click', () => this.looksRight());
        // A double click is one press, as Show it's (its second click lands after the label turned).
        this.sendBtn.addEventListener('click', e => {
            if (e.detail > 1) return;
            void this.improve();
        });
        this.showBtn.addEventListener('click', e => {
            if (e.detail > 1) return;
            void this.parts.creation.show();
        });
        this.lookBtn.addEventListener('click', () => void this.parts.reviews.capture());
        this.words.addEventListener('input', () => this.render());
        this.words.addEventListener('keydown', e => {
            // Ctrl+Enter here sends the change: the page's own shortcut (Create, Show it) is not this box's.
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) void this.improve();
            }
        });
        this.composer = h('div', { class: 'imp-composer' },
            h('label', { class: 'imp-label', for: this.wordsId }, COPY.improve.label),
            this.words,
            h('div', { class: 'imp-actions' }, this.sendBtn, this.looksBtn),
            this.left);
        this.el = h('section', { class: 'imp', 'aria-label': 'Improve this world', hidden: true },
            h('p', { class: 'imp-ask' }, COPY.improve.ask),
            this.thread,
            h('div', { class: 'imp-now' }, this.status, h('div', { class: 'imp-actions' }, this.showBtn, this.lookBtn)),
            this.composer);
        this.render();
    }

    /**
     * A world was put on the stage (the studio, at each install): a creation's, which is improved here, or one made
     * earlier. `change` says what it is to the world before it: `new` (its thread starts afresh), `improved` (a new
     * version of the creation's world already here: its thread goes on, and says so), or `same` (that very world shown
     * again, past its envelope: nothing to say). Null: h1's world, the backdrop or none, for which the panel is not shown.
     */
    installed(kind: StagedKind | null, change: 'new' | 'improved' | 'same' = 'new'): void {
        this.installs++;
        const goesOn = kind === 'creation' && this.staged === 'creation' && change !== 'new';
        if (!goesOn) {
            this.entries = [];
            this.words.value = '';
        } else if (change === 'improved') this.add('studio', COPY.improve.shown);
        this.staged = kind;
        this.drawThread();
        this.render();
    }

    /** The panel as the review and the controller say now. */
    render(): void {
        const kind = this.staged;
        this.el.dataset.state = kind ?? 'none';
        if (kind !== 'creation') {
            this.say(kind === 'earlier' ? COPY.improve.madeEarlier : '');
            this.composer.hidden = true;
            this.showBtn.hidden = true;
            this.lookBtn.hidden = true;
            return;
        }
        const { reviews, creation } = this.parts;
        const st = creation.state;
        const r = reviews.latest;
        const improvingNow = reviews.improving || this.pressing || (st.improves && (st.phase === 'writing' || st.phase === 'turn'));
        const readyToShow = st.improves && st.phase === 'ready';
        const testing = st.improves && st.phase === 'running';
        const blocked = reviews.improvable(r);
        const rounds = reviews.roundsLeft();
        // Show it for the improved world: the same press as the idea box's, on the same controller (one go, P7).
        this.showBtn.hidden = !readyToShow;
        this.showBtn.disabled = creation.showBlocked() !== null;
        this.lookBtn.hidden = r?.status !== 'capture-failed' || reviews.capturing;
        // What stands now, in one sentence.
        this.say(this.sentence(st, r, { improvingNow, readyToShow, testing, blocked, rounds }));
        // The composer: offered while this world can take a change, and has one left; its words kept through a refusal. A
        // world whose own words content safety refused takes none here again (EA9.4's world-refused), so none is offered:
        // the sentence says to make a new one.
        const usable = blocked === null && !improvingNow && !readyToShow && !testing && rounds !== 0;
        this.composer.hidden = blocked?.startsWith('EA_REVIEW_REFUSED') ?? false;
        this.words.disabled = !usable && !improvingNow;
        const text = this.words.value.trim();
        this.sendBtn.disabled = !usable || !text;
        // Written only when they change: the controller publishes at every word of a turn, and the panel with it.
        setText(this.sendBtn, improvingNow ? COPY.improve.sending : COPY.improve.send);
        this.looksBtn.hidden = !r || r.status === 'approved' || improvingNow || readyToShow || testing;
        this.looksBtn.disabled = !r || (r.status !== 'ready' && r.status !== 'not-improved') || reviews.improving;
        setText(this.left, usable && rounds !== null && rounds > 0 ? COPY.improve.left(rounds) : '');
        this.left.hidden = !this.left.textContent;
    }

    /** The one sentence for where the world stands now: its work, its Show it, or why no change can be asked. */
    private sentence(st: CreationState, r: ReviewRecord | null, now: { improvingNow: boolean; readyToShow: boolean; testing: boolean; blocked: string | null; rounds: number | null }): string {
        if (this.parts.lost()) return COPY.improve.deviceLost;
        if (now.testing) return COPY.creation.testing;
        if (now.readyToShow) return st.sentence ?? COPY.improve.ready;
        if (now.improvingNow) return COPY.improve.working;
        if (!r || r.status === 'capturing' || this.parts.reviews.capturing) return COPY.improve.looking;
        if (r.status === 'capture-failed') return r.sentence ?? COPY.review.captureFailed;
        if (now.blocked) {
            // No session for this world any more: another account signed in, or none (its maker's, Q129, Q128 (b)), as the
            // controller says, never guessed from the missing session alone; or it ended otherwise (EA9.4's review).
            if (now.blocked.startsWith('EA_REVIEW_UNAVAILABLE') && /session (holding )?none/.test(now.blocked)) {
                return this.parts.creation.stageMoved ? COPY.improve.otherAccount : COPY.improve.ended;
            }
            return sentenceOf(now.blocked);
        }
        if (now.rounds === 0) return COPY.review.budget;
        if (r.status === 'not-improved' && r.sentence) return r.sentence;
        return '';
    }

    /**
     * The status line, said once per change (E6: a transition, never a tick). While the thread's last message already
     * says the same it is kept for a screen reader only (the thread is no live region): one sentence on screen once, not
     * twice, and a refused round still heard (EA9.4's review).
     */
    private say(sentence: string): void {
        const echo = !!sentence && this.entries.at(-1)?.text === sentence;
        const key = `${echo ? 'heard' : 'shown'}|${sentence}`;
        if (key === this.said) return;
        this.said = key;
        this.status.textContent = sentence;
        this.status.hidden = !sentence;
        this.status.classList.toggle('sr-only', echo);
    }

    private looksRight(): void {
        const r = this.parts.reviews.latest;
        if (!r) return;
        const done = this.parts.reviews.looksRight(r.id);
        if (done.ok) this.add('studio', COPY.improve.glad);
        this.drawThread();
        this.render();
    }

    /** "Improve it": the creator's words as one round on the world on the stage, through the review (loop/review.ts). */
    private async improve(): Promise<void> {
        const r = this.parts.reviews.latest;
        const words = this.words.value.trim();
        if (!r || !words || this.pressing || this.parts.reviews.improvable(r) !== null) return;
        this.pressing = true;
        const at = this.installs;
        // Sent: the words move into the thread, as a chat's do.
        this.words.value = '';
        this.add('creator', words);
        this.drawThread();
        this.render();
        let outcome: { ok: boolean; sentence?: string };
        try {
            outcome = await this.parts.reviews.improve(r.id, words, [], []);
        } catch {
            outcome = { ok: false, sentence: COPY.review.notApplied };
        } finally {
            this.pressing = false;
        }
        // Another world came to the stage meanwhile: what came of this round, and these words, are not its (EA9.4's review).
        if (at !== this.installs) {
            this.render();
            return;
        }
        // Improved: Show it is offered (the status says so). Not improved, or refused before any call: its one sentence,
        // and the words back in the box to say it another way, unless the creator has typed anew meanwhile.
        if (outcome.ok && r.status === 'awaiting-run') {
            this.add('studio', COPY.improve.ready);
        } else {
            this.add('studio', (outcome.ok ? r.sentence : outcome.sentence) ?? COPY.review.notApplied);
            if (!this.words.value.trim()) this.words.value = words;
        }
        this.drawThread();
        this.render();
    }

    private add(who: Entry['who'], text: string): void {
        this.entries.push({ who, text });
        while (this.entries.length > THREAD) this.entries.shift();
    }

    private drawThread(): void {
        this.thread.replaceChildren(...this.entries.map(e => h('li', { class: `imp-msg imp-${e.who}` },
            e.who === 'creator' ? h('span', { class: 'imp-who' }, COPY.improve.you) : null,
            h('p', null, e.text))));
        this.thread.hidden = !this.entries.length;
    }
}
