// EA-D4 and EA-D8, headless (EA5.1; executor-design.md §6 and §10, where these were EA-X4 and EA-X8 before EA3's resolver
// tests were found to hold those names): L3 on the device, over a fake GPUDevice that keeps WebGPU's error-scope stack
// (an error goes to the innermost validation scope, or escapes uncaptured), answers each module's compilation info from
// a script, and loses itself when a test says. No GPU.
//   EA-D4  the device compiler: a clean module, an error and a warning on the body's lines, an error on the host's, a
//          validation error the compilation info does not show, a module that throws when made, a compilation info or a
//          scope that fails, a device lost before or during a compile, a generation that moves, more messages than the
//          cap: each placed by compileBody; never a pass when either check failed; nothing thrown, nothing uncaptured;
//          the scope pushed and popped around the module alone, before any await
//   EA-D8  provenance: the device's own verdicts on exactly a sealed candidate's bodies admit; a JSON copy, a fake
//          labelled device, another device's verdicts, a verdict on another body, one that disagrees with the device, one
//          from an old generation and one from a lost device each refuse in exact words, so no executor is called
// EA5.1's L3 in the candidate session is EA-D4b, in candidate.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleModule, checkBody, compileBody } from '../src/contract/adapters/bodies.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { MAX_COMPILE_MESSAGES, createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { createAuthority, instantiate } from '../src/loop/executor.ts';
import { sealCandidate } from '../src/loop/snapshot.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** EA-E's world: a compute stage, a custom batch and a fullscreen, so three modules of three kinds. */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 1 }, [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'field', 'buffer')]),
        node('look', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ];
}

const BODIES = {
    motion: [
        'fn advance(index: u32) {',
        '    let base = index * B_instances_STRIDE;',
        '    let f = b_field_current[(index % 1024u) * B_field_STRIDE];',
        '    b_instances[base + 1u] = f32(index) * 0.1;',
        '    b_instances[base + 2u] = sin(camera.simTime + f);',
        '}',
    ].join('\n'),
    water: [
        'fn wave(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, instance: u32) -> VertexOut {',
        '    var out: VertexOut;',
        '    out.clipPos = camera.viewProj * vec4<f32>(position, 1.0);',
        '    out.worldPos = position;',
        '    out.worldNormal = normal;',
        '    out.uv = uv;',
        '    out.ecsColor = vec3f(0.2, 0.4, 0.8) + vec3f(f32(instance) * 0.0);',
        '    return out;',
        '}',
        '',
        'fn shade(input: VertexOut) -> vec4<f32> {',
        '    return vec4<f32>(input.ecsColor, 1.0);',
        '}',
    ].join('\n'),
    sky: [
        'fn dusk(uv: vec2<f32>) -> vec4<f32> {',
        '    let f = b_field_current[0] * 0.0;',
        '    return vec4<f32>(uv.x, uv.y, 0.4 + f, 1.0);',
        '}',
    ].join('\n'),
};
/** Another motion body that passes its lint: a different codeHash under the same interface. */
const OTHER_MOTION = BODIES.motion.replace('* 0.1;', '* 0.2;');

/** A candidate the host sealed, over the world above. */
async function sealed(bodies = BODIES) {
    const r = await resolveProgram(world(), POLICY_V1);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph);
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    const s = await sealCandidate({
        attempt: 'attempt-1', revision: 1, program: world(), graph: r.graph.hash,
        bodies: d.interfaces.map(i => ({ module: i.module, interfaceHash: i.interfaceHash, body: bodies[i.module] })),
    });
    assert.equal(s.ok, true, s.reason);
    return s.snapshot;
}

/** A compilation message as WebGPU gives one. */
const msg = (type, lineNum, message) => ({ type, lineNum, linePos: 1, offset: 0, length: 1, message });

/**
 * A fake GPUDevice for L3: WebGPU's error-scope stack, a module's compilation info and validation error scripted by its
 * source, the call order logged with the stack's depth, and a loss the test triggers.
 */
