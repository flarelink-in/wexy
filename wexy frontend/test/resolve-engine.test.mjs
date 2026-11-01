// EA-X3 to X5, headless (EA3.2; engine-adapters-design.md §7 "Memory and ownership"): the resolver's sizes are the
// engine's. Each is pinned against null-graph 1.2.1 as installed, by running the engine's own CPU code: Primitives
// builds every shape on the CPU, and the materials, LightSystem and PostChain are constructed against a recording fake
// device that hands back inert objects and writes down every createBuffer and createTexture. No GPU, no browser, no
// adapter; the resolver itself never imports the engine. This file sets GPU usage globals for the engine's code, so it
// is kept apart from test/resolve.test.mjs, which checks that resolving touches none.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Primitives, StandardLayout } from 'null-graph/geometry';
import { LIGHT_BYTES, MATERIAL_UNIFORM_BYTES, PARAM_SLICE_BYTES, POST_BATCH_BYTES, VERTEX_BYTES, primitive } from '../src/contract/adapters/contribute.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/**
 * A device that records allocations and answers everything else with an inert object; and an engine that records the
 * passes and batches registered with it, the batches cleared and the passes removed.
 */
function recordingEngine(width, height) {
    const log = [];
    const registered = { passes: [], batches: [], cleared: 0, removed: [] };
    const inert = label => new Proxy(function () {}, {
        get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 0 : p === Symbol.iterator ? function* () {} : p === 'length' ? 0 : inert(`${label}.${String(p)}`)),
        apply: () => inert(`${label}()`),
        construct: () => inert(`new ${label}`),
    });
    const device = new Proxy({}, {
        get: (_t, p) => {
            if (p === 'createBuffer') return d => { log.push({ kind: 'buffer', label: d.label ?? null, size: d.size }); return inert('buffer'); };
            if (p === 'createTexture') return d => { log.push({ kind: 'texture', label: d.label ?? null, size: d.size, format: d.format }); return inert('texture'); };
            return inert(`device.${String(p)}`);
        },
    });
    const engine = new Proxy({
        device, width, height, textureManager: { fallbackWhite: {}, fallbackNormal: {} },
        createPass: config => { const pass = { name: config.name, isMainScreenPass: config.isMainScreenPass, batches: [] }; registered.passes.push(pass); return pass; },
        createBatch: (pass, config) => { const batch = { pass: pass.name, bytes: config.maxInstances * config.strideFloats * 4 }; pass.batches.push(batch); registered.batches.push(batch); return batch; },
        clearBatch: () => { registered.cleared++; },
        removePass: pass => { registered.removed.push(pass); return true; },
    }, { get: (t, p) => (p in t ? t[p] : inert(`engine.${String(p)}`)) });
    return { engine, log, registered };
}

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });

test('EA-X3 every primitive\'s counts are Primitives\' own, for every shape and every segments from 3 to 128', async () => {
    assert.equal(StandardLayout.strideFloats * 4, VERTEX_BYTES);
    const shapes = ['cube', 'octahedron', 'plane', 'pyramid', 'icosahedron', 'dodecahedron', 'tetrahedron', 'sphere', 'torus', 'cylinder', 'cone', 'capsule', 'ring'];
    let checked = 0;
    for (const shape of shapes) {
        for (let segments = 3; segments <= 128; segments++) {
            const call = primitive(shape, 1, segments);
            const g = Primitives[call.factory](StandardLayout, ...call.params);
            assert.equal(g.vertices.length / StandardLayout.strideFloats, call.vertices, `${shape} ${segments}: vertices`);
            assert.equal(g.indices.length, call.indices, `${shape} ${segments}: indices`);
            assert.equal(g.indices.BYTES_PER_ELEMENT, call.indexBytes, `${shape} ${segments}: index width`);
            checked++;
        }
    }
    assert.equal(checked, 13 * 126);
    // The mapping of {shape, size, segments} to a Primitives call is this adapter's decision, and X carries it to EA5,
    // which must make exactly these calls: pinned, so a change to it is seen.
    assert.deepEqual(Object.fromEntries(shapes.map(s => { const c = primitive(s, 2, 16); return [s, [c.factory, ...c.params]]; })), {
        cube: ['createCube', 2, 2, 2], octahedron: ['createOctahedron', 2, 2, 2], plane: ['createPlane', 2, 2], pyramid: ['createPyramid', 2, 2, 2],
        icosahedron: ['createIcosahedron', 1], dodecahedron: ['createDodecahedron', 1], tetrahedron: ['createTetrahedron', 1],
        sphere: ['createSphere', 1, 16, 8], torus: ['createTorus', 0.75, 0.25, 8, 16], cylinder: ['createCylinder', 1, 1, 2, 16, 1],
        cone: ['createCone', 1, 2, 16, 1], capsule: ['createCapsule', 0.5, 1, 4, 16], ring: ['createRing', 0.5, 1, 16],
    });
    // The bytes X counts are Geometry.upload's: the vertices exactly, the indices rounded up to 4 (createIndexBuffer).
    const r = await resolveProgram([node('ball', 'ng.geometry.primitive', { shape: 'sphere', size: 2, segments: 7 })]);
    const bytes = id => r.graph.resources.find(x => x.id === id).bytes;
    const g = Primitives.createSphere(StandardLayout, 1, 7, 4);
    assert.equal(bytes('ball#vertices'), g.vertices.byteLength);
    assert.equal(bytes('ball#indices'), Math.ceil(g.indices.byteLength / 4) * 4);
});

test('EA-X4 the stock materials\' uniform buffers and LightSystem\'s light buffer are the engine\'s, through a recording device', async () => {
    const materials = await import('null-graph/materials');
    const classes = { basic: 'BasicMaterial', lambert: 'LambertMaterial', emissive: 'EmissiveMaterial', toon: 'ToonMaterial', pbr: 'StandardPBRMaterial' };
    for (const [kind, name] of Object.entries(classes)) {
        const { engine, log } = recordingEngine(1, 1);
        new materials[name](engine, { baseColor: [1, 1, 1, 1] });
        assert.deepEqual(log.map(l => [l.kind, l.size]), [['buffer', MATERIAL_UNIFORM_BYTES[kind]]], `${name}`);
        const r = await resolveProgram([node('m', 'ng.material.stock', { kind, baseColor: [1, 1, 1, 1] })]);
        assert.equal(r.graph.resources.find(x => x.id === 'm#uniform').bytes, MATERIAL_UNIFORM_BYTES[kind]);
    }
    // Matcap needs a texture the engine has no fallback for; X refuses it rather than inventing one.
    const matcap = await resolveProgram([node('m', 'ng.material.stock', { kind: 'matcap', baseColor: [1, 1, 1, 1] })]);
    assert.deepEqual(matcap.diagnostics.map(d => [d.code, d.path]), [['EA_CAPABILITY_UNSUPPORTED', '/nodes/0/config/kind']]);

    const { LightSystem } = await import('null-graph/lights');
    for (const [points, directional] of [[0, false], [4, true], [2, false]]) {
        const { engine, log } = recordingEngine(1, 1);
        const ls = new LightSystem(engine, { technique: 'standard', capacity: { point: points, directional: directional ? 1 : 0, spot: 0, ambient: 1 } });
        assert.equal(ls.requiresCompute, false, 'standard lighting adds no compute stage');
        const config = {
            ambient: [0.1, 0.1, 0.1], directional: directional ? { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 } : null,
            points: Array.from({ length: points }, () => ({ position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4 })),
        };
        const r = await resolveProgram([node('rig', 'ng.light.rig', config)]);
        assert.deepEqual(log.map(l => [l.kind, l.size]), [['buffer', r.graph.resources.find(x => x.id === 'rig#lights').bytes]], `${points} points`);
        assert.equal(r.graph.resources.find(x => x.id === 'rig#lights').bytes, (1 + points + (directional ? 1 : 0)) * LIGHT_BYTES);
    }
});

