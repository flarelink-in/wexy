// The fraction probe and the sanity look (EA5.3; executor-design.md §9, steps 1, 2 and 4). Nothing generated runs at
// full size until the probe has predicted every submission of the world under h1's 250 ms cap (I3; Q90).
//
// The variants (step 1). A host projection of C, never C itself: W's work counts divided by 8 and by 4 (a storage
// buffer's elements, a stage's invocations, a batch's instances; each rounded up, at least 1), resolved again under the
// same P, H and manifest, checked, and its interfaces derived, so each variant's counts, buffer extents, invocation
// guards, dependencies and pairs agree with each other by construction. The bodies are the sealed ones, byte for byte;
// only host constants may differ (EA_INVOCATIONS), and each that does is recorded. A node whose work this table cannot
// scale, an X that resolves under another identity, or an interface that changes beyond its counts stops the probe:
// such work is never tried at full size (EA_PROBE_UNVERIFIED). Each variant is built by the executor's own allowlist on
// a headless engine of its own (buildVariant), so its resources are its own, and is released whatever happens.
//
// The measurement (step 2), in the order that refuses soonest: init, then a fixed step, then a frame at two sizes. Every
// submission (a first run, a warm-up, a timed batch, a resize) runs inside an error checkpoint and is then fenced; one
// that raises a validation or memory error voids its timing and the probe (the EA5.3 review, H1). After every await the
// probe checks it is still wanted (a cancel, a newer turn, another device generation) and stops submitting if not (M1).
// Each phase's first operation is timed alone and fenced; if that single 1/8 operation is near the cap, nothing repeats it.
// Only then the bounded untimed warm-up and the timed runs. Init and a step are pure work, scaled from the two fractions
// by a two-point fit floored by direct scaling (eight times the 1/8, four times the 1/4); a frame is part work, part
// pixels (the post chain, a fullscreen pass), so it is fitted in both, as h1's probe does: direct work scaling would
// multiply the pixel-bound part by four to eight and refuse slow but safe worlds (Q90). Every prediction carries the
// 1.25 margin. Timings within the timer's floor band (both at most 1 ms, the browser's 0.1 ms grain) are bounded by
// floor scaling rather than judged noisy; above it, a pair that is non-finite, negative or falls as the work grows is
// inconclusive, measured again within the variants, and refused if it stays so. A phase with no GPU operation in X costs
// 0 ms, with nothing extrapolated. On the stage the queue is shared, so the Head's work lands in every timing: the report
// says so, and nothing guessed is subtracted.
//
// The sanity look (step 4): typed f32 state sampled for finiteness, and the offscreen first frame's RGBA8 pixels judged
// only by what a host profile declares for that world (an RGBA8 frame proves nothing about float state, and a dark world
// may be right); a world with no profile has its visibility reported untested, never passed. EA6 owns visual judgment.

import { checkGraph } from '../contract/adapters/checks';
import { POLICY_V1, type ExecutionGraph } from '../contract/adapters/graph';
import { deriveInterfaces, type ModuleInterface } from '../contract/adapters/interfaces';
import { resolveProgram } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { SealedCandidate } from '../loop/snapshot';
import type { CameraView } from '../runtime/camera-path';
import { buildVariant, type BuildSource, type Variant } from './engine-executor';
import type { EnginePort } from './engine-port';
import { PROBE_FRAME, SAMPLE_INSTANCES, type Target } from './gate';
import type { AgentRuntime } from './world-runtime';

type Graph = DeepReadonly<ExecutionGraph>;
type Snapshot = DeepReadonly<SealedCandidate>;
type Iface = DeepReadonly<ModuleInterface>;

export const WORLD_PROBE = {
    /** The variants: the full counts divided by each. */
    fractions: [8, 4] as const,
    /** The probe's two frames: the per-pixel cost is their difference. */
    // 640×360 and 1280×720 (EA-G1, 11-01): the 2.3 MP envelope is about three times the larger frame's pixels, where 320×180
    // and 640×360 made it thirteen, and one noisy timing thirteen times a frame's prediction.
    small: { width: 640, height: 360 },
    large: PROBE_FRAME,
    /** Untimed runs after a phase's first, before the timed ones. */
    warm: 2,
    /** Timed runs in a batch: init's each fenced, a step's together. */
    runs: 6,
    /**
     * Frames in a batch, fenced once (EA-G1, 11-01): each frame's share of the fence's latency, about 3 ms on the AMD iGPU,
     * is a twenty-fourth, so smaller differences of work show.
     */
    frameRuns: 24,
    /** Batches of a step or a frame, and of init's runs the median, so a spike in one moves nothing (EA-G1, 11-01). */
    batches: 3,
    /** Trivial checked submissions (a 4-byte clear) whose median fence latency sets the device's floor band. */
    latencyRuns: 5,
    /** Measurements again of an inconclusive phase, within the variants. */
    retries: 2,
    /** The browser's timer grain without cross-origin isolation, and the band within which jitter is not noise. */
    timerGrainMs: 0.1,
    timerFloorMs: 1.0,
    margin: 1.25,
    /** The one time-based refusal (Q90): no predicted submission over this. */
    maxSubmissionMs: 250,
    /** The steady frame's target and its "below 10 fps" line: warnings, never refusals (Q90). */
    steadyTargetMs: 33,
    steadySlowMs: 100,
    /** Fixed steps a frame at most when the clock catches up (the viewport's): each its own submission. */
    catchUpSteps: 4,
    profile: 'ea5-probe.v1',
} as const;

