// EA-F1, headless (EA5.5; executor-design.md §9a, §10): the agent film workload over fake film engines, driven as
// null-graph/film drives a workload (record.ts: built, calibrated by guard.ts's calibrateFilm (a first step and draw,
// then three rounds of a step and a draw), reset, its warm-up steps, then each frame's steps and its draw; a photo:
// built, one draw at frame 0). The probe's variants on fake headless ports, L3's verdicts from the device compiler over
// a fake device, eligibility as EA-G1 writes it. No GPU.
//   - each invocation is admitted and built before it returns: the probe, init at full size and the offscreen first
//     frame all inside createWorkload, so the runner's first submissions find a world the probe approved (I3);
//   - a measurement, a film and a photo each mint an admission of their own on the Head's verdicts, and none spends
//     another's or the stage's go;
//   - reset() after calibration, on the same construction (no second admission); frame 0 at time zero, frame k at k·s
//     fixed steps from it, at 30 and at 60 fps; a photo at time zero;
//   - dispose releases the construction and its reservation, once; the Head's reservation untouched throughout;
//   - refused, with nothing of it left: a world no longer on the stage; another device generation; an install
//     superseded mid-build; a film size past eligibility; a probe over the cap at the film's size; and a cancel, said
//     as the runner's AbortError.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { agentFilmWorkload } from '../src/exec/film-workload.ts';
import { createMemoryLedger, reservationFor } from '../src/exec/gate.ts';
import { createStage } from '../src/exec/stage.ts';
import { DEFAULT_LIMITS, ENV, cleanDevice, clock, compileAll, costs, eligibilityFor, fakeHeadless, fakePort, present, sealedLive } from './exec-fakes.mjs';

const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const LIGHT = costs({ fixed: 0.02, perInvocation: 1e-5, perPixel: 1e-7, perInstance: 1e-5 });
const HEAD_BYTES = 50_000_000;

/** The film's deps over fakes: its engines' ports kept by engine, the probe's variants, a Head in the ledger. */
async function filmFor(name, { model = LIGHT, pixels = 2_400_000, headlessWrap = h => h } = {}) {
    const snap = await sealedLive(name);
    const install = present();
    const time = clock();
    const compiler = createDeviceCompiler(cleanDevice().device, { generation: () => install.d, gpu: 'Fake GPU' });
    const compiled = await compileAll(snap, compiler);
    const { headless, made } = fakeHeadless(time, model);
    const ledger = createMemoryLedger();
    const head = ledger.record('head: the stage\'s world', HEAD_BYTES);
    const ports = new Map();
    const frames = [];
    const quiet = { taken: 0, released: 0 };
    const state = { onStage: snap.id };
    const deps = {
        port: engine => {
            const port = fakePort({ clock: time, cost: model });
            port.width = engine.width;
            port.height = engine.height;
            ports.set(engine, port);
            return port;
        },
        headless: headlessWrap(headless), now: () => time.t,
        quiet: () => { quiet.taken++; return () => { quiet.released++; }; },
        limits: DEFAULT_LIMITS, compiler: () => compiler, environment: ENV, gpu: 'Fake GPU', ledger,
        eligibility: eligibilityFor([snap], { pixels }),
        present: install, onStage: () => state.onStage, compiled,
        onFrames: a => frames.push(a),
    };
    return { snap, install, time, compiler, compiled, made, ledger, head, ports, frames, quiet, state, deps };
}

const frameAt = (j, fps, view = null) => ({ index: j, seconds: j / fps, timestampUs: Math.round(j * 1e6 / fps), durationUs: Math.round(1e6 / fps), view });

/**
 * null-graph/film's recordFilm over `create`, as record.ts drives a workload; the film's port renders what draw returns.
 * `warmupSteps`: steps between the reset and frame 0, as a film with a warm-up has (an agent world's has none).
 */
