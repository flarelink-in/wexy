// The creator's Create on the agent path, behind `?create=agent` (EA9.1; agent-first-studio-design.md §6 and §7; Q114,
// Q115 (a) and Q118 decided 2026-11-03): the idea box's one primary button, read by the creation's phase, and the
// Journey's four rows on the controller's real events. Plain words only (§2's P5): no id(C), Q_C, WGSL, JSON or GPU
// numbers; a turn's question, the one model-written thing shown, is set as text (coding principles §2).
//   idle, installed, stopped, cancelled   "Create world": one turn, its modules and their repairs (Q118)
//   turn, writing, running                "Stop": nothing is applied, the world on the stage stays
//   ready                                 "Show it", the GPU go (Q115 (a)); beside it a quiet "Create world" for a new idea
//   installed, paused past its envelope   "Show it" again: the same world tested at this size (the EA9.2 review)
// One primary action per state (design guidelines §1): the accent stays on this one button whatever it says.
// EA9.2 (§7; E6): each row counts its elapsed time, once a second while it runs, and says how long it took once done;
// a screen reader hears one sentence a phase, never a tick; a key held down presses once.

import type { AgentTurnRequest } from '../../forge-client/agent-client';
import { COPY } from '../../loop/copy';
import type { CreationController, CreationPhase, CreationRow, CreationState, CreationStep, StepState } from '../../loop/creation';
import { h } from '../../shared/dom';
import type { Journey } from './journey';

const BUSY: ReadonlySet<CreationPhase> = new Set(['turn', 'writing', 'running']);
const ROWS: readonly CreationRow[] = ['plan', 'build', 'check', 'ready'];

export interface CreationViewParts {
    /** The idea box's primary button: its label in its first span, its shortcut in its kbd. */
    readonly primary: HTMLButtonElement;
    readonly journey: Journey;
    /** The idea as the box holds it now; null when it is empty (the box is focused instead). */
    idea(): AgentTurnRequest | null;
    /** Why Create cannot start, beyond the controller's own (no stage yet, an example being built, no backend), or null. */
    blocked(): string | null;
    /** Playground mode owns the button while selected; this view leaves it alone. */
    enabled?(): boolean;
    /** The clock the controller times its steps by, in ms: `performance.now` unless a harness says otherwise. */
    now?(): number;
    /**
     * The world on the stage paused past what it was tested at (EA_RESIZE: a window grown past its display's envelope,
     * a page zoom): Show it is offered again, to test it at this size (the EA9.2 review). Absent, never.
     */
    paused?(): boolean;
}

/** Seconds, then minutes and seconds: "12 s", "1 min 05 s". An elapsed time, never an estimate (guidelines §2). */
export function elapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** A step's words with its time: a running one's so far, a done one's in all (EA9.2). */
export function timed(step: CreationStep, now: number): string {
    if (step.state === 'running' && step.since !== null) return `${step.detail}${step.detail.endsWith('…') ? '' : ' ·'} ${elapsed(now - step.since)}`;
    if (step.state === 'done' && step.took !== null && step.detail) return `${step.detail} · ${elapsed(step.took)}`;
    return step.detail;
}

/**
 * What a screen reader hears as `st` comes about (E6): one sentence a phase, its own words, no time in them. `resized`:
 * the world on the stage is paused past its envelope, and Show it offers to test it again.
 */
export function spoken(st: CreationState, resized = false): string {
    if (resized && st.phase === 'installed') return COPY.creation.resized;
    switch (st.phase) {
        case 'turn': return st.steps.plan.detail;
        case 'handed-off': return COPY.creation.planned;
        case 'writing': return COPY.creation.writingStart;
        case 'ready': return st.sentence ?? st.steps.check.detail;
        case 'running': return st.steps.check.detail;
        case 'installed': return COPY.creation.onStage;
        case 'stopped':
        case 'cancelled': return st.sentence ?? '';
        default: return '';
    }
}

/**
 * A round on the world on the stage that brought no new world, come back to it (`last` the phase seen before): its panel
 * says what came of the round (improve-view.ts), so the Journey does not say "on the stage" as if a new world had come
 * (EA9.4's review). Not an improvement shown, which comes back through its Run.
 */
export function roundCameBack(last: { phase: CreationPhase | null; improves: boolean }, st: Pick<CreationState, 'phase' | 'improves'>): boolean {
    return st.improves && st.phase === 'installed' && last.improves && last.phase === 'writing';
}

export class CreationView {
    /** A quiet "Create world" beside "Show it", for a new idea while a written world waits for its go. */
    readonly again = h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-again', hidden: true }, COPY.creation.create);
    private readonly controller: CreationController;
    private readonly parts: CreationViewParts;
    private readonly off: () => void;
    /** The rows last put on the Journey, so a publish that changed none leaves the Journey alone (an example's rows stay). */
    private applied = '';
    /** Once a second while a step runs: its elapsed time on the Journey. */
    private tick: ReturnType<typeof setInterval> | null = null;
    /** What was last said to a screen reader, and of which creation: said again only when it changes. */
    private said: { idea: AgentTurnRequest | null; words: string } = { idea: null, words: '' };
    /** The phase last seen, and whether it was a round on the world on the stage (EA9.4's review). */
    private last: { phase: CreationPhase | null; improves: boolean } = { phase: null, improves: false };

