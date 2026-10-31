// The film gates FG1 to FG6 (docs/product/film-adoption-design.md §8, "the design" below; its names for them
// are mapped in docs/playground-port-design.md): the studio's film path on null-graph/film, one case per load
// (film-gates.html?case=FG1), run in Chrome on each GPU by dev/film-gates.mjs. A case logs "[g] done" or
// "[g] failed: …" and leaves window.__FILM_G__ for the runner: its checks, what it measured, and the films it
// uploaded for ffprobe.
//   FG1  the adapter's frames equal the old export loop's, byte for byte (both read back), for each archetype
//        at 30 and 60 fps, at a vertical size, and for a spec with a warm-up. A naive adapter (no lead-in)
//        must not match, so the gate is seen to fail.
//   FG2  Kerr through the studio's export at the nine sizes (three shapes × 720/1080/2160), 60 fps, and Full HD
//        at 30 fps, to OPFS; the runner reads each film back. (The studio offers 4K in Developer view only.)
//   FG3  the preview (a Viewport on a canvas) is paused, and an export, a cancel and a failure leave its
//        runtime's clock, parameters and particles (hashed) and its canvas as they were; then it runs again.
//   FG4  ten exports in a row leave nothing on the device beyond the live scene; film engines collected.
//   FG5  cancels in every phase leave nothing in OPFS; a destroyed device keeps a decodable partial; a
//        crashed GPU process ends the film in the library's words, and the viewport reports the loss.
//   FG6  a photo of the live state equals the live runtime drawn at the photo's size, byte for byte.

import { NullGraph } from 'null-graph';
import {
    FrameReadback, listFilms, recordFilm, removeFilm, sha256,
    type CameraView as FilmView, type CreateFilmWorkload, type FilmProgress, type FilmReport, type FilmResult,
} from 'null-graph/film';
import { ARCHETYPES, archetypeSpec } from '../src/forge-client/archetypes';
import { cameraPath, firstView, fitView, type CameraView } from '../src/runtime/camera-path';
import { filmWorkload, recordExport, snapshotLive } from '../src/capture/film';
import { SceneRuntime } from '../src/runtime/scene-runtime';
import { Viewport } from '../src/runtime/viewport';
import type { SceneSpec } from '../src/contract/spec';
import { FORMATS, frameSize, QUALITIES } from '../src/shell/studio/formats';

type Detail = unknown;
const logEl = document.getElementById('log')!;
const log = (line: string, level: 'log' | 'error' = 'log') => {
    console[level](`[g] ${line}`);
    logEl.textContent += `${line}\n`;
};
const checks: { name: string; ok: boolean; detail: Detail }[] = [];
const check = (name: string, ok: boolean, detail: Detail = null) => {
    checks.push({ name, ok: !!ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, ok ? 'log' : 'error');
};

/** Each adapter a case was given, so the runner can tell the case ran on the GPU it asked for. */
const adapters: { vendor: string; architecture: string; description: string }[] = [];

async function requestDevice(): Promise<GPUDevice> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const { vendor, architecture, description } = adapter.info;
    adapters.push({ vendor, architecture, description });
    return adapter.requestDevice();
}

/** An archetype's scene, as the studio builds it; `warmupSeconds` overrides the spec's. */
function specOf(id: string, warmupSeconds?: number): SceneSpec {
    const a = ARCHETYPES.find(x => x.id === id);
    if (!a) throw new Error(`no archetype ${id}`);
    const spec = archetypeSpec(a);
    if (warmupSeconds !== undefined) spec.particles.warmupSeconds = warmupSeconds;
    return spec;
}

const asView = (v: FilmView): CameraView => ({ target: [v.target[0], v.target[1], v.target[2]], distance: v.distance, azimuth: v.azimuth, polar: v.polar, fov: v.fov ?? 45 });

const summary = (r: FilmReport | null) => r && {
    status: r.status, source: r.source, frames: r.frames, timings: r.timings, fencing: r.guard.fencing, switchedAt: r.guard.switchedAt,
    workload: r.workload, gpuErrors: r.gpuErrors, failure: r.failure, cleanupErrors: r.cleanupErrors,
};

