// Rungs L5 and L7 (core-loop-frontend.md §7): the cost probe and the sanity look, both on small worlds of the same
// spec (1/8 and 1/4 of the particles at a small frame) built on headless engines of their own, before the full
// world is ever built. The probe predicts the full cost by scaling what it measured, and over-predicts rather than
// under-predicts (the safe direction, design-doc guide §4); together with the lint's loop bound it is what keeps a
// kernel that would hang the GPU from running at full size (R4; the gotcha "Windows resets a GPU that stays busy
// for about 2 s"). It times a step before the warm-up runs one (F4), and destroys every world it built whatever
// happens (F3). The sanity look reads back a sample of particles and the small frame: a NaN, an empty world, a
// static one or a black frame is refused with numbers a repair can act on.

import { NullGraph } from 'null-graph';
import { FrameReadback } from 'null-graph/film';
import type { FunctionName, SceneSpec } from '../contract/spec';
import type { ProbeNumbers } from '../loop/machine';
import { firstView } from '../runtime/camera-path';
import { SceneRuntime } from '../runtime/scene-runtime';
import { PARTICLE_STRIDE } from '../runtime/spawn';
import type { GateDiagnostic } from './gate';

export const PROBE = {
    /**
     * The probe's two worlds: the full count divided by each, so the per-particle cost is their difference. At 1/4
     * the heaviest kernel the lint admits (128 curl3 a particle: about a second at 2M particles on the iGPU)
     * submits about 250 ms, under the 2 s that resets the GPU; smaller worlds measured too little to tell a
     * per-particle cost from the timer's grain (the gates of 2026-10-28).
     */
    fractions: [8, 4] as const,
    /** The probe's two frames: the per-pixel cost is the difference. */
    small: { width: 320, height: 180 },
    large: { width: 640, height: 360 },
    /** Steps and frames run untimed first, so a cold pipeline compile (4 to 27 s on NVIDIA, gotchas) is not measured as cost. */
    warmSteps: 2,
    /** Steps and frames timed, so the timer's 0.1 ms grain and a submit's fixed cost average out. */
    steps: 12,
    frames: 6,
    /**
     * The probe's worlds run the spec's warm-up in batches of about this many milliseconds of the step it timed,
     * the queue drained and the cancel checked between batches, so the page keeps drawing and a cancel stops it (F4).
     */
    warmUpBatchMs: 32,
    /**
     * The budget for one predicted full-size frame. What the probe guards against is the hang (R4: a GPU busy
     * for about 2 s is reset); a slow world is the preview guard's, which trades resolution and quality down to a
     * quarter of the pixels. So the budget is the submission cap, not a frame rate; Day 2 tunes it.
     */
    budgetMs: 250,
    /** No single submission may be predicted over this (spec §10). */
    maxSubmissionMs: 250,
    /** The prediction is raised by this before it is judged: the safe direction is over-predicting. */
    margin: 1.25,
    /** Particles read back for the sanity look. */
    sample: 1024,
} as const;

/**
 * L5's verdict. Over budget, the diagnostic for the repair, aimed at the function that costs, and no world (the
 * probe destroyed them); within budget, the larger world, warmed up, for the sanity look (the caller destroys it).
 */
export type ProbeOutcome =
    | { numbers: ProbeNumbers; diagnostic: null; world: ProbeWorld }
    | { numbers: ProbeNumbers; diagnostic: GateDiagnostic; world: null };

export interface SanityOutcome {
    ok: boolean;
    diagnostic: GateDiagnostic | null;
    numbers: { nonFinite: number; atOrigin: number; medianDistance: number; cameraDistance: number; moved: number; frameMean: number; frameMax: number };
}

export interface ProbeWorld {
    engine: NullGraph;
    runtime: SceneRuntime;
}

/**
 * A world of `spec` with `count` particles on a headless engine over the app's device, placed but not warmed up
 * (F4); the caller destroys both. A failed or thrown build leaves nothing behind.
 */
