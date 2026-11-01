// EA-D14 and the stage's Run, headless (EA5.3; executor-design.md §9, §10, where this was EA-X14): the stage over a fake
// engine port, the probe's variants on fake headless ports, L3's verdicts from the device compiler over a fake device,
// eligibility as EA-G1 would write it. No GPU.
//   EA-D14 the offscreen first frame: the world's output points at a private target for the whole of its first frame,
//          the Head's camera written back in the same section, and back at the screen only once the sanity look passed,
//          so no candidate draw reaches the canvas before commit; a rejected first frame installs nothing and releases
//          everything, its output never pointed back; a resize past the envelope pauses the world (no oversized
//          submission) and says so once; an old Head whose teardown throws after the switch leaves the new one installed
//   the Run: no press, no Run (P7); an approved Run installs once, its reservation shrunk to the candidate's share; a
//          probe over the cap reaches no full-size work on the stage's engine; a cancel during the probe stops it; a
//          world with no post chain is redirected by its main pass
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { createEngineExecutor } from '../src/exec/engine-executor.ts';
import { createMemoryLedger, reservationFor } from '../src/exec/gate.ts';
import { createStage, envelopeOf, retire } from '../src/exec/stage.ts';
import { DEFAULT_LIMITS, ENV, cleanDevice, clock, compileAll, costs, eligibilityFor, fakeHeadless, fakePort, live, present, sealed, sealedLive } from './exec-fakes.mjs';

const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const SIZE = { width: 1280, height: 720 };
const LIGHT = costs({ fixed: 0.02, perInvocation: 1e-5, perPixel: 1e-7, perInstance: 1e-5 });

async function stageFor(snapOrName, { model = LIGHT, pixels = null, headlessWrap = h => h, fail = () => false, headlessOptions = {}, quiet = undefined } = {}) {
    const snap = typeof snapOrName === 'string' ? await sealedLive(snapOrName) : snapOrName;
    const now = present();
    const time = clock();
    const port = fakePort({ clock: time, cost: model, pixels, fail });
    const { headless, made } = fakeHeadless(time, model, headlessOptions);
    const compiler = createDeviceCompiler(cleanDevice().device, { generation: () => now.d, gpu: 'Fake GPU' });
    const compiled = await compileAll(snap, compiler);
    const envelope = envelopeOf(SIZE, 2_300_000);
    const commits = [];
    const refusals = [];
    const ledger = createMemoryLedger();
    const stage = createStage({
        port, headless: headlessWrap(headless), limits: DEFAULT_LIMITS, compiler: () => compiler, present: now, environment: ENV, gpu: 'Fake GPU',
        size: () => SIZE, maxPixels: 2_300_000, view: () => VIEW, restoreHeadCamera: () => port.log.push('head camera'),
        commit: r => { port.log.push('commit'); commits.push(r); }, now: () => time.t, onRefusal: m => refusals.push(m), ledger,
        eligibility: eligibilityFor([snap], { pixels: envelope.width * envelope.height }), quiet,
    });
    return { snap, now, port, made, compiled, stage, commits, refusals, ledger, envelope };
}

const allReleased = (s, what) => {
    assert.deepEqual([...s.port.live.values()], [], `${what}: every handle the construction made is freed`);
    assert.deepEqual(s.port.errors, [], `${what}: none twice`);
    assert.equal(s.ledger.held(), 0, `${what}: the reservation returned`);
    for (const h of s.made) {
        assert.equal(h.destroyed, true, `${what}: every probe engine destroyed`);
        assert.deepEqual([...h.port.live.values()], [], `${what}: every variant freed`);
    }
};

