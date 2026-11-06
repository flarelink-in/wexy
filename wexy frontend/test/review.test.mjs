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
//   EA-VR6 (EA6.4) a model's review refuses before any call while a gate is unverified, the terms are unread, this build
//          holds no disclosure for their policy, or the creator has not consented to that provider, model and policy
//   EA6.4  "Review with AI": one call carrying the frames, R, S and the findings kept; its verdict E_v by the model; its
//          issues chosen into "Improve it"; three an attempt; a late answer pinned on nothing newer; refusals said
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NOTE_CODE, createCandidateSession } from '../src/loop/candidate.ts';
import { Q_C } from '../src/loop/candidate-ledger.ts';
import { COPY } from '../src/loop/copy.ts';
import { CONSENT_KEY, KEEP_FRAMES, KEPT_BYTES, REVIEW_HISTORY, StageReviews, memoryConsent, sentenceOf, storedConsent, termsKey } from '../src/loop/review.ts';
import { ERROR_STATUS, ForgeError } from '../src/forge-client/errors.ts';
import { candidateBundle } from '../src/loop/candidate.ts';

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
function studio({ reviser = fakeReviser([handedOff(world({ size: 0.5 }))]), modules = fakeModules(), limits = Q_C, capture = () => captured(), reviewer = null,
    consent = memoryConsent(), revisable = true } = {}) {
    // Attempt ids unique across studios, so one studio's attempt is never mistaken for another's.
    const s = createCandidateSession({ modules, revise: revisable ? reviser.revise : undefined, limits, attemptId: () => `attempt-${++attempts}`, now: () => 1_000 }, () => {});
    /** `busy`: why the stage cannot be captured now (a Run, a film), or null. */
    /** `paid`: why the paid actions wait (a new world being made, a world written for its go), or null. */
    const st = { world: null, generation: 1, changes: 0, drops: [], captures: [], busy: null, paid: null, limits: [] };
    const reviews = new StageReviews({
        stage: () => st.world,
        capture: (w, stale) => { st.captures.push({ world: w, stale }); return capture(w, stale); },
        session: () => s,
        generation: () => st.generation,
        busy: () => st.busy,
        paidBusy: () => st.paid,
        reviewer: () => reviewer,
        consent,
        onChange: () => { st.changes++; },
        onDrop: ids => st.drops.push(...ids),
        limit: (kind, sentence) => st.limits.push({ kind, sentence }),
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
    // Only the host's findings and (EA6.4) a model's issues about the stage are chosen: the creator's own verdict's
    // finding is not one of them; it is what "Improve it" records.
    const said = t.s.review({ expected: { attempt: first.attempt, candidate: first.id }, phase: 'visual', verdict: 'fail', producedBy: 'creator',
        findings: [{ code: 'creator', message: 'it floats' }] });
    assert.deepEqual(await t.s.improve({ expected: { attempt: first.attempt, candidate: first.id }, words: '', findings: [said.evidence.findings[0].id] }),
        { ok: false, diagnostic: `${said.evidence.findings[0].id} is not one of the host's or a model's findings about the stage (visual)` });
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

/** The backend's terms with every gate verified (its ReviewRoutesTest's open terms), or with `gate` the first one shut. */
function terms(gate = null, over = {}) {
    const gates = { images: 'verified', transport: 'verified', privacy: 'verified', metering: 'verified' };
    if (gate) for (const g of ['images', 'transport', 'privacy', 'metering'].slice(['images', 'transport', 'privacy', 'metering'].indexOf(gate))) gates[g] = 'unverified';
    return {
        available: gate === null, gate, gates, provider: 'meta', model: 'muse-spark-1.3', mode: 'standard', policyVersion: 'meta-standard.2026-11-03',
        limits: { frames: 2, width: 768, height: 432, jpegBytes: 300_000, pairBytes: 600_000, requestBytes: 1_048_576, findings: 32, modules: 12 }, ...over,
    };
}
const FLOAT = { kind: 'floating', severity: 'error', sentence: 'The castle floats above the hill in the side view.', scope: 'modules', modules: ['motion'] };
const SCALE = { kind: 'scale', severity: 'warning', sentence: 'The hill dwarfs the castle.', scope: 'program', modules: [] };
/** What the review client returns for `body`: the echo of what was sent, a verdict, a usage. */
const answerFor = (body, verdict = { verdict: 'fail', issues: [{ n: 1, ...FLOAT }, { n: 2, ...SCALE }] }) => ({
    reviewId: body.reviewId, generationId: '01JBZ6Q3G8XW0Y4N6R2T5V7K9M', model: 'muse-spark-1.3', source: 'live', role: 'review', promptVersion: 'review.v1',
    subject: { ...body.subject }, frames: body.frames.map(f => ({ id: f.id, sha256: f.sha256 })), verdict, usage: { in: 3100, out: 420, reasoning: 300, cached: null, costMicroUsd: 5660 },
});
/** A model's review over a fake transport: its terms, and each call's answer from `answer` (`{ hold: true }` open until released). */
function fakeReviewer({ termsAre = terms(), answer = body => answerFor(body), hold = false } = {}) {
    const calls = [];
    const held = [];
    /** Each call's signal: what the transport would watch while it waits for its identity and App Check token. */
    const signals = [];
    const r = {
        calls, held, signals, termsAre, termsRead: 0,
        async terms() {
            r.termsRead++;
            if (r.termsAre instanceof Error) throw r.termsAre;
            return structuredClone(r.termsAre);
        },
        async review(body, limits, signal) {
            calls.push(structuredClone(body));
            signals.push(signal);
            if (hold) await new Promise((resolve, reject) => { held.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
            const a = answer(body);
            if (a instanceof Error) throw a;
            return a;
        },
    };
    return r;
}
/** A studio with a reviewer, its first candidate on the stage, reviewed and bound; its terms read. */
async function reviewed(options = {}) {
    const t = studio(options);
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    await t.reviews.loadTerms();
    return { ...t, first, r: t.reviews.latest };
}

test('EA-VR6 a model\'s review is refused before any call while a gate is unverified, the terms are unread, the policy has no disclosure here, or the creator has not consented', { timeout: 20_000 }, async () => {
    const reviewer = fakeReviewer({ termsAre: terms('images') });
    const t = await reviewed({ reviewer });
    const spent = structuredClone(t.s.state.budget);
    const refused = async (label, pattern, sentence) => {
        const out = await t.reviews.aiReview(t.r.id, [0, 1]);
        assert.equal(out.ok, false, label);
        assert.match(out.diagnostic, pattern, label);
        assert.equal(out.sentence, sentence, label);
        assert.equal(reviewer.calls.length, 0, `${label}: no call`);
        assert.deepEqual(t.s.state.budget, spent, `${label}: nothing spent`);
        assert.equal(t.r.status, 'ready', `${label}: the review as it was`);
    };
    // Each gate, in order: the first unverified is the one named.
    for (const gate of ['images', 'transport', 'privacy', 'metering']) {
        reviewer.termsAre = terms(gate);
        await t.reviews.loadTerms();
        await refused(gate, new RegExp(`^EA_VISION_UNAVAILABLE ${gate}: `), COPY.review.aiUnavailable);
        assert.equal(t.reviews.giveConsent().ok, false, `${gate}: no consent to a shut review`);
    }
    // The terms unread: a backend that did not answer is not a verified one.
    reviewer.termsAre = new ForgeError('unavailable', 503, 'The backend did not answer.');
    await t.reviews.loadTerms();
    await refused('terms unread', /^EA_VISION_UNAVAILABLE terms: unavailable: The backend did not answer\.$/, COPY.review.aiUnavailable);
    // A policy this build has no words for: nothing to consent to, so nothing is sent.
    reviewer.termsAre = terms(null, { policyVersion: 'meta-standard.2027-01-01' });
    await t.reviews.loadTerms();
    await refused('an unknown policy', /^EA_VISION_UNAVAILABLE privacy: this build holds no disclosure for policy meta-standard\.2027-01-01$/, COPY.review.aiUnavailable);
    // Every gate verified, no consent yet: asked first.
    reviewer.termsAre = terms();
    await t.reviews.loadTerms();
    await refused('no consent', /^EA_REVIEW_CONSENT the creator has not allowed review by meta's muse-spark-1\.3 under policy meta-standard\.2026-11-03$/, COPY.review.aiConsent);
    // Consent binds to the provider, the model and the policy: a change asks again; a withdrawal stops it.
    assert.deepEqual(t.reviews.giveConsent(), { ok: true });
    assert.deepEqual(t.reviews.consent, { provider: 'meta', model: 'muse-spark-1.3', policyVersion: 'meta-standard.2026-11-03' });
    assert.equal(t.reviews.aiReviewable(t.r), null);
    reviewer.termsAre = terms(null, { model: 'muse-spark-1.4' });
    await t.reviews.loadTerms();
    assert.equal(t.reviews.consent, null, 'another model: asked again');
    await refused('another model', /^EA_REVIEW_CONSENT /, COPY.review.aiConsent);
    // Whatever this browser holds can still be withdrawn while the terms differ (the independent review of EA6.4).
    assert.deepEqual(t.reviews.heldConsent, { provider: 'meta', model: 'muse-spark-1.3', policyVersion: 'meta-standard.2026-11-03' }, 'held, to the old terms');
    // Contributor mode, or another provider, under words written for Meta's Standard mode: what they say would be untrue
    // there, so the review stays shut and there is nothing to consent to (the independent review of EA6.4, both halves).
    reviewer.termsAre = terms(null, { model: 'muse-spark-1.3-contributor', mode: 'contributor' });
    await t.reviews.loadTerms();
    await refused('contributor mode', /^EA_VISION_UNAVAILABLE privacy: the disclosure for policy meta-standard\.2026-11-03 is for meta's standard mode, not meta's contributor mode$/,
        COPY.review.aiUnavailable);
    assert.equal(t.reviews.giveConsent().ok, false, 'contributor mode: nothing to consent to');
    reviewer.termsAre = terms(null, { provider: 'another' });
    await t.reviews.loadTerms();
    await refused('another provider', /^EA_VISION_UNAVAILABLE privacy: .*, not another's standard mode$/, COPY.review.aiUnavailable);
    reviewer.termsAre = terms();
    await t.reviews.loadTerms();
    assert.notEqual(t.reviews.consent, null, 'the same terms again: the consent holds');
    // "Allow" takes only the terms whose disclosure was on screen: terms that moved since are read again first.
    t.reviews.withdrawConsent();
    assert.equal(t.reviews.heldConsent, null);
    const shown = termsKey(t.reviews.terms);
    reviewer.termsAre = terms(null, { model: 'muse-spark-1.4' });
    await t.reviews.loadTerms();
    const moved = t.reviews.giveConsent(shown);
    assert.deepEqual([moved.ok, moved.diagnostic, moved.sentence], [false, 'EA_REVIEW_CONSENT the terms moved after they were shown: read them again', COPY.review.aiConsent]);
    assert.equal(t.reviews.heldConsent, null, 'nothing taken');
    assert.deepEqual(t.reviews.giveConsent(termsKey(t.reviews.terms)), { ok: true });
    assert.equal(t.reviews.heldConsent.model, 'muse-spark-1.4', 'the terms read');
    reviewer.termsAre = terms();
    await t.reviews.loadTerms();
    t.reviews.giveConsent();
    // A new policy version this build has words for: the consent to the old one does not carry over.
    COPY.disclosures['meta-standard.2099-01-01'] = COPY.disclosures['meta-standard.2026-11-03'];
    try {
        reviewer.termsAre = terms(null, { policyVersion: 'meta-standard.2099-01-01' });
        await t.reviews.loadTerms();
        assert.equal(t.reviews.consent, null, 'another policy: asked again');
        await refused('another policy', /^EA_REVIEW_CONSENT .* under policy meta-standard\.2099-01-01$/, COPY.review.aiConsent);
    } finally {
        delete COPY.disclosures['meta-standard.2099-01-01'];
    }
    reviewer.termsAre = terms();
    await t.reviews.loadTerms();
    t.reviews.withdrawConsent();
    await refused('withdrawn', /^EA_REVIEW_CONSENT /, COPY.review.aiConsent);
    // No backend at all.
    const none = await reviewed();
    assert.match(none.reviews.aiReviewable(none.r), /^EA_VISION_UNAVAILABLE backend: /);
});

test('EA6.4 "Review with AI": one call with the frames, R, S and the findings kept; its verdict E_v by the model; its issues chosen into "Improve it"', { timeout: 20_000 }, async () => {
    const reviewer = fakeReviewer();
    const t = await reviewed({ reviewer });
    t.reviews.giveConsent();
    const before = structuredClone(t.s.state.budget);
    // The session holds a review to the host's findings about this very candidate: the creator's own words, or an id it
    // never made, are refused before any call.
    const expected = { attempt: t.first.attempt, candidate: t.first.id };
    const theirs = t.s.review({ expected, phase: 'visual', verdict: 'fail', producedBy: 'creator', findings: [{ code: 'creator', message: 'it floats' }] });
    for (const id of [theirs.evidence.findings[0].id, 'ev-404.f1']) {
        const direct = await t.s.modelReview({ expected, reviewId: 'review-x', findings: [id], run: async () => { throw new Error('never called'); } });
        assert.equal(direct.ok, false, id);
        assert.match(direct.diagnostic, /^EA_STALE_EVIDENCE expected a finding of the host's about id\(C\) /, id);
        assert.equal(direct.dispatched, false, id);
    }
    assert.deepEqual(t.s.state.budget, before, 'nothing reserved');
    // The creator keeps EA_SCALE checked, drops EA_FRAME.
    assert.deepEqual(await t.reviews.aiReview(t.r.id, [0]), { ok: true });
    assert.equal(reviewer.calls.length, 1, 'one call');
    const body = reviewer.calls[0];
    const st = t.s.state;
    assert.deepEqual([body.reviewId, body.turnId, body.request, body.design], [t.r.id, 'turn-1', R, DESIGN], 'R and S verbatim, the candidate\'s turn');
    assert.deepEqual(body.subject, { attempt: st.attempt, revision: st.revision, programHash: st.programHash, graph: st.graph, candidate: t.first.id, module: null, interfaceHash: null, codeHash: null });
    assert.deepEqual(body.modules, t.s.snapshot.bodies.map(b => b.module));
    assert.deepEqual(body.frames.map(f => [f.id, f.view, f.tick, f.width, f.height, f.sha256]), t.r.frames.map(f => [f.id, f.view, f.tick, 768, 432, f.sha256]));
    assert.equal(Buffer.from(body.frames[0].jpeg, 'base64').equals(Buffer.from(t.reviews.bytesOf(t.r.frames[0].id))), true, 'the kept JPEG, as base64');
    assert.deepEqual(body.hostFindings.map(f => f.code), ['EA_SCALE'], 'only the finding kept checked');
    assert.deepEqual(body.consent, { provider: 'meta', model: 'muse-spark-1.3', policyVersion: 'meta-standard.2026-11-03' });

    // Counted: one call of the 34, one review of the three, settled known.
    const after = t.s.state.budget;
    assert.deepEqual([after.reviews, after.calls.settled - before.calls.settled, after.calls.unknown], [1, 1, 0]);
    const call = t.s.state.reviews.at(-1);
    assert.deepEqual([call.reviewId, call.candidate, call.status, call.charge, call.costMicroUsd, call.promptVersion], [t.r.id, t.first.id, 'ok', 'known', 5660, 'review.v1']);
    // The verdict: E_v by the model about this very candidate, on the host's look it carried; never a technical verdict.
    const ev = t.s.state.evidence.find(e => e.producedBy === 'model' && e.phase === 'visual');
    assert.deepEqual([ev.verdict, ev.subject.candidate, ev.refs, ev.findings.map(f => [f.code, f.severity])],
        ['fail', t.first.id, [t.r.renderEvidenceId], [['floating', 'error'], ['scale', 'warning']]]);
    assert.equal(ev.findings[0].message, 'The castle floats above the hill in the side view. (suggested: modules, motion)');
    assert.equal(t.s.state.phase, 'static-verified', 'P4: a visual verdict moves no technical one');
    assert.deepEqual([t.r.model.verdict, t.r.model.issues.length, t.r.model.sent, t.r.modelFindingIds], ['fail', 2, ['EA_SCALE'], ev.findings.map(f => f.id)]);
    assert.ok(t.r.visualEvidenceIds.includes(ev.id));
    assert.equal(t.r.status, 'ready', 'the review answerable again');
    assert.match(t.reviews.budget(), /AI reviews 1 of 3$/);
    // The bundle lists the call, with its template.
    const bundle = candidateBundle(t.s.state);
    assert.deepEqual(bundle.calls.reviews.map(r => [r.reviewId, r.status, r.charge]), [[t.r.id, 'ok', 'known']]);
    assert.ok(bundle.versions.templates.includes('review.v1'));

    // "Improve it" with the model's floating issue alone: one revision citing exactly it.
    assert.deepEqual(await t.reviews.improve(t.r.id, '', [], [0]), { ok: true });
    const rq = t.reviser.calls[0];
    assert.deepEqual(rq.findings.filter(f => f.code !== 'EA_REPAIR_BUDGET').map(f => [f.id, f.code, f.message]), [[ev.findings[0].id, 'floating', ev.findings[0].message]]);
    const creator = t.s.state.evidence.filter(e => e.producedBy === 'creator').at(-1);
    assert.deepEqual(creator.refs, [ev.id], 'the creator\'s verdict stands on the model\'s record it chose from');
    assert.equal(t.r.status, 'awaiting-run');
});

test('EA6.4 a review in flight blocks every other paid action; three an attempt; a late answer is pinned on nothing newer and stays counted', { timeout: 20_000 }, async () => {
    const reviewer = fakeReviewer({ hold: true });
    const t = await reviewed({ reviewer });
    t.reviews.giveConsent();
    const pending = t.reviews.aiReview(t.r.id, [0, 1]);
    await waitFor(() => reviewer.held.length === 1, 'the call');
    assert.equal(t.r.status, 'reviewing');
    // A double press, "Improve it" and the session's own correction all wait for it; nothing more is spent.
    assert.deepEqual(await t.reviews.aiReview(t.r.id, []), { ok: false, diagnostic: 'EA_REVIEW_BUSY a model\'s review is under way', sentence: COPY.review.aiBusy });
    assert.match((await t.reviews.improve(t.r.id, 'smaller hill', [])).diagnostic, /^EA_REVIEW_BUSY a model's review is under way$/);
    assert.match((await t.s.improve({ expected: { attempt: t.first.attempt, candidate: t.first.id }, words: 'x', findings: [] })).diagnostic, /^EA_REVIEW_BUSY /);
    assert.equal(reviewer.calls.length, 1);
    assert.equal(t.reviser.calls.length, 0);
    assert.equal(t.s.state.budget.calls.reserved, 1, 'the call held while it runs');
    // The stage captured again meanwhile: a newer review of the same candidate. The answer for the superseded one is
    // discarded (§9, the outside review of EA6.4): no verdict recorded, none attached; its call still counted, known.
    const settled = t.s.state.budget.calls.settled;
    await t.reviews.capture();
    const newer = t.reviews.latest;
    assert.notEqual(newer, t.r);
    held(reviewer);
    const discarded = await pending;
    assert.equal(discarded.ok, false);
    assert.equal(discarded.diagnostic, `EA_STALE_EVIDENCE a newer review (${newer.id}) supersedes ${t.r.id}: its answer is discarded`);
    assert.equal(discarded.sentence, COPY.review.stale);
    assert.deepEqual([t.r.model, t.r.modelFindingIds, newer.model, newer.modelFindingIds], [null, [], null, []], 'attached to neither review');
    assert.equal(t.s.state.evidence.some(e => e.producedBy === 'model'), false, 'no model verdict recorded');
    const call = t.s.state.reviews.at(-1);
    assert.deepEqual([call.reviewId, call.status, call.charge, t.s.state.budget.reviews, t.s.state.budget.calls.settled], [t.r.id, 'stale', 'known', 1, settled + 1]);
    assert.equal(t.r.status, 'superseded');
    // The newer one is the one a model may review now: the second and third reviews run, a fourth refuses before its call.
    for (let i = 0; i < 2; i++) {
        const p = t.reviews.aiReview(t.reviews.latest.id, []);
        await waitFor(() => reviewer.held.length === 1, `review ${i + 2}`);
        held(reviewer);
        assert.deepEqual(await p, { ok: true });
    }
    const fourth = await t.reviews.aiReview(t.reviews.latest.id, []);
    assert.deepEqual(fourth, { ok: false, diagnostic: 'EA_TURN_BUDGET reviews: 3 of 3', sentence: COPY.review.budget });
    assert.equal(reviewer.calls.length, 3);
    assert.deepEqual([t.s.state.budget.reviews, t.s.state.budget.calls.reserved], [3, 0]);

    // A new attempt while a review runs: the call is aborted, counted unknown in its attempt, and nothing recorded.
    const u = await reviewed({ reviewer: fakeReviewer({ hold: true }) });
    u.reviews.giveConsent();
    const late = u.reviews.aiReview(u.r.id, []);
    await waitFor(() => u.s.state.reviews.length === 1, 'the call');
    const old = u.s.state;
    void u.s.start(handOff());
    const out = await late;
    assert.equal(out.ok, false);
    assert.match(out.diagnostic, /^EA_STALE_EVIDENCE the attempt ended while the review ran: /);
    assert.equal(out.sentence, COPY.review.stale);
    assert.deepEqual([old.reviews[0].status, old.budget.reviews], ['running', 1], 'the call went out in the attempt that ended');
    const closed = old.reviews[0].reviewId;
    assert.equal(closed, u.r.id);
    assert.equal(u.r.model, null, 'no verdict pinned on anything');

    // An answer that ignores its cancel and lands after its attempt ended: counted, its verdict pinned on nothing.
    const deafCalls = [];
    let land = () => {};
    const deaf = {
        terms: async () => terms(),
        async review(body) {
            deafCalls.push(body);
            await new Promise(resolve => { land = resolve; });
            return answerFor(body);
        },
    };
    const v = await reviewed({ reviewer: deaf });
    v.reviews.giveConsent();
    const lateAnswer = v.reviews.aiReview(v.r.id, []);
    await waitFor(() => deafCalls.length === 1, 'the deaf call');
    const ended = v.s.state;
    void v.s.start(handOff());
    land();
    const landed = await lateAnswer;
    assert.equal(landed.ok, false);
    assert.match(landed.diagnostic, /^EA_STALE_EVIDENCE the attempt ended while the review ran$/);
    assert.equal(v.r.model, null, 'the late verdict is pinned on nothing');
    assert.equal(ended.reviews[0].reviewId, v.r.id);
    assert.equal(v.s.state.evidence.some(e => e.producedBy === 'model'), false, 'the new attempt holds no model verdict');
});

/** Releases the reviewer's held call. */
function held(reviewer) {
    reviewer.held.shift()();
}

test('EA6.4 a refusal, an invalid answer or frames past the limits are said, counted when a call went out, and record nothing', { timeout: 20_000 }, async () => {
    // The backend refused (W1: the prompt's reviews spent): counted unknown, said as the AI's failure, nothing recorded.
    const refusing = fakeReviewer({ answer: () => new ForgeError('rate', 429, 'This prompt has made all of its reviews.') });
    const a = await reviewed({ reviewer: refusing });
    a.reviews.giveConsent();
    const out = await a.reviews.aiReview(a.r.id, []);
    assert.deepEqual(out, { ok: false, diagnostic: 'EA_REVIEW_FAILED rate: This prompt has made all of its reviews.', sentence: COPY.review.aiFailed });
    assert.deepEqual([a.s.state.budget.reviews, a.s.state.budget.calls.unknown, a.s.state.reviews[0].status], [1, 1, 'refused']);
    assert.equal(a.s.state.evidence.some(e => e.producedBy === 'model'), false);
    assert.equal(a.r.status, 'ready');
    // A gate the server says is shut after all: said as unavailable.
    const shut = fakeReviewer({ answer: () => new ForgeError('unavailable', 503, 'EA_VISION_UNAVAILABLE metering: no bound') });
    const b = await reviewed({ reviewer: shut });
    b.reviews.giveConsent();
    assert.equal((await b.reviews.aiReview(b.r.id, [])).sentence, COPY.review.aiUnavailable);
    // An answer the client could not hold to what was sent: never a pass.
    const invalid = fakeReviewer({ answer: () => new Error('EA_REVIEW_INVALID verdict: a pass with 2 issues; review review-1') });
    const c = await reviewed({ reviewer: invalid });
    c.reviews.giveConsent();
    const bad = await c.reviews.aiReview(c.r.id, []);
    assert.deepEqual([bad.ok, bad.sentence, c.s.state.reviews[0].status], [false, COPY.review.aiInvalid, 'invalid']);
    assert.equal(c.r.model, null);
    // Frames past the terms' limits: refused here, before any call or reservation.
    const big = fakeReviewer();
    const d = await reviewed({ reviewer: big, capture: () => captured({ size: 300_001 }) });
    d.reviews.giveConsent();
    const size = await d.reviews.aiReview(d.r.id, []);
    assert.deepEqual(size, { ok: false, diagnostic: 'EA_REVIEW_SIZE frames[0].jpeg: 300001 exceeds 300000 bytes', sentence: COPY.review.tooLarge });
    assert.deepEqual([big.calls.length, d.s.state.budget.reviews], [0, 0]);
    // The newest review's JPEGs dropped by the session's own bound (frames past it): nothing to send, capture again.
    const huge = await reviewed({ reviewer: fakeReviewer(), capture: () => captured({ size: 1_000_000 }) });
    huge.reviews.giveConsent();
    assert.equal(huge.r.bytesDropped, true);
    assert.deepEqual(await huge.reviews.aiReview(huge.r.id, []), {
        ok: false, diagnostic: 'EA_REVIEW_DROPPED the frames\' JPEGs are no longer kept: capture the world again', sentence: COPY.review.aiDropped,
    });
    // A review whose JPEGs the bound dropped cannot be sent: capture again.
    const e = await reviewed({ reviewer: fakeReviewer() });
    e.reviews.giveConsent();
    const first = e.r;
    for (let i = 0; i < KEEP_FRAMES; i++) await e.reviews.capture();
    assert.equal(first.bytesDropped, true);
    assert.match(e.reviews.aiReviewable(first), /^EA_STALE_EVIDENCE a newer review/);
    assert.equal(sentenceOf('EA_REVIEW_DROPPED the frames\' JPEGs are no longer kept: capture the world again'), COPY.review.aiDropped);
});

test('EA-VR9b the bundle holds this attempt\'s reviews newest first, at most 600,000 JPEG bytes, each the bytes its hash names; every frame left out said', { timeout: 20_000 }, async () => {
    const t = studio({ capture: () => captured({ size: 250_000 }) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the first review');
    for (let i = 0; i < 3; i++) await t.reviews.capture();
    // Four reviews of 500,000 bytes each: the session keeps the newest three's JPEGs (1,500,000 bytes), the bundle 600,000.
    const b = t.reviews.bundled(first.attempt);
    assert.deepEqual(b.records.map(r => r.id), ['review-4', 'review-3', 'review-2', 'review-1'], 'newest first');
    assert.deepEqual(b.records.map(r => r.frames.map(f => f.jpeg === null ? null : Buffer.from(f.jpeg, 'base64').length)),
        [[250_000, 250_000], [null, null], [null, null], [null, null]]);
    assert.equal(b.jpegBytes, 500_000);
    assert.ok(b.jpegBytes <= b.bound && b.bound === 600_000);
    for (const f of b.records[0].frames) assert.equal(sha(Buffer.from(f.jpeg, 'base64')), f.sha256, 'the bytes its hash names');
    assert.deepEqual(b.omitted.map(o => [o.review, o.why.startsWith('the bundle holds at most 600000') ? 'bound' : o.why.startsWith('its bytes were dropped') ? 'dropped' : o.why]),
        [['review-3', 'bound'], ['review-3', 'bound'], ['review-2', 'bound'], ['review-2', 'bound'], ['review-1', 'dropped'], ['review-1', 'dropped']]);
    // What was judged stays whole beside its bytes: the host's look, its evidence, its frames' identities.
    assert.deepEqual(b.records[3].host.findings.map(f => f.code), ['EA_SCALE', 'EA_FRAME']);
    assert.equal(b.records[3].frames[0].sha256, t.reviews.records[0].frames[0].sha256);
    // Another attempt's reviews are not this one's.
    assert.deepEqual(t.reviews.bundled('attempt-elsewhere'), { records: [], jpegBytes: 0, bound: 600_000, omitted: [] });
    // In the bundle as Developer view downloads it.
    const bundle = candidateBundle(t.s.state, b);
    assert.equal(bundle.format, 'wexy-candidate-bundle.v3');
    assert.equal(bundle.reviews.records.length, 4);
});

test('EA-VR6b the consent is the shared storage\'s: withdrawn in another tab, cleared or unreadable, it is none; only a storage that will not keep it leaves it to the page', { timeout: 20_000 }, async () => {
    // Two tabs over one storage (the outside review of EA6.4, finding 1: a tab fell back on its own memory of a consent).
    const shared = new Map();
    const storage = { getItem: k => (shared.has(k) ? shared.get(k) : null), setItem: (k, v) => { shared.set(k, String(v)); }, removeItem: k => { shared.delete(k); } };
    const consent = { provider: 'meta', model: 'muse-spark-1.3', policyVersion: 'meta-standard.2026-11-03' };
    const a = storedConsent(() => storage);
    const b = storedConsent(() => storage);
    a.write(consent);
    assert.deepEqual(b.read(), consent, 'given in one tab, held in the other');
    b.write(null);
    assert.equal(a.read(), null, 'withdrawn in the other tab: none in this one');
    a.write(consent);
    shared.clear();
    assert.equal(a.read(), null, 'the site\'s data cleared: none');
    shared.set(CONSENT_KEY, '{not json');
    assert.equal(a.read(), null, 'an entry that does not parse: none');
    shared.set(CONSENT_KEY, JSON.stringify({ provider: 'meta' }));
    assert.equal(a.read(), null, 'an entry that is not a consent: none');
    // A storage that refuses everything: the page keeps its own word, its withdrawal included.
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const c = storedConsent(() => refusing);
    assert.equal(c.read(), null);
    c.write(consent);
    assert.deepEqual(c.read(), consent, 'kept for this page');
    c.write(null);
    assert.equal(c.read(), null);
    // A storage that reads but will not write, over an entry it holds: this page's withdrawal still withdraws here.
    shared.set(CONSENT_KEY, JSON.stringify({ ...consent, at: '2026-11-03T00:00:00Z' }));
    const stuck = { getItem: k => storage.getItem(k), setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('denied'); } };
    const d = storedConsent(() => stuck);
    assert.deepEqual(d.read(), consent, 'the stored consent, read');
    d.write(null);
    assert.equal(d.read(), null, 'a withdrawal the storage refused');
    // No storage at all: the page's own.
    const e = storedConsent(() => null);
    assert.equal(e.read(), null);
    e.write(consent);
    assert.deepEqual(e.read(), consent);
    assert.equal(e.pageOnly(), true, 'said: the page only');

    // A storage that refuses one write and keeps the next: page-only, said, until it keeps one; then it is the truth again,
    // another tab's withdrawal included (the independent review of EA6.4: nothing pinned that).
    shared.clear();
    let refuse = true;
    const flaky = { getItem: k => storage.getItem(k), setItem: (k, v) => { if (refuse) { refuse = false; throw new Error('quota'); } storage.setItem(k, v); }, removeItem: k => storage.removeItem(k) };
    const f = storedConsent(() => flaky);
    assert.equal(f.pageOnly(), false);
    f.write(consent);
    assert.deepEqual([f.read(), f.pageOnly(), shared.has(CONSENT_KEY)], [consent, true, false], 'kept on this page only, and said');
    f.write(consent);
    assert.deepEqual([f.pageOnly(), shared.has(CONSENT_KEY)], [false, true], 'kept by the storage this time');
    storedConsent(() => storage).write(null);
    assert.equal(f.read(), null, 'withdrawn in another tab: none here');
    // Another tab's word reaches a page-only store through `watch`: the newest word wins, and the watcher hears it.
    shared.clear();
    refuse = true;
    let fire = () => {};
    let stopped = 0;
    const g = storedConsent(() => flaky, CONSENT_KEY, changed => { fire = changed; return () => { stopped++; }; });
    let heard = 0;
    const stop = g.watch(() => { heard++; });
    g.write(consent);
    assert.deepEqual([g.read(), g.pageOnly()], [consent, true], 'refused by the storage: this page\'s own');
    fire();
    assert.deepEqual([g.read(), g.pageOnly(), heard], [null, false, 1], 'another tab wrote: its word (none) is the truth');
    stop();
    assert.equal(stopped, 1);
    assert.equal(storedConsent(() => storage).watch, undefined, 'nothing to watch without a source');

    // Through the review: another tab's withdrawal shuts this tab's review before any call.
    shared.clear();
    const reviewer = fakeReviewer();
    const t = await reviewed({ reviewer, consent: storedConsent(() => storage) });
    assert.deepEqual(t.reviews.giveConsent(), { ok: true });
    assert.equal(t.reviews.aiReviewable(t.r), null);
    storedConsent(() => storage).write(null);
    const out = await t.reviews.aiReview(t.r.id, []);
    assert.equal(out.ok, false);
    assert.match(out.diagnostic, /^EA_REVIEW_CONSENT /);
    assert.equal(reviewer.calls.length, 0, 'no call');
    assert.equal(t.s.state.budget.reviews, 0, 'nothing reserved');
});

test('EA-VR6c a withdrawal, here or in another tab, stops a review under way: nothing more is sent, its answer is not taken, its call stays counted', { timeout: 20_000 }, async () => {
    // Here: the call waits (for its identity and App Check token, say), and the creator withdraws. The call's signal is
    // pulled, so the transport sends nothing after (the independent review of EA6.4: it used to go out anyway).
    const reviewer = fakeReviewer({ hold: true });
    const t = await reviewed({ reviewer });
    t.reviews.giveConsent();
    const pending = t.reviews.aiReview(t.r.id, []);
    await waitFor(() => reviewer.held.length === 1, 'the call');
    assert.equal(reviewer.signals[0].aborted, false);
    t.reviews.withdrawConsent();
    assert.equal(reviewer.signals[0].aborted, true, 'the call pulled');
    assert.deepEqual(await pending, {
        ok: false, diagnostic: 'EA_REVIEW_CONSENT the creator withdrew consent while the review was under way: it was stopped, and its call is counted',
        sentence: COPY.review.aiConsent,
    });
    assert.equal(t.s.state.evidence.some(e => e.producedBy === 'model'), false, 'nothing recorded');
    assert.deepEqual([t.s.state.budget.reviews, t.s.state.budget.calls.unknown, t.s.state.reviews[0].status], [1, 1, 'cancelled'], 'counted, its end unseen');
    assert.deepEqual([t.r.model, t.r.status, t.reviews.reviewing], [null, 'ready', false]);
    assert.match(t.reviews.aiReviewable(t.r), /^EA_REVIEW_CONSENT /, 'nothing more until the creator allows it again');

    // An answer that ignores its cancel and lands after the withdrawal: not taken either; counted, its cost known.
    let land = () => {};
    const deaf = { terms: async () => terms(), async review(body) { await new Promise(resolve => { land = resolve; }); return answerFor(body); } };
    const v = await reviewed({ reviewer: deaf });
    v.reviews.giveConsent();
    const late = v.reviews.aiReview(v.r.id, []);
    await waitFor(() => v.s.state.reviews.length === 1, 'the deaf call');
    v.reviews.withdrawConsent();
    land();
    const landed = await late;
    assert.equal(landed.diagnostic, 'EA_REVIEW_CONSENT the creator withdrew consent while the review was under way: it was stopped, and its call is counted');
    assert.deepEqual([v.r.model, v.s.state.evidence.some(e => e.producedBy === 'model'), v.s.state.reviews[0].status, v.s.state.reviews[0].charge], [null, false, 'stale', 'known']);

    // In another tab: its storage event reaches this one, which pulls the call its consent no longer covers.
    const shared = new Map();
    const storage = { getItem: k => (shared.has(k) ? shared.get(k) : null), setItem: (k, val) => { shared.set(k, String(val)); }, removeItem: k => { shared.delete(k); } };
    let event = () => {};
    const watched = storedConsent(() => storage, CONSENT_KEY, changed => { event = changed; return () => {}; });
    const other = fakeReviewer({ hold: true });
    const u = await reviewed({ reviewer: other, consent: watched });
    u.reviews.giveConsent();
    // A change elsewhere that leaves this tab's consent standing (the same terms allowed again) pulls nothing.
    const kept = u.reviews.aiReview(u.r.id, []);
    await waitFor(() => other.held.length === 1, 'the first call');
    storedConsent(() => storage).write({ provider: 'meta', model: 'muse-spark-1.3', policyVersion: 'meta-standard.2026-11-03' });
    event();
    assert.equal(other.signals[0].aborted, false, 'still covered');
    held(other);
    assert.deepEqual(await kept, { ok: true });
    const changes = u.st.changes;
    const elsewhere = u.reviews.aiReview(u.r.id, []);
    await waitFor(() => other.held.length === 1, 'the second call');
    storedConsent(() => storage).write(null);
    event();
    assert.equal(other.signals[1].aborted, true, 'pulled by the other tab\'s withdrawal');
    assert.ok(u.st.changes > changes, 'the panel told at once');
    const out = await elsewhere;
    assert.equal(out.diagnostic, 'EA_REVIEW_CONSENT the consent was withdrawn or changed in another tab while the review was under way: it was stopped, and its call is counted');
    assert.deepEqual([u.s.state.budget.reviews, u.r.model.verdict], [2, 'fail'], 'the first review\'s verdict stands; the second is counted');
});

test('EA-VR7c a model\'s answer for a review whose device was replaced, or whose world was put on the stage again, is discarded and stays counted', { timeout: 20_000 }, async () => {
    // The device replaced mid-review: the studio counts a new generation and captures nothing (main.ts).
    const reviewer = fakeReviewer({ hold: true });
    const t = await reviewed({ reviewer });
    t.reviews.giveConsent();
    const pending = t.reviews.aiReview(t.r.id, []);
    await waitFor(() => reviewer.held.length === 1, 'the call');
    t.st.generation++;
    held(reviewer);
    const lost = await pending;
    assert.equal(lost.diagnostic, 'EA_STALE_EVIDENCE the device was replaced since this review: its answer is discarded');
    assert.equal(t.s.state.evidence.some(e => e.producedBy === 'model'), false, 'no verdict recorded');
    assert.deepEqual([t.s.state.reviews[0].status, t.s.state.reviews[0].charge, t.s.state.budget.reviews, t.r.model], ['stale', 'known', 1, null]);
    // The same candidate put on the stage again while the stage is busy: its capture refused, so the review is still the
    // newest, yet of an install no longer on the stage.
    const other = fakeReviewer({ hold: true });
    const u = await reviewed({ reviewer: other });
    u.reviews.giveConsent();
    const again = u.reviews.aiReview(u.r.id, []);
    await waitFor(() => other.held.length === 1, 'the call');
    u.st.busy = 'a Run holds the stage';
    u.install(u.first.id);
    assert.equal(u.reviews.latest, u.r, 'no newer review: its capture was refused');
    assert.equal(u.reviews.refusal.diagnostic, 'EA_REVIEW_BUSY a Run holds the stage');
    held(other);
    const moved = await again;
    assert.equal(moved.diagnostic, 'EA_STALE_EVIDENCE another world is on the stage: its answer is discarded');
    assert.deepEqual([u.s.state.evidence.some(e => e.producedBy === 'model'), u.s.state.reviews[0].status, u.r.model], [false, 'stale', null]);
});

/**
 * A DOM just big enough for the review panel (shared/dom.ts's h() and what the panel reads), installed for one test and
 * taken away after it: the rest of this file runs with none (the panel module touches `document` only when it builds).
 */
function fakeDom() {
    class FakeNode {}
    class FakeText extends FakeNode {
        constructor(data) { super(); this.data = String(data); }
        get textContent() { return this.data; }
    }
    class FakeElement extends FakeNode {
        constructor(tag) {
            super();
            Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, listeners: new Map(), className: '', hidden: false, disabled: false, checked: false, value: '' });
        }
        setAttribute(name, value) {
            if (name === 'hidden' || name === 'disabled' || name === 'checked') this[name] = true;
            else this[name] = value;
        }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        }
        /** As a browser's: a disabled button does nothing. */
        click() {
            if (!this.disabled) for (const l of this.listeners.get('click') ?? []) l({ type: 'click', target: this });
        }
        append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(n)); }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        focus() {}
        /** As a browser's, over `className`: what the panels toggle (EA9.4's review: a line kept for a screen reader). */
        get classList() {
            const names = () => this.className.split(' ').filter(Boolean);
            const set = list => { this.className = [...new Set(list)].join(' '); };
            return {
                contains: name => names().includes(name),
                add: (...more) => set([...names(), ...more]),
                remove: (...less) => set(names().filter(n => !less.includes(n))),
                toggle: (name, force) => {
                    const on = force ?? !names().includes(name);
                    set(on ? [...names(), name] : names().filter(n => n !== name));
                    return on;
                },
            };
        }
        get childElementCount() { return this.children.filter(c => c instanceof FakeElement).length; }
        get textContent() { return this.children.map(c => c.textContent).join(''); }
        set textContent(text) { this.children = text === '' ? [] : [new FakeText(text)]; }
        /** Every element under this one, depth first. */
        *all() { for (const c of this.children) if (c instanceof FakeElement) { yield c; yield* c.all(); } }
    }
    const saved = { Node: globalThis.Node, document: globalThis.document };
    globalThis.Node = FakeNode;
    globalThis.document = { createElement: tag => new FakeElement(tag) };
    return {
        button: (root, text) => [...root.all()].find(e => e.tagName === 'BUTTON' && e.textContent === text) ?? null,
        byClass: (root, name) => [...root.all()].find(e => e.className.split(' ').includes(name)) ?? null,
        restore() { Object.assign(globalThis, saved); },
    };
}

test('EA6.4 the panel: the disclosure follows the terms; "Allow" takes only those shown; Withdraw reaches any consent held; a page-only consent said; no capture or second press while a review runs', { timeout: 20_000 }, async () => {
    const dom = fakeDom();
    try {
        const { ReviewPanel } = await import('../src/shell/studio/review-view.ts');
        const reviewer = fakeReviewer({ hold: true });
        const t = await reviewed({ reviewer });
        const panel = new ReviewPanel(t.reviews);
        const disclosure = () => dom.byClass(panel.el, 'rev-disclosure');
        const allow = () => dom.button(panel.el, 'Allow AI review with Meta');
        const withdraw = () => [...panel.el.all()].find(e => e.tagName === 'BUTTON' && e.textContent === 'Withdraw consent');
        panel.render();
        assert.equal(disclosure().hidden, false, 'asked before anything is sent');
        assert.match(disclosure().textContent, /to Meta's model muse-spark-1\.3,/);
        assert.equal(withdraw().hidden, true, 'nothing held, nothing to withdraw');
        // The backend moves the review to another model under the same policy: the words are drawn again for it, and
        // "Allow" binds what they name (the independent review of EA6.4: the old model's words stayed on screen).
        reviewer.termsAre = terms(null, { model: 'muse-spark-1.4' });
        await t.reviews.loadTerms();
        panel.render();
        assert.match(disclosure().textContent, /to Meta's model muse-spark-1\.4,/);
        allow().click();
        assert.equal(t.reviews.consent?.model, 'muse-spark-1.4');
        // Terms that move after the words were drawn, with no redraw between: "Allow" takes nothing.
        t.reviews.withdrawConsent();
        panel.render();
        reviewer.termsAre = terms(null, { model: 'muse-spark-1.5' });
        await t.reviews.loadTerms();
        allow().click();
        assert.equal(t.reviews.heldConsent, null, 'the words on screen named another model');
        panel.render();
        assert.match(disclosure().textContent, /muse-spark-1\.5/);
        allow().click();
        assert.equal(t.reviews.consent?.model, 'muse-spark-1.5');
        // A consent to terms that moved on, or with the backend away: still withdrawable.
        reviewer.termsAre = terms();
        await t.reviews.loadTerms();
        panel.render();
        assert.equal(t.reviews.consent, null);
        assert.equal(withdraw().hidden, false, 'held, to other terms: withdrawable');
        withdraw().click();
        assert.equal(t.reviews.heldConsent, null);
        // Contributor mode under Standard-mode words: shut, nothing drawn to consent to.
        reviewer.termsAre = terms(null, { model: 'muse-spark-1.3-contributor', mode: 'contributor' });
        await t.reviews.loadTerms();
        panel.render();
        assert.deepEqual([disclosure().hidden, allow().hidden], [true, true]);
        assert.match(dom.byClass(panel.el, 'rev-ai-gate').textContent, /not meta's contributor mode/);

        // While a review runs: "Capture again" waits (a capture would void its paid answer), and a second press does
        // nothing, so nothing is left said once it answers.
        reviewer.termsAre = terms();
        await t.reviews.loadTerms();
        panel.render();
        allow().click();
        panel.render();
        const review = dom.button(panel.el, 'Review with AI');
        assert.equal(review.disabled, false);
        review.click();
        review.click();
        await waitFor(() => reviewer.held.length === 1, 'the call');
        await settle();
        assert.equal(t.r.error, null, 'the second press did nothing, so said nothing');
        panel.render();
        assert.equal(dom.button(panel.el, 'Capture again').disabled, true, 'no capture while a review runs');
        held(reviewer);
        await waitFor(() => !t.reviews.reviewing && t.r.model !== null, 'the answer');
        await settle();
        panel.render();
        assert.equal(reviewer.calls.length, 1, 'one call for two presses');
        assert.deepEqual([t.r.error, dom.byClass(panel.el, 'cand-note').hidden], [null, true], 'nothing left said');
        assert.equal(dom.button(panel.el, 'Capture again').disabled, false);
        panel.dispose();

        // A storage that would not keep the go-ahead, or its withdrawal: said, never silent.
        const refusing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('denied'); } };
        const u = await reviewed({ reviewer: fakeReviewer(), consent: storedConsent(() => refusing) });
        const other = new ReviewPanel(u.reviews);
        other.render();
        dom.button(other.el, 'Allow AI review with Meta').click();
        other.render();
        assert.equal(u.reviews.consent?.model, 'muse-spark-1.3', 'held on this page');
        assert.deepEqual([dom.byClass(other.el, 'rev-ai-kept').hidden, dom.byClass(other.el, 'rev-ai-kept').textContent], [false, COPY.review.aiKeptHere]);
        dom.button(other.el, 'Withdraw consent').click();
        other.render();
        assert.equal(u.reviews.heldConsent, null);
        assert.equal(dom.byClass(other.el, 'rev-ai-kept').textContent, COPY.review.aiWithdrawnHere);
        other.dispose();
    } finally {
        dom.restore();
    }
});

test('EA6.4 the independent review\'s smaller fixes: a double press leaves nothing said; the backend\'s 413 and consent refusals in §11\'s words; a withheld capture; a session that cannot revise; terms read again while shut', { timeout: 20_000 }, async () => {
    // A press refused while one runs writes its BUSY onto the review; the answer of the first clears it.
    const reviewer = fakeReviewer({ hold: true });
    const t = await reviewed({ reviewer });
    t.reviews.giveConsent();
    const first = t.reviews.aiReview(t.r.id, []);
    await waitFor(() => reviewer.held.length === 1, 'the call');
    const second = await t.reviews.aiReview(t.r.id, []);
    assert.equal(second.diagnostic, 'EA_REVIEW_BUSY a model\'s review is under way');
    assert.equal(t.r.error, 'EA_REVIEW_BUSY a model\'s review is under way', 'said while the first runs');
    held(reviewer);
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual([t.r.error, t.r.sentence], [null, null], 'nothing left said once it answered');

    // The backend's 413 (its own size words, or the gateway's) and its refusal of a consent to terms that moved meanwhile.
    const outcome = async error => {
        const r = fakeReviewer({ answer: () => error });
        const x = await reviewed({ reviewer: r });
        x.reviews.giveConsent();
        const read = r.termsRead;
        return { out: await x.reviews.aiReview(x.r.id, []), reread: r.termsRead > read, x };
    };
    const own = await outcome(new ForgeError('too-large', 413, 'EA_REVIEW_SIZE frames: 600001 exceeds 600000 bytes together.'));
    assert.deepEqual(own.out, { ok: false, diagnostic: 'EA_REVIEW_SIZE frames: 600001 exceeds 600000 bytes together.', sentence: COPY.review.tooLarge });
    assert.deepEqual([own.x.s.state.budget.reviews, own.x.s.state.reviews[0].status], [1, 'refused'], 'counted: it went out');
    const gateway = await outcome(new ForgeError('too-large', 413, 'The request is too large.'));
    assert.deepEqual(gateway.out, { ok: false, diagnostic: 'EA_REVIEW_SIZE request: The request is too large.', sentence: COPY.review.tooLarge });
    const moved = await outcome(new ForgeError('bad-request', 400,
        'consent names "meta", "muse-spark-1.3" and policy "meta-standard.2026-11-03"; this server sends frames to meta\'s muse-spark-1.4 under policy meta-standard.2026-11-03: ask the creator again.'));
    assert.match(moved.out.diagnostic, /^EA_REVIEW_CONSENT the backend's terms moved: consent names "meta"/);
    assert.equal(moved.out.sentence, COPY.review.aiConsent);
    assert.equal(moved.reread, true, 'the terms read again, so the panel asks again');
    const other = await outcome(new ForgeError('bad-request', 400, 'frames[0].jpeg does not decode whole: Corrupt JPEG data: bad Huffman code.'));
    assert.equal(other.out.diagnostic, 'EA_REVIEW_FAILED bad-request: frames[0].jpeg does not decode whole: Corrupt JPEG data: bad Huffman code.');

    // A world whose capture was withheld has no frame to send: its own reason (§11), not "capture again".
    const withheld = () => {
        const c = captured();
        const why = 'EA_CAPTURE_UNAVAILABLE state: foggy-dusk#fx writes a buffer its frame schedule keeps';
        return { ...c, outcome: { ...c.outcome, frames: [], missing: [{ name: 'framed', why }, { name: 'side', why }] } };
    };
    const w = await reviewed({ reviewer: fakeReviewer(), capture: withheld });
    w.reviews.giveConsent();
    assert.equal(w.r.frames.length, 0);
    assert.equal(w.reviews.aiReviewable(w.r), 'EA_CAPTURE_UNAVAILABLE state: foggy-dusk#fx writes a buffer its frame schedule keeps');
    assert.equal(sentenceOf(w.reviews.aiReviewable(w.r)), COPY.review.unavailable);

    // A session that cannot revise offers no model's review either (§9.1): its issues would have nowhere to go.
    const n = await reviewed({ reviewer: fakeReviewer(), revisable: false });
    n.reviews.giveConsent();
    assert.match(n.reviews.aiReviewable(n.r), /^EA_REVIEW_UNAVAILABLE stage .*, active revisable session none$/);

    // Terms that said shut are read again with the next capture: gates opened meanwhile are seen without a reload.
    const later = fakeReviewer({ termsAre: terms('images') });
    const s = await reviewed({ reviewer: later });
    assert.match(s.reviews.aiGate(), /^EA_VISION_UNAVAILABLE images: /);
    later.termsAre = terms();
    await s.reviews.capture();
    await waitFor(() => s.reviews.terms?.available === true, 'the terms read again');
    // Open terms are not read on every capture (a review reads them again itself, before its call).
    const reads = later.termsRead;
    await s.reviews.capture();
    await settle();
    assert.equal(later.termsRead, reads);
});

// EA9-U23 and U24 (EA9.4; agent-first-studio-design.md §9; Q121, and the user's Q118 answer of 11-03: "a chat window style
// new prompt to ask them to improve if any missed and then show again"): the creator's "Shape it" over this same review,
// and a revision the backend refused for its words, which spent nothing.

test('EA9-U23 the creator\'s "Shape it": Looks right; their words as one round, its Show it once; a refusal said with the words given back; plain words only', { timeout: 20_000 }, async () => {
    const dom = fakeDom();
    try {
        const { ImproveView } = await import('../src/shell/studio/improve-view.ts');
        const reviser = fakeReviser([handedOff(world({ size: 0.5 })), { throws: new ForgeError('content-refused', 422, 'These words can\'t be used here. Try saying the change another way.') }]);
        const t = await reviewed({ reviser });
        // The controller as the panel reads it: the shown creation's phase, whether it improves the world on the stage, its go.
        const ctl = { state: { phase: 'installed', improves: true, sentence: null }, shows: 0, showBlocked: () => null, async show() { ctl.shows++; return null; } };
        const lost = { now: false };
        const view = new ImproveView({ reviews: t.reviews, creation: ctl, lost: () => lost.now });
        const status = () => dom.byClass(view.el, 'imp-status');
        const thread = () => dom.byClass(view.el, 'imp-thread').textContent;
        const box = () => dom.byClass(view.el, 'imp-words');
        const send = () => [...view.el.all()].find(e => e.className.split(' ').includes('imp-send'));

        // A world made earlier (a starter, a saved world reopened, a replay): said, and nothing offered.
        view.installed('earlier');
        assert.equal(status().textContent, COPY.improve.madeEarlier);
        assert.equal(dom.byClass(view.el, 'imp-composer').hidden, true);

        // A creation's world: the ask, Looks right, the count, and Improve it once there are words.
        view.installed('creation');
        assert.ok(view.el.textContent.includes(COPY.improve.ask));
        assert.equal(dom.button(view.el, COPY.improve.looksRight).disabled, false);
        assert.equal(send().disabled, true, 'no words, nothing to send');
        assert.equal(dom.byClass(view.el, 'imp-left').textContent, COPY.improve.left(2));
        dom.button(view.el, COPY.improve.looksRight).click();
        assert.equal(t.r.status, 'approved', 'a pass recorded, nothing spent');
        assert.ok(thread().includes(COPY.improve.glad));
        assert.equal(dom.button(view.el, COPY.improve.looksRight).hidden, true, 'said once');

        // Sent: the words move into the thread; one revision carries them as the creator's finding, and only them.
        box().value = 'make the towers taller';
        view.render();
        send().click();
        assert.equal(box().value, '', 'the words left the box');
        assert.ok(thread().includes('make the towers taller'));
        await waitFor(() => t.r.status === 'awaiting-run', 'the round');
        await settle();
        assert.equal(reviser.calls.length, 1, 'one revision');
        assert.deepEqual(reviser.calls[0].findings.filter(f => f.code === 'creator').map(f => f.message), ['make the towers taller']);
        assert.ok(thread().includes(COPY.improve.ready));
        // The improvement waits for its go: Show it, one press for a double click.
        ctl.state = { phase: 'ready', improves: true, sentence: null };
        view.render();
        // The thread says it already: one sentence on screen once, not twice; the line kept for a screen reader alone
        // (EA9.4's review: the thread is no live region, so a refused round was never heard).
        assert.deepEqual([status().hidden, status().classList.contains('sr-only'), status().textContent], [false, true, COPY.improve.ready]);
        const show = dom.button(view.el, COPY.improve.show);
        assert.equal(show.hidden, false);
        box().value = 'and a moat around it';
        view.render();
        assert.equal(send().disabled, true, 'nothing more is sent while the improvement waits for its go, whatever is typed');
        box().value = '';
        view.render();
        show.click();
        for (const l of show.listeners.get('click')) l({ type: 'click', target: show, detail: 2 });
        assert.equal(ctl.shows, 1, 'one go for a double click');

        // Shown: a new version of the same world, its thread going on, one improvement left.
        const improved = t.s.snapshot.id;
        ctl.state = { phase: 'installed', improves: true, sentence: null };
        t.install(improved);
        view.installed('creation', 'improved');
        await waitFor(() => t.reviews.latest?.candidate === improved && t.reviews.latest.status === 'ready', 'the improved world\'s review');
        view.render();
        assert.ok(thread().includes(COPY.improve.shown));
        assert.equal(dom.byClass(view.el, 'imp-left').textContent, COPY.improve.left(1));
        // The same world shown again (past its envelope): its thread goes on, and nothing is said of it.
        const said = thread();
        view.installed('creation', 'same');
        assert.equal(thread(), said);

        // A second round, by Ctrl+Enter in the box: the backend refuses its words (422, before any call). Said as such, the
        // words back in the box to say it another way, and nothing spent: the same round still left (EA9-U24).
        const spent = structuredClone(t.s.state.budget);
        box().value = 'add a moat';
        view.render();
        let sent = 0;
        for (const l of box().listeners.get('keydown')) l({ ctrlKey: true, metaKey: false, key: 'Enter', repeat: false, preventDefault() {}, stopPropagation() { sent++; } });
        assert.equal(sent, 1, 'the page\'s own shortcut does not hear it');
        await waitFor(() => t.reviews.latest.status === 'not-improved', 'the refused round');
        await settle();
        view.render();
        assert.equal(t.reviews.latest.sentence, COPY.review.refused);
        assert.ok(thread().endsWith(COPY.review.refused));
        assert.equal(box().value, 'add a moat', 'the words given back');
        assert.equal(t.reviews.roundsLeft(), 1, 'the round given back');
        assert.deepEqual([t.s.state.budget.visualRounds, t.s.state.budget.revisions, t.s.state.budget.calls], [spent.visualRounds, spent.revisions, spent.calls], 'nothing counted');
        assert.equal(dom.byClass(view.el, 'imp-left').textContent, COPY.improve.left(1));

        // Plain words only (§2's P5): no id(C), code, hash, model or WGSL anywhere in the panel.
        assert.doesNotMatch(view.el.textContent, /EA_|id\(C\)|[0-9a-f]{12}|muse-|WGSL|module/);
        // The device lost: said, nothing offered.
        lost.now = true;
        view.render();
        assert.equal(status().textContent, COPY.improve.deviceLost);
    } finally {
        dom.restore();
    }
});

test('EA9-U24 a round\'s sentence by the backend\'s code, never its prose: its words refused, an expired prompt\'s allowance, the budget, anything else', async () => {
    const { roundSentence } = await import('../src/loop/review.ts');
    assert.equal(roundSentence({ scope: 'budget', sentence: 'x' }), COPY.review.budget);
    assert.equal(roundSentence({ scope: 'host', code: 'content-refused', sentence: COPY.failures.refused }), COPY.review.refused);
    // A revision whose prompt expired is an entry, which W1's allowance may refuse: its own sentence, never "not applied".
    assert.equal(roundSentence({ scope: 'host', code: 'account-required', sentence: COPY.failures.allowance }), COPY.failures.allowance);
    assert.equal(roundSentence({ scope: 'host', code: 'quota', sentence: COPY.failures.quota }), COPY.failures.quota);
    assert.equal(roundSentence({ scope: 'program', sentence: COPY.candidate.setup }), COPY.review.notApplied);
    assert.equal(roundSentence({ scope: 'host', code: 'internal', sentence: COPY.candidate.refused }), COPY.review.notApplied);
    assert.equal(roundSentence(null), COPY.review.notApplied);

    // An unseen end still counts (EA-VR5): only the backend's 422 content-refused, answered before any call, gives back.
    const t = studio({ reviser: fakeReviser([{ throws: new ForgeError('upstream', 502, 'the stream broke') }]) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const out = await t.reviews.improve(t.reviews.latest.id, 'make it taller', []);
    assert.equal(out.ok, true);
    assert.equal(t.s.state.budget.visualRounds, 1, 'a round whose revision broke stays spent');
    assert.equal(t.reviews.latest.sentence, COPY.review.notApplied);
});

test('EA9-U24b the world\'s own words refused (422 world-refused, EA9.4\'s second backend review): said as the world\'s, nothing spent, and neither a change nor a model\'s review offered for that world again', { timeout: 20_000 }, async () => {
    const { roundSentence } = await import('../src/loop/review.ts');
    const { refusedBeforeAnyCall, sentenceFor } = await import('../src/loop/candidate.ts');
    assert.equal(roundSentence({ scope: 'host', code: 'world-refused', sentence: COPY.failures.refused }), COPY.review.worldRefused);
    // Create's own revision refused so says what a creation says: no world was shown yet (EA9.4's review).
    assert.equal(sentenceFor('world-refused'), COPY.failures.refused);
    // Nothing spent at admission: the creator's words or the world's, the allowance, a rate, the guard, as the backend's own
    // envelope says it before any stream. A bare page, a refusal in the stream (status 200) or a timeout may follow work.
    for (const code of ['world-refused', 'content-refused', 'account-required', 'quota', 'rate', 'budget', 'paused', 'unavailable', 'bad-request', 'auth', 'forbidden']) {
        assert.equal(refusedBeforeAnyCall(new ForgeError(code, ERROR_STATUS[code], 'm')), true, code);
    }
    assert.equal(refusedBeforeAnyCall(new ForgeError('bad-request', 422, 'm', null, true)), false, 'a bare 422 is no refusal');
    assert.equal(refusedBeforeAnyCall(new ForgeError('world-refused', 200, 'm')), false, 'said in the stream: work had begun');
    for (const code of ['timeout', 'upstream', 'internal']) assert.equal(refusedBeforeAnyCall(new ForgeError(code, ERROR_STATUS[code], 'm')), false, code);
    assert.equal(refusedBeforeAnyCall(new ForgeError('unavailable', 0, 'the network')), false, 'no answer: unknown');
    assert.equal(sentenceOf('EA_REVIEW_REFUSED content safety refused this world\'s own words'), COPY.review.worldRefused);

    const dom = fakeDom();
    try {
        const { ImproveView } = await import('../src/shell/studio/improve-view.ts');
        const reviewer = fakeReviewer();
        const reviser = fakeReviser([{ throws: new ForgeError('world-refused', 422, 'This world can\'t be changed here. Try a different idea.') }, handedOff(world({ size: 0.5 }))]);
        const t = await reviewed({ reviser, reviewer });
        t.reviews.giveConsent();
        const ctl = { state: { phase: 'installed', improves: true, sentence: null }, shows: 0, showBlocked: () => null, async show() { ctl.shows++; return null; } };
        const view = new ImproveView({ reviews: t.reviews, creation: ctl, lost: () => false });
        const thread = () => dom.byClass(view.el, 'imp-thread').textContent;
        const composer = () => dom.byClass(view.el, 'imp-composer');
        const box = () => dom.byClass(view.el, 'imp-words');
        view.installed('creation');
        const spent = structuredClone(t.s.state.budget);
        const rounds = t.reviews.roundsLeft();
        box().value = 'make the towers taller';
        view.render();
        [...view.el.all()].find(e => e.className.split(' ').includes('imp-send')).click();
        await waitFor(() => t.reviews.latest.status === 'not-improved', 'the refused round');
        await settle();
        view.render();
        // Its own sentence, chosen by the code: never the creator's "say the change another way".
        assert.equal(t.reviews.latest.sentence, COPY.review.worldRefused);
        assert.ok(thread().endsWith(COPY.review.worldRefused));
        const line = dom.byClass(view.el, 'imp-status');
        assert.deepEqual([line.textContent, line.classList.contains('sr-only')], [COPY.review.worldRefused, true], 'seen once in the thread, and heard');
        // Nothing spent: the round, the revision and its calls given back.
        assert.deepEqual([t.s.state.budget.visualRounds, t.s.state.budget.revisions, t.s.state.budget.calls], [spent.visualRounds, spent.revisions, spent.calls]);
        assert.equal(t.reviews.roundsLeft(), rounds);
        // No change offered for this world again, in any words, nor a model's review of it: refused before any call.
        assert.equal(composer().hidden, true);
        assert.match(t.reviews.improvable(), /^EA_REVIEW_REFUSED /);
        // Said before any busy word: "improve it once that is done" would promise what the backend refused.
        t.st.paid = 'a new world is being made';
        assert.match(t.reviews.improvable(), /^EA_REVIEW_REFUSED /);
        t.st.paid = null;
        const again = await t.reviews.improve(t.reviews.latest.id, 'add a moat', []);
        assert.deepEqual([again.ok, again.sentence], [false, COPY.review.worldRefused]);
        assert.match(t.reviews.aiReviewable(), /^EA_REVIEW_REFUSED /);
        assert.equal((await t.reviews.aiReview(t.reviews.latest.id, [])).ok, false);
        assert.deepEqual([reviser.calls.length, reviewer.calls.length], [1, 0], 'the refused revision only');
        assert.equal(t.reviews.looksRight(t.reviews.latest.id).ok, true, 'Looks right still spends nothing and is recorded');
        // The same world shown again (past its envelope) is that world still.
        t.install(t.reviews.latest.candidate);
        await waitFor(() => t.reviews.latest?.status === 'ready', 'its review again');
        view.installed('creation', 'same');
        assert.match(t.reviews.improvable(), /^EA_REVIEW_REFUSED /);
        assert.equal(composer().hidden, true);
        assert.doesNotMatch(view.el.textContent, /EA_|id\(C\)|[0-9a-f]{12}|muse-|WGSL|module/);
        // Another world is not that one: whatever else stops it, not this refusal.
        t.install('another-candidate');
        await waitFor(() => t.reviews.latest?.candidate === 'another-candidate' && t.reviews.latest.status === 'ready', 'another world\'s review');
        assert.doesNotMatch(t.reviews.improvable() ?? '', /^EA_REVIEW_REFUSED/);
    } finally {
        dom.restore();
    }
});

// EA9.4's independent review (2026-11-05): its findings, each held here.

test('EA9.4 review: Stop during a round ends the round alone: its calls counted, the session back on the world on the stage, said stopped, and another round offered', { timeout: 20_000 }, async () => {
    const t = studio({ reviser: fakeReviser([{ hold: true }, handedOff(world({ size: 0.5 }))]) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    const round = t.reviews.improve(t.reviews.latest.id, 'make the towers taller', []);
    await waitFor(() => t.reviser.held.length === 1, 'the revision out');
    t.s.stopRound();
    assert.deepEqual(await round, { ok: true });
    const r = t.reviews.latest;
    assert.deepEqual([r.status, r.sentence], ['not-improved', COPY.review.stopped]);
    assert.equal(t.s.snapshot?.id, first.id, 'the session is back on the world on the stage');
    assert.equal(t.s.state.budget.visualRounds, 1, 'the round went out: spent');
    assert.equal(t.s.state.budget.calls.unknown, Q_C.revisionCalls, 'its revision\'s end unseen: unknown');
    assert.equal(t.reviews.improvable(), null, 'another round offered: what is left stays');
    // Outside a round, nothing: the attempt is never closed by it.
    t.s.stopRound();
    assert.equal(t.s.snapshot?.id, first.id);
});

test('EA9.4 review: a round given back only when nothing of it was spent; a later automatic revision\'s refusal is not the creator\'s words nor this world\'s', { timeout: 20_000 }, async () => {
    // The creator's revision hands off a program the browser refuses; the automatic revision that answers it is refused
    // for its words. The round's own revision was charged: the round stays spent, and nothing is pinned on this world.
    const refusedLater = new ForgeError('world-refused', 422, 'This world can\'t be changed here. Try a different idea.');
    // A program whose batch reads a node that is not there: refused at resolve, which a program revision answers.
    const dangling = world().map(n => (n.id === 'blocks' ? { ...n, inputs: n.inputs.map(i => (i.port === 'geometry' ? { ...i, nodeId: 'nowhere' } : i)) } : n));
    const t = studio({ reviser: fakeReviser([handedOff(dangling), { throws: refusedLater }]) });
    const first = await t.s.start(handOff());
    t.install(first.id);
    await waitFor(() => t.reviews.latest?.status === 'ready', 'the review');
    assert.deepEqual(await t.reviews.improve(t.reviews.latest.id, 'make it taller', []), { ok: true });
    assert.equal(t.reviser.calls.length, 2, 'the creator\'s revision, then the automatic one');
    const r = t.reviews.latest;
    assert.deepEqual([r.status, r.sentence], ['not-improved', COPY.review.notApplied]);
    assert.equal(t.s.state.budget.visualRounds, 1, 'the round stays spent: its own revision was charged');
    assert.equal(t.reviews.improvable(), null, 'this world is not refused: another round offered');

    // An expired prompt's revision is an entry the allowance refused (403 account-required): nothing spent, W1's dialog.
    const a = studio({ reviser: fakeReviser([{ throws: new ForgeError('account-required', 403, 'Sign in to make more worlds.') }]) });
    const s = await a.s.start(handOff());
    a.install(s.id);
    await waitFor(() => a.reviews.latest?.status === 'ready', 'its review');
    await a.reviews.improve(a.reviews.latest.id, 'add a moat', []);
    assert.deepEqual([a.reviews.latest.sentence, a.s.state.budget.visualRounds, a.s.state.budget.revisions], [COPY.failures.allowance, 0, 0]);
    assert.deepEqual(a.st.limits, [{ kind: 'allowance', sentence: COPY.failures.allowance }], 'W1\'s dialog, once');
});

test('EA9.4 review: the panel drops a round\'s late answer once another world is on the stage; says whose world it is by the controller; offers nothing with no round left', { timeout: 20_000 }, async () => {
    const dom = fakeDom();
    try {
        const { ImproveView } = await import('../src/shell/studio/improve-view.ts');
        const reviser = fakeReviser([{ hold: true }, handedOff(world({ size: 0.5 }))]);
        const t = await reviewed({ reviser });
        const ctl = { state: { phase: 'installed', improves: true, sentence: null }, stageMoved: false, showBlocked: () => null, async show() { return null; } };
        const view = new ImproveView({ reviews: t.reviews, creation: ctl, lost: () => false });
        const box = () => dom.byClass(view.el, 'imp-words');
        const thread = () => dom.byClass(view.el, 'imp-thread').textContent;
        view.installed('creation');
        box().value = 'make the towers taller';
        view.render();
        [...view.el.all()].find(e => e.className.split(' ').includes('imp-send')).click();
        await waitFor(() => reviser.held.length === 1, 'the round out');
        // Another world arrives (a starter, say) while the round runs; then the round's answer comes.
        view.installed('earlier');
        reviser.held[0].resolve(handedOff(world({ size: 0.5 })));
        await waitFor(() => !t.reviews.improving, 'the round answered');
        await settle();
        assert.equal(thread(), '', 'nothing of the round in the new world\'s thread');
        assert.equal(box().value, '', 'nor its words in the box');

        // Another world on its way to the stage (a Run, an example, a starter: the studio's paidBusy): no change paid for now,
        // said as such, never "capture it again".
        t.st.paid = 'another world is being tested on this device';
        view.installed('creation');
        assert.match(t.reviews.improvable(), /^EA_REVIEW_BUSY another world/);
        assert.equal(sentenceOf(t.reviews.improvable()), COPY.review.replacing);
        t.st.paid = null;

        // No session for the world: its maker's account gone (the controller says so), or ended otherwise.
        const n = await reviewed({ revisable: false });
        const ended = new ImproveView({ reviews: n.reviews, creation: { ...ctl, stageMoved: false }, lost: () => false });
        ended.installed('creation');
        assert.equal(dom.byClass(ended.el, 'imp-status').textContent, COPY.improve.ended);
        const moved = new ImproveView({ reviews: n.reviews, creation: { ...ctl, stageMoved: true }, lost: () => false });
        moved.installed('creation');
        assert.equal(dom.byClass(moved.el, 'imp-status').textContent, COPY.improve.otherAccount);

        // No round left: the limit said, and nothing to send, whatever is typed.
        const spent = await reviewed({ limits: { ...Q_C, visualRounds: 0 } });
        const none = new ImproveView({ reviews: spent.reviews, creation: ctl, lost: () => false });
        none.installed('creation');
        dom.byClass(none.el, 'imp-words').value = 'one more change';
        none.render();
        assert.equal(spent.reviews.roundsLeft(), 0);
        assert.equal([...none.el.all()].find(e => e.className.split(' ').includes('imp-send')).disabled, true);
        assert.equal(dom.byClass(none.el, 'imp-status').textContent, COPY.review.budget);
    } finally {
        dom.restore();
    }
});

test('EA9.5\'s outside review: a followed turn whose end was not seen counts in the improvements left, its whole allowance unknown (Q120 (b))', async () => {
    // The hand-off's three calls, the followed turn's as counted, then three authors; Q_C at 23 calls, so its count decides.
    const left = {};
    // `told`: its end unseen, and the service's count on the follow-up's meta, one call (the user, 11-06: "yes u can go
    // ahead with api change").
    const ways = { seen: { end: 'seen' }, unseen: { end: 'unseen' }, told: { end: 'unseen', service: { end: 'cancelled', calls: 1 } } };
    for (const [way, how] of Object.entries(ways)) {
        const t = studio({ limits: { ...Q_C, calls: 23 } });
        const st = await t.s.start(handOff(world(), { followed: { turnId: 'turn-0', model: 'model-0', promptVersion: 'agent.v5', calls: [TURN_CALLS[0]], ...how } }));
        assert.equal(st.phase, 'static-verified', way);
        left[way] = { rounds: t.reviews.roundsLeft(), budget: t.reviews.budget() };
    }
    // Seen: 3 + 1 + 3 = 7 calls, so two rounds of six fit. Unseen: 3 + 6 + 3 = 12, so one: the cost of the safe count
    // (the independent review's low), said in the creator's count and the developer's line alike. Told: as seen, the
    // creator's improvement given back by the exact count.
    assert.deepEqual([left.seen.rounds, left.unseen.rounds, left.told.rounds], [2, 1, 2], JSON.stringify(left));
    assert.match(left.unseen.budget, /calls 12 of 23 \(6 unknown\)/);
    assert.match(left.seen.budget, /calls 7 of 23 · /);
    assert.match(left.told.budget, /calls 7 of 23 · /);
});