export async function buildProbeWorld(device: GPUDevice, spec: SceneSpec, count: number): Promise<ProbeWorld | { error: string }> {
    const engine = new NullGraph();
    try {
        const init = await engine.init(null, { device, width: PROBE.small.width, height: PROBE.small.height });
        if (!init.success) {
            engine.destroy();
            return { error: init.error ?? "the probe's engine did not start" };
        }
        const { runtime, smoke } = await SceneRuntime.build(engine, spec, PROBE.small.width, PROBE.small.height, { count, warmUp: false });
        if (!runtime) {
            engine.destroy();
            return { error: smoke.error ?? "the probe's world did not build" };
        }
        return { engine, runtime };
    } catch (error) {
        engine.destroy();
        throw error;
    }
}

export function destroyProbeWorld(world: ProbeWorld): void {
    world.runtime.destroy();
    world.engine.destroy();
}

async function settle(device: GPUDevice): Promise<void> {
    await device.queue.onSubmittedWorkDone();
}

/** One step's cost at the world's size, averaged, after untimed steps that compile the pipeline. */
async function timeStep(device: GPUDevice, { runtime }: ProbeWorld): Promise<number> {
    for (let i = 0; i < PROBE.warmSteps; i++) runtime.step();
    await settle(device);
    const t0 = performance.now();
    for (let i = 0; i < PROBE.steps; i++) runtime.step();
    await settle(device);
    return (performance.now() - t0) / PROBE.steps;
}

/**
 * The spec's warm-up, as reset() runs it on the full world, so the frames and the sanity look see the state a
 * film starts from: in batches of about PROBE.warmUpBatchMs of the step timed, the queue drained and `signal`
 * checked between them (F4). The clock restarts after it, as reset()'s does.
 */
async function warmUp(device: GPUDevice, { runtime }: ProbeWorld, stepMs: number, signal?: AbortSignal): Promise<void> {
    const batch = Math.max(1, Math.floor(PROBE.warmUpBatchMs / Math.max(stepMs, 1e-3)));
    for (let done = 0; done < runtime.warmupSteps; done += batch) {
        signal?.throwIfAborted();
        for (let i = 0; i < Math.min(batch, runtime.warmupSteps - done); i++) runtime.step();
        await settle(device);
    }
    signal?.throwIfAborted();
    runtime.restartClock();
}

/** One frame's cost at the small and the large size, averaged, after untimed frames that compile the pipelines and size the targets. */
async function timeFrames(device: GPUDevice, { engine, runtime }: ProbeWorld, spec: SceneSpec): Promise<{ smallMs: number; largeMs: number }> {
    const view = firstView(spec.camera.keyframes);
    const frame = () => { runtime.view(view, runtime.simTime); engine.render(runtime.draw()); };
    const size = (w: number, h: number) => { engine.resize(w, h); runtime.resize(w, h); };
    for (let i = 0; i < PROBE.warmSteps; i++) frame();
    size(PROBE.large.width, PROBE.large.height);
    frame();
    size(PROBE.small.width, PROBE.small.height);
    frame();
    await settle(device);

    let t0 = performance.now();
    for (let i = 0; i < PROBE.frames; i++) frame();
    await settle(device);
    const smallMs = (performance.now() - t0) / PROBE.frames;

    size(PROBE.large.width, PROBE.large.height);
    frame();
    await settle(device);
    t0 = performance.now();
    for (let i = 0; i < PROBE.frames; i++) frame();
    await settle(device);
    const largeMs = (performance.now() - t0) / PROBE.frames;
    size(PROBE.small.width, PROBE.small.height);
    return { smallMs, largeMs };
}

const tooSlow = (what: string, ms: number, limit: number, target: FunctionName): GateDiagnostic => ({
    target, severity: 'error', source: 'probe', line: 0, column: 0, snippet: '',
    message: `too slow: ${what} is predicted to take ${Math.round(ms)} ms on this graphics card; the budget is ${limit} ms. Do less work per particle (no curl3 in a loop, fewer octaves, smaller loops).`,
});

