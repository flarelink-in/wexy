// The technical log, shown in Developer view: one row per model call, gate pass, repair turn and
// GPU step, each with its own clock. Everyone else sees the same run as Journey's four stages.

import { h } from '../../shared/dom';
import { fmtInt, fmtMs } from '../../shared/format';
import { icon } from '../../shared/icons';

export type StepTone = 'spark' | 'code' | 'gate' | 'gpu' | 'live';
type StepState = 'running' | 'ok' | 'error' | 'warn';

/** Each step's actor: a role, since the model behind it is the backend's to report (on the call's line). */
const TONE_LABEL: Record<StepTone, string> = {
    spark: 'Planner',
    code: 'Author',
    gate: 'WGSL compiler',
    gpu: 'WebGPU',
    live: 'NullGraph',
};

export class TraceStep {
    readonly el: HTMLElement;
    private readonly status: HTMLElement;
    private readonly detail: HTMLElement;
    private readonly meta: HTMLElement;
    private readonly extra: HTMLElement;
    private readonly t0 = performance.now();
    private timer = 0;
    private text = '';

    constructor(title: string, tone: StepTone) {
        this.status = h('span', { class: 'step-status', html: '<i class="spinner"></i>' });
        this.detail = h('div', { class: 'step-detail' });
        this.meta = h('div', { class: 'step-meta' });
        this.extra = h('div', { class: 'step-extra' });
        this.el = h('li', { class: 'step is-running' },
            this.status,
            h('div', { class: 'step-main' },
                h('div', { class: 'step-head' }, h('span', { class: 'step-title' }, title), h('span', { class: `tag tag-${tone}` }, TONE_LABEL[tone])),
                this.detail, this.extra, this.meta,
            ),
        );
        this.timer = window.setInterval(() => this.tick(), 100);
    }

    get elapsedMs(): number {
        return performance.now() - this.t0;
    }

    /** Still ticking: neither ok, error nor warn has been called. */
    get running(): boolean {
        return this.timer !== 0;
    }

    setDetail(text: string): void {
        this.text = text;
        this.tick();
    }

    attach(node: Node): void {
        this.extra.append(node);
    }

    ok(detail?: string, meta?: string): void {
        this.finish('ok', detail, meta);
    }

    error(detail: string, meta?: string): void {
        this.finish('error', detail, meta);
    }

    warn(detail: string, meta?: string): void {
        this.finish('warn', detail, meta);
    }

    private tick(): void {
        this.detail.textContent = this.text;
        if (this.timer) this.meta.textContent = fmtMs(this.elapsedMs);
    }

    private finish(state: StepState, detail?: string, meta?: string): void {
        clearInterval(this.timer);
        this.timer = 0;
        if (detail !== undefined) this.text = detail;
        this.detail.textContent = this.text;
        this.meta.textContent = meta ?? fmtMs(this.elapsedMs);
        this.el.className = `step is-${state}`;
        const glyph = state === 'ok' ? 'check' : state === 'error' ? 'x' : 'alert';
        this.status.innerHTML = icon(glyph, 13);
    }

    dispose(): void {
        clearInterval(this.timer);
    }
}

export class TracePanel {
    readonly el: HTMLElement;
    private readonly list: HTMLElement;
    private readonly cost: HTMLElement;
    private readonly empty: HTMLElement;
    private steps: TraceStep[] = [];

    constructor() {
        this.list = h('ol', { class: 'trace-list' });
        this.empty = h('p', { class: 'trace-empty' }, 'Load an example to watch the compiler gate and the GPU work through it here; the agent\'s panels show a creation.');
        this.cost = h('div', { class: 'trace-cost' });
        this.el = h('section', { class: 'trace' },
            h('header', { class: 'panel-head' }, h('h2', null, 'Pipeline'), h('span', { class: 'panel-sub' }, 'prompt → spec → WGSL → gate → GPU')),
            this.empty, this.list, this.cost,
        );
        this.setCalls([]);
    }

    reset(): void {
        for (const s of this.steps) s.dispose();
        this.steps = [];
        this.list.replaceChildren();
        this.empty.hidden = false;
    }

    add(title: string, tone: StepTone): TraceStep {
        const step = new TraceStep(title, tone);
        this.steps.push(step);
        this.empty.hidden = true;
        this.list.append(step.el);
        // Follow the newest step inside the panel only. scrollIntoView would also scroll the page
        // when the panel is not its own scroll container (the stacked mobile layout).
        const scroller = this.el.closest<HTMLElement>('.panel');
        if (scroller && getComputedStyle(scroller).overflowY === 'auto') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        }
        return step;
    }

    /**
     * The run's model calls and their tokens as the backend reported them; unknown stays unknown, never zero. The
     * price is the backend's to know (it meters every call); a playground example makes no calls.
     */
    setCalls(calls: readonly { usage: { in: number; out: number } | null }[]): void {
        let tokens: { in: number; out: number } | null = { in: 0, out: 0 };
        for (const c of calls) tokens = tokens && c.usage ? { in: tokens.in + c.usage.in, out: tokens.out + c.usage.out } : null;
        const spent = calls.length === 0 ? 'No model calls'
            : `${calls.length} model call${calls.length === 1 ? '' : 's'} · <b>${tokens ? `${fmtInt(tokens.in)} in / ${fmtInt(tokens.out)} out tokens` : 'tokens unknown'}</b>`;
        this.cost.innerHTML = `<span>${spent}</span><span>GPU server cost <b class="zero">$0.00</b></span>`;
    }
}
