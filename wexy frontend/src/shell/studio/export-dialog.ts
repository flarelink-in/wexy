// Export: shape, quality and length with an estimate measured on this GPU, a lockstep render, and the finished
// MP4 playing back in the dialog. The film is made by null-graph/film on an engine of its own (capture/film.ts):
// the preview waits, untouched, and the file streams to the browser's own storage (OPFS) or to a file the
// person picks. It never leaves the browser unless the person shares it. Codec, bitrate and per-frame timings
// are Developer view.

import { bitrateFor, probeFilm, type FilmProgress, type FilmReport, type FilmResult, type FilmTarget } from 'null-graph/film';
import type { CameraView } from '../../runtime/camera-path';
import { codecLabel, holdFilm, measureExport, recordExport, type FilmSettings } from '../../capture/film';
import type { SceneRuntime } from '../../runtime/scene-runtime';
import type { Viewport } from '../../runtime/viewport';
import { download, h } from '../../shared/dom';
import { fmtBytes, fmtClock, fmtInt, fmtMs } from '../../shared/format';
import { icon } from '../../shared/icons';
import type { SceneSpec } from '../../contract/spec';
import { FORMATS, frameSize, QUALITIES, type FormatId, type QualityId } from './formats';

export interface ExportContext {
    viewport: Viewport;
    /** The live runtime: read for its parameters, never stepped, resized or reset. */
    runtime: SceneRuntime;
    spec: SceneSpec;
    title: string;
    seconds: number;
    format: FormatId;
    /** The keyframe path stretched over a film of the given length. */
    pathFor: (seconds: number) => (t: number) => CameraView;
}

const LENGTHS = [6, 12, 20, 30];

/** "about 40 seconds", "about 3 minutes": an estimate should read like one. */
export function fmtAbout(ms: number): string {
    const s = ms / 1000;
    if (s < 10) return 'a few seconds';
    if (s < 55) return `about ${Math.round(s / 5) * 5} seconds`;
    const min = Math.round(s / 60);
    return min <= 1 ? 'about a minute' : `about ${min} minutes`;
}

