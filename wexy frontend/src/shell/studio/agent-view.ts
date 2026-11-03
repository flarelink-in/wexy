// The agent turn in Developer view, behind ?agent=1 (the backend's agent-loop design §15.1, gate B2; the engine-aware
// design §13): how the turn ended and how long it ran, each call with its purpose, tokens and cost, each read and each
// check with its findings, the question or the reason it stopped, and the design and program it handed off. Everything
// the model or the backend wrote is set as text, never as HTML (coding principles §2), and this module writes no markup
// at all. A hand-off says checked, not rendered. Nothing here can reach the stage's world or the GPU: the panel is given
// a client and the idea's fields, nothing else, and imports neither the runtime nor the verifier (test/agent-turn.test.mjs).
// Given a module client too (EA4.5), a hand-off's modules can be written beneath it: its candidate (candidate-view.ts).
// EA9.1 (agent-first-studio-design.md §3): the panel owns no session. It watches a creation controller (creation.ts), the
// studio's own when handed one, so the turn shown is the creation's whoever started it; "Run agent turn" is a Create that
// stops at the hand-off for Developer view's step-by-step look, and Cancel a cancel. Handed only a client (a harness), it
// makes a controller of its own over that client, the same code path.

import type { WorldProgram } from '../../contract/agent';
import type { AgentClient, AgentTurnRequest } from '../../forge-client/agent-client';
import type { AgentToolResult } from '../../forge-client/agent-stream';
import { createAgentSession, elapsedMs, PURPOSES, TURN_PHASES, type AgentTurnState, type TurnCall } from '../../loop/agent-turn';
import { createCandidateSession } from '../../loop/candidate';
import { createCreationController, type CreationController, type CreationDeps } from '../../loop/creation';
import { h } from '../../shared/dom';
import { fmtBytes, fmtInt, fmtMs } from '../../shared/format';
import { formatJson } from '../../shared/json';
import { CandidatePanel, type CandidateOptions, type CandidateViewOptions } from './candidate-view';

const INTRO = 'One agent turn (EA2): the backend reads the engine\'s documents, proposes a design and a program of adapter '
    + 'nodes, and checks them. Nothing is built or rendered here, and the world on the stage is never touched.';
const NO_BACKEND = 'This build has no gateway (VITE_API_ORIGIN), so no turn can run. The backend\'s local,mock profile '
    + 'answers turns for nothing (dev workflow).';

/** Micro-USD as dollars, to the hundredth of a cent: a call costs a few cents. */
const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

/** A panel's own controller over a client (a harness's): one turn session, a candidate session per creation, its stage. */
function ownDeps(client: AgentClient, candidate: CandidateOptions | undefined, now: () => number): CreationDeps {
    return {
        turnSession: onChange => createAgentSession(client, onChange, now),
        candidateSession: candidate
            ? onChange => createCandidateSession({ modules: candidate.modules, revise: candidate.revise, attemptId: candidate.attemptId, compiler: candidate.compiler ?? (() => null) }, onChange)
            : undefined,
        stage: candidate?.run,
    };
}

export interface AgentPanelOptions {
    now?: () => number;
    /**
     * The controller to watch: the studio's (EA9.1). Absent, the panel makes its own over the client it is given, with
     * `candidate`'s module client, reviser and stage.
     */
    controller?: CreationController;
    /** The candidate beneath the turn: with the panel's own controller, its seams too; with the studio's, its view alone. */
    candidate?: CandidateOptions | CandidateViewOptions;
}

export class AgentPanel {
    readonly el: HTMLElement;
    /** The controller this panel watches and presses; null when this build has no backend to call. */
    readonly controller: CreationController | null;
    /** A hand-off's candidate (EA4.5); null without a backend or a candidate half. */
    readonly candidate: CandidatePanel | null;
    /** The panel made its controller, so disposing the panel disposes it. */
    private readonly owns: boolean;
    private readonly off: () => void;
    private readonly request: () => AgentTurnRequest;
    private readonly now: () => number;
    private readonly runBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Run agent turn');
    private readonly cancelBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', disabled: true }, 'Cancel');
    private readonly phase = h('span', { class: 'agent-phase' });
    private readonly elapsed = h('span', { class: 'agent-elapsed' });
    private readonly note = h('p', { class: 'agent-note' });
    private readonly reason = h('p', { class: 'agent-reason', hidden: true });
    private readonly meta = h('dl', { class: 'agent-meta', hidden: true });
    private readonly calls = h('ol', { class: 'agent-calls' });
    private readonly question = h('blockquote', { class: 'agent-question', hidden: true });
    private readonly design = this.part('agent-design', 'Design');
    private readonly program = this.part('agent-program', 'Program');
    private readonly cost = h('p', { class: 'agent-cost', hidden: true });
    private timer = 0;
    private state: AgentTurnState | null = null;

