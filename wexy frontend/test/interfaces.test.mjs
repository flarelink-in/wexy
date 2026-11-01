// EA-I series, headless (EA3.4; engine-adapters-design.md §8, §10 EA-U6): module interfaces derived from X. The
// world's three interfaces are pinned: entries and signatures, bindings and who binds them, constants, chunks, where
// each answers in the program. Then EA-U6: change one interface and exactly its module is invalidated; change a chunk
// they share and every module that includes it is; change a host-side count, a material, an unrelated node, and none
// is. Then the refusals. No body is written or compiled: an interface is what EA4 writes against.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIM_BYTES } from '../src/contract/adapters/contribute.ts';
import { ABI_VERSION, EA_SIM_STRUCT, ENGINE_CHUNKS, LIGHTS_CHUNK, MAX_STORAGE_BUFFERS_PER_STAGE, deriveInterfaces, invalidated, notAuthorable } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { SIM_BYTES as H1_SIM_BYTES } from '../src/contract/wgsl.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });

/** EA-A2's nine adapters, with entries a body can define (a built-in or generated name refuses, EA-I3). */
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

async function interfaces(program, chunks) {
    const r = await resolveProgram(program);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph, chunks);
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    return d.interfaces;
}

async function refused(program, path, pattern, change) {
    const r = await resolveProgram(program);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const x = change ? change(structuredClone(r.graph)) : r.graph;
    const d = await deriveInterfaces(x);
    assert.equal(d.ok, false, `wanted a refusal at ${path}`);
    assert.ok(d.diagnostics.some(g => g.code === 'EA_RESOLVE' && g.path === path && pattern.test(g.message)), JSON.stringify(d.diagnostics));
}

/** A pointer into the retained program, through a node's parsed config. */
function walk(program, pointer) {
    let at = { nodes: program };
    for (const token of pointer.split('/').slice(1)) {
        assert.ok(at !== null && typeof at === 'object' && Object.hasOwn(at, token), `${pointer}: no ${token}`);
        at = at[token];
        if (token === 'config' && typeof at === 'string') at = JSON.parse(at);
    }
    return at;
}