/** The share sheet with the file attached, where the browser has one (most phones, Windows, macOS). */
export function canShareFile(file: File): boolean {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

export async function shareFile(file: File, title: string): Promise<void> {
    try {
        await navigator.share({ files: [file], title, text: `${title}, made with Wexy` });
    } catch {
        // Dismissing the share sheet rejects; there is nothing to report.
    }
}

/** The library's refusal in the dialog's words; the library's own words stay in Developer view. */
function plainWords(error: unknown, s: FilmSettings): string {
    const m = error instanceof Error ? error.message : String(error);
    if (/no WebCodecs encoder/.test(m)) return `This browser can't make a ${s.width}×${s.height} video. Pick a lower quality, or try Chrome or Edge.`;
    if (/per-submission limit|safety stop/.test(m)) return 'This quality is too heavy for this graphics card. Pick a lower quality.';
    if (/ran out of room|not enough storage/.test(m)) return "There isn't enough storage on this computer to finish the video. Free some space, or make it shorter or smaller.";
    if (/GPU device lost/.test(m)) return 'The graphics card stopped while making the video.';
    return m.replace(/^film: /, '');
}

const savePicker = (globalThis as { showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;

export class ExportDialog {
    readonly el: HTMLDialogElement;
    onBusy?: (busy: boolean) => void;

    private ctx: ExportContext | null = null;
    private format: FormatId = 'wide';
    private quality: QualityId = 'fhd';
    private settings: FilmSettings = { width: 1920, height: 1080, fps: 60, seconds: 12 };
    private msPerFrame: number | null = null;
    /** Why the measurement refused this size, in the dialog's words and the library's. */
    private refusal: { plain: string; detail: string } | null = null;
    private calibrating = false;
    private measureQueued = false;
    private abort: AbortController | null = null;
    private result: FilmResult<FilmReport> | null = null;
    private releaseHold: (() => void) | null = null;
    private videoUrl = '';
    private readonly body: HTMLElement;
    private readonly foot: HTMLElement;
    private readonly title: HTMLElement;
    private readonly sub: HTMLElement;

    constructor() {
        this.body = h('div', { class: 'ex-body' });
        this.foot = h('footer', { class: 'ex-foot' });
        this.title = h('h2', { id: 'ex-title' }, 'Make a video');
        this.sub = h('p');
        const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: icon('x', 16) });
        close.addEventListener('click', () => this.close());
        this.el = h('dialog', { class: 'export-dialog', 'aria-labelledby': 'ex-title' },
            h('header', { class: 'ex-head' }, h('div', null, this.title, this.sub), close),
            this.body, this.foot);
        this.el.addEventListener('cancel', e => { if (this.abort) e.preventDefault(); });
        this.el.addEventListener('close', () => void this.letGo());
        document.body.append(this.el);
    }

    open(ctx: ExportContext): void {
        void this.letGo();
        this.ctx = ctx;
        this.format = ctx.format;
        this.settings.seconds = ctx.seconds;
        this.applySize();
        this.title.textContent = 'Make a video';
        this.sub.textContent = `${ctx.title} · made on this computer, nothing is uploaded`;
        this.renderSetup();
        this.el.showModal();
        void this.measure();
    }

    private close(): void {
        if (this.abort) return;
        this.el.close();
    }

    /** Let the finished film go: its URL revoked, its hold released, its file removed from OPFS (never a picked file). */
    private async letGo(): Promise<void> {
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = '';
        this.releaseHold?.();
        this.releaseHold = null;
        const result = this.result;
        this.result = null;
        await result?.dispose().catch(() => {});
    }

    private applySize(): void {
        const { width, height } = frameSize(this.format, this.quality);
        this.settings.width = width;
        this.settings.height = height;
    }

    private fileName(s: FilmSettings): string {
        const title = this.ctx?.title ?? 'wexy';
        return `${title.split(':')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.format}-${Math.min(s.width, s.height)}p${s.fps}.mp4`;
    }

    /**
     * What a frame costs at the chosen size, measured by null-graph/film's runner on a copy of the scene: one
     * frame, no file (capture/film.ts). The preview waits meanwhile. A size change mid-measurement queues one more.
     */
    private async measure(): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        this.measureQueued = true;
        if (this.calibrating) return;
        this.calibrating = true;
        try {
            while (this.measureQueued) {
                this.measureQueued = false;
                this.msPerFrame = null;
                this.refusal = null;
                this.renderSetup();
                const { width, height, fps } = this.settings;
                const resume = ctx.viewport.pause();
                try {
                    const { msPerFrame } = await measureExport(ctx.viewport.engine.device, ctx.spec, ctx.runtime, { width, height, fps }, ctx.pathFor(this.settings.seconds)(0));
                    if (!this.measureQueued) this.msPerFrame = msPerFrame;
                } catch (e) {
                    if (!this.measureQueued) this.refusal = { plain: plainWords(e, this.settings), detail: (e as Error).message };
                } finally {
                    resume();
                }
            }
        } finally {
            this.calibrating = false;
            if (!this.abort && !this.result) this.renderSetup();
        }
    }

    private renderSetup(): void {
        const s = this.settings;
        const frames = Math.round(s.seconds * s.fps);

        const shapes = h('div', { class: 'ex-shapes', role: 'radiogroup', 'aria-label': 'Shape' },
            FORMATS.map(f => {
                const b = h('button', { type: 'button', role: 'radio', class: 'ex-shape', 'aria-checked': String(f.id === this.format) },
                    h('span', { class: `ex-shape-icon ex-shape-${f.id}`, html: icon(f.icon, 26) }),
                    h('b', null, f.label, h('small', null, f.ratio)),
                    h('span', null, f.where));
                b.addEventListener('click', () => {
                    this.format = f.id;
                    this.applySize();
                    void this.measure();
                });
                return b;
            }));
        // 4K stays in Developer view: at 4K the hardware H.264 path records about 8 Mbit/s whatever is asked, so
        // the film comes out blocky (red team R9; core-loop-frontend.md §9).
        const quality = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Quality' },
            QUALITIES.map(q => {
                const b = h('button', { type: 'button', role: 'radio', class: q.id === 'uhd' ? 'dev-only' : null, 'aria-checked': String(q.id === this.quality) }, q.label, h('small', null, `${q.lines}p`));
                b.addEventListener('click', () => {
                    this.quality = q.id;
                    this.applySize();
                    void this.measure();
                });
                return b;
            }));
        const lengths = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Length' },
            LENGTHS.map(n => {
                const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(n === s.seconds) }, `${n} s`);
                b.addEventListener('click', () => { s.seconds = n; this.renderSetup(); });
                return b;
            }));
        const fps = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Frame rate' },
            ([30, 60] as const).map(f => {
                const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(f === s.fps) }, `${f} fps`);
                b.addEventListener('click', () => { s.fps = f; this.renderSetup(); void this.measure(); });
                return b;
            }));
        const len = h('input', { type: 'number', min: 1, max: 300, step: 1, value: s.seconds, class: 'num', 'aria-label': 'Film length in seconds' });
        len.addEventListener('change', () => {
            s.seconds = Math.min(300, Math.max(1, Math.round(Number(len.value) || s.seconds)));
            this.renderSetup();
        });

        const ms = this.msPerFrame;
        // The encoder adds to the GPU time; ~8 ms covers H.264 at 1080p.
        const eta = ms === null ? null : frames * (Math.max(ms, 4) + 8 * (s.width * s.height) / (1920 * 1080));
        const tooSlow = this.refusal !== null;
        const rate = bitrateFor(s.width, s.height, s.fps);
        const estimate = h('div', { class: 'ex-estimate' },
            h('span', { html: icon('clock', 15) }),
            h('span', null, this.calibrating ? 'Measuring your graphics card…' : eta === null ? '—' : `Takes ${fmtAbout(eta)} to make`),
            h('span', { class: 'ex-free' }, 'Free'));
        const details = h('dl', { class: 'ex-summary dev-only' },
            item('Size', `${s.width}×${s.height}`),
            item('Frames', `${fmtInt(frames)} at t = f / ${s.fps}`),
            item('Bitrate asked', `${(rate / 1e6).toFixed(0)} Mbit/s · ≈ ${fmtBytes(rate * s.seconds / 8)} at most`),
            item('GPU cost', this.calibrating ? 'measuring…' : ms === null ? '—' : `${fmtMs(ms)} per frame`),
            item('Render time', eta === null ? '—' : `≈ ${fmtClock(eta / 1000)}`),
            item('Server cost', '$0.00', 'zero'),
        );
        this.body.replaceChildren(
            h('div', { class: 'ex-grid' },
                h('label', null, 'Shape'), shapes,
                h('label', null, 'Quality'), quality,
                h('label', null, 'Length'), h('div', { class: 'ex-len' }, lengths, h('span', null, 'the camera move stretches to fit')),
                h('label', { class: 'dev-only' }, 'Frame rate'), h('div', { class: 'dev-only' }, fps),
                h('label', { class: 'dev-only' }, 'Custom length'), h('div', { class: 'ex-len dev-only' }, len, h('span', null, 'seconds')),
            ),
            estimate,
            details,
        );
        if (this.refusal) {
            this.body.append(h('p', { class: 'ex-warn', html: `${icon('alert', 14)}<span></span>` }));
            (this.body.querySelector('.ex-warn span') as HTMLElement).textContent = this.refusal.plain;
            this.body.append(h('p', { class: 'ex-note-block dev-only' }, this.refusal.detail));
        }
        const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
        cancel.addEventListener('click', () => this.close());
        const blocked = tooSlow || this.calibrating;
        // A file the person picks: the handle must come from this click, before any long work (Chromium only).
        const pick = savePicker ? h('button', { type: 'button', class: 'btn', disabled: blocked, html: `${icon('download', 15)}<span>Save to a file…</span>` }) : null;
        pick?.addEventListener('click', async () => {
            let handle: FileSystemFileHandle;
            try {
                handle = await savePicker!({ suggestedName: this.fileName(s), types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
            } catch {
                return; // dismissed
            }
            void this.render({ file: handle });
        });
        const go = h('button', { type: 'button', class: 'btn btn-primary', disabled: blocked, html: `<i class="rec-dot"></i><span>Make video</span>` });
        go.addEventListener('click', () => void this.render('auto'));
        this.foot.replaceChildren(h('span', { class: 'ex-note' }, h('span', { class: 'dev-only' }, 'WebCodecs · null-graph/film · OPFS')), cancel, ...(pick ? [pick] : []), go);
    }

    private async render(target: FilmTarget): Promise<void> {
        // One film at a time. The click shows the progress at once (the probe below takes about a second), so a
        // second click, or a double click, finds this.abort set and does nothing.
        if (this.abort) return;
        const ctx = this.ctx!;
        const s = { ...this.settings };
        const abort = (this.abort = new AbortController());
        this.onBusy?.(true);
        this.title.textContent = 'Making your video…';
        const bar = h('div', { class: 'ex-bar' }, h('span'));
        const frameLine = h('div', { class: 'ex-frame', html: '<b>0%</b> · getting started' });
        const rate = h('div', { class: 'ex-rate dev-only' });
        this.body.replaceChildren(
            h('div', { class: 'ex-progress' }, frameLine, bar, rate),
            h('p', { class: 'ex-note-block' }, 'Every frame is drawn at full quality on its own copy of the scene, so a slower computer takes longer, but no frame is ever skipped.'),
        );
        const stop = h('button', { type: 'button', class: 'btn' }, 'Cancel');
        stop.addEventListener('click', () => abort.abort());
        const note = h('span', { class: 'dev-only' }, `${s.width}×${s.height} · ${s.fps} fps`);
        this.foot.replaceChildren(h('span', { class: 'ex-note' }, note), stop);

        let resume: (() => void) | null = null;
        try {
            await this.letGo();
            const support = await probeFilm({ width: s.width, height: s.height, fps: s.fps, device: ctx.viewport.engine.device });
            abort.signal.throwIfAborted();
            if (!support.codecs.length) {
                this.title.textContent = 'Make a video';
                this.renderError(`This browser can't make a ${s.width}×${s.height} video. Pick a lower quality, or try Chrome or Edge.`, support.reasons.join(' '));
                return;
            }
            note.textContent = `${codecLabel(support.codecs[0])} · ${s.width}×${s.height} · ${s.fps} fps`;
            resume = ctx.viewport.pause();
            const result = await recordExport({
                device: ctx.viewport.engine.device, spec: ctx.spec, live: ctx.runtime, settings: s,
                path: ctx.pathFor(s.seconds), still: ctx.pathFor(s.seconds)(0), name: this.fileName(s), target, signal: abort.signal,
                onProgress: p => this.showProgress(p, bar, frameLine, rate),
            });
            this.result = result;
            this.releaseHold = holdFilm(result.exportId);
            console.info(`Wexy: ${result.status} film, ${result.frames} frames, ${codecLabel(result.codec)}, ${result.file?.size ?? 0} bytes, ${result.target}`);
            this.renderDone(result);
        } catch (e) {
            this.title.textContent = 'Make a video';
            if ((e as Error).name === 'AbortError') this.renderSetup();
            else this.renderError(plainWords(e, s), (e as Error).message);
        } finally {
            resume?.();
            this.abort = null;
            this.onBusy?.(false);
        }
    }

    private showProgress(p: FilmProgress, bar: HTMLElement, frameLine: HTMLElement, rate: HTMLElement): void {
        (bar.firstChild as HTMLElement).style.width = `${(p.frame / p.frames) * 100}%`;
        if (p.phase === 'recording') {
            frameLine.innerHTML = `<b>${Math.floor((p.frame / p.frames) * 100)}%</b> · ${p.frame < 12 || p.etaMs === null ? 'getting started' : `${fmtAbout(p.etaMs)} left`}`;
            if (p.msPerFrame) rate.textContent = `Frame ${fmtInt(p.frame)} / ${fmtInt(p.frames)} · ${fmtMs(p.msPerFrame)} per frame · ${(1000 / p.msPerFrame).toFixed(1)} frames/s · ${fmtBytes(p.bytes)}`;
        } else {
            frameLine.innerHTML = p.phase === 'finalizing' ? '<b>100%</b> · finishing the file' : '<b>0%</b> · getting started';
        }
    }

    private renderDone(r: FilmResult<FilmReport>): void {
        const file = r.file!;
        this.videoUrl = URL.createObjectURL(file);
        const s = r.report.film;
        const shape = FORMATS.find(f => f.id === this.format)!;
        const name = r.name ?? this.fileName({ ...this.settings });
        const partial = r.status === 'partial';
        const shown = partial ? `${(r.frames / s.fps).toFixed(1)} s of ${s.seconds} s` : `${s.seconds} s`;
        this.title.textContent = partial ? 'Part of your video was made' : 'Your video is ready';
        const video = h('video', { class: `ex-video ex-video-${shape.id}`, src: this.videoUrl, controls: true, autoplay: true, muted: true, loop: true, playsinline: true });
        // The muted attribute set after creation is only defaultMuted: without the property, autoplay needs a gesture.
        video.muted = true;
        this.body.replaceChildren(
            video,
            h('p', { class: 'ex-done-line' }, `${shape.label} ${shape.ratio} · ${shown} · ${fmtBytes(file.size)} · ready for ${shape.where}`),
            ...(partial ? [h('p', { class: 'ex-warn', html: `${icon('alert', 14)}<span>The graphics card stopped before the end. This is everything made before it did.</span>` })] : []),
            h('dl', { class: 'ex-summary dev-only' },
                item('File', `${name} · ${r.target === 'file' ? 'saved to the chosen file' : r.target === 'opfs' ? "the browser's storage (OPFS)" : 'memory'}`),
                item('Video', `${codecLabel(r.codec)} · ${s.width}×${s.height} · ${s.fps} fps · ${r.frames} frames`),
                item('Bitrate', r.report.achievedBitrate ? `${(r.report.achievedBitrate / 1e6).toFixed(1)} Mbit/s made of ${((r.report.output?.bitrate ?? 0) / 1e6).toFixed(0)} asked` : '—'),
                item('Rendered in', `${fmtClock(r.report.timings.recordingMs / 1000)} · ${fmtMs(r.report.timings.msPerFrame ?? 0)} per frame`),
                ...(r.report.failure ? [item('Stopped by', r.report.failure)] : []),
                item('Server cost', '$0.00', 'zero'),
            ),
        );
        const again = h('button', { type: 'button', class: 'btn' }, 'Make another');
        again.addEventListener('click', () => {
            void this.letGo();
            this.title.textContent = 'Make a video';
            this.renderSetup();
            void this.measure();
        });
        const shareable = new File([file], name, { type: 'video/mp4' });
        const share = canShareFile(shareable)
            ? h('button', { type: 'button', class: 'btn', html: `${icon('share', 15)}<span>Share</span>`, onclick: () => void shareFile(shareable, this.ctx?.title ?? name) })
            : null;
        const save = r.target === 'file'
            ? h('span', { class: 'ex-note' }, `Saved as ${name}`)
            : h('button', { type: 'button', class: 'btn btn-primary', html: `${icon('download', 15)}<span>Download</span>`, onclick: () => download(file, name) });
        this.foot.replaceChildren(h('span', { class: 'ex-note' }, h('span', { class: 'dev-only' }, 'Deterministic on this device: the same spec renders the same frames here.')), again, ...(share ? [share] : []), save);
    }

    private renderError(message: string, detail = ''): void {
        this.body.replaceChildren(h('p', { class: 'ex-warn', html: `${icon('alert', 14)}<span></span>` }));
        (this.body.querySelector('.ex-warn span') as HTMLElement).textContent = message;
        if (detail && detail !== message) this.body.append(h('p', { class: 'ex-note-block dev-only' }, detail));
        const back = h('button', { type: 'button', class: 'btn' }, 'Back');
        back.addEventListener('click', () => { this.renderSetup(); void this.measure(); });
        this.foot.replaceChildren(back);
    }
}

function item(label: string, value: string, cls = ''): HTMLElement[] {
    return [h('dt', null, label), h('dd', cls ? { class: cls } : null, value)];
}
