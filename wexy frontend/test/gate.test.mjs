// EA-D3, the gate's part of EA-D8, EA-D10, EA-D11 and EA-D16, headless (EA5.3; executor-design.md §7, §10, where these
// were EA-X3, X8, X10, X11 and X16): the authority with the stage's gate over the live candidates, L3's verdicts made by
// the device compiler over a fake GPUDevice. No GPU.
//   EA-D3  a buffer over maxBufferSize, a dispatch over the device's limit, an adapter with no eligibility, an X naming a
//          call the executor never runs, no GPU go: each refused in its own words, nothing reserved
//   EA-D8  copied verdicts, another device's, an old generation's, a stale go (another turn, candidate or generation): the
//          gate refuses in exact words and no construction opens
//   EA-D10 eligibility outside coverage (a config value, a work dimension, a version, a browser, a bundle, a profile),
//          unknown adapter info, one fixture's coverage for another world, a malformed file: refused; the EA-G1
//          bootstrap admits only what it pinned, under every other rule, and the stage's gate has no such door
//   EA-D11 the reservation: B admits, B+1 refuses; the Head's bytes count; a borrowed alias counts once; two builds at
//          once count twice; a reservation is handed over once and returned once
//   EA-D16 Q90's two caps: a 4K film of foggy-dusk beside its Head admits though P v1's 256 MiB is less than its bytes; a
//          stage swap from an h1 Head admits; 1 GiB plus one byte refuses
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import {
    COVERAGE_SCHEMA, EXECUTOR_PROFILE, SHIPPED, adapterIdentity, browserOf, demandsOf, eligibilityFrom, eligibilityOf, environmentOf, osOf, parseEligibility,
} from '../src/exec/eligibility.ts';
import { DEVICE_BUDGET, createGate, createGoLedger, createMemoryLedger, limitsOf, reservationFor } from '../src/exec/gate.ts';
import { envelopeOf } from '../src/exec/stage.ts';
import { createAuthority, instantiate } from '../src/loop/executor.ts';
import { MAX_LIVE_PIXELS } from '../src/runtime/viewport.ts';
import { DEFAULT_LIMITS, ENV, ENVIRONMENT, cleanDevice, compileAll, eligibilityFor, present, sealedLive } from './exec-fakes.mjs';

const STAGE = { width: 1280, height: 720 };
/** This laptop's two GPUs as EA-G1 keyed them (dev/out/ea-g1, 11-01), with Chrome's WebGPU developer features on. */
const AMD_IGPU = 'ea5-env.v2|amd|gcn-5|0x1638|AMD Radeon(TM) Graphics|d3d12|windows|chrome/156';
const GTX_1650 = 'ea5-env.v2|nvidia|turing|0x1f99|NVIDIA GeForce GTX 1650|d3d12|windows|chrome/156';
const short = id => `${id.slice(0, 12)}…`;

/** The world under test with its gate: a device compiler and its verdicts, the go, the ledger, eligibility for it. */
async function setup(name = 'galaxy', { limits = DEFAULT_LIMITS, eligibility, environment = ENV, target = STAGE, ledger = createMemoryLedger(), bootstrap } = {}) {
    const snap = await sealedLive(name);
    const now = present();
    const dev = cleanDevice();
    const compiler = createDeviceCompiler(dev.device, { generation: () => now.d, gpu: 'Fake GPU' });
    const compiled = await compileAll(snap, compiler);
    const goes = createGoLedger();
    const gate = createGate({
        limits, compiler: () => compiler, goes, present: now, ledger, target: () => target, environment, gpu: 'Fake GPU',
        eligibility: eligibility ?? eligibilityFor([snap], { pixels: target.width * target.height }), bootstrap,
    });
    const authority = createAuthority(gate.gate);
    const admit = ({ press = true, verdicts = compiled, gpuGo } = {}) => {
        if (press) goes.press(snap.id, now.turn(), now.device());
        return authority.admit(snap, { compiled: verdicts, gpuGo: gpuGo ?? goes.holds(snap.id, now.turn(), now.device()) }, now);
    };
    return { snap, now, dev, compiler, compiled, goes, gate, authority, admit, ledger };
}

