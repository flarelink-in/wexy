// EA-D6, EA-D15 and EA-D9b, headless (EA5.3; executor-design.md §9, §10, where these were EA-X6, X15 and X9): the
// fraction probe over the live candidates, its variants built by the executor's own allowlist on fake headless ports
// whose submissions advance a clock by a cost model, so what the probe predicts can be held to what the full world costs
// under the same model; and the sanity look. No GPU.
//   EA-D6  every prediction at least the full world's cost (the two-point fit alone would under-predict a padded
//          dispatch); a submission predicted over its kind's cap (init and the first frame 1,000 ms, a frame 500, a
//          fixed step 250; 2026-11-04) refuses before anything runs at full size; a steady
//          frame over 33 ms, and over 100 ms, admits with its warning (Q90); the projection's changed constants recorded;
//          every variant released and every headless engine destroyed
//   EA-D15 an empty fixedStep costs 0 ms with nothing extrapolated (block-film, foggy-dusk); a sub-millisecond pair is
//          bounded by floor scaling, never refused for its jitter; above the floor, a falling or non-finite pair is
//          inconclusive and, measured again and still so, refused; a NaN in typed state is found where it is; a dark
//          frame refuses only a world whose profile declares it visible, and a world with no profile is untested
//   EA-D9b a first run that alone is near the cap is never repeated: no warm-up, no second variant, all released
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVariant } from '../src/exec/engine-executor.ts';
import { WORLD_PROBE, batchRuns, median, predictFirstFrame, predictFrame, predictPair, probeCandidate, project, sanityLook } from '../src/exec/probe.ts';
import { clock, costs, fakeHeadless, fakePort, node, sealed, sealedLive } from './exec-fakes.mjs';

const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const TARGET = { width: 1280, height: 720 };

function probeDeps(model, { target = TARGET, shared = false, options = {} } = {}) {
    const time = clock();
    const { headless, made } = fakeHeadless(time, model, options);
    return { deps: { headless, now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target, shared }, made, time };
}

/** What the full world costs under `model` at `target`: its init, a fixed step and a frame, on a fake port of its own. */
async function fullCosts(snap, model, target = TARGET) {
    const time = clock();
    const port = fakePort({ clock: time, cost: model });
    port.width = target.width;
    port.height = target.height;
    const v = await buildVariant(snap, port, new AbortController().signal);
    const timed = work => { const t0 = time.t; work(); return time.t - t0; };
    const init = timed(() => v.world.runInit());
    const step = timed(() => v.world.runtime.step());
    v.world.runtime.resize(target.width, target.height);
    const frame = timed(() => { v.world.runtime.view(VIEW, 0); port.render(v.world.runtime.draw()); });
    assert.deepEqual(v.release(), []);
    return { init, step, frame };
}

const released = made => {
    assert.equal(made.length, 2, 'one headless engine a variant');
    for (const h of made) {
        assert.equal(h.destroyed, true, 'every headless engine destroyed');
        assert.deepEqual([...h.port.live.values()], [], 'every variant handle freed');
        assert.deepEqual(h.port.errors, [], 'none freed twice');
    }
};

test('EA-D6 the probe over-predicts the full world, refuses over the cap before full work, and admits slow worlds with their warnings', async () => {
    const snap = await sealedLive('galaxy');
    // Within the timer's floor, and above it: the prediction is never below what the full world costs.
    for (const perInvocation of [2e-4, 2e-3]) {
        const model = costs({ fixed: 0.05, perInvocation, perPixel: 2e-7, perInstance: 1e-5 });
        const { deps, made } = probeDeps(model);
        const out = await probeCandidate(snap, deps);
        assert.equal(out.ok, true, out.reason);
        const truth = await fullCosts(snap, model);
        const p = out.probe;
        assert.ok(p.initMs >= truth.init, `init ${p.initMs} ≥ ${truth.init}`);
        assert.ok(p.computeMsPerFrame >= truth.step, `step ${p.computeMsPerFrame} ≥ ${truth.step}`);
        assert.ok(p.drawMsPerFrame >= truth.frame, `frame ${p.drawMsPerFrame} ≥ ${truth.frame}`);
        assert.ok(p.initMs <= 12 * truth.init && p.computeMsPerFrame <= 12 * truth.step, 'and not absurdly over');
        assert.equal(p.maxSubmissionMs, Math.max(p.initMs, p.computeMsPerFrame, p.drawMsPerFrame, p.firstFrameMs));
        assert.ok(p.firstFrameMs >= p.drawMsPerFrame, 'a first frame is never predicted below a frame');
        assert.equal(p.steadyFrameMs, p.computeMsPerFrame + p.drawMsPerFrame);
        assert.equal(p.catchUpMs, 4 * p.computeMsPerFrame + p.drawMsPerFrame, 'reported, not judged: each step is its own submission');
        assert.equal(p.phases.init.rule, perInvocation === 2e-4 ? 'floor' : 'fit');
        assert.deepEqual(p.projection.map(q => q.fraction), [8, 4]);
        assert.ok(p.projection[0].changed.includes('galaxyInit.EA_INVOCATIONS 12000 → 1500') && p.projection[1].changed.includes('galaxySpin.EA_INVOCATIONS 12000 → 3000'),
            `the changed host constants are recorded: ${JSON.stringify(p.projection)}`);
        assert.deepEqual(p.caps, { init: 1000, step: 250, frame: 500, firstFrame: 1000 });
        assert.deepEqual(p.warnings, []);
        released(made);
    }
    // The two-point fit alone under-predicts a dispatch padded to whole workgroups; the direct-scaling floor does not.
    const m8 = 0.05 + 1536 * 2e-3;
    const m4 = 0.05 + 3008 * 2e-3;
    const slope = (m4 - m8) / (1 / 8);
    assert.ok(Math.max(0, m8 - slope / 8) + slope < 0.05 + 12032 * 2e-3, 'the fit alone: under');
    assert.ok(predictPair(m8, m4).ms >= 0.05 + 12032 * 2e-3, 'with the floor: over');

    // Each kind by its own cap (2026-11-04). The init that h1's 250 ms refused is within init's 1,000 ms, and the fixed
    // step as heavy is over the step's 250 ms: refused there, with the numbers; nothing ran at full size here (the stage's
    // preparation never reaches runInit: stage.test.mjs).
    const heavy = probeDeps(costs({ fixed: 0.05, perInvocation: 0.02 }));
    const refused = await probeCandidate(snap, heavy.deps);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'EA_PROBE one fixed step: 307.7 ms predicted, over the 250 ms cap');
    assert.ok(refused.probe.initMs > 250 && refused.probe.initMs <= 1000, `init within its cap: ${refused.probe.initMs}`);
    assert.ok(refused.probe.phases.step.measured.length === 2 && refused.probe.phases.frame === undefined, 'refused before a frame was timed');
    released(heavy.made);
    // Over init's own cap: refused at init, its first phase.
    const heavier = probeDeps(costs({ fixed: 0.05, perInvocation: 0.07 }));
    const atInit = await probeCandidate(snap, heavier.deps);
    assert.equal(atInit.ok, false);
    assert.match(atInit.reason, /^EA_PROBE init: \d+\.\d ms predicted, over the 1000 ms cap$/);
    assert.ok(atInit.probe.phases.init.measured.length === 2 && atInit.probe.phases.step === undefined, 'refused before a step was timed');
    released(heavier.made);

    // A steady frame over 33 ms, and over 100 ms: admitted, each with its warning.
    for (const [perPixel, words] of [[2.2e-5, /^EA_SLOW \d+\.\d ms a steady frame here, over the 33 ms target$/], [7e-5, /^EA_SLOW \d+\.\d ms a steady frame here, over the 33 ms target \(over 100 ms: below 10 fps\)$/]]) {
        const slow = probeDeps(costs({ fixed: 0.05, perInvocation: 1e-5, perPixel, perInstance: 1e-4 }), { shared: true });
        const out = await probeCandidate(snap, slow.deps);
        assert.equal(out.ok, true, out.reason);
        assert.match(out.probe.warnings[0], words);
        assert.ok(out.probe.drawMsPerFrame < WORLD_PROBE.caps.frame, 'slow, but under the cap');
        assert.equal(out.probe.contaminated, true);
        assert.match(out.probe.warnings[1], /the Head shared the queue/, 'the shared queue said, never subtracted');
        released(slow.made);
    }
});