// ------------------------------------------------------------------ the projection

/** The config fields that hold a node's work, divided in a variant. */
const SCALED: Readonly<Record<string, readonly string[]>> = {
    'ng.buffer.storage': ['elements'],
    'ng.compute.stage': ['invocations'],
    'ng.render.mesh_batch': ['maxInstances'],
};
/** The adapters a variant keeps as they are: no count of their own (the frame's size is the probe's). */
const KEPT: ReadonlySet<string> = new Set(['ng.geometry.primitive', 'ng.material.stock', 'ng.light.rig', 'ng.render.fullscreen', 'ng.post.chain']);
/** X's identity fields a variant must share with C: only its program (and so its hash) may differ. */
const SAME_IDENTITY = ['graph', 'resolver', 'engine', 'bundleHash', 'supportStatusHash', 'manifest', 'manifestHash', 'gatesHash', 'policyHash'] as const;

export interface Projection {
    fraction: number;
    source: BuildSource;
    /** The host constants that differ from C's, e.g. `galaxySpin.EA_INVOCATIONS 12000 → 1500`. */
    changed: string[];
}

const unverified = (what: string) => `EA_PROBE_UNVERIFIED ${what}; no full-size work submitted`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A refusal from deep in the measurement, carried to the probe's outcome with its words. */
class Refusal extends Error {}

/** Why variant interface `v` differs from C's `c` beyond its counts; null when only EA_INVOCATIONS moved. */
function beyondCounts(c: Iface, v: Iface, changed: string[]): string | null {
    for (const k of ['kind', 'abi', 'entries', 'bindings', 'workgroupSize', 'chunks', 'epilogue'] as const) if (!same(c[k], v[k])) return k;
    if (c.constants.length !== v.constants.length) return 'constants';
    for (let i = 0; i < c.constants.length; i++) {
        const [a, b] = [c.constants[i], v.constants[i]];
        if (a.name !== b.name) return 'constants';
        if (a.value === b.value) continue;
        if (a.name !== 'EA_INVOCATIONS') return `constant ${a.name}`;
        changed.push(`${c.module}.${a.name} ${a.value} → ${b.value}`);
    }
    return null;
}

/** C's program at 1/`fraction` of its work: resolved, checked, its interfaces derived and held to C's. */
export async function project(snapshot: Snapshot, fraction: number): Promise<Projection | string> {
    const nodes = snapshot.program;
    if (!Array.isArray(nodes)) return unverified('this candidate holds no program to project');
    const scaled: unknown[] = [];
    for (const n of nodes as readonly { id: string; adapterId: string; config: string }[]) {
        const fields = SCALED[n.adapterId];
        if (!fields) {
            if (!KEPT.has(n.adapterId)) return unverified(`${n.adapterId} (node ${n.id}): its work has no projection here`);
            scaled.push(structuredClone(n));
            continue;
        }
        let config: Record<string, unknown>;
        try {
            config = JSON.parse(n.config) as Record<string, unknown>;
        } catch {
            return unverified(`node ${n.id}'s config does not parse`);
        }
        for (const f of fields) {
            const v = config[f];
            if (!Number.isSafeInteger(v) || (v as number) < 1) return unverified(`node ${n.id}'s ${f} is not a count`);
            config[f] = Math.max(1, Math.ceil((v as number) / fraction));
        }
        scaled.push({ ...structuredClone(n), config: JSON.stringify(config) });
    }
    const resolved = await resolveProgram(scaled);
    if (!resolved.ok) return unverified(`the 1/${fraction} projection does not resolve (${resolved.diagnostics[0]?.code ?? 'no diagnostic'} ${resolved.diagnostics[0]?.path ?? ''})`);
    const x = resolved.graph;
    for (const k of SAME_IDENTITY) {
        if (x.identity[k] !== snapshot.x.identity[k]) return unverified(`the 1/${fraction} projection resolves under another ${k} than C's`);
    }
    if (!(await checkGraph(x, POLICY_V1)).ok) return unverified(`the 1/${fraction} projection does not pass X's checks`);
    const derived = await deriveInterfaces(x);
    if (!derived.ok) return unverified(`the 1/${fraction} projection's interfaces cannot be derived`);
    if (derived.interfaces.length !== snapshot.interfaces.length) return unverified(`the 1/${fraction} projection has another module set`);
    const changed: string[] = [];
    for (const c of snapshot.interfaces) {
        const v = derived.interfaces.find(i => i.module === c.module);
        if (!v) return unverified(`the 1/${fraction} projection has no module ${c.module}`);
        const why = beyondCounts(c, v, changed);
        if (why) return unverified(`the 1/${fraction} projection changes module ${c.module}'s ${why}, beyond its counts`);
    }
    return { fraction, source: { x, interfaces: derived.interfaces, bodies: snapshot.bodies }, changed };
}

