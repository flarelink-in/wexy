// The coverage worlds of 2026-11-02 (option B; executor-design.md §7, §10): programs written by hand, not by the model,
// that EA-G1 runs beside the live candidates so eligibility covers every value Tier 1 allows, each only from a clean run
// on that GPU. What keeps them fit for it, with no GPU: each written clean against the interfaces the host derives,
// sealed as written, and projected by the probe with only its counts moved; and together, every value the manifest lets
// a Tier-1 world use, each count at the most the manifest and P v1 allow.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkBody } from '../src/contract/adapters/bodies.ts';
import { primitive } from '../src/contract/adapters/contribute.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { COVERAGE_SCHEMA, demandsOf, eligibilityFrom } from '../src/exec/eligibility.ts';
import { buildVariant } from '../src/exec/engine-executor.ts';
import { probeCandidate, project } from '../src/exec/probe.ts';
import { COVERAGE_WORLDS, clock, costs, coverageWorld, fakeHeadless, fakePort, node, sealedCoverage } from './exec-fakes.mjs';

const descriptors = JSON.parse(readFileSync(new URL('../src/contract/adapters/descriptors.json', import.meta.url), 'utf8'));
const config = id => descriptors.adapters.find(a => a.id === id).config.properties;
/** EA-G1's canvas, 2048 × 1152: what its runs demand of a screen-sized node. */
const PIXELS = 2048 * 1152;
const sorted = values => [...values].sort();
const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const TARGET = { width: 1280, height: 720 };

test('the coverage worlds: each written clean against the interfaces the host derives, sealed as written, and projected by the probe with only its counts moved', async () => {
    for (const name of COVERAGE_WORLDS) {
        const f = coverageWorld(name);
        assert.match(f.note, /^A coverage world of 2026-11-02 /, `${name}: says what it is`);
        const snap = await sealedCoverage(name);
        assert.deepEqual(sorted(snap.bodies.map(b => `${b.module} ${b.interfaceHash} ${b.codeHash}`)), sorted(f.modules.map(m => `${m.module} ${m.interfaceHash} ${m.codeHash}`)),
            `${name}: each body written for the interface the host derives, and the text its codeHash names`);
        for (const iface of snap.interfaces) {
            const checked = await checkBody(iface, f.modules.find(m => m.module === iface.module).body);
            assert.deepEqual({ findings: checked.initial, fixes: checked.fixes }, { findings: [], fixes: [] }, `${name} ${iface.module}: no finding, nothing for the auto-fix`);
        }
        for (const fraction of [8, 4]) {
            const p = await project(snap, fraction);
            assert.notEqual(typeof p, 'string', `${name} at 1/${fraction}: ${p}`);
        }
    }
});

test('each coverage world builds through the executor\'s allowlist on a fake engine, runs its init, a step and a frame, and is probed, everything released', async () => {
    for (const name of COVERAGE_WORLDS) {
        const snap = await sealedCoverage(name);
        const time = clock();
        const port = fakePort({ clock: time, cost: costs() });
        port.width = TARGET.width;
        port.height = TARGET.height;
        const v = await buildVariant(snap, port, new AbortController().signal);
        v.world.runInit();
        v.world.runtime.step();
        v.world.runtime.resize(TARGET.width, TARGET.height);
        v.world.runtime.view(VIEW, 0);
        port.render(v.world.runtime.draw());
        assert.deepEqual(v.release(), [], `${name}: released`);
        assert.deepEqual([...port.live.values()], [], `${name}: every handle freed`);
        assert.deepEqual(port.errors, [], `${name}: none freed twice`);

        const probeClock = clock();
        const { headless, made } = fakeHeadless(probeClock, costs({ fixed: 0.05, perInvocation: 1e-6, perPixel: 1e-7, perInstance: 1e-6 }));
        const out = await probeCandidate(snap, { headless, now: () => probeClock.t, view: () => VIEW, signal: new AbortController().signal, target: TARGET, shared: false });
        assert.equal(out.ok, true, `${name}: ${out.reason}`);
        assert.ok(made.every(h => h.destroyed && h.port.live.size === 0), `${name}: every variant released`);
    }
});