// ---------------------------------------------------------------------------------------------------
// FG1: the adapter against the old export loop
// ---------------------------------------------------------------------------------------------------

/** The old exporter's loop (the playground's exporter.ts before null-graph/film, minus its canvas), on a headless engine of the film's size, read back. */
async function oldLoopHashes(device: GPUDevice, spec: SceneSpec, width: number, height: number, fps: number, seconds: number, path: (t: number) => CameraView): Promise<string[]> {
    const engine = new NullGraph();
    const init = await engine.init(null, { device, width, height });
    if (!init.success) throw new Error(init.error ?? 'the engine did not start');
    const { runtime, smoke } = await SceneRuntime.build(engine, spec, width, height);
    if (!runtime) { engine.destroy(); throw new Error(smoke.error ?? 'the scene did not build'); }
    const readback = new FrameReadback(device, engine.screenTexture as GPUTexture, width, height);
    const hashes: string[] = [];
    try {
        runtime.quality = 1;
        const frames = Math.max(1, Math.round(seconds * fps));
        const stepsPerFrame = Math.max(1, Math.round(1 / fps / spec.particles.dt));
        runtime.reset();
        for (let f = 0; f < frames; f++) {
            if (f > 0) for (let s = 0; s < stepsPerFrame; s++) runtime.step();
            const t = f / fps;
            runtime.view(fitView(path(t), width / height), t);
            engine.render(runtime.draw());
            readback.grab(f);
            const { bytes } = await readback.take();
            hashes.push(await sha256(bytes));
        }
    } finally {
        readback.destroy();
        runtime.destroy();
        engine.destroy();
    }
    return hashes;
}

/** The workload as the adoption would wire it without the design's §2: the runner's warm-up and frame steps, no lead-in, no clock restart. */
function naiveWorkload(spec: SceneSpec, still: CameraView): CreateFilmWorkload {
    return async ({ engine, width, height }) => {
        const { runtime, smoke } = await SceneRuntime.build(engine as NullGraph, spec, width, height);
        if (!runtime) throw new Error(smoke.error ?? 'the scene did not build');
        runtime.quality = 1;
        return {
            dt: spec.particles.dt,
            reset() { runtime.place(); },
            step() { runtime.step(); },
            draw(frame) {
                runtime.view(fitView(frame.view ? asView(frame.view) : still, width / height), frame.seconds);
                return runtime.draw();
            },
            dispose() { runtime.destroy(); },
        };
    };
}

/** A film's frame hashes through recordFilm (readback), and whether its engine was the app's NullGraph class. */
async function filmHashes(device: GPUDevice, createWorkload: CreateFilmWorkload, spec: SceneSpec, width: number, height: number, fps: number, seconds: number, path: (t: number) => CameraView) {
    let oneCore = true;
    const wrapped: CreateFilmWorkload = async ctx => {
        oneCore &&= ctx.engine instanceof NullGraph;
        return createWorkload(ctx);
    };
    let report: FilmReport | null = null;
    await recordFilm({
        device, createWorkload: wrapped, camera: path, output: false, hashes: true,
        film: { width, height, fps, seconds, warmupSeconds: spec.particles.warmupSeconds },
        onReport: r => { report = r; },
    });
    const done = report as FilmReport | null;
    return { hashes: [...(done?.hashes ?? [])], report: done, oneCore };
}