async function runFilm(f, create, { width, height, fps, seconds, warmupSteps = 0, signal = new AbortController().signal }) {
    const engine = { width, height };
    const workload = await create({ engine, width, height, signal, defer: () => {} });
    const port = f.ports.get(engine);
    const built = port.log.length;
    const held = f.ledger.holders();
    const draw = frame => port.render(workload.draw(frame));
    // calibrateFilm: a first step and draw, then three rounds of a step and a draw, each at frame 0's view.
    await workload.step();
    draw(frameAt(0, fps));
    for (let i = 0; i < 3; i++) {
        await workload.step();
        draw(frameAt(0, fps));
    }
    const reservations = f.ledger.holders().length;
    const creates = port.log.filter(l => l.startsWith('create')).length;
    const resetAt = port.log.length;
    await workload.reset();
    assert.equal(f.ledger.holders().length, reservations, 'reset() reserves nothing more: the same construction, no second admission');
    assert.equal(port.log.filter(l => l.startsWith('create')).length, creates, 'and builds nothing again');
    const stepsPerFrame = Math.round(1 / (fps * workload.dt));
    for (let i = 0; i < warmupSteps; i++) await workload.step();
    for (let j = 0; j < Math.round(seconds * fps); j++) {
        for (let s = 0; s < stepsPerFrame; s++) await workload.step();
        draw(frameAt(j, fps));
    }
    await workload.dispose();
    return { engine, port, built, held, resetAt, workload, stepsPerFrame };
}

/** null-graph/film's snapshot over `create`: built, one draw at frame 0 with `view`, disposed; nothing stepped. */
async function runPhoto(f, create, { width, height, view }) {
    const engine = { width, height };
    const workload = await create({ engine, width, height, signal: new AbortController().signal, defer: () => {} });
    const port = f.ports.get(engine);
    const built = port.log.length;
    port.render(workload.draw(frameAt(0, 60, view)));
    await workload.dispose();
    return { port, built };
}

/** Everything a film's construction made, released: its port, its probe's engines; the ledger holds the Head's alone. */
function released(f, port, what) {
    if (port) {
        assert.deepEqual([...port.live.values()], [], `${what}: every handle the film's construction made is freed`);
        assert.deepEqual(port.errors, [], `${what}: none twice`);
    }
    for (const h of f.made) assert.equal(h.destroyed, true, `${what}: every probe engine destroyed`);
    assert.deepEqual(f.ledger.holders(), [{ label: 'head: the stage\'s world', bytes: HEAD_BYTES }], `${what}: the ledger holds the Head's share alone`);
}

