// The live viewport: one NullGraph engine on one canvas, a fixed-step simulation clock, orbit or
// keyframe-path camera, and a cost guard that keeps the preview interactive (design-spec §7). The
// guard reads the median frame interval and ignores the frames after a rebuild or a resize, which
// stall for reasons that have nothing to do with the scene's cost. It lowers the hook's `quality`
// first, then resolution. (onSubmittedWorkDone latency is no use here: in Chrome it includes
// waiting for the compositor, so a 5 ms frame can read as 90 ms.)
// It touches the DOM only for the canvas and its input, so the same loop can move into a worker.

import { NullGraph } from 'null-graph';
import { OrbitalCameraState, OrbitalEventProxy } from 'null-graph/cameras';
import { containView, type CameraView } from './camera-path';
import type { WorldRuntime } from './world';

export interface FrameStats {
    fps: number;
    /** Median interval of the last 30 frames. */
    frameMs: number;
    /** Internal resolution as a fraction of the canvas's CSS size × devicePixelRatio (≤ 1.5). */
    scale: number;
    quality: number;
    width: number;
    height: number;
}

export type CameraMode = 'orbit' | 'path';

export interface GpuInfo {
    vendor: string;
    architecture: string;
    description: string;
}

interface Rung { scale: number; quality: number }

/** Cheapest last. Scenes without a quality knob use only the rungs where resolution changes. */
const LADDER: Rung[] = [
    { scale: 1, quality: 1 },
    { scale: 1, quality: 0.7 },
    { scale: 1, quality: 0.4 },
    { scale: 0.85, quality: 0.4 },
    { scale: 0.7, quality: 0.4 },
    { scale: 0.6, quality: 0.4 },
    { scale: 0.5, quality: 0.4 },
];
/** A sustained median above this is below ~45 fps: step down. */
const OVER_BUDGET_MS = 22;
/** At or under a 60 Hz vsync: there may be headroom, so probe a rung up now and then. */
const AT_VSYNC_MS = 17.4;
/**
 * Live preview stays under ~2.3 MP however large the window: export is where 4K happens. An agent world is admitted and
 * probed for this envelope (EA5.3), so no live resize can grow it past what was checked.
 */
export const MAX_LIVE_PIXELS = 2_300_000;
const MAX_STEPS_PER_FRAME = 4;

export class Viewport {
    readonly canvas: HTMLCanvasElement;
    readonly engine: NullGraph;
    readonly gpu: GpuInfo;
    readonly orbit = new OrbitalCameraState({ target: [0, 0, 0], distance: 12, polarAngle: 1.25, minDistance: 1, maxDistance: 80 });
    fov = 45;
    /** The Head: whatever world runs on the stage, h1's or an agent's (WorldRuntime, EA5.0). */
    runtime: WorldRuntime | null = null;

    mode: CameraMode = 'orbit';
    path: ((seconds: number) => CameraView) | null = null;
    /** Film timeline, seconds. The simulation clock is separate and never rewinds in live mode. */
    playhead = 0;
    duration = 12;
    playing = false;
    simPaused = false;
    /** Pin a rung of the ladder (index), or null to let the guard choose. */
    pinnedRung: number | null = null;
    /**
     * While a frame guide is up: the export frame's aspect. The preview then frames that shape
     * exactly as the export will (containView); null shows the keyframed view as composed.
     */
    frameAspect: number | null = null;

    onFrame?: (stats: FrameStats) => void;
    /** Fired when a drag takes the camera off its keyframe path. */
    onOrbitTakeover?: () => void;
    onDeviceLost?: (message: string) => void;

    private readonly proxy: OrbitalEventProxy;
    private readonly resizeObserver: ResizeObserver;
    private raf = 0;
    private pauses = 0;
    private wantsFrames = false;
    private lastNow = 0;
    private accumulator = 0;
    private exporting = false;
    private sizeDirty = true;
    private ladder: Rung[] = LADDER;
    private rung = 0;
    /** No guard decisions before this time: a rebuild or a resize stalls the next few frames. */
    private settleUntil = 0;
    private lastRungChange = 0;
    private failedRung = -1;
    private failedUntil = 0;
    private intervals: number[] = [];
    /** Intervals since the guard last settled; decisions need a full window of them. */
    private window: number[] = [];
    /** The runtime the post targets were last sized for: a new runtime needs one resize. */
    private runtimeSize: WorldRuntime | null = null;
    private readonly stats: FrameStats = { fps: 0, frameMs: 0, scale: 1, quality: 1, width: 0, height: 0 };