test('EA-X5 the post chain\'s pool and arena are PostChain\'s, for every built-in effect and longer chains, at two viewports', async () => {
    const post = await import('null-graph/post');
    const all = ['AutoExposure', 'Bloom', 'Bokeh', 'CelShade', 'ChromaticAberration', 'ColorGrade', 'FXAA', 'FilmGrain', 'GodRays', 'Halation', 'Kuwahara', 'LensFlare', 'Outline', 'SSAO', 'Tonemap', 'Vignette'];
    const chains = [...all.map(e => [e]), ['FilmGrain', 'Vignette'], ['SSAO', 'Bloom', 'Halation', 'Tonemap', 'FXAA', 'Outline', 'Vignette'],
        ['AutoExposure', 'Bloom', 'LensFlare', 'Bokeh', 'ColorGrade', 'ChromaticAberration', 'Kuwahara', 'CelShade'], ['Bloom', 'Bloom']];
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1001, height: 563 }]) {
        for (const effects of chains) {
            const { engine, log, registered } = recordingEngine(viewport.width, viewport.height);
            // The adapter's own construction: scene depth declared, so the batches keep their depth test.
            const chain = new post.PostChain(engine, { gbuffer: { depth: 'depth24plus' } });
            chain.setChain(effects.map(e => new post[e]()));
            const report = chain.memoryReport();
            const arena = log.filter(l => l.label === 'PostChain_ParamArena').map(l => l.size);
            const r = await resolveProgram([node('look', 'ng.post.chain', { effects: effects.map(effect => ({ effect, intensity: 1 })) })], { ...POLICY_V1, viewport });
            assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
            const own = r.graph.resources.filter(x => x.node === 'look');
            const pool = own.filter(x => x.kind === 'texture');
            const label = `${effects.join('+')} at ${viewport.width}x${viewport.height}`;
            assert.equal(pool.reduce((s, x) => s + x.bytes * x.allocations, 0), report.bytesWithoutAliasing, `${label}: pool bytes`);
            assert.equal(pool.reduce((s, x) => s + x.allocations, 0), report.logicalTargets + pool.filter(x => x.allocations === 2).length, `${label}: logical targets`);
            assert.ok(report.bytes <= report.bytesWithoutAliasing, `${label}: aliasing only lowers the pool`);
            assert.deepEqual(own.filter(x => x.id === 'look#params').map(x => x.bytes), arena, `${label}: the parameter arena`);
            assert.equal(arena[0], effects.length * PARAM_SLICE_BYTES);

            // The engine gets a pass and a 32-byte batch for each compiled pass, and one more of each for the debug view.
            const objects = Object.fromEntries(r.graph.objects.filter(o => o.node === 'look').map(o => [o.kind, o.count]));
            const debug = registered.passes.filter(p => p.name === 'Post/DebugView');
            assert.equal(debug.length, 1, `${label}: one debug view`);
            assert.equal(registered.passes.length, objects.postPasses + 1, `${label}: passes`);
            assert.equal(registered.batches.length, objects.postBatches + 1, `${label}: batches`);
            assert.ok(registered.batches.every(b => b.bytes === POST_BATCH_BYTES), `${label}: each batch's storage`);
            const storage = own.find(x => x.id === 'look#batchStorage');
            assert.deepEqual([storage.bytes, storage.allocations], [POST_BATCH_BYTES, objects.postBatches]);
            const sequence = [...chain.getPassSequence()];
            assert.equal(sequence.length, objects.postPasses, `${label}: the sequence is the compiled passes`);
            assert.ok(sequence.every(p => p.batches.length === 1) && !sequence.some(p => p.name === 'Post/DebugView'), `${label}: one batch each`);
            // 1.2.1: destroy() clears each batch the chain registered, the debug view's included, and removes each of its
            // passes (releaseEngineNodes), so X's post.destroy releases them all; 1.2.0 cleared none and kept the passes.
            chain.destroy();
            assert.equal(registered.cleared, objects.postBatches + 1, `${label}: PostChain.destroy() clears every batch it made`);
            assert.equal(new Set(registered.removed).size, registered.passes.length, `${label}: and removes every pass it made, once`);
            assert.ok(registered.removed.every(p => registered.passes.includes(p)), `${label}: its own passes only`);
            for (const id of ['look#batchStorage', 'look#debugStorage']) assert.equal(own.find(x => x.id === id).releasedBy, 'look#destroy', `${label}: ${id}`);
            assert.throws(() => chain.getPassSequence(), /before setChain/);
        }
    }
});