    /** Owns the primary button's press on the agent path: the studio's own handler leaves it to this view. */
    constructor(controller: CreationController, parts: CreationViewParts) {
        this.controller = controller;
        this.parts = parts;
        parts.primary.addEventListener('click', this.onPress);
        parts.primary.addEventListener('keydown', this.onKey);
        this.again.addEventListener('click', () => this.create());
        this.again.addEventListener('keydown', this.onKey);
        parts.journey.announceTransitionsOnly();
        this.off = controller.subscribe(() => this.render());
        this.render();
    }

    /** The primary button's press, as its label says: Create world, Stop, or Show it (a world ready, or one paused). */
    press(): void {
        if (this.parts.enabled?.() === false) return;
        const phase = this.controller.state.phase;
        if (phase === 'ready' || this.resized()) void this.controller.show();
        else if (BUSY.has(phase)) this.controller.cancel();
        else this.create();
    }

    /** The world on the stage, this controller's, paused past its envelope: Show it tests it again at this size. */
    private resized(): boolean {
        return this.controller.state.phase === 'installed' && !!this.parts.paused?.();
    }

    /** Ctrl+Enter: the primary action, never a Stop (a stray shortcut must not end a creation). */
    shortcut(): void {
        if (!BUSY.has(this.controller.state.phase)) this.press();
    }

    /** A new creation from the idea in the box: superseding a world written and waiting, never H's (creation.ts). */
    create(): void {
        if (this.parts.enabled?.() === false) return;
        if (this.createBlocked() !== null) return;
        const idea = this.parts.idea();
        if (idea) void this.controller.create(idea);
    }

    dispose(): void {
        this.off();
        this.stopTicking();
        this.parts.primary.removeEventListener('click', this.onPress);
        this.parts.primary.removeEventListener('keydown', this.onKey);
        this.again.remove();
    }

    /**
     * A double click is one press (P7): its second click lands on the button after its label has turned (Create world to
     * Stop, Show it to Stop), and must not stop what the first started. Keyboard presses carry no click count.
     */
    private readonly onPress = (event: MouseEvent): void => {
        if (event.detail > 1) return;
        this.press();
    };

    /**
     * The keyboard's double click (E6): a held Enter repeats its press, and the repeat would land on the button after it
     * turned, a Stop. Only the first press of a key counts.
     */
    private readonly onKey = (event: KeyboardEvent): void => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    };

    /** The button and the rows as the controller says now; the studio calls it too when what blocks Create changes. */
    render(): void {
        if (this.parts.enabled?.() === false) {
            this.again.hidden = true;
            this.stopTicking();
            return;
        }
        const st = this.controller.state;
        const busy = BUSY.has(st.phase);
        const ready = st.phase === 'ready' || this.resized();
        const primary = this.parts.primary;
        const label = primary.querySelector('span');
        if (label) label.textContent = ready ? COPY.creation.show : busy ? COPY.creation.stop : COPY.creation.create;
        primary.querySelector('kbd')?.toggleAttribute('hidden', busy);
        primary.classList.toggle('is-busy', busy);
        primary.disabled = ready ? this.controller.showBlocked() !== null : busy ? false : this.createBlocked() !== null;
        this.again.hidden = !ready;
        this.again.disabled = this.createBlocked() !== null;
        if (st.phase === 'idle') {
            this.stopTicking();
            return;
        }
        this.renderSteps();
        this.say(st);
    }

    /** The Journey's rows with their times; while one runs, again each second (EA9.2). */
    private renderSteps(): void {
        const st = this.controller.state;
        const now = this.parts.now?.() ?? performance.now();
        const steps = {} as Record<CreationRow, { state: StepState; detail: string }>;
        let counting = false;
        for (const row of ROWS) {
            const step = st.steps[row];
            steps[row] = { state: step.state, detail: timed(step, now) };
            counting ||= step.state === 'running' && step.since !== null;
        }
        // Paused past its envelope: the last step says so, and what to press, until the world runs again.
        if (this.resized()) steps.ready = { state: 'pending', detail: COPY.creation.resized };
        const rows = JSON.stringify(steps);
        if (rows !== this.applied) {
            this.applied = rows;
            this.parts.journey.apply(steps);
        }
        if (counting && !this.tick) this.tick = setInterval(() => this.renderSteps(), 1000);
        if (!counting) this.stopTicking();
    }

    private stopTicking(): void {
        if (this.tick) clearInterval(this.tick);
        this.tick = null;
    }

    /** One sentence for a screen reader at each change of phase or of its words, never at a count or a tick (E6). */
    private say(st: CreationState): void {
        const words = spoken(st, this.resized());
        const roundBack = roundCameBack(this.last, st);
        this.last = { phase: st.phase, improves: st.improves };
        // Kept as said, so a later change of words is heard; the panel says what came of the round.
        if (roundBack) {
            this.said = { idea: st.idea, words };
            return;
        }
        if (!words || (st.idea === this.said.idea && words === this.said.words)) return;
        this.said = { idea: st.idea, words };
        this.parts.journey.announce(words);
    }

    private createBlocked(): string | null {
        return this.parts.blocked() ?? this.controller.createBlocked();
    }
}