test('EA-F1 the agent film workload: built and probed inside createWorkload, admitted per invocation, reset to time zero, frame k at k·s steps', async () => {
    const f = await filmFor('galaxy');
    const size = { width: 1280, height: 720 };
    const need = reservationFor(f.snap.x, size);
    let during = null;
    const create = agentFilmWorkload(f.snap, { ...f.deps, report: () => { during = f.ledger.holders(); } }, { fps: 30, still: VIEW });

    // A film at 30 fps: two fixed steps a frame (dt 1/60), 2 s.
    const film = await runFilm(f, create, { ...size, fps: 30, seconds: 2 });
    // Before the runner touched it, the whole construction ran: the probe on its variants (each engine made and gone), then
    // the film's engine's first submission, init at full size, then the offscreen first frame and its look; the output back
    // at the screen last. Nothing generated reached the film's engine before the probe approved it.
    const before = film.port.log.slice(0, film.built);
    assert.equal(f.made.length, 2, 'the probe\'s two variants, on engines of their own');
    assert.deepEqual(before.filter(l => l.startsWith('render')), ['render [seed#create]', 'render [main, post/0, post/1]'], 'init at full size, then the first frame');
    assert.ok(before.indexOf('offscreenTarget 1280x720') < before.indexOf('redirect chain -> target 1280x720'), 'the first frame into a private target');
    assert.equal(before.at(-2), 'redirect chain -> screen', 'its output back at the film\'s screen only after its look');
    assert.equal(before.at(-1), 'destroyTarget target 1280x720');
    assert.deepEqual(during.map(h => h.bytes), [HEAD_BYTES, need.total], 'reserved beside the Head while it was prepared: the film\'s candidate, probe and readback');
    assert.deepEqual(film.held.map(h => h.bytes), [HEAD_BYTES, need.candidate], 'then, built, its candidate\'s own share, until it is disposed');
    // Time zero for the film's frames: the calibration's four steps undone, each frame at k·s fixed steps from it.
    assert.deepEqual(f.frames, [{
        candidate: f.snap.id, stepsPerFrame: 2, frames: 60, offTime: 0, firstFrameSteps: 0, last: { index: 59, steps: 118 },
    }]);
    assert.equal(film.workload.dt, 1 / 60);
    assert.deepEqual(film.workload.info, { candidate: f.snap.id, leadInSteps: 2, executorDt: 1 / 60 });
    // The sim uniform written before each fixed step: after the reset, the first frame's two steps were no-ops, and the
    // world's clock ran 0, 1, … again.
    const sims = film.port.log.filter(l => l.startsWith('writeBuffer @host#createSim'));
    const afterReset = sims.slice(4);
    assert.deepEqual(afterReset.slice(0, 3).map(l => l.replace(/.* step=/, '')), ['0', '1', '2'], 'the clock from zero after the reset');
    assert.equal(afterReset.length, 118, 'every frame but the first stepped twice; the first frame\'s two steps were the lead-in');
    released(f, film.port, 'after the film');
    assert.equal(f.quiet.taken, f.quiet.released, 'every quiet window released');
    assert.ok(f.quiet.taken > 20, 'the probe timed in quiet windows');

    // At 60 fps, one step a frame; and the same deps admit again: a measurement's single frame.
    const sixty = agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW });
    const measured = await runFilm(f, sixty, { ...size, fps: 60, seconds: 1 / 60 });
    assert.deepEqual(f.frames[1], { candidate: f.snap.id, stepsPerFrame: 1, frames: 1, offTime: 0, firstFrameSteps: 0, last: { index: 0, steps: 0 } });
    released(f, measured.port, 'after the measurement');

    // A photo: one draw at time zero, nothing stepped, with the view it was given.
    const photo = await runPhoto(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), { ...size, view: { ...VIEW, distance: 20 } });
    assert.ok(!photo.port.log.slice(photo.built).some(l => l.startsWith('writeBuffer @host#createSim')), 'a photo steps nothing: time zero');
    assert.equal(photo.port.log.slice(photo.built).find(l => l.startsWith('updateCamera')), 'updateCamera 20 at 0.000 aspect 1.778', 'the photo\'s view, at time zero');
    assert.equal(f.frames.length, 2, 'a photo is not a film: nothing reset, no frames said');
    released(f, photo.port, 'after the photo');
    assert.equal(f.head.bytes, HEAD_BYTES, 'the Head\'s reservation untouched');

    // A second dispose does nothing.
    await film.workload.dispose();
    released(f, film.port, 'after a second dispose');
    assert.equal(f.frames.length, 2, 'and says nothing again');

    // The account tells a film whose frames drift from time zero: three steps between the reset and frame 0 (a warm-up an
    // agent world's film never has) put every frame three steps late.
    const drifted = await runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 30, still: VIEW }), { ...size, fps: 30, seconds: 0.5, warmupSteps: 3 });
    assert.deepEqual(f.frames[2], { candidate: f.snap.id, stepsPerFrame: 2, frames: 15, offTime: 15, firstFrameSteps: 3, last: { index: 14, steps: 31 } });
    released(f, drifted.port, 'after the drifted film');

    // A tall film: its view fitted to the film's shape (fitAspect widens a 16:9 view), and the probe's first frame drawn from
    // the very view of the film's frame 0.
    const tall = await runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 30, still: VIEW }), { width: 720, height: 1280, fps: 30, seconds: 0.1 });
    const firstFrame = tall.port.log.slice(0, tall.built).find(l => l.startsWith('updateCamera'));
    assert.equal(firstFrame, tall.port.log.slice(tall.resetAt).find(l => l.startsWith('updateCamera')), 'the first frame\'s view is frame 0\'s');
    assert.match(firstFrame, /^updateCamera 14\.96\d* at 0\.000 aspect 0\.563$/, 'fitted to the tall shape: further off than the 12 it was given');
    released(f, tall.port, 'after the tall film');
});