test('EA-D3 the gate: limits, eligibility, the allowlist and the GPU go, each refused in its own words, nothing reserved', async () => {
    const ok = await setup('galaxy');
    const admitted = ok.admit();
    assert.equal(admitted.ok, true, admitted.reason);
    const held = ok.gate.claim(ok.snap);
    assert.ok(held, 'the admission\'s reservation is handed over');
    assert.equal(held.bytes, reservationFor(ok.snap.x, STAGE).total);
    assert.equal(ok.gate.claim(ok.snap), null, 'once');
    held.release();

    const refusal = async (options, expected, what) => {
        const s = await setup('galaxy', options);
        const r = s.admit();
        assert.equal(r.ok, false, what);
        assert.equal(r.reason, expected, what);
        assert.equal(s.ledger.held(), 0, `${what}: nothing reserved`);
        assert.equal(s.goes.holds(s.snap.id, s.now.turn(), s.now.device()), false, `${what}: the go is spent`);
    };
    await refusal({ limits: { ...DEFAULT_LIMITS, maxBufferSize: 600_000 } }, 'EA_ADMIT stars#buffer allocation bytes: 672000 over 600000 on Fake GPU', 'a buffer over maxBufferSize');
    await refusal({ limits: { ...DEFAULT_LIMITS, maxComputeWorkgroupsPerDimension: 100 } }, 'EA_ADMIT seed#create workgroups a dimension: 188 over 100 on Fake GPU', 'a dispatch over the limit');
    await refusal({ limits: { ...DEFAULT_LIMITS, maxComputeWorkgroupSizeX: 32 } }, 'EA_ADMIT seed#create workgroup size: 64 over 32 on Fake GPU', 'a workgroup over the limit');
    await refusal({ limits: { ...DEFAULT_LIMITS, maxStorageBufferBindingSize: 600_000 } }, 'EA_ADMIT galaxyInit binding b_stars bytes: 672000 over 600000 on Fake GPU', 'a bound range over the limit');
    await refusal({ limits: { ...DEFAULT_LIMITS, maxTextureDimension2D: 1000 } }, 'EA_ADMIT @host#depth texture side: 1280 over 1000 on Fake GPU', 'a texture over the limit');
    const noPost = s => eligibilityFor([s], { edit: entries => entries.filter(e => e.adapter !== 'ng.post.chain') });
    const g = await sealedLive('galaxy');
    await refusal({ eligibility: noPost(g) }, `EA_ELIGIBILITY ng.post.chain@1 (node glow) has no coverage for ${ENVIRONMENT} (${EXECUTOR_PROFILE}); static only`, 'an adapter with no eligibility');
    // The shipped file holds EA-G1's entries alone (EA5.4): this laptop's two GPUs, each its exact model. Any other
    // environment is refused, named: fail-closed.
    assert.equal(SHIPPED.ok, true);
    assert.deepEqual([...new Set(SHIPPED.entries.map(e => e.environment))].sort(), [AMD_IGPU, GTX_1650].sort());
    await refusal({ eligibility: SHIPPED }, `EA_ELIGIBILITY ng.buffer.storage@1 (node stars) has no coverage for ${ENVIRONMENT} (${EXECUTOR_PROFILE}); static only`, 'another environment: fail-closed');

    // No GPU go: the authority refuses before the gate; a program or evidence claiming one meets the gate's ledger (P7).
    const s = await setup('galaxy');
    assert.deepEqual(s.admit({ press: false }), { ok: false, reason: 'no GPU go: the host gives it, never a program' });
    const claimed = s.admit({ press: false, gpuGo: true });
    assert.equal(claimed.reason, `EA_EVIDENCE ${short(s.snap.id)}: no GPU go for this candidate in turn 1 on device generation 1: press Run on this GPU for it`);
    assert.equal(s.ledger.held(), 0);

    // An X naming a call the executor never runs refuses before anything is allocated (the gate, called directly with a
    // look-alike that only the seal check above it would stop).
    const forged = structuredClone(s.snap);
    forged.x.operations.find(o => o.id === 'spin#dispatch').call = 'device.destroy';
    s.goes.press(s.snap.id, 1, 1);
    assert.equal(s.gate.gate(forged, { compiled: s.compiled, gpuGo: true }), 'EA_CALL spin#dispatch: device.destroy is not one the executor runs');
    assert.equal(s.ledger.held(), 0);
});

