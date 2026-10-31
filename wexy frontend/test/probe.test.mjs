// T-series, headless: the probe's cleanup and order (src/verify/probe.ts; F3 and F4 of the pass-graph design §13,
// the outside review's findings 3 and 5) over a stubbed engine and runtime and a fake clock: no GPU. What is checked
// is what the probe does with its worlds and when: every world destroyed when a step throws, a heavy step refused
// before any warm-up step runs, the warm-up stopped by a cancel, and the frames timed on warmed-up worlds.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'null-graph' || specifier === 'null-graph/film') return { url: `stub:${specifier}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url === 'stub:null-graph') return { format: 'module', shortCircuit: true, source: 'export class NullGraph { constructor() { return globalThis.probeStub.engine(); } }' };
        if (url === 'stub:null-graph/film') return { format: 'module', shortCircuit: true, source: 'export class FrameReadback {}' };
        if (url.endsWith('/src/runtime/scene-runtime.ts')) return { format: 'module', shortCircuit: true, source: 'export const SceneRuntime = { build: (...a) => globalThis.probeStub.build(...a) };' };
        return nextLoad(url, context);
    },
});

const { H1 } = await import('../src/contract/h1/index.ts');
const { parseDraft, specFromDraft } = await import('../src/contract/draft.ts');
const { PROBE, probeWorld } = await import('../src/verify/probe.ts');

// The galaxy with four seconds of warm-up (its plan has none): 240 steps at 1/60.
const GALAXY = specFromDraft(parseDraft(H1.plans.galaxy).draft, { kind: 'functions', ...H1.exemplars.galaxy });
const SPEC = { ...GALAXY, particles: { ...GALAXY.particles, warmupSeconds: 4 } };
const WARMUP = Math.round(SPEC.particles.warmupSeconds / SPEC.particles.dt);

/**
 * Engines and runtimes that record what was done to them, on a clock that only moves when they work: a step costs
 * `stepMs` per particle, a frame `frameMs` per particle. `SceneRuntime.build` is played as the real one: placed
 * (one step) when asked for no warm-up, else reset (one step and the whole warm-up), then one frame.
 */
function stub({ stepMs = 1e-6, frameMs = 1e-6, onStep = () => {} } = {}) {
    let now = 0;
    const s = { engines: [], runtimes: [], steps: 0 };
    s.engine = () => {
        const engine = { destroyed: false, async init() { return { success: true }; }, resize() {}, destroy() { this.destroyed = true; },
            render(seq) { seq.runtime.log.push('f'); now += frameMs * seq.runtime.count; } };
        s.engines.push(engine);
        return engine;
    };
    s.build = async (engine, spec, _w, _h, options) => {
        const count = typeof options === 'number' ? options : options?.count ?? spec.particles.count;
        const runtime = {
            spec, count, log: [], destroyed: false, simTime: 0, frame: 0, restarts: 0,
            get warmupSteps() { return WARMUP; },
            step() { s.steps++; onStep(s); this.log.push('s'); this.frame++; now += stepMs * count; },
            view() {}, resize() {}, draw() { return { runtime }; },
            restartClock() { this.frame = 0; this.simTime = 0; this.restarts++; },
            destroy() { this.destroyed = true; },
        };
        s.runtimes.push(runtime);
        runtime.step();
        if (options?.warmUp !== false) for (let i = 0; i < WARMUP; i++) runtime.step();
        engine.render(runtime.draw());
        return { runtime, smoke: { ok: true, ms: 1 } };
    };
    globalThis.probeStub = s;
    Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
    return s;
}
const DEVICE = { queue: { onSubmittedWorkDone: async () => {} } };
const allDestroyed = s => s.engines.every(e => e.destroyed) && s.runtimes.every(r => r.destroyed);

test('T3 F3: a probe step that throws leaves no probe world alive', async () => {
    // The second world's measurement throws (a rejected onSubmittedWorkDone or a lost device does the same).
    const s = stub({ onStep: st => { if (st.runtimes.length === 2 && st.runtimes[1].log.length >= 4) throw new Error('the step failed'); } });
    await assert.rejects(probeWorld(DEVICE, SPEC, 1280 * 720, new AbortController().signal), /the step failed/);
    assert.equal(s.engines.length, 2);
    assert.ok(allDestroyed(s), `destroyed: engines ${s.engines.map(e => e.destroyed)}, runtimes ${s.runtimes.map(r => r.destroyed)}`);
});

test('T4 F4: a heavy step is refused before the warm-up runs; the warm-up stops on a cancel; frames are timed after it', async () => {
    // 1 µs a particle a step: about a second a step at the galaxy's count, four times the budget.
    const heavy = stub({ stepMs: 1e-3 });
    const refused = await probeWorld(DEVICE, SPEC, 1280 * 720, new AbortController().signal);
    assert.ok(refused.diagnostic, 'refused');
    assert.equal(refused.diagnostic.target, 'evolve');
    assert.match(refused.diagnostic.message, /one step of evolve is predicted to take \d+ ms/);
    assert.ok(heavy.steps < WARMUP, `${heavy.steps} steps ran before the refusal; the warm-up alone is ${WARMUP}`);
    assert.equal(refused.numbers.frameMs, null, 'no frame was timed for a refused step');
    assert.equal(refused.world, null);
    assert.ok(allDestroyed(heavy));

    // A cancel during the warm-up stops it within a batch, and every world goes.
    const ac = new AbortController();
    const cancelled = stub({ onStep: st => { if (st.runtimes.length === 2 && st.runtimes[0].log.filter(e => e === 's').length === 1 + PROBE.warmSteps + PROBE.steps + 5) ac.abort(); } });
    await assert.rejects(probeWorld(DEVICE, SPEC, 1280 * 720, ac.signal), e => e.name === 'AbortError');
    assert.ok(cancelled.steps < 2 * WARMUP, `${cancelled.steps} steps ran after the cancel`);
    assert.ok(allDestroyed(cancelled));

    // A world that passes: the larger kept for the sanity look, the smaller destroyed; each warmed up in full
    // before its frames were timed, and its clock restarted after the warm-up as reset() does.
    const light = stub();
    const passed = await probeWorld(DEVICE, SPEC, 1280 * 720, new AbortController().signal);
    assert.equal(passed.diagnostic, null);
    assert.equal(passed.world.runtime, light.runtimes[1]);
    assert.ok(light.runtimes[0].destroyed && light.engines[0].destroyed && !light.runtimes[1].destroyed && !light.engines[1].destroyed);
    for (const r of light.runtimes) {
        const beforeSecondFrame = r.log.slice(0, r.log.indexOf('f', r.log.indexOf('f') + 1)).filter(e => e === 's').length;
        assert.ok(beforeSecondFrame >= 1 + PROBE.warmSteps + PROBE.steps + WARMUP, `${beforeSecondFrame} steps before the timed frames`);
        assert.equal(r.restarts, 1);
    }
    assert.ok(passed.numbers.frameMs > 0 && passed.numbers.measuredFrameMs > 0);
});
