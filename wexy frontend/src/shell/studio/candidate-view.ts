// A candidate in Developer view, behind ?agent=1 (EA4.5; candidate-loop-design.md §9 and §13): once a turn hands off,
// the developer may write its modules, one metered call each through the module route, and watch the candidate machine
// check them. It shows:
//   - each module: its kind and phase, its calls and repairs, its body as checked (and as written, when the auto-fix
//     changed it), and every verdict about it, findings with their rung, line and place;
//   - the candidate: its phase, its sealed id(C) or why it stopped (the developer's diagnostic, the creator's sentence),
//     Q_C as spent, and every call it counts with its charge, known or unknown: the hand-off turn's and a program
//     revision's, each with its model and template (the EA4.5 review), and each module job; the evidence records, with
//     what was dropped.
// The bundle downloads as JSON (candidateBundle): a developer's explicit act, since it holds R and the bodies. Everything
// the model or the backend wrote is set as text, never as HTML. Given the studio's device compiler (EA5.1), each body
// that passed its checks is compiled on this device too (L3); without one (no WebGPU) the candidate is checked only.
// "Run on this GPU" (EA5.3, Q89) is the developer's GPU go for the sealed candidate shown: the studio's stage admits,
// builds, probes and checks it, and only then puts it on the stage. The panel builds and renders nothing itself; it shows
// what came of the Run, in the developer's words.
// EA9.1 (agent-first-studio-design.md §3): the panel owns no session. It watches the creation controller (creation.ts),
// which owns every creation's sessions, and its buttons are presses on it: "Write the modules" a write, Cancel a cancel,
// "Run on this GPU" the controller's go, the one the creator's "Show it" is.

import type { ModuleCompiler } from '../../contract/adapters/bodies';
import type { DeepReadonly } from '../../contract/engine/frozen';
import type { ModuleClient } from '../../forge-client/module-client';
import {
    candidateBundle, followedCalls, type BundleReviewsSection, type CandidatePhase, type CandidateSession, type CandidateState, type FollowedTurn, type ModuleState,
    type Reviser, type TurnRecord,
} from '../../loop/candidate';
import type { CandidateEvidence, EvidenceSubject } from '../../loop/candidate-evidence';
import type { CreationController, CreationStage, RunSummary } from '../../loop/creation';
import { download, h } from '../../shared/dom';

/** What a Run came to (EA5.3): the controller's, as the panel shows it. */
export type { RunSummary } from '../../loop/creation';

/** The studio's stage, as a panel's own controller reaches it (EA5.3, Q89): the controller's stage seam. */
export type RunControl = CreationStage;

/** How each phase reads in Developer view; `idle` is no candidate yet. */
export const CANDIDATE_PHASES: Readonly<Record<CandidatePhase | 'idle', { label: string; tone: 'quiet' | 'ok' | 'warn' | 'err'; note: string }>> = {
    'idle': {
        label: 'No candidate yet', tone: 'quiet',
        note: 'After a hand-off, Write the modules: one model call each, checked here against the interface the host derives. '
            + 'Nothing is compiled on a device, built or rendered (EA5), and the world on the stage is untouched.',
    },
    'resolving': { label: 'Resolving the program', tone: 'quiet', note: 'X, its checks and its module interfaces, here in the browser.' },
    'authoring': { label: 'Writing modules', tone: 'quiet', note: 'Module calls are with the model, at most two at once.' },
    'checking': { label: 'Checking bodies', tone: 'quiet', note: 'Each body against its interface: the lint, the auto-fix, the lint again.' },
    'correcting': { label: 'Correcting', tone: 'quiet', note: 'A repair, or a program revision, answering what the checks found.' },
    'static-verified': {
        label: 'Static-verified: checked, not compiled', tone: 'ok',
        note: 'Every module passed the host\'s checks, and the candidate is sealed by its id(C). Nothing was compiled on a device '
            + 'or rendered, and the world on the stage is unchanged: that is EA5.',
    },
    'failed': { label: 'Failed: no candidate', tone: 'err', note: '' },
    'exhausted': { label: 'Stopped by its budget', tone: 'warn', note: '' },
    'cancelled': { label: 'Cancelled', tone: 'quiet', note: 'Cancelled here. Anything its calls say after that is ignored.' },
    'superseded': { label: 'Superseded', tone: 'quiet', note: 'A newer candidate took its place.' },
};