test('EA-F1 per invocation: films mint their own admissions on the Head\'s verdicts, and leave the stage\'s go standing', async () => {
    const f = await filmFor('galaxy');
    // The stage, with the developer's go pressed for this same candidate, not yet spent.
    const time = clock();
    const stage = createStage({
        port: fakePort({ clock: time, cost: LIGHT }), headless: fakeHeadless(time, LIGHT).headless, limits: DEFAULT_LIMITS, compiler: f.deps.compiler,
        present: f.install, environment: ENV, gpu: 'Fake GPU', size: () => ({ width: 1280, height: 720 }), maxPixels: 2_300_000, view: () => VIEW,
        restoreHeadCamera: () => {}, commit: () => {}, now: () => time.t, ledger: f.ledger, eligibility: f.deps.eligibility,
    });
    stage.press(f.snap);
    for (let i = 0; i < 3; i++) {
        const r = await runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), { width: 1280, height: 720, fps: 60, seconds: 0.1 });
        released(f, r.port, `film ${i + 1}`);
    }
    assert.equal(f.frames.length, 3, 'three films, each admitted: none found its admission spent');
    assert.equal(stage.goes.holds(f.snap.id, f.install.turn(), f.install.device()), true, 'the stage\'s go stands: a film never takes it');
});

test('EA-F1 refusals: each an EA_FILM before any unprobed full-size work, with nothing of it left and the Head untouched', async () => {
    const at = '1280x720';
    const size = { width: 1280, height: 720, fps: 60, seconds: 0.1 };
    // No longer on the stage: nothing made at all.
    let f = await filmFor('galaxy');
    f.state.onStage = 'another world';
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), size), new RegExp(`^Error: EA_FILM ${f.snap.id.slice(0, 12)}… at ${at}: this world is no longer on the stage$`));
    assert.equal(f.ports.size, 0, 'no film engine port made');
    released(f, null, 'no longer on the stage');

    // Another device generation: the Head's verdicts prove nothing on it.
    f = await filmFor('galaxy');
    f.install.d++;
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), size), /^Error: EA_FILM .* at 1280x720: EA_EVIDENCE /);
    assert.equal(f.ports.size, 0);
    released(f, null, 'another device generation');

    // Superseded mid-build: another world installed while the probe made its variants.
    f = await filmFor('galaxy', { headlessWrap: h => async (w, hh) => { const made = await h(w, hh); f.install.t++; return made; } });
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), size), /^Error: EA_FILM .* at 1280x720: superseded/);
    let port = [...f.ports.values()][0];
    assert.ok(!port.log.some(l => l.startsWith('render')), 'nothing submitted on the film\'s engine');
    released(f, port, 'superseded');

    // Past eligibility at the film's size: the gate's own words, nothing built.
    f = await filmFor('galaxy', { pixels: 1280 * 720 });
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), { ...size, width: 1920, height: 1080 }),
        /^Error: EA_FILM .* at 1920x1080: EA_ELIGIBILITY ng\.\S+ \(node \w+\): pixels 2073600 over 921600 /);
    assert.equal(f.ports.size, 0);
    released(f, null, 'past eligibility');

    // A probe over the cap at the film's size: the probe's refusal, and nothing of the world at full size on the film's engine.
    f = await filmFor('galaxy', { model: costs({ fixed: 0.05, perInvocation: 1e-5, perPixel: 8e-5 }) });
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), { ...size, width: 2048, height: 1152 }),
        /^Error: EA_FILM .* at 2048x1152: EA_PROBE one frame: \d+\.\d ms predicted, over the 250 ms cap$/);
    port = [...f.ports.values()][0];
    assert.ok(!port.log.some(l => l.startsWith('render')), 'init never ran at full size');
    released(f, port, 'over the cap');

    // A cancel during the probe: the runner's AbortError, everything released.
    f = await filmFor('galaxy');
    const ac = new AbortController();
    f.deps.headless = (inner => async (w, h) => { const made = await inner(w, h); ac.abort(); return made; })(f.deps.headless);
    await assert.rejects(runFilm(f, agentFilmWorkload(f.snap, f.deps, { fps: 60, still: VIEW }), { ...size, signal: ac.signal }), e => e.name === 'AbortError');
    released(f, [...f.ports.values()][0], 'cancelled');
});