test('EA-D14 the offscreen first frame: drawn into a private target, the Head\'s camera written back, the output at the screen only after its look passed', async () => {
    const s = await stageFor('galaxy');
    // No press, no Run (P7).
    const unpressed = await s.stage.run(s.snap, s.compiled);
    assert.deepEqual(unpressed, { status: 'refused', reason: 'no GPU go: the host gives it, never a program', report: null });
    assert.equal(s.port.log.length, 0, 'nothing touched the engine');

    s.stage.press(s.snap);
    const r = await s.stage.run(s.snap, s.compiled);
    assert.equal(r.status, 'installed', r.reason);
    assert.equal(s.commits.length, 1);
    assert.equal(r.runtime, s.commits[0]);
    const need = reservationFor(s.snap.x, s.envelope);
    assert.equal(s.ledger.held(), need.candidate, 'the Head holds the candidate\'s own share; the probe\'s and the readback\'s are returned');
    assert.equal(r.held.bytes, need.candidate);
    assert.equal(r.report.probe.peakBytes, need.total);
    assert.equal(r.report.sanity.visibility, 'passed');
    assert.deepEqual(r.report.firstFrame, SIZE);
    assert.equal(r.report.refused, null);

    // The stage's engine ran nothing generated before the probe approved it: its first submission is init's, at full size.
    assert.deepEqual(s.port.log.filter(l => l.startsWith('render')), ['render [seed#create]', 'render [main, post/0, post/1]']);
    // The first frame, step by step, into its private target; the Head's camera written back right after the frame.
    const from = s.port.log.indexOf('offscreenTarget 1280x720');
    assert.deepEqual(s.port.log.slice(from, s.port.log.indexOf('commit') + 1), [
        'offscreenTarget 1280x720',
        'redirect chain -> target 1280x720',
        'updateCamera 12 at 0.000 aspect 1.778',
        'postUpload',
        'render [main, post/0, post/1]',
        'head camera',
        'readTarget target 1280x720',
        'readBuffer backdrop#create/storage 16',
        `readBuffer galaxy#create/storage ${1024 * 14 * 4}`,
        'redirect chain -> screen',
        'destroyTarget target 1280x720',
        'commit',
    ]);
    // Every draw of the candidate's passes before the commit happened while its output pointed at the private target.
    let redirected = false;
    for (const line of s.port.log.slice(0, s.port.log.indexOf('commit'))) {
        if (line.startsWith('redirect')) redirected = !line.endsWith('-> screen');
        if (/^render \[.*(main|post\/)/.test(line)) assert.ok(redirected, `a candidate draw reached the canvas before commit: ${line}`);
    }

    // After the switch it draws as a Head: its own sequence, nothing redirected.
    assert.deepEqual(r.runtime.draw().map(n => n.label), ['main', 'post/0', 'post/1']);
    // A resize past the envelope pauses it, says so once, and submits nothing at that size; back within, it runs.
    const renders = s.port.renders;
    r.runtime.resize(s.envelope.width + 10, s.envelope.height);
    r.runtime.resize(s.envelope.width + 20, s.envelope.height);
    assert.deepEqual(s.refusals, [`EA_RESIZE ${s.envelope.width + 10}x${s.envelope.height} exceeds the approved ${s.envelope.width * s.envelope.height} pixels; paused until it fits, or re-probe to grow`]);
    assert.equal(r.runtime.isPaused, true);
    assert.deepEqual(r.runtime.draw(), []);
    r.runtime.step();
    assert.equal(s.port.renders, renders, 'no oversized submission');
    r.runtime.resize(1920, 1080);
    assert.equal(r.runtime.isPaused, false);
    assert.deepEqual(r.runtime.draw().map(n => n.label), ['main', 'post/1920']);

    // The old Head's teardown throws after the switch: said, its reservation returned, the new world still the Head.
    const old = s.ledger.record('head h1', 180_000_000);
    const error = retire({ destroy: () => { throw new Error('a release failed'); } }, old);
    assert.equal(error, 'EA_RELEASE a release failed; the new world stays installed');
    assert.equal(old.released, true);
    assert.equal(s.ledger.held(), need.candidate);
    assert.equal(s.commits.length, 1);
    assert.deepEqual(r.runtime.draw().map(n => n.label), ['main', 'post/1920'], 'the installed world untouched');
    assert.equal(retire(null, null), null);
    r.runtime.destroy();
    r.held.release();
    allReleased(s, 'after its destroy');
});

test('the EA5.3 review: a probe submission\'s error refuses before full work (H1); a newer turn or a lost device stops preparation\'s own work (M1); a first frame that throws still writes the Head\'s camera back (M2)', async () => {
    // H1: a variant's submission raises an error: refused before anything ran at full size on the stage's engine.
    const erring = await stageFor('galaxy', { headlessOptions: { checkpointError: () => 'a validation error: the bind group is invalid' } });
    erring.stage.press(erring.snap);
    const e = await erring.stage.run(erring.snap, erring.compiled);
    assert.equal(e.status, 'failed');
    assert.equal(e.reason, 'EA_PROBE_UNVERIFIED the fence on the 1/8 variant raised an error: a validation error: the bind group is invalid; no full-size work submitted');
    assert.equal(erring.port.renders, 0, 'no full-size work on the stage');
    allReleased(erring, 'a probe submission that raised an error');
    // An engine that cannot check its own submissions is never prepared on.
    const unchecked = await stageFor('galaxy');
    delete unchecked.port.checkpoint;
    unchecked.stage.press(unchecked.snap);
    const u = await unchecked.stage.run(unchecked.snap, unchecked.compiled);
    assert.equal(u.reason, 'EA_PROBE_UNVERIFIED this engine cannot check its submissions for errors, or fence them; no full-size work submitted');
    assert.equal(unchecked.port.renders, 0);
    assert.equal(unchecked.made.length, 0, 'no probe either');

    // M1: a newer turn while the probe builds its variants. Preparation stops where it is: nothing on the stage's engine.
    let s = null;
    s = await stageFor('galaxy', { headlessWrap: h => async (w, hh) => { const made = await h(w, hh); s.now.t++; return made; } });
    s.stage.press(s.snap);
    const superseded = await s.stage.run(s.snap, s.compiled);
    assert.equal(superseded.status, 'stopped');
    assert.equal(superseded.reason, 'superseded');
    assert.equal(s.port.renders, 0, 'no full-size init, no first frame');
    assert.equal(superseded.report.firstFrame, null);
    allReleased(s, 'superseded during the probe');
    // A newer turn the moment the probe ends: caught right before init's full-size work.
    let late = null;
    let destroyed = 0;
    late = await stageFor('galaxy', { headlessWrap: h => async (w, hh) => {
        const made = await h(w, hh);
        const destroy = made.destroy;
        made.destroy = () => { destroy(); if (++destroyed === 2) late.now.t++; };
        return made;
    } });
    late.stage.press(late.snap);
    const beforeInit = await late.stage.run(late.snap, late.compiled);
    assert.equal(beforeInit.status, 'stopped');
    assert.equal(beforeInit.reason, 'superseded');
    assert.ok(beforeInit.report.probe.maxSubmissionMs > 0, 'the probe had finished');
    assert.equal(late.port.renders, 0, 'init\'s full-size work never submitted');
    allReleased(late, 'superseded before full-size init');
    // The device generation moves at the probe's first fence: device-lost, nothing on the stage.
    let lost = null;
    lost = await stageFor('galaxy', { headlessWrap: h => async (w, hh) => {
        const made = await h(w, hh);
        const settle = made.port.settle;
        made.port.settle = async () => { await settle(); lost.now.d++; };
        return made;
    } });
    lost.stage.press(lost.snap);
    const gone = await lost.stage.run(lost.snap, lost.compiled);
    assert.equal(gone.status, 'stopped');
    assert.equal(gone.reason, 'device-lost');
    assert.equal(lost.port.renders, 0);
    assert.equal(lost.made[0].port.renders, 0, 'the first fence (the empty one that measures the floor) saw the loss: nothing ran after it');
    allReleased(lost, 'a device generation that moved');

    // M2: the candidate's first frame throws: the Head's camera is written back all the same, right after it.
    const throwing = await stageFor('galaxy', { fail: entry => entry === 'render [main, post/0, post/1]' });
    throwing.stage.press(throwing.snap);
    const t = await throwing.stage.run(throwing.snap, throwing.compiled);
    assert.equal(t.status, 'failed');
    assert.equal(t.reason, 'EA_SANITY the first frame: a device error at render [main, post/0, post/1]');
    const at = throwing.port.log.indexOf('render [main, post/0, post/1]');
    assert.equal(throwing.port.log[at + 1], 'head camera', 'written back in the same section, though the frame threw');
    assert.equal(throwing.commits.length, 0);
    allReleased(throwing, 'a first frame that threw');
});

test('EA-E (11-01): the stage hands the probe its quiet window, and every window is released before the world is installed', async () => {
    const windows = { open: 0, taken: 0, openAtCommit: null };
    const quiet = () => {
        windows.open++;
        windows.taken++;
        let done = false;
        return () => {
            if (done) return;
            done = true;
            windows.open--;
        };
    };
    const s = await stageFor('galaxy', { quiet });
    const commit = s.port.log.push.bind(s.port.log);
    s.port.log.push = (...entries) => {
        if (entries.includes('commit')) windows.openAtCommit = windows.open;
        return commit(...entries);
    };
    s.stage.press(s.snap);
    const r = await s.stage.run(s.snap, s.compiled);
    assert.equal(r.status, 'installed', r.reason);
    assert.ok(windows.taken > 20, `each of the probe's timings in a window (${windows.taken})`);
    assert.equal(windows.open, 0, 'each released');
    assert.equal(windows.openAtCommit, 0, 'none open at the switch');
    assert.equal(r.report.probe.contaminated, false, 'the Head\'s frames in no timing');
});

test('EA-D14 a rejected first frame installs nothing, releases everything, and its output is never pointed back at the screen', async () => {
    const black = t => { const p = new Uint8Array(t.width * t.height * 4); for (let i = 3; i < p.length; i += 4) p[i] = 255; return p; };
    const s = await stageFor('galaxy', { pixels: black });
    s.stage.press(s.snap);
    const r = await s.stage.run(s.snap, s.compiled);
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'EA_SANITY black: the brightest pixel is 0.0 of 255; galaxy declares at least 2.0');
    assert.equal(r.report.refused, r.reason);
    assert.equal(r.report.sanity.frameMax, 0);
    assert.equal(s.commits.length, 0);
    assert.ok(s.port.log.includes('redirect chain -> target 1280x720'));
    assert.ok(!s.port.log.includes('redirect chain -> screen'), 'a refused world stays pointed away from the screen until released');
    allReleased(s, 'a rejected first frame');
});

