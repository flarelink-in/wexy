// A rig wired to an unlit material's batch (11-02, the castle's RCA): null-graph's basic, emissive and matcap shaders
// take no lights, so their pipelines have no group 2, and binding lights there is refused by WebGPU. The host lowers
// such a batch unlit, its rig still named in X, says so in a warning, and binds lights only where a shader takes them;
// a binding the device refuses stops the build in the device's own words. No GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as materials from 'null-graph/materials';
import { checkGraph } from '../src/contract/adapters/checks.ts';
import { LIT_MATERIALS } from '../src/contract/adapters/contribute.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { demandsOf } from '../src/exec/eligibility.ts';
import { buildVariant } from '../src/exec/engine-executor.ts';
import { probeCandidate } from '../src/exec/probe.ts';
import { sealSaved } from '../src/loop/replay.ts';
import { clock, costs, fakeHeadless, fakePort, from, node } from './exec-fakes.mjs';

const descriptors = JSON.parse(readFileSync(new URL('../src/contract/adapters/descriptors.json', import.meta.url), 'utf8'));
const KINDS = descriptors.adapters.find(a => a.id === 'ng.material.stock').config.properties.kind.enum;
const BUILDERS = {
    basic: materials.buildBasicShader, lambert: materials.buildLambertShader, emissive: materials.buildEmissiveShader,
    matcap: materials.buildMatcapShader, toon: materials.buildToonShader, pbr: materials.buildPBRShader,
};
const castle = async () => {
    const r = await sealSaved(readFileSync(new URL('../dev/replays/castle.json', import.meta.url), 'utf8'));
    assert.equal(r.ok, true, r.reason);
    return r.replay.snapshot;
};
const VIEW = { target: [0, 0, 0], distance: 30, azimuth: 0.6, polar: 1.2, fov: 45 };

test('LIT_MATERIALS is what the engine\'s own shader builders take: lambert, toon and pbr put the lights at group 2; basic, emissive and matcap take none', () => {
    const lighting = { wgslStructs: '/*the lights\' structs*/', wgslLogic: '/*the lights\' logic*/' };
    assert.deepEqual(Object.keys(BUILDERS).sort(), [...KINDS].sort(), 'a builder for every stock material the manifest names');
    for (const kind of KINDS) {
        const code = BUILDERS[kind]({ useSkinning: false, lighting });
        const takes = code.includes(lighting.wgslStructs) && code.includes(lighting.wgslLogic);
        assert.equal(LIT_MATERIALS.has(kind), takes, `${kind}: ${takes ? 'takes' : 'takes no'} lights in null-graph`);
    }
    assert.deepEqual([...LIT_MATERIALS].sort(), ['lambert', 'pbr', 'toon']);
});

test('a rig wired to an unlit material\'s batch: named in X, drawn unlit, said in a warning; a lit material\'s batch keeps its lights', async () => {
    const rig = { ambient: [0.2, 0.2, 0.2], directional: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }, points: [] };
    const nodes = [
        node('cells', 'ng.buffer.storage', { elements: 4, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('sun', 'ng.light.rig', rig),
        ...['emissive', 'basic', 'lambert'].flatMap(kind => [
            node(`${kind}mat`, 'ng.material.stock', { kind, baseColor: [1, 0.5, 0.5, 1] }),
            node(`${kind}batch`, 'ng.render.mesh_batch', { maxInstances: 4 },
                [from('geometry', 'cube', 'geometry'), from('material', `${kind}mat`, 'material'), from('instances', 'cells', 'buffer'), from('lights', 'sun', 'lights')]),
        ]),
    ];
    const r = await resolveProgram(nodes);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const x = r.graph;
    const op = id => x.operations.find(o => o.id === id);
    const readsLights = id => op(id).accesses.some(a => a.resource.startsWith('sun#'));
    for (const [kind, lit] of [['emissive', false], ['basic', false], ['lambert', true]]) {
        const create = op(`${kind}batch#create`);
        assert.deepEqual([create.args.lights, create.args.shader.lights, readsLights(`${kind}batch#draw`)], ['sun', lit, lit], `${kind}: its rig named; lit ${lit}`);
    }
    const checked = await checkGraph(x, POLICY_V1);
    assert.equal(checked.ok, true, 'a warning, never a refusal: the world is what it would be in the engine');
    const unlit = checked.findings.filter(f => /takes no lights/.test(f.message));
    assert.deepEqual(unlit.map(f => [f.node, f.severity, f.check, f.path]).sort(), [['basicbatch', 'warning', 'output', '/nodes/6'], ['emissivebatch', 'warning', 'output', '/nodes/4']],
        'emissive and basic, each once, at its batch');
    assert.equal(unlit.find(f => f.node === 'emissivebatch').message,
        'emissivebatch\'s emissive material takes no lights, so sun lights nothing of it: it draws unlit, as the engine draws emissive; unwire sun from it, or light it with lambert, toon or pbr');
    // What eligibility reads is what runs: each unlit batch demands no lights.
    const demands = demandsOf(x, 1280 * 720);
    assert.deepEqual(['emissivebatch', 'basicbatch', 'lambertbatch'].map(n => demands.find(d => d.node === n).values.lights), [['false'], ['false'], ['true']]);
});

test('the executor binds lights only where the shader takes them, and a binding the device refuses stops the build in its own words', async () => {
    const snap = await castle();
    // The castle, as this host lowers it: built over a fake engine that refuses lights where a shader takes none, as
    // WebGPU does; lights bound to the four lit batches alone, and the probe passes.
    const port = fakePort();
    const v = await buildVariant(snap, port, new AbortController().signal);
    assert.deepEqual(port.log.filter(l => l.startsWith('applyLights ')).map(l => l.slice(12)).sort(),
        ['batchhill#create', 'batchroof#create', 'batchstone#create', 'batchtower#create']);
    assert.ok(port.log.includes('createBatch batchflag#create stock:emissive 14x6 rgba16float'), 'the pennants\' shader built without lights');
    assert.deepEqual(v.release(), []);
    const time = clock();
    const { headless, made } = fakeHeadless(time, costs());
    const out = await probeCandidate(snap, { headless, now: () => time.t, view: () => VIEW, signal: new AbortController().signal, target: { width: 1280, height: 720 }, shared: false });
    assert.equal(out.ok, true, out.reason);
    assert.ok(made.every(h => h.destroyed && h.port.live.size === 0));
    // The live attempt's lowering, which bound the lights to the emissive pennants: refused at the build, in the
    // device's own words, with nothing left (before 11-02 the first frame met it as "invalid due to a previous error").
    const old = structuredClone(snap);
    old.x.operations.find(o => o.id === 'batchflag#create').args.shader.lights = true;
    const refusing = fakePort();
    await assert.rejects(buildVariant(old, refusing, new AbortController().signal),
        /^Error: EA_CALL batchflag#create: binding its material and lights failed: \[Invalid BindGroupLayout\] batchflag#create's pipeline has no binding at group 2 for the lights$/);
    assert.equal(refusing.live.size, 0, 'what the half-built world made, released');
});