function fakeDevice(script = {}) {
    const { info = () => [], invalid = () => null, createThrows = null, infoRejects = null, infoThrowsNow = null, popRejects = null, pushThrows = null,
        during = async () => {} } = script;
    const stack = [];
    const uncaptured = [];
    const log = [];
    let lose;
    const lost = new Promise(resolve => { lose = resolve; });
    const device = {
        lost,
        pushErrorScope(filter) {
            log.push(`push ${filter}`);
            if (pushThrows) throw new Error(pushThrows);
            stack.push({ filter, errors: [] });
        },
        popErrorScope() {
            log.push('pop');
            const scope = stack.pop();
            if (!scope) return Promise.reject(new Error('OperationError: no error scope to pop'));
            if (popRejects) return Promise.reject(new Error(popRejects));
            return Promise.resolve(scope.errors[0] ?? null);
        },
        createShaderModule({ code, label }) {
            log.push(`create ${label} at depth ${stack.length}`);
            if (createThrows) throw new TypeError(createThrows);
            const error = invalid(code);
            if (error) {
                const scope = stack.findLast(s => s.filter === 'validation');
                if (scope) scope.errors.push({ message: error });
                else uncaptured.push(error);
            }
            // An implementation may throw from the call itself, before any promise exists (the EA5.1 review).
            if (infoThrowsNow) return { getCompilationInfo() { log.push(`info at depth ${stack.length}`); throw new TypeError(infoThrowsNow); } };
            return {
                async getCompilationInfo() {
                    log.push(`info at depth ${stack.length}`);
                    await during(code);
                    if (infoRejects) throw new Error(infoRejects);
                    return { messages: info(code) };
                },
            };
        },
    };
    return { device, stack, uncaptured, log, lose: (message = 'the GPU process went away') => lose({ reason: 'unknown', message }) };
}

/** A verdict's fields, without whose it is: what a compile's `verdict()` takes. */
const fieldsOf = ({ producedBy, ...fields }) => fields;

/** Each sealed body compiled through compileBody with `compiler`, in the snapshot's order. */
async function compileAll(snap, compiler, bodies = {}) {
    const out = [];
    for (const b of snap.bodies) {
        const iface = snap.interfaces.find(i => i.module === b.module);
        out.push(await compileBody(iface, await checkBody(iface, bodies[b.module] ?? b.body), compiler));
    }
    return out;
}

