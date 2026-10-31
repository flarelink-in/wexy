// EA-E series, headless (EA3.5; engine-adapters-design.md §9, §10 EA-U10): the executor seam, driven by a fake executor
// that counts its calls, and a fake gate standing where EA5's device checks will. Every shut door makes no call at all
// (a look-alike or copied admission, another X, a spent one, a stale turn, another device, a cancel, failing evidence,
// no GPU go). An admitted build makes one door call, each init operation in X's order, the preparation, the switch. A stop or
// a failure at any step releases exactly what the attempted creates made, each release once, in dispose order, and
// installs nothing. No device: EA3 is static only, and ships no executor and no authority that admits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGraph } from '../src/contract/adapters/checks.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { cleanupFor, resolveProgram } from '../src/contract/adapters/resolve.ts';
import { STATIC_ONLY, createAuthority, instantiate } from '../src/loop/executor.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });

/** The nine adapters, with entries a body can define and a tonemapped post chain: X checks and its interfaces derive. */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.1, 0.1, 0.12], directional: { direction: [0.3, -1, 0.2], color: [1, 0.95, 0.85], intensity: 2 }, points: [] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer'), from('lights', 'sun', 'lights')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 1 }, [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'field', 'buffer')]),
        node('look', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ];
}

async function graphOf(program = world()) {
    const r = await resolveProgram(program, POLICY_V1);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.graph;
}

/** Evidence for X as EA5 will gather it, its device part stood in for by the fake gate. */
async function evidence(x, gpuGo = true) {
    return { checked: await checkGraph(x, POLICY_V1), interfaces: await deriveInterfaces(x), gpuGo };
}

const ADMIT = createAuthority(() => null);

/** The host's present: a turn and a device generation either can move. */
const presentNow = () => ({ t: 1, d: 1, turn() { return this.t; }, device() { return this.d; } });

/**
 * A fake executor: counts every call, and keeps which world is the Head (`head`, the old one until a commit). It can fail
 * a step, a release, the preparation or the switch, act during a step or during the preparation, or fail to open.
 */
function fake({ failAt = null, releaseFails = [], prepareFails = false, commitFails = false, during = () => {}, preparing = () => {}, opening = null } = {}) {
    const calls = { instantiate: 0, run: [], release: [], prepare: 0, commit: 0 };
    const state = { head: 'old' };
    return {
        calls,
        state,
        instantiate() {
            calls.instantiate++;
            if (opening) opening();
            return {
                async run(op) {
                    calls.run.push(op);
                    await during(op, calls);
                    if (op === failAt) throw new Error(`a device error at ${op}`);
                },
                async release(op) {
                    calls.release.push(op);
                    if (releaseFails.includes(op)) throw new Error(`${op} could not release`);
                },
                async prepare() {
                    calls.prepare++;
                    await preparing();
                    if (prepareFails) throw new Error('the first frame failed');
                },
                commit() {
                    calls.commit++;
                    if (commitFails) throw new Error('the switch failed');
                    state.head = 'candidate';
                },
            };
        },
    };
}

const admitted = async (x, present) => {
    const a = ADMIT.admit(x, await evidence(x), present);
    assert.equal(a.ok, true, a.reason);
    return a.admission;
};
const creates = x => x.schedule.init.filter(id => x.operations.find(o => o.id === id).kind === 'create');

