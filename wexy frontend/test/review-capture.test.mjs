// EA-VR1 and the review's capture, headless (EA6.1; visual-review-design.md §6, §10; Q108 decided 2026-11-02): the world
// installed by the stage over a fake engine port, then captured from its two views while the stage holds still. No GPU.
//   EA-VR1 the capture's order: each view drawn into a private target with the world's output pointed at it and back,
//          the Head's camera written back in the same section, every readback and the boxes' reads submitted before the
//          section ends; no step, reset or resize; every target destroyed once after its read settled, the reservation
//          returned, the hold released, whatever fails (the target, the redirect, the draw, the read, the encoder) or goes
//          stale (a newer review, a device replaced)
//   the state-safety gate: a world whose frame writes its own state is never drawn again (foggy-dusk's drifting fog, the
//          coverage worlds' frame stages), nor one whose post chain keeps a history (AutoExposure; policy v2, after the
//          outside review of 11-02 night); its boxes are still read
//   the views (Q108) and the fit into 768 × 432: aspect kept, bars opaque and black, nothing stretched
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { createMemoryLedger } from '../src/exec/gate.ts';
import {
    CAPTURE_POLICY, FRAME_BYTES, JPEG_QUALITIES, REVIEW_HEIGHT, REVIEW_WIDTH, captureInstalled, captureSafety, fitInto, reviewViews,
} from '../src/exec/review-capture.ts';
import { createStage, envelopeOf } from '../src/exec/stage.ts';
import {
    COVERAGE_WORLDS, DEFAULT_LIMITS, ENV, cleanDevice, clock, compileAll, costs, coverageWorld, eligibilityFor, fakeHeadless, fakePort, live, present, sealedLive,
} from './exec-fakes.mjs';

