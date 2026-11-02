// A saved attempt replayed in Developer view, behind ?agent=1 (11-02; the user: "add it as preset or link so i could
// verify visually the outputs"). `?agent=1&replay=<name>` loads dev/replays/<name>.json, which only the dev server
// serves; "Open a saved attempt…" takes any bundle Developer view downloaded. Its program and bodies are sealed again
// by this host and compiled by L3 on this device (loop/replay.ts). "Run on this GPU" is then the studio's own Run for
// it, the developer's GPU go: the gate, eligibility, the probe and the first frame, as for any candidate (Q89). No
// model is called and nothing is spent. Everything from the file is set as text, never as HTML.

import type { CompiledBody, ModuleCompiler } from '../../contract/adapters/bodies';
import type { DeepReadonly } from '../../contract/engine/frozen';
import { compileSaved, sealSaved, type Replay } from '../../loop/replay';
import { h } from '../../shared/dom';
import type { RunControl, RunSummary } from './candidate-view';

export interface ReplayOptions {
    /** The studio's device compiler: null until the device exists, and with no WebGPU. */
    compiler: () => ModuleCompiler | null;
    /** The studio's stage, as the candidate panel reaches it. */
    run: RunControl;
    /** A named replay's text; the studio's reads the dev server's dev/replays. */
    named?: (name: string) => Promise<string>;
}

