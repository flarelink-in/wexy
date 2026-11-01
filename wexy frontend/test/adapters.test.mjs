// EA-A series, headless (EA3.1; engine-adapters-design.md §5, §13, §16): the nine Tier-1 adapter descriptors and the
// check of a program's adapter nodes. The manifest is pinned and every descriptor names real engine exports and an H
// family; one minimal valid program uses all nine; then each way a node can be wrong is refused at its exact path.
// Static only (Q75 as decided): nothing here resolves to anything that runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ADAPTER_MANIFEST_HASH, ADAPTER_MANIFEST_TEXT, ADAPTERS, checkManifest, checkNodes } from '../src/contract/adapters/index.ts';
import { ENGINE } from '../src/contract/engine/index.ts';

/**
 * sha256 of descriptors.json, LF line ends. A change is a new manifest: the backend's embedded copy follows (EA3.6).
 * 10-29 night: the pinned layouts table and the buffer's strideFrom (the EA3.1 review); before, 16a7b3e0….
 * 10-30: the compute stage's after input and done output (Q77); before, 7af95545….
 * 10-31: the variant gates' table, `upload` gated (Q80); before, 1de4e9b8….
 */
const MANIFEST_HASH = '3c7775588fb816ce8ccd3660e16d8ae6bfa9526f83174ecf666f8c66ab4c4c77';

const node = (id, adapterId, config, inputs = [], adapterVersion = 1) => ({ id, adapterId, adapterVersion, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });

/** A program that uses all nine adapters, each in a minimal valid variant. */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { module: 'motion', entry: 'step', workgroupSize: 64, invocations: 64, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.1, 0.1, 0.12], directional: { direction: [0.3, -1, 0.2], color: [1, 0.95, 0.85], intensity: 2 }, points: [] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer'), from('lights', 'sun', 'lights')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'vs_main', fragmentEntry: 'fs_main', maxInstances: 1 },
            [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'fs_main' }),
        node('look', 'ng.post.chain', { effects: [{ effect: 'FilmGrain', intensity: 0.3 }, { effect: 'Vignette', intensity: 0.5 }] }),
    ];
}

test('EA-A1 the manifest is the pinned one: nine Tier-1 descriptors over real engine exports and H families', () => {
    assert.equal(createHash('sha256').update(ADAPTER_MANIFEST_TEXT).digest('hex'), MANIFEST_HASH);
    assert.equal(ADAPTER_MANIFEST_HASH, MANIFEST_HASH, 'the pin a turn\'s meta is held to (EA3.6)');
    assert.deepEqual(ADAPTERS.adapters.map(a => a.id), ['ng.buffer.storage', 'ng.compute.stage', 'ng.geometry.primitive', 'ng.material.stock',
        'ng.light.rig', 'ng.render.mesh_batch', 'ng.render.custom_batch', 'ng.render.fullscreen', 'ng.post.chain']);
    const symbols = new Set(ENGINE.capabilities.symbols.map(s => s.id));
    const families = new Map(ENGINE.support.entries.map(e => [e.family, e.status]));
    for (const a of ADAPTERS.adapters) {
        for (const s of a.symbols) assert.ok(symbols.has(s), `${a.id}: ${s} is not an export of null-graph ${ENGINE.bundle.engine.version}`);
        assert.equal(families.get(a.family), 'unverified', `${a.id}: family ${a.family}`);
        assert.ok(Object.isFrozen(a.config));
    }
    // The manifest checks itself at load: a layout key, a stride or a port this check could not enforce whole throws.
    const broken = change => { const m = JSON.parse(ADAPTER_MANIFEST_TEXT); change(m); return () => checkManifest(m); };
    const storage = m => m.adapters.find(a => a.id === 'ng.buffer.storage');
    assert.doesNotThrow(broken(() => {}));
    assert.throws(broken(m => { storage(m).config.properties.layout.enum.push('instance32'); }), /layout is not a required enum of pinned layouts/);
    assert.throws(broken(m => { storage(m).config.required = storage(m).config.required.filter(k => k !== 'strideFloats'); }), /strideFloats is not a required integer/);
    assert.throws(broken(m => { delete storage(m).outputs[0].layoutFrom; }), /has a stride but no layout/);
    assert.throws(broken(m => { m.layouts.instance14.strideFloats = 0; }), /instance14's stride is not a positive integer/);
    assert.throws(broken(m => { m.adapters[5].inputs[2].layouts = ['instance15']; }), /accepts layout instance15, which is not pinned/);
    assert.throws(broken(m => { m.adapters[1].inputs[0].min = 5; }), /takes 5 to 4/);
    assert.throws(broken(m => { m.adapters.push(m.adapters[0]); }), /ng.buffer.storage is listed twice/);
});

test('EA-A2 a program using all nine adapters checks, each config parsed into the data its schema accepts', () => {
    const checked = checkNodes(world());
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    assert.deepEqual([...new Set(checked.nodes.map(n => n.adapter.id))].sort(), ADAPTERS.adapters.map(a => a.id).sort(), 'every adapter used');
    assert.deepEqual(checked.nodes.find(n => n.id === 'stone').config, { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] });
});

