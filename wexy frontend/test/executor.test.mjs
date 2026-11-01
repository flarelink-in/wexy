// EA-E series, headless (EA3.5; engine-adapters-design.md §9, §10 EA-U10), bound to the candidate since EA4.3
// (candidate-loop-design.md §9, P8; EA-K7 and EA-K11): the executor seam, driven by a fake executor that counts its calls,
// and a fake gate standing where EA5's device checks will. An admission is issued only for a candidate the host sealed
// (W resolved, X checked and its interfaces derived by the seal itself, since the EA4.3 review; each module's exact
// checked body, every hash recomputed), on device evidence for
// exactly those bodies. Every shut door makes no call at all (a look-alike or copied admission or candidate, another X,
// another candidate, a spent admission, a stale turn, another device, a cancel, a fake compiler's pass, no GPU go). An
// admitted build makes one door call, each init operation in X's order, the preparation, the switch. A stop or a failure
// at any step releases exactly what the attempted creates made, each release once, in dispose order, and installs
// nothing. No device: EA3 and EA4 are static only, and ship no executor and no authority that admits. The device
// evidence here comes from a stand-in compiler labelled `device`, as EA5's will be; production never admits.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkBody, compileBody, scriptedCompiler } from '../src/contract/adapters/bodies.ts';
import { canonicalJson } from '../src/contract/adapters/canonical.ts';
import { checkGraph } from '../src/contract/adapters/checks.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { cleanupFor, resolveProgram } from '../src/contract/adapters/resolve.ts';
import { STATIC_ONLY, createAuthority, instantiate } from '../src/loop/executor.ts';
import { candidateId, isSealed, sealCandidate } from '../src/loop/snapshot.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The nine adapters, with entries a body can define and a tonemapped post chain: X checks and its interfaces derive. */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
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

/** A body for each of the world's modules that passes its lint (EA-M1's). */
const BODIES = {
    motion: [
        'fn advance(index: u32) {',
        '    let base = index * B_instances_STRIDE;',
        '    let f = b_field_current[(index % 1024u) * B_field_STRIDE];',
        '    b_instances[base + 1u] = f32(index) * 0.1;',
        '    b_instances[base + 2u] = sin(camera.simTime + f);',
        '}',
    ].join('\n'),
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
    sky: [
        'fn dusk(uv: vec2<f32>) -> vec4<f32> {',
        '    let f = b_field_current[0] * 0.0;',
        '    return vec4<f32>(uv.x, uv.y, 0.4 + f, 1.0);',
        '}',
    ].join('\n'),
};

async function resolved(program = world(), policy = POLICY_V1) {
    const r = await resolveProgram(program, policy);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const x = r.graph;
    // Checked under the policy X was resolved under: another refuses it ("resolve it again under this one").
    return { x, checked: await checkGraph(x, policy), interfaces: await deriveInterfaces(x) };
}

/** The input the host seals: W, the X its evidence names, and a body for each module (`bodies` overrides some). */
async function sealInput(program = world(), policy = POLICY_V1, bodies = BODIES) {
    const { x, interfaces } = await resolved(program, policy);
    return {
        attempt: 'attempt-1', revision: 3, program, graph: x.hash,
        bodies: (interfaces.ok ? interfaces.interfaces : []).map(i => ({ module: i.module, interfaceHash: i.interfaceHash, body: bodies[i.module] })),
    };
}

/** A candidate the host sealed, W resolved under `policy` (the host's own unless a test stands in another). */
async function sealed(program = world(), policy = POLICY_V1, bodies = BODIES) {
    const s = await sealCandidate(await sealInput(program, policy, bodies), { policy });
    assert.equal(s.ok, true, s.reason);
    return s.snapshot;
}

/** A stand-in for EA5's device compiler, labelled as one: what it says passes. */
const DEVICE = { producedBy: 'device', compile: async () => [] };

