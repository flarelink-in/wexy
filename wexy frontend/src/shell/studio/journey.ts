// The default view's progress: four fixed stages in plain words and one bar. The technical log
// (TracePanel) records the same run for Developer view; this is what everyone else sees.

import { h } from '../../shared/dom';
import { icon } from '../../shared/icons';

export type StageId = 'plan' | 'build' | 'check' | 'ready';
type StageState = 'pending' | 'running' | 'done' | 'failed';

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
    }

    detail(id: StageId, text: string): void {
        this.rows[id].detail.textContent = text;
    }

    done(id: StageId, detail?: string): void {
        this.set(id, 'done', detail);
    }

    fail(id: StageId, detail: string): void {
        this.set(id, 'failed', detail);
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