test('EA-D8 at the gate: copied verdicts, another device\'s, an old generation\'s and a stale go refuse in exact words, and no construction opens', async () => {
    const s = await setup('galaxy');
    const constructions = [];
    const executor = { instantiate: () => { constructions.push(1); return { run: async () => {}, release: async () => {}, prepare: async () => {}, commit: () => {} }; } };
    const attempt = async verdicts => {
        const r = s.admit({ verdicts });
        if (r.ok) {
            s.gate.claim(s.snap)?.release();
            await instantiate(s.snap, r.admission, executor, s.now, new AbortController().signal);
        }
        return r;
    };
    const first = s.snap.bodies[0].module;
    const copy = await attempt(structuredClone(s.compiled));
    assert.equal(copy.reason, `EA_EVIDENCE ${short(s.snap.id)}: the compile verdict for ${first} is not one this device's compiler made: a copy, a fake's or another device's proves nothing`);
    const other = createDeviceCompiler(cleanDevice().device, { generation: () => s.now.d, gpu: 'Another GPU' });
    const theirs = await attempt(await compileAll(s.snap, other));
    assert.equal(theirs.reason, copy.reason, 'another device\'s verdicts are not this compiler\'s');
    s.now.d = 2;
    const old = await attempt(s.compiled);
    assert.equal(old.reason, `EA_EVIDENCE ${short(s.snap.id)}: the compile verdict for ${first} is from device generation 1, and the device is at 2: compile it again`);
    assert.equal(constructions.length, 0, 'no construction opened');

    // A stale go: pressed in another turn, for another candidate, or on another generation.
    const fresh = await compileAll(s.snap, s.compiler);
    s.goes.press(s.snap.id, 1, 2);
    s.now.t = 2;
    let r = s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now);
    assert.equal(r.reason, `EA_EVIDENCE ${short(s.snap.id)}: no GPU go for this candidate in turn 2 on device generation 2: press Run on this GPU for it`);
    s.goes.press('another-candidate', 2, 2);
    r = s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now);
    assert.equal(r.ok, false, 'a go for another id(C)');
    s.goes.press(s.snap.id, 2, 1);
    r = s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now);
    assert.equal(r.ok, false, 'a go from before the device moved');
    assert.equal(constructions.length, 0);
    // And one go is one attempt: after an admission, none stands.
    s.goes.press(s.snap.id, 2, 2);
    r = s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now);
    assert.equal(r.ok, true, r.reason);
    s.gate.claim(s.snap).release();
    assert.equal(s.goes.holds(s.snap.id, 2, 2), false);
    assert.equal(s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now).ok, false, 'a second attempt needs a second press');
    // A lost device voids every verdict, and nothing it made admits after.
    s.dev.lose();
    await new Promise(resolve => setTimeout(resolve, 0));
    s.goes.press(s.snap.id, 2, 2);
    r = s.authority.admit(s.snap, { compiled: fresh, gpuGo: true }, s.now);
    assert.equal(r.reason, `EA_EVIDENCE ${short(s.snap.id)}: the device was lost (the GPU process went away): its compile verdicts prove nothing now`);
});