/** A replay's name: what dev/replays holds, never a path. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const short = (id: string) => `${id.slice(0, 12)}…`;

export class ReplayPanel {
    readonly el: HTMLElement;
    private readonly compiler: () => ModuleCompiler | null;
    private readonly control: RunControl;
    private readonly named: (name: string) => Promise<string>;
    private readonly source = h('p', { class: 'cand-note' });
    private readonly l3 = h('p', { class: 'cand-l3' });
    private readonly reason = h('p', { class: 'cand-reason', hidden: true });
    private readonly picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    private readonly openBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Open a saved attempt…');
    private readonly runBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: true }, 'Run on this GPU');
    private readonly runLine = h('p', { class: 'cand-run' });
    private replay: Replay | null = null;
    private compiled: DeepReadonly<CompiledBody>[] | null = null;
    private problem: string | null = null;
    private from = '';
    private busy: 'reading' | 'compiling' | null = null;
    private running = false;
    private last: { candidate: string; summary: RunSummary } | null = null;
    /** Moves with each load: a seal or a compile from an older one is dropped. */
    private loads = 0;

    constructor(options: ReplayOptions) {
        this.compiler = options.compiler;
        this.control = options.run;
        this.named = options.named ?? (async name => {
            const res = await fetch(`/dev/replays/${name}.json`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`dev/replays/${name}.json is not here (${res.status}): only the dev server serves it`);
            return res.text();
        });
        this.openBtn.addEventListener('click', () => this.picker.click());
        this.picker.addEventListener('change', () => {
            const file = this.picker.files?.[0];
            this.picker.value = '';
            if (file) void this.load(file.name, file.text());
        });
        this.runBtn.addEventListener('click', () => void this.run());
        this.el = h('section', { class: 'cand cand-replay', 'aria-label': 'Replay', dataset: { run: 'idle' } },
            h('header', { class: 'cand-head' }, h('h3', null, 'Replay'), h('span', { class: 'panel-sub' }, 'a saved attempt, sealed and compiled here; no model call')),
            this.source, this.l3, this.reason,
            h('div', { class: 'cand-actions' }, this.openBtn, this.picker, this.runBtn),
            this.runLine,
        );
        this.render();
    }

    /** `?replay=<name>`: dev/replays/<name>.json. */
    loadNamed(name: string): Promise<void> {
        if (!NAME.test(name)) return this.load(name, Promise.reject(new Error('a replay is named by lower-case letters, digits and dashes, as dev/replays holds it')));
        return this.load(`dev/replays/${name}.json`, this.named(name));
    }

    /** A saved attempt's text, from wherever it came: sealed by this host, then compiled once a device compiler is here. */
    async load(from: string, text: Promise<string>): Promise<void> {
        const load = ++this.loads;
        this.from = from;
        this.replay = null;
        this.compiled = null;
        this.problem = null;
        this.busy = 'reading';
        this.render();
        let sealed: Awaited<ReturnType<typeof sealSaved>>;
        try {
            sealed = await sealSaved(await text);
        } catch (e) {
            sealed = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        if (load !== this.loads) return;
        this.busy = null;
        if (sealed.ok) this.replay = sealed.replay;
        else this.problem = sealed.reason;
        this.render();
        await this.compile();
    }

    /** The studio calls it once its device compiler exists: a sealed replay waiting for L3 is compiled then. */
    refresh(): void {
        this.render();
        void this.compile();
    }

    /** The developer's GPU go for the replay shown, and the studio's own Run of it. */
    async run(): Promise<RunSummary | null> {
        const replay = this.replay;
        const compiled = this.compiled;
        if (!replay || !compiled || this.running || this.control.blocked() !== null) return null;
        this.running = true;
        this.render();
        let summary: RunSummary;
        try {
            summary = await this.control.go(replay.snapshot, compiled);
        } catch (e) {
            summary = { status: 'failed', reason: `internal: ${e instanceof Error ? e.message : String(e)}`, numbers: '' };
        }
        this.running = false;
        this.last = { candidate: replay.snapshot.id, summary };
        this.render();
        return summary;
    }

    private async compile(): Promise<void> {
        const replay = this.replay;
        const compiler = this.compiler();
        if (!replay || this.compiled || this.busy || !compiler) return;
        const load = this.loads;
        this.busy = 'compiling';
        this.render();
        let compiled: DeepReadonly<CompiledBody>[] | null = null;
        let problem: string | null = null;
        try {
            compiled = await compileSaved(replay.snapshot, compiler);
        } catch (e) {
            problem = `L3 could not run: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (load !== this.loads) return;
        this.busy = null;
        this.compiled = compiled;
        if (problem) this.problem = problem;
        this.render();
    }

    private render(): void {
        const replay = this.replay;
        this.source.textContent = !this.from ? 'Open a bundle Developer view downloaded, or name one of dev/replays with &replay=<name>.'
            : `${this.from}${replay ? ` · ${replay.attempt} · id(C) ${short(replay.snapshot.id)} · ${replay.snapshot.x.nodes.length} nodes, ${replay.snapshot.bodies.length} modules` : ''}`
                + (replay?.prompt ? ` · "${replay.prompt}"` : '');
        this.reason.hidden = this.problem === null;
        this.reason.textContent = this.problem ?? '';
        const refused = this.compiled?.filter(c => !c.ok) ?? [];
        this.l3.textContent = this.busy === 'reading' ? 'Reading and sealing it here…'
            : this.busy === 'compiling' ? 'Compiling each body on this device (L3)…'
                : !replay ? ''
                    : !this.compiled ? (this.compiler() ? '' : 'L3 waits for this device\'s compiler (it needs WebGPU).')
                        : refused.length ? `L3 refused ${refused.map(c => c.module).join(', ')} on this device: Run needs every body compiled.`
                            : `L3: ${this.compiled.length} of ${this.compiled.length} bodies compiled on this device.`;
        const blocked = !replay ? 'Run needs a sealed replay: open one first.'
            : !this.compiled || refused.length ? 'Run needs this device\'s L3 verdict on every body.'
                : this.control.blocked();
        this.runBtn.disabled = this.running || this.busy !== null || blocked !== null;
        this.runBtn.title = blocked ?? 'The GPU go for this replay: admitted, built, probed and checked here before it reaches the stage.';
        this.runBtn.textContent = this.running ? 'Running…' : 'Run on this GPU';
        const last = this.last && replay && this.last.candidate === replay.snapshot.id ? this.last.summary : null;
        this.el.dataset.run = this.running ? 'running' : last?.status ?? 'idle';
        this.runLine.className = `cand-run${last ? ` is-${last.status}` : ''}`;
        this.runLine.textContent = this.running ? 'Running on this GPU: the gate, the build, the probe, the first frame offscreen. The world on the stage keeps running.'
            : last?.status === 'installed' ? `On the stage: id(C) ${short(replay!.snapshot.id)}${last.numbers ? ` · ${last.numbers}` : ''}`
                : last ? `${last.status}: ${last.reason ?? ''}${last.numbers ? ` · ${last.numbers}` : ''}`
                    : replay ? blocked ?? 'Ready: Run on this GPU puts it on the stage once every check passes.' : '';
    }
}
