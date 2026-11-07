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
import { NO_CONTENT, SizeOverflow, product } from '../src/contract/adapters/contribute.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { SHIPPED_GATES, SHIPPED_SUPPORT } from '../src/contract/adapters/index.ts';
import { ENGINE } from '../src/contract/engine/index.ts';
import { checkGraph } from '../src/contract/adapters/checks.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { TIER_1, cleanupFor, resolveProgram } from '../src/contract/adapters/resolve.ts';

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

/**
 * A labelled synthetic Tier 2 (Q80): `upload`'s gate lifted, and a test content source that names a seed for every
 * buffer. These tests pin the resolver's upload path, which stays for Tier 2; EA-X16 shows Tier 1 refusing it.
 */
const TIER_2 = Object.freeze({
    gates: [],
    content: { contentFor: (node, bytes) => ({ source: 'test', id: `${node}.seed`, sha256: createHash('sha256').update(`${node}:${bytes}`).digest('hex') }) },
});
/** `resolveProgram`'s policy, H and sources: P v0, the shipped H and the Tier-2 stand-in unless a test names its own. */
const under = ([policy, support, sources]) => [policy ?? POLICY_V1, support ?? SHIPPED_SUPPORT, sources ?? TIER_2];

async function resolved(program, ...rest) {
    const r = await resolveProgram(program, ...under(rest));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.graph;
}