/** With this device's compiler (EA5.1), the words that change: L3 runs here, and still nothing is built or rendered. */
export const DEVICE_PHASES: Readonly<Partial<Record<CandidatePhase | 'idle', { label?: string; note: string }>>> = {
    'idle': {
        note: 'After a hand-off, Write the modules: one model call each, checked here against the interface the host derives, '
            + 'then compiled on this device (L3). Nothing is built or rendered (EA5\'s Run), and the world on the stage is untouched.',
    },
    'checking': { note: 'Each body against its interface: the lint, the auto-fix, the lint again; then this device\'s compiler (L3).' },
    'static-verified': {
        label: 'Static-verified: compiled on this device',
        note: 'Every module passed the host\'s checks and compiled on this device (L3), and the candidate is sealed by its id(C). '
            + 'Nothing was built or rendered, and the world on the stage is unchanged: that is EA5\'s Run.',
    },
};

const RUNNING: ReadonlySet<string> = new Set(['resolving', 'authoring', 'checking', 'correcting']);
/** Micro-USD as dollars, to the hundredth of a cent. */
const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;
const short = (hash: string) => `${hash.slice(0, 12)}…`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the panel shows beside the controller's candidate: what judges L3, the bundle's save, the reviews it carries. */
export interface CandidateViewOptions {
    /**
     * L3 (EA5.1): the studio's device compiler, which the next attempt would get; null until the device exists, and with
     * no WebGPU. Absent: the candidate is checked, never compiled.
     */
    compiler?: () => ModuleCompiler | null;
    /** Saves the bundle: a download by default. */
    save?: (name: string, text: string) => void;
    /** The reviews of an attempt's stage as the bundle holds them (Q113 (a)); absent, the bundle's reviews are none. */
    reviews?: (attempt: string) => BundleReviewsSection | null;
}

/** The candidate half of a panel's own controller (a harness's, agent-view.ts): its sessions' seams and its stage. */
export interface CandidateOptions extends CandidateViewOptions {
    modules: ModuleClient;
    /** A program revision (EA4.4); absent, a program's finding ends the candidate. */
    revise?: Reviser;
    /** A new attempt's id: random by default; a harness names it to replay recorded calls. */
    attemptId?: () => string;
    /** "Run on this GPU" (EA5.3): the studio's stage. Absent, the panel offers no Run. */
    run?: RunControl;
}

type Candidate = DeepReadonly<CandidateState>;

