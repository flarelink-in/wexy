// The contract gates CG1 to CG5 (FE1 design §10): host h1 and the verify ladder on a real GPU, one page per run,
// driven in Chrome on each GPU by dev/contract-gates.mjs. The page logs "[g] done" or "[g] failed: …" and leaves
// window.__CG__ for the runner: its checks, what it measured, and the adapter it ran on.
//   CG1  every h1 exemplar lints clean, needs no auto-fix and compiles (cold and warm); the recorded fault fails
//        at line 11, column 25 with the compiler's message, mapped from the host module onto the function.
//   CG2  the galaxy and storm worlds pass the whole ladder; the probe's prediction is checked against the full
//        world's measured frame (never under half of it); the sanity numbers are what the exemplars promise.
//   CG3  a deliberately slow kernel (curl3 in nested loops of 8 × 16, the most the lint admits, over 1M particles)
//        is refused by the probe, before any full-size build (the FE1 exit gate).
//   CG4  the sanity look catches a NaN, a world a million units away, a static world and a black frame, each
//        naming the function a repair should fix.
//   CG5  the three playground examples (the expert setting) pass the same ladder.

import { NullGraph } from 'null-graph';
import { parseDraft, specFromDraft } from '../src/contract/draft';
import { H1 } from '../src/contract/h1';
import { autofix } from '../src/contract/autofix';
import { lintFunction } from '../src/contract/lint';
import { withProgramText, type SceneSpec } from '../src/contract/spec';
import { ARCHETYPES, archetypeSpec } from '../src/forge-client/archetypes';
import { firstView } from '../src/runtime/camera-path';
import { compileTarget } from '../src/verify/gate';
import { createLadder } from '../src/verify/ladder';
import { PROBE } from '../src/verify/probe';

const logEl = document.getElementById('log')!;
const log = (line: string, level: 'log' | 'error' = 'log') => {
    console[level](`[g] ${line}`);
    logEl.textContent += `${line}\n`;
};
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok: !!ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, ok ? 'log' : 'error');
};

const W = 1280, H = 720;

function worldOf(name: 'galaxy' | 'storm'): SceneSpec {
    const { draft, problems } = parseDraft(H1.plans[name]);
    if (!draft) throw new Error(`the ${name} plan does not parse: ${problems.join('; ')}`);
    return specFromDraft(draft, { kind: 'functions', ...H1.exemplars[name] });
}

const SLOW_EVOLVE = `fn evolve(p: Particle, i: u32) -> Particle {
    var next = p;
    var flow = vec3f(0.0);
    for (var k = 0; k < 8; k++) {
        for (var m = 0; m < 16; m++) {
            flow += curl3(p.pos * 0.5 + vec3f(f32(k) * 0.37, sim.time * 0.1 + f32(m), f32(i) * 0.001));
        }
    }
    next.pos = vec3f(p.b.x * 4.0, p.b.y * 2.0, p.b.z * 4.0) + flow * 0.01;
    next.phase = p.phase + sim.dt;
    return next;
}`;

const NAN_EVOLVE = `fn evolve(p: Particle, i: u32) -> Particle {
    var next = p;
    next.pos = vec3f(p.b.x * 4.0, sqrt(-1.0 - p.b.y * p.b.y), p.b.z * 4.0);
    next.phase = p.phase + sim.dt;
    return next;
}`;

const FAR_EVOLVE = `fn evolve(p: Particle, i: u32) -> Particle {
    var next = p;
    next.pos = vec3f(1000000.0 + p.b.x, p.b.y, p.b.z);
    next.phase = p.phase + sim.dt;
    return next;
}`;

const STATIC_EVOLVE = `fn evolve(p: Particle, i: u32) -> Particle {
    var next = p;
    if (sim.frame == 0u) {
        next.pos = vec3f(p.b.x * 4.0, p.b.y * 2.0, p.b.z * 4.0);
    }
    return next;
}`;

const BLACK_LOOK = `fn look(p: Particle, i: u32) -> Look {
    var o: Look;
    o.color = vec3f(0.0);
    o.size = 0.0;
    o.opacity = 0.0;
    return o;
}`;

