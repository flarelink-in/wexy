// The director panel: every spec uniform becomes a slider bound to the GPU `params` buffer, and the
// post chain's runtime properties sit beside them. Moving one writes memory, never a pipeline.
// Labels are for everyone; the uniform names, stats and post-chain details are Developer view only.

import type { SceneRuntime } from '../../runtime/scene-runtime';
import type { Viewport } from '../../runtime/viewport';
import { h } from '../../shared/dom';
import { fmtInt, fmtNum } from '../../shared/format';
import { icon } from '../../shared/icons';
import { QUALITY_UNIFORM } from '../../contract/spec';

interface SliderDef {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    initial: number;
    hint?: string;
    /** Shown in Developer view only. */
    dev?: boolean;
    set: (v: number) => void;
}

interface Slider {
    el: HTMLElement;
    def: SliderDef;
    set: (v: number) => void;
}

/** Preview modes map onto the viewport guard: null lets it choose, a number pins a ladder rung. */
const PREVIEW_MODES: Array<{ label: string; rung: number | null; title: string }> = [
    { label: 'Auto', rung: null, title: 'Keeps the preview smooth on this device' },
    { label: 'Smooth', rung: 6, title: 'Fastest preview: lower detail while you explore' },
    { label: 'Balanced', rung: 3, title: 'Some detail traded for speed' },
    { label: 'Sharp', rung: 0, title: 'Full detail, even if the preview stutters' },
];

export class DirectorPanel {
    readonly el: HTMLElement;
    /** Fires after any control changes, with the uniform name when it was a scene uniform. */
    onChange?: (uniform?: string) => void;
    onResetSim?: () => void;

    private readonly body: HTMLElement;
    private readouts: Array<() => void> = [];

    constructor() {
        this.body = h('div', { class: 'director-body' });
        this.el = h('div', { class: 'director' }, this.body);
        this.clear();
    }

    clear(): void {
        this.readouts = [];
        this.body.replaceChildren(h('div', { class: 'inspector-empty' },
            h('span', { html: icon('sliders', 22) }),
            h('p', null, 'Controls for your world appear here: things like spin, wind and glow. Move one and the world changes instantly.'),
        ));
    }