async function fg1(): Promise<Record<string, unknown>> {
    const device = await requestDevice();
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    const configs: { id: string; fps: 30 | 60; width: number; height: number; warmupSeconds?: number }[] = [
        ...ARCHETYPES.flatMap(a => ([30, 60] as const).map(fps => ({ id: a.id, fps, width: 640, height: 360 }))),
        // Vertical: fitAspect (null-graph) against fitView (the studio's), which reframe a 9:16 shot.
        { id: 'kerr-black-hole', fps: 60, width: 360, height: 640 },
        // A warm-up (W = 30 steps): the clock restarts after it, and frame 0 follows it.
        { id: 'kerr-black-hole', fps: 30, width: 640, height: 360, warmupSeconds: 0.5 },
    ];
    const results: Record<string, unknown>[] = [];
    for (const c of configs) {
        const spec = specOf(c.id, c.warmupSeconds);
        const seconds = 1;
        const still = firstView(spec.camera.keyframes);
        const path = cameraPath(spec.camera.keyframes, seconds) ?? (() => still);
        const label = `${c.id} ${c.width}×${c.height} ${c.fps} fps${c.warmupSeconds ? `, warm-up ${c.warmupSeconds} s` : ''}`;
        const want = await oldLoopHashes(device, spec, c.width, c.height, c.fps, seconds, path);
        const got = await filmHashes(device, filmWorkload(spec, null, { fps: c.fps, still }), spec, c.width, c.height, c.fps, seconds, path);
        const differ = want.map((h, j) => (h === got.hashes[j] ? -1 : j)).filter(j => j >= 0);
        check(`${label}: the adapter's ${want.length} frames equal the old loop's, byte for byte`, got.hashes.length === want.length && differ.length === 0,
            { frames: got.hashes.length, want: want.length, differ: differ.slice(0, 8) });
        check(`${label}: the film's engine is the app's NullGraph (one copy of the core)`, got.oneCore);
        check(`${label}: the scene moves frame to frame, so equality means something`, new Set(want).size === want.length, { distinct: new Set(want).size, frames: want.length });
        let naiveSame: number | null = null;
        if (!c.warmupSeconds) {
            const naive = await filmHashes(device, naiveWorkload(spec, still), spec, c.width, c.height, c.fps, seconds, path);
            naiveSame = naive.hashes.filter((h, j) => h === want[j]).length;
            check(`${label}: a naive adapter (no lead-in) does not match: the gate can fail`, naiveSame === 0, { sameFrames: naiveSame });
        }
        results.push({ label, frames: want.length, naiveSame, report: summary(got.report) });
    }
    await device.queue.onSubmittedWorkDone();
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    return { results };
}

// ---------------------------------------------------------------------------------------------------
// Shared by FG2…G6
// ---------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const describe = (result: FilmResult<FilmReport> | null, error: unknown) => (error ? `${(error as Error).name}: ${(error as Error).message}` : result?.status ?? 'nothing');

async function upload(name: string, body: Blob): Promise<void> {
    const res = await fetch(`/__g/upload/${encodeURIComponent(name)}`, { method: 'PUT', body });
    if (!res.ok) throw new Error(`upload of ${name} failed: HTTP ${res.status}`);
}

/** Upload a made film for the runner to read back, then let its storage go (a film left in OPFS fails the case). */
async function keep(id: string, result: FilmResult<FilmReport>, expected: { width: number; height: number; fps: number; frames: number; partial?: boolean }) {
    await upload(`${id}.mp4`, result.file!);
    await result.dispose();
    return { file: `${id}.mp4`, id, target: result.target, ...expected };
}

/** Every buffer, texture and query set made on `device` and not yet destroyed. */
function trackDevice(device: GPUDevice) {
    const alive = new Map<object, string>();
    const wrap = <D extends { label?: string }, O extends { destroy(): void }>(kind: string, make: (d: D) => O) => (d: D): O => {
        const object = make(d);
        alive.set(object, `${kind} ${d?.label ?? '(no label)'}`);
        const destroy = object.destroy.bind(object);
        object.destroy = () => { alive.delete(object); destroy(); };
        return object;
    };
    device.createBuffer = wrap('buffer', device.createBuffer.bind(device));
    device.createTexture = wrap('texture', device.createTexture.bind(device));
    device.createQuerySet = wrap('querySet', device.createQuerySet.bind(device));
    return { live: () => ({ count: alive.size, labels: [...alive.values()].sort() }) };
}

