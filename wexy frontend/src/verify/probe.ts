// Rungs L5 and L7 (core-loop-frontend.md §7): the cost probe and the sanity look, both on a small world of the
// same spec (1/64 of the particles at a quarter-size frame) built on a headless engine of its own, before the full
// world is ever built. The probe predicts the full cost by scaling what it measured, and over-predicts rather than
// under-predicts (the safe direction, design-doc guide §4); together with the lint's loop bound it is what keeps a
// kernel that would hang the GPU from running at full size (R4; the gotcha "Windows resets a GPU that stays busy
// for about 2 s"). The sanity look reads back a sample of particles and the small frame: a NaN, an empty world, a
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
    /** The full count divided by this is the probe's count. */
    fraction: 64,
    /** The probe's frame. */
    width: 320,
    height: 180,
    /** Steps and frames timed, so the timer's 0.1 ms grain and a submit's fixed cost average out. */
    steps: 8,
    frames: 4,
    /** The budget for one predicted full-size frame; the preview guard trades resolution and quality below it. */
    budgetMs: 100,
    /** No single submission may be predicted over this (spec §10). */
    maxSubmissionMs: 250,
    /** Particles read back for the sanity look. */
    sample: 1024,
} as const;

export interface ProbeOutcome {
    numbers: ProbeNumbers;
    /** Over budget: the diagnostic for the repair, aimed at the function that costs. */
    diagnostic: GateDiagnostic | null;
}

export interface SanityOutcome {
    ok: boolean;
    diagnostic: GateDiagnostic | null;
    numbers: { nonFinite: number; atOrigin: number; medianDistance: number; cameraDistance: number; moved: number; frameMean: number; frameMax: number };
}

/** A small world of `spec` on a headless engine over the app's device; the caller destroys both. */
export async function buildProbeWorld(device: GPUDevice, spec: SceneSpec): Promise<{ engine: NullGraph; runtime: SceneRuntime } | { error: string }> {
    const engine = new NullGraph();
    const init = await engine.init(null, { device, width: PROBE.width, height: PROBE.height });
    if (!init.success) return { error: init.error ?? 'the probe\'s engine did not start' };
    const count = Math.max(128, Math.ceil(spec.particles.count / PROBE.fraction));
    const { runtime, smoke } = await SceneRuntime.build(engine, spec, PROBE.width, PROBE.height, count);
    if (!runtime) {
        engine.destroy();
        return { error: smoke.error ?? 'the probe\'s world did not build' };
    }
    return { engine, runtime };
}

async function settle(device: GPUDevice): Promise<void> {
    await device.queue.onSubmittedWorkDone();
}

/** The cost of an empty submit and its round trip, which every measured step and frame also pays. */
async function baseline(device: GPUDevice, n: number): Promise<number> {
    await settle(device);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) device.queue.submit([device.createCommandEncoder().finish()]);
    await settle(device);
    return (performance.now() - t0) / n;
}

/** L5: one step and one frame of the small world, timed; the full world's cost predicted from them. */
export async function probeWorld(device: GPUDevice, engine: NullGraph, runtime: SceneRuntime, spec: SceneSpec): Promise<ProbeOutcome> {
    const view = firstView(spec.camera.keyframes);
    const scale = spec.particles.count / runtime.count;
    const base = await baseline(device, PROBE.steps);

    await settle(device);
    let t0 = performance.now();
    for (let i = 0; i < PROBE.steps; i++) runtime.step();
    await settle(device);
    const measuredStepMs = (performance.now() - t0) / PROBE.steps;

    t0 = performance.now();
    for (let i = 0; i < PROBE.frames; i++) {
        runtime.view(view, runtime.simTime);
        engine.render(runtime.draw());
    }
    await settle(device);
    const measuredFrameMs = (performance.now() - t0) / PROBE.frames;

    // Per-particle work scales with the count; per-pixel work scales with the area, which is at most ~40× the probe's
    // for the live preview (2.3 MP) and less than the count's 64×, so the count's scale over-predicts both.
    const stepMs = Math.max(0, measuredStepMs - base) * scale;
    const frameMs = Math.max(0, measuredFrameMs - base) * scale;
    const predictedMs = stepMs + frameMs;
    const numbers: ProbeNumbers = { stepMs, frameMs, predictedMs, budgetMs: PROBE.budgetMs, measuredStepMs, measuredFrameMs };

    let diagnostic: GateDiagnostic | null = null;
    const over = (what: string, ms: number, limit: number, target: FunctionName) => {
        diagnostic ??= {
            target, severity: 'error', source: 'probe', line: 0, column: 0, snippet: '',
            message: `too slow: ${what} is predicted to take ${Math.round(ms)} ms on this graphics card; the budget is ${limit} ms. Do less work per particle (no curl3 in a loop, fewer octaves, smaller loops).`,
        };
    };
    if (stepMs > PROBE.maxSubmissionMs) over('one step of evolve', stepMs, PROBE.maxSubmissionMs, 'evolve');
    if (frameMs > PROBE.maxSubmissionMs) over('drawing one frame', frameMs, PROBE.maxSubmissionMs, spec.sky === 'function' && frameMs > stepMs ? 'sky' : 'look');
    if (predictedMs > PROBE.budgetMs) over('one frame', predictedMs, PROBE.budgetMs, stepMs >= frameMs ? 'evolve' : spec.sky === 'function' ? 'sky' : 'look');
    return { numbers, diagnostic };
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

/** L7: a sample of the small world's particles after its steps, and its frame, judged. */
export async function sanityLook(device: GPUDevice, engine: NullGraph, runtime: SceneRuntime, spec: SceneSpec): Promise<SanityOutcome> {
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
    const readback = new FrameReadback(device, engine.screenTexture as GPUTexture, PROBE.width, PROBE.height);
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