test('EA-A3 each way a node can be wrong is refused, at its exact path, with its code', () => {
    const cases = [
        ['an agent-action.v1 object', w => { w[3] = { id: 'cube', symbol: 'geometry:Primitives', member: 'createCube', purpose: 'x', args: [], inputs: [] }; }, 'EA_CONTRACT_V1', '/nodes/3'],
        ['an unknown adapter', w => { w[3].adapterId = 'ng.render.anything'; }, 'EA_CAPABILITY_UNSUPPORTED', '/nodes/3/adapterId'],
        ['another version', w => { w[3].adapterVersion = 2; }, 'EA_CAPABILITY_UNSUPPORTED', '/nodes/3/adapterVersion'],
        ['an extra key on a node', w => { w[3].call = 'createCube'; }, 'EA_RESOLVE', '/nodes/3'],
        ['config that is not JSON', w => { w[3].config = '{shape: cube'; }, 'EA_RESOLVE', '/nodes/3/config'],
        ['config that is an object, not text', w => { w[3].config = { shape: 'cube' }; }, 'EA_RESOLVE', '/nodes/3/config'],
        ['config past its characters', w => { w[3].config = JSON.stringify({ shape: 'cube', size: 1, segments: 3, pad: 'x'.repeat(4_100) }); }, 'EA_RESOLVE', '/nodes/3/config'],
        ['an extra config key', w => { w[3].config = JSON.stringify({ shape: 'cube', size: 1, segments: 3, method: 'createCube' }); }, 'EA_RESOLVE', '/nodes/3/config/method'],
        ['a config value out of range', w => { w[0].config = JSON.stringify({ elements: 0, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }); }, 'EA_RESOLVE', '/nodes/0/config/elements'],
        ['a shape that is not one', w => { w[3].config = JSON.stringify({ shape: 'teapot', size: 1, segments: 3 }); }, 'EA_RESOLVE', '/nodes/3/config/shape'],
        ['a duplicate id', w => { w[4].id = 'cube'; }, 'EA_RESOLVE', '/nodes/4/id'],
        ['an input port the adapter lacks', w => { w[6].inputs.push(from('shadow', 'sun', 'lights')); }, 'EA_RESOLVE', '/nodes/6/inputs/4/port'],
        ['a dangling node', w => { w[6].inputs[0].nodeId = 'sphere'; }, 'EA_RESOLVE', '/nodes/6/inputs/0/nodeId'],
        ['an output the node lacks', w => { w[6].inputs[0].output = 'mesh'; }, 'EA_RESOLVE', '/nodes/6/inputs/0/output'],
        ['a port of another kind', w => { w[6].inputs[1] = from('material', 'cube', 'geometry'); }, 'EA_RESOLVE', '/nodes/6/inputs/1'],
        ['24-float instances into a stock material\'s batch', w => { w[0].config = JSON.stringify({ elements: 64, layout: 'instance24', strideFloats: 24, pingPong: false, init: 'zero' }); }, 'EA_RESOLVE', '/nodes/6/inputs/2'],
        ['a required port left empty', w => { w[6].inputs.splice(1, 1); }, 'EA_RESOLVE', '/nodes/6/inputs'],
        ['a port given twice', w => { w[6].inputs.push(from('geometry', 'cube', 'geometry')); }, 'EA_RESOLVE', '/nodes/6/inputs'],
        ['a node fed by itself', w => { w[2].inputs[0] = from('reads', 'move', 'buffer'); }, 'EA_RESOLVE', '/nodes/2/inputs/0/nodeId'],
        ['an input with an extra key', w => { w[6].inputs[0].via = 'x'; }, 'EA_RESOLVE', '/nodes/6/inputs/0'],
    ];
    for (const [name, change, code, path] of cases) {
        const w = world();
        change(w);
        const checked = checkNodes(w);
        assert.equal(checked.ok, false, `${name}: accepted`);
        assert.ok(checked.diagnostics.some(d => d.code === code && d.path === path),
            `${name}: wanted ${code} at ${path}, got ${JSON.stringify(checked.diagnostics.map(d => [d.code, d.path, d.message]))}`);
    }
    assert.equal(checkNodes([]).ok, false);
    assert.equal(checkNodes(Array(65).fill(world()[3]).map((n, i) => ({ ...n, id: `n${i}` }))).ok, false);
});

