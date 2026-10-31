// EA-X series, headless (EA3.2; engine-adapters-design.md §2, §6, §10 EA-U5): a checked program of adapter nodes
// resolves to X, the execution graph, with no GPU. One program uses all nine adapters and its whole X is pinned: the
// phase schedules, the bytes, the estimate, the output, the source map. Then the identity (canonical, deterministic,
// sensitive to what matters), ping-pong pairs over 0 to N fixed steps, dependency order over program order, the
// refusals, and that resolving touches no device. The sizes themselves are pinned against the engine in
// test/resolve-engine.test.mjs. Static only (Q75 as decided): "statically resolved, not rendered".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalHash, canonicalJson, sha256Hex } from '../src/contract/adapters/canonical.ts';
import { SizeOverflow, product } from '../src/contract/adapters/contribute.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { ENGINE } from '../src/contract/engine/index.ts';
import { cleanupFor, resolveProgram } from '../src/contract/adapters/resolve.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });

/** EA-A2's program: all nine adapters, each in a minimal valid variant. */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { module: 'motion', entry: 'step', workgroupSize: 64, invocations: 64, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.1, 0.1, 0.12], directional: { direction: [0.3, -1, 0.2], color: [1, 0.95, 0.85], intensity: 2 }, points: [] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer'), from('lights', 'sun', 'lights')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'vs_main', fragmentEntry: 'fs_main', maxInstances: 1 }, [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }),
        node('look', 'ng.post.chain', { effects: [{ effect: 'FilmGrain', intensity: 0.3 }, { effect: 'Vignette', intensity: 0.5 }] }),
    ];
}

async function resolved(program, ...rest) {
    const r = await resolveProgram(program, ...rest);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.graph;
}

async function refused(program, code, path, ...rest) {
    const r = await resolveProgram(program, ...rest);
    assert.equal(r.ok, false, `wanted ${code} at ${path}; it resolved`);
    assert.ok(r.diagnostics.some(d => d.code === code && d.path === path), `wanted ${code} at ${path}, got ${JSON.stringify(r.diagnostics.map(d => [d.code, d.path, d.message]))}`);
    return r.diagnostics;
}

const op = (x, id) => x.operations.find(o => o.id === id);
const res = (x, id) => x.resources.find(r => r.id === id);

/** A pointer into the retained program; one that passes through a node's `config` continues into its parsed JSON. */
function walk(program, pointer) {
    let at = { nodes: program };
    for (const raw of pointer.split('/').slice(1)) {
        const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        assert.ok(at !== null && typeof at === 'object' && Object.hasOwn(at, token), `${pointer}: no ${token}`);
        at = at[token];
        if (token === 'config' && typeof at === 'string') at = JSON.parse(at);
    }
    return at;
}