    bind(runtime: SceneRuntime, viewport: Viewport): void {
        const { spec, post } = runtime;
        const sceneDefs: SliderDef[] = Object.entries(spec.uniforms)
            .filter(([name]) => name !== QUALITY_UNIFORM)
            .map(([name, u]) => ({
                label: u.label, min: u.min, max: u.max, step: u.step ?? 0.01, value: runtime.getParam(name), initial: u.value,
                hint: `params.${name}`,
                set: v => { runtime.setParam(name, v); this.onChange?.(name); },
            }));

        const lookDefs: SliderDef[] = [];
        const tm = post.tonemap;
        lookDefs.push({ label: 'Brightness', min: 0.2, max: 3, step: 0.01, value: tm.exposure, initial: tm.exposure, hint: `Tonemap.exposure · ${tm.curve}`, set: v => { tm.exposure = v; this.onChange?.(); } });
        if (post.bloom) {
            const b = post.bloom;
            lookDefs.push({ label: 'Glow', min: 0, max: 2, step: 0.01, value: b.intensity, initial: b.intensity, hint: 'Bloom.intensity', set: v => { b.intensity = v; this.onChange?.(); } });
            lookDefs.push({ label: 'Glow threshold', min: 0, max: 3, step: 0.01, value: b.threshold, initial: b.threshold, hint: 'Bloom.threshold', dev: true, set: v => { b.threshold = v; this.onChange?.(); } });
        }
        if (post.halation) {
            const hl = post.halation;
            lookDefs.push({ label: 'Warm halo', min: 0, max: 2, step: 0.01, value: hl.intensity, initial: hl.intensity, hint: 'Halation.intensity', set: v => { hl.intensity = v; this.onChange?.(); } });
        }
        if (post.outline) {
            const o = post.outline;
            lookDefs.push({ label: 'Outlines', min: 0, max: 1, step: 0.01, value: o.strength, initial: o.strength, hint: 'Outline.strength', set: v => { o.strength = v; this.onChange?.(); } });
        }
        if (post.vignette) {
            const vg = post.vignette;
            lookDefs.push({ label: 'Vignette', min: 0, max: 1, step: 0.01, value: vg.intensity, initial: vg.intensity, hint: 'Vignette.intensity', set: v => { vg.intensity = v; this.onChange?.(); } });
        }
        const scene = sceneDefs.map(slider);
        const look = lookDefs.map(slider);

        this.readouts = [];
        const stats = h('dl', { class: 'stat-grid dev-only' });
        const stat = (label: string, read: () => string) => {
            const dd = h('dd');
            stats.append(h('dt', null, label), dd);
            this.readouts.push(() => { dd.textContent = read(); });
        };
        stat('Particles', () => fmtInt(runtime.count));
        stat('GPU state', () => `${fmtInt(runtime.count * 32 / 1048576)} MiB`);
        stat('Internal res', () => `${viewport.frameStats.width}×${viewport.frameStats.height}`);
        stat('Quality', () => runtime.qualityFloor === null ? 'n/a' : viewport.frameStats.quality.toFixed(2));
        stat('Sim time', () => `${runtime.simTime.toFixed(1)} s`);
        stat('Steps', () => fmtInt(runtime.frame));

        // Gentle variety around the drafted values: a third of each range either way, so a shuffle
        // stays recognisably the same world and one click on Reset brings it back.
        const surprise = h('button', { type: 'button', class: 'btn btn-sm', title: 'Try a random variation of this world', html: `${icon('shuffle', 13)}<span>Surprise me</span>` });
        surprise.addEventListener('click', () => {
            for (const s of scene) {
                const { min, max, initial, step } = s.def;
                const v = initial + (Math.random() * 2 - 1) * (max - min) / 3;
                s.set(Math.min(max, Math.max(min, Math.round(v / step) * step)));
            }
        });
        const resetAll = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', title: 'Put every control back where it started', html: `${icon('reset', 13)}<span>Reset</span>` });
        resetAll.addEventListener('click', () => { for (const s of [...scene, ...look]) s.set(s.def.initial); });

        const preview = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Preview quality' },
            PREVIEW_MODES.map(m => h('button', {
                type: 'button', role: 'radio', title: m.title, 'aria-checked': String(viewport.pinnedRung === m.rung),
                onclick: (e: Event) => {
                    viewport.pin(m.rung);
                    for (const b of preview.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
                },
            }, m.label)),
        );
        const pause = h('button', { type: 'button', class: 'btn btn-sm', html: `${icon(viewport.simPaused ? 'play' : 'pause', 13)}<span>${viewport.simPaused ? 'Resume' : 'Pause'}</span>` });
        pause.addEventListener('click', () => {
            viewport.simPaused = !viewport.simPaused;
            pause.innerHTML = `${icon(viewport.simPaused ? 'play' : 'pause', 13)}<span>${viewport.simPaused ? 'Resume' : 'Pause'}</span>`;
        });
        const restart = h('button', { type: 'button', class: 'btn btn-sm', title: 'Start the motion again from the beginning', html: `${icon('reset', 13)}<span>Restart</span>`, onclick: () => this.onResetSim?.() });

        this.body.replaceChildren(
            section('Scene', `${scene.length} uniforms · from the draft`, [
                ...scene.map(s => s.el),
                h('div', { class: 'row-buttons' }, surprise, resetAll),
            ]),
            section('Look', 'NullGraph PostChain · live params', look.map(s => s.el)),
            section('Motion', 'fixed dt 1/60 s · deterministic seed', [h('div', { class: 'row-buttons' }, pause, restart), stats]),
            section('Preview', 'export always renders at full quality', [
                preview,
                h('p', { class: 'dir-note' }, 'Only the live preview changes. Photos and videos always use full quality.'),
            ]),
        );
        this.refresh();
    }

    /** Update the live readouts; cheap enough to call a few times a second. */
    refresh(): void {
        for (const r of this.readouts) r();
    }
}

/** A titled group; `devSub` is its technical subtitle, shown in Developer view. */
function section(title: string, devSub: string, children: Node[]): HTMLElement {
    return h('section', { class: 'dir-section' },
        h('header', null, h('h3', null, title), h('span', { class: 'dev-only' }, devSub)),
        children);
}

function slider(def: SliderDef): Slider {
    const out = h('output', null, fmtNum(def.value, def.step));
    const input = h('input', {
        type: 'range', min: def.min, max: def.max, step: def.step, value: def.value, 'aria-label': def.label,
    });
    const fill = () => {
        const t = (Number(input.value) - def.min) / (def.max - def.min || 1);
        input.style.setProperty('--fill', `${(t * 100).toFixed(2)}%`);
    };
    input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmtNum(v, def.step);
        fill();
        def.set(v);
    });
    const set = (v: number) => {
        input.value = String(v);
        input.dispatchEvent(new Event('input'));
    };
    const label = h('label', { title: 'Double-click to reset' }, def.label);
    label.addEventListener('dblclick', () => set(def.initial));
    fill();
    const el = h('div', { class: def.dev ? 'field dev-only' : 'field' },
        h('div', { class: 'field-head' }, label, def.hint ? h('code', { class: 'dev-only' }, def.hint) : null, out),
        input);
    return { el, def, set };
}
