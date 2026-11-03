// The default view's progress: four fixed stages in plain words and one bar. The technical log
// (TracePanel) records the same run for Developer view; this is what everyone else sees.

import { h } from '../../shared/dom';
import { icon } from '../../shared/icons';

export type StageId = 'plan' | 'build' | 'check' | 'ready';
export type StageState = 'pending' | 'running' | 'done' | 'failed';

const STAGES: Array<{ id: StageId; title: string }> = [
    { id: 'plan', title: 'Planning the scene' },
    { id: 'build', title: 'Building the world' },
    { id: 'check', title: 'Testing it on your device' },
    { id: 'ready', title: 'Ready to film' },
];

interface Row {
    el: HTMLElement;
    status: HTMLElement;
    detail: HTMLElement;
    state: StageState;
}

export class Journey {
    readonly el: HTMLElement;
    private readonly rows = {} as Record<StageId, Row>;
    private readonly bar: HTMLElement;
    private readonly list: HTMLElement;
    private readonly idle: HTMLElement;
    /** What a screen reader hears of the steps once they count time (EA9.2, E6): a sentence a transition. */
    private readonly status = h('p', { class: 'sr-only', role: 'status' });
    private transitionsOnly = false;

    constructor() {
        this.list = h('ol', { class: 'journey-list' }, STAGES.map(s => {
            const status = h('span', { class: 'journey-status' });
            const detail = h('span', { class: 'journey-detail' });
            const el = h('li', { class: 'journey-step is-pending' }, status, h('div', null, h('span', { class: 'journey-title' }, s.title), detail));
            this.rows[s.id] = { el, status, detail, state: 'pending' };
            return el;
        }));
        this.bar = h('span');
        this.idle = h('p', { class: 'journey-idle' }, 'Pick an idea or type your own, then press Create. Your world appears in the middle, you shape it with the controls on the right, and Record turns it into a video.');
        this.el = h('section', { class: 'journey', 'aria-live': 'polite' },
            h('header', { class: 'panel-head' }, h('h2', null, 'Progress')),
            this.idle,
            h('div', { class: 'journey-bar', hidden: true }, this.bar),
            this.list,
        );
        this.list.hidden = true;
    }

    reset(): void {
        for (const s of STAGES) this.set(s.id, 'pending', '');
        this.idle.hidden = true;
        this.list.hidden = false;
        (this.bar.parentElement as HTMLElement).hidden = false;
        this.progress();
    }

    start(id: StageId, detail = ''): void {
        this.set(id, 'running', detail);
        this.said(id, detail);
    }

    detail(id: StageId, text: string): void {
        this.rows[id].detail.textContent = text;
    }

    done(id: StageId, detail?: string): void {
        this.set(id, 'done', detail);
        this.said(id, detail ?? '');
    }

    fail(id: StageId, detail: string): void {
        this.set(id, 'failed', detail);
        this.said(id, detail);
    }

    /**
     * For the agent path, whose rows count elapsed time every second (EA9.2, E6): the list stops being a live region, so
     * a tick is never read out. What changes is said once, by {@link announce}, in a status line only a screen reader
     * hears; h1's start, done and fail say their step there too. Until this is called, the whole list is live, as before.
     */
    announceTransitionsOnly(): void {
        this.transitionsOnly = true;
        this.el.removeAttribute('aria-live');
        if (!this.status.isConnected) this.el.append(this.status);
    }

    /** One sentence for a screen reader: a transition, never a count or a tick. */
    announce(text: string): void {
        this.status.textContent = text;
    }

    /**
     * All four rows at once, from a state the caller keeps (the agent path's creation controller, EA9.1). A row whose state
     * and words are unchanged is left as it is, so a running row's spinner never restarts.
     */
    apply(steps: Readonly<Record<StageId, { readonly state: StageState; readonly detail: string }>>): void {
        this.idle.hidden = true;
        this.list.hidden = false;
        (this.bar.parentElement as HTMLElement).hidden = false;
        for (const s of STAGES) {
            const row = this.rows[s.id];
            const next = steps[s.id];
            if (row.state !== next.state) this.set(s.id, next.state, next.detail);
            else if (row.detail.textContent !== next.detail) row.detail.textContent = next.detail;
        }
    }

    /** The words shown before any run: a sentence in place of the invitation (a page that cannot create, EA9.1). */
    say(text: string): void {
        this.idle.textContent = text;
    }

    /** h1's transitions, once the list is no live region: its step's title and words. */
    private said(id: StageId, detail: string): void {
        if (!this.transitionsOnly) return;
        const title = STAGES.find(s => s.id === id)?.title ?? '';
        this.announce(detail ? `${title}: ${detail}` : title);
    }

    private set(id: StageId, state: StageState, detail?: string): void {
        const row = this.rows[id];
        row.state = state;
        row.el.className = `journey-step is-${state}`;
        row.status.innerHTML = state === 'running' ? '<i class="spinner"></i>'
            : state === 'done' ? icon('check', 12)
            : state === 'failed' ? icon('x', 12) : '';
        if (detail !== undefined) row.detail.textContent = detail;
        this.progress();
    }

    /** Done stages count fully and a running one half, so the bar moves as soon as work starts. */
    private progress(): void {
        const rows = Object.values(this.rows);
        const score = rows.reduce((n, r) => n + (r.state === 'done' ? 1 : r.state === 'running' ? 0.5 : 0), 0);
        this.bar.style.width = `${(score / rows.length) * 100}%`;
        this.bar.classList.toggle('failed', rows.some(r => r.state === 'failed'));
    }
}