test('EA-D4 L3 on the device: every message placed, never a pass when the module or its scope failed, nothing thrown or uncaptured', async () => {
    const snap = await sealed();
    const iface = snap.interfaces.find(i => i.module === 'motion');
    const checked = await checkBody(iface, BODIES.motion);
    const first = assembleModule(iface, checked.body).bodyFirstLine;
    const label = `motion#${checked.codeHash.slice(0, 12)}`;
    const run = async (script, options = {}) => {
        const d = fakeDevice(typeof script === 'function' ? script(() => d) : script);
        const compiler = createDeviceCompiler(d.device, { gpu: 'Fake GPU', ...options });
        const verdict = await compileBody(iface, checked, compiler);
        return { d, compiler, verdict };
    };

    // A clean module: the device's pass. The scope is pushed, the module made inside it, the scope popped, and only then
    // is anything awaited: no other work's error can land in it, and none of the module's escapes it.
    const clean = await run({});
    assert.deepEqual([clean.verdict.ok, clean.verdict.producedBy, clean.verdict.body, clean.verdict.host, clean.verdict.unplaced], [true, 'device', [], [], []]);
    assert.deepEqual(clean.d.log, ['push validation', `create ${label} at depth 1`, 'pop', 'info at depth 0']);
    assert.deepEqual([clean.compiler.gpu, clean.compiler.lost, clean.d.stack.length], ['Fake GPU', false, 0]);

    // An error on the body's second line, which the scope caught as well: one finding, on the body, for its repair.
    const error = await run({ info: () => [msg('error', first + 1, 'unresolved value shimmer')], invalid: () => 'Error while parsing WGSL' });
    assert.equal(error.verdict.ok, false);
    assert.deepEqual(error.verdict.body.map(f => [f.rung, f.line, f.code, f.severity, f.message]), [['L3', 2, 'compile', 'error', 'unresolved value shimmer']]);
    assert.deepEqual([error.verdict.host, error.verdict.unplaced, error.d.uncaptured], [[], [], []]);

    // A warning is kept, and passes; an info is not a finding.
    const warn = await run({ info: () => [msg('warning', first, 'unused variable n'), msg('info', first, 'a note')] });
    assert.deepEqual([warn.verdict.ok, warn.verdict.body.map(f => [f.line, f.severity, f.message])], [true, [[1, 'warning', 'unused variable n']]]);

    // An error on the host's preamble is the host's: never a body's.
    const host = await run({ info: () => [msg('error', 1, 'a slip in the generated preamble')], invalid: () => 'Error while parsing WGSL' });
    assert.deepEqual([host.verdict.ok, host.verdict.body.length, host.verdict.host.map(f => f.code)], [false, 0, ['host-source']]);

    // The device refuses the module but its compilation info shows no error: never a pass, and with no line it accuses
    // no module. The scope caught the error, so nothing escaped.
    const hidden = await run({ invalid: () => 'a shader module limit was exceeded' });
    assert.equal(hidden.verdict.ok, false);
    assert.deepEqual(hidden.verdict.unplaced.map(f => [f.severity, f.message]),
        [['error', 'L3 could not judge this module on this device: the device refused it: a shader module limit was exceeded']]);
    assert.deepEqual([hidden.verdict.body, hidden.d.uncaptured], [[], []]);
    const bare = fakeDevice({ invalid: () => 'an error made with no scope open' });
    bare.device.createShaderModule({ code: 'x', label: 'outside' });
    assert.deepEqual(bare.uncaptured, ['an error made with no scope open'], 'the fake does let an error escape when no scope is open');

    // Making the module throws: the scope is still popped, and the verdict is the device's trouble, not the body's.
    const thrown = await run({ createThrows: 'a bad descriptor' });
    assert.deepEqual([thrown.verdict.ok, thrown.verdict.body, thrown.d.stack.length, thrown.d.log.at(-1)], [false, [], 0, 'pop']);
    assert.match(thrown.verdict.unplaced[0].message, /making the module threw: a bad descriptor$/);

    // Its compilation info fails, or its scope does: never a pass, whatever the other said.
    const noInfo = await run({ infoRejects: 'the info went missing' });
    assert.deepEqual([noInfo.verdict.ok, noInfo.verdict.unplaced.map(f => f.message)], [false, ['L3 could not judge this module on this device: its compilation info failed: the info went missing']]);
    const noScope = await run({ popRejects: 'the scope went missing' });
    assert.deepEqual([noScope.verdict.ok, noScope.verdict.unplaced.map(f => f.message)], [false, ['L3 could not judge this module on this device: its validation scope failed: the scope went missing']]);
    // The EA5.1 review: a scope that cannot be opened (the module is then not made at all, so nothing escapes), and an
    // info call that throws before any promise exists (after the scope was popped). Both are findings, never a rejection.
    const unopened = await run({ pushThrows: 'no scopes left' });
    assert.deepEqual([unopened.verdict.ok, unopened.verdict.unplaced.map(f => f.message), unopened.d.log, unopened.d.stack.length],
        [false, ['L3 could not judge this module on this device: its validation scope could not be opened: no scopes left'], ['push validation'], 0]);
    const infoNow = await run({ infoThrowsNow: 'info is not a function here' });
    assert.deepEqual([infoNow.verdict.ok, infoNow.verdict.unplaced.map(f => f.message), infoNow.d.log.slice(1), infoNow.d.stack.length],
        [false, ['L3 could not judge this module on this device: its compilation info failed: info is not a function here'], [`create ${label} at depth 1`, 'pop', 'info at depth 0'], 0]);
    // And a host whose own generation callback throws: still a finding, still no rejection.
    const hostless = createDeviceCompiler(fakeDevice().device, { generation: () => { throw new Error('no generation'); } });
    assert.deepEqual((await hostless.compile('x', 'x')).map(m => m.message), ['L3 could not judge this module on this device: the compiler failed: no generation']);

    // The device lost before the compile: nothing is made. Lost while it compiles: what it said is void.
    const gone = fakeDevice();
    const goneCompiler = createDeviceCompiler(gone.device);
    gone.lose('the driver reset');
    await tick();
    const before = await compileBody(iface, checked, goneCompiler);
    assert.deepEqual([before.ok, goneCompiler.lost, gone.log], [false, true, []]);
    assert.deepEqual(before.unplaced.map(f => f.message), ['L3 could not judge this module on this device: the device was lost (the driver reset)']);
    const during = await run(d => ({ info: () => [msg('warning', first, 'fine otherwise')], during: async () => { d().lose('mid-compile'); await tick(); } }));
    assert.deepEqual([during.verdict.ok, during.verdict.body], [false, []]);
    assert.deepEqual(during.verdict.unplaced.map(f => f.message), ['L3 could not judge this module on this device: the device was lost while it compiled (mid-compile)']);

    // The host's device generation moves while it compiles (a device replaced): void too.
    let generation = 4;
    const moved = await run({ during: async () => { generation = 5; } }, { generation: () => generation });
    assert.deepEqual([moved.verdict.ok, moved.verdict.unplaced.map(f => f.message)],
        [false, ['L3 could not judge this module on this device: the device generation moved from 4 to 5 while it compiled']]);

    // More messages than the cap: errors first, the cut said.
    const flood = await run({ info: () => [...Array.from({ length: 20 }, (_, i) => msg('warning', first, `w${i}`)), ...Array.from({ length: 40 }, (_, i) => msg('error', first, `e${i}`))] });
    assert.equal(flood.verdict.body.length + flood.verdict.unplaced.length, MAX_COMPILE_MESSAGES);
    assert.deepEqual(flood.verdict.body.map(f => f.message), Array.from({ length: MAX_COMPILE_MESSAGES - 1 }, (_, i) => `e${i}`));
    assert.deepEqual(flood.verdict.unplaced.map(f => [f.severity, f.message]), [['warning', '29 more of the device\'s messages were not kept']]);
});

