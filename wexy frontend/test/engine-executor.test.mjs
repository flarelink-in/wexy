// EA-D1, D2, D5, D9, D12, D13, headless (EA5.2; executor-design.md §8, §10, where these were EA-X1, X2, X5, X9, X12, X13):
// the engine executor and the agent runtime over a fake engine port that keeps every handle it made and fails or holds a
// call when a test says. The three live candidates of 2026-11-01 (test/fixtures/live-candidates) and synthetic worlds
// with what those lack (storage buffers, ping-pong pairs, copies). No GPU.
//   EA-D1  every create of each live candidate's X, in schedule order, once, with X's arguments; a call outside the
//          allowlist refuses
//   EA-D2  a stop at each init operation: cleanupFor's releases, each once, every handle made freed once, nothing installed
//   EA-D5  R against X's schedules: step, draw, resize, reset, destroy
//   EA-D9  no generated GPU work before the preparation approves it, init's included; no preparation, no work and all freed
//   EA-D12 a cancel or a device loss across a compile's await: the late handle released once, nothing installed; a create
//          that fails half way frees what it made
//   EA-D13 0, 1 and 4 fixed steps, copies, swaps and post work in exact order and parity, and no per-frame allocation
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assembleModule, checkBody, compileBody } from '../src/contract/adapters/bodies.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { cleanupFor, resolveProgram } from '../src/contract/adapters/resolve.ts';
import { HOST_DT, createEngineExecutor } from '../src/exec/engine-executor.ts';
import { createAuthority, instantiate } from '../src/loop/executor.ts';
import { LIVE, fakePort, from, live, node, present, sealed, sealedLive } from './exec-fakes.mjs';

/** An admission on stand-in device evidence (the gate is EA5.3's, gate.test.mjs; provenance is EA-D8's). */
async function admitted(snap, now) {
    const DEVICE = { producedBy: 'device', compile: async () => [] };
    const compiled = [];
    for (const b of snap.bodies) {
        const iface = snap.interfaces.find(i => i.module === b.module);
        compiled.push(await compileBody(iface, await checkBody(iface, b.body), DEVICE));
    }
    const r = createAuthority(() => null).admit(snap, { compiled, gpuGo: true }, now);
    assert.equal(r.ok, true, r.reason);
    return r.admission;
}

/** An instantiation through the coordinator: the executor over `port`, a preparation (approving by default), the switch. */
async function build(snap, port, { prepare = async w => { w.runInit(); }, signal = new AbortController().signal, now = present() } = {}) {
    const installed = [];
    const executor = createEngineExecutor({ port, onCommit: r => installed.push(r), ...(prepare ? { prepare } : {}) });
    const outcome = await instantiate(snap, await admitted(snap, now), executor, now, signal);
    return { outcome, runtime: installed[0] ?? null, installed };
}

/** What a create call looks like in the fake's log, as X wrote its arguments. */
function expectedCall(x, snap, op) {
    const a = op.args;
    switch (op.call) {
        case 'geometry.primitive': return `primitive ${a.factory} ${a.params.join(',')}`;
        case 'materials.create': return `material ${a.class} ${JSON.stringify(a.options)}`;
        case 'lights.LightSystem': return `lightSystem ${JSON.stringify(a.capacity)}`;
        case 'lights.upload': return `uploadLights ${a.points.length} points`;
        case 'post.PostChain': return `postChain ${a.effects.map(e => `${e.effect}:${e.intensity}`).join(',')}`;
        case 'engine.createPass': return `createPass ${op.id}${a.attachments === 'post.sceneAttachments' ? ' into the chain' : ''}`;
        case 'engine.createComputeStage': return `createComputeStage ${op.id}`;
        case 'device.createBuffer': return `createBuffer ${op.id}/0 ${a.bytes}`;
        case 'engine.createBatch': {
            const shader = a.shader.kind === 'stock' ? `stock:${a.shader.material}${a.shader.lights ? '+lights' : ''}` : 'module';
            return `createBatch ${op.id} ${shader} ${a.strideFloats}x${a.maxInstances} ${a.target === 'canvas' ? 'bgra8unorm' : a.target}`;
        }
        default: return null;
    }
}