export class CandidatePanel {
    readonly el: HTMLElement;
    private readonly controller: CreationController;
    private readonly off: () => void;
    private readonly save: (name: string, text: string) => void;
    private readonly reviews: ((attempt: string) => BundleReviewsSection | null) | null;
    private readonly compiler: () => ModuleCompiler | null;
    private readonly sub = h('span', { class: 'panel-sub' });
    private readonly l3 = h('p', { class: 'cand-l3' });
    private readonly writeBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: true }, 'Write the modules');
    private readonly cancelBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', disabled: true }, 'Cancel');
    private readonly downloadBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', disabled: true }, 'Download bundle');
    private readonly phase = h('span', { class: 'cand-phase' });
    private readonly id = h('span', { class: 'cand-id' });
    private readonly note = h('p', { class: 'cand-note' });
    private readonly reason = h('p', { class: 'cand-reason', hidden: true });
    private readonly budget = h('p', { class: 'cand-budget', hidden: true });
    private readonly modules = h('ol', { class: 'cand-modules' });
    private readonly turnList = h('ol', { class: 'cand-turns' });
    private readonly jobs = h('ol', { class: 'cand-jobs' });
    private readonly evidenceTag = h('span', { class: 'cand-tag' });
    private readonly evidenceList = h('ol', { class: 'cand-evidence-list' });
    private readonly evidence = h('details', { class: 'cand-evidence', hidden: true }, h('summary', null, 'Evidence ', this.evidenceTag), this.evidenceList);
    private readonly runBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: true, hidden: true }, 'Run on this GPU');
    private readonly runLine = h('p', { class: 'cand-run', hidden: true });

    /** Watches `controller`'s current creation: its candidate, its hand-off, its Run. */
    constructor(controller: CreationController, options: CandidateViewOptions = {}) {
        this.controller = controller;
        this.save = options.save ?? ((name, text) => download(new Blob([text], { type: 'application/json' }), name));
        this.reviews = options.reviews ?? null;
        this.compiler = options.compiler ?? (() => null);
        this.writeBtn.addEventListener('click', () => void this.write());
        this.cancelBtn.addEventListener('click', () => this.cancel());
        this.downloadBtn.addEventListener('click', () => this.download());
        this.runBtn.addEventListener('click', () => void this.run());
        this.el = h('section', { class: 'cand', 'aria-label': 'Candidate', dataset: { phase: 'idle', l3: 'none', run: 'idle' } },
            h('header', { class: 'cand-head' }, h('h3', null, 'Candidate'), this.sub),
            h('div', { class: 'cand-status' }, this.phase, this.id),
            this.l3, this.note, this.reason,
            h('div', { class: 'cand-actions' }, this.writeBtn, this.cancelBtn, this.downloadBtn, this.runBtn),
            this.runLine,
            this.budget, this.modules, this.turnList, this.jobs, this.evidence,
        );
        this.off = controller.subscribe(() => this.render());
        this.render();
    }

    /** The host's turn for the stage's Run (executor.ts's Present): the controller's κ, which each turn and write move. */
    get epoch(): number {
        return this.controller.n;
    }

    /** The session of the candidate shown: the current creation's, made at its first write; null before. */
    get session(): CandidateSession | null {
        return this.controller.session;
    }

    /**
     * The developer's GPU go for the sealed candidate shown, and its Run on the studio's stage (Q89): the controller's go,
     * the one the creator's "Show it" is. Only a sealed candidate with this device's L3 verdict on every body can be run;
     * the stage decides everything else.
     */
    async run(): Promise<RunSummary | null> {
        return this.controller.show();
    }

    /** Writes the hand-off's modules: the first attempt, or a new one in a session of its own; a Run under way is superseded. */
    async write(): Promise<Candidate | null> {
        await this.controller.write();
        return this.controller.state.candidate;
    }

    cancel(): void {
        this.controller.cancel();
    }

    /** The candidate as a JSON bundle, saved by the developer's own click. */
    download(): void {
        const s = this.controller.state.candidate;
        if (!s) return;
        this.save(`wexy-candidate-${s.attempt}.json`, `${JSON.stringify(candidateBundle(s, this.reviews?.(s.attempt) ?? null), null, 2)}\n`);
    }

    /** Stops watching; the controller and whatever it runs belong to its owner. */
    dispose(): void {
        this.off();
    }

    /** Shows the panel again as it is now: the studio calls it once its device compiler exists. */
    refresh(): void {
        this.render();
    }

    private render(): void {
        const st = this.controller.state;
        const s = st.candidate;
        // What judges L3: the attempt's own compiler once one runs, else the one the next attempt would get.
        const now = this.compiler();
        const judge = s ? s.l3 : now ? { producedBy: now.producedBy, gpu: now.gpu ?? null } : null;
        const device = judge?.producedBy === 'device';
        const base = CANDIDATE_PHASES[s?.phase ?? 'idle'];
        const look = { ...base, ...(device ? DEVICE_PHASES[s?.phase ?? 'idle'] : undefined) };
        const running = !!s && RUNNING.has(s.phase);
        this.el.dataset.phase = s?.phase ?? 'idle';
        this.el.dataset.l3 = judge?.producedBy ?? 'none';
        this.sub.textContent = device ? 'EA5.1 · checked, compiled on this device, never built' : 'EA4 · checked, never compiled';
        this.l3.textContent = !judge ? 'L3 not run: no device compiler here, so bodies are checked, never compiled.'
            : judge.producedBy === 'device' ? `L3 on this device: ${judge.gpu ?? 'its GPU'}.` : 'L3 by a fake compiler: its verdicts prove nothing about a device.';
        this.writeBtn.disabled = !st.handOff || running;
        this.writeBtn.textContent = s && !running ? 'Write the modules again' : 'Write the modules';
        this.cancelBtn.disabled = !running;
        this.downloadBtn.disabled = !s;
        this.phase.textContent = look.label;
        this.phase.className = `cand-phase tone-${look.tone}`;
        this.id.textContent = s?.id ? `id(C) ${short(s.id)}` : s?.verified ? `last verified ${short(s.verified.id)}` : '';
        // The creator's sentence when it stopped, in the words the studio would show; the developer's beneath.
        this.note.textContent = s?.stop ? s.stop.sentence : !s && !st.handOff ? 'A turn that hands off comes first.' : look.note;
        this.note.hidden = !this.note.textContent;
        this.reason.hidden = !s?.stop;
        this.reason.replaceChildren(...(s?.stop ? [h('code', null, s.stop.scope), ' ', s.stop.diagnostic] : []));
        this.budget.hidden = !s;
        this.budget.textContent = s ? budgetLine(s) : '';
        this.modules.replaceChildren(...(s?.modules ?? []).map(m => moduleRow(m, s!)));
        // Every call Q_C counts: the turn the hand-off's followed (Q120 (b)), the turns' (the hand-off's, a revision's), then
        // the module jobs.
        this.turnList.replaceChildren(...(s?.followed ? [followedRow(s.followed)] : []), ...(s?.turns ?? []).map(turnRow));
        this.jobs.replaceChildren(...(s?.jobs ?? []).map(j => h('li', { class: `cand-job is-${j.status}`, dataset: { job: j.jobId } },
            h('code', null, j.jobId), ` ${j.module} ${j.purpose}: ${j.status} · `,
            j.charge === 'known' && j.costMicroUsd !== null ? usd(j.costMicroUsd) : 'charge unknown',
            j.model ? ` · ${j.model}` : '', j.promptVersion ? ` · ${j.promptVersion}` : '', j.error ? ` · ${j.error}` : '')));
        const omitted = s ? Object.values(s.omitted).reduce((sum, n) => sum + n, 0) : 0;
        this.evidence.hidden = !s?.evidence.length;
        this.evidenceTag.textContent = s ? `${plural(s.evidence.length, 'record')}${omitted ? `, ${omitted} dropped` : ''}` : '';
        this.evidenceList.replaceChildren(...(s?.evidence ?? []).map(evidenceRow));
        this.renderRun(running);
    }

    /** "Run on this GPU": offered for a sealed candidate with this device's verdicts, and what the last Run came to. */
    private renderRun(writing: boolean): void {
        const c = this.controller;
        this.runBtn.hidden = !c.showable;
        this.runLine.hidden = !c.showable;
        if (!c.showable) return;
        const session = c.session;
        const snapshot = session?.snapshot ?? null;
        const running = c.state.phase === 'running';
        const blocked = !snapshot ? 'Run needs a sealed candidate: Write the modules first.'
            : !session?.compiled ? 'Run needs this device\'s L3 verdict on every body (a device compiler here).'
                : c.stageBlocked();
        this.runBtn.disabled = running || writing || blocked !== null;
        this.runBtn.title = blocked ?? 'The GPU go for this candidate: admitted, built, probed and checked here before it reaches the stage.';
        this.runBtn.textContent = running ? 'Running…' : 'Run on this GPU';
        const last = c.state.run;
        this.el.dataset.run = running ? 'running' : last?.status ?? 'idle';
        this.runLine.className = `cand-run${last ? ` is-${last.status}` : ''}`;
        if (running) this.runLine.textContent = 'Running on this GPU: the gate, the build, the probe, the first frame offscreen. The world on the stage keeps running, and holds while the probe times its work.';
        else if (last?.status === 'installed') this.runLine.textContent = `On the stage: id(C) ${short(snapshot!.id)}${last.numbers ? ` · ${last.numbers}` : ''}`;
        else if (last) this.runLine.textContent = `${last.status}: ${last.reason ?? ''}${last.numbers ? ` · ${last.numbers}` : ''}`;
        else this.runLine.textContent = blocked ?? 'Ready: Run on this GPU puts it on the stage once every check passes; the world there now stays until then.';
    }
}

