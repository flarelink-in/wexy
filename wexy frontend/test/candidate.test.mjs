// EA-K series, headless (EA4.3; candidate-loop-design.md §2, §5, §8, §9, §10; Q82 to Q84 decided; EA4.4's reviser over the wire is revision.test.mjs): the
// candidate machine (src/loop/candidate.ts) over fakes: a module client that answers from a script and can hold a call
// open, a checker and a compiler that can be held or scripted, a reviser standing where EA4.4's program revision will.
// P1 reuse and re-authoring, P2 stale corrections, P3 each routing row, P4 a visual pass on a failing candidate, P5 each
// budget at B and B+1, a cancel and a newer candidate in each phase, two bodies under one X, the ledger under
// concurrency and revisions, the checker's version, the evidence bounds, and the ends that must not replace anything.
// EA-K7 and EA-K11, the admission seam, are in executor.test.mjs. No model, no backend, no GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkBody } from '../src/contract/adapters/bodies.ts';
import { deriveInterfaces, invalidated } from '../src/contract/adapters/interfaces.ts';
import { programHash, resolveProgram } from '../src/contract/adapters/resolve.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { MODULE_VERSIONS } from '../src/forge-client/module-client.ts';
import { candidateBundle, createCandidateSession } from '../src/loop/candidate.ts';
import { route, verifyEnvelope } from '../src/loop/candidate-evidence.ts';
import { Ledger, Q_C, budgetDiagnostic } from '../src/loop/candidate-ledger.ts';
import { COPY } from '../src/loop/copy.ts';
import { candidateId, isSealed } from '../src/loop/snapshot.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const MOVE = { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'fixedStep' };

/** The EA-I world: one module of each kind (motion, sky, water). */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', MOVE, [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
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
/** A compute stage of its own, writing a buffer of its own: one module more. */
const stage = (name, buffer) => [
    node(buffer, 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' }),
    node(`${name}Stage`, 'ng.compute.stage', { module: name, entry: `${name}Run`, workgroupSize: 64, invocations: 64, phase: 'frame' }, [from('writes', buffer, 'buffer')]),
];
const four = () => [...world(), ...stage('stir', 'dust')];
const five = () => [...four(), ...stage('glow', 'ember')];
/** No authored module at all: stock materials only. */
const zero = () => world().filter(n => !['move', 'water', 'sky', 'field'].includes(n.id));
/** One module, motion, writing the instances: its candidate checks one body. */
const one = () => world().filter(n => !['water', 'sky', 'field'].includes(n.id)).map(n => (n.id === 'move' ? { ...n, inputs: [from('writes', 'instances', 'buffer')] } : n));
/** The world with one change to motion's stage: only motion's interface changes (EA-U6). */
const motionAt = (workgroupSize, nodes = world()) => nodes.map(n => (n.id === 'move' ? { ...n, config: JSON.stringify({ ...MOVE, workgroupSize }) } : n));

const BODIES = {
    motion: 'fn advance(index: u32) {\n    let base = index * B_instances_STRIDE;\n    b_instances[base + 1u] = f32(index) * 0.1;\n}',
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
    sky: 'fn dusk(uv: vec2<f32>) -> vec4<f32> {\n    let f = b_field_current[0] * 0.0;\n    return vec4<f32>(uv.x, uv.y, 0.4 + f, 1.0);\n}',
    stir: 'fn stirRun(index: u32) {\n    b_dust[index * B_dust_STRIDE] = f32(index) * 0.5;\n}',
    glow: 'fn glowRun(index: u32) {\n    b_ember[index * B_ember_STRIDE] = f32(index);\n}',
};
BODIES.sky2 = BODIES.sky;
/** Bodies the lint refuses: each calls a function nothing declares, on its line 2. */
const FAULT = {
    motion: 'fn advance(index: u32) {\n    let n = noise2(f32(index));\n}',
    water: BODIES.water.replace('return vec4<f32>(input.ecsColor, 1.0);', 'return noise3(input.ecsColor);'),
    sky: 'fn dusk(uv: vec2<f32>) -> vec4<f32> {\n    return noise2(uv);\n}',
};

const R = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };
const DESIGN = {
    intent: 'a field of blocks under a dusk sky', interpretation: null, assumptions: [], visualElements: [{ name: 'blocks', description: 'stone cubes' }],
    motion: 'the blocks drift', animated: true, techniques: [], resourceFlow: [], cameraAndTiming: 'a slow orbit', controls: [], successCriteria: [], unresolved: [],
};
const handOff = (nodes = world(), over = {}) => ({ turnId: 'turn-1', request: R, design: DESIGN, program: { nodes }, turnCalls: 3, ...over });

/**
 * A module client from a script: each module's answers in order, the last repeating (a body, `{ error }`, `{ throws }`,
 * or `{ hold }`: open until the test resolves it). It echoes the job as the backend does, reports a usage, and honours
 * the signal: an aborted call rejects with the abort.
 */