const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const SIZE = { width: 1280, height: 720 };
const LIGHT = costs({ fixed: 0.02, perInvocation: 1e-5, perPixel: 1e-7, perInstance: 1e-5 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** A JPEG-shaped answer: its signature, then `size(q)` bytes in all; each call counted. */
function fakeEncoder(size = () => 50_000) {
    const calls = [];
    const encode = async (rgba, width, height, quality) => {
        calls.push({ width, height, quality, bytes: rgba.length });
        const out = new Uint8Array(size(quality));
        out.set([0xff, 0xd8, 0xff, 0xe0]);
        out[4] = Math.round(quality * 100);
        out[5] = rgba[0];
        return out;
    };
    return { encode, calls };
}

/** A live world installed on the stage over a fake port: its runtime is the Head. */
async function installed(name) {
    const snap = await sealedLive(name);
    const now = present();
    const time = clock();
    const port = fakePort({ clock: time, cost: LIGHT });
    const { headless } = fakeHeadless(time, LIGHT);
    const compiler = createDeviceCompiler(cleanDevice().device, { generation: () => now.d, gpu: 'Fake GPU' });
    const compiled = await compileAll(snap, compiler);
    const envelope = envelopeOf(SIZE, 2_300_000);
    const ledger = createMemoryLedger();
    const stage = createStage({
        port, headless, limits: DEFAULT_LIMITS, compiler: () => compiler, present: now, environment: ENV, gpu: 'Fake GPU', size: () => SIZE, maxPixels: 2_300_000,
        view: () => VIEW, restoreHeadCamera: () => port.log.push('head camera'), commit: () => port.log.push('commit'), now: () => time.t, ledger,
        eligibility: eligibilityFor([snap], { pixels: envelope.width * envelope.height }),
    });
    stage.press(snap);
    const r = await stage.run(snap, compiled);
    assert.equal(r.status, 'installed', r.reason);
    return { snap, port, runtime: r.runtime, ledger, report: r.report, envelope };
}

/** The capture's own deps over an installed world; `over` replaces any. */
function deps(w, over = {}) {
    const holds = { taken: 0, released: 0 };
    const { encode, calls } = fakeEncoder(over.size);
    const d = {
        port: w.port, runtime: w.runtime, x: w.snap.x,
        views: reviewViews({ view: { target: [0, 1, 0], distance: 20, azimuth: 0.6, polar: 1.15, fov: 45 }, subject: null, notes: [] }, VIEW).views,
        restoreHeadCamera: () => w.port.log.push('head camera'),
        hold: () => { holds.taken++; return () => { holds.released++; }; },
        stale: () => null, ledger: w.ledger, encode, ...over,
    };
    return { d, holds, calls };
}

const targetsFreed = (w, what) => {
    assert.deepEqual([...w.port.live.values()].filter(l => l.startsWith('target')), [], `${what}: every target destroyed`);
    assert.deepEqual(w.port.errors, [], `${what}: none twice`);
};

test('EA-VR1 a capture draws each view into its own target and back, writes the Head\'s camera back, reads every frame and box in the same section, and changes nothing of the world', async () => {
    const w = await installed('galaxy');
    // The world has run a while: its clock is where it is.
    for (let i = 0; i < 5; i++) w.runtime.step();
    const steps = w.runtime.steps;
    const seconds = w.runtime.simTime;
    const before = w.ledger.held();
    const renders = w.port.renders;
    const from = w.port.log.length;
    const { d, holds, calls } = deps(w);
    const o = await captureInstalled(d);
    assert.equal(o.ok, true, o.message);
    const log = w.port.log.slice(from);
    const draw = (aspect = '1.778') => [
        'offscreenTarget 1280x720', 'redirect chain -> target 1280x720', `updateCamera 20 at ${seconds.toFixed(3)} aspect ${aspect}`, 'postUpload',
        'render [main, post/0, post/1]', 'redirect chain -> screen',
    ];
    const bounds = log.filter(l => l.startsWith('readBuffer'));
    assert.deepEqual(log.slice(0, 15), [...draw(), ...draw(), 'head camera', 'readTarget target 1280x720', 'readTarget target 1280x720'],
        'both views drawn and their output pointed back in one section, the Head\'s camera written after them, both reads asked for at once');
    assert.equal(bounds.length, 16, 'galaxy\'s 12,000 instances read for their box in 16 runs, in the same section');
    assert.ok(log.indexOf(bounds[0]) < log.indexOf('destroyTarget target 1280x720'), 'the boxes asked for before any target goes');
    assert.deepEqual(log.slice(-2), ['destroyTarget target 1280x720', 'destroyTarget target 1280x720'], 'each target destroyed once, after its read');
    // I7: no step, reset or resize; one submission a view; the world's clock where it was.
    assert.equal(w.runtime.steps, steps);
    assert.equal(w.runtime.simTime, seconds);
    assert.equal(w.port.renders, renders + 2);
    assert.ok(!log.some(l => /^(clearBuffer|postResize|writeBuffer)/.test(l)), `nothing reset, resized or stepped: ${log.filter(l => /^(clearBuffer|postResize|writeBuffer)/.test(l))}`);
    assert.deepEqual(holds, { taken: 1, released: 1 });
    assert.equal(w.ledger.held(), before, 'the capture\'s reservation returned');
    targetsFreed(w, 'after a capture');
    // The frames: identified, fitted, encoded at the first quality, hashed.
    assert.deepEqual([o.tick, o.seconds, o.policy, o.missing, o.temporal], [steps, seconds, CAPTURE_POLICY, [], []]);
    assert.deepEqual(o.frames.map(f => [f.view, f.renderOrdinal, f.sourceWidth, f.sourceHeight, f.width, f.height, f.quality]),
        [['framed', 1, 1280, 720, REVIEW_WIDTH, REVIEW_HEIGHT, JPEG_QUALITIES[0]], ['side', 2, 1280, 720, REVIEW_WIDTH, REVIEW_HEIGHT, JPEG_QUALITIES[0]]]);
    for (const f of o.frames) {
        assert.deepEqual(f.content, { x: 0, y: 0, width: 768, height: 432 }, 'a 16:9 canvas fills the frame');
        assert.equal(f.sha256, sha(f.jpeg), 'the hash is of the encoded bytes themselves');
        assert.equal(f.rgba.length, 768 * 432 * 4);
    }
    assert.equal(o.frames[1].camera.polar, Math.PI / 2, 'the side view is level');
    assert.ok(Math.abs(o.frames[1].camera.azimuth - (0.6 + Math.PI / 2)) < 1e-12, 'a quarter turn round');
    assert.deepEqual(calls.map(c => [c.width, c.height, c.quality]), [[768, 432, 0.85], [768, 432, 0.85]]);
    assert.deepEqual(o.bounds, { batches: [] }, 'its boxes, at that tick (the fake\'s instances were never written)');
});

test('EA-VR1 a failure at each step restores the camera and the output, destroys every target once, returns the reservation and releases the hold; a stale capture is discarded', async () => {
    const w = await installed('galaxy');
    const before = w.ledger.held();
    const check = async (label, over, pattern, { drawn = true } = {}) => {
        const from = w.port.log.length;
        const { d, holds } = deps(w, over(w));
        const o = await captureInstalled(d);
        assert.equal(o.ok, false, label);
        assert.match(o.message, pattern, label);
        const log = w.port.log.slice(from);
        if (drawn) {
            assert.equal(log.filter(l => l === 'head camera').length, 1, `${label}: the Head's camera written back once`);
            const last = log.filter(l => l.startsWith('redirect')).at(-1);
            assert.ok(last === undefined || last.endsWith('-> screen'), `${label}: the output back at the screen (${last})`);
        }
        assert.deepEqual(holds.taken, holds.released, `${label}: the hold released`);
        assert.equal(w.ledger.held(), before, `${label}: the reservation returned`);
        targetsFreed(w, label);
    };
    let n = 0;
    await check('the second target', ({ port }) => ({ port: { ...port, offscreenTarget: (wd, ht) => { if (++n === 2) throw new Error('out of memory'); return port.offscreenTarget(wd, ht); } } }),
        /^EA_CAPTURE target side: out of memory$/);
    let r = 0;
    await check('the second draw', ({ port }) => ({ port: { ...port, render: seq => { if (++r === 2) throw new Error('a validation error'); port.render(seq); } } }),
        /^EA_CAPTURE draw side: a validation error$/);
    await check('a read', ({ port }) => ({ port: { ...port, readTarget: t => (port.log.push(`readTarget ${t.label}`), Promise.reject(new Error('mapAsync failed'))) } }),
        /^EA_CAPTURE read: mapAsync failed$/);
    await check('the encoder', () => ({ encode: async () => { throw new Error('no 2D canvas'); } }), /^EA_CAPTURE encode framed: no 2D canvas$/);
    await check('an encoder that gives no JPEG', () => ({ encode: async () => new Uint8Array([1, 2, 3, 4, 5]) }), /^EA_CAPTURE encode framed: the encoder gave no JPEG$/);
    // The redirect is the world's own port's: refused there, the camera and the output still come back.
    const redirect = w.port.redirectOutput;
    let k = 0;
    w.port.redirectOutput = (pass, chain, target) => { if (target && ++k === 2) throw new Error('no screen pass'); redirect(pass, chain, target); };
    await check('the second redirect', () => ({}), /^EA_CAPTURE redirect side: no screen pass$/);
    w.port.redirectOutput = redirect;
    // A newer review, or the device replaced, while the reads are under way: discarded, nothing returned but why.
    let stale = null;
    await check('a newer review', ({ port }) => ({ port: { ...port, readTarget: async t => { stale = 'a newer review'; return port.readTarget(t); } }, stale: () => stale }),
        /^EA_STOP a newer review: the capture is discarded$/);
    stale = null;
    await check('the device replaced', () => ({ encode: async () => { stale = 'the device was replaced'; return new Uint8Array([0xff, 0xd8, 0xff, 1]); }, stale: () => stale }),
        /^EA_STOP the device was replaced: the capture is discarded$/);
    // Past the byte cap at every quality: refused, after at most two retries.
    const sizes = [];
    await check('too large', () => ({ encode: async (rgba, wd, ht, q) => { sizes.push(q); const b = new Uint8Array(FRAME_BYTES + 1); b.set([0xff, 0xd8, 0xff]); return b; } }),
        new RegExp(`^EA_REVIEW_SIZE framed: ${FRAME_BYTES + 1} exceeds ${FRAME_BYTES} bytes$`));
    assert.deepEqual(sizes, [...JPEG_QUALITIES]);
    // Within it at the last quality: taken at that quality. At the cap exactly: taken at the first.
    const { d } = deps(w, { size: q => (q > 0.6 ? FRAME_BYTES + 1 : 1000) });
    const ok = await captureInstalled(d);
    assert.deepEqual(ok.frames.map(f => [f.quality, f.jpeg.length]), [[0.55, 1000], [0.55, 1000]]);
    const atCap = await captureInstalled(deps(w, { size: () => FRAME_BYTES }).d);
    assert.deepEqual(atCap.frames.map(f => [f.quality, f.jpeg.length]), [[0.85, FRAME_BYTES], [0.85, FRAME_BYTES]], 'two frames at the cap: the pair\'s 600,000 exactly');
    // The world itself: still the Head, drawing its own sequence to the screen.
    assert.deepEqual(w.runtime.draw().map(x => x.label), ['main', 'post/0', 'post/1']);
});

test('the state-safety gate (EA6.1, policy v2): a world whose frame writes its own state, or whose post chain keeps a history, is never drawn for a review; its boxes are still read', async () => {
    const xOf = async nodes => {
        const r = await resolveProgram(nodes);
        assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
        return r.graph;
    };
    const safety = {};
    for (const name of ['block-film', 'galaxy', 'foggy-dusk']) safety[name] = captureSafety(await xOf(live(name).program.nodes));
    for (const name of COVERAGE_WORLDS) safety[name] = captureSafety(await xOf(coverageWorld(name).program.nodes));
    const castle = JSON.parse(readFileSync(new URL('../dev/replays/castle.json', import.meta.url), 'utf8'));
    safety.castle = captureSafety(await xOf(castle.program.nodes));
    const unsafe = Object.entries(safety).filter(([, s]) => s.unsafe).map(([n]) => n).sort();
    assert.deepEqual(unsafe, ['cov-compute', 'cov-custom', 'cov-effects-a', 'foggy-dusk'], 'the worlds with a frame-phase stage, and the one whose post chain keeps a history');
    assert.equal(safety['foggy-dusk'].unsafe, 'driftfog writes fog#buffer every frame: an extra frame for a review would move it');
    assert.match(safety['cov-compute'].unsafe, /^driftswarm writes swarm#buffer every frame/);
    // Policy v2 (the outside review of 11-02 night): a temporal effect's history withholds the capture as state does.
    assert.equal(CAPTURE_POLICY, 'ea6-capture.v2');
    assert.deepEqual(safety['cov-effects-a'].temporal, ['AutoExposure'], 'the one effect with a history');
    assert.equal(safety['cov-effects-a'].unsafe, 'look keeps the history of AutoExposure, which every frame drawn moves: an extra frame for a review would move it');
    assert.deepEqual(Object.entries(safety).filter(([n]) => n !== 'cov-effects-a').flatMap(([, s]) => s.temporal), []);
    // A frame stage that reads what it writes (read-write), and a ping-pong pair swapped each frame: both move the world.
    const foggy = live('foggy-dusk').program.nodes;
    const reread = foggy.map(n => (n.id === 'driftfog' ? { ...n, inputs: [...n.inputs, { port: 'reads', nodeId: 'fog', output: 'buffer' }] } : n));
    const rx = await xOf(reread);
    assert.ok(rx.operations.some(o => o.node === 'driftfog' && o.phase === 'frame' && o.accesses.some(a => a.resource === 'fog#buffer' && a.mode === 'readwrite')), 'a read-write access');
    assert.equal(captureSafety(rx).unsafe, 'driftfog writes fog#buffer every frame: an extra frame for a review would move it');
    const stepped = coverageWorld('cov-compute').program.nodes.map(n => (n.id === 'stepfield' ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), phase: 'frame' }) } : n));
    const sx = await xOf(stepped);
    assert.ok(sx.schedule.frame.some(id => sx.operations.find(o => o.id === id)?.call === 'pingpong.swap'), 'a swap in the frame');
    assert.match(captureSafety(sx).unsafe, /stepfield swaps field#buffer every frame/);

    // foggy-dusk on the stage: nothing drawn, both views said unavailable, its boxes read all the same.
    const w = await installed('foggy-dusk');
    const from = w.port.log.length;
    const { d, holds, calls } = deps(w);
    const o = await captureInstalled(d);
    assert.equal(o.ok, true, o.message);
    const log = w.port.log.slice(from);
    assert.ok(!log.some(l => /^(offscreenTarget|redirect|render|readTarget|updateCamera)/.test(l)), `nothing drawn: ${log}`);
    assert.ok(log.some(l => l.startsWith('readBuffer')), 'its boxes read: a read changes nothing');
    assert.deepEqual(o.frames, []);
    assert.deepEqual(o.missing.map(m => m.name), ['framed', 'side']);
    assert.equal(o.missing[0].why, `EA_CAPTURE_UNAVAILABLE state: ${safety['foggy-dusk'].unsafe}`);
    assert.deepEqual([calls.length, holds.taken, holds.released], [0, 1, 1]);
    targetsFreed(w, 'an unsafe world');

    // A world paused past its envelope draws nothing either, and says so.
    const g = await installed('galaxy');
    g.runtime.resize(g.envelope.width + 10, g.envelope.height);
    const paused = await captureInstalled(deps(g).d);
    assert.equal(paused.missing[0].why, 'EA_CAPTURE_UNAVAILABLE envelope: the world is paused past the size it was approved for');
    assert.deepEqual(paused.frames, []);
});