/** Q_C as spent: the calls (the turn's own among them), then each counter against its limit. */
function budgetLine(s: Candidate): string {
    const c = s.budget.calls;
    const unknown = c.unknown ? `, ${c.unknown} unknown` : '';
    return `Q_C: ${c.settled + c.reserved + c.unknown} of ${s.limits.calls} calls${unknown} · authors ${s.budget.authors}/${s.limits.authors}`
        + ` · repairs ${s.budget.repairs}/${s.limits.repairs} · revisions ${s.budget.revisions}/${s.limits.revisions}`;
}

function moduleRow(m: DeepReadonly<ModuleState>, s: Candidate): HTMLElement {
    const head = `${m.module} · ${m.kind} · ${m.phase}${m.reused ? ' · reused' : ''} · ${plural(m.calls, 'call')}`
        + `${m.repairs ? `, ${plural(m.repairs, 'repair')}` : ''}${m.codeHash ? ` · body ${short(m.codeHash)}` : ''}`;
    // Every verdict about this module, oldest first: what a repair answered stays readable after it passed.
    const verdicts = s.evidence.filter(e => e.subject.module === m.module);
    const lines = (text: string | null) => (text === null ? 0 : text.split('\n').length);
    return h('li', { class: `cand-module is-${m.phase}`, dataset: { module: m.module, phase: m.phase } },
        h('div', { class: 'cand-module-head' }, head),
        verdicts.length ? h('ul', { class: 'cand-verdicts' }, verdicts.map(e => h('li', { class: `cand-verdict is-${e.verdict}` },
            h('span', { class: 'cand-verdict-head' }, `${e.phase} ${e.verdict}`), ` (${e.producedBy}${m.evidence.includes(e.id) ? ', current' : ''})`,
            e.findings.length ? h('ul', { class: 'cand-findings' }, e.findings.map(f => h('li', { class: `cand-finding is-${f.severity}` },
                h('span', { class: 'cand-finding-code' }, `${f.severity} ${f.code}`),
                f.line === null ? '' : ` line ${f.line}`, f.rung ? ` · ${f.rung}${f.place ? ` on the ${f.place}` : ''}` : '', ': ', f.message))) : null))) : null,
        m.body === null ? null : h('details', { class: 'cand-body' }, h('summary', null, `Body as checked (${plural(lines(m.body), 'line')})`),
            h('pre', { class: 'cand-code' }, m.body)),
        m.originalBody !== null && m.originalBody !== m.body ? h('details', { class: 'cand-body' }, h('summary', null, 'As the model wrote it'),
            h('pre', { class: 'cand-code' }, m.originalBody)) : null,
    );
}