test('EA-D8 only this device\'s own verdicts, on exactly the sealed bodies, in its current generation, admit; anything else refuses in exact words', async () => {
    const snap = await sealed();
    assert.deepEqual(snap.bodies.map(b => b.module), ['motion', 'sky', 'water']);
    const a = fakeDevice();
    let generation = 0;
    const compiler = createDeviceCompiler(a.device, { generation: () => generation, gpu: 'Fake GPU A' });
    const verdicts = await compileAll(snap, compiler);
    assert.equal(compiler.provenance(snap, verdicts), null);

    // The gate EA5.3 builds on: the compiler's provenance. A refused admission calls no executor.
    const authority = createAuthority((s, e) => compiler.provenance(s, e.compiled));
    const present = { turn: () => 1, device: () => generation };
    let constructions = 0;
    const executor = { instantiate() { constructions++; throw new Error('not in this test'); } };
    const admit = async (compiled) => {
        const r = authority.admit(snap, { compiled, gpuGo: true }, present);
        if (r.ok) await instantiate(snap, r.admission, executor, present, new AbortController().signal);
        return r;
    };
    assert.equal((await admit(verdicts)).ok, true);
    assert.equal(constructions, 1, 'the device\'s own verdicts open the door');

    // A fake that calls itself a device.
    const pretender = { producedBy: 'device', compile: async () => [] };
    const b = fakeDevice();
    const other = createDeviceCompiler(b.device, { gpu: 'Fake GPU B' });
    const NOT_MINE = /^the compile verdict for motion is not one this device's compiler made: a copy, a fake's or another device's proves nothing$/;
    for (const [label, compiled, says] of [
        ['a JSON copy', JSON.parse(JSON.stringify(verdicts)), NOT_MINE],
        ['a structured clone', structuredClone(verdicts), NOT_MINE],
        ['a fake labelled device', await compileAll(snap, pretender), NOT_MINE],
        ['another device\'s', await compileAll(snap, other), NOT_MINE],
        ['a verdict on another body', [...(await compileAll(snap, compiler, { motion: OTHER_MOTION })).slice(0, 1), verdicts[1], verdicts[2]],
            /^the compile verdict for motion is for another body than this candidate's$/],
    ]) {
        const r = await admit(compiled);
        assert.deepEqual([r.ok, constructions], [false, 1], label);
        assert.match(r.reason, says, label);
    }
    // The provenance check itself, below the seam's own. There is no call that registers a verdict made elsewhere (the EA5.1
    // review's two reproductions): a copy handed along with a fresh compile of the very same source stays unregistered,
    // since that compile makes its own object, once; and a verdict claiming another module than the source its compile
    // judged is refused for the module it claims.
    const NOT_MINE_TEXT = 'the compile verdict for motion is not one this device\'s compiler made: a copy, a fake\'s or another device\'s proves nothing';
    assert.equal(compiler.attest, undefined, 'no public registration of a verdict');
    const motionSource = assembleModule(snap.interfaces.find(i => i.module === 'motion'), snap.bodies[0].body).source;
    const skySource = assembleModule(snap.interfaces.find(i => i.module === 'sky'), snap.bodies[1].body).source;
    const copy = Object.freeze(structuredClone(verdicts[0]));
    const again = await compiler.compileBound(motionSource, 'motion#again');
    const minted = again.verdict(fieldsOf(verdicts[0]));
    assert.notEqual(minted, copy);
    assert.equal(compiler.provenance(snap, [copy, verdicts[1], verdicts[2]]), NOT_MINE_TEXT, 'the copy stays unregistered');
    assert.equal(compiler.provenance(snap, [minted, verdicts[1], verdicts[2]]), null, 'what a real compile makes is the device\'s own');
    assert.throws(() => again.verdict(fieldsOf(verdicts[0])), /made its verdict already/, 'one verdict a compile');
    const claiming = (await compiler.compileBound(skySource, 'sky#claims-motion')).verdict(fieldsOf(verdicts[0]));
    assert.equal(compiler.provenance(snap, [claiming, verdicts[1], verdicts[2]]), 'the compile verdict for motion judged another module than this candidate\'s');
    const otherBody = await compileAll(snap, compiler, { motion: OTHER_MOTION });
    assert.equal(compiler.provenance(snap, [otherBody[0], verdicts[1], verdicts[2]]), 'the compile verdict for motion judged another module than this candidate\'s');
    assert.equal(compiler.provenance(snap, [Object.freeze({ ...otherBody[0], codeHash: snap.bodies[0].codeHash }), verdicts[1], verdicts[2]]),
        'the compile verdict for motion is not one this device\'s compiler made: a copy, a fake\'s or another device\'s proves nothing');
    assert.equal(compiler.provenance(snap, verdicts.slice(1)), 'module motion has no compile verdict from this device');
    assert.equal(compiler.provenance(snap, [verdicts[0], ...verdicts]), 'module motion has 2 compile verdicts');
    const ghost = Object.freeze({ ...verdicts[0], module: 'ghost' });
    assert.equal(compiler.provenance(snap, [...verdicts, ghost]), 'module ghost is not one of this candidate\'s');
    // A body the device refuses: its verdict is the device's own, and still never admits. Fields that say otherwise about
    // that very compile make a verdict that is never registered.
    const failing = createDeviceCompiler(fakeDevice({ info: c => (c.includes('* 0.1;') ? [msg('error', 1, 'host slip')] : []) }).device);
    const refused = await compileAll(snap, failing);
    assert.deepEqual(refused.map(v => v.ok), [false, true, true]);
    assert.equal(failing.provenance(snap, refused), 'motion does not compile on this device');
    const forged = (await failing.compileBound(motionSource, 'motion#forged')).verdict({ ...fieldsOf(refused[0]), ok: true, host: [] });
    assert.equal(failing.provenance(snap, [forged, refused[1], refused[2]]), NOT_MINE_TEXT);

    // The device's generation moves (a loss, a replacement): every verdict from before proves nothing, and stays so
    // whatever is compiled since (the review's second reproduction); a compile from before makes an unregistered verdict.
    const pending = await compiler.compileBound(motionSource, 'motion#pending');
    generation = 1;
    const stale = await admit(verdicts);
    assert.deepEqual([stale.ok, constructions], [false, 1]);
    assert.equal(stale.reason, 'the compile verdict for motion is from device generation 0, and the device is at 1: compile it again');
    const fresh = await compileAll(snap, compiler);
    assert.equal((await admit(fresh)).ok, true, 'compiled again in generation 1, it admits');
    assert.equal(constructions, 2);
    assert.equal(compiler.provenance(snap, verdicts), 'the compile verdict for motion is from device generation 0, and the device is at 1: compile it again',
        'the old objects stay in their generation, however often their source is compiled since');
    assert.equal(compiler.provenance(snap, [pending.verdict(fieldsOf(verdicts[0])), fresh[1], fresh[2]]), NOT_MINE_TEXT, 'a compile from before the move');

    // A lost device voids every verdict it made, and compiles nothing more.
    a.lose('the GPU was reset');
    await tick();
    const lost = await admit(fresh);
    assert.deepEqual([lost.ok, lost.reason, constructions, compiler.lost], [false, 'the device was lost (the GPU was reset): its compile verdicts prove nothing now', 2, true]);
    const after = await compileAll(snap, compiler);
    assert.ok(after.every(v => !v.ok && v.unplaced[0].message.endsWith('the device was lost (the GPU was reset)')));
});