async function main(): Promise<Record<string, unknown>> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const { vendor, architecture, description } = adapter.info;
    const device = await adapter.requestDevice();
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
    log(`adapter: ${vendor} ${architecture} ${description}`);
    const engine = new NullGraph();
    const init = await engine.init(null, { device, width: W, height: H });
    if (!init.success) throw new Error(init.error ?? 'the engine did not start');
    const ladder = createLadder(engine, { width: () => W, height: () => H });
    const signal = new AbortController().signal;
    const results: Record<string, unknown> = {};

    // CG1: the exemplars and the fault, through L1 to L3.
    const compiles: Record<string, { cold: number; warm: number }> = {};
    for (const world of ['galaxy', 'storm'] as const) {
        const spec = worldOf(world);
        for (const fn of ['evolve', 'look', 'sky'] as const) {
            const text = H1.exemplars[world][fn];
            check(`CG1 ${world}.${fn} lints clean and needs no auto-fix`, lintFunction(fn, text).length === 0 && autofix(text).body === text, lintFunction(fn, text).map(i => i.message));
            const cold = await compileTarget(device, spec, fn);
            const warm = await compileTarget(device, spec, fn);
            const errors = cold.diagnostics.filter(d => d.severity === 'error');
            check(`CG1 ${world}.${fn} compiles in its host module`, errors.length === 0, errors.map(d => `${d.line}:${d.column} ${d.message}`));
            compiles[`${world}.${fn}`] = { cold: Math.round(cold.ms * 100) / 100, warm: Math.round(warm.ms * 100) / 100 };
        }
    }
    const faulted = withProgramText(worldOf('galaxy'), 'evolve', H1.faults['galaxy.evolve']);
    const fault = await compileTarget(device, faulted, 'evolve');
    const first = fault.diagnostics.find(d => d.severity === 'error');
    check('CG1 the recorded fault fails at line 11, column 25, with the compiler\'s message on the function\'s own line',
        !!first && first.line === 11 && first.column === 25 && /hash11/.test(first.message) && first.snippet === 'let jitter = hash11(i) * 0.02;',
        first && { line: first.line, column: first.column, message: first.message, snippet: first.snippet });
    results.compiles = compiles;

    // CG2: the two worlds through the ladder, and the probe against the full world's measured frame.
    const probes: Record<string, unknown> = {};
    for (const world of ['galaxy', 'storm'] as const) {
        const spec = worldOf(world);
        const t0 = performance.now();
        const r = await ladder.verify(spec, signal);
        const ladderMs = performance.now() - t0;
        check(`CG2 ${world} passes the ladder`, r.ok, r.ok ? r.report.rungs.map(x => `${x.rung} ${x.ms.toFixed(1)}`) : { failure: r.failure.message, rungs: r.report.rungs });
        if (!r.ok) continue;
        const runtime = r.world;
        const view = firstView(spec.camera.keyframes);
        // The full world's cost: 60 steps and frames at 1280×720, after a warm frame.
        runtime.view(view, 0);
        engine.render(runtime.draw());
        await device.queue.onSubmittedWorkDone();
        const t1 = performance.now();
        for (let i = 0; i < 60; i++) {
            runtime.step();
            runtime.view(view, runtime.simTime);
            engine.render(runtime.draw());
        }
        await device.queue.onSubmittedWorkDone();
        const measuredMs = (performance.now() - t1) / 60;
        const p = r.report.probe!;
        const ratio = p.predictedMs / measuredMs;
        check(`CG2 ${world}: the probe's prediction is never under half the measured frame (predicted ${p.predictedMs.toFixed(1)} ms, measured ${measuredMs.toFixed(1)} ms, ×${ratio.toFixed(2)})`, p.predictedMs >= measuredMs * 0.5, { predicted: p.predictedMs, measured: measuredMs, ratio });
        const sanity = r.report.rungs.find(x => x.rung === 'L7');
        check(`CG2 ${world}: the sanity look saw a finite, placed, moving, lit world`, !!sanity?.ok && /finite yes/.test(sanity.detail ?? ''), sanity?.detail);
        probes[world] = { ladderMs: Math.round(ladderMs), rungs: r.report.rungs, probe: p, measuredMs, ratio, particles: runtime.count };
        runtime.destroy();
    }
    results.probes = probes;

    // CG3: the slow kernel is refused by the probe, before any full build.
    {
        // The heaviest world the contract admits: the most particles a draft may ask for, and the most work a particle may do.
        const spec = withProgramText({ ...worldOf('galaxy'), particles: { ...worldOf('galaxy').particles, count: 2_097_152 } }, 'evolve', SLOW_EVOLVE);
        check('CG3 the slow kernel passes the lint (8 × 16 nested steps are allowed) so only the probe can stop it', lintFunction('evolve', SLOW_EVOLVE).length === 0, lintFunction('evolve', SLOW_EVOLVE).map(i => i.message));
        const t0 = performance.now();
        const r = await ladder.verify(spec, signal);
        const ms = performance.now() - t0;
        const l5 = r.report.rungs.find(x => x.rung === 'L5');
        check('CG3 the probe refuses the slow kernel as too heavy, naming evolve, with no full-size build',
            !r.ok && r.failure.reason === 'probe' && r.failure.target === 'evolve' && /too slow/.test(r.failure.message) && !r.report.rungs.some(x => x.rung === 'L6'),
            r.ok ? 'passed' : { message: r.failure.message, rungs: r.report.rungs });
        check(`CG3 the refusal took under 20 s (${Math.round(ms)} ms): the probe's own submissions stayed small (the iGPU takes about 10 s for this, the heaviest world the contract admits)`, ms < 20_000, { ms, l5: l5?.detail });
        results.slow = { ms, probe: r.report.probe, ok: r.ok };

        // F4 (the pass-graph design §13): the same kernel with ten seconds of warm-up at 1/240 s, 2,400 steps. The
        // probe used to run the whole warm-up on both of its worlds before timing a step: minutes on the iGPU. Now a
        // step is timed and refused first, so no frame is timed and the refusal takes about as long as CG3's.
        const warm = { ...spec, particles: { ...spec.particles, warmupSeconds: 10, dt: 1 / 240 } };
        const t1 = performance.now();
        const w = await ladder.verify(warm, signal);
        const wms = performance.now() - t1;
        check(`CG3 with 2,400 warm-up steps the slow kernel is refused before any warm-up step, as fast (${Math.round(wms)} ms; CG3 took ${Math.round(ms)} ms)`,
            !w.ok && w.failure.reason === 'probe' && w.failure.target === 'evolve' && w.report.probe?.frameMs === null && wms < 20_000,
            w.ok ? 'passed' : { message: w.failure.message, l5: w.report.rungs.find(x => x.rung === 'L5')?.detail });
        results.slowWarm = { ms: wms, probe: w.report.probe, ok: w.ok };
    }

    // CG4: the sanity detectors, each naming its function.
    {
        const cases: [string, SceneSpec, RegExp, 'evolve' | 'look'][] = [
            ['a NaN position', withProgramText(worldOf('galaxy'), 'evolve', NAN_EVOLVE), /non-finite/, 'evolve'],
            ['a world a million units away', withProgramText(worldOf('galaxy'), 'evolve', FAR_EVOLVE), /far from the camera/, 'evolve'],
            ['a world that never moves', withProgramText(worldOf('galaxy'), 'evolve', STATIC_EVOLVE), /moved over 4 steps|must keep moving/, 'evolve'],
            ['a black frame', withProgramText({ ...worldOf('galaxy'), sky: 'black' }, 'look', BLACK_LOOK), /frame is black/, 'look'],
        ];
        const sanity: Record<string, unknown> = {};
        for (const [name, spec, pattern, target] of cases) {
            const r = await ladder.verify(spec, signal);
            check(`CG4 the sanity look refuses ${name}, naming ${target}`, !r.ok && r.failure.reason === 'sanity' && r.failure.target === target && pattern.test(r.failure.message),
                r.ok ? 'passed' : { reason: r.failure.reason, target: r.failure.target, message: r.failure.message });
            sanity[name] = r.ok ? 'passed' : r.failure.message;
            if (r.ok) r.world.destroy();
        }
        results.sanity = sanity;
    }

    // CG5: the playground examples through the same ladder.
    const expert: Record<string, unknown> = {};
    for (const a of ARCHETYPES) {
        const r = await ladder.verify(archetypeSpec(a), signal);
        check(`CG5 ${a.id} (expert setting) passes the ladder`, r.ok, r.ok ? r.report.rungs.map(x => `${x.rung} ${x.ms.toFixed(1)}`) : { failure: r.failure.message, rungs: r.report.rungs });
        expert[a.id] = r.ok ? { rungs: r.report.rungs, probe: r.report.probe } : r.failure.message;
        if (r.ok) r.world.destroy();
    }
    results.expert = expert;

    await device.queue.onSubmittedWorkDone();
    check('no uncaptured WebGPU error', uncaptured.length === 0, uncaptured);
    engine.destroy();
    return { adapter: { vendor, architecture, description }, probeSettings: PROBE, ...results };
}

const out = window as unknown as { __CG__?: unknown };
try {
    log(navigator.userAgent);
    const result = await main();
    out.__CG__ = { ok: checks.every(c => c.ok), checks, ...result, browser: navigator.userAgent };
    log('done');
} catch (e) {
    out.__CG__ = { ok: false, checks, error: String((e as Error)?.stack ?? e), browser: navigator.userAgent };
    log(`failed: ${(e as Error)?.message ?? e}`, 'error');
}