    constructor(client: AgentClient | null, request: () => AgentTurnRequest, options: AgentPanelOptions = {}) {
        this.request = request;
        this.now = options.now ?? (() => performance.now());
        const own = !options.controller && client ? ownDeps(client, options.candidate && 'modules' in options.candidate ? options.candidate : undefined, this.now) : null;
        this.controller = options.controller ?? (own ? createCreationController(own) : null);
        this.owns = !options.controller;
        const writes = !!options.controller || !!own?.candidateSession;
        this.candidate = this.controller && options.candidate && writes ? new CandidatePanel(this.controller, options.candidate) : null;
        this.off = this.controller?.subscribe(st => this.render(st.turn)) ?? (() => {});
        this.runBtn.addEventListener('click', () => void this.run());
        this.cancelBtn.addEventListener('click', () => this.cancel());
        this.el = h('section', { class: 'agent', 'aria-label': 'Agent turn', dataset: { phase: 'idle', success: 'false' } },
            h('header', { class: 'panel-head' }, h('h2', null, 'Agent turn'), h('span', { class: 'panel-sub' }, 'EA2 · checked, never rendered')),
            h('div', { class: 'agent-status' }, this.phase, this.elapsed),
            this.note, this.reason, this.question,
            h('div', { class: 'agent-actions' }, this.runBtn, this.cancelBtn),
            this.meta, this.calls, this.design.el, this.program.el, this.cost,
            this.candidate?.el ?? null,
        );
        this.render(this.controller?.state.turn ?? null);
    }

    /**
     * Runs a turn with the idea as it is now, a Create on the controller that stops at its hand-off (Developer view's
     * step); any creation under way is superseded. Resolves with the turn's last state.
     */
    async run(): Promise<AgentTurnState | null> {
        if (!this.controller) return null;
        await this.controller.create(this.request(), { write: false });
        return this.controller.state.turn;
    }

    cancel(): void {
        this.controller?.cancel();
    }

    /** The panel is done: a controller of its own is disposed with it (what it runs cancelled); the studio's is left alone. */
    dispose(): void {
        if (this.owns) this.controller?.dispose();
        this.off();
        this.candidate?.dispose();
        clearInterval(this.timer);
    }

    private part(className: string, title: string) {
        const tag = h('span', { class: 'agent-tag' });
        const body = h('pre', { class: 'agent-json' });
        const el = h('details', { class: `agent-part ${className}`, hidden: true }, h('summary', null, title, ' ', tag), body);
        return { el, tag, body };
    }

    private render(s: AgentTurnState | null): void {
        this.state = s;
        const phase = s ? TURN_PHASES[s.phase] : null;
        this.el.dataset.phase = s?.phase ?? 'idle';
        this.el.dataset.success = String(phase?.success ?? false);
        this.runBtn.disabled = !this.controller;
        this.cancelBtn.disabled = s?.phase !== 'running';
        this.phase.textContent = phase ? `Turn ${s!.seq}: ${phase.label}` : this.controller ? 'No turn yet' : 'No backend';
        this.phase.className = `agent-phase tone-${phase?.tone ?? 'quiet'}`;
        this.note.textContent = !s ? (this.controller ? INTRO : NO_BACKEND) : s.phase === 'running' ? running(s) : phase!.note;
        this.note.hidden = !this.note.textContent;
        this.reason.hidden = !s?.reason;
        // The code before the reason, unless the reason starts with it already, as the backend's budget reasons do.
        const code = s?.code && s.reason && !s.reason.startsWith(s.code) ? s.code : null;
        this.reason.replaceChildren(...(s?.reason ? [code ? h('code', null, code) : '', code ? ' ' : '', s.reason] : []));
        this.question.hidden = !s?.question;
        this.question.textContent = s?.question ?? '';
        this.renderMeta(s);
        this.calls.replaceChildren(...(s?.calls ?? []).map(c => callRow(c, s!)));
        const checked = s?.phase === 'handed-off' ? 'checked, not rendered' : 'received, not handed off';
        this.fill(this.design, s?.design ?? null, checked);
        this.fill(this.program, s?.program ? readable(s.program) : null, checked);
        this.cost.hidden = !s?.calls.length;
        if (s?.calls.length) {
            const unknown = s.unreported ? ` · ${s.unreported} call${s.unreported === 1 ? '' : 's'} reported no usage: cost unknown` : '';
            this.cost.textContent = `${s.calls.length} model call${s.calls.length === 1 ? '' : 's'} · ${usd(s.costMicroUsd)} reported${s.phase === 'running' ? ' so far' : ''}${unknown}`;
        }
        this.tick();
        // The clock runs only while the turn does; once it ends, its time is fixed.
        if (s?.phase === 'running' && !this.timer) this.timer = window.setInterval(() => this.tick(), 100);
        if (s?.phase !== 'running' && this.timer) {
            clearInterval(this.timer);
            this.timer = 0;
        }
    }

