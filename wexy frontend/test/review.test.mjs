// EA-VR3, VR5, VR7 and VR9 (retention), headless (EA6.2; visual-review-design.md §5, §8, §10; Q110 decided 2026-11-02,
// Q113 held): the review of the stage (src/loop/review.ts) over the candidate session (src/loop/candidate.ts), with a
// fake module client, a fake reviser and a fake capture. No GPU, no model, no spend.
//   EA-VR3 "Improve it": the creator's words and the host's findings they kept checked become one program revision citing
//          exactly them, R and S verbatim; its round recorded; the improved candidate awaits Run; a review of a world no
//          longer on the stage, or from before a device was replaced, is refused with no call
//   EA-VR5 two rounds, a third refused; the 34-call cap and the revisions refusing before anything reopens, the round given
//          back; a round that went out stays spent whatever came of it (authors exhausted, a cancel, an unseen end); a
//          double press makes one call; a revision holds its six calls while it runs
//   EA-VR7 the same X with another body is another candidate; a session that holds another candidate, or none, records
//          nothing and improves nothing; a capture or a round that resolves after a newer review or install attaches
//          nothing to the newer one
//   EA-VR9 the newest three reviews keep their JPEGs, the older say theirs were dropped, whatever shows them is told; at
//          most REVIEW_HISTORY reviews, the evictions counted
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NOTE_CODE, createCandidateSession } from '../src/loop/candidate.ts';
import { Q_C } from '../src/loop/candidate-ledger.ts';
import { COPY } from '../src/loop/copy.ts';
import { KEEP_FRAMES, KEPT_BYTES, REVIEW_HISTORY, StageReviews, sentenceOf } from '../src/loop/review.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });
const sha = text => createHash('sha256').update(text).digest('hex');
const MOVE = { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'fixedStep' };

/** The candidate tests' world (candidate.test.mjs): one module of each kind; `size` its cube's, `workgroupSize` motion's. */
function world({ size = 1, workgroupSize = 64 } = {}) {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { ...MOVE, workgroupSize }, [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.1, 0.1, 0.12], directional: { direction: [0.3, -1, 0.2], color: [1, 0.95, 0.85], intensity: 2 }, points: [] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer'), from('lights', 'sun', 'lights')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 1 }, [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'field', 'buffer')]),
        node('look', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ];
}
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
};
/** Motion's body moving its blocks twice as far: the same interface, another body. */
const FARTHER = BODIES.motion.replace('0.1', '0.2');
const R = { prompt: 'a castle on a green hill', style: 'cinematic', seconds: 12 };
const DESIGN = {
    intent: 'a castle on a hill', interpretation: null, assumptions: [], visualElements: [{ name: 'castle', description: 'stone walls' }],
    motion: 'flags flutter', animated: true, techniques: [], resourceFlow: [], cameraAndTiming: 'a slow orbit', controls: [], successCriteria: [], unresolved: [],
};
const TURN_CALLS = [1, 2, 3].map(n => ({ n, purpose: n === 1 ? 'first' : 'next', charge: 'known', costMicroUsd: 46_000, generationId: `gen-${n}` }));
const handOff = (nodes = world(), over = {}) => ({ turnId: 'turn-1', request: R, design: DESIGN, program: { nodes }, model: 'model-0', promptVersion: 'agent.v5', calls: TURN_CALLS, ...over });

/** The module client: each module's body (or `bodies[module]`; a repair's `repairs[module]` first), with a usage. */
function fakeModules(bodies = {}, repairs = {}) {
    const calls = [];
    return {
        calls,
        async call(body, onEvent, signal) {
            signal.throwIfAborted();
            calls.push(structuredClone(body));
            const answer = (body.purpose === 'repair' ? repairs[body.module.id] : undefined) ?? bodies[body.module.id] ?? BODIES[body.module.id];
            const meta = {
                turnId: body.turnId, jobId: body.jobId, purpose: body.purpose, subject: body.subject, versions: body.versions, module: body.module.id,
                interfaceHash: body.module.interface.interfaceHash, generationId: `gen-m${calls.length}`, model: 'm-1', source: 'live', role: 'module', promptVersion: `module.${body.purpose}.v1`,
            };
            onEvent({ type: 'meta', meta });
            const usage = { in: 100, out: 50, reasoning: null, cached: null, costMicroUsd: 1_000 };
            onEvent({ type: 'usage', usage });
            return { status: 'ok', meta, answer, answerSha256: sha(answer), usage };
        },
    };
}