test('EA-X13 what NullGraph keeps after a world lets go, and the 1.2.1 calls that release one pass or one compute stage', async () => {
    const { NullGraph } = await import('null-graph');
    const engine = new NullGraph();
    // CPU only: no init, no device. The stage factory is stubbed; the bookkeeping under test is the engine's own.
    engine.batchManager = { createComputeStage: config => ({ name: config.name }) };
    const rendered = [];
    engine.renderPipeline = { render: sequence => { rendered.push(sequence); } };
    const main = engine.createPass({ name: 'main', isMainScreenPass: true });
    engine.createPass({ name: 'other', isMainScreenPass: false });
    const stage = engine.createComputeStage({ name: 'step', shaderCode: '', dispatchCount: [1, 1, 1] });
    assert.deepEqual([engine.passes.length, engine.computeStages.length], [2, 1], 'createPass and createComputeStage keep what they make');
    // An explicit sequence never reads the list; render() without one draws every pass the engine keeps.
    engine.render([stage, main]);
    engine.render();
    assert.deepEqual(rendered, [[stage, main], engine.passes]);
    // 1.2.1: removePass forgets the one pass it names, and removeComputeStage the one stage (X's @host#removePass and
    // <stage>#drop); each says whether the engine held it. clearPasses() still forgets every pass, and X never calls it.
    const other = engine.passes[1];
    assert.deepEqual([engine.removePass(other), engine.removePass(other)], [true, false]);
    assert.deepEqual(engine.passes, [main], 'only the named pass is forgotten: another world\'s stays');
    assert.deepEqual([engine.removeComputeStage(stage), engine.removeComputeStage(stage), engine.computeStages.length], [true, false, 0]);
    engine.render();
    assert.deepEqual(rendered.at(-1), [main], 'render() without a sequence stops drawing a removed pass');
    engine.clearPasses();
    assert.deepEqual([engine.passes.length, engine.computeStages.length], [0, 0]);
    const releasing = Object.getOwnPropertyNames(NullGraph.prototype).filter(n => /remove|release|forget|drop|clear|destroy|dispose/i.test(n)).sort();
    assert.deepEqual(releasing, ['clearBatch', 'clearBatches', 'clearPasses', 'destroy', 'removeComputeStage', 'removePass'],
        'null-graph changed its release calls: X\'s releases must follow them');
});

test('EA-X14 the checks\' effect order is the engine\'s: EFFECT_ORDER itself, and orderChain\'s sort on every chain tried', async () => {
    const post = await import('null-graph/post');
    const { EFFECT_ORDER, orderEffects } = await import('../src/contract/adapters/checks.ts');
    assert.deepEqual([...EFFECT_ORDER], [...post.EFFECT_ORDER]);
    // A fixed shuffle of the sixteen, and chains with repeats and the same effect apart, against orderChain itself.
    const all = [...post.EFFECT_ORDER];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const chains = [all, [...all].reverse(), ['FilmGrain', 'Bloom', 'Tonemap', 'Vignette', 'SSAO'], ['Bloom', 'Tonemap', 'Bloom'], ['Vignette', 'FilmGrain', 'Vignette']];
    const shuffled = () => { const a = [...all]; for (let i = a.length - 1; i > 0; i--) { const j = next() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    for (let k = 0; k < 20; k++) chains.push(shuffled().slice(0, 2 + (next() % 7)));
    for (const names of chains) {
        assert.deepEqual(orderEffects(names), post.orderChain(names.map(n => new post[n]())).map(e => e.name), names.join());
    }
});

test('EA-X15 the interfaces\' engine chunks are null-graph\'s CommonChunks, byte for byte', async () => {
    const { CommonChunks } = await import('null-graph/materials');
    const { ENGINE_CHUNKS } = await import('../src/contract/adapters/interfaces.ts');
    for (const [name, text] of Object.entries(ENGINE_CHUNKS)) assert.equal(text, CommonChunks[name], name);
});