async function bufferHash(device: GPUDevice, buffer: GPUBuffer, size: number): Promise<string> {
    const read = device.createBuffer({ label: 'gates/read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, read, 0, size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return sha256(bytes);
}

/** A live runtime's whole state: its clock, its parameters and a hash of its particles. */
async function liveState(device: GPUDevice, live: SceneRuntime) {
    const particles = (live as unknown as { particles: { storageBuffer: GPUBuffer } }).particles.storageBuffer;
    return {
        frame: live.frame, simTime: live.simTime,
        params: live.uniformNames.map(n => `${n}=${live.getParam(n)}`).join(' '),
        particles: await bufferHash(device, particles, live.count * 32),
    };
}

/** A canvas for a Viewport, as the studio lays one out. */
function viewportCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;right:0;top:0;width:640px;height:360px';
    document.body.append(canvas);
    return canvas;
}

// ---------------------------------------------------------------------------------------------------
// FG2: the nine sizes
// ---------------------------------------------------------------------------------------------------

async function fg2(): Promise<Record<string, unknown>> {
    const device = await requestDevice();
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    const spec = specOf('kerr-black-hole');
    const still = firstView(spec.camera.keyframes);
    const runs = [
        ...FORMATS.flatMap(f => QUALITIES.map(q => ({ format: f.id, quality: q.id, fps: 60 as const }))),
        { format: 'wide' as const, quality: 'fhd' as const, fps: 30 as const },
    ];
    const videos: Record<string, unknown>[] = [];
    const reports: Record<string, unknown>[] = [];
    for (const r of runs) {
        const { width, height } = frameSize(r.format, r.quality);
        const seconds = 1;
        const path = cameraPath(spec.camera.keyframes, seconds) ?? (() => still);
        const id = `FG2-${r.format}-${Math.min(width, height)}p${r.fps}`;
        let result: FilmResult<FilmReport> | null = null;
        let error: unknown = null;
        try {
            result = await recordExport({ device, spec, live: null, settings: { width, height, fps: r.fps, seconds }, path, still, name: `${id}.mp4`, signal: new AbortController().signal });
        } catch (e) { error = e; }
        check(`${id}: films ${width}×${height} to OPFS`, result?.status === 'completed' && result.target === 'opfs' && result.codec === 'avc', describe(result, error));
        if (!result) continue;
        reports.push({ id, msPerFrame: result.report.timings.msPerFrame, achievedMbps: Math.round((result.report.achievedBitrate ?? 0) / 1e5) / 10, bytes: result.file?.size, fencing: result.report.guard.fencing });
        videos.push(await keep(id, result, { width, height, fps: r.fps, frames: r.fps * seconds }));
    }
    await device.queue.onSubmittedWorkDone();
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    return { videos, reports };
}

// ---------------------------------------------------------------------------------------------------
// FG3: the preview untouched
// ---------------------------------------------------------------------------------------------------

async function fg3(): Promise<Record<string, unknown>> {
    const canvas = viewportCanvas();
    const vp = await Viewport.create(canvas);
    adapters.push(vp.gpu);
    const { device } = vp.engine;
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    const spec = specOf('kerr-black-hole');
    const { runtime: live, smoke } = await SceneRuntime.build(vp.engine, spec, canvas.width, canvas.height);
    if (!live) throw new Error(smoke.error ?? 'the scene did not build');
    vp.setView(firstView(spec.camera.keyframes));
    vp.path = cameraPath(spec.camera.keyframes, 12);
    vp.mode = 'path';
    vp.playing = true;
    vp.setRuntime(live);
    const slider = live.uniformNames.find(n => n !== 'quality')!;
    live.setParam(slider, live.getParam(slider) * 1.5); // a slider the person moved
    vp.start();
    await sleep(1000);
    check('the preview runs before the export', live.frame > 10, { frame: live.frame });

    const resume = vp.pause();
    await device.queue.onSubmittedWorkDone();
    const before = { ...(await liveState(device, live)), canvas: `${canvas.width}×${canvas.height}` };
    const settings = { width: 640, height: 360, fps: 60 as const, seconds: 0.5 };
    const path = cameraPath(spec.camera.keyframes, settings.seconds)!;
    const still = vp.currentView();
    const outcomes: Record<string, string> = {};
    const film = async (label: string, extra: { signal?: AbortSignal; path?: (t: number) => CameraView; onProgress?: (p: FilmProgress) => void }) => {
        let result: FilmResult<FilmReport> | null = null;
        let error: unknown = null;
        try {
            result = await recordExport({ device, spec, live, settings, path: extra.path ?? path, still, name: `${label}.mp4`, signal: extra.signal ?? new AbortController().signal, onProgress: extra.onProgress });
        } catch (e) { error = e; }
        outcomes[label] = describe(result, error);
        await result?.dispose();
        const after = { ...(await liveState(device, live)), canvas: `${canvas.width}×${canvas.height}` };
        check(`${label} (${outcomes[label]}): the live runtime's clock, parameters and particles, and the canvas, are as they were`,
            JSON.stringify(after) === JSON.stringify(before), { before, after });
        return { result, error };
    };
    const done = await film('an export', {});
    check('the export completed, with the live slider in its scene', done.result?.status === 'completed', outcomes['an export']);
    const controller = new AbortController();
    const cancelled = await film('a cancel', { signal: controller.signal, onProgress: p => { if (p.phase === 'recording' && p.frame === 10) controller.abort(); } });
    check('the cancel ended in an AbortError', (cancelled.error as Error | null)?.name === 'AbortError', outcomes['a cancel']);
    // A failure mid-film: the camera path throws past 0.2 s (frame 13); a finalized partial is kept, then let go.
    const failed = await film('a failure', { path: t => { if (t > 0.2) throw new Error('the camera path failed (injected)'); return path(t); } });
    check('the failure kept a finalized partial (keep-if-finalizable)', failed.result?.status === 'partial', outcomes['a failure']);

    resume();
    const frame = live.frame;
    await sleep(800);
    check('the preview runs again once the films are done', live.frame > frame + 10, { before: frame, after: live.frame });
    vp.destroy();
    live.destroy();
    vp.engine.destroy();
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    return { outcomes, before };
}

// ---------------------------------------------------------------------------------------------------
// FG4: repeated teardown
// ---------------------------------------------------------------------------------------------------

async function fg4(): Promise<Record<string, unknown>> {
    const device = await requestDevice();
    const tracker = trackDevice(device);
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    const spec = specOf('kerr-black-hole');
    // The live scene, as the preview holds it; a headless engine stands in for the canvas.
    const liveEngine = new NullGraph();
    const init = await liveEngine.init(null, { device, width: 640, height: 360 });
    if (!init.success) throw new Error(init.error ?? 'the engine did not start');
    const { runtime: live, smoke } = await SceneRuntime.build(liveEngine, spec, 640, 360);
    if (!live) throw new Error(smoke.error ?? 'the scene did not build');
    await device.queue.onSubmittedWorkDone();
    const baseline = tracker.live();
    const still = firstView(spec.camera.keyframes);
    const settings = { width: 640, height: 360, fps: 60 as const, seconds: 0.5 };
    const path = cameraPath(spec.camera.keyframes, settings.seconds) ?? (() => still);
    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
        let result: FilmResult<FilmReport> | null = null;
        let error: unknown = null;
        try { result = await recordExport({ device, spec, live, settings, path, still, name: `teardown-${i}.mp4`, signal: new AbortController().signal }); } catch (e) { error = e; }
        statuses.push(describe(result, error));
        await result?.dispose();
    }
    check('ten exports in a row complete', statuses.every(s => s === 'completed'), statuses);
    await device.queue.onSubmittedWorkDone();
    const after = tracker.live();
    check('nothing is left on the device beyond the live scene', after.count === baseline.count, { before: baseline.count, after: after.count, alive: after.labels.filter(l => !baseline.labels.includes(l)).slice(0, 12) });
    // Three more films through the same adapter, their engines watched: none is kept alive.
    const engines: WeakRef<object>[] = [];
    for (let i = 0; i < 3; i++) {
        const create = filmWorkload(spec, live, { fps: 60, still });
        await recordFilm({ device, createWorkload: async ctx => { engines.push(new WeakRef(ctx.engine)); return create(ctx); }, camera: path, output: false, film: { ...settings } });
    }
    for (let i = 0; i < 3; i++) { await sleep(30); gc(); }
    const kept = engines.filter(r => r.deref() !== undefined).length;
    check('no film engine is kept alive after GC', kept === 0 && engines.length === 3, `${kept} of ${engines.length} engines still reachable`);
    live.destroy();
    liveEngine.destroy();
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    return { statuses, baseline: baseline.count };
}