async function refused(program, code, path, ...rest) {
    const r = await resolveProgram(program, ...under(rest));
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
    // The bundle, H's statuses and the manifest: ea.v1's own constants since KR0 (identity.ts), never the shell's files.
    assert.deepEqual(a.identity, {
        graph: 'ea-x.v1', resolver: 'ea3.2-resolver.3', engine: 'null-graph@1.2.1', bundleHash: 'aa60280bae32e3aa780d34352ac42ef9c323d39f201b72cd5dc6c07a562f6824',
        supportStatusHash: '32307cbb13986bcde6afa91d2e5374e563e746831b45e7b2a06ded6c564e79bb',
        manifest: 'ea-adapters.v1', manifestHash: '8bdd11e8ef2f0ced4b0cabbbac19ca4b6ff0df03fca2d56082005b05b1497220',
        gatesHash: await canonicalHash([]), programHash: a.identity.programHash, policyHash: await canonicalHash(POLICY_V1),
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
    // The gates it was resolved under are X's too: a world with no upload, under Tier 1 and under the stand-in (Q80).
    const still = world();
    still[0].config = JSON.stringify({ elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' });
    const tier1 = await resolved(still, undefined, undefined, TIER_1);
    const tier2 = await resolved(still);
    assert.notEqual(tier1.hash, tier2.hash, 'another set of gates');
    assert.deepEqual([tier1.identity.gatesHash, tier2.identity.gatesHash], [await canonicalHash(SHIPPED_GATES), await canonicalHash([])]);
    const apart = x => ({ ...x, hash: null, identity: { ...x.identity, gatesHash: null } });
    assert.deepEqual(apart(tier1), apart(tier2), 'and nothing else in X differs');
});

test('EA-X2 the nine adapters resolve to one X: its schedules, bytes, estimate, output and source map, pinned', async () => {
    const program = world();
    const x = await resolved(program);
    assert.deepEqual(x.schedule, {
        init: ['@host#createSim', 'instances#create', 'field#create', 'move#create', 'cube#create', 'stone#create', 'sun#create', 'look#create',
            '@host#pass', 'sky#create', 'blocks#create', 'water#create', 'instances#upload', 'sun#upload'],
        // Q81: the host's clock is written whole before every fixed step, so each step reads its own.
        fixedStep: ['@host#updateSim', 'move#dispatch'],
        frame: ['@host#updateCamera', 'look#upload', 'blocks#copy', '@host#clear', 'sky#draw', 'blocks#draw', 'water#draw', 'look#passes'],
        resize: ['@host#resize', 'look#resize'],
        dispose: ['water#clear', 'blocks#clear', 'sky#clear', 'look#destroy', 'sun#destroy', 'stone#destroy', 'cube#destroy', 'move#drop',
            'field#destroy', 'instances#destroy', '@host#destroySim', '@host#removePass'],
    });
    assert.deepEqual(x.fixedSteps, { min: 0, max: 4 });
    // Every allocation, with its owner: the engine's batch storage beside the buffer copied into it, the pool's targets.
    assert.deepEqual(x.resources.map(r => [r.id, r.owner, r.bytes, r.allocations]), [
        ['@host#camera', 'shared', 432, 1], ['@host#depth', 'shared', 1920 * 1080 * 4, 1], ['@host#fallbacks', 'shared', 16, 1], ['@host#screen', 'canvas', 0, 1],
        ['@host#sim', 'host', 16, 1],
        ['blocks#storage', 'engine', 64 * 56, 1], ['cube#indices', 'host', 72, 1], ['cube#vertices', 'host', 24 * 32, 1], ['field#buffer', 'host', 4096 * 16, 2],
        ['instances#buffer', 'host', 64 * 56, 1], ['look#batchStorage', 'engine', 32, 2], ['look#chain1', 'extra', 1920 * 1080 * 8, 1],
        ['look#debugStorage', 'engine', 32, 1], ['look#params', 'extra', 512, 1],
        ['look#sceneColor', 'extra', 1920 * 1080 * 8, 1], ['look#sceneDepth', 'extra', 1920 * 1080 * 4, 1], ['sky#storage', 'engine', 16, 1],
        ['stone#uniform', 'extra', 32, 1], ['sun#lights', 'extra', 128, 1], ['water#storage', 'engine', 16, 1],
    ]);
    // Every engine object, with what releases it: on null-graph 1.2.1 nothing is kept after the world's dispose (EA5.0).
    // PostChain's destroy releases its passes, its batches and its debug view's; the stage and the main pass are removed.
    assert.deepEqual(x.objects.map(o => [o.id, o.kind, o.count, o.createdBy, o.releasedBy, o.retained]), [
        ['@host#mainPass', 'pass', 1, '@host#pass', '@host#removePass', null], ['blocks#batch', 'batch', 1, 'blocks#create', 'blocks#clear', null],
        ['cube#geometry', 'geometry', 1, 'cube#create', 'cube#destroy', null], ['look#chain', 'postChain', 1, 'look#create', 'look#destroy', null],
        ['look#debugView', 'postDebugView', 1, 'look#create', 'look#destroy', null], ['look#postBatches', 'postBatches', 2, 'look#create', 'look#destroy', null],
        ['look#postPasses', 'postPasses', 2, 'look#create', 'look#destroy', null],
        ['move#stage', 'computeStage', 1, 'move#create', 'move#drop', null],
        ['sky#batch', 'batch', 1, 'sky#create', 'sky#clear', null], ['stone#material', 'material', 1, 'stone#create', 'stone#destroy', null],
        ['sun#lightSystem', 'lightSystem', 1, 'sun#create', 'sun#destroy', null], ['water#batch', 'batch', 1, 'water#create', 'water#clear', null],
    ]);
    assert.deepEqual([res(x, 'look#debugStorage').releasedBy, res(x, 'look#debugStorage').retained], ['look#destroy', null]);
    assert.ok([...x.resources, ...x.objects].every(r => r.retained === null), 'no retention on 1.2.1');
    assert.deepEqual([op(x, 'move#drop').call, op(x, '@host#removePass').call, op(x, '@host#removePass').args, op(x, 'look#destroy').call],
        ['engine.removeComputeStage', 'engine.removePass', { pass: '@host#pass' }, 'post.destroy']);
    assert.ok(!x.operations.some(o => ['engine.clearPasses', 'host.dropComputeStage', 'post.clearBatches'].includes(o.call)), 'no 1.2.0 release call is left');
    assert.deepEqual(x.estimate, {
        bytes: 49_906_744, maxAllocationBytes: 16_588_800, viewportBytes: 49_766_400, resizePeakBytes: 49_906_744,
        invocationsPerFrame: 64 * 4, workgroupsPerFrame: 4, vertexInvocationsPerFrame: 36 * 64 + 36 + 3, invocationsInit: 0,
        copyBytesPerFrame: 3584, uploadBytesPerFrame: 432 + 512 + 16 * 4, uploadBytesInit: 3584 + 840 + 32 + 128, operations: 38,
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
    assert.deepEqual(x.schedule.fixedStep, ['@host#updateSim', 'step#dispatch', 'step#swap0']);
    assert.deepEqual(op(x, 'step#dispatch').accesses, [
        { resource: 'field#buffer', mode: 'read', version: 'current', coverage: null }, { resource: 'field#buffer', mode: 'write', version: 'next', coverage: 'unknown' },
        { resource: '@host#sim', mode: 'read', version: null, coverage: null }], 'and, at a fixed step, the clock of the host (Q81)');
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
    assert.deepEqual(op(p, 'step#dispatch').accesses, [{ resource: 'field#buffer', mode: 'readwrite', version: null, coverage: 'unknown' },
        { resource: '@host#sim', mode: 'read', version: null, coverage: null }]);
    assert.deepEqual(p.schedule.fixedStep, ['@host#updateSim', 'step#dispatch']);

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
    // Disposal is construction backwards; the host's own releases come last, its main pass removed after its batches.
    const creates = l.schedule.init.filter(id => id.endsWith('#create')).map(id => id.split('#')[0]);
    const disposed = [...new Set(l.schedule.dispose.filter(id => !id.startsWith('@host#')).map(id => id.split('#')[0]))];
    assert.deepEqual(disposed, creates.filter(n => disposed.includes(n)).reverse());
    assert.equal(l.schedule.dispose.at(-1), '@host#removePass');

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
    assert.deepEqual((await resolved(feedback)).schedule.fixedStep, ['@host#updateSim', 'ba#dispatch']);
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
    const [ops] = await refused(world(), 'EA_RESOLVE', '/nodes', { ...POLICY_V1, maxOperations: 37 });
    assert.match(ops.message, /38 operations, over P's 37/);
    assert.equal((await resolveProgram(world(), { ...POLICY_V1, maxOperations: 38 }, undefined, TIER_2)).ok, true, 'B passes where B+1 refuses');
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
        if (program.length === 2) assert.deepEqual(x.schedule.dispose, ['step#drop', 'field#destroy', '@host#removePass']);
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

test('EA-X16 Q80: Tier 1 refuses an upload at the node check; a lifted gate with no content refuses at the buffer; with content, X names it', async () => {
    // Tier 1: the manifest's gate, before any adapter's code runs.
    const tier1 = await resolveProgram(world(), POLICY_V1, SHIPPED_SUPPORT, TIER_1);
    assert.equal(tier1.ok, false);
    assert.deepEqual(tier1.diagnostics.map(d => [d.code, d.path, d.nodeId]), [['EA_CAPABILITY_UNSUPPORTED', '/nodes/0/config/init', 'instances']]);
    assert.match(tier1.diagnostics[0].message, /"upload" is not available yet/);
    // The gate lifted, but no content: the buffer refuses, so a missing seed never reads as zeros (Q80 (c)).
    const [empty] = await refused(world(), 'EA_CAPABILITY_UNSUPPORTED', '/nodes/0/config/init', undefined, undefined, { gates: [], content: NO_CONTENT });
    assert.match(empty.message, /no content source holds a seed for this buffer/);
    // With content, as Tier 2 will supply it: the upload names its source, id and hash, never its bytes.
    const x = await resolved(world());
    assert.deepEqual(op(x, 'instances#upload').args.data, { source: 'test', id: 'instances.seed', sha256: createHash('sha256').update('instances:3584').digest('hex') });
    assert.deepEqual(op(x, 'instances#upload').work.bytes, 3584);
});

test('EA-D7 Q76(b): an eligible buffer is its batch\'s own storage, made by the batch\'s create, cleared once; every other case copies', async () => {
    // The live worlds' shape: instances declared zero, exactly maxInstances of them at the stock stride, one mesh batch,
    // written by an init stage and by a frame stage, which bind the batch's storage.
    const adoptable = (over = {}) => [
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('blocks', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero', ...over }),
        node('place', 'ng.compute.stage', { module: 'place', entry: 'put', workgroupSize: 64, invocations: 64, phase: 'init' }, [from('writes', 'blocks', 'buffer')]),
        node('sway', 'ng.compute.stage', { module: 'sway', entry: 'drift', workgroupSize: 64, invocations: 64, phase: 'frame' },
            [from('reads', 'blocks', 'buffer'), from('writes', 'blocks', 'buffer')]),
        node('terrain', 'ng.render.mesh_batch', { maxInstances: 64 }, [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'blocks', 'buffer')]),
    ];
    const x = await resolved(adoptable(), undefined, undefined, TIER_1);
    // One allocation, the batch's, realized under the buffer's own id: engine-owned, made by the batch, cleared once.
    const r = res(x, 'blocks#buffer');
    assert.deepEqual([r.owner, r.bytes, r.allocations, r.content, r.createdBy, r.releasedBy, r.retained], ['engine', 64 * 56, 1, 'zero', 'terrain#create', 'terrain#clear', null]);
    assert.equal(res(x, 'terrain#storage'), undefined, 'no storage of the batch beside it');
    for (const id of ['blocks#create', 'blocks#destroy', 'terrain#copy']) assert.equal(op(x, id), undefined, `${id}: no create, destroy or copy`);
    assert.ok(!x.operations.some(o => o.call === 'buffer.destroy' || o.call === 'encoder.copyBufferToBuffer'), 'released only through clearBatch, never copied');
    const create = op(x, 'terrain#create');
    assert.deepEqual([create.args.adopts, create.accesses], ['blocks#buffer', [{ resource: 'blocks#buffer', mode: 'write', version: null, coverage: 'whole' }]]);
    assert.ok(op(x, 'terrain#draw').accesses.some(a => a.resource === 'blocks#buffer' && a.mode === 'read'));
    // The batch's create comes before every stage that binds its storage; disposal undoes it: the stages dropped first.
    const init = x.schedule.init;
    for (const stage of ['place', 'sway']) {
        assert.ok(op(x, `${stage}#create`).after.includes('terrain#create'), `${stage} waits for the storage it binds`);
        assert.ok(init.indexOf('terrain#create') < init.indexOf(`${stage}#create`), `${stage}#create after terrain#create`);
        assert.ok(x.schedule.dispose.indexOf(`${stage}#drop`) < x.schedule.dispose.indexOf('terrain#clear'), `${stage}#drop before terrain#clear`);
    }
    assert.ok(init.indexOf('terrain#create') < init.indexOf('place#dispatch'), 'the init stage writes storage that exists');
    assert.deepEqual(x.schedule.frame.filter(id => ['sway#dispatch', 'terrain#draw'].includes(id)), ['sway#dispatch', 'terrain#draw'], 'the frame stage before the draw');
    // X checks, and a partial init is undone, each release once, the storage by its batch's clear alone.
    const checked = await checkGraph(x, POLICY_V1);
    assert.deepEqual(checked.findings.filter(f => f.severity === 'error'), []);
    const creates = init.filter(id => op(x, id).kind === 'create');
    for (let k = 0; k <= creates.length; k++) {
        const made = new Set(creates.slice(0, k));
        const cleanup = cleanupFor(x, made);
        assert.equal(new Set(cleanup).size, cleanup.length, `after ${k} creates: each release once`);
        assert.equal(cleanup.includes('terrain#clear'), made.has('terrain#create'), `after ${k} creates: the storage released when, and only when, its batch was made`);
    }

    // The bodies see the same buffer either way: each stage's interface is the copy's, byte for byte.
    const copied = [...adoptable(), node('rubble', 'ng.render.mesh_batch', { maxInstances: 64 },
        [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'blocks', 'buffer')])];
    const c = await resolved(copied, undefined, undefined, TIER_1);
    assert.equal(res(c, 'blocks#buffer').owner, 'host', 'a second batch keeps the copy');
    const [ia, ic] = [await deriveInterfaces(x), await deriveInterfaces(c)];
    assert.deepEqual(ia.interfaces.map(i => [i.module, i.interfaceHash]), ic.interfaces.map(i => [i.module, i.interfaceHash]));
    // And no copy each frame, where the copies run each frame because the frame stage writes the buffer.
    assert.deepEqual([x.estimate.copyBytesPerFrame, c.estimate.copyBytesPerFrame], [0, 2 * 64 * 56]);

    // Every other case keeps the copy: a ping-pong pair, an upload seed, fewer elements than the batch holds, a
    // fullscreen that reads it.
    const keeps = async (label, program, sources = TIER_1) => {
        const k = await resolved(program, undefined, undefined, sources);
        assert.deepEqual([res(k, 'blocks#buffer').owner, !!op(k, 'terrain#copy'), op(k, 'terrain#create').args.adopts], ['host', true, undefined], label);
    };
    await keeps('a pair', adoptable({ pingPong: true }).filter(n => n.id !== 'place'));
    await keeps('an upload seed', adoptable({ init: 'upload' }), TIER_2);
    await keeps('fewer elements than the batch holds', adoptable({ elements: 40 }));
    await keeps('a fullscreen reads it', [...adoptable(), node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'blocks', 'buffer')])]);

    // A custom batch adopts the same way, and its engine group binds the storage it adopted.
    const custom = [
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('motes', 'ng.buffer.storage', { elements: 32, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('spawn', 'ng.compute.stage', { module: 'spawn', entry: 'seed', workgroupSize: 32, invocations: 32, phase: 'init' }, [from('writes', 'motes', 'buffer')]),
        node('glow', 'ng.render.custom_batch', { module: 'glow', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 32 },
            [from('geometry', 'cube', 'geometry'), from('instances', 'motes', 'buffer')]),
    ];
    const g = await resolved(custom, undefined, undefined, TIER_1);
    assert.deepEqual([res(g, 'motes#buffer').createdBy, res(g, 'motes#buffer').releasedBy, op(g, 'glow#create').args.adopts], ['glow#create', 'glow#clear', 'motes#buffer']);
    const gi = await deriveInterfaces(g);
    assert.equal(gi.interfaces.find(i => i.module === 'glow').bindings.find(b => b.name === 'ecs').resource, 'motes#buffer');
});