test('the coverage worlds alone exercise every value Tier 1 allows, each count at the most the manifest and P v1 allow', async () => {
    const worlds = await Promise.all(COVERAGE_WORLDS.map(sealedCoverage));
    const entries = eligibilityFrom(worlds.flatMap(s => demandsOf(s.x, PIXELS)), { environment: 'a test', engineBundleHash: worlds[0].x.identity.bundleHash, evidence: 'a test' });
    const cov = Object.fromEntries(entries.map(e => [e.adapter, e.coverage]));
    assert.deepEqual(sorted(Object.keys(cov)), sorted(Object.keys(COVERAGE_SCHEMA)), 'every adapter with a coverage schema');

    // The values the manifest allows that a Tier-1 world can resolve: matcap needs a texture none makes, and an upload
    // a seed no Tier-1 source holds (descriptors' unavailable).
    const kinds = [];
    const classes = [];
    for (const kind of config('ng.material.stock').kind.enum) {
        const r = await resolveProgram([node('m', 'ng.material.stock', { kind, baseColor: [1, 1, 1, 1] })]);
        if (!r.ok) {
            assert.deepEqual([kind, r.diagnostics[0].code], ['matcap', 'EA_CAPABILITY_UNSUPPORTED'], 'matcap alone is refused');
            continue;
        }
        kinds.push(kind);
        classes.push(demandsOf(r.graph, PIXELS)[0].values.class[0]);
    }
    const inits = config('ng.buffer.storage').init.enum.filter(v => !descriptors.unavailable.some(u => u.adapter === 'ng.buffer.storage' && u.path === '/init' && u.value === v));
    assert.deepEqual(inits, ['zero']);
    const shapes = config('ng.geometry.primitive').shape.enum;
    const most = config('ng.geometry.primitive').segments.maximum;
    const counts = shapes.map(s => primitive(s, 1, most));

    assert.deepEqual(cov['ng.buffer.storage'].values, { layout: sorted(config('ng.buffer.storage').layout.enum), content: inits, pingPong: ['false', 'true'] });
    assert.deepEqual(cov['ng.compute.stage'].values, { phase: sorted(config('ng.compute.stage').phase.enum) });
    assert.deepEqual(cov['ng.geometry.primitive'].values, { factory: sorted(counts.map(c => c.factory)) });
    assert.deepEqual(cov['ng.material.stock'].values, { class: sorted(classes) });
    assert.deepEqual(cov['ng.render.mesh_batch'].values, { material: sorted(kinds), lights: ['false', 'true'] });
    // Custom lighting is gated (the seal refuses a lit custom batch): unlit alone, with geometry and with none.
    assert.deepEqual(cov['ng.render.custom_batch'].values, { vertexLayout: ['StandardLayout', 'none'], lights: ['false'] });
    assert.deepEqual(cov['ng.post.chain'].values, { effect: sorted(config('ng.post.chain').effects.items.properties.effect.enum) });

    // The counts. A 1-D dispatch's most is 65,535 workgroups (P v1) of the manifest's largest size, over a buffer of as
    // many floats, within P v1's 64 MiB; each shape is largest at the most segments; a rig's most lights are its four
    // points, the sun and the ambient; a batch's most instances are the manifest's, its vertices within P v1's frame.
    const dispatch = POLICY_V1.maxWorkgroupsPerDimension * config('ng.compute.stage').workgroupSize.maximum;
    assert.equal(cov['ng.buffer.storage'].max.bytes, dispatch * 4);
    assert.ok(dispatch * 4 <= POLICY_V1.maxBufferBytes);
    assert.deepEqual(cov['ng.compute.stage'].max, { invocations: dispatch, workgroups: POLICY_V1.maxWorkgroupsPerDimension, workgroupSize: config('ng.compute.stage').workgroupSize.maximum });
    assert.deepEqual(cov['ng.geometry.primitive'].max, { vertices: Math.max(...counts.map(c => c.vertices)), indices: Math.max(...counts.map(c => c.indices)) });
    assert.deepEqual(cov['ng.light.rig'].max, { lights: config('ng.light.rig').points.maxItems + 2 });
    for (const batch of ['ng.render.mesh_batch', 'ng.render.custom_batch']) {
        assert.equal(cov[batch].max.instances, config(batch).maxInstances.maximum, `${batch}: the most instances`);
        assert.ok(cov[batch].max.vertexInvocations <= POLICY_V1.maxVertexInvocationsPerFrame, `${batch}: within P v1's frame`);
    }
    assert.deepEqual(cov['ng.post.chain'].max, { effects: config('ng.post.chain').effects.maxItems, pixels: PIXELS });
    assert.deepEqual(cov['ng.render.fullscreen'].max, { pixels: PIXELS });
});