// ---------------------------------------------------------------------------------------------------
// FG5: cancels, a destroyed device, a crashed GPU process
// ---------------------------------------------------------------------------------------------------

async function fg5(): Promise<Record<string, unknown>> {
    const device = await requestDevice();
    const spec = specOf('kerr-black-hole');
    const still = firstView(spec.camera.keyframes);
    const settings = { width: 640, height: 360, fps: 60 as const, seconds: 1 };
    const path = cameraPath(spec.camera.keyframes, settings.seconds) ?? (() => still);
    const cancels: Record<string, string> = {};
    // 'finalizing (reported)' cancels in the progress report itself, before the runner asks the session to finish:
    // that cancel wins. 'finalizing (under way)' cancels a task later, once finish() has begun: it joins the
    // finalize, and the film completes (the parent's §4.9: the first terminal request wins; F2's defect 3).
    for (const phase of ['building', 'calibrating', 'resetting', 'recording', 'finalizing (reported)', 'finalizing (under way)'] as const) {
        const controller = new AbortController();
        const onProgress = (p: FilmProgress) => {
            if (phase === 'finalizing (reported)' && p.phase === 'finalizing') controller.abort();
            else if (phase === 'finalizing (under way)' && p.phase === 'finalizing') setTimeout(() => controller.abort(), 0);
            else if (p.phase === phase && (phase !== 'recording' || p.frame === 10)) controller.abort();
        };
        if (phase === 'building') setTimeout(() => controller.abort(), 0);
        let result: FilmResult<FilmReport> | null = null;
        let error: unknown = null;
        try { result = await recordExport({ device, spec, live: null, settings, path, still, name: `cancel-${phase.replace(/\W+/g, '-')}.mp4`, signal: controller.signal, onProgress }); } catch (e) { error = e; }
        cancels[phase] = describe(result, error);
        if (phase === 'finalizing (under way)') check('a cancel once finalizing is under way joins it: the film completes', result?.status === 'completed' && controller.signal.aborted, cancels[phase]);
        else check(`a cancel while ${phase} ends in an AbortError`, (error as Error | null)?.name === 'AbortError', cancels[phase]);
        await result?.dispose();
        const left = await listFilms();
        check(`after the cancel while ${phase}, nothing is left in OPFS`, left.length === 0, left.map(f => `${f.exportId}:${f.status}`));
    }

    // A destroyed device at frame 30: keep-if-finalizable commits the frames made, and they decode.
    const doomed = await requestDevice();
    let lost: FilmResult<FilmReport> | null = null;
    let lostError: unknown = null;
    try {
        lost = await recordExport({ device: doomed, spec, live: null, settings: { ...settings, seconds: 2 }, path, still, name: 'lost.mp4', signal: new AbortController().signal, onProgress: p => { if (p.phase === 'recording' && p.frame === 30) doomed.destroy(); } });
    } catch (e) { lostError = e; }
    check('a destroyed device keeps a finalized partial, saying why', lost?.status === 'partial' && /GPU device lost at frame \d+ \(destroyed/.test(lost.report.failure ?? ''), describe(lost, lostError));
    const videos = lost ? [await keep('FG5-lost-partial', lost, { width: 640, height: 360, fps: 60, frames: lost.frames, partial: true })] : [];

    // A crashed GPU process mid-film, on the preview's own device: the film ends in the library's words, and the
    // viewport reports the loss (a destroyed device it would not: that is the app's own doing).
    const canvas = viewportCanvas();
    const vp = await Viewport.create(canvas);
    adapters.push(vp.gpu);
    let reported: string | null = null;
    vp.onDeviceLost = message => { reported = message; };
    const { runtime: live, smoke } = await SceneRuntime.build(vp.engine, spec, canvas.width, canvas.height);
    if (!live) throw new Error(smoke.error ?? 'the scene did not build');
    vp.setRuntime(live);
    vp.start();
    await sleep(300);
    const resume = vp.pause();
    let crashed: FilmResult<FilmReport> | null = null;
    let crashError: unknown = null;
    try {
        crashed = await recordExport({
            device: vp.engine.device, spec, live, settings: { ...settings, seconds: 20 }, path: cameraPath(spec.camera.keyframes, 20) ?? (() => still), still,
            name: 'crash.mp4', signal: new AbortController().signal, onProgress: p => { if (p.phase === 'recording' && p.frame === 30) log('action gpucrash'); },
        });
    } catch (e) { crashError = e; }
    resume();
    for (let i = 0; i < 50 && reported === null; i++) await sleep(100);
    const words = crashError ? (crashError as Error).message : crashed?.report.failure ?? '';
    check('a crashed GPU process ends the film in the library\'s words', /^film: GPU device lost at frame \d+ \(unknown/.test(words), describe(crashed, crashError));
    check('the viewport reports the lost device (the studio asks for a reload)', reported !== null, reported);
    await crashed?.dispose();
    return { cancels, lost: describe(lost, lostError), crash: describe(crashed, crashError), reported, videos };
}

// ---------------------------------------------------------------------------------------------------
// FG6: the photo is the live view
// ---------------------------------------------------------------------------------------------------

async function fg6(): Promise<Record<string, unknown>> {
    const device = await requestDevice();
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    const W = 1920, H = 1080;
    const shots: Record<string, unknown>[] = [];
    for (const a of ARCHETYPES) {
        const spec = specOf(a.id);
        // The live scene at the photo's size, so it can be drawn and read back as the reference.
        const engine = new NullGraph();
        const init = await engine.init(null, { device, width: W, height: H });
        if (!init.success) throw new Error(init.error ?? 'the engine did not start');
        const { runtime: live, smoke } = await SceneRuntime.build(engine, spec, W, H);
        if (!live) throw new Error(smoke.error ?? 'the scene did not build');
        const slider = live.uniformNames.find(n => n !== 'quality')!;
        live.setParam(slider, live.getParam(slider) * 1.25);
        for (let i = 0; i < 37; i++) live.step();
        const path = cameraPath(spec.camera.keyframes, 12) ?? (() => firstView(spec.camera.keyframes));
        const view = path(4.2);
        const before = await liveState(device, live);
        const shot = await snapshotLive(device, live, W, H, view);
        const after = await liveState(device, live);
        live.quality = 1;
        live.view(fitView(view, W / H), live.simTime);
        engine.render(live.draw());
        const readback = new FrameReadback(device, engine.screenTexture as GPUTexture, W, H);
        readback.grab(0);
        const { bytes } = await readback.take();
        readback.destroy();
        for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
        let differing = 0;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== shot.rgba[i]) differing++;
        check(`${a.id}: the photo equals the live runtime drawn at ${W}×${H}, byte for byte`, differing === 0 && shot.rgba.length === bytes.length, { differingBytes: differing });
        check(`${a.id}: taking the photo left the live runtime as it was`, JSON.stringify(before) === JSON.stringify(after), { before, after });
        shots.push({ id: a.id, translucentPixels: shot.translucent, pngBytes: shot.png.size });
        live.destroy();
        engine.destroy();
    }
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    return { shots };
}

// ---------------------------------------------------------------------------------------------------

const CASES: Record<string, () => Promise<Record<string, unknown>>> = {
    'FG1': fg1,
    'FG2': fg2,
    'FG3': fg3,
    'FG4': fg4,
    'FG5': fg5,
    'FG6': fg6,
};

/** What a case left in OPFS, then removed, so the next case starts clean. */
async function sweepFilms() {
    const left = await listFilms().catch(() => []);
    for (const film of left) await removeFilm(film.exportId).catch(() => {});
    return left.map(film => ({ exportId: film.exportId, status: film.status, name: film.name }));
}

const name = new URLSearchParams(location.search).get('case') ?? '';
const out = window as unknown as { __FILM_G__?: unknown };
try {
    const run = CASES[name];
    if (!run) throw new Error(`unknown case ${name}; cases: ${Object.keys(CASES).join(', ')}`);
    log(`${name}: ${navigator.userAgent}`);
    const result = await run();
    out.__FILM_G__ = { ok: true, case: name, checks, ...result, adapters, leftoverFilms: await sweepFilms(), browser: navigator.userAgent };
    log('done');
} catch (e) {
    out.__FILM_G__ = { ok: false, case: name, checks, error: String((e as Error)?.stack ?? e), adapters, leftoverFilms: await sweepFilms(), browser: navigator.userAgent };
    log(`failed: ${(e as Error)?.message ?? e}`, 'error');
}