test('the Run: a probe over the cap reaches no full-size work on the stage\'s engine; a cancel during the probe stops it; a world with no chain redirects its main pass', async () => {
    const heavy = await stageFor('galaxy', { model: costs({ fixed: 0.05, perInvocation: 0.02 }) });
    heavy.stage.press(heavy.snap);
    const r = await heavy.stage.run(heavy.snap, heavy.compiled);
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'EA_PROBE init: 307.7 ms predicted, over the 250 ms cap');
    assert.equal(heavy.port.renders, 0, 'nothing submitted on the stage\'s engine: init\'s dispatch never ran there');
    assert.ok(!heavy.port.log.some(l => l.startsWith('offscreenTarget')), 'no first frame');
    assert.equal(r.report.probe.phases.init.measured.length, 2);
    assert.equal(heavy.commits.length, 0);
    allReleased(heavy, 'a probe over the cap');

    // A cancel lands while the probe builds its variants.
    const ac = new AbortController();
    const cancelled = await stageFor('galaxy', { headlessWrap: h => async (w, hh) => { const made = await h(w, hh); ac.abort(); return made; } });
    cancelled.stage.press(cancelled.snap);
    const c = await cancelled.stage.run(cancelled.snap, cancelled.compiled, ac.signal);
    assert.equal(c.status, 'stopped');
    assert.equal(c.reason, 'cancelled');
    assert.equal(cancelled.port.renders, 0);
    assert.equal(cancelled.commits.length, 0);
    assert.deepEqual([...cancelled.port.live.values()], [], 'every handle freed');
    assert.equal(cancelled.ledger.held(), 0);
    assert.ok(cancelled.made.every(h => h.destroyed), 'the probe engine made before the cancel destroyed');

    // A world with no post chain: its main pass is the screen pass, redirected and pointed back.
    const film = live('block-film');
    const noChain = await sealed(film.program.nodes.filter(n => n.adapterId !== 'ng.post.chain'), Object.fromEntries(film.modules.map(m => [m.module, m.body])));
    const plain = await stageFor(noChain);
    plain.stage.press(plain.snap);
    const p = await plain.stage.run(plain.snap, plain.compiled);
    assert.equal(p.status, 'installed', p.reason);
    assert.ok(plain.port.log.includes('redirect main -> target 1280x720') && plain.port.log.includes('redirect main -> screen'));
    assert.equal(p.report.sanity.visibility, 'untested', 'a world no profile declares: its visibility untested, never passed');
    p.runtime.destroy();
    p.held.release();
    allReleased(plain, 'a world with no chain, destroyed');

    // The executor opens no construction for an admission of another candidate, whoever calls it.
    assert.throws(() => createEngineExecutor({ port: fakePort(), onCommit: () => {} }).instantiate(heavy.snap, { graph: heavy.snap.x.hash, candidate: 'another' }, new AbortController().signal),
        /this admission is for another candidate/);

    // A second Run while one is under way is refused, not interleaved.
    const busy = await stageFor('galaxy');
    busy.stage.press(busy.snap);
    const first = busy.stage.run(busy.snap, busy.compiled);
    assert.equal(busy.stage.busy, true);
    assert.deepEqual(await busy.stage.run(busy.snap, busy.compiled), { status: 'refused', reason: 'a Run is under way already', report: null });
    const done = await first;
    assert.equal(done.status, 'installed');
    assert.equal(busy.stage.busy, false);
    done.runtime.destroy();
    done.held.release();
});
