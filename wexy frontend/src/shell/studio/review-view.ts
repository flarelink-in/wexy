// The review of the world on the stage, in Developer view behind ?agent=1 (EA6.2 and EA6.4; visual-review-design.md §8.1,
// §9.1; Q109 decided 2026-11-02: the creator's studio is not touched, and the panel moves there with the switch from h1).
// It shows the newest review (loop/review.ts): its two frames at the captured tick, each named by its view, size and
// hash; what the host measured and what it could not; and the creator's answers. "Looks right" records a pass and spends
// nothing. "Improve it" (Q110; it was "Fix it") takes the creator's words and the findings they keep checked into one
// visual round of the candidate session: a program revision, paid, within Q_C and the attempt's two rounds. "Review with
// AI" (EA6.4, Q112 (a)) is offered only when the backend's terms say every one of Q62's gates is verified: before the
// first, the creator reads what goes where and allows it, bound to that provider, model and policy, and may withdraw it;
// then one paid call returns a verdict whose issues join the host's findings, checked at first, never applied alone. The
// Head stays on the stage throughout; an improved candidate reaches it only through Run on this GPU, the developer's GPU
// go. Everything a model, a file or the creator wrote is set as text, never as HTML; the frames are the host's own JPEGs.

import { IMPROVE_FINDINGS, IMPROVE_WORDS } from '../../loop/candidate';
import { CONSENT_KEY, disclosureFor, storedConsent, termsKey, type ConsentStore, type FrameRef, type ReviewRecord, type ReviewStatus, type StageReviews } from '../../loop/review';
import { COPY } from '../../loop/copy';
import { h } from '../../shared/dom';

/** Quick words the creator can add (§8.1). */
export const QUICK_WORDS: readonly string[] = Object.freeze(['floating', 'too big', 'too small', 'camera', 'too dark', 'missing a part']);

const STATUS: Readonly<Record<ReviewStatus, { label: string; tone: 'quiet' | 'ok' | 'warn' | 'err' }>> = {
    'capturing': { label: 'Capturing the stage', tone: 'quiet' },
    'ready': { label: 'Ready for the creator', tone: 'quiet' },
    'capture-failed': { label: 'Capture failed', tone: 'err' },
    'approved': { label: 'Looks right', tone: 'ok' },
    'reviewing': { label: 'AI review: the model is looking', tone: 'quiet' },
    'improving': { label: 'Improving: a program revision', tone: 'quiet' },
    'awaiting-run': { label: 'Improved: awaiting Run', tone: 'ok' },
    'not-improved': { label: 'Not improved', tone: 'warn' },
    'superseded': { label: 'Superseded', tone: 'quiet' },
};

const short = (s: string) => `${s.slice(0, 12)}…`;
const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
let ids = 0;