test('EA-D15 empty phases, the timer\'s floor, inconclusive pairs, NaN in typed state, and dark frames judged only by a profile', async () => {
    // An empty fixedStep: 0 ms, nothing extrapolated.
    for (const name of ['block-film', 'foggy-dusk']) {
        const snap = await sealedLive(name);
        assert.deepEqual(snap.x.schedule.fixedStep.filter(id => snap.x.operations.find(o => o.id === id).kind === 'compute'), [], `${name} has no fixed-step work`);
        const { deps, made } = probeDeps(costs({ fixed: 0.05, perInvocation: 1e-4, perPixel: 1e-7 }));
        const out = await probeCandidate(snap, deps);
        assert.equal(out.ok, true, `${name}: ${out.reason}`);
        assert.deepEqual(out.probe.phases.step, { first: [], measured: [], ms: 0, rule: 'empty' });
        assert.equal(out.probe.computeMsPerFrame, 0);
        released(made);
    }

    // The device's floor (EA-G1): twice an empty submission's fence latency, where that is more than the timer's. A falling
    // pair within it is noise on this device, bounded by floor scaling; above it, a fall within noise (two grains, half the
    // floor and a tenth: 2026-11-04, as a frame's) is judged by direct scaling, and one past it is inconclusive.
    assert.deepEqual(predictPair(2.9, 2.78, 5.4), { ms: 2.9 * 8 * WORLD_PROBE.margin, rule: 'floor' }, 'foggy-dusk\'s init on the AMD iGPU (EA-G1, 11-01)');
    assert.deepEqual(predictPair(2.9, 2.78), { ms: 2.9 * 8 * WORLD_PROBE.margin, rule: 'fit' }, 'the same pair above the timer\'s floor alone: within noise');
    assert.deepEqual(predictPair(7, 6, 5.4), { ms: 7 * 8 * WORLD_PROBE.margin, rule: 'fit' });
    // EA-G1 on the GTX 1650 (11-04): two clean coverage worlds refused on these, now judged.
    assert.deepEqual(predictPair(2.95, 2.70), { ms: 2.95 * 8 * WORLD_PROBE.margin, rule: 'fit' }, 'cov-scale-xl\'s init');
    assert.deepEqual(predictPair(3.45, 2.75, 1.2), { ms: 3.45 * 8 * WORLD_PROBE.margin, rule: 'fit' }, 'cov-shapes\'s init');
    // Past noise, still inconclusive; and a pair that rises keeps its fit.
    assert.match(predictPair(3.45, 2.2, 1.2).inconclusive, /below 1\/8's 3\.450 ms, above the floor of 1\.200 ms/);
    assert.equal(predictPair(2, 3).rule, 'fit');
    assert.equal(median([1, 9, 2]), 2, 'a spike moves the median not at all');
    assert.equal(median([1, 2, 3, 4]), 2.5);

    // The floor band: a falling sub-millisecond pair is bounded, not refused.
    assert.deepEqual(predictPair(0.3, 0.2), { ms: 3, rule: 'floor' });
    assert.deepEqual(predictPair(0, 0), { ms: 8 * WORLD_PROBE.timerGrainMs * WORLD_PROBE.margin, rule: 'floor' }, 'never below a grain\'s worth');
    assert.match(predictPair(5, 3).inconclusive, /below 1\/8's/, 'above the floor, falling: inconclusive');
    assert.ok('inconclusive' in predictPair(Number.NaN, 1) && 'inconclusive' in predictPair(-1, 2) && 'inconclusive' in predictPair(1, Infinity), 'non-finite or negative');
    assert.equal(predictFrame({ small: 0.3, large: 0.5 }, { small: 0.2, large: 0.4 }, 921_600).rule, 'floor');
    assert.ok('inconclusive' in predictFrame({ small: 2, large: 6 }, { small: 1, large: 6 }, 921_600), 'twice the work, cheaper, above the floor');
    assert.ok('inconclusive' in predictFrame({ small: 6, large: 2 }, { small: 7, large: 3 }, 921_600), 'four times the pixels, cheaper, above the floor');

    // A noisy device: the 1/4 variant measures cheaper than the 1/8, above the floor, every time.
    const snap = await sealedLive('galaxy');
    const time = clock();
    let ports = [];
    const { headless, made } = fakeHeadless(time, (seq, port) => (port === ports[1] ? 2 : 5));
    const deps = { headless: async (w, h) => { const hp = await headless(w, h); ports = made.map(m => m.port); return hp; }, now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target: TARGET, shared: false };
    const noisy = await probeCandidate(snap, deps);
    assert.equal(noisy.ok, false);
    assert.match(noisy.reason, /^EA_PROBE_UNVERIFIED init: 1\/4 measured 2\.000 ms, below 1\/8's 5\.000 ms, above the floor of 1\.000 ms; no full-size work submitted$/);
    assert.equal(made[0].port.renders, 1 + (1 + WORLD_PROBE.retries) * (WORLD_PROBE.warm + WORLD_PROBE.runs), 'measured again, within the variants only, then refused');
    released(made);

    // NaN in typed state, found where it is.
    const port = fakePort({ state: (label, bytes) => { const f = new Float32Array(bytes / 4); if (label.startsWith('galaxy#create')) f[7] = Number.NaN; return f.buffer; } });
    const v = await buildVariant(snap, port, new AbortController().signal);
    const nan = await sanityLook(v.world.runtime, port, snap.x, new Uint8Array(16).fill(200));
    assert.deepEqual(v.world.runtime.stateBuffers().map(s => [s.resource, s.elements, s.strideFloats]), [['backdrop#storage', 1, 4], ['stars#buffer', 12000, 14]],
        'each storage buffer of instances or floats: the stars (the batch\'s adopted storage) and the backdrop\'s');
    assert.equal(nan.ok, false);
    assert.equal(nan.reason, `EA_SANITY NaN at stars#buffer[7]: 1 of ${4 + 1024 * 14} sampled floats are not finite`);
    // A dark frame: refused only where the world's profile declares it visible.
    const clean = fakePort();
    const w = await buildVariant(snap, clean, new AbortController().signal);
    const black = new Uint8Array(64);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const dark = await sanityLook(w.world.runtime, clean, snap.x, black);
    assert.equal(dark.ok, false);
    assert.equal(dark.reason, 'EA_SANITY black: the brightest pixel is 0.0 of 255; galaxy declares at least 2.0');
    const lit = await sanityLook(w.world.runtime, clean, snap.x, new Uint8Array(64).fill(40));
    assert.equal(lit.ok, true);
    assert.equal(lit.numbers.visibility, 'passed');
    assert.equal(lit.numbers.profile, 'galaxy');
    const unprofiled = await sanityLook(w.world.runtime, clean, snap.x, black, []);
    assert.equal(unprofiled.ok, true, 'a world with no profile is not refused for being dark');
    assert.equal(unprofiled.numbers.visibility, 'untested', 'and is reported untested, never passed');
    assert.deepEqual(v.release(), []);
    assert.deepEqual(w.release(), []);
});

test('the EA5.3 review (H1): every probe submission is checked for errors; one that raises refuses, its timing never used; an engine that cannot check refuses', async () => {
    const snap = await sealedLive('galaxy');
    // An error at the very first checked submission (the empty one that measures the device's floor): refused there. The
    // build's own bindings, checked since 11-02, pass here.
    const submissions = message => port => (/^apply(Material|Lights) /.test(port.log.at(-1) ?? '') ? null : message);
    const first = probeDeps(costs(), { options: { checkpointError: submissions('a validation error') } });
    let out = await probeCandidate(snap, first.deps);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED the fence on the 1/8 variant raised an error: a validation error; no full-size work submitted');
    assert.equal(out.probe.phases, undefined, 'nothing measured');
    assert.equal(first.made[0].port.renders, 0);
    released(first.made);
    // 11-02 (the castle): a binding the device refuses while a variant builds is said there, in the device's own words,
    // and nothing is submitted; the half-built variant and its engine are released.
    const atBinding = probeDeps(costs(), { options: { checkpointError: port => (port.log.at(-1)?.startsWith('applyMaterial galaxy#create') ? 'a validation error: the layout has no binding 2' : null) } });
    out = await probeCandidate(snap, atBinding.deps);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED the 1/8 variant did not build: EA_CALL galaxy#create: binding its material failed: a validation error: the layout has no binding 2; no full-size work submitted');
    assert.equal(atBinding.made.length, 1, 'the second variant never built');
    assert.ok(atBinding.made[0].destroyed && atBinding.made[0].port.live.size === 0 && atBinding.made[0].port.renders === 0, 'nothing submitted, everything released');
    // An error at init's first run: refused there, its timing never used.
    const atInit = probeDeps(costs(), { options: { checkpointError: port => (port.log.at(-1)?.startsWith('render [seed#create]') ? 'a validation error' : null) } });
    out = await probeCandidate(snap, atInit.deps);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED init on the 1/8 variant raised an error: a validation error; no full-size work submitted');
    assert.equal(out.probe.phases, undefined, 'its timing never used');
    assert.equal(atInit.made[0].port.renders, 1);
    released(atInit.made);
    // An error only once a fixed step runs: init measured clean, and the step's error refuses all the same.
    const atStep = probeDeps(costs(), { options: { checkpointError: port => (port.log.at(-1)?.startsWith('render [spin#create]') ? 'an out-of-memory error' : null) } });
    out = await probeCandidate(snap, atStep.deps);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED one fixed step on the 1/8 variant raised an error: an out-of-memory error; no full-size work submitted');
    assert.equal(out.probe.phases.init.measured.length, 2, 'init was measured');
    assert.equal(out.probe.phases.step, undefined, 'the step\'s timing never used');
    released(atStep.made);
    // And an error in a frame's batch, after its first run passed.
    let frames = 0;
    const atFrame = probeDeps(costs(), { options: { checkpointError: port => (port.log.at(-1)?.startsWith('render [main') && ++frames === 3 ? 'a validation error in a pass' : null) } });
    out = await probeCandidate(snap, atFrame.deps);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED one frame on the 1/8 variant raised an error: a validation error in a pass; no full-size work submitted');
    released(atFrame.made);
    // An engine that cannot check its submissions, or fence them, proves nothing.
    for (const missing of ['checkpoint', 'settle']) {
        const unchecked = probeDeps(costs());
        const make = unchecked.deps.headless;
        unchecked.deps.headless = async (w, h) => { const made = await make(w, h); delete made.port[missing]; return made; };
        out = await probeCandidate(snap, unchecked.deps);
        assert.equal(out.reason, 'EA_PROBE_UNVERIFIED this engine cannot check the probe\'s submissions for errors, or fence them; no full-size work submitted', missing);
        assert.ok(unchecked.made.length === 1 && unchecked.made[0].destroyed, `${missing}: its engine destroyed, no second built`);
    }
});

test('EA-G1\'s calibration: the floor is a real submission\'s fence latency, so tiny work timed as latency is bounded, not refused; medians drop a spike', async () => {
    const snap = await sealedLive('foggy-dusk');
    // Every submission's fence costs 2.7 ms, as a trivial one did on the AMD iGPU; a 1/4 variant measures a hair under
    // the 1/8 (the jitter EA-G1 saw). Judged by the timer's floor alone, that is inconclusive; by the device's, bounded.
    const time = clock();
    let ports = [];
    const { headless, made } = fakeHeadless(time, (seq, port) => (port === ports[1] ? 0.05 : 0.15));
    const deps = {
        headless: async (w, h) => {
            const hp = await headless(w, h);
            ports = made.map(m => m.port);
            const settle = hp.port.settle;
            hp.port.settle = async () => { await settle(); time.t += 2.7; };
            return hp;
        },
        now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target: TARGET, shared: false,
    };
    const out = await probeCandidate(snap, deps);
    assert.equal(out.ok, true, out.reason);
    assert.ok(Math.abs(out.probe.floorMs - 5.4) < 1e-9, 'twice the 4-byte clear\'s fence latency');
    assert.equal(out.probe.phases.init.rule, 'floor', 'within the device\'s floor: bounded by floor scaling');
    assert.ok(out.probe.initMs >= 8 * 2.7 * WORLD_PROBE.margin, 'and never below eight times what it measured');
    assert.ok(made[0].port.log.includes('createBuffer wexy/probe floor 4') && made[0].port.log.includes('clearBuffer wexy/probe floor'), 'a real submission, not an empty one');
    // The probe's frames (EA-G1's calibration): each variant's engine made at 640×360, its frames timed there and at 1280×720.
    assert.ok(made.every(m => m.created[0] === 640 && m.created[1] === 360), JSON.stringify(made.map(m => m.created)));
    assert.ok(made.every(m => m.port.log.includes('postResize 1280x720') && m.port.log.includes('postResize 640x360')), 'and resized to the larger frame and back');
    released(made);
    // A spike in one of three batches moves nothing.
    assert.equal(median([1.2, 9.7, 1.3]), 1.3);

    // The pixel floor, from the GTX 1650's own numbers (dev/out/ea-g1, 11-01): block-film ×4's four probe frames, and the
    // 3.383 ms its frame took at 2048×1152. The fit alone predicted 2.889 ms, under it; with the floor, over it.
    const ran = 3.383;
    const pixels = 2048 * 1152;
    const a = { small: 1.233, large: 1.583 };
    const b = { small: 1.2, large: 1.567 };
    const predicted = predictFrame(a, b, pixels);
    assert.ok(predicted.ms >= ran, `${predicted.ms} ms predicted, ${ran} ms ran`);
    assert.ok(predicted.ms <= 2 * ran, 'and not a multiple of it');
    const L = WORLD_PROBE.large.width * WORLD_PROBE.large.height;
    const share = WORLD_PROBE.timerFloorMs / WORLD_PROBE.frameRuns;
    assert.equal(predicted.ms, (a.large + 7 * (0 + share)) * (pixels / L) * WORLD_PROBE.margin,
        'the full-work frame at 1280×720, a frame\'s share of the floor hidden in each step of work, in proportion to the pixels, with the margin');
    // foggy-dusk ×16 on the same GPU: 22.15 ms ran.
    assert.ok(predictFrame({ small: 1.1, large: 2.833 }, { small: 1.433, large: 3.9 }, pixels).ms >= 22.15);
    // foggy-dusk ×1 on the AMD iGPU, whose 1/4 timed under its 1/8 (a floor of 7 ms): 9.667 ms ran. The pixel floor alone
    // gave 8.27 ms; with the share of the floor its work may hide, over it.
    assert.ok(predictFrame({ small: 1.067, large: 2.583 }, { small: 1.033, large: 2.483 }, pixels, 7).ms >= 9.667);
});

test('the EA5.4 review (High): the first full-size frame runs cold, and is predicted and judged by the cap: never below what a cold first frame costs', async () => {
    const snap = await sealedLive('galaxy');
    // A device where a first draw costs 3 ms a pipeline and a first touch 2 ns a pixel (the AMD iGPU's order).
    const model = costs({ fixed: 0.05, perInvocation: 1e-4, perPixel: 2e-7, perInstance: 1e-5, coldMs: 3, touchPerPixel: 2e-6 });
    const { deps, made } = probeDeps(model, { target: { width: 2048, height: 1152 } });
    const out = await probeCandidate(snap, deps);
    assert.equal(out.ok, true, out.reason);
    // What the full world's own first frame costs, cold, at the target, on a port of its own.
    const time = clock();
    const port = fakePort({ clock: time, cost: model });
    port.width = 2048;
    port.height = 1152;
    const v = await buildVariant(snap, port, new AbortController().signal);
    v.world.runInit();
    v.world.runtime.resize(2048, 1152);
    const t0 = time.t;
    v.world.runtime.view(VIEW, 0);
    port.render(v.world.runtime.draw());
    const coldFirstFrame = time.t - t0;
    assert.deepEqual(v.release(), []);
    assert.ok(out.probe.firstFrameMs >= coldFirstFrame, `${out.probe.firstFrameMs} ms predicted, ${coldFirstFrame} ms a cold first frame costs`);
    assert.ok(out.probe.firstFrameMs > out.probe.drawMsPerFrame, 'above the steady frame, by what a first frame adds');
    assert.ok(made.every(m => m.port.log.includes('postResize 1280x720')), 'each variant\'s targets made again at the larger frame, and its first frame timed');
    released(made);

    // The GTX 1650's block-film ×1 (dev/out/ea-g1, 11-01): a 5.64 ms frame predicted, its variants' first frames 7.2 and
    // 3.1 ms against steady 0.74 and 0.77 ms; its cold first frame ran 11.7 ms. Predicted now: at least that.
    assert.ok(predictFirstFrame(5.64, [7.2, 3.1], { small: 0.74, large: 1.0, touched: 1.0 }, { small: 0.77, large: 1.08, touched: 1.08 }, 2048 * 1152) >= 11.7);
    assert.ok(out.probe.maxSubmissionMs >= out.probe.firstFrameMs, 'the cap\'s submission is the first frame when it is the largest');

    // The model exactly: the steady frame, plus, with the margin, the coldest variant's first-frame extra and the first
    // touch at the target: its fixed part, and what grows with pixels at the rate it rose from the smaller frame to the larger.
    const S = WORLD_PROBE.small.width * WORLD_PROBE.small.height;
    const L = WORLD_PROBE.large.width * WORLD_PROBE.large.height;
    const P = 2048 * 1152;
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    const { margin } = WORLD_PROBE;
    // A fixed touch: the same extra at both frames, so nothing more at the target (EA-G1's GPUs, mostly).
    assert.ok(near(predictFirstFrame(10, [5, 4], { small: 1, large: 2, touched: 3, touchedSmall: 2 }, { small: 1, large: 2, touched: 2.5, touchedSmall: 1.5 }, P), 10 + (4 + 1) * margin));
    // A touch that grows with pixels: carried on to the target at the rate it rose.
    assert.ok(near(predictFirstFrame(10, [5, 4], { small: 1, large: 2, touched: 3, touchedSmall: 1.25 }, { small: 1, large: 2, touched: 2, touchedSmall: 1 }, P), 10 + (4 + 1 + 0.75 * (P - L) / (L - S)) * margin));
    // Either variant's extras count: the same with the variants swapped.
    const va = { small: 1, large: 2, touched: 3, touchedSmall: 1.25 };
    const vb = { small: 1, large: 2, touched: 2, touchedSmall: 1 };
    assert.ok(near(predictFirstFrame(10, [4, 5], vb, va, P), predictFirstFrame(10, [5, 4], va, vb, P)));
    // A larger extra at the smaller frame: never below it.
    assert.ok(near(predictFirstFrame(10, [5, 4], { small: 1, large: 2, touched: 2.5, touchedSmall: 3 }, { small: 1, large: 2, touched: 2, touchedSmall: 1 }, P), 10 + (4 + 2) * margin));
    // No touch timed: no touch term. Nothing cold and nothing touched: the steady frame.
    assert.ok(near(predictFirstFrame(10, [5, 4], { small: 1, large: 2 }, { small: 1, large: 2 }, P), 10 + 4 * margin));
    assert.equal(predictFirstFrame(10, [0.5, 0.5], { small: 1, large: 2, touched: 1, touchedSmall: 0.5 }, { small: 1, large: 2, touched: 1, touchedSmall: 0.5 }, P), 10);
    // The report keeps each variant's touched frames, at the smaller frame and the larger.
    assert.equal(out.probe.phases.frame.touched.length, 4);
    assert.ok(out.probe.phases.frame.touched.every(t => t > 0));

    // A first touch heavy enough that the first frame alone passes its 1,000 ms cap, while the steady frame stays under
    // the frame's 500 ms, and each variant's touched frame under it too: refused at the first frame.
    const heavy = probeDeps(costs({ fixed: 0.05, perInvocation: 1e-5, perPixel: 2e-7, touchPerPixel: 4e-4 }), { target: { width: 2048, height: 1152 } });
    const refused = await probeCandidate(snap, heavy.deps);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /^EA_PROBE the first frame: \d+\.\d ms predicted, over the 1000 ms cap$/);
    assert.ok(refused.probe.drawMsPerFrame < WORLD_PROBE.caps.frame, 'its steady frame under the cap');
    released(heavy.made);
});

test('EA-E (11-01): every timing runs in a quiet window, so the Head drawing on the same queue never lands in the numbers', async () => {
    const snap = await sealedLive('galaxy');
    const model = costs({ fixed: 0.05, perInvocation: 1e-4, perPixel: 2e-7, perInstance: 1e-5 });
    const alone = await probeCandidate(snap, probeDeps(model, { shared: true }).deps);
    assert.equal(alone.ok, true, alone.reason);
    /** The probe with a Head: whenever it may draw, it has queued a 13 ms frame ahead of the probe's next submission. */
    const withHead = async (quietly, m = model, options = {}) => {
        const { deps, made, time } = probeDeps(m, { shared: true, options });
        const head = { holds: 0, most: 0, taken: 0, released: 0, queued: 0 };
        const make = deps.headless;
        deps.headless = async (w, h) => {
            const hp = await make(w, h);
            const settle = hp.port.settle;
            hp.port.settle = async () => {
                if (head.holds === 0) head.queued++;
                time.t += head.queued * 13;
                head.queued = 0;
                await settle();
            };
            return hp;
        };
        if (quietly) {
            deps.quiet = () => {
                if (head.holds === 0) head.queued++;
                head.holds++;
                head.taken++;
                head.most = Math.max(head.most, head.holds);
                let done = false;
                return () => {
                    if (done) return;
                    done = true;
                    head.holds--;
                    head.released++;
                };
            };
        }
        return { out: await probeCandidate(snap, deps), head, made };
    };
    const quiet = await withHead(true);
    assert.equal(quiet.out.ok, true, quiet.out.reason);
    for (const k of ['floorMs', 'initMs', 'computeMsPerFrame', 'drawMsPerFrame', 'firstFrameMs']) assert.ok(Math.abs(quiet.out.probe[k] - alone.probe[k]) < 1e-6, `${k}: the Head's frames never in it`);
    assert.equal(quiet.out.probe.contaminated, false, 'no timing shared the queue with the Head');
    assert.ok(!quiet.out.probe.warnings.some(w => /shared the queue/.test(w)), 'and none is said');
    assert.ok(quiet.head.taken > 20 && quiet.head.released === quiet.head.taken && quiet.head.holds === 0, JSON.stringify(quiet.head));
    assert.equal(quiet.head.most, 1, 'one window at a time');
    released(quiet.made);
    // Without the window, the Head's frames land in every timing, and the probe says so.
    const loud = await withHead(false);
    assert.ok(loud.out.probe.floorMs > alone.probe.floorMs && loud.out.probe.drawMsPerFrame > alone.probe.drawMsPerFrame);
    assert.equal(loud.out.probe.contaminated, true);
    assert.ok(loud.out.probe.warnings.some(w => /shared the queue/.test(w)));
    released(loud.made);
    // A timing that throws (an error in its submission) releases its window too.
    const refused = await withHead(true, model, { checkpointError: port => (port.log.at(-1)?.startsWith('render [seed#create]') ? 'a validation error' : null) });
    assert.match(refused.out.reason, /^EA_PROBE_UNVERIFIED init on the 1\/8 variant raised an error/);
    assert.ok(refused.head.taken > 0 && refused.head.holds === 0 && refused.head.released === refused.head.taken, JSON.stringify(refused.head));
    released(refused.made);
});

test('EA-D9b a first run near the cap is never repeated: no warm-up, no second variant run, everything released', async () => {
    const snap = await sealedLive('galaxy');
    // Near init's own cap (1,000 ms since 2026-11-04): its 1/8 variant alone about 920 ms.
    const heavy = probeDeps(costs({ fixed: 0.05, perInvocation: 0.6 }));
    const out = await probeCandidate(snap, heavy.deps);
    assert.equal(out.ok, false);
    assert.match(out.reason, /^EA_PROBE init: its 1\/8 variant alone took 9\d\d\.\d ms, near the 1000 ms cap; nothing repeated it$/);
    assert.equal(heavy.made[0].port.renders, 1, 'the 1/8 variant ran once');
    assert.equal(heavy.made[1].port.renders, 0, 'the 1/4 variant never ran');
    released(heavy.made);
});

test('the EA5.4 review\'s over-budget run: a variant\'s first frame at the larger frame near the cap is never repeated there', async () => {
    const snap = await sealedLive('galaxy');
    // Pixel-bound: a variant's first frame (three passes at 640×360) about 173 ms, within the first runs' rule; the 1/8
    // variant's first at 1280×720 (two passes) about 460 ms, which with the margin is past the frame's 500 ms cap, so it
    // is the last.
    const heavy = probeDeps(costs({ fixed: 0.05, perInvocation: 1e-6, perPixel: 2.5e-4 }));
    const out = await probeCandidate(snap, heavy.deps);
    assert.equal(out.ok, false);
    assert.match(out.reason, /^EA_PROBE one frame: its 1\/8 variant alone took 4\d\d\.\d ms at 1280×720, near the 500 ms cap; nothing repeated it$/);
    const log = heavy.made[0].port.log;
    const after = log.slice(log.lastIndexOf('postResize 1280x720') + 1);
    assert.equal(after.filter(e => e.startsWith('render')).length, 1, 'one frame at the larger frame, then nothing');
    assert.ok(!heavy.made[1].port.log.includes('postResize 1280x720'), 'the 1/4 variant never drew at the larger frame');
    released(heavy.made);
});

test('11-02, after EA-G1\'s over-budget world: each warm-up and timed batch is sized to its work, so none holds much more than the cap, and every prediction still covers the full world', async () => {
    // A batch's bound is the quiet window's 250 ms, kept when the caps rose (2026-11-04).
    const { batchMs: cap, frameRuns, runs, warm, margin } = WORLD_PROBE;
    // The rule: as many runs as fit in the cap at the pace measured; one at least, the calibrated count at most.
    assert.equal(batchRuns(0, 2, frameRuns), frameRuns, 'a warm-up that took no time: the calibrated count');
    assert.equal(batchRuns(2 * 3, 2, frameRuns), frameRuns, 'a 3 ms frame: 83 would fit, 24 run');
    assert.equal(batchRuns(2 * 57, 2, frameRuns), 4, 'the over-budget world\'s 1/8 at 1280×720 on the AMD iGPU (EA-G1, 11-01)');
    assert.equal(batchRuns(2 * 106, 2, frameRuns), 2, 'and its 1/4');
    assert.equal(batchRuns(300, 1, warm), 1, 'one alone past the cap: one, never none');
    assert.equal(batchRuns(2 * 60, 2, runs), 4, 'a step\'s batch the same');
    // The heaviest live variant frame on either GPU (EA-G1, 11-01: foggy-dusk ×16's 1/4 at 1280×720 on the AMD iGPU,
    // 8.24 ms, its warm-up's fence 2.7 ms more) still fills EA-G1's 24: every live world is timed as it was calibrated.
    assert.equal(batchRuns(2 * 8.24 + 2.7, 2, frameRuns), frameRuns);

    // A frame's share of the floor is its own batch's: with 24 everywhere, as before; with fewer, larger.
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    const P = 2048 * 1152;
    const L = WORLD_PROBE.large.width * WORLD_PROBE.large.height;
    const [a, b] = [{ small: 1.233, large: 1.583 }, { small: 1.2, large: 1.567 }];
    const calibrated = { small: frameRuns, large: frameRuns };
    assert.deepEqual(predictFrame({ ...a, runs: calibrated }, { ...b, runs: calibrated }, P, 5.4), predictFrame(a, b, P, 5.4), 'EA-G1\'s 24 is the default');
    // A heavy pixel-bound frame, 150 ms a variant at 1280×720, one frame a batch there for the 1/8, two for the 1/4: each
    // step of work may hide the larger share, the whole floor.
    const heavyA = { small: 40, large: 150, runs: { small: 6, large: 1 } };
    const heavyB = { small: 40, large: 150, runs: { small: 6, large: 2 } };
    assert.ok(near(predictFrame(heavyA, heavyB, L, 5.4).ms, (150 + 7 * 5.4) * margin), String(predictFrame(heavyA, heavyB, L, 5.4).ms));
    assert.ok(near(predictFrame(heavyB, heavyA, L, 5.4).ms, (150 + 7 * 5.4) * margin), 'either variant\'s');
    // The contract: a timing within its own batch's share of the floor is noise there.
    const one = { small: 1, large: 1 };
    assert.equal(predictFrame({ small: 3, large: 3, runs: one }, { small: 3, large: 3, runs: one }, L, 5.4).rule, 'floor');
    assert.equal(predictFrame({ small: 3, large: 3 }, { small: 3, large: 3 }, L, 5.4).rule, 'fit');
    // And a cheaper timing is judged against the share of the one it is compared with: 130 ms in a batch of one may read
    // 2.7 ms high (half the 5.4 ms floor), so 115 ms beside it is within noise; judged by the other's share, it would not be.
    for (const [x, y] of [
        [{ small: 130, large: 140, runs: { small: 1, large: 1 } }, { small: 115, large: 140, runs: { small: 2, large: 1 } }], // twice the work, 640×360
        [{ small: 100, large: 130, runs: { small: 2, large: 1 } }, { small: 100, large: 115, runs: { small: 2, large: 2 } }], // twice the work, 1280×720
        [{ small: 130, large: 115, runs: { small: 1, large: 2 } }, { small: 130, large: 115, runs: { small: 1, large: 2 } }], // four times the pixels
    ]) {
        const p = predictFrame(x, y, L, 5.4);
        assert.ok(!('inconclusive' in p), `${JSON.stringify([x, y])}: ${p.inconclusive}`);
    }

    const snap = await sealedLive('galaxy');
    const target = { width: 2048, height: 1152 };
    /** The probe over `model(sequence, port, made)`, with what the work in each timing's quiet window cost. */
    const windowed = async model => {
        const time = clock();
        const { headless, made } = fakeHeadless(time, (seq, port) => model(seq, port, made));
        const held = [];
        const quiet = () => { const t0 = time.t; return () => held.push(time.t - t0); };
        const out = await probeCandidate(snap, { headless, now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target, shared: true, quiet });
        return { out, made, held };
    };
    // Light work, as every live world's: EA-G1's counts, unchanged.
    const light = await windowed(costs({ fixed: 0.05, perInvocation: 1e-4, perPixel: 2e-7, perInstance: 1e-5 }));
    assert.equal(light.out.ok, true, light.out.reason);
    assert.deepEqual(light.out.probe.phases.frame.runs, [frameRuns, frameRuns, frameRuns, frameRuns]);
    assert.deepEqual(light.out.probe.phases.step.runs, [runs, runs]);
    released(light.made);

    // A pixel-bound frame heavy enough to refuse at 2048×1152 under the frame's 500 ms (2026-11-04): 100 ns a pixel a
    // pass, about 184 ms a frame at 1280×720 for either variant (EA-G1's stacked fog drew 57 and 106 ms on the AMD iGPU;
    // 80 ns, 250 ms's case, now predicts under the cap). The same refusal as before, at the frame's cap.
    const pixelModel = costs({ fixed: 0.05, perInvocation: 1e-5, perPixel: 1e-4 });
    const heavy = await windowed(pixelModel);
    assert.equal(heavy.out.ok, false);
    assert.match(heavy.out.reason, /^EA_PROBE one frame: \d+\.\d ms predicted, over the 500 ms cap$/);
    const f = heavy.out.probe.phases.frame;
    assert.equal(f.runs.length, 4);
    assert.ok(f.runs.every((n, i) => Number.isInteger(n) && n >= 1 && n * f.measured[i] <= cap), `each batch within the cap: ${JSON.stringify({ runs: f.runs, measured: f.measured })}`);
    assert.ok(f.runs[1] === 1 && f.runs[3] === 1, `one frame a batch at 1280×720: ${f.runs}`);
    assert.ok(Math.max(...heavy.held) <= cap, `no quiet window held more than the cap: ${Math.max(...heavy.held).toFixed(1)} ms`);
    assert.ok(f.ms >= (await fullCosts(snap, pixelModel, target)).frame, 'and the prediction still over what the full frame costs');
    for (const [i, m] of heavy.made.entries()) {
        // At the larger frame: the first touch, one warm-up frame (two would pass the cap), three batches of one; EA-G1's
        // 24 drew 75 there, about 11 s at this pace. Back at the smaller: its first touch, then three batches of its count.
        const log = m.port.log;
        const from = log.indexOf('postResize 1280x720');
        const back = log.indexOf('postResize 640x360', from);
        const drawn = (start, end) => log.slice(start, end).filter(e => e.startsWith('render')).length;
        assert.equal(drawn(from, back), 1 + 1 + WORLD_PROBE.batches * 1);
        assert.equal(drawn(back), 1 + WORLD_PROBE.batches * f.runs[2 * i]);
    }
    released(heavy.made);

    // A step heavy enough to refuse: galaxy's spin at 20 µs an invocation, about 31 and 60 ms a step at 1/8 and 1/4. Six
    // to a batch would hold 361 ms for the 1/4; four fit.
    const base = costs({ fixed: 0.05, perInvocation: 1e-5, perPixel: 2e-7 });
    const stepModel = (seq, port) => base(seq, port) + seq.reduce((s, h) => s + (h.kind === 'stage' && h.label.startsWith('spin') ? h.workgroups.reduce((x, y) => x * y, 1) * h.size * 0.02 : 0), 0);
    const stepping = await windowed(stepModel);
    assert.equal(stepping.out.ok, false);
    assert.match(stepping.out.reason, /^EA_PROBE one fixed step: \d+\.\d ms predicted, over the 250 ms cap$/);
    const s = stepping.out.probe.phases.step;
    assert.deepEqual(s.runs, [runs, 4], JSON.stringify(s));
    assert.ok(s.runs.every((n, i) => n * s.measured[i] <= cap));
    assert.ok(Math.max(...stepping.held) <= cap, `no quiet window held more than the cap: ${Math.max(...stepping.held).toFixed(1)} ms`);
    assert.ok(s.ms >= (await fullCosts(snap, stepModel, target)).step, 'and the prediction still over what the full step costs');
    released(stepping.made);

    // A device whose 1/8 variant times slower than its 1/4, as the GTX 1650's stacked fog did in every EA-G1 run (11-01):
    // 140 ms a frame (or a step) for the 1/8, 70 for the 1/4. Each first run passes its rule, but two more of the 1/8's
    // would pass the cap: its warm-up is one, sized by the first run before it. Measured again, then refused, unverified.
    for (const [what, costly] of [['one frame', h => h.kind === 'pass'], ['one fixed step', h => h.kind === 'stage' && h.label.startsWith('spin')]]) {
        const inverted = await windowed((seq, port, made) => (seq.some(costly) ? (port === made[0].port ? 140 : 70) : 0.05));
        assert.equal(inverted.out.ok, false);
        assert.ok(inverted.out.reason.startsWith(`EA_PROBE_UNVERIFIED ${what}: `), inverted.out.reason);
        assert.ok(Math.max(...inverted.held) <= cap, `${what}: no quiet window held more than the cap: ${Math.max(...inverted.held).toFixed(1)} ms`);
        // The 1/8's batches one (140 ms), the 1/4's three: its warm-up's two ran 140 ms, 70 a run.
        const phase = what === 'one frame' ? inverted.out.probe.phases.frame : inverted.out.probe.phases.step;
        assert.deepEqual(phase.runs, what === 'one frame' ? [1, 1, 3, 3] : [1, 3]);
        released(inverted.made);
    }
});

test('the projection: a custom batch\'s instances scale; unknown work and a projection that changes an interface beyond its counts are never tried', async () => {
    const snap = await sealedLive('galaxy');
    const p = await project(snap, 8);
    assert.notEqual(typeof p, 'string', p);
    assert.equal(p.source.bodies, snap.bodies, 'the sealed bodies, byte for byte');
    assert.equal(p.source.x.identity.resolver, snap.x.identity.resolver);
    assert.notEqual(p.source.x.hash, snap.x.hash, 'another X, never claimed to be C\'s');
    const water = await sealed([
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 61 }, [{ port: 'geometry', nodeId: 'cube', output: 'geometry' }]),
    ], {
        water: [
            'fn wave(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, instance: u32) -> VertexOut {',
            '    var out: VertexOut;',
            '    out.clipPos = camera.viewProj * vec4<f32>(position, 1.0);',
            '    out.worldPos = position;',
            '    out.worldNormal = normal;',
            '    out.uv = uv;',
            '    out.ecsColor = vec3f(0.2, 0.4, 0.8) + vec3f(f32(instance) * 0.0);',
            '    return out;',
            '}',
            '',
            'fn shade(input: VertexOut) -> vec4<f32> {',
            '    return vec4<f32>(input.ecsColor, 1.0);',
            '}',
        ].join('\n'),
    });
    // A custom batch is scaled as a mesh batch is (11-02, option B): its instances, rounded up; its module unchanged.
    for (const [fraction, instances] of [[8, 8], [4, 16]]) {
        const v = await project(water, fraction);
        assert.notEqual(typeof v, 'string', v);
        const op = id => v.source.x.operations.find(o => o.id === id);
        assert.deepEqual([op('water#create').args.maxInstances, op('water#draw').work.instances], [instances, instances], `1/${fraction}: 61 instances, rounded up`);
        assert.deepEqual(v.changed, [], 'no host constant moved');
    }
    // Work no table here scales or keeps is never tried, whatever resolves.
    const odd = structuredClone(snap);
    odd.program = [...odd.program, { id: 'odd', adapterId: 'ng.render.odd', adapterVersion: 1, config: '{}', inputs: [] }];
    assert.equal(await project(odd, 8), 'EA_PROBE_UNVERIFIED ng.render.odd (node odd): its work has no projection here; no full-size work submitted');
    const forged = structuredClone(snap);
    forged.program = 'not a program';
    assert.equal(await project(forged, 8), 'EA_PROBE_UNVERIFIED this candidate holds no program to project; no full-size work submitted');
    // Only EA_INVOCATIONS may move: any other constant, or a binding, that differs refuses.
    const stride = structuredClone(snap);
    stride.interfaces.find(i => i.module === 'galaxySpin').constants.find(c => c.name === 'B_stars_STRIDE').value = 16;
    assert.equal(await project(stride, 8), 'EA_PROBE_UNVERIFIED the 1/8 projection changes module galaxySpin\'s constant B_stars_STRIDE, beyond its counts; no full-size work submitted');
    const rebound = structuredClone(snap);
    rebound.interfaces.find(i => i.module === 'galaxySpin').bindings[0].binding = 5;
    assert.equal(await project(rebound, 4), 'EA_PROBE_UNVERIFIED the 1/4 projection changes module galaxySpin\'s bindings, beyond its counts; no full-size work submitted');
    // A variant resolved under another P, H or manifest than C's is not a projection of C.
    const policy = structuredClone(snap);
    policy.x.identity.policyHash = '0'.repeat(64);
    assert.equal(await project(policy, 8), 'EA_PROBE_UNVERIFIED the 1/8 projection resolves under another policyHash than C\'s; no full-size work submitted');

    // A variant that fails half-built releases what it made, and its engine.
    const time = clock();
    const { headless, made } = fakeHeadless(time, costs(), { fail: entry => entry.startsWith('createBatch galaxy#create') });
    const out = await probeCandidate(snap, { headless, now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target: TARGET, shared: false });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'EA_PROBE_UNVERIFIED the 1/8 variant did not build: a device error at createBatch galaxy#create stock:emissive 14x1500 rgba16float; no full-size work submitted');
    assert.equal(made.length, 1, 'the second variant never built');
    assert.ok(made[0].destroyed && made[0].port.live.size === 0 && made[0].port.errors.length === 0, 'what the half-built variant made, released once');
});