test('EA-I1 the world\'s three interfaces: entries, bindings and who binds them, constants, chunks, places in the program', async () => {
    const program = world();
    const [motion, sky, water] = await interfaces(program);
    assert.deepEqual([motion.module, sky.module, water.module], ['motion', 'sky', 'water']);
    assert.deepEqual(motion.entries.map(e => [e.stage, e.signature, e.engineEntry]), [['compute', 'fn advance(index: u32)', 'cs_main']]);
    assert.deepEqual(motion.bindings.map(b => [b.group, b.binding, b.name, b.access, b.resource, b.version, b.boundBy]), [
        [0, 0, 'b_field_current', 'read', 'field#buffer', 'current', 'host'], [0, 1, 'b_instances', 'read_write', 'instances#buffer', null, 'host'],
        [1, 0, 'camera', 'uniform', '@host#camera', null, 'host'], [1, 1, 'sim', 'uniform', '@host#sim', null, 'host']]);
    assert.deepEqual(motion.constants, [{ name: 'B_field_STRIDE', value: 4 }, { name: 'B_instances_STRIDE', value: 14 }, { name: 'EA_INVOCATIONS', value: 64 }]);
    assert.equal(motion.workgroupSize, 64);
    assert.match(motion.epilogue, /@compute @workgroup_size\(64\)\nfn cs_main\(@builtin\(global_invocation_id\) id: vec3<u32>\) \{\n(    _ = .*;\n){4}    if \(id\.x >= EA_INVOCATIONS\) \{ return; \}\n    advance\(id\.x\);\n\}/);
    assert.deepEqual(sky.entries.map(e => [e.stage, e.signature]), [['fragment', 'fn dusk(uv: vec2<f32>) -> vec4<f32>']]);
    assert.deepEqual(sky.bindings.map(b => [b.group, b.binding, b.name, b.boundBy]), [[0, 0, 'camera', 'engine'], [0, 1, 'ecs', 'engine'], [1, 0, 'b_field_current', 'host']]);
    assert.deepEqual(water.entries.map(e => [e.stage, e.signature]), [
        ['vertex', 'fn wave(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, instance: u32) -> VertexOut'], ['fragment', 'fn shade(input: VertexOut) -> vec4<f32>']]);
    assert.deepEqual(water.chunks.map(c => c.id), ['materials:CommonChunks.CameraStruct', 'materials:CommonChunks.EngineBindings', 'materials:CommonChunks.VertexOut']);
    for (const i of [motion, sky, water]) {
        // The engine's chunks are in the preamble byte for byte; every binding is declared once, and used in the generated
        // entry, so layout 'auto' keeps it (the gotcha "null-graph owns bind group 0").
        for (const c of i.chunks) assert.ok(i.preamble.includes(ENGINE_CHUNKS[c.id.split('.').pop()]), `${i.module}: ${c.id}`);
        for (const b of i.bindings) {
            if (b.boundBy === 'host') assert.equal(i.preamble.split(b.declaration).length, 2, `${i.module}: ${b.name} declared once`);
            const use = b.access === 'uniform' ? `_ = ${b.name}.${b.name === 'sim' ? 'dt' : 'simTime'};` : `_ = arrayLength(&${b.name});`;
            assert.ok(i.epilogue.includes(use), `${i.module}: ${b.name} used`);
        }
        assert.ok(!/`/.test(i.preamble + i.epilogue), 'no backtick in generated WGSL');
        for (const p of [...i.paths, ...i.entries.map(e => e.path)]) walk(program, p);
    }
    assert.deepEqual([motion.consumers, sky.consumers, water.consumers], [['move#dispatch'], ['sky#draw'], ['water#draw']]);
    // Deterministic: the same X gives the same interfaces and hashes.
    assert.deepEqual((await interfaces(world())).map(i => i.interfaceHash), [motion, sky, water].map(i => i.interfaceHash));
});

test('EA-I2 EA-U6: one interface changed invalidates exactly its module; a shared chunk, every module that includes it; nothing else does', async () => {
    const base = await interfaces(world());
    const after = async (change, chunks) => { const w = world(); change(w); return invalidated(base, await interfaces(w, chunks)); };
    const set = (w, id, config) => { w.find(n => n.id === id).config = JSON.stringify(config); };
    assert.deepEqual(await after(w => set(w, 'move', { module: 'motion', entry: 'advance', workgroupSize: 128, invocations: 64, phase: 'fixedStep' })), ['motion'], 'workgroup size');
    assert.deepEqual(await after(w => set(w, 'move', { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 100, phase: 'fixedStep' })), ['motion'], 'the generated bound');
    assert.deepEqual(await after(w => set(w, 'move', { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'frame' })), ['motion'],
        'a fixed step reads its own clock, a frame the camera\'s: the phase is the interface\'s since ea-abi.v2 (Q81)');
    assert.deepEqual(await after(w => set(w, 'field', { elements: 8192, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' })), [], 'a host-side count');
    assert.deepEqual(await after(w => set(w, 'field', { elements: 4096, layout: 'f32', strideFloats: 8, pingPong: true, init: 'zero' })), ['motion', 'sky'], 'a stride both read');
    assert.deepEqual(await after(w => set(w, 'stone', { kind: 'toon', baseColor: [1, 1, 1, 1] })), [], 'a stock material is no module');
    assert.deepEqual(await after(w => { w.find(n => n.id === 'sky').inputs.push(from('reads', 'instances', 'buffer')); }), ['sky'], 'a binding added');
    assert.deepEqual(await after(w => set(w, 'water', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'tint', maxInstances: 1 })), ['water'], 'an entry renamed');
    // Names: code names a bound buffer, so renaming one invalidates its users; it names neither the consumer nor what
    // the batch draws, so renaming those invalidates nothing.
    const rename = (w, from, to) => { w.find(n => n.id === from).id = to; for (const n of w) for (const i of n.inputs) if (i.nodeId === from) i.nodeId = to; };
    assert.deepEqual(await after(w => rename(w, 'field', 'flow')), ['motion', 'sky'], 'a bound buffer renamed');
    assert.deepEqual(await after(w => rename(w, 'move', 'mover')), [], 'the consumer renamed');
    assert.deepEqual(await after(w => rename(w, 'cube', 'box')), [], 'the geometry renamed');
    // Without geometry a custom batch's vertex entry takes the vertex index, and its interface is another.
    const bare = world();
    bare.find(n => n.id === 'water').inputs = [];
    const water = (await interfaces(bare)).find(i => i.module === 'water');
    assert.equal(water.entries[0].signature, 'fn wave(vertex: u32, instance: u32) -> VertexOut');
    assert.match(water.epilogue, /fn vs_main\(@builtin\(vertex_index\) vertex: u32, @builtin\(instance_index\) instance: u32\) -> VertexOut \{/);
    assert.deepEqual(invalidated(base, await interfaces(bare)), ['water']);
    // A shared chunk: CameraStruct is in all three, EngineBindings in the two batches only, VertexOut in water only.
    const changed = name => ({ ...ENGINE_CHUNKS, [name]: `${ENGINE_CHUNKS[name]}// changed\n` });
    assert.deepEqual(await after(() => {}, changed('CameraStruct')), ['motion', 'sky', 'water']);
    assert.deepEqual(await after(() => {}, changed('EngineBindings')), ['sky', 'water']);
    assert.deepEqual(await after(() => {}, changed('VertexOut')), ['water']);
    // Lights: a lit custom batch's interface follows its light system's capacity; the unlit ones do not.
    const lit = w => { w.find(n => n.id === 'water').inputs.push(from('lights', 'sun', 'lights')); return w; };
    const litBase = await interfaces(lit(world()));
    const morePoints = lit(world());
    set(morePoints, 'sun', { ambient: [0.1, 0.1, 0.12], directional: null, points: [{ position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4 }] });
    assert.deepEqual(invalidated(litBase, await interfaces(morePoints)), ['water']);
    assert.ok(litBase.find(i => i.module === 'water').chunks.some(c => c.id === LIGHTS_CHUNK));
    // Custom lighting is derived, but not authored until the host's lighting contract exists (the EA4.2 review's
    // finding 2; the candidate-loop design §6): the lit batch is refused before any call, the rest of the world is not.
    assert.match(notAuthorable(litBase.find(i => i.module === 'water')), /water is a custom batch wired to lights, and custom lighting is not available yet/);
    for (const i of litBase.filter(i => i.module !== 'water')) assert.equal(notAuthorable(i), null, i.module);
    for (const i of await interfaces(world())) assert.equal(notAuthorable(i), null, `${i.module}, unlit`);
});

test('EA-I3 the refusals: a module two nodes share, an entry no body may define, two bindings of one name, too many storage buffers', async () => {
    const shared = world();
    shared.push(node('drift', 'ng.compute.stage', { module: 'motion', entry: 'drift', workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('writes', 'instances', 'buffer')]));
    await refused(shared, '/nodes/10/config/module', /module motion serves move and drift; a module serves one node in Tier 1/);
    for (const [entry, why] of [['filter', 'reserved'], ['step', 'built-in'], ['fs_main', 'generated'], ['camera', 'generated'], ['sim', 'generated'], ['b_extra', 'generated'], ['Advance', 'not lower-case first']]) {
        const w = world();
        w[2].config = JSON.stringify({ module: 'motion', entry, workgroupSize: 64, invocations: 64, phase: 'fixedStep' });
        await refused(w, '/nodes/2/config/module', new RegExp(`^${entry} cannot be an entry`), undefined, why);
    }
    const clash = world();
    clash.push(node('a-b', 'ng.buffer.storage', { elements: 4, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('a_b', 'ng.buffer.storage', { elements: 4, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }));
    clash[2].inputs.push(from('reads', 'a-b', 'buffer'), from('reads', 'a_b', 'buffer'));
    await refused(clash, '/nodes/2/config/module', /would declare b_a_b twice/);
    // A pair's half and a buffer named like it: field's current half and a buffer called field_current.
    const half = world();
    half.push(node('field_current', 'ng.buffer.storage', { elements: 4, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }));
    half[2].inputs.push(from('reads', 'field_current', 'buffer'));
    await refused(half, '/nodes/2/config/module', /would declare b_field_current twice/);

    // The EA3.4 review. 1: buffers that differ only by case are two buffers, with two constants, not one declared twice.
    const cased = world();
    cased.push(node('aB', 'ng.buffer.storage', { elements: 4, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
        node('ab', 'ng.buffer.storage', { elements: 4, layout: 'f32', strideFloats: 8, pingPong: false, init: 'zero' }));
    cased[2].inputs.push(from('reads', 'aB', 'buffer'), from('reads', 'ab', 'buffer'));
    const motion = (await interfaces(cased)).find(i => i.module === 'motion');
    assert.deepEqual(motion.constants.filter(c => /^B_a/i.test(c.name)), [{ name: 'B_aB_STRIDE', value: 4 }, { name: 'B_ab_STRIDE', value: 8 }]);
    for (const name of ['B_aB_STRIDE', 'B_ab_STRIDE', 'b_aB', 'b_ab']) assert.equal(motion.preamble.split(new RegExp(`\\b${name}\\b`)).length, 2, `${name} declared once`);
    // 2: a custom batch's two entries of one name, with geometry and without, refuse at the fragment entry.
    for (const geometry of [true, false]) {
        const w = world();
        w[7].config = JSON.stringify({ module: 'water', vertexEntry: 'shade', fragmentEntry: 'shade', maxInstances: 1 });
        if (!geometry) w[7].inputs = [];
        await refused(w, '/nodes/7/config/fragmentEntry', /water would define shade twice, as its vertex and fragment entries/);
    }
    // 3: what the generated wrappers call or declare, for every kind: a compute entry, a fullscreen one, a custom batch's.
    const entryAt = { 2: e => ({ module: 'motion', entry: e, workgroupSize: 64, invocations: 64, phase: 'fixedStep' }),
        8: e => ({ module: 'sky', fragmentEntry: e }), 7: e => ({ module: 'water', vertexEntry: e, fragmentEntry: 'shade', maxInstances: 1 }) };
    const paths = { 2: '/nodes/2/config/module', 8: '/nodes/8/config/fragmentEntry', 7: '/nodes/7/config/vertexEntry' };
    for (const [at, entries] of [[2, ['arrayLength', 'id', 'index', 'storage', 'read_write', 'u32', 'vec3']], [8, ['vec2', 'f32', 'p', 'out', 'input', 'uv', 'vertex']],
        [7, ['position', 'normal', 'instance', 'location', 'vec4']]]) {
        for (const entry of entries) {
            const w = world();
            w[at].config = JSON.stringify(entryAt[at](entry));
            await refused(w, paths[at], new RegExp(`^${entry} cannot be an entry`));
        }
    }
    // Tier 1's ports cap a stage at 8 storage buffers, WebGPU's default; a larger X (a future descriptor) refuses.
    await refused(world(), '/nodes/2/config/module', new RegExp(`binds 9 storage buffers in one stage, over WebGPU's default ${MAX_STORAGE_BUFFERS_PER_STAGE}`), x => {
        const dispatch = x.operations.find(o => o.id === 'move#dispatch');
        for (let i = 0; i < 7; i++) {
            x.resources.push({ ...x.resources.find(r => r.id === 'instances#buffer'), id: `extra${i}#buffer`, node: `extra${i}` });
            dispatch.accesses.push({ resource: `extra${i}#buffer`, mode: 'read', version: null, coverage: null });
        }
        return x;
    });
});

test('EA-I4 every identifier the generated code uses is one no entry can take, for every kind of interface', async () => {
    const { ENTRY_EXCLUDED } = await import('../src/contract/adapters/interfaces.ts');
    // Every shape the generator has: a compute stage with a pair and a plain buffer, a custom batch with geometry and
    // lights and one with neither, a fullscreen that reads a pair.
    const lit = world();
    lit[7].inputs.push(from('lights', 'sun', 'lights'));
    const bare = world();
    bare[7].inputs = [];
    const shapes = [...await interfaces(lit), ...await interfaces(bare)];
    assert.deepEqual([...new Set(shapes.map(i => i.kind))].sort(), ['compute', 'custom_batch', 'fullscreen']);
    for (const i of shapes) {
        // The identifiers it depends on: struct bodies' field names and member accesses are not module-scope names.
        const code = `${i.preamble}\n${i.epilogue}`.replace(/\/\/.*$/gm, '').replace(/struct\s+(\w+)\s*\{[^}]*\}/g, 'struct $1').replace(/\.\s*[A-Za-z_]\w*/g, '');
        const used = new Set(code.match(/\b[A-Za-z_]\w*\b/g));
        const entries = new Set(i.entries.map(e => e.entry));
        // `_` is WGSL's phony-assignment token, never a name.
        const loose = [...used].filter(t => t !== '_' && !ENTRY_EXCLUDED.has(t) && !/^(b_|B_|EA_)/.test(t) && !entries.has(t));
        assert.deepEqual(loose, [], `${i.module} (${i.kind}): generated code uses names an entry could take`);
    }
});

test('EA-I5 Q81 (ea-abi.v2): a fixed-step stage reads the host clock of its step; a frame stage and the draws keep the camera time', async () => {
    const [motion, sky, water] = await interfaces(world());
    assert.equal(ABI_VERSION, 'ea-abi.v2');
    assert.ok([motion, sky, water].every(i => i.abi === 'ea-abi.v2'), 'the ABI is in every interface, so every hash moved with it');
    // The clock: bound beside the camera at group 1, declared once in the preamble, used in cs_main so layout 'auto' keeps it.
    assert.deepEqual(motion.bindings.filter(b => b.access === 'uniform').map(b => [b.group, b.binding, b.name, b.resource]),
        [[1, 0, 'camera', '@host#camera'], [1, 1, 'sim', '@host#sim']]);
    assert.equal(motion.preamble.split(EA_SIM_STRUCT).length, 2);
    assert.ok(motion.preamble.includes('@group(1) @binding(1) var<uniform> sim: EaSim;'));
    assert.ok(motion.epilogue.includes('    _ = sim.dt;\n'));
    // h1's Sim layout without its particle count: four 32-bit words, the 16 bytes X allocates (EA-X2) and h1 writes.
    assert.deepEqual([...EA_SIM_STRUCT.matchAll(/(\w+): (f32|u32)/g)].map(m => [m[1], m[2]]), [['dt', 'f32'], ['time', 'f32'], ['step', 'u32'], ['_pad', 'u32']]);
    assert.deepEqual([SIM_BYTES, H1_SIM_BYTES], [16, 16]);
    // A frame stage has no clock of its own: it reads the camera time once a frame, as the draws do; an init stage too.
    for (const phase of ['frame', 'init']) {
        const other = world();
        other[2].config = JSON.stringify({ module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase });
        const [stage] = await interfaces(other);
        assert.deepEqual(stage.bindings.filter(b => b.access === 'uniform').map(b => b.name), ['camera'], phase);
        assert.ok(!stage.preamble.includes('EaSim') && !stage.epilogue.includes('sim.'), phase);
    }
    assert.ok(![sky, water].some(i => i.bindings.some(b => b.name === 'sim') || i.preamble.includes('EaSim')), 'draws keep the camera time');
    // The storage bindings are the stage's buffers only: the clock X lists among the dispatch's reads is no storage buffer.
    assert.deepEqual(motion.bindings.filter(b => b.access !== 'uniform').map(b => b.name), ['b_field_current', 'b_instances']);
});