    private tick(): void {
        this.elapsed.textContent = this.state ? fmtMs(elapsedMs(this.state, this.now())) : '';
    }

    private renderMeta(s: AgentTurnState | null): void {
        this.meta.hidden = !s?.meta;
        if (!s?.meta) {
            this.meta.replaceChildren();
            return;
        }
        const m = s.meta;
        // The reader refused any turn whose bundle, contract or adapters differ, so what shows here is this build's.
        const rows: [string, string][] = [['Turn', m.turnId], ['Model', `${m.model} (${m.source})`], ['Prompt', m.promptVersion],
            ['Bundle', `${m.bundleHash.slice(0, 12)}…, as this build`], ['Action', `${m.actionSchema ?? 'none'}, as this build`],
            ['Adapters', `${(m.manifestHash ?? 'none').slice(0, 12)}…, as this build`]];
        this.meta.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    }

    private fill(part: { el: HTMLDetailsElement; tag: HTMLElement; body: HTMLElement }, value: unknown, tag: string): void {
        part.el.hidden = value === null;
        part.tag.textContent = value === null ? '' : tag;
        const text = value === null ? '' : formatJson(value);
        // Rewritten only when it changes, so a reader's place in a long program survives the turn's later events.
        if (part.body.textContent !== text) part.body.textContent = text;
    }
}

/**
 * A program as a developer reads it: each node's config is JSON text on the wire, escaped inside the program's JSON, so
 * it is shown parsed (as text still: this is data, never markup); a config that does not parse is shown as it came.
 */
function readable(program: WorldProgram): unknown {
    return {
        nodes: program.nodes.map(n => {
            let config: unknown = n.config;
            try { config = JSON.parse(n.config); } catch { /* shown as the text it is */ }
            return { ...n, config };
        }),
    };
}

function running(s: AgentTurnState): string {
    const call = s.calls[s.calls.length - 1];
    if (!call) return s.meta ? 'The turn has started.' : 'Waiting for the backend\'s first word: its first charge.';
    return `Call ${call.n} (${PURPOSES[call.purpose] ?? call.purpose}) ${call.usage ? 'answered; acting on it' : 'is with the model'}.`;
}

function callRow(c: TurnCall, s: AgentTurnState): HTMLElement {
    const u = c.usage;
    const tokens = !u ? (s.phase === 'running' && c === s.calls[s.calls.length - 1] ? 'with the model…' : 'no usage reported: cost unknown')
        : `${u.in === null ? '?' : fmtInt(u.in)} in / ${u.out === null ? '?' : fmtInt(u.out)} out`
            + `${u.reasoning ? ` (${fmtInt(u.reasoning)} reasoning)` : ''}${u.cached ? `, ${fmtInt(u.cached)} cached` : ''}`
            + ` · ${usd(u.costMicroUsd)}${u.in === null ? ' held, no usage came' : ''}`;
    const time = c.answeredMs === null ? '' : fmtMs(c.answeredMs - c.startedMs);
    const reads = c.tools ? h('ul', { class: 'agent-reads' },
        c.tools.error ? h('li', { class: 'is-warn' }, `${c.tools.error}: no reads left in this turn`) : null,
        c.tools.results.map(readRow)) : null;
    const check = c.check ? h('div', { class: `agent-call-check ${c.check.ok ? 'is-ok' : 'is-fail'}` },
        c.check.ok ? 'Check passed' : `Check failed: ${c.check.findings.filter(f => f.level === 'fail').length} failing`,
        c.check.findings.some(f => f.level === 'warn') ? `, ${c.check.findings.filter(f => f.level === 'warn').length} warning` : '') : null;
    // Each call keeps its own findings, so what a revision fixed stays readable after the hand-off.
    const findings = c.check?.findings.length ? h('ul', { class: 'agent-findings' }, c.check.findings.map(f => h('li', { class: `agent-finding is-${f.level}` },
        h('span', { class: 'agent-finding-code' }, `${f.level} ${f.code}`), ' ', h('span', { class: 'agent-finding-path' }, f.path), ': ', f.message))) : null;
    return h('li', { class: 'agent-call', dataset: { n: String(c.n) } },
        h('div', { class: 'agent-call-head' }, h('b', null, `Call ${c.n}`), ' ', h('span', null, PURPOSES[c.purpose] ?? c.purpose), h('span', { class: 'agent-call-time' }, time)),
        h('div', { class: 'agent-call-usage' }, tokens),
        reads, check, findings);
}

function readRow(r: AgentToolResult): HTMLElement {
    return h('li', { class: r.ok ? 'is-ok' : 'is-err' }, h('code', null, r.tool || '?'), ' ', r.target || '(nothing named)', ' · ',
        r.ok ? fmtBytes(r.bytes) : `refused: ${r.error}`);
}