export class ReviewPanel {
    readonly el: HTMLElement;
    private readonly reviews: StageReviews;
    private readonly phase = h('span', { class: 'cand-phase' });
    private readonly id = h('span', { class: 'cand-id' });
    private readonly status = h('p', { class: 'rev-status', role: 'status', 'aria-live': 'polite' });
    private readonly frames = h('div', { class: 'rev-frames' });
    private readonly gaps = h('ul', { class: 'rev-gaps' });
    private readonly findings = h('ul', { class: 'rev-findings' });
    /** Their status, said before them (the outside review of 11-02 night): heuristics, checked at first, never verdicts. */
    private readonly findingsBox = h('fieldset', { class: 'rev-findings-box' }, h('legend', null, 'The host\'s findings'),
        h('p', { class: 'rev-hint' }, 'Heuristics from what the host measured, not judgments: a world may be meant to look this way. Untick any that do not apply.'),
        this.findings);
    /** A model's review (EA6.4): its gate or consent, its button, then its verdict's issues as findings to choose. */
    private readonly aiGate = h('p', { class: 'rev-ai-gate' });
    private readonly aiDisclosure = h('div', { class: 'rev-disclosure' });
    private readonly aiAgreeBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Allow AI review');
    private readonly aiWithdrawBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Withdraw consent');
    private readonly aiReviewBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Review with AI');
    private readonly aiWhy = h('p', { class: 'rev-ai-why' });
    /** When this browser would not keep the creator's go-ahead, or its withdrawal: said, never silent. */
    private readonly aiKept = h('p', { class: 'rev-hint rev-ai-kept', hidden: true });
    private readonly aiIssues = h('ul', { class: 'rev-findings rev-ai-issues' });
    private readonly aiVerdict = h('p', { class: 'rev-hint' });
    private readonly aiIssuesBox = h('fieldset', { class: 'rev-findings-box', hidden: true }, h('legend', null, 'The model\'s review'),
        this.aiVerdict, h('p', { class: 'rev-hint' }, 'A model\'s reading of the two frames: advice, not a judgment. Untick any that do not apply.'), this.aiIssues);
    private readonly aiBox = h('div', { class: 'rev-ai' });
    private readonly looksBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Looks right');
    private readonly wordsId = `rev-words-${++ids}`;
    private readonly words = h('textarea', { id: this.wordsId, class: 'rev-words', rows: '3', maxlength: String(IMPROVE_WORDS), placeholder: 'What should change? The castle floats; the camera is inside the hill…' }) as HTMLTextAreaElement;
    private readonly count = h('span', { class: 'rev-count', 'aria-live': 'polite' });
    private readonly chips = h('div', { class: 'rev-chips', role: 'group', 'aria-label': 'Quick words' });
    private readonly improveBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, 'Improve it');
    private readonly improveWhy = h('p', { class: 'rev-why' });
    private readonly againBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Capture again');
    private readonly verdictBox = h('div', { class: 'rev-verdict' });
    private readonly budget = h('p', { class: 'cand-budget' });
    private readonly note = h('p', { class: 'cand-note', hidden: true });
    private readonly reason = h('p', { class: 'cand-reason', hidden: true });
    /** Each kept frame's object URL, until its bytes are dropped or the panel goes. */
    private readonly urls = new Map<string, string>();
    /** The findings the creator keeps checked, by index, for the review they were shown for. */
    private chosen: { review: string; indices: Set<number> } | null = null;
    /** The model's issues the creator keeps checked, by index, for the review and the verdict they were shown for. */
    private chosenModel: { review: string; evidence: string; indices: Set<number> } | null = null;
    /** What the findings lists were last drawn for: redrawn only when their review or its state moves, so focus stays put. */
    private drawn = '';
    private drawnModel = '';
    /** A press of "Review with AI" from its click until its answer: a second press in between does nothing. */
    private pressing = false;

    constructor(reviews: StageReviews) {
        this.reviews = reviews;
        for (const w of QUICK_WORDS) {
            this.chips.append(h('button', { type: 'button', class: 'chip rev-chip', onclick: () => this.addWords(w) }, w));
        }
        this.looksBtn.addEventListener('click', () => {
            const r = this.reviews.latest;
            if (r) this.reviews.looksRight(r.id);
        });
        this.improveBtn.addEventListener('click', () => void this.improve());
        this.againBtn.addEventListener('click', () => void this.reviews.capture());
        // The consent is to the terms whose disclosure is on screen: terms that moved since are shown again first.
        this.aiAgreeBtn.addEventListener('click', () => this.reviews.giveConsent(this.aiDisclosure.dataset.terms ?? ''));
        this.aiWithdrawBtn.addEventListener('click', () => this.reviews.withdrawConsent());
        this.aiReviewBtn.addEventListener('click', () => void this.aiReview());
        this.words.addEventListener('input', () => this.renderControls());
        this.aiBox.append(this.aiGate, this.aiDisclosure, h('div', { class: 'cand-actions' }, this.aiAgreeBtn, this.aiReviewBtn, this.aiWithdrawBtn), this.aiWhy, this.aiKept);
        this.verdictBox.append(
            h('div', { class: 'cand-actions' }, this.looksBtn),
            h('label', { class: 'rev-label', for: this.wordsId }, 'Or say what should change (up to 400 characters)'),
            this.words, h('div', { class: 'rev-words-foot' }, this.chips, this.count),
            h('div', { class: 'cand-actions' }, this.improveBtn), this.improveWhy,
        );
        this.el = h('section', { class: 'cand rev', 'aria-label': 'Review of the stage', dataset: { status: 'none' } },
            h('header', { class: 'cand-head' }, h('h3', null, 'Review'), h('span', { class: 'panel-sub' }, 'EA6 · what the world on the stage looks like')),
            h('div', { class: 'cand-status' }, this.phase, this.id),
            this.status, this.frames, this.gaps, this.findingsBox, this.aiBox, this.aiIssuesBox, this.verdictBox,
            h('div', { class: 'cand-actions' }, this.againBtn), this.note, this.reason, this.budget,
        );
        this.render();
    }

    /** The frames whose JPEGs the bound dropped: their URLs go too. */
    dropped(frameIds: readonly string[]): void {
        for (const id of frameIds) {
            const url = this.urls.get(id);
            if (url) URL.revokeObjectURL(url);
            this.urls.delete(id);
        }
    }

    dispose(): void {
        this.dropped([...this.urls.keys()]);
    }

    render(): void {
        const r = this.reviews.latest;
        this.el.dataset.status = r?.status ?? 'none';
        const look = r ? STATUS[r.status] : { label: 'No review yet', tone: 'quiet' as const };
        this.phase.textContent = look.label;
        this.phase.className = `cand-phase tone-${look.tone}`;
        this.id.textContent = r ? `${r.id} · id(C) ${short(r.candidate)}` : '';
        this.status.textContent = statusLine(r, this.reviews.capturing);
        this.renderFrames(r);
        this.gaps.replaceChildren(...(r?.host ? [...r.host.gaps.map(g => h('li', { class: 'rev-gap' }, `Not measured: ${g}`)), ...r.host.notes.map(n => h('li', { class: 'rev-gap is-note' }, n))] : []));
        this.gaps.hidden = !this.gaps.childElementCount;
        this.renderFindings(r);
        this.renderModel(r);
        const refusal = this.reviews.refusal;
        const sentence = refusal?.sentence ?? r?.sentence ?? null;
        const diagnostic = refusal?.diagnostic ?? r?.error ?? null;
        this.note.hidden = !sentence;
        this.note.textContent = sentence ?? '';
        this.reason.hidden = !diagnostic;
        this.reason.textContent = diagnostic ?? '';
        this.budget.textContent = this.reviews.budget() ?? 'No candidate session here: a review is local, and nothing can be spent on it.';
        // Not while a model's review runs either: a new capture would void its paid answer (the independent review).
        this.againBtn.disabled = this.reviews.capturing || this.reviews.improving || this.reviews.reviewing;
        this.renderControls();
    }

    /** The two frames, each with what it shows; a view not drawn says why; a dropped image keeps its identity. */
    private renderFrames(r: ReviewRecord | null): void {
        if (!r) {
            this.frames.replaceChildren();
            return;
        }
        const figures: HTMLElement[] = r.frames.map(f => this.figure(f));
        for (const m of r.missing) {
            figures.push(h('figure', { class: 'rev-frame is-missing' },
                h('div', { class: 'rev-missing' }, `${m.name === 'framed' ? 'Framed view' : 'Side view'} not drawn`),
                h('figcaption', null, m.why)));
        }
        this.frames.replaceChildren(...figures);
    }

    private figure(f: FrameRef): HTMLElement {
        const bytes = this.reviews.bytesOf(f.id);
        let url = this.urls.get(f.id) ?? null;
        if (!url && bytes) {
            url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: f.mime }));
            this.urls.set(f.id, url);
        }
        const name = f.view === 'framed' ? 'Framed view' : 'Side view, level';
        const alt = `${f.describes} Tick ${f.tick}, ${f.seconds.toFixed(2)} s.`;
        return h('figure', { class: 'rev-frame', dataset: { frame: f.id, view: f.view } },
            url ? h('img', { src: url, alt, width: String(f.width), height: String(f.height), loading: 'lazy' })
                : h('div', { class: 'rev-missing' }, 'Image dropped: only the newest three reviews keep theirs'),
            h('figcaption', null, `${name} · ${f.sourceWidth}×${f.sourceHeight} fitted into ${f.width}×${f.height} · JPEG ${f.quality} · ${kb(f.bytes)} · sha256 ${short(f.sha256)}`));
    }

    /** The host's findings as checkboxes, each checked at first (every one is a warning); redrawn only when its review moves. */
    private renderFindings(r: ReviewRecord | null): void {
        const key = r ? `${r.id}:${r.status}:${r.hostFindingIds.length}` : '';
        if (key === this.drawn) return;
        this.drawn = key;
        const list = r?.host?.findings ?? [];
        // Chosen once its findings exist (never while it is still capturing): every one checked at first.
        if (r?.host && (!this.chosen || this.chosen.review !== r.id)) this.chosen = { review: r.id, indices: new Set(list.map((_, i) => i)) };
        this.findingsBox.hidden = !r?.host;
        if (!r?.host) return;
        if (!list.length) {
            this.findings.replaceChildren(h('li', { class: 'rev-finding is-none' }, r.host.verdict === 'pass' ? 'None: every check ran, and none fired.'
                : 'None fired, but not every check ran (above).'));
            return;
        }
        const pickable = r.hostFindingIds.length === list.length;
        this.findings.replaceChildren(...list.map((f, i) => {
            const box = h('input', { type: 'checkbox', class: 'rev-check', checked: this.chosen!.indices.has(i), disabled: !pickable }) as HTMLInputElement;
            box.addEventListener('change', () => {
                if (box.checked) this.chosen!.indices.add(i);
                else this.chosen!.indices.delete(i);
                this.renderControls();
            });
            return h('li', { class: 'rev-finding' }, h('label', null, box, ' ', h('span', { class: 'cand-finding-code' }, f.code), ` ${f.message}`));
        }));
    }

    /**
     * A model's review (EA6.4): the gate that keeps it shut, or the disclosure and the creator's consent, or the button;
     * then the verdict's issues as checkboxes, each checked at first, redrawn only when its review's verdict moves.
     */
    private renderModel(r: ReviewRecord | null): void {
        const terms = this.reviews.terms;
        const shut = this.reviews.aiGate(false);
        const consented = !!this.reviews.consent;
        const held = this.reviews.heldConsent;
        const disclosure = disclosureFor(terms?.policyVersion ?? null);
        this.aiGate.textContent = shut ? `AI review is not available: ${shut}` : '';
        this.aiGate.hidden = !shut;
        const asking = !shut && !consented && !!terms && !!disclosure;
        this.aiDisclosure.hidden = !asking;
        this.aiAgreeBtn.hidden = !asking;
        // Drawn again whenever the terms move (their provider, model, mode or policy): the creator consents to what they
        // read, and "Allow" takes only the terms drawn here (the independent review of EA6.4).
        const shown = termsKey(terms);
        if (asking && this.aiDisclosure.dataset.terms !== shown) {
            this.aiDisclosure.dataset.terms = shown;
            this.aiDisclosure.replaceChildren(
                h('p', null, disclosure!.sends(terms!.model)),
                h('ul', null, ...disclosure!.statements.map(s => h('li', null, s))),
                h('p', { class: 'rev-links' }, ...disclosure!.links.flatMap((l, i) => [
                    ...(i ? [' · '] : []), h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label)])),
            );
            this.aiAgreeBtn.textContent = disclosure!.agree;
        }
        // Whatever this browser holds can be withdrawn, to these terms or to others, the backend away or not.
        this.aiWithdrawBtn.hidden = !held;
        this.aiWithdrawBtn.textContent = disclosure?.withdraw ?? 'Withdraw consent';
        const pageOnly = this.reviews.consentPageOnly;
        this.aiKept.hidden = !pageOnly;
        this.aiKept.textContent = !pageOnly ? '' : held ? COPY.review.aiKeptHere : COPY.review.aiWithdrawnHere;
        this.aiReviewBtn.hidden = !!shut || !consented;

        const look = r?.model ?? null;
        const key = r && look ? `${r.id}:${look.evidenceId}:${r.status}` : '';
        this.aiIssuesBox.hidden = !look;
        if (key === this.drawnModel) return;
        this.drawnModel = key;
        if (!r || !look) return;
        if (!this.chosenModel || this.chosenModel.review !== r.id || this.chosenModel.evidence !== look.evidenceId) {
            this.chosenModel = { review: r.id, evidence: look.evidenceId, indices: new Set(look.issues.map((_, i) => i)) };
        }
        this.aiVerdict.textContent = `${look.model} (${look.promptVersion}) answered ${look.verdict === 'pass' ? 'a pass: nothing to change' : `a fail with ${look.issues.length} issue${look.issues.length === 1 ? '' : 's'}`}`
            + ` · ${(look.costMicroUsd / 1e6).toFixed(4)} USD · generation ${short(look.generationId)}`;
        const pickable = r.modelFindingIds.length === look.issues.length;
        this.aiIssues.replaceChildren(...look.issues.map((issue, i) => {
            const box = h('input', { type: 'checkbox', class: 'rev-check', checked: this.chosenModel!.indices.has(i), disabled: !pickable }) as HTMLInputElement;
            box.addEventListener('change', () => {
                if (box.checked) this.chosenModel!.indices.add(i);
                else this.chosenModel!.indices.delete(i);
                this.renderControls();
            });
            const suggested = `suggested: ${issue.scope}${issue.modules.length ? `, ${issue.modules.join(', ')}` : ''}`;
            return h('li', { class: 'rev-finding' }, h('label', null, box, ' ', h('span', { class: 'cand-finding-code' }, `${issue.kind} · ${issue.severity}`),
                ` ${issue.sentence} `, h('span', { class: 'rev-suggested' }, `(${suggested})`)));
        }));
    }

    /** What can be pressed now, and why not: never a paid action without its review, its session and its budget. */
    private renderControls(): void {
        const r = this.reviews.latest;
        // Not improved, too: once its round failed, the session is back on the candidate on the stage (loop/review.ts).
        const answerable = !!r && (r.status === 'ready' || r.status === 'approved' || r.status === 'not-improved');
        this.verdictBox.hidden = !answerable;
        this.looksBtn.disabled = !r || (r.status !== 'ready' && r.status !== 'not-improved') || this.reviews.improving || this.reviews.reviewing;
        const text = this.words.value.trim();
        this.count.textContent = `${this.words.value.length}/${IMPROVE_WORDS}`;
        const chosen = r && this.chosen?.review === r.id ? this.chosen.indices.size : 0;
        const chosenModel = r && r.model && this.chosenModel?.review === r.id && this.chosenModel.evidence === r.model.evidenceId ? this.chosenModel.indices.size : 0;
        const cited = chosen + chosenModel + (text ? 1 : 0);
        const blocked = this.reviews.improvable(r);
        const why = blocked ?? (!cited ? 'Say what should change, or keep a finding checked.'
            : cited > IMPROVE_FINDINGS ? `At most ${IMPROVE_FINDINGS} findings a round: ${cited} are chosen.` : null);
        this.improveBtn.disabled = why !== null || this.reviews.improving || this.reviews.reviewing;
        this.improveBtn.textContent = this.reviews.improving ? 'Improving…' : 'Improve it';
        this.improveWhy.textContent = why ?? `One round: a program revision answering ${cited === 1 ? 'this' : `these ${cited}`}, paid, within the budget below. `
            + 'It changes sizes, materials, effects and the program\'s structure, and can ask a part\'s own code to change, such as where it places things. '
            + 'The world stays on the stage until Run.';
        const aiBlocked = this.reviews.aiReviewable(r);
        this.aiReviewBtn.disabled = aiBlocked !== null || this.reviews.reviewing || this.reviews.improving || this.pressing;
        this.aiReviewBtn.textContent = this.reviews.reviewing || this.pressing ? 'Reviewing…' : 'Review with AI';
        const consented = !!this.reviews.consent;
        this.aiWhy.textContent = !consented || this.reviews.aiGate() ? ''
            : aiBlocked ?? `One call to ${this.reviews.terms?.model ?? 'the model'}, paid, within the budget below: the two frames, your idea, the design`
                + ` and the ${chosen} host finding${chosen === 1 ? '' : 's'} checked above. Its issues come back here for you to choose; nothing changes until "Improve it".`;
        this.aiWhy.hidden = !this.aiWhy.textContent;
    }

    private addWords(word: string): void {
        const now = this.words.value.trim();
        const next = now ? `${now}, ${word}` : word;
        if (next.length <= IMPROVE_WORDS) this.words.value = next;
        this.words.focus();
        this.renderControls();
    }

    private async improve(): Promise<void> {
        const r = this.reviews.latest;
        if (!r) return;
        const chosen = this.chosen?.review === r.id ? [...this.chosen.indices].sort((a, b) => a - b) : [];
        const chosenModel = r.model && this.chosenModel?.review === r.id && this.chosenModel.evidence === r.model.evidenceId
            ? [...this.chosenModel.indices].sort((a, b) => a - b) : [];
        const done = await this.reviews.improve(r.id, this.words.value, chosen, chosenModel);
        if (done.ok) this.words.value = '';
        this.render();
    }

    private async aiReview(): Promise<void> {
        const r = this.reviews.latest;
        // One press at a time: the button is off from the click (the terms are read first) until the answer.
        if (!r || this.pressing) return;
        this.pressing = true;
        this.renderControls();
        try {
            // The terms again first: a gate or a policy may have moved since the panel last read them.
            await this.reviews.loadTerms();
            const chosen = this.chosen?.review === r.id ? [...this.chosen.indices].sort((a, b) => a - b) : [];
            await this.reviews.aiReview(r.id, chosen);
        } finally {
            this.pressing = false;
        }
        this.render();
    }
}

