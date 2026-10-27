// Film export, its estimate and photos, on null-graph/film (docs/product/film-adoption-design.md, "design" below).
// The film draws on an engine of its own, on the app's device, from a runtime of its own built from the spec:
// the live preview is paused meanwhile, and never resized, stepped or reset. Its frames are the old exporter's
// (design §2): the runner draws frame j after its warm-up and (j + 1)·s steps, so the workload spends its first
// s steps after placement as no-ops and restarts the clock where SceneRuntime.reset() does, and frame j shows
// placement, the spec's warm-up and j·s steps, as it always has.

import type { NullGraph } from 'null-graph';
import {
    cleanupFilms, encodePNG, fitAspect, listFilms, recordFilm, removeFilm, snapshot,
    type CameraView as FilmView, type CreateFilmWorkload, type FilmCodec, type FilmProgress, type FilmReport, type FilmResult, type FilmTarget,
} from 'null-graph/film';
import type { SceneSpec } from '../contract/spec';
import type { CameraView } from '../runtime/camera-path';
import { SceneRuntime } from '../runtime/scene-runtime';

export interface FilmSettings {
    width: number;
    height: number;
    fps: 30 | 60;
    seconds: number;
}

export function codecLabel(codec: FilmCodec | null): string {
    return codec ? ({ avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', png: 'PNG' }[codec] ?? codec) : '—';
}

/** Wexy's own Web Lock on a film it is showing, so a start-up sweep in another tab leaves it alone (design §5.3). */
const showLock = (exportId: string) => `wexy-film:${exportId}`;

/** Hold a finished film for as long as it is on screen. Returns the release. Without Web Locks there is nothing to hold. */
export function holdFilm(exportId: string | null): () => void {
    if (!exportId || typeof navigator.locks?.request !== 'function') return () => {};
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    void navigator.locks.request(showLock(exportId), () => held);
    return () => release();
}

/**
 * At start-up: remove the films no tab is writing (null-graph's cleanupFilms: orphans of closed or crashed tabs), and
 * the finished films no Wexy tab is showing. The studio keeps no film library, so a finished film outlives its
 * dialog only by accident. A film finished in the last minute is left, in case its tab has not taken its lock yet.
 */
export async function sweepFilms(): Promise<string[]> {
    const removed: string[] = [];
    try { removed.push(...(await cleanupFilms()).removed); } catch { /* no Web Locks: a live film cannot be told from a dead one */ }
    if (typeof navigator.locks?.query !== 'function') return removed;
    const shown = new Set(((await navigator.locks.query()).held ?? []).map(l => l.name));
    for (const film of await listFilms()) {
        const finished = film.status === 'completed' || film.status === 'partial';
        const recent = Date.now() - Date.parse(film.updated ?? film.created ?? '') < 60_000;
        if (!finished || recent || shown.has(showLock(film.exportId))) continue;
        try { await removeFilm(film.exportId); removed.push(film.exportId); } catch { /* being written, or gone */ }
    }
    return removed;
}

/** null-graph's view (readonly, `fov` optional) as the runtime takes it. */
function asView(v: FilmView): CameraView {
    return { target: [v.target[0], v.target[1], v.target[2]], distance: v.distance, azimuth: v.azimuth, polar: v.polar, fov: v.fov ?? 45 };
}

/**
 * The film's workload: `spec` built on the film's engine, with the live runtime's parameters and quality
 * pinned to 1. `fps` sets the steps a frame (the runner's context does not carry it); `still` is the view
 * when the spec has no keyframes, the live camera's.
 */
export function filmWorkload(spec: SceneSpec, live: SceneRuntime | null, { fps, still }: { fps: number; still: CameraView }): CreateFilmWorkload {
    const { dt, warmupSeconds } = spec.particles;
    const s = Math.round(1 / (fps * dt));
    const W = Math.round(warmupSeconds / dt);
    return async ({ engine, width, height }) => {
        const { runtime, smoke } = await SceneRuntime.build(engine as NullGraph, spec, width, height);
        if (!runtime) throw new Error(`The scene did not build for the film: ${smoke.error ?? 'unknown error'}`);
        if (live) for (const name of live.uniformNames) runtime.setParam(name, live.getParam(name));
        runtime.quality = 1;
        const aspect = width / height;
        let leadIn = 0;
        let real = 0;
        return {
            dt,
            // Calibration steps and draws before this; the runner then asks for the exact initial state.
            reset() {
                runtime.place();
                leadIn = s;
                real = 0;
            },
            step() {
                if (leadIn > 0) { leadIn--; return; }
                if (real === W) runtime.restartClock();
                runtime.step();
                real++;
            },
            draw(frame) {
                runtime.view(asView(fitAspect(frame.view ?? still, aspect)), frame.seconds);
                return runtime.draw();
            },
            dispose() { runtime.destroy(); },
            info: { scene: spec.title, seed: spec.particles.seed, particles: runtime.count, warmupSteps: W, leadInSteps: s },
        };
    };
}

export interface ExportRequest {
    device: GPUDevice;
    spec: SceneSpec;
    /** The live runtime, read for its parameters only. */
    live: SceneRuntime | null;
    settings: FilmSettings;
    /** Film time in seconds → view, before reframing for the film's shape. */
    path: (seconds: number) => CameraView;
    still: CameraView;
    name: string;
    /** Default 'auto': OPFS where it is writable, else memory within its budget. */
    target?: FilmTarget;
    signal: AbortSignal;
    onProgress?: (p: FilmProgress) => void;
    onReport?: (r: FilmReport) => void;
}

/** Record the film: H.264 MP4, from an offscreen canvas, a finalized partial kept after a failure that is not a cancel. */
export function recordExport(r: ExportRequest): Promise<FilmResult<FilmReport>> {
    const { width, height, fps, seconds } = r.settings;
    return recordFilm({
        device: r.device,
        createWorkload: filmWorkload(r.spec, r.live, { fps, still: r.still }),
        film: { width, height, fps, seconds, warmupSeconds: r.spec.particles.warmupSeconds },
        camera: r.path,
        output: { container: 'mp4', target: r.target ?? 'auto', name: r.name },
        partial: 'keep-if-finalizable',
        signal: r.signal,
        onProgress: r.onProgress,
        onReport: r.onReport,
        provenance: { scene: r.spec.title, seed: r.spec.particles.seed, keyframes: r.spec.camera.keyframes.length },
    });
}

/**
 * What one frame costs at this size, measured by the runner itself: a film of one frame with no file, so the
 * runner's device turn, error scopes and teardown apply (design §5.1). Rejects with the runner's words when
 * calibration refuses the size.
 */
export async function measureExport(device: GPUDevice, spec: SceneSpec, live: SceneRuntime | null, settings: Omit<FilmSettings, 'seconds'>, view: CameraView, signal?: AbortSignal): Promise<{ msPerFrame: number; report: FilmReport }> {
    let report: FilmReport | null = null;
    await recordFilm({
        device,
        createWorkload: filmWorkload(spec, live, { fps: settings.fps, still: view }),
        film: { width: settings.width, height: settings.height, fps: settings.fps, seconds: 1 / settings.fps },
        output: false,
        camera: () => view,
        signal,
        onReport: rep => { report = rep; },
    });
    const done = report as FilmReport | null;
    if (!done?.guard.calibration) throw new Error('The measurement made no calibration.');
    return { msPerFrame: done.guard.calibration.msPerFrame, report: done };
}

/**
 * A photo of what the preview shows now, at any size: the live state copied into a runtime of the photo's
 * own, drawn once, read back exactly, and made opaque (a premultiplied additive scene can leave alpha below 1,
 * and a photo must not come out transparent). The preview must be paused (design §6).
 */
export async function snapshotLive(device: GPUDevice, live: SceneRuntime, width: number, height: number, view: CameraView): Promise<{ png: Blob; rgba: Uint8Array; translucent: number }> {
    const shot = await snapshot({
        device, width, height, seconds: live.simTime, view,
        createWorkload: async ({ engine, width: w, height: h }) => {
            const { runtime, smoke } = await SceneRuntime.build(engine as NullGraph, live.spec, w, h);
            if (!runtime) throw new Error(`The scene did not build for the photo: ${smoke.error ?? 'unknown error'}`);
            runtime.copyStateFrom(live);
            runtime.quality = 1;
            return {
                dt: live.spec.particles.dt,
                step() {},
                draw(frame) {
                    runtime.view(asView(fitAspect(frame.view ?? view, w / h)), frame.seconds);
                    return runtime.draw();
                },
                dispose() { runtime.destroy(); },
            };
        },
    });
    const { rgba } = shot;
    let translucent = 0;
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255) { translucent++; rgba[i] = 255; }
    }
    return { png: new Blob([(await encodePNG(rgba, width, height)) as Uint8Array<ArrayBuffer>], { type: 'image/png' }), rgba, translucent };
}