test('EA-D10 eligibility: outside coverage, unknown adapter info, one fixture for another world and a malformed file refuse; the bootstrap admits only what EA-G1 pinned', async () => {
    const galaxy = await sealedLive('galaxy');
    const refused = async (eligibility, expected, what, options = {}) => {
        const s = await setup('galaxy', { eligibility, ...options });
        const r = s.admit();
        assert.equal(r.ok, false, what);
        if (expected instanceof RegExp) assert.match(r.reason, expected, what);
        else assert.equal(r.reason, expected, what);
    };
    const where = `${ENVIRONMENT} (${EXECUTOR_PROFILE})`;
    const edit = fn => eligibilityFor([galaxy], { edit: entries => entries.map(e => fn(structuredClone(e)) ?? e) });
    await refused(edit(e => { if (e.adapter === 'ng.render.mesh_batch') e.coverage.values.material = ['lambert']; return e; }),
        `EA_ELIGIBILITY ng.render.mesh_batch@1 (node galaxy): material emissive has no coverage for ${where}; static only`, 'a config value outside');
    await refused(edit(e => { if (e.adapter === 'ng.compute.stage') e.coverage.max.invocations = 6000; return e; }),
        `EA_ELIGIBILITY ng.compute.stage@1 (node seed): invocations 12032 over 6000 has no coverage for ${where}; static only`, 'a work dimension outside');
    await refused(edit(e => { if (e.adapter === 'ng.compute.stage') e.adapterVersion = 2; return e; }),
        `EA_ELIGIBILITY ng.compute.stage@1 (node seed) has no coverage for ${where}; static only`, 'another adapter version');
    const elsewhere = `EA_ELIGIBILITY ng.buffer.storage@1 (node stars) has no coverage for ${where}; static only`;
    await refused(eligibilityFor([galaxy], { environment: ENVIRONMENT.replace('chrome/156', 'chrome/157') }), elsewhere, 'another browser');
    await refused(eligibilityFor([galaxy], { environment: 'ea5-env.v2|nvidia|turing|0x1f91|NVIDIA GeForce GTX 1650|d3d12|windows|chrome/156' }), elsewhere, 'another GPU');
    // Another model of the same architecture is another environment: one model's run never covers its family (H2).
    await refused(eligibilityFor([galaxy], { environment: ENVIRONMENT.replace('0x15d8|AMD Radeon(TM) Vega 8 Graphics', '0x1636|AMD Radeon(TM) Graphics') }), elsewhere, 'another model, one architecture');
    await refused(eligibilityFor([galaxy], { environment: ENVIRONMENT.replace('|windows|', '|linux|') }), elsewhere, 'another operating system');
    await refused(eligibilityFor([galaxy], { environment: ENVIRONMENT.replace('|d3d12|', '|vulkan|') }), elsewhere, 'another backend');
    await refused(edit(e => { e.engineBundleHash = '0'.repeat(64); return e; }), /^EA_ELIGIBILITY ng\.buffer\.storage@1 \(node stars\) has no coverage/, 'another engine bundle');
    await refused(edit(e => { e.executorProfile = 'ea5-exec.v0'; return e; }), /has no coverage/, 'another executor profile');
    const hidden = "this browser hides the GPU's model (its device and description), and eligibility is per model: Chrome shows them with chrome://flags/#enable-webgpu-developer-features";
    await refused(eligibilityFor([galaxy]), `EA_ELIGIBILITY ng.buffer.storage@1 (node stars) has no coverage for an unknown environment (${hidden}) (${EXECUTOR_PROFILE}); static only`,
        'a model the browser hides', { environment: { unknown: hidden } });
    // One fixture's coverage promotes neither an adapter nor a family: block-film's entries do not cover galaxy.
    await refused(eligibilityFor([await sealedLive('block-film')]), /^EA_ELIGIBILITY /, 'block-film\'s coverage for galaxy');
    // Ranges from two entries are never combined: one covers the work, the other the value, neither both.
    const split = eligibilityFor([galaxy], {
        edit: entries => entries.flatMap(e => e.adapter !== 'ng.render.mesh_batch' ? [e] : [
            { ...structuredClone(e), coverage: { ...e.coverage, values: { ...e.coverage.values, material: ['lambert'] } } },
            { ...structuredClone(e), coverage: { ...e.coverage, max: { ...e.coverage.max, instances: 10 } } },
        ]),
    });
    await refused(split, `EA_ELIGIBILITY ng.render.mesh_batch@1 (node galaxy): material emissive has no coverage for ${where}; static only`, 'two half-entries');

    // The environment: the exact model, its backend, its operating system and browser, or nothing (the EA5.3 review, H2).
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
    const gtx = { vendor: 'NVIDIA', architecture: 'turing', device: '0x1F91', description: 'NVIDIA GeForce GTX 1650', backend: 'D3D12', isFallbackAdapter: false };
    assert.deepEqual(environmentOf(gtx, ua), { key: 'ea5-env.v2|nvidia|turing|0x1f91|NVIDIA GeForce GTX 1650|d3d12|windows|chrome/156' });
    const rtx = { ...gtx, device: '0x1f08', description: 'NVIDIA GeForce RTX 2060' };
    assert.notDeepEqual(environmentOf(rtx, ua), environmentOf(gtx, ua), 'two models of one architecture: two environments');
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
    assert.notDeepEqual(environmentOf(gtx, linux), environmentOf(gtx, ua), 'another operating system');
    assert.notDeepEqual(environmentOf({ ...gtx, backend: 'vulkan' }, ua), environmentOf(gtx, ua), 'another backend');
    assert.deepEqual(environmentOf({ ...gtx, device: '' }, ua), { key: 'ea5-env.v2|nvidia|turing|-|NVIDIA GeForce GTX 1650|d3d12|windows|chrome/156' }, 'the description alone names the model');
    assert.deepEqual(environmentOf({ ...gtx, device: '', description: '' }, ua), { unknown: hidden }, 'a browser that hides the model: no environment');
    assert.deepEqual(environmentOf({ ...gtx, isFallbackAdapter: true }, ua), { unknown: 'a software (fallback) adapter qualifies nowhere' });
    assert.deepEqual(environmentOf({ ...gtx, architecture: '' }, ua), { unknown: 'the adapter does not say its vendor and architecture' });
    assert.deepEqual(environmentOf(gtx, 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), { unknown: 'the browser is not one this host knows' });
    assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'), 'edge/156');
    assert.equal(osOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'), 'android', 'Android says Linux too');
    // The identity is read from GPUAdapterInfo as the device reports it; a missing field is empty, never invented.
    assert.deepEqual(adapterIdentity({ vendor: 'amd', architecture: 'gcn-5', description: 'AMD Radeon(TM) Vega 8 Graphics', subgroupMinSize: 32 }),
        { vendor: 'amd', architecture: 'gcn-5', device: '', description: 'AMD Radeon(TM) Vega 8 Graphics', backend: '', isFallbackAdapter: false });
    assert.deepEqual(adapterIdentity(undefined), { vendor: '', architecture: '', device: '', description: '', backend: '', isFallbackAdapter: false });

    // A file in any other shape refuses whole, and with it every candidate.
    const entry = eligibilityFor([galaxy]).entries[0];
    const file = entries => JSON.stringify({ format: 'wexy-eligibility.v1', note: '', entries });
    assert.equal(parseEligibility(file([entry])).ok, true);
    for (const [bad, what] of [
        [{ ...entry, extra: 1 }, 'an unknown key'],
        [{ ...entry, coverage: { ...entry.coverage, max: {} } }, 'a missing range'],
        [{ ...entry, coverage: { ...entry.coverage, max: { ...entry.coverage.max, bytes: -1 } } }, 'a negative range'],
        [{ ...entry, adapter: 'ng.render.custom_batch' }, 'an adapter with no schema (custom_batch stays static-only)'],
        [{ ...entry, environment: ' ' }, 'no environment'],
        [{ ...entry, coverage: { ...entry.coverage, values: { ...entry.coverage.values, layout: [] } } }, 'an empty value list'],
    ]) {
        const parsed = parseEligibility(file([entry, bad]));
        assert.equal(parsed.ok, false, what);
        await refused(parsed, /^EA_ELIGIBILITY eligibility refused: entry 1[ ']/, `the gate under a refused file: ${what}`);
    }
    assert.equal(parseEligibility('{').ok, false);
    assert.deepEqual(Object.keys(COVERAGE_SCHEMA).sort(), ['ng.buffer.storage', 'ng.compute.stage', 'ng.geometry.primitive', 'ng.light.rig', 'ng.material.stock', 'ng.post.chain', 'ng.render.fullscreen', 'ng.render.mesh_batch'],
        'the eight adapters the live worlds use (Q88); custom_batch has none');

    // The EA-G1 bootstrap: the pinned candidate admits with no entry at all, under every other rule; nothing else does.
    const pinned = await setup('galaxy', { eligibility: SHIPPED, bootstrap: { harness: 'EA-G1', candidates: new Set([galaxy.id]) } });
    assert.equal(pinned.admit().ok, true, 'the pinned fixture');
    pinned.gate.claim(pinned.snap).release();
    const unpinned = await setup('foggy-dusk', { eligibility: SHIPPED, bootstrap: { harness: 'EA-G1', candidates: new Set([galaxy.id]) } });
    assert.match(unpinned.admit().reason, /^EA_ELIGIBILITY /, 'another candidate under the same harness');
    const stage = await setup('galaxy', { eligibility: SHIPPED });
    assert.match(stage.admit().reason, /^EA_ELIGIBILITY /, 'the stage\'s gate: no bootstrap, so the pinned fixture is static-only there');
    const limited = await setup('galaxy', { eligibility: SHIPPED, bootstrap: { harness: 'EA-G1', candidates: new Set([galaxy.id]) }, limits: { ...DEFAULT_LIMITS, maxBufferSize: 600_000 } });
    assert.match(limited.admit().reason, /^EA_ADMIT stars#buffer allocation bytes/, 'the bootstrap lifts eligibility alone');
    const base = { limits: DEFAULT_LIMITS, compiler: () => null, goes: createGoLedger(), present: present(), ledger: createMemoryLedger(), target: () => STAGE, environment: ENV, gpu: 'x' };
    assert.throws(() => createGate({ ...base, bootstrap: { harness: 'studio', candidates: new Set() } }), /EA-G1's harness's alone/);
    assert.throws(() => createGate({ ...base, bootstrap: { harness: 'EA-G1', candidates: new Set(['a', 'b', 'c', 'd']) } }), /at most 3 pinned/);
});

test('EA-D10 eligibility as EA-G1 writes it: one entry an adapter from the clean runs, in the schema the gate parses, covering what ran and nothing more', async () => {
    const runs = [await sealedLive('galaxy'), await sealedLive('foggy-dusk')];
    const pixels = 2022 * 1138;
    const context = (x, more = 0) => ({ environment: ENV, engineBundleHash: x.identity.bundleHash, profile: EXECUTOR_PROFILE, pixels: pixels + more });
    const entries = eligibilityFrom(runs.flatMap(s => demandsOf(s.x, pixels)), { environment: ENVIRONMENT, engineBundleHash: runs[0].x.identity.bundleHash, evidence: 'EA-G1, a test' });
    assert.equal(new Set(entries.map(e => `${e.adapter}@${e.adapterVersion}`)).size, entries.length, 'one entry an adapter');
    const parsed = parseEligibility(JSON.stringify({ format: 'wexy-eligibility.v1', note: '', entries }));
    assert.equal(parsed.ok, true, parsed.reason);
    for (const s of runs) assert.equal(eligibilityOf(s.x, parsed.entries, context(s.x)), null, 'each world that ran is covered where it ran');
    assert.match(eligibilityOf(runs[0].x, parsed.entries, context(runs[0].x, 1)), /^EA_ELIGIBILITY ng\.render\.fullscreen@1 \(node backdrop\): pixels \d+ over \d+ /,
        'nothing past what ran: one pixel more refuses');
    const film = await sealedLive('block-film');
    assert.match(eligibilityOf(film.x, parsed.entries, context(film.x)), /^EA_ELIGIBILITY ng\.geometry\.primitive@1 \(node cube\): factory /, 'a world that did not run is not covered by the ones that did');
    const stage = entries.find(e => e.adapter === 'ng.compute.stage');
    assert.equal(stage.coverage.max.invocations, 12032, 'the largest demand that ran, never widened');
    assert.deepEqual(stage.coverage.values.phase, ['fixedStep', 'frame', 'init'], 'every value that ran, sorted');
    assert.throws(() => eligibilityFrom([{ node: 'water', adapter: 'ng.render.custom_batch', adapterVersion: 1, max: {}, values: {} }], { environment: ENVIRONMENT, engineBundleHash: 'x', evidence: 'x' }),
        /custom_batch has no coverage schema here/, 'custom_batch is never written (Q88)');
});

test('EA5.4: the shipped eligibility, written by EA-G1, covers each live world on the two GPUs at every envelope the stage computes, and nothing past what ran', async () => {
    assert.ok(SHIPPED.entries.every(e => /^EA-G1 2026-11-01 on .+; dev\/out\/ea-g1\/[0-9T-]+\/(amd|nvidia)\.json$/.test(e.evidence)), 'each entry names its run and its result');
    const worlds = await Promise.all(['block-film', 'galaxy', 'foggy-dusk'].map(n => sealedLive(n)));
    const at = (x, key, pixels) => eligibilityOf(x, SHIPPED.entries, { environment: { key }, engineBundleHash: x.identity.bundleHash, profile: EXECUTOR_PROFILE, pixels });
    // The stage admits for its live cap at the canvas's shape, whatever the shape; EA-G1 rendered 2048×1152, over each.
    const envelopes = [4 / 3, 16 / 10, 16 / 9, 21 / 9, 3].map(aspect => envelopeOf({ width: Math.round(720 * aspect), height: 720 }, MAX_LIVE_PIXELS));
    for (const key of [AMD_IGPU, GTX_1650]) {
        for (const w of worlds) {
            for (const e of envelopes) assert.equal(at(w.x, key, e.width * e.height), null, `${key.split('|')[1]}: ${w.x.nodes.length} nodes at ${e.width}×${e.height}`);
        }
    }
    // Nothing past what ran: a pixel over what EA-G1 rendered, another model, or a world the runs did not hold.
    assert.match(at(worlds[1].x, AMD_IGPU, 2048 * 1152 + 1), /^EA_ELIGIBILITY ng\.render\.fullscreen@1 \(node backdrop\): pixels 2359297 over 2359296 /);
    assert.match(at(worlds[1].x, AMD_IGPU.replace('0x1638|AMD Radeon(TM) Graphics', '0x15d8|AMD Radeon(TM) Vega 8 Graphics'), 2048 * 1152), /has no coverage for/);
    assert.match(at(worlds[1].x, GTX_1650.replace('chrome/156', 'chrome/157'), 2048 * 1152), /has no coverage for/, 'another browser version');
});

test('EA-D11 the reservation: B admits and B+1 refuses, the Head counts, an alias counts once, two builds count twice, each returned once', async () => {
    const galaxy = await sealedLive('galaxy');
    const need = reservationFor(galaxy.x, STAGE);
    // The boundary.
    const exact = await setup('galaxy', { ledger: createMemoryLedger(need.total) });
    assert.equal(exact.admit().ok, true, 'B');
    const under = await setup('galaxy', { ledger: createMemoryLedger(need.total - 1) });
    assert.equal(under.admit().reason, `EA_ADMIT memory: ${need.total} bytes over the ${need.total - 1} budget (held 0, this ${need.total}) on Fake GPU`, 'B+1');
    // The Head's bytes are part of the overlap.
    const ledger = createMemoryLedger(DEVICE_BUDGET);
    const head = ledger.record('head', DEVICE_BUDGET - need.total + 1);
    const withHead = await setup('galaxy', { ledger });
    assert.match(withHead.admit().reason, /^EA_ADMIT memory: /, 'Head + candidate + probe + readback over the budget');
    head.shrink(DEVICE_BUDGET - need.total);
    assert.equal(withHead.admit().ok, true, 'and exactly at it');
    // A borrowed alias, Q76(b)'s adopted buffer, is one resource of X, counted once: at P's viewport the candidate's
    // share is X's own estimate.
    assert.equal(galaxy.x.resources.filter(r => r.id === 'stars#buffer').length, 1);
    assert.equal(galaxy.x.resources.find(r => r.id === 'stars#buffer').createdBy, 'galaxy#create', 'the batch\'s own storage');
    assert.equal(reservationFor(galaxy.x, POLICY_V1.viewport).candidate, galaxy.x.estimate.bytes);
    assert.ok(need.probe > 0 && need.readback >= STAGE.width * STAGE.height * 8, 'the probe and the readback are reserved before they exist');
    // Two builds at once count twice; a third over the budget refuses.
    const two = createMemoryLedger(2 * need.total);
    const s = await setup('galaxy', { ledger: two });
    assert.equal(s.admit().ok, true);
    assert.equal(s.admit().ok, true, 'a second admission while the first still holds');
    assert.equal(two.held(), 2 * need.total);
    assert.match(s.admit().reason, /^EA_ADMIT memory: /, 'a third');
    // Each handed over once, each returned once; shrinking keeps the candidate's share.
    const a = s.gate.claim(s.snap);
    const b = s.gate.claim(s.snap);
    assert.ok(a && b && a !== b);
    assert.equal(s.gate.claim(s.snap), null);
    a.release();
    a.release();
    assert.equal(two.held(), need.total, 'a second release returns nothing more');
    b.shrink(need.candidate);
    assert.equal(two.held(), need.candidate);
    b.shrink(need.total);
    assert.equal(two.held(), need.candidate, 'shrinking never grows it');
    b.release();
    assert.equal(two.held(), 0);
    assert.deepEqual(two.holders(), []);
});

test('EA-D16 Q90\'s two caps: a 4K film of foggy-dusk beside its Head and a swap from an h1 Head admit; 1 GiB plus one byte refuses', async () => {
    const foggy = await sealedLive('foggy-dusk');
    const stageEnvelope = { width: 2022, height: 1138 };
    const film = { width: 3840, height: 2160 };
    // The film's construction at its real size, beside the stage's Head (foggy-dusk itself, at the stage's envelope).
    const ledger = createMemoryLedger();
    ledger.record('head foggy-dusk', reservationFor(foggy.x, stageEnvelope).candidate);
    const filmNeed = reservationFor(foggy.x, film);
    assert.ok(filmNeed.candidate > POLICY_V1.maxTotalBytes, `at 4K its own bytes (${filmNeed.candidate}) pass P v1's 256 MiB, which is not applied again here`);
    const s = await setup('foggy-dusk', { target: film, ledger, eligibility: eligibilityFor([foggy], { pixels: film.width * film.height }) });
    const r = s.admit();
    assert.equal(r.ok, true, r.reason);
    assert.ok(ledger.held() < DEVICE_BUDGET && ledger.held() > 512 * 1024 * 1024, `about 650 MB together, within 1 GiB: ${ledger.held()}`);
    // A stage swap from an h1 Head of about 180 MB.
    const swap = createMemoryLedger();
    swap.record('head h1', 180_000_000);
    const g = await setup('galaxy', { ledger: swap, target: stageEnvelope, eligibility: eligibilityFor([await sealedLive('galaxy')], { pixels: stageEnvelope.width * stageEnvelope.height }) });
    assert.equal(g.admit().ok, true);
    // 1 GiB plus one byte.
    const galaxyNeed = reservationFor(g.snap.x, STAGE);
    const full = createMemoryLedger();
    full.record('head', DEVICE_BUDGET - galaxyNeed.total + 1);
    const over = await setup('galaxy', { ledger: full });
    assert.equal(over.admit().reason, `EA_ADMIT memory: ${DEVICE_BUDGET + 1} bytes over the ${DEVICE_BUDGET} budget (held ${DEVICE_BUDGET - galaxyNeed.total + 1}, this ${galaxyNeed.total}) on Fake GPU`);
    // And the device's own limits are read as it reports them.
    assert.equal(limitsOf({ limits: DEFAULT_LIMITS }).maxBufferSize, DEFAULT_LIMITS.maxBufferSize);
});