test('EA-X1 X is canonical and deterministic: the same program gives the same bytes; what matters changes the hash', async () => {
    const program = world();
    const before = structuredClone(program);
    const a = await resolved(program);
    const b = await resolved(world());
    assert.equal(canonicalJson(a), canonicalJson(b), 'two resolutions are byte-identical');
    assert.deepEqual(program, before, 'the program is not changed by resolving it');
    const { hash, ...body } = a;
    assert.equal(await canonicalHash(body), hash, 'the hash is of X without it');
    assert.equal(a.executable, false);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.resources[0]) && Object.isFrozen(a.schedule.frame) && Object.isFrozen(a.operations[0].args));
    assert.deepEqual(a.identity, {
        graph: 'ea-x.v1', resolver: 'ea3.2-resolver.1', engine: 'null-graph@1.2.0', bundleHash: ENGINE.bundle.bundleHash, supportStatusHash: a.identity.supportStatusHash,
        manifest: 'ea-adapters.v1', manifestHash: '1de4e9b80b3d604f712cac856a17e58b66a00cc0d7a981cf88e65fd5fd87ba64',
        programHash: a.identity.programHash, policyHash: await canonicalHash(POLICY_V1),
    });

    // A config's key order and spacing are text, not meaning.
    const respaced = world();
    respaced[5].config = JSON.stringify({ points: [], directional: { intensity: 2, color: [1, 0.95, 0.85], direction: [0.3, -1, 0.2] }, ambient: [0.1, 0.1, 0.12] }, null, 2);
    assert.equal((await resolved(respaced)).hash, a.hash);

    // Each of these changes what X says, so its hash.
    const changed = async (label, program, ...rest) => {
        const x = await resolved(program, ...rest);
        assert.notEqual(x.hash, a.hash, label);
        return x;
    };
    const swapped = world();
    [swapped[6], swapped[7]] = [swapped[7], swapped[6]];
    const reordered = await changed('two draws in the other order', swapped);
    assert.deepEqual(reordered.schedule.frame.filter(id => /#draw$/.test(id)), ['sky#draw', 'water#draw', 'blocks#draw']);
    const config = world();
    config[0].config = JSON.stringify({ elements: 32, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' });
    assert.notEqual((await changed('a config value', config)).identity.programHash, a.identity.programHash);
    const steps = await changed('another policy', world(), { ...POLICY_V1, maxFixedSteps: 2 });
    assert.notEqual(steps.identity.policyHash, a.identity.policyHash);
    assert.equal(steps.estimate.invocationsPerFrame, 128);
    // A labelled synthetic H: post device-blocked still resolves, statically, and X says which H it was made under.
    const synthetic = new Map(ENGINE.support.entries.map(e => [e.family, e.status]));
    synthetic.set('post', 'device-blocked');
    const blocked = await changed('another H', world(), undefined, synthetic);
    assert.notEqual(blocked.identity.supportStatusHash, a.identity.supportStatusHash);
    assert.equal(blocked.nodes.find(n => n.id === 'look').status, 'device-blocked');
    assert.equal(blocked.executable, false);
});

test('EA-X2 the nine adapters resolve to one X: its schedules, bytes, estimate, output and source map, pinned', async () => {
    const program = world();
    const x = await resolved(program);
    assert.deepEqual(x.schedule, {
        init: ['instances#create', 'field#create', 'move#create', 'cube#create', 'stone#create', 'sun#create', 'look#create', '@host#pass',
            'sky#create', 'blocks#create', 'water#create', 'instances#upload', 'sun#upload'],
        fixedStep: ['move#dispatch'],
        frame: ['@host#updateCamera', 'look#upload', 'blocks#copy', '@host#clear', 'sky#draw', 'blocks#draw', 'water#draw', 'look#passes'],
        resize: ['@host#resize', 'look#resize'],
        dispose: ['water#clear', 'blocks#clear', 'sky#clear', 'look#clearBatches', 'look#destroy', 'sun#destroy', 'stone#destroy', 'cube#destroy', 'move#drop',
            'field#destroy', 'instances#destroy', '@host#forgetPasses'],
    });
    assert.deepEqual(x.fixedSteps, { min: 0, max: 4 });
    // Every allocation, with its owner: the engine's batch storage beside the buffer copied into it, the pool's targets.
    assert.deepEqual(x.resources.map(r => [r.id, r.owner, r.bytes, r.allocations]), [
        ['@host#camera', 'shared', 432, 1], ['@host#depth', 'shared', 1920 * 1080 * 4, 1], ['@host#fallbacks', 'shared', 16, 1], ['@host#screen', 'canvas', 0, 1],
        ['blocks#storage', 'engine', 64 * 56, 1], ['cube#indices', 'host', 72, 1], ['cube#vertices', 'host', 24 * 32, 1], ['field#buffer', 'host', 4096 * 16, 2],
        ['instances#buffer', 'host', 64 * 56, 1], ['look#batchStorage', 'engine', 32, 2], ['look#chain1', 'extra', 1920 * 1080 * 8, 1],
        ['look#debugStorage', 'engine', 32, 1], ['look#params', 'extra', 512, 1],
        ['look#sceneColor', 'extra', 1920 * 1080 * 8, 1], ['look#sceneDepth', 'extra', 1920 * 1080 * 4, 1], ['sky#storage', 'engine', 16, 1],
        ['stone#uniform', 'extra', 32, 1], ['sun#lights', 'extra', 128, 1], ['water#storage', 'engine', 16, 1],
    ]);
    // Every engine object, with what releases it, or what keeps it after the world's dispose and until when.
    const held = { by: 'the engine\'s batch manager (the post debug view\'s batch)', until: 'engine.destroy()' };
    assert.deepEqual(x.objects.map(o => [o.id, o.kind, o.count, o.createdBy, o.releasedBy, o.retained]), [
        ['@host#mainPass', 'pass', 1, '@host#pass', '@host#forgetPasses', null], ['blocks#batch', 'batch', 1, 'blocks#create', 'blocks#clear', null],
        ['cube#geometry', 'geometry', 1, 'cube#create', 'cube#destroy', null], ['look#chain', 'postChain', 1, 'look#create', 'look#destroy', null],
        ['look#debugView', 'postDebugView', 1, 'look#create', '@host#forgetPasses', held], ['look#postBatches', 'postBatches', 2, 'look#create', 'look#clearBatches', null],
        ['look#postPasses', 'postPasses', 2, 'look#create', '@host#forgetPasses', null],
        ['move#stage', 'computeStage', 1, 'move#create', 'move#drop', { by: 'engine.computeStages', until: 'engine.destroy()' }],
        ['sky#batch', 'batch', 1, 'sky#create', 'sky#clear', null], ['stone#material', 'material', 1, 'stone#create', 'stone#destroy', null],
        ['sun#lightSystem', 'lightSystem', 1, 'sun#create', 'sun#destroy', null], ['water#batch', 'batch', 1, 'water#create', 'water#clear', null],
    ]);
    assert.deepEqual(res(x, 'look#debugStorage').retained, held);
    assert.deepEqual(x.estimate, {
        bytes: 49_906_728, maxAllocationBytes: 16_588_800, viewportBytes: 49_766_400, resizePeakBytes: 49_906_728,
        invocationsPerFrame: 64 * 4, workgroupsPerFrame: 4, vertexInvocationsPerFrame: 36 * 64 + 36 + 3, invocationsInit: 0,
        copyBytesPerFrame: 3584, uploadBytesPerFrame: 432 + 512, uploadBytesInit: 3584 + 840 + 32 + 128, operations: 36,
    });
    assert.deepEqual(x.output, { color: '@host#screen', producer: 'look#passes', format: 'canvas', colorSpace: 'srgb', conversion: 'none', depth: 'look#sceneDepth' });
    assert.deepEqual(x.modules.map(m => [m.module, m.stage, m.entry, m.node, m.operation, m.path]), [
        ['motion', 'compute', 'step', 'move', 'move#dispatch', '/nodes/2/config/module'],
        ['sky', 'fragment', 'fs_main', 'sky', 'sky#draw', '/nodes/8/config/fragmentEntry'],
        ['water', 'fragment', 'fs_main', 'water', 'water#draw', '/nodes/7/config/fragmentEntry'],
        ['water', 'vertex', 'vs_main', 'water', 'water#draw', '/nodes/7/config/vertexEntry'],
    ]);
    assert.deepEqual(x.nodes.map(n => [n.id, n.adapterId, n.status, n.path]), program.map((n, i) => [n.id, n.adapterId, 'unverified', `/nodes/${i}`]));

    // R2 and R4: every resource, object and operation comes from a node or the host, and maps back to the program once.
    const ids = [...x.resources, ...x.objects, ...x.operations].map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique across resources, objects and operations');
    assert.deepEqual(x.sourceMap.map(s => s.id), [...ids].sort());
    for (const s of x.sourceMap) {
        if (s.node === '@host') { assert.deepEqual([s.adapter, s.paths], ['host', []], `${s.id}: the host's own has no authored location`); continue; }
        const i = program.findIndex(n => n.id === s.node);
        assert.equal(s.adapter, program[i].adapterId);
        assert.equal(s.paths[0], `/nodes/${i}`);
        for (const p of s.paths) walk(program, p);
    }
    for (const m of x.modules) walk(program, m.path);
    // Every access names a resource X has; every predecessor is in the same phase, earlier.
    for (const o of x.operations) {
        for (const a of o.accesses) assert.ok(res(x, a.resource), `${o.id}: ${a.resource}`);
        const order = x.schedule[o.phase];
        for (const p of o.after) assert.ok(order.indexOf(p) >= 0 && order.indexOf(p) < order.indexOf(o.id), `${o.id} after ${p}`);
    }
    // The batch draws the copy of its instances, and its copy runs each frame because move writes them in fixedStep.
    assert.deepEqual(op(x, 'blocks#copy').accesses, [
        { resource: 'instances#buffer', mode: 'read', version: null, coverage: null }, { resource: 'blocks#storage', mode: 'write', version: null, coverage: 'whole' }]);
    assert.deepEqual(op(x, 'blocks#draw').after, ['@host#updateCamera', 'blocks#copy', '@host#clear', 'sky#draw']);
    assert.deepEqual(op(x, 'blocks#create').after, ['instances#create', 'cube#create', 'stone#create', 'sun#create', '@host#pass', 'sky#create']);
    assert.deepEqual(op(x, '@host#pass').after, ['look#create']);

    // Static instances (nothing writes them after init) are copied once, at init, after their upload; fewer instances
    // than the batch holds are its drawn prefix.
    const still = world().filter(n => n.id !== 'move');
    still[0].config = JSON.stringify({ elements: 40, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' });
    const s = await resolved(still);
    assert.equal(op(s, 'blocks#copy').phase, 'init');
    assert.ok(s.schedule.init.indexOf('instances#upload') < s.schedule.init.indexOf('blocks#copy'));
    assert.ok(!s.schedule.frame.includes('blocks#copy'));
    assert.deepEqual([s.estimate.copyBytesPerFrame, op(s, 'blocks#copy').work.bytes, op(s, 'blocks#copy').accesses[1].coverage], [0, 40 * 56, 'prefix']);
    assert.deepEqual([op(s, 'blocks#draw').work.instances, res(s, 'blocks#storage').bytes], [40, 64 * 56]);
});

test('EA-X6 a ping-pong pair: two initialized halves, one writer, its swap, and readers of the half just written', async () => {
    const pair = upload => [
        node('field', 'ng.buffer.storage', { elements: 1024, layout: 'f32', strideFloats: 4, pingPong: true, init: upload ? 'upload' : 'zero' }),
        node('step', 'ng.compute.stage', { module: 'flow', entry: 'step', workgroupSize: 64, invocations: 1000, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'field', 'buffer')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }, [from('reads', 'field', 'buffer')]),
    ];
    const x = await resolved(pair(true));
    assert.deepEqual([res(x, 'field#buffer').bytes, res(x, 'field#buffer').allocations], [16_384, 2]);
    // Both halves get the seed, so a read is initialized after zero, one or two fixed steps, whichever half is current.
    assert.deepEqual([op(x, 'field#upload').work.bytes, op(x, 'field#upload').accesses], [32_768, [{ resource: 'field#buffer', mode: 'write', version: null, coverage: 'whole' }]]);
    assert.deepEqual(x.schedule.fixedStep, ['step#dispatch', 'step#swap0']);
    assert.deepEqual(op(x, 'step#dispatch').accesses, [
        { resource: 'field#buffer', mode: 'read', version: 'current', coverage: null }, { resource: 'field#buffer', mode: 'write', version: 'next', coverage: 'unknown' }]);
    assert.deepEqual(op(x, 'step#swap0').after, ['step#dispatch']);
    assert.deepEqual(op(x, 'step#dispatch').work, { workgroups: [16, 1, 1], invocations: 1024, vertices: null, instances: null, bytes: null });
    // The backdrop reads the current half in frame: after the frame's fixed steps (0 to 4 of them), never between.
    assert.deepEqual(op(x, 'sky#draw').accesses.find(a => a.resource === 'field#buffer'), { resource: 'field#buffer', mode: 'read', version: 'current', coverage: null });
    assert.deepEqual(x.fixedSteps, { min: 0, max: 4 });
    assert.equal(x.estimate.invocationsPerFrame, 1024 * 4, 'invocations count every fixed step P allows a frame');
    assert.ok(!x.schedule.init.includes('step#dispatch'));
    // Zero-initialized halves are initialized too: WebGPU zero-fills, and the buffer declared zero.
    assert.equal(res(await resolved(pair(false)), 'field#buffer').content, 'zero');

    // A buffer that is not a pair, read and written by one stage, is one read-write binding: WebGPU forbids aliasing a
    // writable storage binding with a second binding of the same buffer.
    const inPlace = pair(true);
    inPlace[0].config = JSON.stringify({ elements: 1024, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' });
    const p = await resolved(inPlace);
    assert.deepEqual(op(p, 'step#dispatch').accesses, [{ resource: 'field#buffer', mode: 'readwrite', version: null, coverage: 'unknown' }]);
    assert.deepEqual(p.schedule.fixedStep, ['step#dispatch']);

    // A second writer would leave the parity ambiguous.
    const two = pair(true);
    two.push(node('stir', 'ng.compute.stage', { module: 'flow', entry: 'stir', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('writes', 'field', 'buffer')]));
    await refused(two, 'EA_RESOLVE', '/nodes/3');
});

test('EA-X7 dependencies order a phase before program order does: writers before readers, backdrops first, creation as drawn', async () => {
    // The backdrop reads what a frame compute writes, and the program lists it first: the compute still runs first.
    const glow = [
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }, [from('reads', 'glow', 'buffer')]),
        node('glow', 'ng.buffer.storage', { elements: 256, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('paint', 'ng.compute.stage', { module: 'glow', entry: 'paint', workgroupSize: 64, invocations: 256, phase: 'frame' }, [from('writes', 'glow', 'buffer')]),
    ];
    const g = await resolved(glow);
    assert.deepEqual(g.schedule.frame, ['@host#updateCamera', 'paint#dispatch', '@host#clear', 'sky#draw']);
    assert.ok(op(g, 'sky#draw').after.includes('paint#dispatch'));
    // A consumer is made after what it reads, and a batch after its pass, though the program lists the backdrop first.
    assert.deepEqual(g.schedule.init, ['@host#pass', 'glow#create', 'sky#create', 'paint#create']);
    // Without a post chain the draws go straight to the screen, with the engine's depth target.
    assert.deepEqual([g.output.producer, g.output.depth, g.output.conversion], ['sky#draw', '@host#depth', 'none']);

    // A backdrop listed after the meshes still draws first, and is created first: NullGraph draws in creation order.
    const late = world();
    const sky = late.splice(8, 1)[0];
    late.push(sky);
    const l = await resolved(late);
    assert.deepEqual(l.schedule.frame.filter(id => /#draw$/.test(id)), ['sky#draw', 'blocks#draw', 'water#draw']);
    const made = l.schedule.init.filter(id => ['sky#create', 'blocks#create', 'water#create'].includes(id));
    assert.deepEqual(made, ['sky#create', 'blocks#create', 'water#create']);
    // Disposal is construction backwards; the host's release of what the engine lists for every world comes last.
    const creates = l.schedule.init.filter(id => id.endsWith('#create')).map(id => id.split('#')[0]);
    const disposed = [...new Set(l.schedule.dispose.filter(id => !id.startsWith('@host#')).map(id => id.split('#')[0]))];
    assert.deepEqual(disposed, creates.filter(n => disposed.includes(n)).reverse());
    assert.equal(l.schedule.dispose.at(-1), '@host#forgetPasses');

    // Two computes each reading what the other writes, in one phase, order nothing: refused, both named.
    const loop = [
        node('a', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('b', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('ab', 'ng.compute.stage', { module: 'm', entry: 'ab', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('reads', 'a', 'buffer'), from('writes', 'b', 'buffer')]),
        node('ba', 'ng.compute.stage', { module: 'm', entry: 'ba', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('reads', 'b', 'buffer'), from('writes', 'a', 'buffer')]),
    ];
    const [cycle] = await refused(loop, 'EA_RESOLVE', '/nodes/2');
    assert.equal(cycle.message, 'a dependency cycle in frame: ab#dispatch → ba#dispatch → ab#dispatch');
    const flipped = [loop[0], loop[1], loop[3], loop[2]];
    assert.equal((await refused(flipped, 'EA_RESOLVE', '/nodes/2'))[0].message, 'a dependency cycle in frame: ba#dispatch → ab#dispatch → ba#dispatch');
    // The same two in different phases are a one-frame feedback, not a cycle.
    const feedback = structuredClone(loop);
    feedback[3].config = JSON.stringify({ module: 'm', entry: 'ba', workgroupSize: 64, invocations: 64, phase: 'fixedStep' });
    assert.deepEqual((await resolved(feedback)).schedule.fixedStep, ['ba#dispatch']);
});

test('EA-X8 each refusal of the resolver, at its exact path; a refused producer is not refused again downstream', async () => {
    const two = world();
    two.push(node('look2', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }));
    await refused(two, 'EA_RESOLVE', '/nodes/10');
    const over = world();
    over[0].config = JSON.stringify({ elements: 65, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' });
    await refused(over, 'EA_RESOLVE', '/nodes/6/inputs/2');
    const custom = world();
    custom[7].inputs.push(from('instances', 'field', 'buffer'));
    await refused(custom, 'EA_RESOLVE', '/nodes/7/inputs/1');
    const twice = world();
    twice[2].inputs.push(from('writes', 'instances', 'buffer'));
    await refused(twice, 'EA_RESOLVE', '/nodes/2/inputs/2');
    const [ops] = await refused(world(), 'EA_RESOLVE', '/nodes', { ...POLICY_V1, maxOperations: 35 });
    assert.match(ops.message, /36 operations, over P's 35/);
    assert.equal((await resolveProgram(world(), { ...POLICY_V1, maxOperations: 36 })).ok, true, 'B passes where B+1 refuses');
    const v1 = world();
    v1[3] = { id: 'cube', symbol: 'geometry:Primitives', member: 'createCube', purpose: 'x', args: [], inputs: [] };
    await refused(v1, 'EA_CONTRACT_V1', '/nodes/3');
    // Matcap refuses once, at its own node; the batch that takes it is skipped, not refused for the same cause.
    const matcap = world();
    matcap[4].config = JSON.stringify({ kind: 'matcap', baseColor: [1, 1, 1, 1] });
    const diagnostics = await refused(matcap, 'EA_CAPABILITY_UNSUPPORTED', '/nodes/4/config/kind');
    assert.equal(diagnostics.length, 1);
    // A size past the safe integers is unknown, so it refuses rather than rounds.
    assert.equal(product(64, 14, 4), 3584);
    assert.throws(() => product(2 ** 30, 2 ** 30, 2 ** 30), SizeOverflow);
    assert.throws(() => product(-1, 4), SizeOverflow);
});

test('EA-X9 resolving is inert: no device, no engine, no network; the resolver\'s modules import none of them', async () => {
    const trap = name => ({ configurable: true, get() { throw new Error(`resolving touched ${name}`); } });
    const globals = ['GPUBufferUsage', 'GPUTextureUsage', 'fetch', 'XMLHttpRequest', 'WebSocket'];
    const saved = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis.navigator, 'gpu', trap('navigator.gpu'));
    for (const name of globals) Object.defineProperty(globalThis, name, trap(name));
    try {
        const x = await resolved(world());
        assert.equal(x.executable, false);
    } finally {
        delete globalThis.navigator.gpu;
        for (const [name, d] of saved) { delete globalThis[name]; if (d) Object.defineProperty(globalThis, name, d); }
    }
    for (const file of ['canonical', 'contribute', 'graph', 'resolve', 'index']) {
        const source = readFileSync(new URL(`../src/contract/adapters/${file}.ts`, import.meta.url), 'utf8');
        const imports = [...source.matchAll(/ from '([^']+)';/g)].map(m => m[1]);
        assert.ok(imports.length > 0, `${file}.ts: imports read`);
        for (const i of imports) assert.ok(/^\.\.?\//.test(i), `${file}.ts imports ${i}`);
        assert.doesNotMatch(source, /\bnavigator\b|\bdocument\b|\bwindow\b|\bfetch\(|null-graph['/]/, `${file}.ts reaches the page, the network or the engine`);
    }
});

test('EA-X11 the EA3.2 review: program order never outranks a dependency; writers ordered only by the program are ties', async () => {
    const buffer = id => node(id, 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' });
    const stage = (id, entry, inputs) => node(id, 'ng.compute.stage', { module: 'm', entry, workgroupSize: 64, invocations: 64, phase: 'frame' }, inputs);
    // consume reads a and b and writes a in place; produce writes a and b. b makes produce first, whatever the listing.
    const consume = stage('consume', 'c', [from('reads', 'a', 'buffer'), from('reads', 'b', 'buffer'), from('writes', 'a', 'buffer')]);
    const produce = stage('produce', 'p', [from('writes', 'a', 'buffer'), from('writes', 'b', 'buffer')]);
    for (const program of [[buffer('a'), buffer('b'), consume, produce], [buffer('a'), buffer('b'), produce, consume]]) {
        const x = await resolved(program);
        assert.deepEqual(x.schedule.frame, ['@host#updateCamera', 'produce#dispatch', 'consume#dispatch', '@host#clear'], program.map(n => n.id).join());
        assert.deepEqual([op(x, 'consume#dispatch').after, op(x, 'consume#dispatch').ties], [['produce#dispatch'], []], 'a dependency, not a tie');
    }
    // Two in-place writers of one buffer, nothing between them: the program's order decides, and X says so.
    const pair = [buffer('a'), stage('first', 'f', [from('writes', 'a', 'buffer')]), stage('second', 's', [from('writes', 'a', 'buffer')])];
    const x = await resolved(pair);
    assert.deepEqual(x.schedule.frame.slice(1, 3), ['first#dispatch', 'second#dispatch']);
    assert.deepEqual([op(x, 'second#dispatch').after, op(x, 'second#dispatch').ties], [['first#dispatch'], ['first#dispatch']]);
    const swapped = await resolved([pair[0], pair[2], pair[1]]);
    assert.deepEqual(swapped.schedule.frame.slice(1, 3), ['second#dispatch', 'first#dispatch'], 'the listing decides a tie');
    // A designed order is no tie: the clear and the draws, a pass's creation order, a ping-pong swap.
    const w = await resolved(world());
    assert.deepEqual(w.operations.filter(o => o.ties.length).map(o => o.id), []);
    // Nor is the kind of work: a seed is uploaded before an init stage works on it in place, whatever the listing.
    const seeded = await resolved([stage('stir', 's', [from('writes', 'a', 'buffer')]),
        node('a', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'upload' })]
        .map(n => (n.id === 'stir' ? { ...n, config: JSON.stringify({ module: 'm', entry: 's', workgroupSize: 64, invocations: 64, phase: 'init' }) } : n)));
    assert.deepEqual(seeded.schedule.init, ['@host#pass', 'a#create', 'stir#create', 'a#upload', 'stir#dispatch']);
    assert.deepEqual([op(seeded, 'stir#dispatch').after, op(seeded, 'stir#dispatch').ties], [['a#create', 'stir#create', 'a#upload'], []]);
});

test('EA-X12 every allocation and engine object a world makes has a release or a disclosed retention; a partial init is undone', async () => {
    const programs = [world(), world().filter(n => n.id !== 'look'), [node('field', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('step', 'ng.compute.stage', { module: 'm', entry: 's', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('writes', 'field', 'buffer')])]];
    for (const program of programs) {
        const x = await resolved(program);
        const label = program.map(n => n.id).join();
        for (const r of [...x.resources, ...x.objects]) {
            if ('owner' in r && (r.owner === 'shared' || r.owner === 'canvas')) {
                assert.deepEqual([r.createdBy, r.releasedBy, r.retained], [null, null, null], `${r.id}: the engine's own and the canvas outlive the world`);
                continue;
            }
            assert.ok(x.schedule.init.includes(r.createdBy), `${label}: ${r.id} is made in init`);
            assert.ok(r.releasedBy !== null || r.retained !== null, `${label}: ${r.id} has neither a release nor a declared retention`);
            if (r.releasedBy !== null) assert.ok(x.schedule.dispose.includes(r.releasedBy), `${label}: ${r.id}'s release ${r.releasedBy} is scheduled`);
            if (r.retained !== null) assert.equal(r.retained.until, 'engine.destroy()');
        }
        // Each dispose operation releases something, and nothing else is in dispose.
        const releases = new Set([...x.resources, ...x.objects].map(r => r.releasedBy).filter(Boolean));
        assert.deepEqual(x.schedule.dispose.filter(id => !releases.has(id)), [], `${label}: a dispose operation that releases nothing`);
        // The minimal compute world the review reproduced: its stage and pass now have their releases.
        if (program.length === 2) assert.deepEqual(x.schedule.dispose, ['step#drop', 'field#destroy', '@host#forgetPasses']);
        // A partial init: after each create, what has been made is released, in dispose order; all of it, at the end.
        const creates = x.schedule.init.filter(id => op(x, id).kind === 'create');
        for (let k = 0; k <= creates.length; k++) {
            const attempted = new Set(creates.slice(0, k));
            const made = [...x.resources, ...x.objects].filter(r => r.createdBy !== null && attempted.has(r.createdBy) && r.releasedBy !== null);
            const cleanup = cleanupFor(x, attempted);
            assert.deepEqual(new Set(cleanup), new Set(made.map(r => r.releasedBy)), `${label}: after ${k} creates`);
            assert.deepEqual(cleanup, x.schedule.dispose.filter(id => cleanup.includes(id)), 'in dispose order');
        }
        assert.deepEqual(cleanupFor(x, new Set(creates)), x.schedule.dispose);
    }
});

test('EA-X10 canonical JSON: sorted keys, finite numbers, -0 as 0, and nothing that is not plain data; SHA-256 of its UTF-8', async () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 'é' }], '~/': null }), '{"a":[1,{"c":"é","d":2}],"b":1,"~/":null}');
    assert.equal(canonicalJson([-0, 0.5, 1.25e-7, 0.1 + 0.2, true, ' ']), JSON.stringify([0, 0.5, 1.25e-7, 0.1 + 0.2, true, ' ']));
    // Every double from 2^53 up is an integer, and an inexact one: 1e21 refuses as 2^53 does.
    assert.throws(() => canonicalJson(1e21), /past the safe integers/);
    assert.equal(canonicalJson(Number.MAX_SAFE_INTEGER), '9007199254740991');
    class Thing {}
    const cyclic = { a: {} };
    cyclic.a.b = cyclic;
    for (const [label, v] of [['NaN', NaN], ['Infinity', [Infinity]], ['an unsafe integer', { n: 2 ** 53 }], ['undefined', { u: undefined }],
        ['a function', [() => 1]], ['a Map', new Map()], ['a Date', new Date(0)], ['a class instance', new Thing()], ['a hole', [, 1]], // eslint-disable-line no-sparse-arrays
        ['a cycle', cyclic], ['a symbol key', { [Symbol('s')]: 1 }], ['a bigint', 1n]]) {
        assert.throws(() => canonicalJson(v), /canonical JSON/, label);
    }
    assert.match((() => { try { canonicalJson({ a: [{ 'x/y': NaN }] }); } catch (e) { return e.message; } })(), /at \/a\/0\/x~1y/);
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    for (const s of ['é', '🧱 world', '\u0000￿']) assert.equal(await sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
    // The same object built in another key order hashes the same.
    assert.equal(await canonicalHash({ x: 1, y: [2, { p: 3, q: 4 }] }), await canonicalHash({ y: [2, { q: 4, p: 3 }], x: 1 }));
});