test('the views (Q108): the framed view, and a level side view a quarter turn round at the same distance; with no mesh to frame, the stage\'s camera and no side view', () => {
    const framing = { view: { target: [1, 2, 3], distance: 30, azimuth: 0.6, polar: 1.15, fov: 45 }, subject: null, notes: [] };
    const { views, missing } = reviewViews(framing, VIEW);
    assert.deepEqual(views.map(v => v.name), ['framed', 'side']);
    assert.deepEqual(views[0].camera, framing.view);
    assert.deepEqual(views[1].camera, { target: [1, 2, 3], distance: 30, azimuth: 0.6 + Math.PI / 2, polar: Math.PI / 2, fov: 45 });
    assert.notEqual(views[0].camera.target, framing.view.target, 'copied, never shared');
    assert.deepEqual(missing, []);
    const none = reviewViews(null, VIEW);
    assert.deepEqual(none.views.map(v => [v.name, v.camera]), [['framed', VIEW]]);
    assert.deepEqual(none.missing, [{ name: 'side', why: 'no mesh boxes, so no subject to look at level' }]);
});

test('the fit into 768 × 432: a 16:9 source fills it; a portrait one keeps its shape between black bars; each pixel the mean of what it covers', () => {
    const solid = (w, h, rgb) => {
        const p = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) p.set([...rgb, 0], i * 4);
        return p;
    };
    const wide = fitInto(solid(1280, 720, [200, 100, 50]), 1280, 720);
    assert.deepEqual(wide.content, { x: 0, y: 0, width: 768, height: 432 });
    assert.deepEqual([...wide.rgba.subarray(0, 4)], [200, 100, 50, 255], 'its colour kept, and opaque whatever the source\'s alpha');
    const tall = fitInto(solid(720, 1280, [10, 220, 30]), 720, 1280);
    assert.deepEqual(tall.content, { x: 262, y: 0, width: 243, height: 432 }, 'portrait: bars at its sides, never stretched');
    const at = (f, x, y) => [...f.rgba.subarray((y * 768 + x) * 4, (y * 768 + x) * 4 + 4)];
    assert.deepEqual(at(tall, 0, 0), [0, 0, 0, 255], 'a bar: opaque black');
    assert.deepEqual(at(tall, 767, 431), [0, 0, 0, 255]);
    assert.deepEqual(at(tall, 262, 0), [10, 220, 30, 255]);
    assert.deepEqual(at(tall, 504, 431), [10, 220, 30, 255]);
    // A checkerboard of black and white pixels averages to grey; a source smaller than the frame is drawn nearest.
    const board = new Uint8Array(1536 * 864 * 4);
    for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) board.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 1536 + x) * 4);
    assert.deepEqual(at(fitInto(board, 1536, 864), 10, 10), [128, 128, 128, 255]);
    const tiny = fitInto(solid(16, 9, [9, 8, 7]), 16, 9);
    assert.deepEqual([tiny.content, at(tiny, 767, 431)], [{ x: 0, y: 0, width: 768, height: 432 }, [9, 8, 7, 255]]);
});
