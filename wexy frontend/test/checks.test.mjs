// EA-C and EA-R series, headless (EA3.3; engine-adapters-design.md §7, §10): the checks on X, and the recorded programs.
// The nine-adapter world's findings are pinned whole. Each limit of P is met at B and refused at B+1, under labelled
// fixture policies. Initialization through 0 and 1 fixed steps, ties, lifecycle and output each fire on a world built
// to fail them, and stay quiet on the real one. EA-R: EA2's recorded hand-off and the paper test's three plans are v1,
// refused as such; authored v2 equivalents of the three worlds resolve and check, and the gaps a reader would name are
// the ones Tier 1 has. Static only: "statically resolved, not rendered".
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGraph, MAX_FINDINGS } from '../src/contract/adapters/checks.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { ADAPTERS } from '../src/contract/adapters/index.ts';
import { TIER_1, resolveProgram } from '../src/contract/adapters/resolve.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });

/** EA-A2's program: all nine adapters. */
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
 * A labelled synthetic Tier 2 (Q80): `upload`'s gate lifted and a test content source, so the checks on an uploaded
 * buffer's content stay pinned for Tier 2. The recorded and paper programs (EA-R) are Tier 1's, and say so.
 */
const TIER_2 = Object.freeze({ gates: [], content: { contentFor: node => ({ source: 'test', id: `${node}.seed`, sha256: '0'.repeat(64) }) } });

async function resolved(program, policy = POLICY_V1, sources = TIER_2) {
    const r = await resolveProgram(program, policy, undefined, sources);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r.graph;
}
const summary = c => c.findings.map(f => [f.check, f.severity, f.subject, f.path]);
const errors = c => c.findings.filter(f => f.severity === 'error').map(f => [f.check, f.subject, f.expected, f.actual]);
/** A labelled fixture policy: P v0 with one limit moved, for a B / B+1 pair. */
const fixture = (label, change) => ({ ...POLICY_V1, label: `fixture: ${label}`, ...change });

test('EA-C1 the nine-adapter world checks: no error; its two warnings, each with its offender and path; a retention is disclosed', async () => {
    const x = await resolved(world());
    const c = await checkGraph(x, POLICY_V1);
    assert.equal(c.ok, true);
    assert.equal(c.truncated, false);
    // On null-graph 1.2.1 the world leaves nothing behind (EA5.0): no lifecycle warning, the output's two alone.
    assert.deepEqual(summary(c), [
        ['output', 'warning', 'look#create', '/nodes/9'],
        ['output', 'warning', 'look#create', '/nodes/9'],
    ]);
    assert.deepEqual(c.findings.map(f => f.message), [
        'look has no Tonemap: the scene\'s linear HDR (rgba16float) reaches the 8-bit screen unconverted, clipped above 1; add Tonemap',
        'look runs FilmGrain, Vignette; the engine\'s order is Vignette, FilmGrain (Tonemap the pivot: HDR work before it, display-referred after)',
    ]);
    assert.ok(c.findings.every(f => f.code === 'EA_RESOLVE' && f.node !== null));
    // A hold an engine cannot release is still disclosed, once a holder, and never refused (1.2.0's were the stage and the
    // post debug view): a synthetic X.
    const held = structuredClone(x);
    for (const id of ['move#stage', 'look#debugView']) Object.assign(held.objects.find(o => o.id === id), { releasedBy: null, retained: { by: 'the engine', until: 'engine.destroy()' } });
    const disclosed = await checkGraph(held, POLICY_V1);
    assert.deepEqual([disclosed.ok, summary(disclosed)[0]], [true, ['lifecycle', 'warning', 'look#debugView', '/nodes/9']]);
    assert.equal(disclosed.findings[0].message, 'the engine keeps look#debugView, move#stage after the world\'s dispose, until engine.destroy(): the engine has no call that releases them');
});