/** An agent turn and each of its calls: what it cost, known or unknown, which model made it, under which template. */
function turnRow(t: DeepReadonly<TurnRecord>): HTMLElement {
    const known = t.calls.reduce((sum, c) => sum + (c.charge === 'known' && c.costMicroUsd !== null ? c.costMicroUsd : 0), 0);
    const cost = t.charge === 'known' ? usd(known) : t.calls.some(c => c.charge === 'known') ? `${usd(known)} reported, charge unknown` : 'charge unknown';
    return h('li', { class: `cand-turn is-${t.status}`, dataset: { role: t.role, status: t.status } },
        h('div', { class: 'cand-turn-head' }, h('code', null, t.turnId ?? 'no turn id'),
            ` ${t.role === 'hand-off' ? 'hand-off' : 'program revision'}: ${t.status} · ${plural(t.calls.length, 'call')} · ${cost}`,
            t.model ? ` · ${t.model}` : '', t.promptVersion ? ` · ${t.promptVersion}` : '', t.error ? ` · ${t.error}` : ''),
        t.calls.length ? h('ol', { class: 'cand-turn-calls' }, t.calls.map(c => h('li', { class: `cand-turn-call is-${c.charge}` },
            `${c.n} ${c.purpose}: `, c.charge === 'known' && c.costMicroUsd !== null ? usd(c.costMicroUsd) : 'charge unknown',
            c.generationId ? ` · ${c.generationId}` : ''))) : null);
}

