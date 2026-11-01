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
// Nothing here admits, builds, renders or reaches the stage's world: that is EA5's Run.

import type { ModuleCompiler } from '../../contract/adapters/bodies';
import type { DeepReadonly } from '../../contract/engine/frozen';
import type { ModuleClient } from '../../forge-client/module-client';
import type { AgentTurnState } from '../../loop/agent-turn';
import {
    candidateBundle, createCandidateSession, turnCallsOf, type CandidatePhase, type CandidateSession, type CandidateState, type HandOff, type ModuleState,
    type Reviser, type TurnRecord,
} from '../../loop/candidate';
import type { CandidateEvidence, EvidenceSubject } from '../../loop/candidate-evidence';
import { download, h } from '../../shared/dom';

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

export interface CandidateOptions {
    modules: ModuleClient;
    /** A program revision (EA4.4); absent, a program's finding ends the candidate. */
    revise?: Reviser;
    /**
     * L3 (EA5.1): the studio's device compiler, asked at each attempt's start; null until the device exists, and with no
     * WebGPU. Absent: the candidate is checked, never compiled.
     */
    compiler?: () => ModuleCompiler | null;
    /** A new attempt's id: random by default; a harness names it to replay recorded calls. */
    attemptId?: () => string;
    /** Saves the bundle: a download by default. */
    save?: (name: string, text: string) => void;
}

type Candidate = DeepReadonly<CandidateState>;

export class CandidatePanel {
    readonly el: HTMLElement;
    readonly session: CandidateSession;
    private readonly save: (name: string, text: string) => void;
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
    private handOff: HandOff | null = null;
    private turnSeq: number | null = null;
    private state: Candidate | null = null;

    constructor(options: CandidateOptions) {
        this.save = options.save ?? ((name, text) => download(new Blob([text], { type: 'application/json' }), name));
        this.compiler = options.compiler ?? (() => null);
        this.session = createCandidateSession({ modules: options.modules, revise: options.revise, attemptId: options.attemptId, compiler: this.compiler }, s => {
            this.state = s;
            this.render();
        });
        this.writeBtn.addEventListener('click', () => void this.write());
        this.cancelBtn.addEventListener('click', () => this.cancel());
        this.downloadBtn.addEventListener('click', () => this.download());
        this.el = h('section', { class: 'cand', 'aria-label': 'Candidate', dataset: { phase: 'idle', l3: 'none' } },
            h('header', { class: 'cand-head' }, h('h3', null, 'Candidate'), this.sub),
            h('div', { class: 'cand-status' }, this.phase, this.id),
            this.l3, this.note, this.reason,
            h('div', { class: 'cand-actions' }, this.writeBtn, this.cancelBtn, this.downloadBtn),
            this.budget, this.modules, this.turnList, this.jobs, this.evidence,
        );
        this.render();
    }

    /**
     * The turn as it is now. Its hand-off is what the modules are written for; a new turn retires the last turn's
     * candidate, cancelled if it still runs, so nothing of it shows beside another turn.
     */
    turn(s: AgentTurnState | null): void {
        if (s && s.seq !== this.turnSeq) {
            this.turnSeq = s.seq;
            if (this.state && RUNNING.has(this.state.phase)) this.session.cancel();
            this.state = null;
        }
        this.handOff = s?.phase === 'handed-off' && s.meta && s.design && s.program
            ? {
                turnId: s.meta.turnId, request: s.request, design: s.design, program: s.program, model: s.meta.model, promptVersion: s.meta.promptVersion,
                calls: turnCallsOf(s.calls),
            }
            : null;
        this.render();
    }

    /** Writes the hand-off's modules, a candidate of its own; one still running is superseded. */
    async write(): Promise<Candidate | null> {
        return this.handOff ? this.session.start(this.handOff) : null;
    }

    cancel(): void {
        this.session.cancel();
    }

    /** The candidate as a JSON bundle, saved by the developer's own click. */
    download(): void {
        if (!this.state) return;
        this.save(`wexy-candidate-${this.state.attempt}.json`, `${JSON.stringify(candidateBundle(this.state), null, 2)}\n`);
    }

    dispose(): void {
        this.session.cancel();
    }

    /** Shows the panel again as it is now: the studio calls it once its device compiler exists. */
    refresh(): void {
        this.render();
    }

    private render(): void {
        const s = this.state;
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
        this.writeBtn.disabled = !this.handOff || running;
        this.writeBtn.textContent = s && !running ? 'Write the modules again' : 'Write the modules';
        this.cancelBtn.disabled = !running;
        this.downloadBtn.disabled = !s;
        this.phase.textContent = look.label;
        this.phase.className = `cand-phase tone-${look.tone}`;
        this.id.textContent = s?.id ? `id(C) ${short(s.id)}` : s?.verified ? `last verified ${short(s.verified.id)}` : '';
        // The creator's sentence when it stopped, in the words the studio would show; the developer's beneath.
        this.note.textContent = s?.stop ? s.stop.sentence : !s && !this.handOff ? 'A turn that hands off comes first.' : look.note;
        this.note.hidden = !this.note.textContent;
        this.reason.hidden = !s?.stop;
        this.reason.replaceChildren(...(s?.stop ? [h('code', null, s.stop.scope), ' ', s.stop.diagnostic] : []));
        this.budget.hidden = !s;
        this.budget.textContent = s ? budgetLine(s) : '';
        this.modules.replaceChildren(...(s?.modules ?? []).map(m => moduleRow(m, s!)));
        // Every call Q_C counts: the turns' (the hand-off's, a revision's), then the module jobs.
        this.turnList.replaceChildren(...(s?.turns ?? []).map(turnRow));
        this.jobs.replaceChildren(...(s?.jobs ?? []).map(j => h('li', { class: `cand-job is-${j.status}`, dataset: { job: j.jobId } },
            h('code', null, j.jobId), ` ${j.module} ${j.purpose}: ${j.status} · `,
            j.charge === 'known' && j.costMicroUsd !== null ? usd(j.costMicroUsd) : 'charge unknown',
            j.model ? ` · ${j.model}` : '', j.promptVersion ? ` · ${j.promptVersion}` : '', j.error ? ` · ${j.error}` : '')));
        const omitted = s ? Object.values(s.omitted).reduce((sum, n) => sum + n, 0) : 0;
        this.evidence.hidden = !s?.evidence.length;
        this.evidenceTag.textContent = s ? `${plural(s.evidence.length, 'record')}${omitted ? `, ${omitted} dropped` : ''}` : '';
        this.evidenceList.replaceChildren(...(s?.evidence ?? []).map(evidenceRow));
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