/** Device evidence for each of the snapshot's bodies, as EA5 will gather it, with the GPU go. */
async function evidence(snap, { gpuGo = true, compiler = DEVICE } = {}) {
    const compiled = [];
    for (const b of snap.bodies) {
        const iface = snap.interfaces.find(i => i.module === b.module);
        compiled.push(await compileBody(iface, await checkBody(iface, b.body), compiler));
    }
    return { compiled, gpuGo };
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
    const state = { head: 'old', opened: null };
    return {
        calls,
        state,
        instantiate(snapshot, admission) {
            calls.instantiate++;
            state.opened = { snapshot, admission };
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

const admitted = async (snap, present) => {
    const a = ADMIT.admit(snap, await evidence(snap), present);
    assert.equal(a.ok, true, a.reason);
    return a.admission;
};
const creates = x => x.schedule.init.filter(id => x.operations.find(o => o.id === id).kind === 'create');
const NO_CALL = { instantiate: 0, run: [], release: [], prepare: 0, commit: 0 };

test('EA-E1 every shut door makes no executor call: forged, copied, unsealed, another X or candidate, spent, stale, another device, cancelled', async () => {
    const snap = await sealed();
    const x = snap.x;
    const present = presentNow();
    const signal = new AbortController().signal;
    const shut = async (label, admission, reason, candidate = snap, p = present, s = signal) => {
        const exec = fake();
        const out = await instantiate(candidate, admission, exec, p, s);
        assert.deepEqual(out, { status: 'refused', reason }, label);
        assert.deepEqual(exec.calls, NO_CALL, `${label}: no call`);
    };
    // EA3 and EA4 ship no authority that admits.
    assert.deepEqual(STATIC_ONLY.admit(snap, await evidence(snap), present), { ok: false, reason: 'EA3 is static only (Q75): admissions come with EA5\'s device checks and the GPU go' });
    const real = await admitted(snap, present);
    await shut('a look-alike object', { graph: x.hash, candidate: snap.id, policy: x.identity.policyHash, turn: 1, device: 1 }, 'not an admission the host issued');
    await shut('a copy of a real one', structuredClone(real), 'not an admission the host issued');
    await shut('a copy of the candidate', real, 'not a candidate the host sealed', structuredClone(snap));
    const other = world();
    other[0].config = JSON.stringify({ elements: 32, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' });
    await shut('another X', real, 'this admission is for another X', await sealed(other));
    // A changed policy is another X: its identity, and so its hash, differ.
    const p2 = { ...POLICY_V1, label: 'fixture: another policy', maxFixedSteps: 2 };
    await shut('another policy', real, 'this admission is for another X', await sealed(world(), p2));
    // The same X with another body is another candidate: id(C) covers the bodies.
    const rewritten = await sealed(world(), POLICY_V1, { ...BODIES, sky: `// a second dusk\n${BODIES.sky}` });
    assert.equal(rewritten.x.hash, x.hash);
    await shut('another candidate under the same X', real, 'this admission is for another candidate', rewritten);
    const stale = presentNow();
    const forStale = await admitted(snap, stale);
    stale.t = 2;
    await shut('a turn that moved on', forStale, 'superseded before construction', snap, stale);
    const lost = presentNow();
    const forLost = await admitted(snap, lost);
    lost.d = 2;
    await shut('a device lost', forLost, 'device-lost before construction', snap, lost);
    const cancelled = new AbortController();
    cancelled.abort();
    await shut('a cancel before the door', await admitted(snap, present), 'cancelled before construction', snap, present, cancelled.signal);
    // Spent: one door call, then the same admission opens nothing.
    const once = await admitted(snap, present);
    const exec = fake();
    assert.equal((await instantiate(snap, once, exec, present, signal)).status, 'installed');
    assert.deepEqual(await instantiate(snap, once, exec, present, signal), { status: 'refused', reason: 'this admission was spent already' });
    assert.equal(exec.calls.instantiate, 1);
    // The door hands the executor the sealed snapshot itself: its X and the exact bodies it sealed.
    assert.equal(exec.state.opened.snapshot, snap);
    assert.equal(exec.state.opened.admission, once);
});

test('EA-E1b the host seals only a checked candidate; the authority admits only a sealed one, with the GPU go and the gate', async () => {
    const present = presentNow();
    // Sealing refuses what the old authority refused: X failing its checks, interfaces that cannot be derived.
    const nothing = await sealInput([node('field', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' })]);
    assert.deepEqual(await sealCandidate(nothing), { ok: false, reason: 'X does not pass its checks' });
    const step = world();
    step[2].config = JSON.stringify({ module: 'motion', entry: 'step', workgroupSize: 64, invocations: 64, phase: 'fixedStep' });
    assert.deepEqual(await sealCandidate(await sealInput(step)), { ok: false, reason: 'X\'s module interfaces cannot be derived' });
    // The seal resolves W itself (the EA4.3 review), and holds it to the X the caller's evidence names: a W that does not
    // resolve, another W, or the same W under another policy is refused, whatever bodies come with it.
    const good = await sealInput();
    const unresolved = world();
    unresolved[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    assert.deepEqual(await sealCandidate({ ...good, program: unresolved }), { ok: false, reason: 'W does not resolve: EA_RESOLVE /nodes/1/config/elements' });
    const otherW = world();
    otherW[0].config = JSON.stringify({ elements: 32, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' });
    const elsewhere = { ok: false, reason: 'W resolves to another X than the one its evidence is for' };
    assert.deepEqual(await sealCandidate({ ...good, program: otherW }), elsewhere);
    assert.deepEqual(await sealCandidate({ ...good, graph: (await sealInput(otherW)).graph }), elsewhere);
    assert.deepEqual(await sealCandidate(good, { policy: { ...POLICY_V1, label: 'fixture: another policy', maxFixedSteps: 2 } }), elsewhere);
    assert.equal((await sealCandidate(good)).ok, true);

    const snap = await sealed();
    const refused = (label, candidate, ev, reason, authority = ADMIT) => assert.deepEqual(authority.admit(candidate, ev, present), { ok: false, reason }, label);
    const ev = await evidence(snap);
    refused('a candidate the host did not seal', structuredClone(snap), ev, 'not a candidate the host sealed');
    refused('no GPU go', snap, { ...ev, gpuGo: false }, 'no GPU go: the host gives it, never a program');
    refused('the gate says no', snap, ev, 'the device lacks a limit', createAuthority(() => 'the device lacks a limit'));
    const a = ADMIT.admit(snap, ev, present);
    assert.deepEqual(a.ok && { ...a.admission }, { graph: snap.x.hash, candidate: snap.id, policy: snap.x.identity.policyHash, turn: 1, device: 1 });
    assert.ok(Object.isFrozen(a.admission));
});

test('EA-E2 an admitted build: one door call, each init operation in X\'s order, one preparation, one switch, no release', async () => {
    const snap = await sealed();
    const x = snap.x;
    const exec = fake();
    const out = await instantiate(snap, await admitted(snap, presentNow()), exec, presentNow(), new AbortController().signal);
    assert.deepEqual(out, { status: 'installed', ran: [...x.schedule.init] });
    assert.deepEqual(exec.calls, { instantiate: 1, run: [...x.schedule.init], release: [], prepare: 1, commit: 1 });
    assert.equal(exec.state.head, 'candidate');
});

test('EA-E3 a cancel after any step stops before the next, releases what was attempted, once each in dispose order, installs nothing', async () => {
    const snap = await sealed();
    const x = snap.x;
    const init = x.schedule.init;
    for (let k = 1; k <= init.length; k++) {
        const controller = new AbortController();
        const present = presentNow();
        const exec = fake({ during: (op, calls) => { if (calls.run.length === k) controller.abort(); } });
        const out = await instantiate(snap, await admitted(snap, present), exec, present, controller.signal);
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
    const snap = await sealed();
    const x = snap.x;
    const k = x.schedule.init.indexOf('look#create') + 1;
    for (const [why, move] of [['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const present = presentNow();
        const exec = fake({ during: (op, calls) => { if (calls.run.length === k) move(present); } });
        const out = await instantiate(snap, await admitted(snap, present), exec, present, new AbortController().signal);
        assert.equal(out.status, 'stopped');
        assert.equal(out.why, why);
        assert.deepEqual(out.ran, x.schedule.init.slice(0, k));
        assert.deepEqual(out.released, cleanupFor(x, new Set(x.schedule.init.slice(0, k).filter(id => creates(x).includes(id)))));
        assert.ok(out.released.includes('look#destroy'), 'the chain made in the late step is released: its destroy frees its batches and passes too (1.2.1)');
        assert.deepEqual([exec.calls.commit, exec.state.head], [0, 'old']);
    }
});

test('EA-E5 a failed step, a failed release, a failed install: what was made is released, each release tried, nothing installed', async () => {
    const snap = await sealed();
    const x = snap.x;
    // The failing create counts as attempted: it may have made something half way.
    const exec = fake({ failAt: 'cube#create', releaseFails: ['field#destroy'] });
    const present = presentNow();
    const out = await instantiate(snap, await admitted(snap, present), exec, present, new AbortController().signal);
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
    const failed = await instantiate(snap, await admitted(snap, p2), late, p2, new AbortController().signal);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.released, x.schedule.dispose, 'everything X makes');
    assert.deepEqual([late.calls.commit, late.state.head], [0, 'old']);
    // The switch itself throws, having changed nothing: released the same way, the old Head kept.
    const refusing = fake({ commitFails: true });
    const p3 = presentNow();
    const unswitched = await instantiate(snap, await admitted(snap, p3), refusing, p3, new AbortController().signal);
    assert.deepEqual([unswitched.status, unswitched.error, unswitched.released, refusing.state.head], ['failed', 'the switch failed', x.schedule.dispose, 'old']);
});

test('EA-E6 a cancel after the last step stops before the preparation; a step that rejects because of the cancel is a stop, not a failure', async () => {
    const snap = await sealed();
    const x = snap.x;
    const last = x.schedule.init.length;
    const controller = new AbortController();
    const present = presentNow();
    const exec = fake({ during: (op, calls) => { if (calls.run.length === last) controller.abort(); } });
    const out = await instantiate(snap, await admitted(snap, present), exec, present, controller.signal);
    assert.deepEqual([out.status, out.why, out.released], ['stopped', 'cancelled', x.schedule.dispose]);
    assert.deepEqual([exec.calls.prepare, exec.calls.commit, exec.state.head], [0, 0, 'old']);
    // The executor rejects its step as the signal aborts it: reported as the cancel it is.
    const aborting = new AbortController();
    const p2 = presentNow();
    const rejecting = fake({ during: (op, calls) => { if (calls.run.length === 2) { aborting.abort(); throw new Error('aborted'); } } });
    const stopped = await instantiate(snap, await admitted(snap, p2), rejecting, p2, aborting.signal);
    assert.deepEqual([stopped.status, stopped.why], ['stopped', 'cancelled']);
});

test('EA-E7 the EA3.5 review: a cancel, a newer turn or a lost device while the switch is prepared stops it; the old Head stays', async () => {
    const snap = await sealed();
    const x = snap.x;
    for (const [why, move] of [['cancelled', (p, c) => c.abort()], ['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const present = presentNow();
        const controller = new AbortController();
        // The preparation is deferred: the state moves while it is pending, then it resolves.
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const exec = fake({ preparing: () => pending });
        const out = instantiate(snap, await admitted(snap, present), exec, present, controller.signal);
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
    const snap = await sealed();
    const present = presentNow();
    const exec = fake({ opening: () => { throw new Error('construction setup failed'); } });
    const admission = await admitted(snap, present);
    const out = await instantiate(snap, admission, exec, present, new AbortController().signal);
    assert.deepEqual(out, { status: 'failed', error: 'construction setup failed', ran: [], released: [], releaseErrors: [] });
    assert.deepEqual(exec.calls, { instantiate: 1, run: [], release: [], prepare: 0, commit: 0 });
    assert.deepEqual(await instantiate(snap, admission, exec, present, new AbortController().signal), { status: 'refused', reason: 'this admission was spent already' });
    // Opening fails as the turn is cancelled, superseded, or the device lost: reported as that stop.
    for (const [why, move] of [['cancelled', (p, c) => c.abort()], ['superseded', p => { p.t++; }], ['device-lost', p => { p.d++; }]]) {
        const p = presentNow();
        const controller = new AbortController();
        const failing = fake({ opening: () => { move(p, controller); throw new Error('setup gave up'); } });
        const stopped = await instantiate(snap, await admitted(snap, p), failing, p, controller.signal);
        assert.deepEqual(stopped, { status: 'stopped', why, ran: [], released: [], releaseErrors: [] }, why);
    }
});

test('EA-E9 a switch that returns a promise breaks the contract: reported, and nothing that may now be live is released', async () => {
    const snap = await sealed();
    const present = presentNow();
    const exec = fake();
    const awaiting = { instantiate: (...a) => { const c = exec.instantiate(...a); return { ...c, commit: async () => { c.commit(); } }; } };
    const out = await instantiate(snap, await admitted(snap, present), awaiting, present, new AbortController().signal);
    assert.deepEqual([out.status, out.released], ['failed', []]);
    assert.match(out.error, /commit returned a promise: the switch must be synchronous/);
});

test('EA-K7 P8: a candidate whose bodies changed after its checks is not admitted, and opens no door', async () => {
    const present = presentNow();
    const snap = await sealed();
    const ev = await evidence(snap);
    // The sealed candidate cannot change: every level is frozen, so a late write throws.
    assert.ok(isSealed(snap) && Object.isFrozen(snap) && Object.isFrozen(snap.bodies[0]) && Object.isFrozen(snap.x.operations));
    assert.throws(() => { snap.bodies[0].body = 'fn advance(index: u32) {}'; }, TypeError);
    // A body changed after its checks, as a copy of the candidate: not one the host sealed, so nothing admits or opens it.
    const changed = structuredClone(snap);
    changed.bodies.find(b => b.module === 'motion').body = BODIES.motion.replace('* 0.1', '* 0.2');
    assert.deepEqual(ADMIT.admit(changed, ev, present), { ok: false, reason: 'not a candidate the host sealed' });
    const exec = fake();
    assert.deepEqual(await instantiate(changed, await admitted(snap, present), exec, present, new AbortController().signal), { status: 'refused', reason: 'not a candidate the host sealed' });
    assert.deepEqual(exec.calls, NO_CALL);
    // Sealed again with the new body, it is another candidate: the old body's device evidence does not admit it, and the
    // old candidate's admission does not open its door.
    const resealed = await sealed(world(), POLICY_V1, { ...BODIES, motion: changed.bodies.find(b => b.module === 'motion').body });
    assert.notEqual(resealed.id, snap.id);
    assert.deepEqual(ADMIT.admit(resealed, ev, present), { ok: false, reason: 'the compile verdict for motion is for another body than this candidate\'s' });
    assert.deepEqual(await instantiate(resealed, await admitted(snap, present), exec, present, new AbortController().signal), { status: 'refused', reason: 'this admission is for another candidate' });
    assert.deepEqual(exec.calls, NO_CALL);
});

test('EA-K11 the seal recomputes every hash and holds the module set exactly; a fake pass or partial device evidence admits nothing', async () => {
    const present = presentNow();
    const input = await sealInput();
    const seal = async (label, change, reason) => assert.deepEqual(await sealCandidate(change(structuredClone(input))), { ok: false, reason }, label);
    // Caller-supplied hashes are not proof: a claimed codeHash that is not the text's is refused; the right one is taken.
    await seal('a claimed hash of another text', i => { i.bodies[0].codeHash = sha('something else'); return i; }, `module ${input.bodies[0].module}'s body is not the text its codeHash names`);
    assert.equal((await sealCandidate({ ...input, bodies: input.bodies.map(b => ({ ...b, codeHash: sha(b.body) })) })).ok, true);
    await seal('a module missing', i => { i.bodies = i.bodies.filter(b => b.module !== 'sky'); return i; }, 'module sky has no body');
    await seal('an extra module', i => { i.bodies.push({ ...i.bodies[0], module: 'extra' }); return i; }, 'module extra is not one of X\'s');
    await seal('a module twice', i => { i.bodies.push({ ...i.bodies[0] }); return i; }, `module ${input.bodies[0].module} has two bodies`);
    await seal('a body for another interface', i => { i.bodies[0].interfaceHash = '0'.repeat(64); return i; }, `module ${input.bodies[0].module}'s body was written for another interface`);
    // A body the host's own lint refuses is never sealed, whatever a caller says of it.
    await seal('a body that fails the host\'s lint', i => { i.bodies.find(b => b.module === 'sky').body = 'fn dusk(uv: vec2<f32>) -> vec4<f32> { return noise2(uv); }'; return i; },
        'module sky\'s body does not pass the host\'s lint');
    // The EA4.3 review's probes. The seal takes no X, checks or interfaces from its caller: X with its operations removed
    // and its init schedule emptied, interfaces with a storage binding added to each preamble (each keeping its hash), and
    // passing checks claimed for them are not what it seals. It seals the resolver's X, and its own checks and interfaces.
    const own = await resolved();
    const added = '@group(0) @binding(7) var<storage, read_write> b_extra: array<f32>;';
    const forged = await sealCandidate({
        ...structuredClone(input), x: { ...own.x, operations: [], schedule: { ...own.x.schedule, init: [] } }, checked: own.checked,
        interfaces: { ok: true, graph: own.x.hash, interfaces: own.interfaces.interfaces.map(i => ({ ...i, preamble: `${i.preamble}\n${added}` })) },
    });
    assert.equal(forged.ok, true, forged.reason);
    assert.deepEqual(forged.snapshot.x, own.x, 'the resolver\'s X, its operations and init schedule whole');
    assert.deepEqual(forged.snapshot.checked, own.checked);
    assert.deepEqual(forged.snapshot.interfaces, own.interfaces.interfaces, 'its own interfaces, no binding a caller added');
    // Empty interface and body lists for X's three modules: the module set is X's, and each of its modules needs a body.
    await seal('empty interface and body lists', i => { i.interfaces = { ok: true, graph: i.graph, interfaces: [] }; i.bodies = []; return i; },
        `module ${input.bodies[0].module} has no body`);
    // Custom lighting stays gated at the seal, whatever the body, as the machine gates it before any call (the design §6).
    const lit = world().map(n => (n.id === 'water' ? { ...n, inputs: [...n.inputs, from('lights', 'sun', 'lights')] } : n));
    const litInput = await sealInput(lit);
    assert.ok(litInput.bodies.some(b => b.module === 'water' && typeof b.body === 'string'));
    assert.match((await sealCandidate(litInput)).reason, /^module water cannot be authored yet: water is a custom batch wired to lights/);

    // id(C): SHA-256 of canonical {graph, modules: [[m, interfaceHash, codeHash], …]} in code-unit order of m, whatever
    // order the bodies came in, and from the hashes the host computed.
    const snap = await sealed();
    assert.equal(forged.snapshot.id, snap.id, 'and so the candidate of the X and bodies it holds');
    assert.deepEqual(snap.bodies.map(b => b.module), [...new Set(snap.x.modules.map(m => m.module))].sort(), 'one body for each of X\'s modules');
    const modules = snap.bodies.map(b => [b.module, b.interfaceHash, sha(b.body)]).sort((p, q) => (p[0] < q[0] ? -1 : 1));
    assert.equal(snap.id, sha(canonicalJson({ graph: snap.x.hash, modules })));
    assert.deepEqual(snap.bodies.map(b => b.codeHash), snap.bodies.map(b => sha(b.body)));
    const reversed = await sealCandidate({ ...input, bodies: [...input.bodies].reverse() });
    assert.equal(reversed.snapshot.id, snap.id);
    // The modules sort in code-unit order, never locale order: `B` before `a`, whatever order they are given in.
    const h = (c) => c.repeat(64);
    const pair = [['a', h('1'), h('2')], ['B', h('3'), h('4')]];
    assert.equal(await candidateId(h('0'), pair), sha(canonicalJson({ graph: h('0'), modules: [pair[1], pair[0]] })));
    assert.equal(await candidateId(h('0'), [pair[1], pair[0]]), await candidateId(h('0'), pair));

    // Device evidence covers exactly the sealed bodies, from a device.
    const ev = await evidence(snap);
    const refused = (label, compiled, reason) => assert.deepEqual(ADMIT.admit(snap, { compiled, gpuGo: true }, present), { ok: false, reason }, label);
    refused('a fake compiler\'s pass', (await evidence(snap, { compiler: scriptedCompiler([]) })).compiled,
        `${snap.bodies[0].module} was compiled by a fake, which proves nothing about this device`);
    refused('a module with no verdict', ev.compiled.filter(c => c.module !== 'sky'), 'module sky has no compile verdict from this device');
    refused('a module judged twice', [...ev.compiled, ev.compiled[0]], `module ${ev.compiled[0].module} has two compile verdicts`);
    refused('a verdict for a module not in the candidate', [...ev.compiled, { ...ev.compiled[0], module: 'extra' }], 'module extra is not one of this candidate\'s');
    // The device refuses one body: its line is on the body, so the door stays shut.
    const failing = { producedBy: 'device', compile: async (source) => [{ line: source.split('\n').indexOf(BODIES.sky.split('\n')[1]) + 1, message: 'unresolved value', type: 'error' }] };
    const skyIface = snap.interfaces.find(i => i.module === 'sky');
    const skyFails = await compileBody(skyIface, await checkBody(skyIface, BODIES.sky), failing);
    refused('a body the device does not compile', ev.compiled.map(c => (c.module === 'sky' ? skyFails : c)), 'sky does not compile on this device');
    // STATIC_ONLY admits nothing, whatever the evidence.
    assert.equal(STATIC_ONLY.admit(snap, ev, present).ok, false);
    assert.equal(ADMIT.admit(snap, ev, present).ok, true, 'and the complete device evidence admits');
    // No compile verdict is needed only where X has no module: an empty set is X's own, never one a caller brings.
    const none = await sealed(world().filter(n => !['move', 'water', 'sky', 'field'].includes(n.id)));
    assert.deepEqual([none.bodies, none.x.modules], [[], []]);
    assert.equal(ADMIT.admit(none, { compiled: [], gpuGo: true }, present).ok, true);
});