/**
 * The creator's consent kept in this browser's localStorage (EA6.4, §9's privacy gate), shared by its tabs: read again
 * before every review, withdrawn everywhere by removing it (loop/review.ts, `storedConsent`), and watched: another tab's
 * change reaches this one at once (a `storage` event), stopping a review it no longer covers.
 */
export function browserConsent(): ConsentStore {
    return storedConsent(() => globalThis.localStorage ?? null, CONSENT_KEY, changed => {
        const listener = (e: StorageEvent) => {
            // A null key: another tab cleared the site's storage.
            if (e.key === null || e.key === CONSENT_KEY) changed();
        };
        globalThis.addEventListener('storage', listener);
        return () => globalThis.removeEventListener('storage', listener);
    });
}

/** One line on the newest review: which world, which tick, which GPU, how many views; or why there is none. */
function statusLine(r: ReviewRecord | null, capturing: boolean): string {
    if (!r) return 'No agent world on the stage yet: once Run puts one there, it is captured here (two views at the current tick).';
    if (r.status === 'capturing' || (capturing && r.status === 'superseded')) return 'Capturing the world on the stage: two views at the current tick, read back on this device. It stays on the stage.';
    const where = r.tick === null ? 'no frame' : `tick ${r.tick} (${(r.seconds ?? 0).toFixed(2)} s)`;
    const views = `${r.frames.length} of 2 views`;
    const bound = r.attempt ? `in attempt ${r.attempt}` : `local only: ${r.unbound ?? 'no session'}`;
    const host = r.host ? `host: ${r.host.verdict} (${r.host.detector})` : '';
    const model = r.model ? `AI: ${r.model.verdict}` : '';
    const improved = r.improvedTo ? ` · improved to id(C) ${short(r.improvedTo)}: Run on this GPU puts it on the stage` : '';
    return [`On the stage at ${where} on ${r.gpu}`, views, host, model, bound].filter(Boolean).join(' · ') + improved;
}