// ------------------------------------------------------------------ the predictions

export type Prediction = { ms: number; rule: 'fit' | 'floor' } | { inconclusive: string };

const finiteNonNegative = (...vs: number[]) => vs.every(v => Number.isFinite(v) && v >= 0);

/** The middle of a set of timings: a spike in one run moves it not at all (EA-G1, 11-01). */
export function median(values: readonly number[]): number {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A pure-work phase (init, a fixed step) at full size from its 1/8 and 1/4 timings: within the floor band, floor scaling;
 * above it, the two-point fit floored by direct scaling, with the margin; non-finite, negative, or falling as the work
 * doubles, inconclusive (EA-X15). The band is the device's own (`floorMs`): at least the timer's, and twice an empty
 * submission's fence latency where that is more (EA-G1 found 2.7 ms on the AMD iGPU, where tiny work timed as latency).
 */
export function predictPair(m8: number, m4: number, floorMs: number = WORLD_PROBE.timerFloorMs): Prediction {
    const { timerGrainMs, margin } = WORLD_PROBE;
    if (!finiteNonNegative(m8, m4)) return { inconclusive: `timings ${m8} and ${m4} ms are not finite and non-negative` };
    if (m8 <= floorMs && m4 <= floorMs) return { ms: Math.max(m8 * 8, m4 * 4, timerGrainMs * 8) * margin, rule: 'floor' };
    if (m4 < m8) return { inconclusive: `1/4 measured ${m4.toFixed(3)} ms, below 1/8's ${m8.toFixed(3)} ms, above the floor of ${floorMs.toFixed(3)} ms` };
    const slope = (m4 - m8) / (1 / 4 - 1 / 8);
    const fixed = Math.max(0, m8 - slope / 8);
    return { ms: Math.max(fixed + slope, m8 * 8, m4 * 4) * margin, rule: 'fit' };
}

export interface FrameTimings {
    small: number;
    large: number;
    /** The first frame at the larger frame, timed alone right after its targets were made again: their first touch. */
    touched?: number;
    /** The same at the smaller frame, after the larger: what of a first touch grows with pixels is the rise between them. */
    touchedSmall?: number;
}

/**
 * A frame at full work and `pixels`, from the 1/8 (a) and 1/4 (b) variants at the small and large frames: fitted in
 * work and in pixels with slopes and the fixed part never below zero, as h1's probe does; never below the largest frame
 * measured, nor a timer grain's worth; with the margin. Above the floor, a timing that falls as the work or the pixels
 * grow is inconclusive. A frame is timed in batches, so its share of the fence's latency, and its band, is `floorMs`
 * divided by the batch's frames.
 */
export function predictFrame(a: FrameTimings, b: FrameTimings, pixels: number, floorMs: number = WORLD_PROBE.timerFloorMs): Prediction {
    const { timerFloorMs, timerGrainMs, margin, small, large, frameRuns } = WORLD_PROBE;
    const all = [a.small, a.large, b.small, b.large];
    if (!finiteNonNegative(...all)) return { inconclusive: `frame timings ${all.join(', ')} ms are not finite and non-negative` };
    // A frame's share of the device's floor: what a batch's fence adds to each of its frames, and what may hide in one.
    const share = floorMs / frameRuns;
    const band = Math.max(timerFloorMs, share);
    if (all.some(v => v > band)) {
        const tolerance = (v: number) => 2 * timerGrainMs + share / 2 + 0.1 * v;
        if (b.small < a.small - tolerance(a.small) || b.large < a.large - tolerance(a.large)) {
            return { inconclusive: 'a frame measured cheaper with twice the work, above the floor' };
        }
        if (a.large < a.small - tolerance(a.small)) return { inconclusive: 'a frame measured cheaper at four times the pixels, above the floor' };
    }
    const S = small.width * small.height;
    const L = large.width * large.height;
    const slope = (ya: number, yb: number, xa: number, xb: number) => Math.max(0, (yb - ya) / (xb - xa));
    const perWorkSmall = slope(a.small, b.small, 1 / 8, 1 / 4);
    const perWorkLarge = slope(a.large, b.large, 1 / 8, 1 / 4);
    // The work's cost grows with the pixels too (an instance covers more of them): extrapolated to the target, never
    // below the small frame's.
    const perWork = Math.max(perWorkSmall, perWorkSmall + (perWorkLarge - perWorkSmall) * (pixels - S) / (L - S));
    const perPixel = slope(a.small, a.large, S, L);
    const fixed = Math.max(0, a.small - perWorkSmall / 8 - perPixel * S);
    const fit = fixed + perWork + perPixel * pixels;
    // Direct pixel scaling as a floor (EA-G1, 11-01): the full-work frame fitted at the larger frame, in proportion to the
    // target's pixels. On the GTX 1650 a frame's cost per pixel grew faster from 0.92 to 2.36 MP than from 0.23 to 0.92,
    // and the fit alone fell up to 17% short of the frames that ran; a frame's cost per pixel on average, its fixed part
    // included, never grew with its size in any run, so this floor held in all of them.
    // A difference of work smaller than the noise cannot be seen, so the worst within it is assumed: each step of work
    // between the variants may hide a frame's share of the floor (EA-G1: foggy-dusk's 1/4 timed under its 1/8, and its
    // full frame ran 3.7 times the full-work frame the fit saw at 1280×720).
    const fullAtLarge = a.large + 7 * (Math.max(0, b.large - a.large) + share);
    const linear = fullAtLarge * Math.max(1, pixels / L);
    return { ms: Math.max(fit, linear, ...all, timerGrainMs * 8) * margin, rule: all.every(v => v <= band) ? 'floor' : 'fit' };
}

/**
 * The first full-size frame, which runs cold (the EA5.4 review): the steady frame's prediction, plus what a first frame
 * adds, with the margin.
 * - Each pipeline's first use: at most the coldest variant's first frame less its steady frame, at the smaller frame. The
 *   variant's pipelines are as cold as the full world's: none had drawn before its first frame.
 * - The first touch of the target's render targets: each variant's frame right after its targets were made again, less
 *   its steady frame, at each frame. What grows with pixels (a target's first clear) is the rise from the smaller frame
 *   to the larger, carried on to the target's pixels at that rate; the rest is fixed. EA-G1, 11-01: a remade target cost
 *   the AMD iGPU 12–36 ms at 1280×720, while a full-size first frame paid 9–15 ms over its steady frame, so scaling the
 *   whole touch by pixels predicted first frames up to seven times what ran, and refused galaxy in the studio (EA-E).
 *
 * Each term carries a fence's latency, and a remade target costs more than one made once, so the sum over-predicts.
 */
export function predictFirstFrame(frameMs: number, first: readonly number[], a: FrameTimings, b: FrameTimings, pixels: number): number {
    const { margin, small, large } = WORLD_PROBE;
    const S = small.width * small.height;
    const L = large.width * large.height;
    const cold = Math.max(0, (first[0] ?? 0) - a.small, (first[1] ?? 0) - b.small);
    const atLarge = Math.max(0, (a.touched ?? a.large) - a.large, (b.touched ?? b.large) - b.large);
    const atSmall = Math.max(0, (a.touchedSmall ?? a.small) - a.small, (b.touchedSmall ?? b.small) - b.small);
    const perPixel = (atLarge - atSmall) / (L - S);
    const touch = Math.max(atSmall, atLarge + perPixel * Math.max(0, pixels - L));
    return frameMs + (cold + touch) * margin;
}

// ------------------------------------------------------------------ the measurement

/** A headless engine's port over the shared device, at a size it can change; destroyed by whoever made it. */
export interface HeadlessPort {
    port: EnginePort;
    resize(width: number, height: number): void;
    destroy(): void;
}

export interface ProbeDeps {
    /** A headless engine adopting the device, at `width`×`height`. */
    headless(width: number, height: number): Promise<HeadlessPort>;
    now(): number;
    /** The view the frames are drawn from: the stage's. */
    view(): CameraView;
    signal: AbortSignal;
    /** The full world's pixels: the admitted envelope's. */
    target: Target;
    /** The queue is the stage's: without a quiet window, the Head's work lands in the timings (said, never subtracted). */
    shared: boolean;
    /**
     * A quiet window (EA-E, 11-01): the Head draws nothing until the returned release is called (the viewport's pause).
     * Each timing runs in one, so it measures this work alone, as EA-G1 calibrated it. Absent where nothing else draws.
     */
    quiet?: () => () => void;
    /**
     * Why the construction is stale (a newer turn, another device generation), or null: checked after every await, so a
     * superseded candidate submits nothing more (the coordinator, executor.ts, sees the same and stops).
     */
    stale?: () => string | null;
}

/** One phase's numbers: the first runs alone, the measured means, the prediction and its rule. */
export interface PhaseProbe {
    first: number[];
    measured: number[];
    /** A frame's only: each variant's first frame after its targets were made again, at the smaller frame and the larger. */
    touched?: number[];
    ms: number;
    rule: 'fit' | 'floor' | 'empty';
}

/** The probe's numbers, as h1's ProbeNumbers, for an agent world (§5's WorldProbe). */
export interface WorldProbe {
    /** One fixed step's compute at full work, predicted. */
    computeMsPerFrame: number;
    /** A frame at full work and the target's pixels: its compute, its draws and its post chain. */
    drawMsPerFrame: number;
    initMs: number;
    /** The worst predicted submission: what the cap judges. */
    maxSubmissionMs: number;
    /** The first full-size frame, cold: its pipelines' first use and its targets' first touch on top of a frame. */
    firstFrameMs: number;
    /** One fixed step and the draw: the target's 33 ms, warned over, never refused. */
    steadyFrameMs: number;
    /** A frame after the clock catches up its four steps, each its own submission: reported only. */
    catchUpMs: number;
    /** The gate's reservation for this candidate (I7); set by the preparation. */
    peakBytes: number;
    viewport: Target;
    profile: string;
    budgetMs: number;
    phases: { init: PhaseProbe; step: PhaseProbe; frame: PhaseProbe };
    projection: { fraction: number; changed: string[] }[];
    warnings: string[];
    /** The Head's work shared the queue while it measured. */
    contaminated: boolean;
    /** The device's floor band it judged by: the timer's, or twice an empty submission's fence latency (EA-G1). */
    floorMs: number;
}

export type ProbeOutcome = { ok: true; probe: WorldProbe } | { ok: false; reason: string; probe: Partial<WorldProbe> };

interface Built {
    fraction: number;
    variant: Variant;
    headless: HeadlessPort;
}

/** Whether X's phase holds GPU work: a dispatch, a copy, a swap (uploads are host writes). */
const hasGpuWork = (x: Graph, phase: 'fixedStep') => x.schedule[phase].some(id => {
    const op = x.operations.find(o => o.id === id);
    return op !== undefined && (op.kind === 'compute' || op.kind === 'copy' || op.kind === 'swap');
});

/**
 * Probes C before any of its full-size work: its variants built and measured, every submission predicted at the target,
 * and every variant released whatever happens. Over the cap, or inconclusive, it refuses with the numbers.
 */
export async function probeCandidate(snapshot: Snapshot, deps: ProbeDeps): Promise<ProbeOutcome> {
    const { margin, maxSubmissionMs, warm, runs, retries, small, large } = WORLD_PROBE;
    const pixels = deps.target.width * deps.target.height;
    const contaminated = deps.shared && !deps.quiet;
    const partial: Partial<WorldProbe> = { viewport: { ...deps.target }, profile: WORLD_PROBE.profile, budgetMs: maxSubmissionMs, contaminated };
    const refuse = (reason: string): ProbeOutcome => ({ ok: false, reason, probe: partial });
    /** Neither cancelled nor stale (another turn, another device generation): checked after every await (the EA5.3 review, M1). */
    const fresh = () => {
        deps.signal.throwIfAborted();
        const why = deps.stale?.() ?? null;
        if (why !== null) throw new Error(`EA_STOP ${why}: the probe submits nothing more`);
    };
    const built: Built[] = [];
    try {
        const projections: Projection[] = [];
        for (const f of WORLD_PROBE.fractions) {
            const p = await project(snapshot, f);
            fresh();
            if (typeof p === 'string') return refuse(p);
            projections.push(p);
        }
        partial.projection = projections.map(p => ({ fraction: p.fraction, changed: p.changed }));
        for (const p of projections) {
            const headless = await deps.headless(small.width, small.height);
            try {
                fresh();
                // A probe whose submissions cannot be checked for errors, or fenced, proves nothing (the EA5.3 review, H1).
                if (!headless.port.checkpoint || !headless.port.settle) throw new Refusal(unverified('this engine cannot check the probe\'s submissions for errors, or fence them'));
                const variant = await buildVariant(p.source, headless.port, deps.signal);
                built.push({ fraction: p.fraction, variant, headless });
                fresh();
            } catch (e) {
                if (!built.some(b => b.headless === headless)) headless.destroy();
                fresh();
                if (e instanceof Refusal) return refuse(e.message);
                return refuse(unverified(`the 1/${p.fraction} variant did not build: ${(e as Error).message}`));
            }
        }
        const [A, B] = built;
        /**
         * One submission, or a batch, of a variant: inside an error checkpoint (pushed and popped around the work alone),
         * then fenced, and its time from the work to the fence. A validation or memory error voids the timing: it never
         * approves anything (the EA5.3 review, H1).
         */
        const checked = async (b: Built, what: string, work: () => void): Promise<number> => {
            // In a quiet window (EA-E, 11-01). In the studio the Head draws on the same queue, and a timing that waits
            // behind its frames measures them (§9 never subtracts them): with h1's galaxy on the AMD iGPU, every number
            // came out five to seven times EA-G1's. So the Head holds, its frames already queued finish, and the clock
            // starts in the same synchronous section as the work. The Head draws between timings, and through every
            // compile (P8).
            const release = deps.quiet?.() ?? null;
            try {
                await b.headless.port.settle!();
                fresh();
                const t0 = deps.now();
                const error = b.headless.port.checkpoint!(work);
                await b.headless.port.settle!();
                const ms = deps.now() - t0;
                const e = await error;
                fresh();
                if (e !== null) throw new Refusal(unverified(`${what} on the 1/${b.fraction} variant raised an error: ${e}`));
                return ms;
            } finally {
                release?.();
            }
        };
        /** A first run alone: refused, unrepeated, when this variant alone is predicted near the cap. */
        const firstRun = async (b: Built, work: () => void, what: string): Promise<number | string> => {
            const ms = await checked(b, what, work);
            const scale = b.fraction === 8 ? 1 : 2;
            if (ms * scale * margin > maxSubmissionMs) return `EA_PROBE ${what}: its 1/${b.fraction} variant alone took ${ms.toFixed(1)} ms, near the ${maxSubmissionMs} ms cap; nothing repeated it`;
            return ms;
        };
        // The device's floor (EA-G1, 11-01): the fence latency of a real but trivial submission (a 4-byte clear on the
        // probe's own engine), the median of a few. An empty submission is answered at once and says nothing of a
        // submission's round trip, which EA-G1 found to be 2.6 ms on the AMD iGPU however little it holds. Work that times
        // within twice it is noise on this device, bounded by floor scaling and never judged by its jitter.
        const latencies: number[] = [];
        const tiny = A.headless.port.createBuffer('wexy/probe floor', 4, ['copy_dst']);
        try {
            for (let i = 0; i < WORLD_PROBE.latencyRuns; i++) latencies.push(await checked(A, 'the fence', () => A.headless.port.clearBuffer(tiny)));
        } finally {
            A.headless.port.destroyBuffer(tiny);
        }
        const floorMs = Math.max(WORLD_PROBE.timerFloorMs, 2 * median(latencies));
        partial.floorMs = floorMs;
        const judged = (what: string, p: Prediction): { ms: number; rule: 'fit' | 'floor' } | string => {
            if ('inconclusive' in p) return unverified(`${what}: ${p.inconclusive}`);
            if (p.ms > maxSubmissionMs) return `EA_PROBE ${what}: ${p.ms.toFixed(1)} ms predicted, over the ${maxSubmissionMs} ms cap`;
            return p;
        };

        // Init: once each alone, then rewound and run again, timed.
        const initFirst: number[] = [];
        for (const b of built) {
            const t = await firstRun(b, () => b.variant.world.runInit(), 'init');
            if (typeof t === 'string') return refuse(t);
            initFirst.push(t);
        }
        const initMedian = async (b: Built) => {
            for (let i = 0; i < warm; i++) {
                await checked(b, 'init', () => {
                    b.variant.world.runtime.rewind();
                    b.variant.world.runInit();
                });
            }
            const times: number[] = [];
            for (let i = 0; i < runs; i++) {
                await checked(b, 'init', () => b.variant.world.runtime.rewind());
                times.push(await checked(b, 'init', () => b.variant.world.runInit()));
            }
            return median(times);
        };
        let initMeasured: number[] = [];
        let init: Prediction = { inconclusive: 'not measured' };
        for (let attempt = 0; attempt <= retries; attempt++) {
            initMeasured = [await initMedian(A), await initMedian(B)];
            init = predictPair(initMeasured[0], initMeasured[1], floorMs);
            if (!('inconclusive' in init)) break;
        }
        const initJudged = judged('init', init);
        partial.phases = { init: { first: initFirst, measured: initMeasured, ms: 'ms' in init ? init.ms : NaN, rule: 'rule' in init ? init.rule : 'fit' } } as WorldProbe['phases'];
        if (typeof initJudged === 'string') return refuse(initJudged);
        partial.initMs = initJudged.ms;

        // A fixed step: 0 ms when X's fixedStep holds no GPU work.
        let step: PhaseProbe;
        if (!hasGpuWork(snapshot.x, 'fixedStep')) {
            step = { first: [], measured: [], ms: 0, rule: 'empty' };
        } else {
            const stepFirst: number[] = [];
            for (const b of built) {
                const t = await firstRun(b, () => b.variant.world.runtime.step(), 'one fixed step');
                if (typeof t === 'string') return refuse(t);
                stepFirst.push(t);
            }
            const stepMedian = async (b: Built) => {
                await checked(b, 'one fixed step', () => { for (let i = 0; i < warm; i++) b.variant.world.runtime.step(); });
                const batches: number[] = [];
                for (let j = 0; j < WORLD_PROBE.batches; j++) {
                    batches.push((await checked(b, 'one fixed step', () => { for (let i = 0; i < runs; i++) b.variant.world.runtime.step(); })) / runs);
                }
                return median(batches);
            };
            let stepMeasured: number[] = [];
            let p: Prediction = { inconclusive: 'not measured' };
            for (let attempt = 0; attempt <= retries; attempt++) {
                stepMeasured = [await stepMedian(A), await stepMedian(B)];
                p = predictPair(stepMeasured[0], stepMeasured[1], floorMs);
                if (!('inconclusive' in p)) break;
            }
            const j = judged('one fixed step', p);
            step = { first: stepFirst, measured: stepMeasured, ms: 'ms' in p ? p.ms : NaN, rule: 'rule' in p ? p.rule : 'fit' };
            partial.phases.step = step;
            if (typeof j === 'string') return refuse(j);
        }
        partial.phases.step = step;
        partial.computeMsPerFrame = step.ms;

        // A frame, at the small and the large frame, from the stage's view at time zero.
        const view = deps.view();
        const size = (b: Built, s: Target) => {
            b.headless.resize(s.width, s.height);
            b.variant.world.runtime.resize(s.width, s.height);
        };
        const frame = (b: Built) => {
            b.variant.world.runtime.view(view, 0);
            b.headless.port.render(b.variant.world.runtime.draw());
        };
        const frameFirst: number[] = [];
        for (const b of built) {
            const t = await firstRun(b, () => frame(b), 'one frame');
            if (typeof t === 'string') return refuse(t);
            frameFirst.push(t);
        }
        const frameMedian = async (b: Built): Promise<FrameTimings> => {
            const frames = (n: number) => () => { for (let i = 0; i < n; i++) frame(b); };
            const batched = async () => {
                const batches: number[] = [];
                for (let j = 0; j < WORLD_PROBE.batches; j++) batches.push((await checked(b, 'one frame', frames(WORLD_PROBE.frameRuns))) / WORLD_PROBE.frameRuns);
                return median(batches);
            };
            await checked(b, 'one frame', frames(warm));
            // The first frame at the larger frame right after its targets are made again: their first touch, with warm
            // pipelines, timed alone (the cold first frame's model, predictFirstFrame).
            const touched = await checked(b, 'one frame', () => { size(b, large); frame(b); });
            // The first run at the larger frame (the EA5.4 review's over-budget run). Each frame there is a submission of
            // its own, so one near the cap on its own is never repeated: no warm-up and no batch at that frame.
            if (touched * margin > maxSubmissionMs) {
                throw new Refusal(`EA_PROBE one frame: its 1/${b.fraction} variant alone took ${touched.toFixed(1)} ms at ${large.width}×${large.height}, near the ${maxSubmissionMs} ms cap; nothing repeated it`);
            }
            await checked(b, 'one frame', frames(warm));
            const largeMs = await batched();
            const touchedSmall = await checked(b, 'one frame', () => { size(b, small); frame(b); });
            return { small: await batched(), large: largeMs, touched, touchedSmall };
        };
        let frames: FrameTimings[] = [];
        let fp: Prediction = { inconclusive: 'not measured' };
        for (let attempt = 0; attempt <= retries; attempt++) {
            frames = [await frameMedian(A), await frameMedian(B)];
            fp = predictFrame(frames[0], frames[1], pixels, floorMs);
            if (!('inconclusive' in fp)) break;
        }
        const fj = judged('one frame', fp);
        partial.phases.frame = {
            first: frameFirst, measured: frames.flatMap(f => [f.small, f.large]), touched: frames.flatMap(f => [f.touchedSmall ?? NaN, f.touched ?? NaN]),
            ms: 'ms' in fp ? fp.ms : NaN, rule: 'rule' in fp ? fp.rule : 'fit',
        };
        if (typeof fj === 'string') return refuse(fj);
        partial.drawMsPerFrame = fj.ms;
        // The first full-size frame runs cold, and is a submission like any other: the cap judges it too (the EA5.4 review).
        const firstFrameMs = predictFirstFrame(fj.ms, frameFirst, frames[0], frames[1], pixels);
        partial.firstFrameMs = firstFrameMs;
        if (firstFrameMs > maxSubmissionMs) return refuse(`EA_PROBE the first frame: ${firstFrameMs.toFixed(1)} ms predicted, over the ${maxSubmissionMs} ms cap`);

        const steady = step.ms + fj.ms;
        const warnings: string[] = [];
        if (steady > WORLD_PROBE.steadyTargetMs) {
            warnings.push(`EA_SLOW ${steady.toFixed(1)} ms a steady frame here, over the ${WORLD_PROBE.steadyTargetMs} ms target${steady > WORLD_PROBE.steadySlowMs ? ` (over ${WORLD_PROBE.steadySlowMs} ms: below 10 fps)` : ''}`);
        }
        if (contaminated) warnings.push('the Head shared the queue while this measured: its work is in every timing, never subtracted');
        const probe: WorldProbe = {
            computeMsPerFrame: step.ms, drawMsPerFrame: fj.ms, initMs: initJudged.ms,
            firstFrameMs, maxSubmissionMs: Math.max(initJudged.ms, step.ms, fj.ms, firstFrameMs), steadyFrameMs: steady, catchUpMs: WORLD_PROBE.catchUpSteps * step.ms + fj.ms,
            peakBytes: 0, viewport: { ...deps.target }, profile: WORLD_PROBE.profile, budgetMs: maxSubmissionMs, floorMs,
            phases: partial.phases as WorldProbe['phases'], projection: partial.projection, warnings, contaminated,
        };
        return { ok: true, probe };
    } catch (e) {
        if (e instanceof Refusal) return refuse(e.message);
        throw e;
    } finally {
        for (const b of built) {
            b.variant.release();
            b.headless.destroy();
        }
    }
}

// ------------------------------------------------------------------ the sanity look

/** What a pinned world declares about its first frame (§9 step 4): its brightest pixel at least this (luminance, 0 to 1). */
export interface SanityProfile {
    name: string;
    /** X's programHash: the program the profile is for, under this resolver. */
    programHash: string;
    minFrameMax: number;
}

/**
 * EA5's three pinned worlds, each declared visible at time zero: its brightest pixel at least 2 of 255, as h1's own
 * black-frame threshold. A world with no profile has its visibility reported untested.
 */
export const SANITY_PROFILES: readonly SanityProfile[] = [
    { name: 'block-film', programHash: 'daa4e4734a0cb21f3ccfd7ad6d25ac06f049d001a4879c8b6f1079aae286cd82', minFrameMax: 2 / 255 },
    { name: 'galaxy', programHash: '2dbdbf177c3a5734dd1af075b8ff53a2f14e5a3df18e4ba3a92847a93c8385bd', minFrameMax: 2 / 255 },
    { name: 'foggy-dusk', programHash: 'a093c2312aac08090537f5450ef3b9b8371055f20ad069e570094c85d5a977e2', minFrameMax: 2 / 255 },
];

export interface SanityNumbers {
    /** Floats read back, every sampled buffer together. */
    sampled: number;
    nonFinite: number;
    /** The first non-finite float, `resource[index]`. */
    firstNonFinite: string | null;
    /** State buffers this engine could not read back. */
    untested: string[];
    /** The first frame's mean and brightest luminance, 0 to 1. */
    frameMean: number;
    frameMax: number;
    visibility: 'passed' | 'untested';
    profile: string | null;
}

export type SanityOutcome = { ok: true; numbers: SanityNumbers } | { ok: false; reason: string; numbers: SanityNumbers };

/** RGBA8's mean and brightest luminance (Rec. 709 weights). */
export function luminance(pixels: Uint8Array): { mean: number; max: number } {
    let sum = 0;
    let max = 0;
    const n = Math.floor(pixels.length / 4);
    for (let i = 0; i < n * 4; i += 4) {
        const l = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
        sum += l;
        if (l > max) max = l;
    }
    return { mean: n ? sum / n : 0, max };
}

/** Typed state sampled for finiteness; the first frame judged by the world's profile, or reported untested. */
export async function sanityLook(runtime: AgentRuntime, port: EnginePort, x: Graph, pixels: Uint8Array | null, profiles: readonly SanityProfile[] = SANITY_PROFILES): Promise<SanityOutcome> {
    const numbers: SanityNumbers = { sampled: 0, nonFinite: 0, firstNonFinite: null, untested: [], frameMean: 0, frameMax: 0, visibility: 'untested', profile: null };
    for (const s of runtime.stateBuffers()) {
        if (!port.readBuffer) {
            numbers.untested.push(s.resource);
            continue;
        }
        const floats = Math.min(s.elements, SAMPLE_INSTANCES) * s.strideFloats;
        const data = new Float32Array(await port.readBuffer(s.buffer, floats * 4));
        numbers.sampled += data.length;
        for (let i = 0; i < data.length; i++) {
            if (Number.isFinite(data[i])) continue;
            numbers.nonFinite++;
            if (numbers.firstNonFinite === null) numbers.firstNonFinite = `${s.resource}[${i}]`;
        }
    }
    if (pixels) {
        const l = luminance(pixels);
        numbers.frameMean = l.mean;
        numbers.frameMax = l.max;
    }
    if (numbers.nonFinite > 0) {
        return { ok: false, numbers, reason: `EA_SANITY NaN at ${numbers.firstNonFinite}: ${numbers.nonFinite} of ${numbers.sampled} sampled floats are not finite` };
    }
    const profile = profiles.find(p => p.programHash !== '' && p.programHash === x.identity.programHash);
    if (profile && pixels) {
        numbers.profile = profile.name;
        if (numbers.frameMax < profile.minFrameMax) {
            return { ok: false, numbers, reason: `EA_SANITY black: the brightest pixel is ${(numbers.frameMax * 255).toFixed(1)} of 255; ${profile.name} declares at least ${(profile.minFrameMax * 255).toFixed(1)}` };
        }
        numbers.visibility = 'passed';
    }
    return { ok: true, numbers };
}