test('EA-A4 support is static only: a family H marks unsupported refuses; unverified checks (a labelled synthetic H)', () => {
    const synthetic = new Map(ENGINE.support.entries.map(e => [e.family, e.status]));
    synthetic.set('post', 'unsupported');
    const checked = checkNodes(world(), undefined, synthetic);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.diagnostics.map(d => [d.code, d.path]), [['EA_CAPABILITY_UNSUPPORTED', '/nodes/9/adapterId']]);
    assert.equal(checkNodes(world()).ok, true, 'the shipped H marks every Tier-1 family unverified, which checks');
    // A status H does not define fails closed, as unsupported does (a labelled synthetic H).
    synthetic.set('post', 'maybe');
    assert.deepEqual(checkNodes(world(), undefined, synthetic).diagnostics?.map(d => [d.code, d.path]), [['EA_CAPABILITY_UNSUPPORTED', '/nodes/9/adapterId']]);
});

test('EA-A5 the EA3.1 review: a canonical layout pins its stride, and config paths are exact JSON pointers', () => {
    const buffer = (layout, strideFloats) => w => { w[0].config = JSON.stringify({ elements: 64, layout, strideFloats, pingPong: false, init: 'zero' }); };
    // Finding 1: instance14 declared with 24 floats used to check and reach the mesh batch's 14-float port.
    for (const [layout, stride] of [['instance14', 24], ['instance14', 13], ['instance24', 14], ['instance24', 25]]) {
        const w = world();
        buffer(layout, stride)(w);
        const checked = checkNodes(w);
        assert.equal(checked.ok, false, `${layout} with ${stride} floats: accepted`);
        assert.deepEqual(checked.diagnostics.map(d => [d.code, d.path]), [['EA_RESOLVE', '/nodes/0/config/strideFloats']], `${layout} with ${stride}`);
        assert.match(checked.diagnostics[0].message, new RegExp(`layout ${layout} is ${layout === 'instance14' ? 14 : 24} floats an element, not ${stride}`));
    }
    // f32 keeps the stride it declares; its own layout reaches only ports that take any layout.
    const f32 = world();
    f32[1].config = JSON.stringify({ elements: 4096, layout: 'f32', strideFloats: 24, pingPong: true, init: 'zero' });
    assert.equal(checkNodes(f32).ok, true, 'f32 with 24 floats');

    // Finding 2: a key with / ~ or : in it is one reference token, escaped (RFC 6901), at every depth.
    const keyed = (key, change) => { const w = world(); change(w, key); return checkNodes(w); };
    const cases = [
        ['bad/key', '/nodes/0/config/bad~1key'],
        ['bad~key', '/nodes/0/config/bad~0key'],
        ['bad:key', '/nodes/0/config/bad:key'],
        ['~1', '/nodes/0/config/~01'],
        ['', '/nodes/0/config/'],
    ];
    for (const [key, path] of cases) {
        const checked = keyed(key, (w, k) => { w[0].config = JSON.stringify({ elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero', [k]: 1 }); });
        assert.equal(checked.ok, false, `${JSON.stringify(key)}: accepted`);
        assert.deepEqual(checked.diagnostics.map(d => [d.code, d.path]), [['EA_RESOLVE', path]], JSON.stringify(key));
    }
    const nested = keyed('a/b', (w, k) => {
        w[5].config = JSON.stringify({ ambient: [0.1, 0.1, 0.1], directional: null, points: [{ position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 5, [k]: 0 }] });
    });
    assert.deepEqual(nested.diagnostics.map(d => d.path), ['/nodes/5/config/points/0/a~1b']);
    // A whole config of the wrong type is the config itself, not a property of it.
    assert.deepEqual(keyed('', w => { w[3].config = '[1]'; }).diagnostics.map(d => d.path), ['/nodes/3/config']);
});

test('EA-A6 a model\'s text in a node is quoted short, never whole; a malformed input names no other property', () => {
    const long = 'x'.repeat(10_000);
    const cases = [
        w => { w[3].adapterId = long; },
        w => { w[3].adapterVersion = long; },
        w => { w[6].inputs[0].port = long; },
        w => { w[6].inputs[0].nodeId = long; },
        w => { w[6].inputs[0].output = `${long}/x`; },
        w => { w[3][long] = 1; },
        w => { w[3].config = `{${long}`; },
    ];
    for (const change of cases) {
        const w = world();
        change(w);
        const checked = checkNodes(w);
        assert.equal(checked.ok, false);
        for (const d of checked.diagnostics) assert.ok(d.message.length < 400 && d.path.length < 80, `${d.path}: ${d.message.length} characters`);
    }
    const array = world();
    array[6].inputs[0] = { port: ['geometry'], nodeId: 'cube', output: 'geometry' };
    assert.deepEqual(checkNodes(array).diagnostics.map(d => d.path), ['/nodes/6/inputs/0']);
});

const BACKEND_MAIN = 'D:/orion-realms/wexy/wexy backend/forge-service/src/main';

test('EA-A7 the backend embeds this manifest byte for byte and pins its hash, when that repository is on this disk (EA3.6, Q74)',
    { skip: !existsSync(BACKEND_MAIN) && 'the backend repository is not on this disk' }, () => {
        const embedded = readFileSync(`${BACKEND_MAIN}/resources/adapters/descriptors.json`, 'utf8').replace(/\r\n/g, '\n');
        assert.equal(embedded, ADAPTER_MANIFEST_TEXT);
        const java = readFileSync(`${BACKEND_MAIN}/java/ai/wexy/forge/engine/AdapterManifest.java`, 'utf8');
        assert.equal(/String HASH = "([0-9a-f]{64})";/.exec(java)?.[1], ADAPTER_MANIFEST_HASH);
    });

test('EA-A8 Q80: a value the manifest gates is refused from that data, with its reason; lifting the gate is a data change', () => {
    // The shipped gate: `upload` stays declared on the buffer's init, and is unavailable until Tier 2 brings content.
    assert.deepEqual(ADAPTERS.unavailable.map(g => [g.adapter, g.path, g.value]), [['ng.buffer.storage', '/init', 'upload']]);
    assert.deepEqual(ADAPTERS.adapters[0].config.properties.init.enum, ['zero', 'upload'], 'Tier 2 lifts the gate, not the schema');
    const seeded = world();
    const buffer = (change = {}) => JSON.stringify({ elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload', ...change });
    seeded[0].config = buffer();
    const checked = checkNodes(seeded);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.diagnostics.map(d => [d.code, d.path, d.nodeId]), [['EA_CAPABILITY_UNSUPPORTED', '/nodes/0/config/init', 'instances']]);
    assert.match(checked.diagnostics[0].message,
        /^ng\.buffer\.storage config \/init: "upload" is not available yet: no host data source until Tier 2 \(assets\); seed the buffer with an init-phase compute stage$/);
    // After the schema: a config the schema refuses says that, not the gate.
    seeded[0].config = buffer({ elements: 0 });
    assert.deepEqual(checkNodes(seeded).diagnostics.map(d => d.path), ['/nodes/0/config/elements']);
    // A labelled lifted gate, as Tier 2 will lift it: the same node checks, and nothing else in the check moved.
    seeded[0].config = buffer();
    assert.equal(checkNodes(seeded, undefined, undefined, []).ok, true);

    // The manifest refuses a gate it could not enforce whole, before any node is checked against it.
    const broken = change => { const m = JSON.parse(ADAPTER_MANIFEST_TEXT); change(m); return () => checkManifest(m); };
    const gate = { adapter: 'ng.buffer.storage', path: '/init', value: 'upload', reason: 'r' };
    assert.doesNotThrow(broken(m => { m.unavailable = [gate]; }));
    assert.throws(broken(m => { m.unavailable = [{ ...gate, adapter: 'ng.buffer.store' }]; }), /there is no such adapter/);
    assert.throws(broken(m => { m.unavailable = [{ ...gate, path: '/layout' }]; }), /not an enum of its config that holds "upload"/);
    assert.throws(broken(m => { m.unavailable = [{ ...gate, path: '/elements' }]; }), /not an enum/);
    assert.throws(broken(m => { m.unavailable = [{ ...gate, path: 'init' }]; }), /not an enum/);
    assert.throws(broken(m => { m.unavailable = [{ adapter: 'ng.post.chain', path: '/effects/effect', value: 'Bloom', reason: 'r' }]; }), /not an enum/,
        'a path runs through properties, never into an array\'s items');
    assert.throws(broken(m => { m.unavailable = [{ ...gate, value: 'stream' }]; }), /holds "stream"/);
    assert.throws(broken(m => { m.unavailable = [gate, gate]; }), /"upload" is gated twice/);
    assert.throws(broken(m => { m.unavailable = [gate, { ...gate, value: 'zero' }]; }), /every value of the enum is gated/);
    assert.throws(broken(m => { m.unavailable = [{ ...gate, reason: ' ' }]; }), /its reason is 1 to 200 characters/);
    assert.throws(broken(m => { m.unavailable = [{ ...gate, why: 'x' }]; }), /a gate is exactly \{adapter, path, value, reason\}/);
    assert.throws(broken(m => { delete m.unavailable; }), /unavailable is not a list/);
});