test('EA-E1 every shut door makes no executor call: forged, copied, another X, spent, stale, another device, cancelled', async () => {
    const x = await graphOf();
    const present = presentNow();
    const signal = new AbortController().signal;
    const shut = async (label, admission, reason, graph = x, p = present, s = signal) => {
        const exec = fake();
        const out = await instantiate(graph, admission, exec, p, s);
        assert.deepEqual(out, { status: 'refused', reason }, label);
        assert.deepEqual(exec.calls, { instantiate: 0, run: [], release: [], prepare: 0, commit: 0 }, `${label}: no call`);
    };
    // EA3 ships no authority that admits.
    assert.deepEqual(STATIC_ONLY.admit(x, await evidence(x), present), { ok: false, reason: 'EA3 is static only (Q75): admissions come with EA5\'s device checks and the GPU go' });
    const real = await admitted(x, present);
    await shut('a look-alike object', { graph: x.hash, policy: x.identity.policyHash, turn: 1, device: 1 }, 'not an admission the host issued');
    await shut('a copy of a real one', structuredClone(real), 'not an admission the host issued');
    const other = world();
    other[0].config = JSON.stringify({ elements: 32, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' });
    await shut('another X', real, 'this admission is for another X', await graphOf(other));
    // A changed policy is another X: its identity, and so its hash, differ.
    const p2 = { ...POLICY_V1, label: 'fixture: another policy', maxFixedSteps: 2 };
    const underP2 = (await resolveProgram(world(), p2)).graph;
    await shut('another policy', real, 'this admission is for another X', underP2);
    const stale = presentNow();
    const forStale = await admitted(x, stale);
    stale.t = 2;
    await shut('a turn that moved on', forStale, 'superseded before construction', x, stale);
    const lost = presentNow();
    const forLost = await admitted(x, lost);
    lost.d = 2;
    await shut('a device lost', forLost, 'device-lost before construction', x, lost);
    const cancelled = new AbortController();
    cancelled.abort();
    await shut('a cancel before the door', await admitted(x, present), 'cancelled before construction', x, present, cancelled.signal);
    // Spent: one door call, then the same admission opens nothing.
    const once = await admitted(x, present);
    const exec = fake();
    assert.equal((await instantiate(x, once, exec, present, signal)).status, 'installed');
    assert.deepEqual(await instantiate(x, once, exec, present, signal), { status: 'refused', reason: 'this admission was spent already' });
    assert.equal(exec.calls.instantiate, 1);
});

test('EA-E1b the authority admits only on passing evidence for this X, with the GPU go and the gate', async () => {
    const x = await graphOf();
    const present = presentNow();
    const refused = async (label, x, ev, reason, authority = ADMIT) => assert.deepEqual(authority.admit(x, ev, present), { ok: false, reason }, label);
    const nothing = await graphOf([node('field', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' })]);
    await refused('checks fail (a world that draws nothing)', nothing, await evidence(nothing), 'X does not pass its checks');
    const step = world();
    step[2].config = JSON.stringify({ module: 'motion', entry: 'step', workgroupSize: 64, invocations: 64, phase: 'fixedStep' });
    const stepped = await graphOf(step);
    await refused('an interface cannot be derived (step shadows a built-in)', stepped, await evidence(stepped), 'X\'s module interfaces cannot be derived');
    await refused('evidence for another X', x, await evidence(stepped), 'the evidence is for another X');
    await refused('no GPU go', x, await evidence(x, false), 'no GPU go: the host gives it, never a program');
    await refused('the gate says no', x, await evidence(x), 'the device lacks a limit', createAuthority(() => 'the device lacks a limit'));
    const a = ADMIT.admit(x, await evidence(x), present);
    assert.deepEqual(a.ok && { ...a.admission }, { graph: x.hash, policy: x.identity.policyHash, turn: 1, device: 1 });
    assert.ok(Object.isFrozen(a.admission));
});

test('EA-E2 an admitted build: one door call, each init operation in X\'s order, one preparation, one switch, no release', async () => {
    const x = await graphOf();
    const exec = fake();
    const out = await instantiate(x, await admitted(x, presentNow()), exec, presentNow(), new AbortController().signal);
    assert.deepEqual(out, { status: 'installed', ran: [...x.schedule.init] });
    assert.deepEqual(exec.calls, { instantiate: 1, run: [...x.schedule.init], release: [], prepare: 1, commit: 1 });
    assert.equal(exec.state.head, 'candidate');
});

test('EA-E3 a cancel after any step stops before the next, releases what was attempted, once each in dispose order, installs nothing', async () => {
    const x = await graphOf();
    const init = x.schedule.init;
    for (let k = 1; k <= init.length; k++) {
        const controller = new AbortController();
        const present = presentNow();
        const exec = fake({ during: (op, calls) => { if (calls.run.length === k) controller.abort(); } });
        const out = await instantiate(x, await admitted(x, present), exec, present, controller.signal);
        const attempted = new Set(init.slice(0, k).filter(id => creates(x).includes(id)));
        const expected = cleanupFor(x, attempted);
        assert.deepEqual(out, { status: 'stopped', why: 'cancelled', ran: init.slice(0, k), released: expected, releaseErrors: [] }, `after ${k}`);
        assert.deepEqual(exec.calls.run, init.slice(0, k), `${k}: no step after the cancel`);
        assert.deepEqual(exec.calls.release, expected, `${k}: released once each`);
        assert.equal(new Set(exec.calls.release).size, exec.calls.release.length);
        assert.deepEqual([exec.calls.prepare, exec.calls.commit, exec.state.head], [0, 0, 'old']);
    }
});

test('EA-E4 a turn superseded, or the device lost, during a step: the late step is discarded and cleaned up, nothing installed', async () => {
    const x = await graphOf();
    const k = x.schedule.init.indexOf('look#create') + 1;
    for (const [why, move] of [['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const present = presentNow();
        const exec = fake({ during: (op, calls) => { if (calls.run.length === k) move(present); } });
        const out = await instantiate(x, await admitted(x, present), exec, present, new AbortController().signal);
        assert.equal(out.status, 'stopped');
        assert.equal(out.why, why);
        assert.deepEqual(out.ran, x.schedule.init.slice(0, k));
        assert.deepEqual(out.released, cleanupFor(x, new Set(x.schedule.init.slice(0, k).filter(id => creates(x).includes(id)))));
        assert.ok(out.released.includes('look#destroy') && out.released.includes('look#clearBatches'), 'the chain made in the late step is released');
        assert.deepEqual([exec.calls.commit, exec.state.head], [0, 'old']);
    }
});

test('EA-E5 a failed step, a failed release, a failed install: what was made is released, each release tried, nothing installed', async () => {
    const x = await graphOf();
    // The failing create counts as attempted: it may have made something half way.
    const exec = fake({ failAt: 'cube#create', releaseFails: ['field#destroy'] });
    const present = presentNow();
    const out = await instantiate(x, await admitted(x, present), exec, present, new AbortController().signal);
    const upTo = x.schedule.init.slice(0, x.schedule.init.indexOf('cube#create') + 1);
    const expected = cleanupFor(x, new Set(upTo.filter(id => creates(x).includes(id))));
    assert.equal(out.status, 'failed');
    assert.equal(out.error, 'a device error at cube#create');
    assert.deepEqual(out.ran, upTo.slice(0, -1));
    assert.ok(expected.includes('cube#destroy'), 'the failed create is released');
    assert.deepEqual(exec.calls.release, expected, 'every release tried, the failing one too');
    assert.deepEqual(out.released, expected.filter(id => id !== 'field#destroy'));
    assert.deepEqual(out.releaseErrors, ['field#destroy: field#destroy could not release']);
    assert.deepEqual([exec.calls.commit, exec.state.head], [0, 'old']);
    // The preparation fails (EA5's first frame): everything made is released.
    const late = fake({ prepareFails: true });
    const p2 = presentNow();
    const failed = await instantiate(x, await admitted(x, p2), late, p2, new AbortController().signal);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.released, x.schedule.dispose, 'everything X makes');
    assert.deepEqual([late.calls.commit, late.state.head], [0, 'old']);
    // The switch itself throws, having changed nothing: released the same way, the old Head kept.
    const refusing = fake({ commitFails: true });
    const p3 = presentNow();
    const unswitched = await instantiate(x, await admitted(x, p3), refusing, p3, new AbortController().signal);
    assert.deepEqual([unswitched.status, unswitched.error, unswitched.released, refusing.state.head], ['failed', 'the switch failed', x.schedule.dispose, 'old']);
});

test('EA-E6 a cancel after the last step stops before the preparation; a step that rejects because of the cancel is a stop, not a failure', async () => {
    const x = await graphOf();
    const last = x.schedule.init.length;
    const controller = new AbortController();
    const present = presentNow();
    const exec = fake({ during: (op, calls) => { if (calls.run.length === last) controller.abort(); } });
    const out = await instantiate(x, await admitted(x, present), exec, present, controller.signal);
    assert.deepEqual([out.status, out.why, out.released], ['stopped', 'cancelled', x.schedule.dispose]);
    assert.deepEqual([exec.calls.prepare, exec.calls.commit, exec.state.head], [0, 0, 'old']);
    // The executor rejects its step as the signal aborts it: reported as the cancel it is.
    const aborting = new AbortController();
    const p2 = presentNow();
    const rejecting = fake({ during: (op, calls) => { if (calls.run.length === 2) { aborting.abort(); throw new Error('aborted'); } } });
    const stopped = await instantiate(x, await admitted(x, p2), rejecting, p2, aborting.signal);
    assert.deepEqual([stopped.status, stopped.why], ['stopped', 'cancelled']);
});

test('EA-E7 the EA3.5 review: a cancel, a newer turn or a lost device while the switch is prepared stops it; the old Head stays', async () => {
    const x = await graphOf();
    for (const [why, move] of [['cancelled', (p, c) => c.abort()], ['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const present = presentNow();
        const controller = new AbortController();
        // The preparation is deferred: the state moves while it is pending, then it resolves.
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const exec = fake({ preparing: () => pending });
        const out = instantiate(x, await admitted(x, present), exec, present, controller.signal);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(exec.calls.prepare, 1, `${why}: preparing`);
        move(present, controller);
        finish();
        const result = await out;
        assert.deepEqual([result.status, result.why], ['stopped', why], why);
        assert.deepEqual([exec.calls.commit, exec.state.head], [0, 'old'], `${why}: never switched`);
        assert.deepEqual(exec.calls.release, x.schedule.dispose, `${why}: the candidate released once each`);
        assert.equal(new Set(exec.calls.release).size, exec.calls.release.length);
    }
});

test('EA-E8 the EA3.5 review: an executor that cannot open is a structured outcome, its admission spent, nothing to release', async () => {
    const x = await graphOf();
    const present = presentNow();
    const exec = fake({ opening: () => { throw new Error('construction setup failed'); } });
    const admission = await admitted(x, present);
    const out = await instantiate(x, admission, exec, present, new AbortController().signal);
    assert.deepEqual(out, { status: 'failed', error: 'construction setup failed', ran: [], released: [], releaseErrors: [] });
    assert.deepEqual(exec.calls, { instantiate: 1, run: [], release: [], prepare: 0, commit: 0 });
    assert.deepEqual(await instantiate(x, admission, exec, present, new AbortController().signal), { status: 'refused', reason: 'this admission was spent already' });
    // Opening fails as the turn is cancelled, superseded, or the device lost: reported as that stop.
    for (const [why, move] of [['cancelled', (p, c) => c.abort()], ['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const p = presentNow();
        const controller = new AbortController();
        const failing = fake({ opening: () => { move(p, controller); throw new Error('setup gave up'); } });
        const stopped = await instantiate(x, await admitted(x, p), failing, p, controller.signal);
        assert.deepEqual(stopped, { status: 'stopped', why, ran: [], released: [], releaseErrors: [] }, why);
    }
});

test('EA-E9 a switch that returns a promise breaks the contract: reported, and nothing that may now be live is released', async () => {
    const x = await graphOf();
    const present = presentNow();
    const exec = fake();
    const awaiting = { instantiate: (...a) => { const c = exec.instantiate(...a); return { ...c, commit: async () => { c.commit(); } }; } };
    const out = await instantiate(x, await admitted(x, present), awaiting, present, new AbortController().signal);
    assert.deepEqual([out.status, out.released], ['failed', []]);
    assert.match(out.error, /commit returned a promise: the switch must be synchronous/);
});