/**
 * The turn the hand-off's turn followed (Q120 (b)): it ended with no world, and its calls are among Q_C's. Its end not
 * seen, Q_C counts a turn's whole allowance, unknown: the row says so beside the calls seen (the outside review of EA9.5).
 */
function followedRow(f: DeepReadonly<FollowedTurn>): HTMLElement {
    const known = f.calls.reduce((sum, c) => sum + (c.charge === 'known' && c.costMicroUsd !== null ? c.costMicroUsd : 0), 0);
    const seen = f.end === 'seen';
    const unknown = !seen || f.calls.some(c => c.charge !== 'known');
    const { unknown: counted } = followedCalls(f);
    const calls = seen ? plural(f.calls.length, 'call') : `${plural(f.calls.length, 'call')} seen, its end unseen: Q_C counts ${counted}`;
    return h('li', { class: `cand-turn is-followed${seen ? '' : ' is-unseen'}`, dataset: { role: 'followed', end: f.end } },
        h('div', { class: 'cand-turn-head' }, h('code', null, f.turnId), ` followed: no world · ${calls} · `,
            unknown ? (known ? `${usd(known)} reported, charge unknown` : 'charge unknown') : usd(known),
            f.model ? ` · ${f.model}` : '', f.promptVersion ? ` · ${f.promptVersion}` : ''),
        f.calls.length ? h('ol', { class: 'cand-turn-calls' }, f.calls.map(c => h('li', { class: `cand-turn-call is-${c.charge}` },
            `${c.n} ${c.purpose}: `, c.charge === 'known' && c.costMicroUsd !== null ? usd(c.costMicroUsd) : 'charge unknown',
            c.generationId ? ` · ${c.generationId}` : ''))) : null);
}

function subjectText(s: DeepReadonly<EvidenceSubject>): string {
    return [`revision ${s.revision}`, s.module ? `module ${s.module}` : null, s.codeHash ? `body ${short(s.codeHash)}` : null,
        s.candidate ? `candidate ${short(s.candidate)}` : null, s.graph ? `X ${short(s.graph)}` : 'no X'].filter(Boolean).join(' · ');
}

function evidenceRow(e: DeepReadonly<CandidateEvidence>): HTMLElement {
    return h('li', { class: `cand-record is-${e.verdict}`, dataset: { record: e.id } },
        h('code', null, e.id), ` ${e.phase} ${e.verdict} · ${e.producedBy} · ${subjectText(e.subject)}`,
        e.findings.length ? ` · ${plural(e.findings.length, 'finding')}${e.omittedFindings ? ` (+${e.omittedFindings} not kept)` : ''}` : '',
        e.refs.length ? ` · refs ${e.refs.join(', ')}` : '');
}