test('EA-D1 the three live candidates: every create of X once, in schedule order, with X\'s arguments; a call outside the allowlist refuses', async () => {
    for (const name of LIVE) {
        const snap = await sealedLive(name);
        const x = snap.x;
        const op = id => x.operations.find(o => o.id === id);
        const port = fakePort();
        const { outcome, runtime } = await build(snap, port);
        assert.equal(outcome.status, 'installed', `${name}: ${JSON.stringify(outcome)}`);
        assert.deepEqual(outcome.ran, x.schedule.init, `${name}: every init operation, in X's order`);
        // Each create made one port call, in X's order, with X's arguments.
        const expected = x.schedule.init.map(id => expectedCall(x, snap, op(id))).filter(Boolean);
        const made = port.log.filter(l => /^(primitive|material|lightSystem|uploadLights|postChain|createPass|createComputeStage|createBuffer|createBatch) /.test(l));
        assert.deepEqual(made, expected, `${name}: one call a create`);
        // A stage's module is the sealed body in its assembled module, byte for byte (I6).
        for (const stage of [...port.live.keys()].filter(h => h.kind === 'stage')) {
            const o = op(stage.label);
            const iface = snap.interfaces.find(i => i.module === o.args.module);
            const body = snap.bodies.find(b => b.module === o.args.module);
            assert.equal(stage.code, assembleModule(iface, body.body).source, `${name}: ${stage.label}'s module`);
            assert.deepEqual([stage.workgroups, stage.size], [o.args.dispatch, o.args.workgroupSize]);
        }
        // Every adopted buffer is the batch's own storage, which the stages bind (Q76(b)).
        for (const r of x.resources.filter(r => r.owner === 'engine' && r.id.endsWith('#buffer'))) {
            const batch = r.createdBy.slice(0, r.createdBy.indexOf('#'));
            assert.ok(port.log.some(l => l.startsWith('computeGroup ') && l.includes(`${batch}#create/storage`)), `${name}: ${r.id} bound as ${batch}'s storage`);
        }
        // Each batch draws the instances its draw names (the buffer's elements), never its maximum.
        for (const draw of x.operations.filter(o => o.call === 'pass.drawBatch')) {
            assert.ok(port.log.includes(`setInstances ${draw.node}#create ${draw.args.instances}`), `${name}: ${draw.node} draws ${draw.args.instances}`);
        }
        assert.equal(runtime.dt, HOST_DT);
        runtime.destroy();
        assert.deepEqual([[...port.live.values()], port.errors], [[], []], `${name}: everything made is freed once`);
    }

    // The executor's own allowlist, under a look-alike X whose one call is not on it: refused, never run.
    const snap = await sealedLive('block-film');
    const forged = structuredClone(snap);
    forged.x.operations.find(o => o.id === 'cube#create').call = 'device.destroy';
    const executor = createEngineExecutor({ port: fakePort(), onCommit: () => {} });
    const construction = executor.instantiate(forged, { graph: snap.x.hash, candidate: snap.id }, new AbortController().signal);
    await assert.rejects(construction.run('cube#create'), /^Error: EA_CALL cube#create: device\.destroy is not one the executor runs$/);
    await assert.rejects(construction.run('cube#destroy'), /not an init operation of this X/);
});

test('EA-D2 a stop at each init operation: cleanupFor\'s releases, each once; every handle made freed once; nothing installed', async () => {
    const snap = await sealedLive('foggy-dusk');
    const x = snap.x;
    const creates = new Set(x.operations.filter(o => o.kind === 'create').map(o => o.id));
    for (let k = 0; k < x.schedule.init.length; k++) {
        const at = x.schedule.init[k];
        const call = expectedCall(x, snap, x.operations.find(o => o.id === at));
        if (!call) continue; // a deferred dispatch makes nothing to stop at; EA-D9 covers it
        const port = fakePort({ fail: entry => entry === call });
        const { outcome, installed } = await build(snap, port);
        assert.equal(outcome.status, 'failed', at);
        const attempted = new Set(x.schedule.init.slice(0, k + 1).filter(id => creates.has(id)));
        assert.deepEqual(outcome.released, cleanupFor(x, attempted), `${at}: cleanupFor's releases, in dispose order`);
        assert.deepEqual([[...port.live.values()], port.errors, installed.length], [[], [], 0], `${at}: everything made freed once, nothing installed`);
        assert.ok(!port.log.some(l => l.startsWith('render')), `${at}: nothing submitted`);
    }
    // A release is idempotent (the seam's contract): run twice, or after the whole dispose, it frees nothing again.
    const port = fakePort();
    const construction = createEngineExecutor({ port, onCommit: () => {} }).instantiate(snap, { graph: x.hash, candidate: snap.id }, new AbortController().signal);
    for (const id of x.schedule.init) await construction.run(id);
    for (const id of [...x.schedule.dispose, ...x.schedule.dispose]) await construction.release(id);
    assert.deepEqual([[...port.live.values()], port.errors], [[], []]);
});

test('EA-D5 R against X\'s schedules: a step, a frame, a resize, a reset to time zero, and a destroy', async () => {
    // galaxy: a fixed-step stage and the host's clock; one frame submission of the pass and the post passes.
    const galaxy = await sealedLive('galaxy');
    const port = fakePort();
    const { runtime } = await build(galaxy, port);
    const mark = port.log.length;
    runtime.step();
    runtime.step();
    assert.deepEqual(port.log.slice(mark), [
        `writeBuffer @host#createSim/0 dt=${HOST_DT.toFixed(5)} time=0.00000 step=0`, 'render [spin#create]',
        `writeBuffer @host#createSim/0 dt=${HOST_DT.toFixed(5)} time=${HOST_DT.toFixed(5)} step=1`, 'render [spin#create]',
    ], 'each step: its own clock, then its dispatch');
    assert.equal(runtime.simTime, 2 * HOST_DT);
    runtime.view({ target: [0, 0, 0], distance: 9, azimuth: 0, polar: 1, fov: 45 }, runtime.simTime);
    const frameAt = port.log.length;
    const sequence = runtime.draw();
    assert.deepEqual(port.log.slice(frameAt), ['postUpload'], 'the frame\'s host action first');
    assert.deepEqual(sequence.map(s => s.label), ['main', 'post/0', 'post/1'], 'then one submission: the pass, the post passes');
    assert.ok(port.log.includes(`updateCamera 9 at ${(2 * HOST_DT).toFixed(3)} aspect ${(1280 / 720).toFixed(3)}`));
    runtime.view({ target: [0, 0, 0], distance: 9, azimuth: 0, polar: 1, fov: 45 }, 5);
    assert.equal(port.log.at(-1), `updateCamera 9 at 5.000 aspect ${(1280 / 720).toFixed(3)}`, 'the seconds the caller gives (a film\'s frame time), not the clock\'s');
    runtime.resize(640, 360);
    assert.ok(port.log.includes('postResize 640x360'));
    assert.deepEqual(runtime.draw().map(s => s.label), ['main', 'post/640'], 'the frame lowered again after the chain recompiled');
    // A reset: the zero-declared buffers cleared (the adopted stars among them), the clock at zero, init run again.
    const resetAt = port.log.length;
    runtime.reset();
    assert.deepEqual(port.log.slice(resetAt), ['clearBuffer backdrop#create/storage', 'clearBuffer galaxy#create/storage', 'postResize 640x360', 'render [seed#create]'],
        'every zero-declared buffer cleared, in X\'s order; the chain re-resolved at the world\'s size, so its history starts from zero (the EA5.2\n'
        + 'review); then init\'s work again; no group reinstalled, as none binds a pair');
    assert.deepEqual([runtime.simTime, runtime.steps], [0, 0]);
    runtime.destroy();
    runtime.destroy();
    assert.deepEqual([[...port.live.values()], port.errors], [[], []], 'destroy releases everything once, twice or not');
    // After destroy, no call touches what it released (the EA5.2 review): a step, a frame, a resize, a reset do nothing.
    const gone = port.log.length;
    runtime.step();
    runtime.view({ target: [0, 0, 0], distance: 9, azimuth: 0, polar: 1, fov: 45 }, 1);
    assert.deepEqual(runtime.draw(), []);
    runtime.resize(320, 180);
    runtime.reset();
    runtime.runInit();
    assert.deepEqual(port.log.slice(gone), [], 'nothing after destroy');

    // foggy-dusk: a frame stage, its dispatch in the frame's one submission before the pass; no fixed step at all.
    const foggy = await sealedLive('foggy-dusk');
    const fport = fakePort();
    const built = await build(foggy, fport);
    const before = fport.log.length;
    built.runtime.step();
    assert.deepEqual(fport.log.slice(before), [], 'an empty fixed step submits nothing');
    assert.deepEqual(built.runtime.draw().map(s => s.label), ['driftfog#create', 'main', 'post/0', 'post/1']);
    built.runtime.destroy();
});

/**
 * A world with what the live ones lack: a pair an init stage writes and swaps, a pair a fixed-step stage writes and swaps
 * each step (Tier 1 gives a pair one writer), and a storage buffer copied into its batch each frame.
 */
function synthetic() {
    return [
        node('ground', 'ng.buffer.storage', { elements: 1024, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('seed', 'ng.compute.stage', { module: 'seed', entry: 'plant', workgroupSize: 64, invocations: 1024, phase: 'init' },
            [from('reads', 'ground', 'buffer'), from('writes', 'ground', 'buffer')]),
        node('field', 'ng.buffer.storage', { elements: 1024, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('flow', 'ng.compute.stage', { module: 'flow', entry: 'advect', workgroupSize: 64, invocations: 1024, phase: 'fixedStep' },
            [from('reads', 'ground', 'buffer'), from('reads', 'field', 'buffer'), from('writes', 'field', 'buffer')]),
        node('cells', 'ng.buffer.storage', { elements: 32, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('paint', 'ng.compute.stage', { module: 'paint', entry: 'tint', workgroupSize: 32, invocations: 32, phase: 'frame' },
            [from('reads', 'field', 'buffer'), from('writes', 'cells', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'basic', baseColor: [1, 1, 1, 1] }),
        // 40 instances, more than the 32 cells: the copy fallback (Q76(b)), each frame since paint writes them.
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 40 }, [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'cells', 'buffer')]),
        node('look', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ];
}
const SYNTHETIC_BODIES = {
    seed: 'fn plant(index: u32) {\n    b_ground_next[index * B_ground_STRIDE] = f32(index) + b_ground_current[0] * 0.0;\n}',
    flow: 'fn advect(index: u32) {\n    b_field_next[index * B_field_STRIDE] = b_field_current[index * B_field_STRIDE] + b_ground_current[index * B_ground_STRIDE] * sim.dt;\n}',
    paint: 'fn tint(index: u32) {\n    b_cells[index * B_cells_STRIDE + 11u] = b_field_current[index * B_field_STRIDE];\n}',
};

test('EA-D9 no generated GPU work before the preparation approves it, init\'s dispatches, swaps and copies included', async () => {
    const snap = await sealed(synthetic(), SYNTHETIC_BODIES);
    const x = snap.x;
    assert.ok(x.schedule.init.some(id => /#dispatch$/.test(id)) && x.schedule.init.some(id => /#swap0$/.test(id)), 'init dispatches and swaps');
    // A preparation that approves nothing: every create ran, no submission, no copy, no swap.
    const port = fakePort();
    let seen = null;
    const { outcome } = await build(snap, port, { prepare: async w => { seen = w.deferred; throw new Error('EA_PROBE over the cap'); } });
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(seen, ['seed#dispatch', 'seed#swap0'], 'the probe is handed init\'s GPU work, in X\'s order');
    assert.deepEqual(port.log.filter(l => /^(render|copy)/.test(l)), [], 'nothing generated submitted, no copy');
    assert.ok(!port.log.some(l => l.includes('ground#create/1+ground#create/0')), 'and no swap: the seed\'s groups were never switched');
    assert.deepEqual([[...port.live.values()], port.errors], [[], []], 'and everything made freed once');
    // No preparation at all: the construction refuses before any work, in EA5.3's words.
    const bare = fakePort();
    const none = await build(snap, bare, { prepare: null });
    assert.deepEqual([none.outcome.status, none.outcome.error], ['failed', 'EA_PROBE_UNVERIFIED: this build has no probe yet (EA5.3); no generated work was submitted']);
    assert.equal(bare.log.filter(l => l.startsWith('render') || l.startsWith('copy')).length, 0);
    assert.deepEqual([[...bare.live.values()], bare.errors], [[], []]);
    // Approved: the init work runs once, in X's order: the seed's dispatch, then its swap, which installs on every stage
    // that binds the ground the groups for its other half (the seed's, and flow's).
    const ok = fakePort();
    const approved = await build(snap, ok);
    assert.equal(approved.outcome.status, 'installed');
    const at = ok.log.indexOf('render [seed#create]');
    assert.deepEqual(ok.log.slice(at), [
        'render [seed#create]',
        'useComputeGroup seed#create 0 seed#create/0/ground#create/1+ground#create/0',
        'useComputeGroup flow#create 0 flow#create/0/ground#create/1+field#create/0+field#create/1',
    ]);
    assert.equal(ok.log.filter(l => l.startsWith('render')).length, 1, 'once');
    approved.runtime.destroy();
});

test('EA-D12 a cancel or a device loss across a compile\'s await: the late handle released once, nothing installed; a half-made create freed', async () => {
    const snap = await sealedLive('galaxy');
    for (const [why, move] of [['cancelled', s => s.controller.abort()], ['device-lost', s => { s.now.d++; }], ['superseded', s => { s.now.t++; }]]) {
        let settle;
        const state = { controller: new AbortController(), now: present() };
        const port = fakePort({ hold: entry => (entry === 'createBatch galaxy#create' ? new Promise(r => { settle = r; }) : null) });
        const pending = build(snap, port, { signal: state.controller.signal, now: state.now });
        while (!settle) await new Promise(r => setTimeout(r, 1));
        move(state);
        settle();
        const { outcome, installed } = await pending;
        assert.deepEqual([outcome.status, outcome.why, installed.length], ['stopped', why, 0], why);
        assert.ok(outcome.released.includes('galaxy#clear'), `${why}: the batch that came back late is released`);
        assert.deepEqual([[...port.live.values()], port.errors], [[], []], `${why}: every handle freed once`);
    }
    // A pair's second allocation fails: its first is freed by the buffer's own release.
    const pair = await sealed(synthetic(), SYNTHETIC_BODIES);
    const port = fakePort({ fail: entry => entry.startsWith('createBuffer field#create/1') });
    const { outcome } = await build(pair, port);
    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.released.includes('field#destroy'));
    assert.deepEqual([[...port.live.values()], port.errors], [[], []]);
});

test('EA-D13 0, 1 and 4 fixed steps, a pair\'s parity, a frame\'s copy and post work in exact order; no allocation per step or frame', async () => {
    const snap = await sealed(synthetic(), SYNTHETIC_BODIES);
    const port = fakePort();
    const { outcome, runtime } = await build(snap, port);
    assert.equal(outcome.status, 'installed');
    assert.ok(port.log.includes('setInstances blocks#create 32'), 'the batch draws the 32 cells copied in, not its 40');
    const makes = () => port.log.filter(l => /^(create|computeGroup|batchGroup|primitive|material|lightSystem|postChain)/.test(l)).length;
    const made = makes();
    // After init the seed swapped once: the ground's current half is its second buffer; the field is untouched.
    const frame = () => {
        const at = port.log.length;
        const sequence = runtime.draw();
        return { log: port.log.slice(at), sequence: sequence.map(s => s.label) };
    };
    // 0 steps: paint reads the field's first half; then the copy into the batch; then the pass and the post passes.
    let f = frame();
    assert.deepEqual(f.log, ['postUpload', 'render [paint#create]', `copy cells#create/0 -> blocks#create/storage ${32 * 56}`]);
    assert.deepEqual(f.sequence, ['main', 'post/0', 'post/1']);
    const flowGroups = () => port.log.filter(l => l.startsWith('useComputeGroup flow#create 0'));
    // 1 step: the clock, flow (reading the ground's second half, the field's first, writing its second), then the swap,
    // which installs on flow and paint the groups made for the field's other half.
    const before = port.log.length;
    runtime.step();
    assert.deepEqual(port.log.slice(before).map(l => l.replace(/ dt=.*$/, '')), [
        'writeBuffer @host#createSim/0', 'render [flow#create]',
        'useComputeGroup flow#create 0 flow#create/0/ground#create/1+field#create/1+field#create/0',
        'useComputeGroup paint#create 0 paint#create/0/field#create/1+cells#create/0',
    ]);
    // 4 more steps: the field's halves alternate (the ground's stay), and no group is made: each was made at construction.
    for (let i = 0; i < 4; i++) runtime.step();
    const groups = flowGroups().slice(-4).map(l => l.split(' ').at(-1));
    assert.deepEqual(groups, ['flow#create/0/ground#create/1+field#create/0+field#create/1', 'flow#create/0/ground#create/1+field#create/1+field#create/0',
        'flow#create/0/ground#create/1+field#create/0+field#create/1', 'flow#create/0/ground#create/1+field#create/1+field#create/0']);
    f = frame();
    assert.deepEqual(f.log, ['postUpload', 'render [paint#create]', `copy cells#create/0 -> blocks#create/storage ${32 * 56}`]);
    for (let i = 0; i < 100; i++) { runtime.step(); runtime.draw(); }
    assert.equal(makes(), made, 'no GPU object made by a step or a frame');
    assert.equal(runtime.steps, 105);
    // A reset (a film's calibration, EA5.5): the zero-declared buffers cleared, every pair at its first half, then init
    // again: the seed and its swap. The next step is the first step's again.
    const resetAt = port.log.length;
    runtime.reset();
    const reset = port.log.slice(resetAt);
    assert.deepEqual(reset.filter(l => l.startsWith('clearBuffer')),
        ['clearBuffer blocks#create/storage', 'clearBuffer cells#create/0', 'clearBuffer field#create/0', 'clearBuffer field#create/1', 'clearBuffer ground#create/0', 'clearBuffer ground#create/1']);
    assert.deepEqual(reset.filter(l => !l.startsWith('clearBuffer')), [
        'useComputeGroup seed#create 0 seed#create/0/ground#create/0+ground#create/1',
        'useComputeGroup flow#create 0 flow#create/0/ground#create/0+field#create/0+field#create/1',
        'useComputeGroup paint#create 0 paint#create/0/field#create/0+cells#create/0',
        'postResize 1280x720',
        'render [seed#create]',
        'useComputeGroup seed#create 0 seed#create/0/ground#create/1+ground#create/0',
        'useComputeGroup flow#create 0 flow#create/0/ground#create/1+field#create/0+field#create/1',
    ]);
    assert.deepEqual([runtime.simTime, runtime.steps], [0, 0]);
    const again = port.log.length;
    runtime.step();
    assert.equal(port.log.slice(again).at(-2), 'useComputeGroup flow#create 0 flow#create/0/ground#create/1+field#create/1+field#create/0', 'as the first step');
    runtime.destroy();
    assert.deepEqual([[...port.live.values()], port.errors], [[], []]);
});

test('the EA5.2 review: init by kind and call (M3), a binding before its create refused by name (L5), no lights on a module batch (L8)', async () => {
    const forge = async (name, change) => {
        const snap = await sealedLive(name);
        const forged = structuredClone(snap);
        change(forged.x);
        const port = fakePort();
        return { snap, forged, port, c: createEngineExecutor({ port, onCommit: () => {} }).instantiate(forged, { graph: snap.x.hash, candidate: snap.id }, new AbortController().signal) };
    };
    const op = (x, id) => x.operations.find(o => o.id === id);
    // M3 (1): an upload's seed at an upload's own place in init is refused in Tier 2's words, before anything defers.
    const seeded = await forge('block-film', x => { Object.assign(op(x, 'sun#upload'), { call: 'queue.writeBuffer' }); });
    for (const id of ['cube#create', 'clay#create', 'sun#create', 'film#create', '@host#pass', 'terrain#create', 'place#create']) await seeded.c.run(id);
    await assert.rejects(seeded.c.run('sun#upload'), /^Error: EA_CALL sun#upload: an upload's content is Tier 2's; this build runs Tier 1$/);
    // M3 (2): a create after init's GPU work began is refused, never run ahead of that work.
    const late = await forge('foggy-dusk', () => {});
    const init = late.snap.x.schedule.init;
    for (const id of init.slice(0, init.indexOf('placehills#dispatch') + 1)) await late.c.run(id);
    await assert.rejects(late.c.run('driftfog#create'), /^Error: EA_CALL driftfog#create: a create after init's GPU work \(placehills#dispatch\); X puts every create first$/);
    // M3 (3): a light upload is one path: at once while nothing waits; behind init's work, in order, once something does.
    const now = await forge('block-film', () => {});
    for (const id of now.snap.x.schedule.init) await now.c.run(id);
    assert.ok(now.port.log.includes('uploadLights 0 points'), 'made at once in X\'s own order');
    const behind = await forge('block-film', x => {
        const order = x.schedule.init;
        order.splice(order.indexOf('sun#upload'), 1);
        order.push('sun#upload');
    });
    const runs = createEngineExecutor({ port: behind.port, onCommit: () => {}, prepare: async w => w.runInit() })
        .instantiate(behind.forged, { graph: behind.snap.x.hash, candidate: behind.snap.id }, new AbortController().signal);
    for (const id of behind.forged.x.schedule.init) await runs.run(id);
    assert.ok(!behind.port.log.includes('uploadLights 0 points'), 'queued behind the dispatch');
    await runs.prepare();
    assert.deepEqual(behind.port.log.slice(-2), ['render [place#create]', 'uploadLights 0 points'], 'and run after it, by the lowering, once approved');
    // L5: a stage whose clock has no buffer yet is refused, naming the create that makes it.
    const clockless = await forge('galaxy', () => {});
    for (const id of clockless.snap.x.schedule.init.filter(id => id !== '@host#createSim' && !id.endsWith('#dispatch'))) {
        if (id === 'spin#create') {
            await assert.rejects(clockless.c.run(id), /^Error: EA_CALL spin#create: binds @host#sim, which @host#createSim makes and has not made yet; X must order that create first$/);
            break;
        }
        await clockless.c.run(id);
    }
    // L8: a lit batch whose shader is a module is refused before anything is made for it.
    const lit = await forge('block-film', x => { op(x, 'terrain#create').args.shader = { kind: 'module', module: 'place', lights: true }; });
    for (const id of ['cube#create', 'clay#create', 'sun#create', 'film#create', '@host#pass']) await lit.c.run(id);
    await assert.rejects(lit.c.run('terrain#create'), /^Error: EA_CALL terrain#create: custom lighting is gated; a module batch takes no lights$/);
    assert.ok(!lit.port.log.some(l => l.startsWith('createBatch')));
});