    static async create(canvas: HTMLCanvasElement): Promise<Viewport> {
        if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * Math.min(devicePixelRatio, 1.5)));
        canvas.height = Math.max(1, Math.round(rect.height * Math.min(devicePixelRatio, 1.5)));
        const engine = new NullGraph();
        const result = await engine.init(canvas, { powerPreference: 'high-performance' });
        if (!result.success) throw new Error(result.error ?? 'WebGPU initialisation failed.');
        const info = engine.device.adapterInfo;
        return new Viewport(canvas, engine, {
            vendor: info?.vendor ?? '',
            architecture: info?.architecture ?? '',
            description: info?.description ?? '',
        });
    }

    private constructor(canvas: HTMLCanvasElement, engine: NullGraph, gpu: GpuInfo) {
        this.canvas = canvas;
        this.engine = engine;
        this.gpu = gpu;
        this.proxy = new OrbitalEventProxy({
            canvas,
            sensitivity: 0.0055,
            zoomSensitivity: 0.0012,
            onInput: (type, x, y) => {
                if (this.exporting) return;
                if (this.mode === 'path') {
                    // Start orbiting from where the path put the camera, not from a stale orbit.
                    this.setView(this.currentView());
                    this.mode = 'orbit';
                    this.onOrbitTakeover?.();
                }
                if (type === 'ROTATE') this.orbit.applyRotation(x, y);
                else this.orbit.applyZoom(y * this.orbit.distance);
            },
        });
        this.resizeObserver = new ResizeObserver(() => { this.sizeDirty = true; });
        this.resizeObserver.observe(canvas);
        engine.device.lost.then(info => {
            if (info.reason !== 'destroyed') this.onDeviceLost?.(info.message);
        });
    }

    get gpuLabel(): string {
        const { vendor, architecture, description } = this.gpu;
        if (description) return description;
        const v = vendor ? vendor[0].toUpperCase() + vendor.slice(1) : 'WebGPU';
        return architecture ? `${v} · ${architecture}` : v;
    }

    get frameStats(): FrameStats {
        return this.stats;
    }

    start(): void {
        this.wantsFrames = true;
        if (!this.pauses && !this.raf) this.raf = requestAnimationFrame(this.tick);
    }

    stop(): void {
        this.wantsFrames = false;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.lastNow = 0;
    }

    /**
     * Stop the frame loop until every pause is released: a film or a photo works on the same device meanwhile,
     * on its own engine and its own copy of the scene (film.ts), so the preview is left exactly as it was.
     * Returns the release; releasing twice does nothing.
     */
    pause(): () => void {
        if (this.pauses++ === 0) {
            // Suspend drawing without changing whether the owner wants the viewport running.
            cancelAnimationFrame(this.raf);
            this.raf = 0;
            this.lastNow = 0;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.pauses === 0 && this.wantsFrames) this.start();
        };
    }

    /** Held by a pause (a film, a photo, a probe's quiet window): a review's capture waits for its own turn (EA6). */
    get held(): boolean {
        return this.pauses > 0;
    }

    /**
     * Swap the running world: the switch EA5's commit() makes. Everything that can fail runs first, on the new world and
     * on locals: its quality floor, the ladder, the rung, its dial set. Only then do the assignments run, which cannot
     * fail, so a throw leaves the Head as it was (executor-design.md §9). The caller owns the old runtime's teardown.
     */
    setRuntime(runtime: WorldRuntime | null): void {
        const floor = runtime?.qualityFloor ?? null;
        const ladder = floor === null
            ? LADDER.filter((r, i) => i === 0 || r.scale !== LADDER[i - 1].scale).map(r => ({ ...r, quality: 1 }))
            : LADDER.map(r => ({ ...r, quality: Math.max(floor, r.quality) }));
        const rung = previewRung(ladder, this.pinnedRung);
        const step = ladder[Math.min(rung, ladder.length - 1)];
        if (runtime && floor !== null) runtime.quality = step.quality;
        // The switch: assignments only. The first frames after a build still wait on pipeline creation; judge after.
        this.runtime = runtime;
        this.accumulator = 0;
        this.ladder = ladder;
        this.rung = rung;
        this.failedRung = -1;
        this.stats.quality = floor !== null ? step.quality : 1;
        this.stats.scale = step.scale;
        this.settle(performance.now(), 2500);
    }

    /** Pin the preview to a rung of the cost ladder now, or hand it back to the guard (null). */
    pin(rung: number | null): void {
        this.pinnedRung = rung;
        this.rung = previewRung(this.ladder, rung);
        this.failedRung = -1;
        this.applyRung(performance.now(), 700);
    }

    setView(v: CameraView): void {
        this.orbit.target = [...v.target];
        this.orbit.distance = v.distance;
        this.orbit.azimuthAngle = v.azimuth;
        this.orbit.polarAngle = v.polar;
        this.fov = v.fov;
    }

    currentView(): CameraView {
        if (this.mode === 'path' && this.path) return this.path(this.playhead);
        return {
            target: [...this.orbit.target],
            distance: this.orbit.distance,
            azimuth: this.orbit.azimuthAngle,
            polar: this.orbit.polarAngle,
            fov: this.fov,
        };
    }

    /**
     * Hold the canvas at a fixed size and full quality until exitExport(): dev/smoke.ts measures the preview
     * this way. Films and photos never use it: they draw on engines of their own (film.ts, pause()).
     */
    enterExport(width: number, height: number): void {
        this.exporting = true;
        if (this.runtime) this.runtime.quality = 1;
        this.resizeTo(width, height);
    }

    exitExport(): void {
        this.exporting = false;
        this.lastNow = 0;
        this.applyRung(performance.now(), 1000);
    }

    destroy(): void {
        this.stop();
        this.proxy.destroy();
        this.resizeObserver.disconnect();
    }

    private tick = (now: number) => this.frame(now);

    /** One animation frame: the guard's sample, the size, the fixed-step clock, the camera, the draw. */
    private frame(now: number): void {
        this.raf = requestAnimationFrame(this.tick);
        if (this.exporting) return;
        const wall = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.25) : 1 / 60;
        this.lastNow = now;
        this.sample(wall * 1000, now);
        if (this.sizeDirty) this.applyLiveSize(now);

        const rt = this.runtime;
        if (!rt) return;
        const dt = rt.dt;
        if (!this.simPaused) {
            // Fixed-step clock: a 144 Hz display steps less than once per frame, a stall at most
            // MAX_STEPS_PER_FRAME times, so the simulation keeps real-time speed on any refresh rate.
            this.accumulator += wall;
            let steps = 0;
            while (this.accumulator >= dt && steps < MAX_STEPS_PER_FRAME) {
                rt.step();
                this.accumulator -= dt;
                steps++;
            }
            if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
        }
        if (this.playing) this.playhead = (this.playhead + wall) % this.duration;
        this.writeCamera();
        this.engine.render(rt.draw());
        this.onFrame?.(this.stats);
    }

    /**
     * The Head's camera, written as its next frame writes it. EA5.3's preparation calls it right after a candidate's
     * offscreen frame, in the same synchronous section: the engine's camera uniform, which every post pass binds, holds
     * the Head's view again before anything of the Head's runs.
     */
    writeCamera(): void {
        const rt = this.runtime;
        if (!rt) return;
        const view = this.currentView();
        rt.view(this.frameAspect ? containView(view, this.frameAspect, this.canvas.width / this.canvas.height) : view, rt.simTime);
    }

    private sample(ms: number, now: number): void {
        this.intervals.push(ms);
        if (this.intervals.length > 30) this.intervals.shift();
        this.stats.frameMs = median(this.intervals);
        this.stats.fps = this.stats.frameMs > 0 ? 1000 / this.stats.frameMs : 0;
        if (this.exporting || !this.runtime || now < this.settleUntil) return;
        this.window.push(ms);
        // Half a second of frames, but at least six: a 150 ms scene must not wait 30 frames.
        const spent = this.window.reduce((a, b) => a + b, 0);
        if (this.window.length < 30 && !(this.window.length >= 6 && spent >= 500)) return;

        const target = this.pinnedRung === null ? this.decideRung(median(this.window), now)
            : previewRung(this.ladder, this.pinnedRung);
        this.window.length = 0;
        if (target === this.rung) return;
        if (target > this.rung) {
            // Remember the rung that was too expensive, so the probe upward does not oscillate.
            this.failedRung = this.rung;
            this.failedUntil = now + 20_000;
        }
        this.rung = Math.min(Math.max(target, 0), this.ladder.length - 1);
        this.applyRung(now, 700);
    }

    private decideRung(frameMs: number, now: number): number {
        if (frameMs > OVER_BUDGET_MS && this.rung < this.ladder.length - 1) {
            // Far over budget: skip rungs instead of paying a settle window for each one.
            const jump = frameMs > OVER_BUDGET_MS * 3 ? 3 : frameMs > OVER_BUDGET_MS * 2 ? 2 : 1;
            return Math.min(this.rung + jump, this.ladder.length - 1);
        }
        const blocked = now < this.failedUntil && this.rung - 1 <= this.failedRung;
        if (frameMs < AT_VSYNC_MS && this.rung > 0 && now - this.lastRungChange > 3000 && !blocked) return this.rung - 1;
        return this.rung;
    }

    private applyRung(now: number, settleMs: number): void {
        const r = this.ladder[Math.min(this.rung, this.ladder.length - 1)];
        if (this.runtime && this.runtime.qualityFloor !== null) this.runtime.quality = r.quality;
        this.stats.quality = this.runtime && this.runtime.qualityFloor !== null ? r.quality : 1;
        this.stats.scale = r.scale;
        this.settle(now, settleMs);
    }

    /** A rung or a world just changed: no guard decision until it settles, and the size follows. Assignments only. */
    private settle(now: number, settleMs: number): void {
        this.lastRungChange = now;
        this.settleUntil = now + settleMs;
        this.window.length = 0;
        this.sizeDirty = true;
    }

    private applyLiveSize(now: number): void {
        this.sizeDirty = false;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio, 1.5);
        let w = rect.width * dpr * this.stats.scale;
        let h = rect.height * dpr * this.stats.scale;
        const pixels = w * h;
        if (pixels > MAX_LIVE_PIXELS) {
            const k = Math.sqrt(MAX_LIVE_PIXELS / pixels);
            w *= k;
            h *= k;
        }
        if (this.resizeTo(Math.max(2, Math.round(w)), Math.max(2, Math.round(h)))) {
            this.settleUntil = Math.max(this.settleUntil, now + 500);
            this.window.length = 0;
        }
    }

    /** Returns true when the size actually changed. */
    private resizeTo(width: number, height: number): boolean {
        // The engine's depth target and the post chain's targets must match the swapchain texture
        // before the next frame, or the main-screen pass fails validation.
        const changed = this.canvas.width !== width || this.canvas.height !== height
            || this.engine.width !== width || this.engine.height !== height;
        if (changed) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.engine.resize(width, height);
        }
        if (changed || this.runtimeSize !== this.runtime) {
            this.runtime?.resize(width, height);
            this.runtimeSize = this.runtime;
        }
        this.stats.width = width;
        this.stats.height = height;
        return changed;
    }
}

/** Presets use the full ladder; worlds without a quality knob collapse its duplicate scales. */
function previewRung(ladder: readonly Rung[], rung: number | null): number {
    if (rung === null) return 0;
    const index = Math.min(Math.max(rung, 0), LADDER.length - 1);
    if (ladder.length === LADDER.length) return index;
    return ladder.findIndex(r => r.scale === LADDER[index].scale);
}

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
}