/** A reviser from a script of results (`{ hold }` open until resolved; `{ throws }`); every request recorded. */
function fakeReviser(results) {
    const calls = [];
    const held = [];
    const revise = async (req, signal) => {
        calls.push(structuredClone(req));
        let r = results[Math.min(calls.length, results.length) - 1];
        if (r && r.hold) r = await new Promise((resolve, reject) => { held.push({ resolve }); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
        if (r && r.throws) throw r.throws;
        return r;
    };
    return { calls, held, revise };
}
const handedOff = (nodes, calls = 1) => ({ status: 'handed-off', turnId: `turn-r${calls}`, design: DESIGN, program: { nodes }, repairs: [], calls });

const FULL = { x: 0, y: 0, width: 768, height: 432 };
/** A frame as a world looks: a grey ground, a warm subject, a blue sky; `shade` moves it so frames differ. */
function pixels(shade = 0) {
    const p = new Uint8Array(768 * 432 * 4);
    for (let y = 0; y < 432; y++) for (let x = 0; x < 768; x++) p.set(x > 256 && x < 512 && y > 100 ? [180, 120 + shade, 60, 255] : y > 300 ? [70, 70, 70, 255] : [40, 60, 120, 255], (y * 768 + x) * 4);
    return p;
}
/** The castle as written (bounds.test.mjs): its hill a shell, its camera inside it. */
const CASTLE = { batches: [
    { node: 'batchhill', box: { min: [-234, -54, -234], max: [234, 50, 234] }, instances: 1, sampled: 1 },
    { node: 'batchtower', box: { min: [-7.9, -2.9, -7.9], max: [7.9, 13.9, 7.9] }, instances: 6, sampled: 6 },
    { node: 'batchroof', box: { min: [-8, 6.3, -8], max: [8, 14.7, 8] }, instances: 6, sampled: 6 },
] };
const FRAMED = { target: [0, 5.5, 0], distance: 23, azimuth: 0.6, polar: 1.15, fov: 45 };

/** A capture's answer: two frames of `size` JPEG bytes each, the castle's boxes. */
function captured({ size = 40_000, bounds = CASTLE, tick = 120, shade = 0 } = {}) {
    const frame = (view, i) => {
        const jpeg = new Uint8Array(size);
        jpeg.set([0xff, 0xd8, 0xff, i, shade & 0xff]);
        return {
            view, camera: view === 'framed' ? FRAMED : { ...FRAMED, azimuth: FRAMED.azimuth + Math.PI / 2, polar: Math.PI / 2 }, describes: `the ${view} view`, renderOrdinal: i,
            sourceWidth: 1280, sourceHeight: 720, width: 768, height: 432, content: FULL, rgba: pixels(shade), jpeg, quality: 0.85, sha256: sha(jpeg),
        };
    };
    return {
        outcome: { ok: true, tick, seconds: tick / 60, frames: [frame('framed', 1), frame('side', 2)], missing: [], temporal: [], bounds, boundsError: null, policy: 'ea6-capture.v1' },
        missing: [], framed: FRAMED, aspect: 16 / 9, prepared: null,
    };
}

/**
 * A studio's worth of seams: a candidate session over fake calls, a stage that shows what `install` put there, a capture
 * that answers `next()` (a StageCapture or a promise of one), a device generation, the panel's redraws and drops.
 */
let attempts = 0;
function studio({ reviser = fakeReviser([handedOff(world({ size: 0.5 }))]), modules = fakeModules(), limits = Q_C, capture = () => captured() } = {}) {
    // Attempt ids unique across studios, so one studio's attempt is never mistaken for another's.
    const s = createCandidateSession({ modules, revise: reviser.revise, limits, attemptId: () => `attempt-${++attempts}`, now: () => 1_000 }, () => {});
    const st = { world: null, generation: 1, changes: 0, drops: [], captures: [] };
    const reviews = new StageReviews({
        stage: () => st.world,
        capture: (w, stale) => { st.captures.push({ world: w, stale }); return capture(w, stale); },
        session: () => s,
        generation: () => st.generation,
        onChange: () => { st.changes++; },
        onDrop: ids => st.drops.push(...ids),
    });
    let epochs = 0;
    /** Puts `candidate` on the stage (what Run does), and its review is captured at once. */
    const install = (candidate, graph = 'x-hash') => {
        st.world = { epoch: ++epochs, candidate, graph, gpu: 'Fake GPU', probe: { warnings: [], width: 2022, height: 1137 }, unboxed: [] };
        reviews.installed(st.world);
        return st.world;
    };
    return { s, st, reviews, install, reviser, modules };
}
const settle = () => new Promise(r => setTimeout(r, 10));
const waitFor = async (condition, label) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(condition(), `waited for ${label}`);
};

test('EA-VR3 "Improve it": the creator\'s words and the findings they kept become one program revision citing exactly them; the improved candidate awaits Run', async () => {
    const t = studio();
    const first = await t.s.start(handOff());
    assert.equal(first.phase, 'static-verified');
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const r = t.reviews.latest;
    // The host's look reached the session as render evidence about this very candidate (EA_SCALE and EA_FRAME, the castle's).
    assert.deepEqual(r.host.findings.map(f => f.code), ['EA_SCALE', 'EA_FRAME']);
    const render = t.s.state.evidence.find(e => e.id === r.renderEvidenceId);
    assert.deepEqual([render.phase, render.producedBy, render.verdict, render.subject.candidate, render.findings.map(f => [f.code, f.severity])],
        ['render', 'device', 'fail', first.id, [['EA_SCALE', 'warning'], ['EA_FRAME', 'warning']]]);
    assert.deepEqual(r.hostFindingIds, render.findings.map(f => f.id));
    assert.equal(t.s.state.phase, 'static-verified', 'a render record never moves a technical verdict (P4)');
    // Frames identified: the install, the tick, the views, the bytes' hash.
    assert.deepEqual(r.frames.map(f => [f.id, f.view, f.tick, f.deviceGeneration, f.bytes, f.sha256.length]), [[`${r.id}.v1`, 'framed', 120, 1, 40_000, 64], [`${r.id}.v2`, 'side', 120, 1, 40_000, 64]]);

    // The creator keeps EA_SCALE checked, drops EA_FRAME, and says what they see.
    const words = 'the castle floats above the hill; set the hill\'s size to 1';
    const done = await t.reviews.improve(r.id, `  ${words}  `, [0]);
    assert.deepEqual(done, { ok: true });
    assert.equal(t.reviser.calls.length, 1, 'one revision');
    const rq = t.reviser.calls[0];
    assert.deepEqual([rq.request, rq.design, rq.program.nodes], [R, DESIGN, world()], 'R and S verbatim, the base program');
    const verdict = t.s.state.evidence.find(e => e.phase === 'visual');
    assert.deepEqual([verdict.producedBy, verdict.verdict, verdict.subject.candidate, verdict.refs, verdict.findings.map(f => [f.code, f.message])],
        ['creator', 'fail', first.id, [render.id], [['creator', words]]], 'the creator\'s verdict, their words its finding, on the host\'s look it chose from');
    assert.deepEqual(rq.findings.map(f => [f.id, f.code, f.path, f.message]), [
        [verdict.findings[0].id, 'creator', null, words],
        [render.findings[0].id, 'EA_SCALE', null, render.findings[0].message],
        // The host's own, last: how many notes the attempt can still answer (the independent review of EA6.3).
        ['q_c.repairs', 'EA_REPAIR_BUDGET', null, 'This attempt can still repair 10 module bodies with notes: a plan past that is refused whole, before any of it is done.'],
    ], 'exactly the words and the one finding kept checked');
    const after = t.s.state;
    assert.equal(after.phase, 'static-verified', JSON.stringify(after.stop));
    assert.notEqual(after.id, first.id, 'a new candidate: the cube\'s size moved X');
    assert.deepEqual([after.budget.visualRounds, after.budget.revisions], [1, 1]);
    assert.equal(t.modules.calls.length, 3, 'no module written again: their interfaces held (the castle\'s sizes are the program\'s)');
    assert.deepEqual([r.status, r.improvedTo, r.creator, r.visualEvidenceIds], ['awaiting-run', after.id, 'improve', [verdict.id]]);
    // The world on the stage is still the first candidate's: the improved one reaches it only through Run.
    assert.equal(t.st.world.candidate, first.id);
    assert.match(t.reviews.improvable(r), /^EA_REVIEW_UNAVAILABLE the review is awaiting-run$/);

    // Run puts it on the stage: a new review, bound to it; the old one stays as history.
    const second = t.install(after.id);
    await waitFor(() => t.reviews.latest?.status === 'ready' && t.reviews.latest.epoch === second.epoch, 'the second review');
    assert.equal(t.reviews.latest.attempt, after.attempt);
    assert.equal(t.reviews.records[0].status, 'awaiting-run', 'the first review keeps what came of it');

    // A review of a world no longer on the stage, or from before the device was replaced: refused, no call.
    const old = t.reviews.records[0];
    assert.deepEqual(await t.reviews.improve(old.id, 'again', []), { ok: false, diagnostic: `EA_STALE_EVIDENCE a newer review (${t.reviews.latest.id}) supersedes ${old.id}`, sentence: COPY.review.stale });
    t.st.generation = 2;
    const replaced = await t.reviews.improve(t.reviews.latest.id, 'again', []);
    assert.deepEqual(replaced, { ok: false, diagnostic: 'EA_STALE_EVIDENCE the device was replaced since this review', sentence: COPY.review.stale });
    assert.equal(t.reviser.calls.length, 1, 'no call for either');
});

test('EA-VR3 "Looks right" records the creator\'s pass and spends nothing; an empty improvement, too many findings or too many words are refused before any call', async () => {
    const t = studio();
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const r = t.reviews.latest;
    const spent = structuredClone(t.s.state.budget);
    const refused = async (label, words, chosen, pattern) => {
        const out = await t.reviews.improve(r.id, words, chosen);
        assert.equal(out.ok, false, label);
        assert.match(out.diagnostic, pattern, label);
        assert.equal(t.reviser.calls.length, 0, `${label}: no call`);
        assert.equal(r.status, 'ready', `${label}: the review as it was`);
        assert.equal(t.s.snapshot?.id, first.id, `${label}: the candidate still sealed`);
    };
    await refused('nothing said, nothing chosen', '   ', [], /^an improvement answers the creator's words or a finding they chose: there are neither$/);
    await refused('401 characters', 'x'.repeat(401), [], /^the creator's words are at most 400 characters: these are 401$/);
    await refused('a finding the review never had', 'x', [7], /^EA_STALE_EVIDENCE finding 7 is not one of this review's$/);
    // Over 32 findings: the session refuses past the backend's bound rather than cut it.
    const many = t.s.review({ expected: { attempt: first.attempt, candidate: first.id }, phase: 'render', verdict: 'fail', producedBy: 'device',
        findings: Array.from({ length: 33 }, (_, i) => ({ code: 'EA_SCALE', message: `batch ${i}` })) });
    const over = await t.s.improve({ expected: { attempt: first.attempt, candidate: first.id }, words: '', findings: many.evidence.findings.map(f => f.id) });
    assert.deepEqual(over, { ok: false, diagnostic: 'an improvement cites at most 32 findings, the revision\'s bound: this one cites 33' });
    // A render record is the device's to make, a verdict the creator's or a model's.
    assert.deepEqual(t.s.review({ expected: { attempt: first.attempt, candidate: first.id }, phase: 'render', verdict: 'pass', producedBy: 'creator' }),
        { ok: false, diagnostic: 'a render record is not the creator\'s to make' });
    // Only the host's findings about the stage are chosen: a verdict's own finding is not one of them.
    const said = t.s.visual({ verdict: 'fail', producedBy: 'model', findings: [{ code: 'floating', message: 'it floats' }] });
    assert.deepEqual(await t.s.improve({ expected: { attempt: first.attempt, candidate: first.id }, words: '', findings: [said.findings[0].id] }),
        { ok: false, diagnostic: `${said.findings[0].id} is not one of the host's findings about the stage (visual)` });
    assert.equal(t.reviser.calls.length, 0);
    assert.deepEqual(t.s.state.budget, spent, 'nothing spent');

    // Looks right: recorded as the creator's pass on this candidate; the host's warnings stay as they were.
    assert.deepEqual(t.reviews.looksRight(r.id), { ok: true });
    const pass = t.s.state.evidence.filter(e => e.phase === 'visual').at(-1);
    assert.deepEqual([pass.verdict, pass.producedBy, pass.subject.candidate, r.status, r.creator], ['pass', 'creator', first.id, 'approved', 'looks-right']);
    assert.ok(t.s.state.evidence.some(e => e.id === r.renderEvidenceId && e.verdict === 'fail'), 'the host\'s record not erased');
    assert.deepEqual(t.s.state.budget, spent, 'nothing spent');
    assert.equal(t.reviews.looksRight(r.id).ok, false, 'once');
    // After approving, the creator may still improve it.
    assert.equal(t.reviews.improvable(r), null);
    assert.equal(sentenceOf('EA_TURN_BUDGET calls: 34 of 34'), COPY.review.budget);

    // 32 findings, the words among them: exactly the backend's bound, taken whole.
    const edge = studio();
    const e = await edge.s.start(handOff());
    const host = edge.s.review({ expected: { attempt: e.attempt, candidate: e.id }, phase: 'render', verdict: 'fail', producedBy: 'device',
        findings: Array.from({ length: 31 }, (_, i) => ({ code: 'EA_SCALE', message: `batch ${i}` })) });
    const at32 = await edge.s.improve({ expected: { attempt: e.attempt, candidate: e.id }, words: 'and the camera', findings: host.evidence.findings.map(f => f.id) });
    assert.equal(at32.ok, true, at32.diagnostic);
    assert.equal(edge.reviser.calls[0].findings.length, 32);
});

test('EA-VR5 two rounds, a third refused; the calls and the revisions refuse before anything reopens, the round given back; a dispatched round stays spent', async () => {
    // Two rounds: each a revision, each through Run to a new review.
    const t = studio({ reviser: fakeReviser([handedOff(world({ size: 0.5 })), handedOff(world({ size: 0.25 }))]) });
    let st = await t.s.start(handOff());
    for (let round = 1; round <= 2; round++) {
        t.install(st.id);
        await waitFor(() => t.reviews.latest?.status === 'ready' && t.reviews.latest.candidate === st.id, `review ${round}`);
        const out = await t.reviews.improve(t.reviews.latest.id, `round ${round}`, []);
        assert.equal(out.ok, true, out.diagnostic);
        st = t.s.state;
        assert.deepEqual([st.phase, st.budget.visualRounds, st.budget.revisions], ['static-verified', round, round]);
    }
    t.install(st.id);
    await waitFor(() => t.reviews.latest?.status === 'ready' && t.reviews.latest.candidate === st.id, 'review 3');
    const third = await t.reviews.improve(t.reviews.latest.id, 'round 3', []);
    assert.deepEqual(third, { ok: false, diagnostic: 'EA_REVIEW_BUDGET visual rounds 2 of 2', sentence: COPY.review.budget });
    assert.equal(t.reviser.calls.length, 2, 'no third call');
    assert.equal(t.s.snapshot.id, st.id, 'nothing reopened');

    // The 34 calls: a revision's six do not fit. Refused at the press; the round given back; the candidate as it was.
    const full = studio();
    const c = await full.s.start(handOff(world(), { calls: Array.from({ length: 26 }, (_, i) => ({ ...TURN_CALLS[0], n: i + 1 })) }));
    assert.equal(c.budget.calls.settled, 29, 'the turn\'s 26 and three authors');
    full.install(c.id);
    await waitFor(() => full.reviews.latest?.status === 'ready', 'its review');
    const tight = await full.reviews.improve(full.reviews.latest.id, 'smaller', [0]);
    assert.deepEqual(tight, { ok: false, diagnostic: 'EA_TURN_BUDGET calls: 29 of 34', sentence: COPY.review.budget });
    assert.deepEqual([full.s.state.phase, full.s.snapshot.id, full.s.state.budget.visualRounds, full.s.state.budget.revisions, full.reviser.calls.length], ['static-verified', c.id, 0, 0, 0]);
    // The revisions: one, spent by a technical refusal before; refused the same way.
    const one = studio({ limits: { ...Q_C, revisions: 0 } });
    const d = await one.s.start(handOff());
    one.install(d.id);
    await waitFor(() => one.reviews.latest?.status === 'ready', 'its review');
    assert.equal((await one.reviews.improve(one.reviews.latest.id, 'x', [])).diagnostic, 'EA_TURN_BUDGET revisions: 0 of 0');
    assert.equal(one.s.state.budget.visualRounds, 0, 'the round given back');

    // Dispatched, then the authors run out: the round and the revision stay spent, the Head on the stage; the session goes
    // back to the candidate the round started from, with no call, so another round may follow (the outside review).
    const authors = studio({ reviser: fakeReviser([handedOff(world({ workgroupSize: 32 }))]), limits: { ...Q_C, authors: 3 } });
    const e = await authors.s.start(handOff());
    const stage = authors.install(e.id);
    await waitFor(() => authors.reviews.latest?.status === 'ready', 'its review');
    const r = authors.reviews.latest;
    const moduleCalls = authors.modules.calls.length;
    assert.deepEqual(await authors.reviews.improve(r.id, 'move them in smaller groups', []), { ok: true });
    const ended = authors.s.state;
    assert.deepEqual([ended.phase, ended.id, ended.stop, ended.budget.visualRounds, ended.budget.revisions, ended.budget.authors],
        ['static-verified', e.id, null, 1, 1, 3], 'back on the candidate on the stage, every count where the round left it');
    assert.equal(authors.modules.calls.length, moduleCalls, 'the restore wrote nothing: every body its own');
    assert.equal(ended.turns.at(-1).status, 'handed-off', 'the round\'s revision turn kept in the record');
    assert.deepEqual([r.status, r.improvedTo, r.sentence, r.error], ['not-improved', null, COPY.review.budget,
        'EA_TURN_BUDGET authors: 3 of 3; the session is back on the candidate on the stage']);
    assert.equal(authors.st.world, stage, 'the world on the stage untouched');
    assert.equal(authors.reviews.improvable(r), null, 'the creator may try again, within what is left');
});

test('EA-VR5 a double press makes one call; a revision holds its six calls while it runs; a cancel or an unseen end counts the round and the calls, never zero', async () => {
    const t = studio({ reviser: fakeReviser([{ hold: true }]) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const r = t.reviews.latest;
    const press = t.reviews.improve(r.id, 'lower the hill', [0, 1]);
    const again = await t.reviews.improve(r.id, 'lower the hill', [0, 1]);
    assert.deepEqual(again, { ok: false, diagnostic: 'EA_REVIEW_BUSY an improvement is under way', sentence: COPY.review.improving });
    const direct = await t.s.improve({ expected: { attempt: first.attempt, candidate: first.id }, words: 'twice', findings: [] });
    assert.equal(direct.ok, false, 'the session refuses a second press on its own too');
    await waitFor(() => t.reviser.held.length === 1, 'the held revision');
    assert.equal(t.reviser.calls.length, 1);
    assert.deepEqual(t.s.state.budget.calls, { settled: 6, reserved: 6, unknown: 0 }, 'the turn\'s three, three authors, and the revision\'s six held');
    assert.equal(t.s.state.budget.visualRounds, 1);
    assert.deepEqual([t.s.state.phase, t.s.snapshot], ['correcting', null], 'reopened while its round runs: nothing sealed to Run meanwhile');
    // A cancel while it runs: the round spent, the six counted unknown; the creator's own stop, so no restore.
    t.s.cancel();
    assert.deepEqual(await press, { ok: true });
    assert.deepEqual([t.s.state.phase, t.s.state.budget.calls, t.s.state.budget.visualRounds], ['cancelled', { settled: 6, reserved: 0, unknown: 6 }, 1]);
    assert.equal(r.status, 'not-improved');
    assert.match(t.reviews.improvable(r), /^EA_REVIEW_UNAVAILABLE stage [0-9a-f]{12}…, active revisable session none$/);
    // An unseen end (the stream broke): counted the same, never zero; the session back on the candidate on the stage.
    const broken = studio({ reviser: fakeReviser([{ throws: new Error('the stream was cut') }]) });
    const b = await broken.s.start(handOff());
    broken.install(b.id);
    await waitFor(() => broken.reviews.latest?.status === 'ready', 'its review');
    assert.deepEqual(await broken.reviews.improve(broken.reviews.latest.id, 'x', []), { ok: true });
    assert.deepEqual([broken.s.state.phase, broken.s.state.id, broken.s.state.budget.calls.unknown, broken.s.state.budget.visualRounds], ['static-verified', b.id, 6, 1]);
    assert.equal(broken.reviews.latest.status, 'not-improved');
    assert.match(broken.reviews.latest.error, /^revision: the stream was cut; charge unknown; the session is back on the candidate on the stage$/);
});

test('EA-VR7 the same X with another body is another candidate; a session holding another candidate, or none, records and improves nothing', async () => {
    const t = studio();
    const a = await t.s.start(handOff());
    t.install(a.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the first review');
    // Motion written again, farther: the same program, the same X, another body, another id(C). (A session takes its module
    // client when it is made, so a second session stands for the developer's next write.)
    const t2 = studio({ modules: fakeModules({ motion: FARTHER }) });
    const b = { t2, st: await t2.s.start(handOff()) };
    assert.equal(b.st.graph, a.graph, 'the same X');
    assert.notEqual(b.st.id, a.id, 'another candidate');
    // The stage shows A; the session (t2's) holds B: the review of A reaches no session, and offers no improvement.
    b.t2.st.world = { epoch: 9, candidate: a.id, graph: a.graph, gpu: 'Fake GPU', probe: null, unboxed: [] };
    const r = await b.t2.reviews.capture();
    assert.equal(r.status, 'ready');
    assert.deepEqual([r.attempt, r.renderEvidenceId, r.hostFindingIds], [null, null, []]);
    assert.equal(r.unbound, `the session holds ${b.st.id.slice(0, 12)}…, the stage ${a.id.slice(0, 12)}…`);
    assert.ok(!b.t2.s.state.evidence.some(e => e.phase === 'render'), 'nothing recorded about A in B\'s attempt');
    assert.equal(b.t2.reviews.improvable(r), `EA_REVIEW_UNAVAILABLE stage ${a.id.slice(0, 12)}…, active revisable session ${b.st.id.slice(0, 12)}…`);
    assert.deepEqual(await b.t2.reviews.improve(r.id, 'x', []), { ok: false, diagnostic: b.t2.reviews.improvable(r), sentence: COPY.review.noSession });
    assert.equal(b.t2.reviser.calls.length, 0);
    // The session refuses a record or a round about another candidate on its own: by id(C), never by X's hash.
    const another = `EA_STALE_EVIDENCE expected id(C) ${b.st.id.slice(0, 12)}, the review is about ${a.id.slice(0, 12)}`;
    assert.deepEqual(b.t2.s.review({ expected: { attempt: b.st.attempt, candidate: a.id }, phase: 'visual', verdict: 'pass', producedBy: 'creator' }), { ok: false, diagnostic: another });
    assert.deepEqual(await b.t2.s.improve({ expected: { attempt: b.st.attempt, candidate: a.id }, words: 'lower it', findings: [] }), { ok: false, diagnostic: another });
    assert.deepEqual(await b.t2.s.improve({ expected: { attempt: a.attempt, candidate: b.st.id }, words: 'lower it', findings: [] }),
        { ok: false, diagnostic: `EA_STALE_EVIDENCE expected attempt ${b.st.attempt}, got attempt ${a.attempt}` });
    assert.deepEqual([b.t2.s.state.budget.visualRounds, b.t2.reviser.calls.length], [0, 0]);
    // Looks right on an unbound review: kept with the review alone.
    assert.deepEqual(b.t2.reviews.looksRight(r.id), { ok: true });
    assert.deepEqual([r.creator, r.visualEvidenceIds], ['looks-right', []]);

    // A round that ends asking: the stage keeps the world; the session goes back to it, so the review may be answered again.
    const failed = studio({ reviser: fakeReviser([{ status: 'asked', reason: 'which hill?', calls: 1 }, handedOff(world({ size: 0.5 }))]) });
    const c = await failed.s.start(handOff());
    failed.install(c.id);
    await waitFor(() => failed.reviews.latest?.status === 'ready', 'its review');
    const asked = failed.reviews.latest;
    assert.deepEqual(await failed.reviews.improve(asked.id, 'lower it', []), { ok: true });
    assert.deepEqual([failed.s.state.phase, failed.s.state.id], ['static-verified', c.id]);
    assert.deepEqual([asked.status, asked.sentence], ['not-improved', COPY.review.notApplied], 'said in the review\'s words, not the candidate\'s');
    assert.match(asked.error, /^the program revision ended asked: which hill\?; the session is back on the candidate on the stage$/);
    // The same review answered again: the second round improves it, the two rounds spent.
    assert.deepEqual(await failed.reviews.improve(asked.id, 'lower it onto the hill', []), { ok: true });
    assert.deepEqual([asked.status, asked.improvedTo === failed.s.state.id, failed.s.state.budget.visualRounds], ['awaiting-run', true, 2]);
    const recaptured = await failed.reviews.capture();
    assert.equal(recaptured.unbound, `the session holds ${failed.s.state.id.slice(0, 12)}…, the stage ${c.id.slice(0, 12)}…`, 'until Run puts the improved one there');
});

test('EA-VR7 a capture or a round that resolves after a newer review or install attaches nothing to the newer one', async () => {
    // A capture still reading when another world is installed: discarded, nothing recorded; the new world's review stands.
    let release;
    const slow = new Promise(r => { release = r; });
    let calls = 0;
    const t = studio({ capture: () => (++calls === 1 ? slow : captured({ shade: 9 })) });
    const a = await t.s.start(handOff());
    t.install(a.id);
    await waitFor(() => t.st.captures.length === 1, 'the first capture under way');
    const first = t.reviews.latest;
    t.install(a.id);
    await waitFor(() => t.reviews.latest !== first && t.reviews.latest.status === 'ready', 'the second review');
    assert.equal(t.st.captures[0].stale(), 'a newer review', 'the first capture is told');
    release(captured());
    await settle();
    assert.deepEqual([first.status, first.frames, first.renderEvidenceId, first.error], ['superseded', [], null, 'EA_STOP a newer review: the capture is discarded']);
    assert.equal(t.s.state.evidence.filter(e => e.phase === 'render').length, 1, 'one render record: the newer review\'s');
    assert.equal(t.reviews.latest.renderEvidenceId, t.s.state.evidence.find(e => e.phase === 'render').id);

    // A round under way when the stage is captured again: the round says what came of it, the newer review stays newest
    // and ready, and nothing of the round is pinned on it.
    const held = studio({ reviser: fakeReviser([{ hold: true }]) });
    const c = await held.s.start(handOff());
    held.install(c.id);
    await waitFor(() => held.reviews.latest?.status === 'ready', 'its review');
    const r = held.reviews.latest;
    const press = held.reviews.improve(r.id, 'lower it', []);
    await waitFor(() => held.reviser.held.length === 1, 'the held revision');
    const newer = await held.reviews.capture();
    assert.equal(r.status, 'superseded');
    assert.equal(newer.attempt, null, 'the session is mid-round: the newer review reaches no session');
    held.reviser.held[0].resolve(handedOff(world({ size: 0.5 })));
    assert.deepEqual(await press, { ok: true });
    assert.deepEqual([r.status, typeof r.improvedTo], ['superseded', 'string'], 'the round said where it went, its review still superseded');
    assert.deepEqual([newer.status, newer.visualEvidenceIds, newer.improvedTo], ['ready', [], null]);
    // And the device replaced while a capture reads: discarded.
    let late;
    const gen = studio({ capture: () => new Promise(r => { late = r; }) });
    const g = await gen.s.start(handOff());
    gen.install(g.id);
    await waitFor(() => gen.st.captures.length === 1, 'the capture under way');
    gen.st.generation = 2;
    late(captured());
    await settle();
    assert.deepEqual([gen.reviews.latest.status, gen.reviews.latest.error], ['superseded', 'EA_STOP the device was replaced: the capture is discarded']);
    assert.equal(gen.s.state.evidence.filter(e => e.phase === 'render').length, 0);
});

test('EA-VR9 the newest three reviews keep their JPEGs, at most 1,800,000 bytes; older ones say theirs were dropped, and whatever shows them is told; the history is bounded and counted', async () => {
    const t = studio({ capture: () => captured({ size: 300_000 }) });
    const a = await t.s.start(handOff());
    t.install(a.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the first review');
    for (let i = 0; i < 3; i++) await t.reviews.capture();
    const list = t.reviews.records;
    assert.equal(list.length, 4);
    assert.equal(KEEP_FRAMES * 2 * 300_000, KEPT_BYTES, 'three pairs at the cap fill the bound exactly');
    assert.equal(t.reviews.keptBytes, KEPT_BYTES);
    assert.deepEqual(list.map(r => r.bytesDropped), [true, false, false, false]);
    assert.deepEqual(t.st.drops, list[0].frames.map(f => f.id), 'whatever shows the oldest frames is told to let them go');
    assert.equal(t.reviews.bytesOf(list[0].frames[0].id), null);
    assert.deepEqual(list[0].frames.map(f => [f.bytes, f.sha256.length]), [[300_000, 64], [300_000, 64]], 'its identities and hashes stay');
    assert.ok(t.reviews.bytesOf(list[3].frames[1].id) instanceof Uint8Array);
    // The history: at most REVIEW_HISTORY reviews, the oldest dropped and counted.
    for (let i = 0; i < REVIEW_HISTORY; i++) await t.reviews.capture();
    assert.equal(t.reviews.records.length, REVIEW_HISTORY);
    assert.equal(t.reviews.dropped, 4);
    assert.ok(t.reviews.keptBytes <= KEPT_BYTES);
    assert.equal(t.reviews.records.filter(r => !r.bytesDropped).length, KEEP_FRAMES);
    // Small frames: the count bounds them as well, three reviews and no more.
    const small = studio({ capture: () => captured({ size: 1000 }) });
    const s1 = await small.s.start(handOff());
    small.install(s1.id);
    await waitFor(() => small.reviews.latest?.status === 'ready', 'a small review');
    for (let i = 0; i < 3; i++) await small.reviews.capture();
    assert.deepEqual([small.reviews.records.map(r => r.bytesDropped), small.reviews.keptBytes], [[true, false, false, false], 6000]);
    // A capture refused while the stage is busy: said, nothing made.
    const busy = new StageReviews({ stage: () => t.st.world, capture: () => assert.fail('no capture while busy'), session: () => null, generation: () => 1, busy: () => 'a film is being made', onChange: () => {} });
    assert.equal(await busy.capture(), null);
    assert.deepEqual(busy.refusal, { diagnostic: 'EA_REVIEW_BUSY a film is being made', sentence: COPY.review.busy });
});

// EA-VR4, the round's half (EA6.3; visual-review-design.md §8.2, Q111 (a)): the castle floated because the code that
// places it is a module's, which a program revision cannot reach. Its revision's note now does.
test('EA-VR4f the castle\'s float: a round whose revision notes the module that places the blocks repairs that body, and the improved candidate awaits Run; a plan naming a part the program lacks applies nothing', async () => {
    const note = 'Lower every block by 2 units, so the castle stands on the hill.';
    const t = studio({ reviser: fakeReviser([{ ...handedOff(world()), repairs: [{ module: 'motion', message: note }] }]), modules: fakeModules({}, { motion: FARTHER }) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const r = t.reviews.latest;
    assert.deepEqual(await t.reviews.improve(r.id, 'the castle floats above the hill', []), { ok: true });
    const after = t.s.state;
    assert.equal(after.phase, 'static-verified', JSON.stringify(after.stop));
    assert.equal(after.programHash, first.programHash, 'the program as it was');
    assert.notEqual(after.id, first.id, 'a new candidate: the body that places the blocks');
    assert.deepEqual(t.modules.calls.slice(3).map(c => [c.module.id, c.purpose, c.previous?.findings.map(f => f.code)]), [['motion', 'repair', [NOTE_CODE]]]);
    assert.match(t.modules.calls[3].previous.findings[0].message, /Lower every block by 2 units/);
    assert.deepEqual([r.status, r.improvedTo], ['awaiting-run', after.id]);
    const verdict = after.evidence.find(e => e.phase === 'visual' && e.producedBy === 'creator');
    const noted = after.evidence.find(e => e.findings.some(f => f.code === NOTE_CODE));
    assert.deepEqual([noted.producedBy, noted.verdict, noted.refs, noted.subject.module], ['model', 'unverified', [verdict.id], 'motion']);
    assert.deepEqual(r.visualEvidenceIds, [verdict.id], 'the note is the model\'s instruction, not the creator\'s verdict');

    // A plan naming a part the program lacks: nothing of it applied, no call, the session back on the stage's candidate.
    const u = studio({ reviser: fakeReviser([{ ...handedOff(world()), repairs: [{ module: 'tower', message: 'Lower it.' }] }]) });
    const start = await u.s.start(handOff());
    u.install(start.id);
    await waitFor(() => u.reviews.latest?.status === 'ready', 'the review');
    const v = u.reviews.latest;
    assert.deepEqual(await u.reviews.improve(v.id, 'the castle floats', []), { ok: true });
    assert.equal(v.status, 'not-improved');
    assert.match(v.error, /^EA_RESOLVE moduleRepairs\[0\]: tower is not a module of the revised program; plan refused; the session is back on the candidate on the stage$/);
    assert.equal(v.sentence, COPY.review.notApplied);
    assert.equal(u.modules.calls.length, 3, 'no call after the revision');
    assert.equal(u.s.snapshot?.id, start.id, 'the stage\'s candidate is the session\'s again');
});

test('EA-VR4g a round whose revised program the browser refuses, with no revision left to answer it, drops its notes with it: the restore applies none', async () => {
    const bad = world();
    bad[1] = node('field', 'ng.buffer.storage', { elements: 0, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' });
    const t = studio({ reviser: fakeReviser([{ ...handedOff(bad), repairs: [{ module: 'sky', message: 'Darken the sky.' }] }]), limits: { ...Q_C, revisions: 1 } });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const r = t.reviews.latest;
    assert.deepEqual(await t.reviews.improve(r.id, 'the sky is too bright', []), { ok: true });
    assert.equal(r.status, 'not-improved');
    assert.equal(r.error, 'EA_TURN_BUDGET revisions: 1 of 1; the session is back on the candidate on the stage');
    assert.equal(r.sentence, COPY.review.budget);
    assert.equal(t.modules.calls.length, 3, 'no repair: the notes went with the program the browser refused');
    assert.equal(t.s.snapshot?.id, first.id, 'the stage\'s candidate, with its own bodies');
    assert.equal(t.s.state.evidence.filter(e => e.findings.some(f => f.code === NOTE_CODE)).length, 0);
});