/**
 * L5: two small worlds of the spec (1/8 and 1/4 of the particles), placed, then timed in the order that refuses a
 * heavy world soonest (F4): a step on each, judged before the warm-up would run it hundreds of times; the spec's
 * warm-up on each, in cancellable batches; a frame on each at two sizes, judged. The costs split into a fixed part,
 * a per-particle part and a per-pixel part, and the full world's cost is predicted from those for its count and the
 * live frame's pixels. Slopes never go below zero (the safe direction), and the fixed part is counted as measured,
 * never scaled. Every world is registered as it is built and destroyed here, unless it is the one handed back,
 * also when a step throws or `signal` cancels (F3).
 */
export async function probeWorld(device: GPUDevice, spec: SceneSpec, livePixels: number, signal?: AbortSignal): Promise<ProbeOutcome | { error: string }> {
    const counts = PROBE.fractions.map(f => Math.max(128, Math.ceil(spec.particles.count / f)));
    const worlds: ProbeWorld[] = [];
    let kept: ProbeWorld | null = null;
    try {
        for (const count of counts) {
            const world = await buildProbeWorld(device, spec, count);
            if ('error' in world) return world;
            worlds.push(world);
        }
        const [nA, nB] = worlds.map(w => w.runtime.count);
        const slope = (ya: number, yb: number, xa: number, xb: number) => (xb > xa ? Math.max(0, (yb - ya) / (xb - xa)) : 0);
        const count = spec.particles.count;

        // A step on each world, judged before any warm-up.
        const stepA = await timeStep(device, worlds[0]);
        const stepB = await timeStep(device, worlds[1]);
        const perStep = slope(stepA, stepB, nA, nB);
        const fixedStep = Math.max(0, stepA - perStep * nA);
        const stepMs = (fixedStep + perStep * count) * PROBE.margin;
        if (stepMs > PROBE.maxSubmissionMs) {
            const numbers: ProbeNumbers = { stepMs, frameMs: null, predictedMs: stepMs, budgetMs: PROBE.budgetMs, measuredStepMs: stepB, measuredFrameMs: null };
            return { numbers, diagnostic: tooSlow('one step of evolve', stepMs, PROBE.maxSubmissionMs, 'evolve'), world: null };
        }

        await warmUp(device, worlds[0], stepA, signal);
        await warmUp(device, worlds[1], stepB, signal);

        // A frame on each warmed-up world, at two sizes. A sprite's cost grows with the frame too (it covers more
        // pixels), so the per-particle draw cost is taken at both sizes and extrapolated to the live frame, never
        // below the small frame's.
        const a = await timeFrames(device, worlds[0], spec);
        const b = await timeFrames(device, worlds[1], spec);
        const smallPixels = PROBE.small.width * PROBE.small.height;
        const largePixels = PROBE.large.width * PROBE.large.height;
        const perDrawSmall = slope(a.smallMs, b.smallMs, nA, nB);
        const perDrawLarge = slope(a.largeMs, b.largeMs, nA, nB);
        const perDraw = Math.max(perDrawSmall, perDrawSmall + (perDrawLarge - perDrawSmall) * (livePixels - smallPixels) / (largePixels - smallPixels));
        const perPixel = slope(a.smallMs, a.largeMs, smallPixels, largePixels);
        const fixedDraw = Math.max(0, a.smallMs - perDrawSmall * nA - perPixel * smallPixels);
        const frameMs = (fixedDraw + perDraw * count + perPixel * livePixels) * PROBE.margin;
        const predictedMs = stepMs + frameMs;
        const numbers: ProbeNumbers = { stepMs, frameMs, predictedMs, budgetMs: PROBE.budgetMs, measuredStepMs: stepB, measuredFrameMs: b.largeMs };

        const drawTarget: FunctionName = spec.sky === 'function' && perPixel * livePixels > perDraw * count ? 'sky' : 'look';
        const diagnostic = frameMs > PROBE.maxSubmissionMs ? tooSlow('drawing one frame', frameMs, PROBE.maxSubmissionMs, drawTarget)
            : predictedMs > PROBE.budgetMs ? tooSlow('one frame', predictedMs, PROBE.budgetMs, stepMs >= frameMs ? 'evolve' : drawTarget)
                : null;
        if (diagnostic) return { numbers, diagnostic, world: null };
        kept = worlds[1];
        return { numbers, diagnostic: null, world: kept };
    } finally {
        for (const w of worlds) if (w !== kept) destroyProbeWorld(w);
    }
}