function fakeModules(script = {}) {
    const calls = [];
    const held = [];
    return {
        calls,
        held,
        async call(body, onEvent, signal) {
            signal.throwIfAborted();
            calls.push(structuredClone(body));
            const mine = calls.filter(c => c.module.id === body.module.id).length;
            const list = script[body.module.id];
            let answer = list === undefined ? BODIES[body.module.id] : list[Math.min(mine, list.length) - 1];
            const meta = {
                turnId: body.turnId, jobId: body.jobId, purpose: body.purpose, subject: body.subject, versions: body.versions, module: body.module.id,
                interfaceHash: body.module.interface.interfaceHash, generationId: `gen-${calls.length}`, model: 'm-1', source: 'live', role: 'module',
                promptVersion: `module.${body.purpose}.v1`,
            };
            onEvent({ type: 'meta', meta });
            if (answer && typeof answer === 'object' && answer.hold) {
                answer = await new Promise((resolve, reject) => {
                    held.push({ name: answer.hold, module: body.module.id, purpose: body.purpose, body: calls.at(-1), resolve });
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            signal.throwIfAborted();
            if (answer && typeof answer === 'object' && answer.throws) throw answer.throws;
            const usage = { in: 100, out: 50, reasoning: null, cached: null, costMicroUsd: 1_000 };
            onEvent({ type: 'usage', usage });
            if (answer && typeof answer === 'object' && answer.error) {
                return { status: 'error', meta, code: answer.error, message: answer.message ?? 'The model wrote nothing for this part.', usage };
            }
            return { status: 'ok', meta, answer, answerSha256: sha(answer), usage };
        },
    };
}

/** A reviser from a script of results (or `{ hold }`, `{ throws }`), recording each request. */
function fakeReviser(results) {
    const calls = [];
    const held = [];
    return {
        calls,
        held,
        async revise(req, signal) {
            calls.push(structuredClone(req));
            let r = results[Math.min(calls.length, results.length) - 1];
            if (r && r.hold) r = await new Promise((resolve, reject) => { held.push({ resolve }); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
            if (r && r.throws) throw r.throws;
            return r;
        },
    };
}

function session(deps = {}) {
    const states = [];
    const modules = deps.modules ?? fakeModules();
    let n = 0;
    const s = createCandidateSession({ attemptId: () => `attempt-${++n}`, now: () => 1_000 + states.length, ...deps, modules }, st => states.push(st));
    return { s, states, modules };
}

const waitFor = async (condition, label) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(condition(), `waited for ${label}`);
};
const settle = () => new Promise(r => setTimeout(r, 20));
/** The envelope base of a state: what a correction of it is based on. */
const baseOf = (st) => ({ attempt: st.attempt, revision: st.revision, candidate: st.id, programHash: st.programHash, graph: st.graph });

/** Interfaces of a program, as this build derives them. */
async function interfacesOf(nodes) {
    const r = await resolveProgram(nodes);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph);
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    return d.interfaces;
}
const I = Object.fromEntries((await interfacesOf(world())).map(i => [i.module, i]));
/** A fake compiler that answers an error on `module`'s body line, the host's first line or no line, `times` times. */
function compilerFailing(module, place, times = 1) {
    let n = 0;
    const calls = [];
    return {
        producedBy: 'fake',
        calls,
        async compile(source, label) {
            calls.push(label);
            if (!label.startsWith(`${module}#`) || n >= times) return [];
            n++;
            const line = place === 'host' ? 1 : place === 'none' ? 0 : I[module].preamble.split('\n').length + 2;
            return [{ line, message: 'unresolved value: shimmer', type: 'error' }];
        },
    };
}

test('EA-K3 P3, P7: each row of §8\'s routing goes to its scope; a clean candidate is authored once a module, R and S verbatim in every call', async () => {
    // The table, on a record of each kind.
    const rec = (phase, findings, verdict = 'fail') => ({
        id: 'ev-1', subject: {}, phase, verdict, omittedFindings: 0, producedBy: 'host', refs: [],
        findings: findings.map((f, i) => ({ id: `ev-1.f${i + 1}`, code: 'x', path: null, line: null, severity: 'error', message: 'm', rung: null, place: null, ...f })),
    });
    assert.equal(route(rec('lint', [{ rung: 'L1', line: 3 }])), 'modules', 'a body\'s lint error repairs that module');
    assert.equal(route(rec('compile', [{ rung: 'L3', line: 3, place: 'body' }])), 'modules', 'a compile error on the body');
    assert.equal(route(rec('compile', [{ place: 'host' }])), 'host', 'the host\'s generated source: never a body repair');
    assert.equal(route(rec('compile', [{ place: 'host' }, { place: 'body', line: 2 }])), 'host', 'the host\'s own error decides');
    assert.equal(route(rec('compile', [{ place: 'unplaced' }])), 'candidate', 'no line: no module is accused');
    assert.equal(route(rec('resolve', [{ code: 'EA_RESOLVE', path: '/nodes/1/config/elements' }])), 'program');
    assert.equal(route(rec('resolve', [{ code: 'EA_CAPABILITY_UNSUPPORTED', path: '/nodes/0/config/init' }])), 'program', 'a gated value is the program\'s to change');
    assert.equal(route(rec('resolve', [{ code: 'EA_CAPABILITY_UNSUPPORTED', path: '/nodes/9/adapterId' }])), 'design', 'a capability H lacks');
    assert.equal(route(rec('resolve', [{ code: 'EA_CAPABILITY_UNSUPPORTED', path: '/nodes/9/adapterVersion' }])), 'design');
    assert.equal(route(rec('check', [{ code: 'work' }])), 'program', 'work over P: the program reduces it');
    assert.equal(route(rec('interface', [{ code: 'EA_RESOLVE' }])), 'program');
    assert.equal(route(rec('visual', [{ code: 'too-dark' }])), null, 'a visual verdict never decides a scope');
    assert.equal(route(rec('lint', [], 'pass')), null);

    // The path with no finding: each module authored once, checked, the candidate sealed.
    const { s, modules } = session();
    const st = await s.start(handOff());
    assert.equal(st.phase, 'static-verified', JSON.stringify(st.stop));
    assert.deepEqual(modules.calls.map(c => [c.module.id, c.purpose]), [['motion', 'author'], ['sky', 'author'], ['water', 'author']]);
    for (const c of modules.calls) {
        // P7: R and S verbatim, this build's pins, the subject of this module under this X, the module's own slice.
        assert.deepEqual(c.request, R);
        assert.deepEqual(c.design, DESIGN);
        assert.deepEqual(c.versions, { ...MODULE_VERSIONS });
        assert.deepEqual(c.subject, {
            attempt: 'attempt-1', revision: c.subject.revision, programHash: st.programHash, graph: st.graph, candidate: null, module: c.module.id,
            interfaceHash: I[c.module.id].interfaceHash, codeHash: null,
        });
        assert.equal(c.module.interface.interfaceHash, I[c.module.id].interfaceHash);
        assert.equal(c.previous, null);
        assert.equal(c.turnId, 'turn-1');
    }
    assert.deepEqual(modules.calls.find(c => c.module.id === 'motion').nodes.map(n => n.id), ['instances', 'field', 'move']);
    assert.deepEqual(modules.calls.find(c => c.module.id === 'water').nodes.map(n => n.id), ['cube', 'water']);
    // id(C), and the sealed snapshot EA5's authority will take.
    const ids = st.modules.map(m => [m.module, m.interfaceHash, m.codeHash]);
    assert.equal(st.id, await candidateId(st.graph, ids));
    assert.ok(isSealed(s.snapshot) && s.snapshot.id === st.id);
    assert.deepEqual(st.verified, { id: st.id, revision: st.revision });
    // Every verdict a record; the completion references each module's own checks, never relabelled.
    assert.deepEqual(st.evidence.map(e => [e.phase, e.verdict]), [['resolve', 'pass'], ['check', 'pass'], ['interface', 'pass'], ['lint', 'pass'], ['lint', 'pass'], ['lint', 'pass'], ['candidate', 'pass']]);
    const completion = st.evidence.at(-1);
    assert.deepEqual(completion.refs, st.modules.flatMap(m => m.evidence));
    assert.equal(completion.subject.candidate, st.id);
    assert.deepEqual(st.budget.calls, { settled: 6, reserved: 0, unknown: 0 });
    assert.deepEqual(st.jobs.map(j => [j.module, j.status, j.charge, j.costMicroUsd]), [['motion', 'ok', 'known', 1000], ['sky', 'ok', 'known', 1000], ['water', 'ok', 'known', 1000]]);

    // A body's lint finding: that module is repaired, with exactly its findings, its body as judged; the others stay.
    const faulty = session({ modules: fakeModules({ sky: [FAULT.sky, BODIES.sky] }) });
    const repaired = await faulty.s.start(handOff());
    assert.equal(repaired.phase, 'static-verified');
    const calls = faulty.modules.calls;
    // Two checks run at once and either may end first: the order of water's author and sky's repair is not fixed.
    assert.deepEqual(calls.map(c => `${c.module.id} ${c.purpose}`).sort(), ['motion author', 'sky author', 'sky repair', 'water author']);
    const lint = repaired.evidence.find(e => e.phase === 'lint' && e.verdict === 'fail');
    assert.deepEqual([lint.subject.module, lint.findings.map(f => [f.code, f.line])], ['sky', [['call', 2]]]);
    const repair = calls.find(c => c.purpose === 'repair');
    assert.equal(repair.previous.body, FAULT.sky);
    assert.equal(repair.previous.codeHash, sha(FAULT.sky));
    assert.equal(repair.subject.codeHash, sha(FAULT.sky));
    assert.deepEqual(repair.previous.evidenceIds, [lint.id]);
    assert.deepEqual(repair.previous.findings.map(f => [f.id, f.code, f.line, f.severity]), lint.findings.map(f => [f.id, f.code, f.line, f.severity]));
    assert.deepEqual([repair.request, repair.design], [R, DESIGN], 'P7 in the repair too');

    // A body's compile error (a fake L3, labelled so) is a module's too: repaired, then static-verified.
    const compiler = compilerFailing('motion', 'body');
    const compiled = session({ compiler });
    const afterCompile = await compiled.s.start(handOff());
    assert.equal(afterCompile.phase, 'static-verified');
    assert.deepEqual(compiled.modules.calls.map(c => [c.module.id, c.purpose]).filter(([m]) => m === 'motion'), [['motion', 'author'], ['motion', 'repair']]);
    const l3 = afterCompile.evidence.find(e => e.phase === 'compile' && e.verdict === 'fail');
    assert.deepEqual([l3.producedBy, l3.findings[0].place, l3.findings[0].line], ['fake', 'body', 2]);
    assert.deepEqual(compiled.modules.calls.find(c => c.purpose === 'repair').previous.findings.map(f => f.rung), ['L3']);
    assert.ok(afterCompile.evidence.filter(e => e.phase === 'compile').every(e => e.producedBy === 'fake'), 'a fake compiler\'s verdicts say so');

    // Program refusals go to a program revision; with no reviser the candidate ends there, no call.
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    const upload = world();
    upload[0] = node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'upload' });
    const step = motionAt(64).map(n => (n.id === 'move' ? { ...n, config: JSON.stringify({ ...MOVE, entry: 'step' }) } : n));
    const lit = world().map(n => (n.id === 'water' ? { ...n, inputs: [...n.inputs, from('lights', 'sun', 'lights')] } : n));
    const nothing = [node('field', 'ng.buffer.storage', { elements: 64, layout: 'f32', strideFloats: 4, pingPong: false, init: 'zero' })];
    const unknown = world().map(n => (n.id === 'look' ? node('look', 'ng.post.sdf', { effects: [] }) : n));
    for (const [label, nodes, phase, scope, says] of [
        ['a resolver refusal', bad, 'resolve', 'program', /^EA_RESOLVE \/nodes\/1\/config\/elements: .*; no program revision: this candidate has no reviser$/],
        ['a gated value (Q80)', upload, 'resolve', 'program', /^EA_CAPABILITY_UNSUPPORTED \/nodes\/0\/config\/init: .*"upload" is not available yet/],
        ['a check on X', nothing, 'check', 'program', /no program revision/],
        ['an interface refusal', step, 'interface', 'program', /cannot be an entry/],
        ['custom lighting, gated', lit, 'interface', 'program', /water is a custom batch wired to lights/],
        ['a capability H lacks', unknown, 'resolve', 'design', /no adapter "ng.post.sdf".*; EA4 starts no design revision: the creator asks again$/],
    ]) {
        const run = session();
        const end = await run.s.start(handOff(nodes));
        assert.deepEqual([end.phase, end.stop?.scope], ['failed', scope], label);
        assert.match(end.stop.diagnostic, says, label);
        assert.equal(end.stop.sentence, COPY.candidate.setup, label);
        assert.equal(run.modules.calls.length, 0, `${label}: no module call`);
        assert.deepEqual([end.evidence.at(-1).phase, end.evidence.at(-1).verdict], [phase, 'fail'], label);
        assert.equal(run.s.snapshot, null);
    }
});

test('EA-K1 P1: a revision re-authors exactly the module whose interface changed; the others are reused with no call; the calls are counted', async () => {
    const changed = motionAt(32);
    assert.deepEqual(invalidated(await interfacesOf(world()), await interfacesOf(changed)), ['motion'], 'EA-U6 says motion');
    const reviser = fakeReviser([{ status: 'handed-off', turnId: 'turn-2', design: DESIGN, program: { nodes: changed }, calls: 2 }]);
    const { s, modules } = session({ revise: reviser.revise });
    const first = await s.start(handOff());
    assert.equal(first.phase, 'static-verified');
    // A visual verdict proposes a program change (it never decides one); the correction cites its finding.
    const visual = s.visual({ verdict: 'fail', producedBy: 'creator', findings: [{ code: 'grouping', message: 'move the blocks in smaller groups' }] });
    const corrected = await s.correct({ base: baseOf(first), scope: 'program', changes: [], findingsAddressed: [visual.findings[0].id] });
    assert.equal(corrected.ok, true, corrected.diagnostic);
    const after = corrected.state;
    assert.equal(after.phase, 'static-verified', JSON.stringify(after.stop));
    assert.deepEqual(modules.calls.slice(3).map(c => [c.module.id, c.purpose, c.turnId]), [['motion', 'author', 'turn-2']], 'motion alone, under the revision\'s turn');
    assert.deepEqual(after.modules.map(m => [m.module, m.reused, m.calls]), [['motion', false, 1], ['sky', true, 0], ['water', true, 0]]);
    assert.deepEqual(after.modules.filter(m => m.reused).map(m => m.codeHash), first.modules.filter(m => m.module !== 'motion').map(m => m.codeHash));
    // Reused under the same checker: no new check, and their verdicts are the records they passed with.
    assert.equal(after.evidence.filter(e => e.phase === 'lint').length, 4, 'three first, then motion\'s alone');
    assert.deepEqual(after.modules.filter(m => m.reused).map(m => m.evidence), first.modules.filter(m => m.module !== 'motion').map(m => m.evidence));
    // Counted: the turn's 3, three authors, the revision's actual 2, one author more.
    assert.deepEqual(after.budget.calls, { settled: 9, reserved: 0, unknown: 0 });
    assert.deepEqual([after.budget.authors, after.budget.revisions], [4, 1]);
    // The revision carried R and S verbatim, the base W and the finding it answers, subject-bound.
    const rq = reviser.calls[0];
    assert.deepEqual([rq.request, rq.design, rq.program.nodes], [R, DESIGN, world()]);
    assert.deepEqual(rq.findings.map(f => f.id), [visual.findings[0].id]);
    assert.deepEqual([rq.subject.graph, rq.subject.programHash], [first.graph, first.programHash]);
    assert.notEqual(after.graph, first.graph);
    assert.notEqual(after.id, first.id);
    assert.deepEqual(after.verified, { id: after.id, revision: after.revision });
});

test('EA-K2 P2: a correction citing another candidate\'s evidence, or none this attempt holds, is refused before any call', async () => {
    const reviser = fakeReviser([{ status: 'handed-off', turnId: 'turn-2', design: DESIGN, program: { nodes: world() }, calls: 1 }]);
    const { s, modules } = session({ revise: reviser.revise });
    const first = await s.start(handOff());
    const visual = s.visual({ verdict: 'fail', producedBy: 'model', findings: [{ code: 'too-dark', message: 'the dusk is too dark' }] });
    const cited = visual.findings[0].id;
    const base = baseOf(first);
    let calls = modules.calls.length;
    const refused = async (label, envelope, pattern) => {
        const r = await s.correct(envelope);
        assert.equal(r.ok, false, label);
        assert.match(r.diagnostic, pattern, label);
        assert.equal(modules.calls.length, calls, `${label}: no module call`);
        assert.equal(reviser.calls.length, 0, `${label}: no revision`);
    };
    const program = (over = {}, findings = [cited]) => ({ base: { ...base, ...over }, scope: 'program', changes: [], findingsAddressed: findings });
    await refused('another attempt', program({ attempt: 'attempt-0' }), /^EA_STALE_EVIDENCE expected attempt attempt-1, got attempt attempt-0$/);
    await refused('another candidate', program({ candidate: 'f'.repeat(64) }), /^EA_STALE_EVIDENCE expected candidate [0-9a-f]{12}, got candidate ffffffffffff$/);
    await refused('another program', program({ programHash: '0'.repeat(64) }), /^EA_STALE_EVIDENCE expected program [0-9a-f]{12} graph [0-9a-f]{12}, got program 000000000000/);
    await refused('a finding this attempt never held', program({}, ['ev-999.f1']), /^EA_STALE_EVIDENCE expected a finding this attempt holds, got ev-999.f1$/);
    await refused('no finding at all', program({}, []), /findingsAddressed is empty/);
    await refused('a module correction citing a finding about no module', { base, scope: 'modules', changes: ['sky'], findingsAddressed: [cited] },
        /^EA_STALE_EVIDENCE expected a finding about sky, got one about none/);
    await refused('a module that is not the candidate\'s', { base, scope: 'modules', changes: ['moon'], findingsAddressed: [cited] }, /got module moon$/);
    await refused('a design revision', { ...program(), scope: 'design' }, /EA4 starts no design revision/);
    await refused('the controls tier', { ...program(), scope: 'controls' }, /waits for Q85/);
    // A newer candidate: an envelope based on the old one is stale, though it cites a finding that existed.
    await s.start(handOff());
    calls = modules.calls.length;
    await refused('the attempt that was superseded', program(), /^EA_STALE_EVIDENCE expected attempt attempt-2, got attempt attempt-1$/);
    // A correction waits until the candidate settles: refused while it runs, with no call.
    const held = fakeModules({ motion: [{ hold: 'm' }] });
    const busy = session({ modules: held });
    const pending = busy.s.start(handOff());
    await waitFor(() => held.held.length === 1, 'the held author');
    const r = await busy.s.correct(program());
    assert.deepEqual(r, { ok: false, diagnostic: 'the candidate is still running: a correction waits until it settles' });
    held.held[0].resolve(BODIES.motion);
    assert.equal((await pending).phase, 'static-verified');
});

test('EA-K2b the EA4.3 review: a module correction cites a current finding of each module it changes and names each once; else no call, no change', async () => {
    // Motion passes with a warning (a value nothing declares, line 3); a correction may answer it, motion's alone.
    const WARNED = 'fn advance(index: u32) {\n    let base = index * B_instances_STRIDE;\n    b_instances[base + 1u] = f32(index) * shimmer;\n}';
    const { s, modules } = session({ modules: fakeModules({ motion: [WARNED, BODIES.motion] }) });
    const first = await s.start(handOff());
    assert.equal(first.phase, 'static-verified', JSON.stringify(first.stop));
    const record = first.evidence.find(e => e.phase === 'lint' && e.subject.module === 'motion');
    assert.deepEqual([record.verdict, record.findings.map(f => [f.code, f.line, f.severity])], ['pass', [['unresolved', 3, 'warning']]]);
    const warning = record.findings[0].id;
    const sealed = s.snapshot;
    const calls = modules.calls.length;
    const base = baseOf(first);
    const refused = async (label, envelope, pattern) => {
        const r = await s.correct(envelope);
        assert.equal(r.ok, false, label);
        assert.match(r.diagnostic, pattern, label);
        assert.equal(modules.calls.length, calls, `${label}: no call`);
        assert.deepEqual(s.state, first, `${label}: the candidate as it was`);
        assert.equal(s.snapshot, sealed, `${label}: the same sealed candidate`);
    };
    // The review's probe: sky named beside motion with no finding of its own was reopened and sent to a repair with none,
    // which the backend refuses (previous.findings is 1 to 32).
    await refused('a module named with no finding cited for it', { base, scope: 'modules', changes: ['motion', 'sky'], findingsAddressed: [warning] },
        /^a module correction answers a finding about each module it changes: none is cited about sky$/);
    await refused('a module named twice', { base, scope: 'modules', changes: ['motion', 'motion'], findingsAddressed: [warning] },
        /^a module correction names each module once: motion is named twice$/);
    await refused('a finding cited twice', { base, scope: 'modules', changes: ['motion'], findingsAddressed: [warning, warning] },
        new RegExp(`^a correction cites each finding once: ${warning.replace('.', '\\.')} is cited twice$`));
    // Motion alone, citing its own warning: its repair carries that finding, and nothing else is called.
    const r = await s.correct({ base, scope: 'modules', changes: ['motion'], findingsAddressed: [warning] });
    assert.equal(r.ok, true, r.diagnostic);
    assert.equal(r.state.phase, 'static-verified', JSON.stringify(r.state.stop));
    const later = modules.calls.slice(calls);
    assert.deepEqual(later.map(c => [c.module.id, c.purpose]), [['motion', 'repair']]);
    assert.deepEqual([later[0].previous.evidenceIds, later[0].previous.findings.map(f => [f.id, f.severity])], [[record.id], [[warning, 'warning']]]);
    assert.notEqual(r.state.id, first.id);
});

test('EA-K4 P4: a visual pass on a technically failing candidate is its own verdict; the candidate stays failed, nothing sealed', async () => {
    const { s, modules } = session({ modules: fakeModules({ sky: [FAULT.sky] }) });
    const st = await s.start(handOff());
    assert.equal(st.phase, 'failed');
    assert.equal(st.stop.scope, 'modules');
    assert.match(st.stop.diagnostic, /^EA_MODULE sky: L1 at line 2: .*noise2.*; 2 repairs used$/);
    assert.equal(st.stop.sentence, COPY.candidate.moduleFailed);
    assert.deepEqual(modules.calls.filter(c => c.module.id === 'sky').map(c => c.purpose), ['author', 'repair', 'repair']);
    const visual = s.visual({ verdict: 'pass', producedBy: 'creator' });
    assert.deepEqual([visual.phase, visual.verdict, visual.producedBy, route(visual)], ['visual', 'pass', 'creator', null]);
    const after = s.state;
    assert.equal(after.phase, 'failed');
    assert.deepEqual([after.id, after.verified, s.snapshot], [null, null, null]);
    assert.ok(after.evidence.some(e => e.id === visual.id));
});

test('EA-K5 P5: each budget at B runs and at B+1 refuses before its call, the outcome naming it', async () => {
    const L = (over = {}, turn = 0) => new Ledger({ ...Q_C, ...over }, turn);
    // calls: 19, the turn's 6 among them.
    const calls = L({ authors: 100, concurrent: 100 }, 6);
    for (let i = 0; i < 13; i++) assert.ok(calls.reserveModule('author', `m${i}`).ok, `call ${7 + i}`);
    const over = calls.reserveModule('author', 'm13');
    assert.deepEqual(over, { ok: false, budget: 'calls', used: 19, limit: 19 });
    assert.equal(budgetDiagnostic(over), 'EA_TURN_BUDGET calls: 19 of 19');
    // authors: 4.
    const authors = L({ concurrent: 100 });
    for (let i = 0; i < 4; i++) assert.ok(authors.reserveModule('author', `m${i}`).ok);
    assert.deepEqual(authors.reserveModule('author', 'm4'), { ok: false, budget: 'authors', used: 4, limit: 4 });
    // repairs: 2 a module, 3 in all.
    const repairs = L({ concurrent: 100 });
    assert.ok(repairs.reserveModule('repair', 'a').ok && repairs.reserveModule('repair', 'a').ok);
    assert.deepEqual(repairs.reserveModule('repair', 'a'), { ok: false, budget: 'repairs-per-module', used: 2, limit: 2 });
    assert.ok(repairs.reserveModule('repair', 'b').ok);
    assert.deepEqual(repairs.reserveModule('repair', 'c'), { ok: false, budget: 'repairs', used: 3, limit: 3 });
    // concurrent: 2 at once, the scheduler's bound: a third waits, and goes once one has ended.
    const concurrent = L();
    const a = concurrent.reserveModule('author', 'a');
    assert.ok(concurrent.reserveModule('author', 'b').ok);
    assert.deepEqual(concurrent.reserveModule('author', 'c'), { ok: false, budget: 'concurrent', used: 2, limit: 2 });
    concurrent.dispatched(a.reservation);
    concurrent.settle(a.reservation, 1);
    assert.ok(concurrent.reserveModule('author', 'c').ok);
    // revisions: 1, its whole allowance reserved, never beside a module call.
    const revisions = L({}, 6);
    const m = revisions.reserveModule('author', 'a');
    assert.deepEqual(revisions.reserveRevision(), { ok: false, budget: 'concurrent', used: 1, limit: 0 }, 'no revision overlaps a module call');
    revisions.dispatched(m.reservation);
    revisions.settle(m.reservation, 1);
    const rev = revisions.reserveRevision();
    assert.ok(rev.ok);
    assert.equal(revisions.state.calls.reserved, 6);
    assert.deepEqual(revisions.reserveModule('author', 'b'), { ok: false, budget: 'concurrent', used: 1, limit: 0 }, 'no module call overlaps a revision');
    revisions.dispatched(rev.reservation);
    revisions.settle(rev.reservation, 2);
    assert.deepEqual(revisions.state.calls, { settled: 9, reserved: 0, unknown: 0 }, 'reconciled to its actual calls');
    assert.deepEqual(revisions.reserveRevision(), { ok: false, budget: 'revisions', used: 1, limit: 1 });
    assert.deepEqual(L({}, 14).reserveRevision(), { ok: false, budget: 'calls', used: 14, limit: 19 }, 'its six must fit');
    assert.ok(L({}, 13).reserveRevision().ok);
    // Only a reservation never dispatched returns; a dispatched one whose end is not seen is counted, never zero.
    const spent = L();
    const undispatched = spent.reserveModule('author', 'a');
    assert.equal(spent.release(undispatched.reservation), true);
    assert.equal(spent.state.authors, 0);
    const gone = spent.reserveModule('author', 'b');
    spent.dispatched(gone.reservation);
    assert.equal(spent.release(gone.reservation), false);
    spent.settle(gone.reservation, null);
    assert.deepEqual([spent.state.calls, spent.state.authors], [{ settled: 0, reserved: 0, unknown: 1 }, 1]);

    // The machine: modules, authors, calls and repairs, each at B and at B+1.
    const runAt = async (nodes, limits, script) => {
        const run = session({ limits: { ...Q_C, ...limits }, modules: fakeModules(script) });
        return { end: await run.s.start(handOff(nodes)), calls: run.modules.calls };
    };
    const at4 = await runAt(four(), {});
    assert.deepEqual([at4.end.phase, at4.calls.length], ['static-verified', 4]);
    const at5 = await runAt(five(), {});
    assert.deepEqual([at5.end.phase, at5.end.stop.diagnostic, at5.end.stop.sentence, at5.calls.length], ['exhausted', 'EA_TURN_BUDGET modules: 5 of 4', COPY.candidate.budget, 0]);
    assert.equal((await runAt(world(), { authors: 3 })).end.phase, 'static-verified');
    const authors2 = await runAt(world(), { authors: 2 });
    assert.deepEqual([authors2.end.phase, authors2.end.stop.diagnostic, authors2.calls.length], ['exhausted', 'EA_TURN_BUDGET authors: 2 of 2', 2]);
    assert.equal((await runAt(world(), { calls: 6 })).end.phase, 'static-verified');
    const calls5 = await runAt(world(), { calls: 5 });
    assert.deepEqual([calls5.end.phase, calls5.end.stop.diagnostic, calls5.calls.length], ['exhausted', 'EA_TURN_BUDGET calls: 5 of 5', 2]);
    const allFaulty = { motion: [FAULT.motion, BODIES.motion], sky: [FAULT.sky, BODIES.sky], water: [FAULT.water, BODIES.water] };
    const repairs3 = await runAt(world(), {}, allFaulty);
    assert.deepEqual([repairs3.end.phase, repairs3.calls.filter(c => c.purpose === 'repair').length], ['static-verified', 3]);
    const repairs2 = await runAt(world(), { repairs: 2 }, allFaulty);
    assert.deepEqual([repairs2.end.phase, repairs2.end.stop.diagnostic, repairs2.calls.filter(c => c.purpose === 'repair').length], ['exhausted', 'EA_TURN_BUDGET repairs: 2 of 2', 2]);
});

test('EA-K6 a cancel or a newer candidate in each phase: shown at once, no call after, nothing applied, nothing to admit', async () => {
    const heldChecks = [];
    const holdingChecker = { version: 'ea4-body.v1', check: (iface, answer) => new Promise(resolve => heldChecks.push(() => resolve(checkBody(iface, answer)))) };
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    const phases = [
        { phase: 'resolving', nodes: world(), deps: () => ({}), ready: () => true },
        { phase: 'authoring', nodes: world(), deps: () => ({ modules: fakeModules({ motion: [{ hold: 'm' }, BODIES.motion], sky: [{ hold: 's' }, BODIES.sky] }) }), ready: (r) => r.modules.held.length === 2 },
        { phase: 'checking', nodes: one(), deps: () => ({ checker: holdingChecker }), ready: () => heldChecks.length === 1 },
        { phase: 'correcting', nodes: world(), deps: () => ({ modules: fakeModules({ sky: [FAULT.sky, { hold: 'r' }, BODIES.sky] }) }), ready: (r) => r.modules.held.length === 1 },
        { phase: 'correcting', label: 'correcting (a revision)', nodes: bad, deps: () => ({ revise: fakeReviser([{ hold: true }, { status: 'declined', reason: 'no', calls: 1 }]).revise }), ready: (r) => r.states.at(-1)?.phase === 'correcting' },
        { phase: 'static-verified', nodes: world(), deps: () => ({}), ready: () => true, after: true },
    ];
    for (const how of ['cancel', 'newer']) {
        for (const p of phases) {
            heldChecks.length = 0;
            const label = `${p.label ?? p.phase}, ${how}`;
            const run = session(p.deps());
            const pending = run.s.start(handOff(p.nodes));
            if (p.after) await pending;
            await waitFor(() => p.ready(run), label);
            assert.equal(run.s.state.phase, p.phase, `${label}: in the phase`);
            const attempt = run.s.state.attempt;
            const before = run.modules.calls.length;
            if (how === 'cancel') run.s.cancel();
            else void run.s.start(handOff(world()));
            // Shown at once: the cancelled attempt is cancelled before anything settles; the superseded one is no longer shown.
            if (how === 'cancel') assert.equal(run.states.at(-1).phase, 'cancelled', `${label}: shown at once`);
            else assert.notEqual(run.s.state.attempt, attempt, `${label}: the newer one is the one shown`);
            for (const release of heldChecks.splice(0)) release();
            // A candidate already static-verified had resolved its start: its end is the state shown, when it is shown.
            const ended = p.after ? (how === 'cancel' ? run.s.state : null) : await pending;
            await settle();
            if (!ended) {
                assert.ok(run.s.snapshot === null || run.s.snapshot.attempt !== attempt, `${label}: never the old one's`);
                assert.ok(run.modules.calls.slice(before).every(c => c.subject.attempt !== attempt), `${label}: no call for the old attempt`);
                continue;
            }
            assert.equal(ended.phase, how === 'cancel' ? 'cancelled' : 'superseded', label);
            // No call after, for the old attempt: none at all after a cancel; only the newer one's after a newer start.
            const later = run.modules.calls.slice(before);
            if (how === 'cancel') assert.deepEqual(later, [], `${label}: no call after`);
            else assert.ok(later.every(c => c.subject.attempt !== attempt), `${label}: no call for the old attempt`);
            // Nothing applied after the stop, and nothing sealed to admit: the Head is EA5's, never touched here.
            assert.equal(ended.id, null, `${label}: no candidate id`);
            if (how === 'cancel') assert.equal(run.s.snapshot, null, `${label}: nothing to admit`);
            else assert.ok(run.s.snapshot === null || run.s.snapshot.attempt !== attempt, `${label}: never the old one's`);
            // Calls held open were aborted, and their charge is unknown, never zero.
            const open = ended.jobs.filter(j => j.status === 'cancelled');
            assert.equal(ended.budget.calls.unknown, open.length + (p.label ? 6 : 0), `${label}: unknown, never zero`);
            assert.equal(ended.budget.calls.reserved, 0, label);
            if (p.phase === 'checking') assert.equal(ended.evidence.filter(e => e.phase === 'lint').length, 0, `${label}: a late check is not applied`);
        }
    }
});

test('EA-K8 a resolve failure is addressable before X; two bodies failing under one X never share their repairs', async () => {
    // Resolve fails before any X: its finding names the program and no graph, and a revision can answer it by id.
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    const reviser = fakeReviser([{ status: 'declined', reason: 'cannot seed the field', calls: 1 }]);
    const refused = session({ revise: reviser.revise });
    const end = await refused.s.start(handOff(bad));
    const record = end.evidence.find(e => e.phase === 'resolve');
    assert.deepEqual([record.verdict, record.subject.graph, record.subject.module], ['fail', null, null]);
    assert.match(record.subject.programHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.findings.map(f => [f.id, f.code, f.path]), [[`${record.id}.f1`, 'EA_RESOLVE', '/nodes/1/config/elements']]);
    assert.deepEqual(reviser.calls[0].findings.map(f => f.id), [`${record.id}.f1`]);
    assert.equal(reviser.calls[0].subject.graph, null);
    assert.deepEqual([end.phase, end.stop.scope], ['failed', 'program']);
    assert.match(end.stop.diagnostic, /^the program revision ended declined: cannot seed the field$/);
    assert.equal(end.program.nodes[1].config, bad[1].config, 'no replacement');
    // The program's hash is X's own when its nodes check (their configs parsed: spacing does not count), and W's as it
    // came when they do not, so a subject names its program either way.
    const x = (await resolveProgram(world())).graph;
    assert.equal(await programHash(world()), x.identity.programHash);
    const spaced = world().map(n => ({ ...n, config: JSON.stringify(JSON.parse(n.config), null, 2) }));
    assert.equal(await programHash(spaced), x.identity.programHash);
    assert.equal(record.subject.programHash, await programHash(bad));
    assert.notEqual(record.subject.programHash, await programHash(world()));

    // Two bodies fail under one X: each repair answers its own module's findings, about its own body.
    const fake = fakeModules({ water: [FAULT.water, { hold: 'rw' }], sky: [FAULT.sky, { hold: 'rs' }] });
    const { s } = session({ modules: fake });
    const pending = s.start(handOff());
    await waitFor(() => fake.held.length === 2, 'both repairs');
    const st = s.state;
    const failed = (m) => st.evidence.find(e => e.phase === 'lint' && e.verdict === 'fail' && e.subject.module === m);
    const w = failed('water');
    const k = failed('sky');
    assert.equal(w.subject.graph, k.subject.graph, 'one X');
    assert.notEqual(w.subject.codeHash, k.subject.codeHash);
    for (const [m, e] of [['water', w], ['sky', k]]) {
        const body = fake.held.find(h => h.module === m).body;
        assert.deepEqual(body.previous.evidenceIds, [e.id], `${m}'s repair cites its own record`);
        assert.deepEqual(body.previous.findings.map(f => f.id), e.findings.map(f => f.id));
        assert.equal(body.subject.codeHash, e.subject.codeHash);
    }
    // A repair of water citing sky's finding is refused, whatever the candidate's state; its own finding is not.
    const current = {
        attempt: st.attempt, revision: st.revision, candidate: null, programHash: st.programHash, graph: st.graph,
        modules: new Map(st.modules.map(m => [m.module, { interfaceHash: m.interfaceHash, codeHash: m.codeHash }])),
    };
    const find = (id) => {
        for (const r of st.evidence) {
            const f = r.findings.find(x => x.id === id);
            if (f) return { record: r, finding: f };
        }
        return null;
    };
    const base = { attempt: st.attempt, revision: st.revision, candidate: null, programHash: st.programHash, graph: st.graph };
    assert.match(verifyEnvelope({ base, scope: 'modules', changes: ['water'], findingsAddressed: [k.findings[0].id] }, current, find),
        /^EA_STALE_EVIDENCE expected a finding about water, got one about sky/);
    assert.equal(verifyEnvelope({ base, scope: 'modules', changes: ['water'], findingsAddressed: [w.findings[0].id] }, current, find), null);
    for (const h of fake.held) h.resolve(BODIES[h.module]);
    const done = await pending;
    assert.equal(done.phase, 'static-verified');
    // Water's body has changed since: its old finding is stale for it now, and a correction citing it makes no call.
    const calls = fake.calls.length;
    const r = await s.correct({ base: baseOf(done), scope: 'modules', changes: ['water'], findingsAddressed: [w.findings[0].id] });
    assert.equal(r.ok, false);
    assert.match(r.diagnostic, /^EA_STALE_EVIDENCE expected graph [0-9a-f]{12}, got graph [0-9a-f]{12}|^EA_STALE_EVIDENCE expected body [0-9a-f]{12}, got body [0-9a-f]{12}/);
    assert.equal(fake.calls.length, calls);
});

test('EA-K9 the ledger under concurrency and revisions: no oversubscription, no fifth author, an unseen revision counted whole', async () => {
    // Two calls at once, never a third, and the third goes once one ends.
    const fake = fakeModules({ motion: [{ hold: 'm' }], sky: [{ hold: 's' }], water: [{ hold: 'w' }] });
    const run = session({ modules: fake });
    const pending = run.s.start(handOff());
    await waitFor(() => fake.held.length === 2, 'two calls');
    await settle();
    assert.equal(fake.held.length, 2, 'never a third at once');
    assert.equal(run.s.state.budget.inFlight, 2);
    fake.held[0].resolve(BODIES[fake.held[0].module]);
    await waitFor(() => fake.held.length === 3, 'the third');
    for (const h of fake.held.slice(1)) h.resolve(BODIES[h.module]);
    assert.equal((await pending).phase, 'static-verified');

    // One slot left and two modules ready: exactly one call starts; the other is refused before its call.
    const last = fakeModules({ motion: [{ hold: 'm' }], sky: [{ hold: 's' }] });
    const tight = session({ modules: last, limits: { ...Q_C, calls: 4 } });
    const end = await tight.s.start(handOff());
    assert.deepEqual([end.phase, end.stop.diagnostic], ['exhausted', 'EA_TURN_BUDGET calls: 4 of 4']);
    assert.equal(last.calls.length, 1, 'no oversubscription');
    assert.deepEqual(end.budget.calls, { settled: 3, reserved: 0, unknown: 1 }, 'the aborted call is counted, unknown');
    assert.deepEqual(end.jobs.map(j => [j.module, j.status, j.charge]), [['motion', 'cancelled', 'unknown']]);

    // A revision after four authors: the module it changes cannot be authored a fifth time.
    const reviser = fakeReviser([{ status: 'handed-off', turnId: 'turn-2', design: DESIGN, program: { nodes: motionAt(32, four()) }, calls: 2 }]);
    const fourRun = session({ revise: reviser.revise });
    const first = await fourRun.s.start(handOff(four()));
    assert.equal(first.phase, 'static-verified');
    const visual = fourRun.s.visual({ verdict: 'fail', producedBy: 'creator', findings: [{ code: 'grouping', message: 'smaller groups' }] });
    const r = await fourRun.s.correct({ base: baseOf(first), scope: 'program', changes: [], findingsAddressed: [visual.findings[0].id] });
    assert.equal(r.ok, true);
    assert.deepEqual([r.state.phase, r.state.stop.diagnostic], ['exhausted', 'EA_TURN_BUDGET authors: 4 of 4']);
    assert.equal(fourRun.modules.calls.length, 4, 'no fifth author');
    // Exhaustion keeps the last static-verified candidate, and starts nothing more.
    assert.deepEqual([r.state.verified.id, r.state.id, fourRun.s.snapshot], [first.id, null, null]);

    // A revision whose end is not seen keeps its whole reservation, unknown, never zero.
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    const dropped = fakeReviser([{ throws: new ForgeError('unavailable', 0, 'The backend did not answer (socket hang up).') }]);
    const disconnected = session({ revise: dropped.revise });
    const gone = await disconnected.s.start(handOff(bad));
    assert.deepEqual([gone.phase, gone.stop.scope, gone.stop.sentence], ['failed', 'host', COPY.failures.offline]);
    assert.equal(gone.stop.diagnostic, 'revision: The backend did not answer (socket hang up).; charge unknown');
    assert.deepEqual([gone.budget.calls, gone.budget.revisions], [{ settled: 3, reserved: 0, unknown: 6 }, 1]);
    assert.equal(disconnected.modules.calls.length, 0);
});

test('EA-K10 the checker\'s version, a concurrent result, exact reuse: re-checked with no call, accepted, re-authored when renamed', async () => {
    // The checker's version moves: reused bodies are judged again by the current checker, with no model call.
    const checker = { version: 'ea4-body.v1', check: (iface, answer) => checkBody(iface, answer) };
    const same = fakeReviser([{ status: 'handed-off', turnId: 'turn-2', design: DESIGN, program: { nodes: world() }, calls: 1 }]);
    const { s, modules } = session({ checker, revise: same.revise });
    const first = await s.start(handOff());
    checker.version = 'ea4-body.v2';
    const visual = s.visual({ verdict: 'fail', producedBy: 'creator', findings: [{ code: 'retry', message: 'again' }] });
    const r = await s.correct({ base: baseOf(first), scope: 'program', changes: [], findingsAddressed: [visual.findings[0].id] });
    assert.equal(r.state.phase, 'static-verified', JSON.stringify(r.state.stop));
    assert.equal(modules.calls.length, 3, 'no model call');
    assert.deepEqual(r.state.modules.map(m => [m.module, m.reused, m.checkerVersion]), [['motion', true, 'ea4-body.v2'], ['sky', true, 'ea4-body.v2'], ['water', true, 'ea4-body.v2']]);
    assert.equal(r.state.evidence.filter(e => e.phase === 'lint').length, 6, 'judged again: three new records');
    assert.equal(r.state.id, first.id, 'the same X and the same bodies: the same candidate');

    // Another module finishing first is not stale: both concurrent results are accepted.
    const fake = fakeModules({ motion: [{ hold: 'm' }], sky: [{ hold: 's' }] });
    const run = session({ modules: fake });
    const pending = run.s.start(handOff());
    await waitFor(() => fake.held.length === 2, 'two authors');
    fake.held.find(h => h.module === 'sky').resolve(BODIES.sky);
    await waitFor(() => run.s.state.modules.find(m => m.module === 'sky').phase === 'passed', 'sky passed');
    const moved = run.s.state.revision;
    fake.held.find(h => h.module === 'motion').resolve(BODIES.motion);
    const done = await pending;
    assert.equal(done.phase, 'static-verified');
    assert.ok(done.jobs.every(j => j.status === 'ok'), JSON.stringify(done.jobs));
    assert.ok(done.jobs.find(j => j.module === 'motion').revision < moved, 'motion\'s call began before sky\'s result moved the revision');

    // Reuse is exact: a renamed module (the same body would do) is authored again.
    const renamed = world().map(n => (n.id === 'sky' ? { ...n, config: JSON.stringify({ module: 'sky2', fragmentEntry: 'dusk' }) } : n));
    const rename = fakeReviser([{ status: 'handed-off', turnId: 'turn-2', design: DESIGN, program: { nodes: renamed }, calls: 1 }]);
    const third = session({ revise: rename.revise });
    const before = await third.s.start(handOff());
    const v = third.s.visual({ verdict: 'fail', producedBy: 'creator', findings: [{ code: 'rename', message: 'call it sky2' }] });
    const after = await third.s.correct({ base: baseOf(before), scope: 'program', changes: [], findingsAddressed: [v.findings[0].id] });
    assert.equal(after.state.phase, 'static-verified');
    assert.deepEqual(third.modules.calls.slice(3).map(c => [c.module.id, c.purpose]), [['sky2', 'author']]);
    assert.deepEqual(after.state.modules.map(m => [m.module, m.reused]), [['motion', true], ['sky2', false], ['water', true]]);
});

test('EA-K12 the evidence bounds: history past its bound is dropped oldest first and counted; required records past the bytes fail closed', async () => {
    const { s } = session({ evidence: { history: 2, bytes: 4 * 1024 * 1024 } });
    const st = await s.start(handOff());
    assert.equal(st.phase, 'static-verified');
    const visuals = Array.from({ length: 5 }, (_, i) => s.visual({ verdict: 'pass', producedBy: 'creator', findings: [{ code: 'note', message: `look ${i}` }] }));
    const after = s.state;
    assert.deepEqual(after.evidence.filter(e => e.phase === 'visual').map(e => e.id), visuals.slice(3).map(v => v.id), 'the newest two kept');
    assert.deepEqual({ ...after.omitted }, { visual: 3 });
    // Every record the candidate stands on is still held.
    for (const id of [...after.modules.flatMap(m => m.evidence), ...after.evidence.at(-3).refs]) assert.ok(after.evidence.some(e => e.id === id), id);
    assert.ok(after.evidence.some(e => e.phase === 'candidate'));
    // The bundle declares what it omits, the versions and each call's charge; no credential is anywhere in it.
    const bundle = candidateBundle(after);
    assert.deepEqual([bundle.format, bundle.candidate, bundle.omitted.records, bundle.omitted.byPhase.visual], ['wexy-candidate-bundle.v1', st.id, 3, 3]);
    assert.deepEqual(bundle.versions.templates, ['module.author.v1']);
    assert.equal(bundle.versions.checker, 'ea4-body.v1');
    assert.ok(bundle.calls.jobs.every(j => j.charge === 'known'));
    assert.deepEqual(bundle.request, R);
    const text = JSON.stringify(bundle);
    assert.ok(!/Bearer|X-Firebase-AppCheck|ac-\d/.test(text), 'no credential');

    // The records a candidate stands on are never dropped: past the bytes, it fails closed, before any call.
    const small = session({ evidence: { history: 256, bytes: 600 } });
    const end = await small.s.start(handOff());
    assert.deepEqual([end.phase, end.stop.scope, end.stop.sentence], ['failed', 'evidence', COPY.candidate.tooLarge]);
    assert.match(end.stop.diagnostic, /^EA_EVIDENCE_LIMIT \d+ of 600; required records cannot be evicted$/);
    assert.equal(small.modules.calls.length, 0);
});

test('EA-K13 no module, a revision that changes S or asks, a finding in the host\'s source: no call, no replacement, no body repair', async () => {
    // A graph with no module: no author call, and a candidate of no bodies.
    const none = session();
    const empty = await none.s.start(handOff(zero()));
    assert.equal(empty.phase, 'static-verified', JSON.stringify(empty.stop));
    assert.equal(none.modules.calls.length, 0);
    assert.equal(empty.id, await candidateId(empty.graph, []));
    assert.deepEqual(none.s.snapshot.bodies, []);

    // A revision that changes S, asks, or declines: W is not replaced, and the revision's calls are counted.
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    for (const [label, result, scope, says] of [
        ['a changed design', { status: 'handed-off', turnId: 'turn-2', design: { ...DESIGN, intent: 'a forest instead' }, program: { nodes: world() }, calls: 3 }, 'design',
            /^the program revision changed the design \(S\), which a program revision may not: no replacement$/],
        ['a question', { status: 'asked', reason: 'Which blocks?', calls: 1 }, 'program', /^the program revision ended asked: Which blocks\?$/],
        ['a refusal', { status: 'declined', reason: 'cannot', calls: 2 }, 'program', /^the program revision ended declined: cannot$/],
    ]) {
        const run = session({ revise: fakeReviser([result]).revise });
        const end = await run.s.start(handOff(bad));
        assert.deepEqual([end.phase, end.stop.scope], ['failed', scope], label);
        assert.match(end.stop.diagnostic, says, label);
        assert.deepEqual(end.program.nodes, bad, `${label}: no replacement`);
        assert.equal(end.graph, null, label);
        assert.deepEqual([end.budget.revisions, end.budget.calls.settled], [1, 3 + result.calls], `${label}: counted`);
        assert.equal(run.modules.calls.length, 0, label);
    }

    // A compile error in the host's generated source stops the candidate; it is never sent to a body repair.
    const host = session({ compiler: compilerFailing('motion', 'host', 5) });
    const hostEnd = await host.s.start(handOff());
    assert.deepEqual([hostEnd.phase, hostEnd.stop.scope], ['failed', 'host']);
    assert.match(hostEnd.stop.diagnostic, /^EA_MODULE motion: L3 in the host's generated source: unresolved value: shimmer \(the host's preamble, line 1 of the module\)$/);
    assert.equal(host.modules.calls.filter(c => c.purpose === 'repair').length, 0, 'no body repair');
    // One with no line accuses no module: the candidate stops, and nothing is repaired.
    const unplaced = session({ compiler: compilerFailing('motion', 'none', 5) });
    const unplacedEnd = await unplaced.s.start(handOff());
    assert.deepEqual([unplacedEnd.phase, unplacedEnd.stop.scope], ['failed', 'candidate']);
    assert.match(unplacedEnd.stop.diagnostic, /no module is accused$/);
    assert.equal(unplaced.modules.calls.filter(c => c.purpose === 'repair').length, 0);

    // An answer the server judged unusable (its own error, the call ended) needs the same call again, within Q_C;
    // anything else from the server stops the candidate, with the backend's words and the creator's sentence.
    const empty1 = session({ modules: fakeModules({ motion: [{ error: 'upstream' }, BODIES.motion] }) });
    const retried = await empty1.s.start(handOff());
    assert.equal(retried.phase, 'static-verified');
    assert.deepEqual(empty1.modules.calls.filter(c => c.module.id === 'motion').map(c => c.purpose), ['author', 'author']);
    assert.deepEqual(retried.jobs.filter(j => j.module === 'motion').map(j => j.status), ['unusable', 'ok']);
    const refusedRun = session({ modules: fakeModules({ motion: [{ throws: new ForgeError('rate', 429, 'Too many module calls.') }] }) });
    const rateEnd = await refusedRun.s.start(handOff());
    assert.deepEqual([rateEnd.phase, rateEnd.stop.scope, rateEnd.stop.diagnostic, rateEnd.stop.sentence], ['failed', 'host', 'rate: Too many module calls.', COPY.failures.rate]);
    assert.equal(refusedRun.modules.calls.filter(c => c.module.id === 'motion').length, 1, 'never retried');
});