test('EA-C2 each limit of P: B passes and B+1 refuses, for one buffer, all bytes, a dispatch\'s workgroups and its invocations', async () => {
    const pair = async (label, program, limit, b, subject) => {
        const atB = fixture(`${label} = ${b}`, { [limit]: b });
        assert.deepEqual(errors(await checkGraph(await resolved(program, atB), atB)), [], `${label} at B`);
        const under = fixture(`${label} = ${b - 1}`, { [limit]: b - 1 });
        const refused = errors(await checkGraph(await resolved(program, under), under));
        assert.ok(refused.length > 0 && refused.every(([check, s, expected]) => (check === 'memory' || check === 'work') && expected === b - 1), `${label} at B-1: ${JSON.stringify(refused)}`);
        assert.ok(refused.some(([, s]) => s === subject), `${label}: ${subject} named`);
    };
    // field's halves are the largest buffer, 65,536 bytes each.
    await pair('one buffer', world(), 'maxBufferBytes', 65_536, 'field#buffer');
    const total = (await resolved(world())).estimate.bytes;
    await pair('all bytes', world(), 'maxTotalBytes', total, null);
    // 128 invocations of 64 are 2 workgroups.
    const two = world();
    two[2].config = JSON.stringify({ module: 'motion', entry: 'step', workgroupSize: 64, invocations: 128, phase: 'fixedStep' });
    await pair('workgroups a dimension', two, 'maxWorkgroupsPerDimension', 2, 'move#dispatch');
    await pair('invocations a dispatch', two, 'maxInvocationsPerDispatch', 128, 'move#dispatch');

    // The work repeated (P v1, EA3.3's review): every dispatch stays legal while the sum is held. move's 64 invocations
    // run in each of P's 4 fixed steps; the draws are 36 × 64 + 36 + 3 vertex invocations; a warm-up stage runs in init.
    await pair('invocations a frame', world(), 'maxInvocationsPerFrame', 256, null);
    await pair('workgroups a frame', world(), 'maxWorkgroupsPerFrame', 4, null);
    await pair('vertex invocations a frame', world(), 'maxVertexInvocationsPerFrame', 2343, null);
    const warm = [...world(), node('warm', 'ng.buffer.storage', { elements: 128, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('warmup', 'ng.compute.stage', { module: 'warmup', entry: 'run', workgroupSize: 64, invocations: 128, phase: 'init' }, [from('writes', 'warm', 'buffer')])];
    await pair('invocations in init', warm, 'maxInvocationsInit', 128, null);
    // The review's case under the shipped P: twenty fixed-step stages, each dispatch at its limit and legal, refused whole.
    const twenty = [];
    for (let i = 0; i < 20; i++) {
        twenty.push(node(`b${i}`, 'ng.buffer.storage', { elements: 16, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
            node(`s${i}`, 'ng.compute.stage', { module: `m${i}`, entry: 'step', workgroupSize: 256, invocations: 65_535 * 256, phase: 'fixedStep' }, [from('writes', `b${i}`, 'buffer')]));
    }
    twenty.push(node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }, [from('reads', 'b0', 'buffer')]));
    const c = await checkGraph(await resolved(twenty), POLICY_V1);
    assert.deepEqual(errors(c), [['work', null, 4 * 16_777_216, 1_342_156_800], ['work', null, 4 * 65_535, 5_242_800]]);
});

test('EA-C3 X is checked under the policy it was resolved under, or refused before anything is compared', async () => {
    const x = await resolved(world());
    const other = fixture('two fixed steps', { maxFixedSteps: 2 });
    const c = await checkGraph(x, other);
    assert.equal(c.ok, false);
    assert.deepEqual(summary(c), [['policy', 'error', null, '/nodes']]);
});

test('EA-C4 initialization: a read before a whole write refuses, through init, a frame with no fixed step and one after a step', async () => {
    const x = await resolved(world());
    assert.deepEqual((await checkGraph(x, POLICY_V1)).findings.filter(f => f.check === 'init'), [], 'the real world reads only what is given content');
    // instances' content now comes only from its upload, and that upload writes a prefix: nothing gives it content.
    const partial = structuredClone(x);
    partial.resources.find(r => r.id === 'instances#buffer').content = 'upload';
    partial.operations.find(o => o.id === 'instances#upload').accesses[0].coverage = 'prefix';
    const c = await checkGraph(partial, POLICY_V1);
    assert.deepEqual(errors(c), [['init', 'blocks#copy', 'initialized', 'not yet']]);
    assert.match(c.findings[0].message, /blocks#copy reads instances#buffer in frame before anything gives it content \(a frame with no fixed step\)/);
    // A target only a fixed step writes whole is read by the frame: fine after a step, not when no step runs.
    const stepOnly = structuredClone(x);
    stepOnly.resources.find(r => r.id === 'look#params').content = 'pass';
    const upload = stepOnly.operations.find(o => o.id === 'look#upload');
    upload.phase = 'fixedStep';
    stepOnly.schedule.frame = stepOnly.schedule.frame.filter(id => id !== 'look#upload');
    stepOnly.schedule.fixedStep = [...stepOnly.schedule.fixedStep, 'look#upload'];
    const s = await checkGraph(stepOnly, POLICY_V1);
    assert.deepEqual(errors(s), [['init', 'look#passes', 'initialized', 'not yet']]);
    assert.match(s.findings[0].message, /\(a frame with no fixed step\)/);
    // And the allocation's zero-fill does not count for content that comes from an upload.
    const unseeded = structuredClone(x);
    unseeded.resources.find(r => r.id === 'instances#buffer').content = 'upload';
    unseeded.schedule.init = unseeded.schedule.init.filter(id => id !== 'instances#upload');
    assert.deepEqual(errors(await checkGraph(unseeded, POLICY_V1)), [['init', 'blocks#copy', 'initialized', 'not yet']]);
});

test('EA-C5 two writers of one buffer that only the program orders refuse, in every phase; a dependency between them does not', async () => {
    const buffer = id => node(id, 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' });
    const stage = (id, inputs, phase = 'frame') => node(id, 'ng.compute.stage', { module: id, entry: id, workgroupSize: 64, invocations: 64, phase }, inputs);
    const drawn = node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }, [from('reads', 'a', 'buffer')]);
    for (const phase of ['init', 'fixedStep', 'frame']) {
        const tie = await checkGraph(await resolved([buffer('a'), stage('first', [from('writes', 'a', 'buffer')], phase), stage('second', [from('writes', 'a', 'buffer')], phase), drawn]), POLICY_V1);
        assert.equal(tie.ok, false, `${phase}: unordered conflicting writes refuse (§7)`);
        const order = tie.findings.filter(f => f.check === 'order');
        assert.deepEqual(order.map(f => [f.severity, f.subject, f.path, f.phase, f.expected, f.actual]), [['error', 'second#dispatch', '/nodes/2', phase, 'a dependency', 'the program\'s listing']]);
        assert.equal(order[0].message, `first#dispatch and second#dispatch both write a#buffer in ${phase} with nothing ordering them but the program's listing, which would decide which write wins; merge them into one stage, or have one read a buffer the other writes`);
    }
    const dependency = await checkGraph(await resolved([buffer('a'), buffer('b'), stage('consume', [from('reads', 'a', 'buffer'), from('reads', 'b', 'buffer'), from('writes', 'a', 'buffer')]),
        stage('produce', [from('writes', 'a', 'buffer'), from('writes', 'b', 'buffer')]), drawn]), POLICY_V1);
    assert.deepEqual(dependency.findings.filter(f => f.check === 'order'), []);
});

test('EA-C6 lifecycle: an allocation nothing releases, a release never run, and a teardown out of order each refuse', async () => {
    const x = await resolved(world());
    const leak = structuredClone(x);
    leak.resources.find(r => r.id === 'cube#vertices').releasedBy = null;
    leak.objects.find(o => o.id === 'blocks#batch').releasedBy = 'blocks#vanish';
    assert.deepEqual(errors(await checkGraph(leak, POLICY_V1)), [['lifecycle', 'cube#vertices', 'a release', null], ['lifecycle', 'blocks#batch', 'blocks#vanish', null]]);
    // cube was made before blocks, which takes its geometry; releasing cube first refuses, naming both.
    const early = structuredClone(x);
    const d = early.schedule.dispose;
    const [i, j] = [d.indexOf('blocks#clear'), d.indexOf('cube#destroy')];
    [d[i], d[j]] = [d[j], d[i]];
    // Moving blocks' release down past cube's also moves it past stone's, sun's and sky's: each was made before blocks
    // (its material, its lights, the backdrop drawn before it), and each is named.
    const c = await checkGraph(early, POLICY_V1);
    assert.deepEqual(errors(c), ['cube', 'stone', 'sun', 'sky'].map(p => ['lifecycle', 'blocks#create', `blocks released before ${p}`, `${p} released first`]));
    assert.match(c.findings[0].message, /dispose releases cube before blocks, which was made after it/);
});

test('EA-C7 output: a world that draws nothing refuses; a Tonemap in the engine\'s order leaves no output warning', async () => {
    const nothing = await checkGraph(await resolved([node('field', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('step', 'ng.compute.stage', { module: 'm', entry: 's', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('writes', 'field', 'buffer')])]), POLICY_V1);
    assert.deepEqual(errors(nothing), [['output', null, 'a draw', null]]);
    // On 1.2.1 the compute stage is removed with the world: no retention warning beside the error.
    assert.deepEqual(nothing.findings.map(f => f.severity), ['error']);
    const graded = world();
    graded[9].config = JSON.stringify({ effects: [{ effect: 'Tonemap', intensity: 1 }, { effect: 'Vignette', intensity: 0.5 }, { effect: 'FilmGrain', intensity: 0.3 }] });
    const c = await checkGraph(await resolved(graded), POLICY_V1);
    assert.deepEqual(c.findings.filter(f => f.check === 'output'), []);
    assert.equal((await resolved(graded)).output.conversion, 'tonemap');
});

test('EA-C8 findings are bounded: errors first, at most MAX_FINDINGS, and the cut said', async () => {
    const tiny = fixture('one byte a buffer', { maxBufferBytes: 1 });
    const x = structuredClone(await resolved(world(), tiny));
    const template = x.resources.find(r => r.id === 'instances#buffer');
    for (let i = 0; i < MAX_FINDINGS; i++) x.resources.push({ ...template, id: `extra${i}#buffer` });
    const c = await checkGraph(x, tiny);
    assert.equal(c.truncated, true);
    assert.equal(c.findings.length, MAX_FINDINGS);
    assert.ok(c.findings.every(f => f.severity === 'error'), 'the errors are kept before any warning');
});

test('EA-C9 layout: a copy into a batch\'s storage of another stride, or past its end, refuses', async () => {
    const x = await resolved(world());
    const stride = structuredClone(x);
    stride.resources.find(r => r.id === 'blocks#storage').strideFloats = 13;
    assert.deepEqual(errors(await checkGraph(stride, POLICY_V1)), [['layout', 'blocks#copy', '13 floats, at most 3584 bytes', '14 floats, 3584 bytes']]);
    const past = structuredClone(x);
    past.resources.find(r => r.id === 'blocks#storage').bytes = 3583;
    assert.deepEqual(errors(await checkGraph(past, POLICY_V1)).map(e => e.slice(0, 2)), [['layout', 'blocks#copy']]);
});

// --- EA-R: the recorded and the paper programs ---------------------------------------------------------------------

const BACKEND_PLANS = fileURLToPath(new URL('../../wexy backend/forge-service/src/test/resources/agent/plans', import.meta.url));

/** The `program` event of a recorded turn: the backend's wire (v2), or EA2's v1 recording kept as an incompatible fixture. */
function recordedProgram(name, folder = 'agent-wire') {
    const text = readFileSync(new URL(`./fixtures/${folder}/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const block = text.split('\n\n').find(b => b.startsWith('event:program\n'));
    return JSON.parse(block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n')).program;
}

test('EA-R1 the recorded hand-off (agent-action.v2, EA3.6) resolves and checks; EA2\'s v1 hand-off is refused as v1, never coerced', async () => {
    // What the backend's mock hands off, through its own route and check (AgentWireTest), resolves here to static X.
    const program = recordedProgram('handed-off.sse');
    assert.deepEqual(program.nodes.map(n => n.adapterId), ['ng.buffer.storage', 'ng.geometry.primitive', 'ng.material.stock', 'ng.light.rig',
        'ng.render.mesh_batch', 'ng.post.chain', 'ng.compute.stage']);
    // Tier 1's: the blocks are seeded by an init stage, `place`, whose body is EA-E1's first module (Q80).
    const x = await resolved(program.nodes, POLICY_V1, TIER_1);
    assert.deepEqual(x.modules.map(m => [m.module, m.entry]), [['place', 'placeBlocks']]);
    assert.equal(x.executable, false, 'statically resolved, not rendered');
    const c = await checkGraph(x, POLICY_V1);
    assert.deepEqual(errors(c), []);
    assert.ok(c.findings.every(f => f.check === 'lifecycle'), `only the disclosed retentions: ${JSON.stringify(summary(c))}`);
    assert.equal(x.output.conversion, 'tonemap', 'HDR converted');

    const v1 = recordedProgram('handed-off.sse', 'agent-wire-v1');
    assert.ok(v1.objects.length > 0);
    const r = await resolveProgram(v1.objects);
    assert.equal(r.ok, false);
    assert.deepEqual(r.diagnostics.map(d => [d.code, d.path]), v1.objects.map((_, i) => ['EA_CONTRACT_V1', `/nodes/${i}`]));
});

/**
 * Authored v2 equivalents of the paper test's three worlds (the engine-aware design §13), in Tier-1 adapters. Each buffer
 * a draw reads is seeded by an init-phase compute stage, as the live block-film and galaxy were: `upload` waits for
 * Tier 2 (Q80).
 */
const EQUIVALENTS = {
    'block-film': [
        node('voxels', 'ng.buffer.storage', { elements: 6000, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('place', 'ng.compute.stage', { module: 'voxelgen', entry: 'genBlocks', workgroupSize: 64, invocations: 6000, phase: 'init' }, [from('writes', 'voxels', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('earth', 'ng.material.stock', { kind: 'lambert', baseColor: [0.55, 0.5, 0.42, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.18, 0.16, 0.13], directional: { direction: [0.4, -1, 0.3], color: [1, 0.92, 0.8], intensity: 2.5 }, points: [] }),
        node('valley', 'ng.render.mesh_batch', { maxInstances: 6000 },
            [from('geometry', 'cube', 'geometry'), from('material', 'earth', 'material'), from('instances', 'voxels', 'buffer'), from('lights', 'sun', 'lights')]),
        node('film', 'ng.post.chain', { effects: [{ effect: 'ColorGrade', intensity: 0.8 }, { effect: 'Tonemap', intensity: 1 }, { effect: 'Vignette', intensity: 0.6 }, { effect: 'FilmGrain', intensity: 0.4 }] }),
    ],
    galaxy: [
        node('stars', 'ng.buffer.storage', { elements: 12000, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('spiral', 'ng.compute.stage', { module: 'spiral', entry: 'initGalaxy', workgroupSize: 64, invocations: 12000, phase: 'init' }, [from('writes', 'stars', 'buffer')]),
        node('orbit', 'ng.compute.stage', { module: 'orbit', entry: 'step', workgroupSize: 64, invocations: 12000, phase: 'fixedStep' }, [from('writes', 'stars', 'buffer')]),
        node('star', 'ng.geometry.primitive', { shape: 'icosahedron', size: 0.05, segments: 3 }),
        node('glow', 'ng.material.stock', { kind: 'emissive', baseColor: [1, 0.9, 0.75, 1] }),
        node('disk', 'ng.render.mesh_batch', { maxInstances: 12000 }, [from('geometry', 'star', 'geometry'), from('material', 'glow', 'material'), from('instances', 'stars', 'buffer')]),
        node('bloom', 'ng.post.chain', { effects: [{ effect: 'Bloom', intensity: 1.2 }, { effect: 'Tonemap', intensity: 1 }] }),
    ],
    'foggy-dusk': [
        node('ground', 'ng.geometry.primitive', { shape: 'plane', size: 400, segments: 3 }),
        node('grass', 'ng.material.stock', { kind: 'lambert', baseColor: [0.32, 0.36, 0.3, 1] }),
        node('dusk', 'ng.light.rig', { ambient: [0.2, 0.17, 0.22], directional: { direction: [-0.6, -0.25, 0.2], color: [1, 0.6, 0.4], intensity: 1.2 }, points: [] }),
        node('hills', 'ng.buffer.storage', { elements: 1, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('raise', 'ng.compute.stage', { module: 'hillgen', entry: 'raiseHills', workgroupSize: 1, invocations: 1, phase: 'init' }, [from('writes', 'hills', 'buffer')]),
        node('terrain', 'ng.render.mesh_batch', { maxInstances: 1 },
            [from('geometry', 'ground', 'geometry'), from('material', 'grass', 'material'), from('instances', 'hills', 'buffer'), from('lights', 'dusk', 'lights')]),
        node('sky', 'ng.render.fullscreen', { module: 'duskSky', fragmentEntry: 'fs_main' }),
        node('grade', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ],
};

test('EA-R2 the paper test\'s three plans are refused as v1; their v2 equivalents resolve and check, with the gaps Tier 1 has',
    { skip: !existsSync(BACKEND_PLANS) && 'the backend repository is not on this disk' }, async () => {
        const wrapped = new Set(ADAPTERS.adapters.flatMap(a => a.symbols));
        const families = new Set(ADAPTERS.adapters.map(a => a.family));
        const gaps = {};
        for (const [name, program] of Object.entries(EQUIVALENTS)) {
            const plan = JSON.parse(readFileSync(`${BACKEND_PLANS}/${name}.json`, 'utf8')).program;
            const v1 = await resolveProgram(plan.objects);
            assert.deepEqual(v1.diagnostics.map(d => d.code), plan.objects.map(() => 'EA_CONTRACT_V1'), `${name}: the v1 plan`);
            // What a reader would name: the plan's families with no Tier-1 adapter, and its classes no descriptor wraps.
            const named = [...new Set(plan.objects.map(o => o.symbol))];
            gaps[name] = {
                families: [...new Set(named.map(s => s.split(':')[0]))].filter(f => !families.has(f)),
                classes: named.filter(s => /^[a-z]+:[A-Z]/.test(s) && families.has(s.split(':')[0]) && !wrapped.has(s)),
            };
            const x = await resolved(program, POLICY_V1, TIER_1);
            const c = await checkGraph(x, POLICY_V1);
            assert.deepEqual(errors(c), [], `${name}: no error`);
            assert.ok(c.findings.every(f => f.check === 'lifecycle'), `${name}: only the disclosed retentions: ${JSON.stringify(summary(c))}`);
            assert.equal(x.output.conversion, 'tonemap', `${name}: HDR converted`);
        }
        // block-film and galaxy need nothing Tier 1 lacks (their v1 plans name a material's shader builder, which the stock
        // material adapter builds itself). foggy-dusk's fog and dusk sky are the environment family, Tier 2, and its terrain
        // a GeometryBuilder heightfield: its equivalent is a flat plane under a fullscreen sky, no fog.
        assert.deepEqual(gaps, {
            'block-film': { families: [], classes: [] },
            galaxy: { families: [], classes: [] },
            'foggy-dusk': { families: ['environment'], classes: ['geometry:GeometryBuilder'] },
        });
    });

test('EA-C10 Q77: a stage that names another in after is ordered by that word; across phases, or in a loop, it refuses', async () => {
    const buffer = (id, pingPong = false) => node(id, 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong, init: 'zero' });
    const stage = (id, inputs, phase = 'frame') => node(id, 'ng.compute.stage', { module: id, entry: `run_${id}`, workgroupSize: 64, invocations: 64, phase }, inputs);
    const sky = node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'a', 'buffer')]);
    // Two in-place writers of a: the tie refuses, until the second names the first.
    const second = stage('second', [from('writes', 'a', 'buffer'), from('after', 'first', 'done')]);
    for (const program of [[buffer('a'), stage('first', [from('writes', 'a', 'buffer')]), second, sky], [buffer('a'), second, stage('first', [from('writes', 'a', 'buffer')]), sky]]) {
        const x = await resolved(program);
        const op = x.operations.find(o => o.id === 'second#dispatch');
        assert.deepEqual([op.after.includes('first#dispatch'), op.ties], [true, []], program.map(n => n.id).join());
        assert.ok(x.schedule.frame.indexOf('first#dispatch') < x.schedule.frame.indexOf('second#dispatch'), 'the word, whatever the listing');
        const c = await checkGraph(x, POLICY_V1);
        assert.deepEqual(errors(c), [], 'ordered, so no conflicting writes');
    }
    // After a ping-pong writer, a stage waits for its swap too, the whole of the stage it names, though it reads nothing
    // of the pair: only after orders it.
    const pair = await resolved([buffer('p', true), stage('flow', [from('reads', 'p', 'buffer'), from('writes', 'p', 'buffer')]),
        buffer('a'), stage('stir', [from('writes', 'a', 'buffer'), from('after', 'flow', 'done')]), sky]);
    assert.ok(pair.operations.find(o => o.id === 'stir#dispatch').after.includes('flow#swap0'));
    // An order across phases has nothing to hold; a loop of afters is a cycle.
    const across = await resolveProgram([buffer('a'), stage('first', [from('writes', 'a', 'buffer')], 'fixedStep'), stage('second', [from('writes', 'a', 'buffer'), from('after', 'first', 'done')]), sky], POLICY_V1);
    assert.deepEqual(across.diagnostics.map(d => [d.code, d.path]), [['EA_RESOLVE', '/nodes/2/inputs/1']]);
    assert.match(across.diagnostics[0].message, /second runs in frame and first in fixedStep; after orders stages within one phase/);
    const loop = await resolveProgram([buffer('a'), stage('one', [from('writes', 'a', 'buffer'), from('after', 'two', 'done')]), stage('two', [from('writes', 'a', 'buffer'), from('after', 'one', 'done')]), sky], POLICY_V1);
    assert.equal(loop.ok, false);
    assert.match(loop.diagnostics[0].message, /a dependency cycle: one → two → one/);
    // after takes a stage's done, nothing else.
    const wrong = await resolveProgram([buffer('a'), stage('one', [from('writes', 'a', 'buffer'), from('after', 'a', 'buffer')]), sky], POLICY_V1);
    assert.deepEqual(wrong.diagnostics.map(d => d.path), ['/nodes/1/inputs/1']);
});