/** The first `n` particles' eight floats. */
export async function readParticles(device: GPUDevice, runtime: SceneRuntime, n: number): Promise<Float32Array> {
    const count = Math.min(n, runtime.count);
    const size = count * PARTICLE_STRIDE * 4;
    const read = device.createBuffer({ label: 'wexy/sanity read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder({ label: 'wexy/sanity copy' });
    encoder.copyBufferToBuffer(runtime.particleBuffer, 0, read, 0, size);
    device.queue.submit([encoder.finish()]);
    try {
        await read.mapAsync(GPUMapMode.READ);
        return new Float32Array(read.getMappedRange().slice(0));
    } finally {
        read.unmap();
        read.destroy();
    }
}

/** L7: a sample of the probe world's particles after its steps, and its frame, judged. */
export async function sanityLook(device: GPUDevice, world: ProbeWorld, spec: SceneSpec): Promise<SanityOutcome> {
    const { engine, runtime } = world;
    const view = firstView(spec.camera.keyframes);
    const before = await readParticles(device, runtime, PROBE.sample);
    for (let i = 0; i < 4; i++) runtime.step();
    const after = await readParticles(device, runtime, PROBE.sample);
    const n = after.length / PARTICLE_STRIDE;
    let nonFinite = 0;
    let atOrigin = 0;
    let moved = 0;
    const distances: number[] = [];
    for (let i = 0; i < n; i++) {
        const o = i * PARTICLE_STRIDE;
        const x = after[o], y = after[o + 1], z = after[o + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(after[o + 3])) { nonFinite++; continue; }
        if (x === 0 && y === 0 && z === 0) atOrigin++;
        const dx = x - view.target[0], dy = y - view.target[1], dz = z - view.target[2];
        distances.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
        if (x !== before[o] || y !== before[o + 1] || z !== before[o + 2]) moved++;
    }
    distances.sort((a, b) => a - b);
    const medianDistance = distances.length ? distances[distances.length >> 1] : Infinity;

    runtime.view(view, runtime.simTime);
    engine.render(runtime.draw());
    const readback = new FrameReadback(device, engine.screenTexture as GPUTexture, PROBE.small.width, PROBE.small.height);
    let frameMean = 0;
    let frameMax = 0;
    try {
        readback.grab(0);
        const { bytes } = await readback.take();
        let sum = 0;
        for (let i = 0; i < bytes.length; i += 4) {
            const l = (bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722) / 255;
            sum += l;
            if (l > frameMax) frameMax = l;
        }
        frameMean = sum / (bytes.length / 4);
    } finally {
        readback.destroy();
    }

    const numbers = { nonFinite, atOrigin, medianDistance, cameraDistance: view.distance, moved, frameMean, frameMax };
    const refuse = (target: FunctionName, message: string): SanityOutcome => ({ ok: false, numbers, diagnostic: { target, severity: 'error', source: 'sanity', line: 0, column: 0, snippet: '', message } });
    if (nonFinite > 0) return refuse('evolve', `${nonFinite} of ${n} sampled particles have a non-finite position or phase (NaN or infinity): every result must stay finite; clamp before sqrt, log, pow and division`);
    if (atOrigin > n / 2) return refuse('evolve', `${atOrigin} of ${n} sampled particles are still at the origin after ${runtime.frame} steps: evolve must place every particle on its first step, from its random numbers`);
    if (medianDistance > 4 * view.distance) return refuse('evolve', `the particles are far from the camera: median distance ${medianDistance.toExponential(1)} from the target, while the camera is ${view.distance} away; keep the world within a few units of the origin`);
    if (moved < n / 10) return refuse('evolve', `only ${moved} of ${n} sampled particles moved over 4 steps: the world must keep moving (integrate with sim.dt)`);
    if (frameMax < 2 / 255) return refuse(spec.sky === 'function' && frameMean === 0 ? 'look' : 'look', `the frame is black: look's colors or sizes come out at zero (the brightest pixel is ${(frameMax * 255).toFixed(1)} of 255)`);
    return { ok: true, numbers, diagnostic: null };
}
