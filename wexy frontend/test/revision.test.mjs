// EA-MR series, headless (EA4.4; candidate-loop-design.md §8 and §10; Q82 (a), decided 2026-11-01): the program revision,
// the candidate machine's Reviser seam (src/loop/reviser.ts) over the real agent client, reader and transport, only
// fetch faked, on the backend's own wire (test/fixtures/agent-wire: revised.sse and the other endings its AgentWireTest
// records). A revision is one turn: the three fields and a base of this build's pins, S and W as handed off, and the
// findings it answers, cut to the backend's caps. A hand-off maps to the new design and program with the turn's actual
// calls; asked, declined and exhausted to no replacement, with theirs; anything else rejects, its calls unknown. Then the
// machine: a program the browser refuses (an entry named after a WGSL built-in, which the server's check passes) is
// revised over the recorded wire, resolved again, its module authored under the revision's turn, and static-verified,
// with Q_C reconciled to the revision's calls and nothing reset; a hand-off that changed S replaces nothing; a revision
// whose stream fails keeps its six calls unknown. No model, no backend, no GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ADAPTER_MANIFEST_HASH } from '../src/contract/adapters/index.ts';
import { BASE_CAPS, createAgentClient, ENGINE_BUNDLE_HASH, TURN_VERSIONS } from '../src/forge-client/agent-client.ts';
import { AgentVersionError } from '../src/forge-client/agent-stream.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { createApi } from '../src/forge-client/http.ts';
import { candidateBundle, createCandidateSession, turnCallsOf } from '../src/loop/candidate.ts';
import { COPY } from '../src/loop/copy.ts';
import { createReviser } from '../src/loop/reviser.ts';

const wire = (name) => readFileSync(new URL(`./fixtures/agent-wire/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const eventData = (text, name) => [...text.matchAll(/^event:(.*)\ndata:(.*)$/gm)].filter(m => m[1] === name).map(m => JSON.parse(m[2]));
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const res = (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };
const identity = () => ({ async authorization() { return 'Bearer id-1'; }, async appCheck() { return 'ac-1'; } });

/** A fetch that answers from a list, keeping each request it was sent. */
function fakeFetch(...answers) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, method: init.method, body: init.body });
        const next = answers.shift();
        if (!next) throw new Error(`no answer left for request ${requests.length}`);
        return next;
    };
    return { fetchImpl, requests };
}

const reviserOver = (answer, options) => {
    const fetched = fakeFetch(answer);
    return { revise: createReviser(createAgentClient(createApi(CONFIG, identity(), fetched.fetchImpl), options)), requests: fetched.requests };
};

/** The recorded revision: the mock's design, and its program as revised; the base it revised named its init stage's entry `step`. */
const REVISED = wire('revised.sse');
const DESIGN = eventData(REVISED, 'design')[0].design;
const PROGRAM = eventData(REVISED, 'program')[0].program;
const withEntry = (entry) => ({ nodes: PROGRAM.nodes.map(n => (n.id === 'place' ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), entry }) } : n)) });
const BASE_PROGRAM = withEntry('step');
const R = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };
const FINDING = { id: 'ev-4.f1', code: 'EA_RESOLVE', path: '/nodes/6/config/module', message: 'step cannot be an entry: it must be a WGSL name' };
const SUBJECT = { attempt: 'attempt-1', revision: 0, programHash: '0'.repeat(64), graph: null, candidate: null, module: null, interfaceHash: null, codeHash: null };
const request = (over = {}) => ({ turnId: 'turn-0', request: R, design: DESIGN, program: BASE_PROGRAM, subject: SUBJECT, findings: [FINDING], ...over });

test('EA-MR1 a revision is one turn: the three fields and a base of this build\'s pins, S and W as handed off, the findings capped; its hand-off maps with its calls', async () => {
    const { revise, requests } = reviserOver(res(REVISED));
    const long = { id: 'x'.repeat(80), code: 'c'.repeat(50), path: `/${'p'.repeat(250)}`, message: 'm'.repeat(500) };
    const result = await revise(request({ findings: [FINDING, ...Array.from({ length: 40 }, () => long)] }), new AbortController().signal);

    assert.equal(requests.length, 1);
    assert.deepEqual([requests[0].url, requests[0].method], ['http://localhost:8400/v1/agent/turn', 'POST']);
    const sent = JSON.parse(requests[0].body);
    assert.deepEqual(Object.keys(sent), ['prompt', 'style', 'seconds', 'base']);
    assert.deepEqual({ prompt: sent.prompt, style: sent.style, seconds: sent.seconds }, R, 'R verbatim');
    // W1 (PL-FE9): the base names the turn it revises, so the revision runs inside that turn's prompt.
    assert.deepEqual(Object.keys(sent.base), ['turnId', 'versions', 'design', 'program', 'findings']);
    assert.equal(sent.base.turnId, 'turn-0', 'the turn the candidate holds: the hand-off\'s, or the last revision\'s');
    assert.deepEqual(sent.base.versions, { actionSchema: 'agent-action.v3', bundle: ENGINE_BUNDLE_HASH, manifest: ADAPTER_MANIFEST_HASH });
    assert.deepEqual(sent.base.versions, { ...TURN_VERSIONS });
    assert.deepEqual([sent.base.design, sent.base.program], [DESIGN, BASE_PROGRAM], 'S and W as handed off');
    // Cut to the backend's caps (AgentBase), so a base is never refused for a finding's length or their number.
    assert.equal(sent.base.findings.length, BASE_CAPS.findings);
    assert.deepEqual(sent.base.findings[0], FINDING);
    assert.deepEqual(sent.base.findings[1], { id: 'x'.repeat(64), code: 'c'.repeat(40), path: `/${'p'.repeat(199)}`, message: 'm'.repeat(400) });
    // The recorded revision: one call, the revise; its hand-off with the revision's own turn id and that call.
    assert.deepEqual(eventData(REVISED, 'call').map(c => c.purpose), ['revise']);
    assert.deepEqual(eventData(REVISED, 'meta')[0].promptVersion, 'agent.v6');
    assert.deepEqual(result, { status: 'handed-off', turnId: 'turn-1', design: DESIGN, program: PROGRAM, repairs: [], calls: 1 });
    // A first turn still sends its three fields alone.
    const first = fakeFetch(res(wire('asked.sse')));
    await createAgentClient(createApi(CONFIG, identity(), first.fetchImpl)).turn(R, () => {}, new AbortController().signal);
    assert.equal(first.requests[0].body, JSON.stringify(R));
});

test('EA-MR2 asked, declined and exhausted replace nothing and say their calls; a refusal, a failed stream or another contract rejects', async () => {
    const run = (name) => reviserOver(res(wire(name))).revise(request(), new AbortController().signal);
    assert.deepEqual(await run('asked.sse'), { status: 'asked', reason: eventData(wire('asked.sse'), 'question')[0].text, calls: 1 });
    assert.deepEqual(await run('declined.sse'), { status: 'declined', reason: eventData(wire('declined.sse'), 'done')[0].reason, calls: 1 });
    const exhausted = await run('exhausted-revisions.sse');
    assert.deepEqual([exhausted.status, exhausted.calls], ['exhausted', 3]);
    assert.match(exhausted.reason, /^EA_TURN_BUDGET: the check still fails after 2 revisions$/);
    // Rejections: the machine counts each revision's six calls unknown (EA-MR3).
    const failed = await run('error-upstream.sse').catch(e => e);
    assert.ok(failed instanceof ForgeError && failed.code === 'upstream', String(failed));
    const envelope = new Response('{"code":"bad-request","message":"base.versions.manifest is not this server\'s."}', { status: 400, headers: { 'Content-Type': 'application/json' } });
    const refused = await reviserOver(envelope).revise(request(), new AbortController().signal).catch(e => e);
    assert.ok(refused instanceof ForgeError && refused.code === 'bad-request', String(refused));
    const other = await reviserOver(res(REVISED), { manifestHash: 'f'.repeat(64) }).revise(request(), new AbortController().signal).catch(e => e);
    assert.ok(other instanceof AgentVersionError && other.identity === 'manifest', String(other));
});

/** The mock's place module, a body its interface takes (the backend's mock/modules/place.wgsl, shortened). */
const PLACE = [
    'fn placeBlocks(index: u32) {',
    '    let base = index * B_blocks_STRIDE;',
    '    b_blocks[base + 1u] = f32(index % 8u) - 3.5;',
    '    b_blocks[base + 3u] = f32(index / 8u) - 3.5;',
    '    b_blocks[base + 7u] = 1.0;',
    '    b_blocks[base + 8u] = 1.0;',
    '    b_blocks[base + 9u] = 1.0;',
    '    b_blocks[base + 10u] = 1.0;',
    '}',
].join('\n');

/** A module client that answers every call with PLACE, echoing the job as the backend does. */
function fakeModules() {
    const calls = [];
    return {
        calls,
        async call(body, onEvent, signal) {
            signal.throwIfAborted();
            calls.push(structuredClone(body));
            const meta = {
                turnId: body.turnId, jobId: body.jobId, purpose: body.purpose, subject: body.subject, versions: body.versions, module: body.module.id,
                interfaceHash: body.module.interface.interfaceHash, generationId: `gen-${calls.length}`, model: 'm-1', source: 'live', role: 'module',
                promptVersion: `module.${body.purpose}.v1`,
            };
            onEvent({ type: 'meta', meta });
            const usage = { in: 100, out: 50, reasoning: null, cached: null, costMicroUsd: 1_000 };
            onEvent({ type: 'usage', usage });
            return { status: 'ok', meta, answer: PLACE, answerSha256: sha(PLACE), usage };
        },
    };
}

function machine(answer) {
    const { revise, requests } = reviserOver(answer);
    const modules = fakeModules();
    let n = 0;
    const session = createCandidateSession({ modules, revise, attemptId: () => `attempt-${++n}`, now: () => 1_000 }, () => {});
    return { session, modules, requests };
}

/** The hand-off turn's own calls, as the recorded hand-off made them: each reported its usage. */
const TURN_CALLS = ['first', 'after-tools', 'next'].map((purpose, i) => ({ n: i + 1, purpose, charge: 'known', costMicroUsd: 46_000, generationId: `gen-${i + 1}` }));
const handOff = (over = {}) => ({
    turnId: 'turn-0', request: R, design: DESIGN, program: BASE_PROGRAM, model: 'muse-spark-1.3', promptVersion: 'agent.v5', calls: TURN_CALLS, ...over,
});

test('EA-MR3 a program the browser refuses is revised over the recorded wire, resolved again, authored and static-verified; Q_C counts the revision\'s calls', async () => {
    const { session, modules, requests } = machine(res(REVISED));
    const end = await session.start(handOff());

    assert.equal(end.phase, 'static-verified', JSON.stringify(end.stop));
    // The interface refusal went to the program, as one revision carrying R, S, W and that finding by its id.
    const refusal = end.evidence.find(e => e.phase === 'interface' && e.verdict === 'fail');
    assert.deepEqual(refusal.findings.map(f => [f.code, f.path]), [['EA_RESOLVE', '/nodes/6/config/module']]);
    assert.equal(requests.length, 1);
    const sent = JSON.parse(requests[0].body);
    assert.deepEqual([sent.prompt, sent.style, sent.seconds], [R.prompt, R.style, R.seconds]);
    assert.deepEqual([sent.base.design, sent.base.program], [DESIGN, BASE_PROGRAM]);
    assert.deepEqual(sent.base.findings.map(f => [f.id, f.code, f.path]), [...refusal.findings.map(f => [f.id, f.code, f.path]), ['q_c.repairs', 'EA_REPAIR_BUDGET', null]]);
    assert.match(sent.base.findings[0].message, /^step cannot be an entry/);
    // W replaced whole and resolved again; its module authored under the revision's turn, once.
    assert.deepEqual(end.program, PROGRAM);
    assert.equal(end.turnId, 'turn-1');
    assert.deepEqual(modules.calls.map(c => [c.module.id, c.purpose, c.turnId]), [['place', 'author', 'turn-1']]);
    assert.equal(modules.calls[0].subject.graph, end.graph);
    // Q_C: the turn's 3, the revision's six reserved and reconciled to its 1, one author; no counter reset.
    assert.deepEqual(end.budget.calls, { settled: 5, reserved: 0, unknown: 0 });
    assert.deepEqual([end.budget.revisions, end.budget.authors], [1, 1]);
    assert.deepEqual(end.verified, { id: end.id, revision: end.revision });
    assert.equal(session.snapshot.id, end.id);
});

test('EA-MR3b a revision\'s hand-off that changed S replaces nothing; a revision whose stream fails keeps its six calls unknown', async () => {
    // S as this candidate was handed it differs from the recording's: the revision hands off the recording's.
    const changed = machine(res(REVISED));
    const ended = await changed.session.start(handOff({ design: { ...DESIGN, intent: 'a forest instead' } }));
    assert.deepEqual([ended.phase, ended.stop.scope], ['failed', 'design']);
    assert.match(ended.stop.diagnostic, /^the program revision changed the design \(S\), which a program revision may not: no replacement$/);
    assert.equal(JSON.parse(changed.requests[0].body).base.design.intent, 'a forest instead', 'the base carried S as handed off');
    assert.deepEqual(ended.program, BASE_PROGRAM, 'no replacement');
    assert.deepEqual([ended.budget.calls, ended.budget.revisions], [{ settled: 4, reserved: 0, unknown: 0 }, 1]);
    assert.equal(changed.modules.calls.length, 0);

    // The revision's stream ends in its own error: the candidate stops, the revision's whole reservation unknown.
    const broken = machine(res(wire('error-upstream.sse')));
    const failed = await broken.session.start(handOff());
    assert.deepEqual([failed.phase, failed.stop.scope, failed.stop.sentence], ['failed', 'host', COPY.candidate.stream]);
    assert.match(failed.stop.diagnostic, /^revision: .*; charge unknown$/);
    assert.deepEqual([failed.budget.calls, failed.budget.revisions], [{ settled: 3, reserved: 0, unknown: 6 }, 1]);
    assert.deepEqual(failed.program, BASE_PROGRAM);
});

// The EA4.5 review: a revision's calls were counted in Q_C and kept nowhere else, so neither Developer view nor the bundle
// could say what they cost, which model made them or under which template. The hand-off turn's own were a count too.
const revisionCall = { n: 1, purpose: 'revise', charge: 'known', costMicroUsd: 46_000, generationId: 'gen-1' };

test('EA-MR5 the EA4.5 review: the hand-off\'s turn and a revision\'s are kept, each call with its charge, model and template, and the bundle holds them', async () => {
    // Browser refusal, program revision over the recorded wire, the module authored, static-verified; then the bundle.
    const { session } = machine(res(REVISED));
    const end = await session.start(handOff());
    assert.equal(end.phase, 'static-verified', JSON.stringify(end.stop));
    assert.deepEqual(end.turns, [
        { role: 'hand-off', turnId: 'turn-0', revision: 0, status: 'handed-off', model: 'muse-spark-1.3', promptVersion: 'agent.v5', charge: 'known', calls: TURN_CALLS, error: null },
        { role: 'revision', turnId: 'turn-1', revision: 1, status: 'handed-off', model: 'muse-spark-1.3', promptVersion: 'agent.v6', charge: 'known', calls: [revisionCall], error: null },
    ]);
    // Q_C reconciles from the records: each call it settled has one, the turns' and the module job's.
    assert.equal(end.turns.reduce((n, t) => n + t.calls.length, 0) + end.jobs.length, end.budget.calls.settled);
    const bundle = candidateBundle(end);
    // v3 since Q113 (a) (EA6.4): the reviews of the stage beside the turns.
    assert.equal(bundle.format, 'wexy-candidate-bundle.v3');
    assert.deepEqual(bundle.calls.turns, end.turns);
    // The hand-off's template (this test's), the revision's as recorded (agent.v6 since EA6.3), the module's (this test's).
    assert.deepEqual(bundle.versions.templates, ['agent.v5', 'agent.v6', 'module.author.v1']);
    const spent = [...bundle.calls.turns.flatMap(t => t.calls), ...bundle.calls.jobs].reduce((sum, c) => sum + c.costMicroUsd, 0);
    assert.equal(spent, 3 * 46_000 + 46_000 + 1_000, 'the hand-off\'s three calls, the revision\'s one, the author');

    // A revision whose stream fails: its calls as they came, the turn's charge unknown, its error; Q_C holds its six unknown.
    const broken = machine(res(wire('error-upstream.sse')));
    const failed = await broken.session.start(handOff());
    assert.deepEqual([failed.phase, failed.budget.calls], ['failed', { settled: 3, reserved: 0, unknown: 6 }]);
    const said = eventData(wire('error-upstream.sse'), 'error')[0].message;
    assert.deepEqual(failed.turns[1], {
        role: 'revision', turnId: 'turn-1', revision: 1, status: 'broken', model: 'muse-spark-1.3', promptVersion: 'agent.v6', charge: 'unknown',
        // Its first call and its two schema repairs (2026-11-04).
        calls: [{ ...revisionCall, purpose: 'first' }, { ...revisionCall, n: 2, purpose: 'repair', generationId: 'gen-2' }, { ...revisionCall, n: 3, purpose: 'repair', generationId: 'gen-3' }], error: said,
    });
    assert.equal(candidateBundle(failed).calls.turns[1].charge, 'unknown');

    // Refused before any stream (an envelope): no meta, no call, the refusal's words; still unknown, as Q_C keeps it.
    const envelope = new Response('{"code":"bad-request","message":"base.versions.manifest is not this server\'s."}', { status: 400, headers: { 'Content-Type': 'application/json' } });
    const refused = await machine(envelope).session.start(handOff());
    assert.deepEqual(refused.turns[1], {
        role: 'revision', turnId: null, revision: 1, status: 'refused', model: null, promptVersion: null, charge: 'unknown', calls: [],
        error: 'base.versions.manifest is not this server\'s.',
    });

    // A cancel while the revision runs, over a reviser that honours it and over one deaf to it: nothing its turn says
    // after the cancel is kept or shown; its record ends cancelled, its charge unknown.
    for (const deafToIt of [false, true]) {
        let release, emitted;
        const gate = new Promise(r => { release = r; });
        const started = new Promise(r => { emitted = r; });
        const reviser = async (_request, signal, onEvent) => {
            onEvent({ type: 'meta', meta: eventData(REVISED, 'meta')[0] });
            onEvent({ type: 'call', call: { n: 1, purpose: 'revise' } });
            emitted();
            if (!deafToIt) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
            await gate;
            onEvent({ type: 'usage', usage: { n: 1, generationId: 'gen-late', in: 1, out: 1, reasoning: null, cached: null, costMicroUsd: 46_000 } });
            onEvent({ type: 'call', call: { n: 2, purpose: 'repair' } });
            return { status: 'handed-off', turnId: 'turn-1', design: DESIGN, program: PROGRAM, repairs: [], calls: 2 };
        };
        const states = [];
        const cancelled = createCandidateSession({ modules: fakeModules(), revise: reviser, attemptId: () => 'attempt-c', now: () => 1_000 }, s => states.push(s));
        const running = cancelled.start(handOff());
        await started;
        const before = states.at(-1);
        assert.deepEqual([before.phase, before.turns[1].status, before.turns[1].turnId, before.turns[1].calls],
            ['correcting', 'running', 'turn-1', [{ n: 1, purpose: 'revise', charge: 'unknown', costMicroUsd: null, generationId: null }]], 'the revision shows as it runs');
        cancelled.cancel();
        const atCancel = states.at(-1);
        release();
        const ended = await running;
        assert.equal(states.at(-1), atCancel, `nothing published after the cancel (deaf: ${deafToIt})`);
        assert.deepEqual(ended.turns[1].calls, before.turns[1].calls, `no late event kept (deaf: ${deafToIt})`);
        assert.deepEqual([ended.phase, ended.turns[1].status, ended.turns[1].charge], ['cancelled', 'cancelled', 'unknown'], `deaf: ${deafToIt}`);
    }

    // A hand-off call that reported no usage: its record says so, and the hand-off's turn is unknown.
    assert.deepEqual(turnCallsOf([{ n: 1, purpose: 'first', usage: null }, { n: 2, purpose: 'next', usage: { generationId: 'gen-2', costMicroUsd: 9 } }]), [
        { n: 1, purpose: 'first', charge: 'unknown', costMicroUsd: null, generationId: null }, { n: 2, purpose: 'next', charge: 'known', costMicroUsd: 9, generationId: 'gen-2' },
    ]);
    const unreported = await machine(res(REVISED)).session.start(handOff({ calls: [TURN_CALLS[0], { ...TURN_CALLS[1], charge: 'unknown', costMicroUsd: null, generationId: null }] }));
    assert.deepEqual([unreported.turns[0].charge, unreported.turns[1].charge, unreported.budget.calls.settled], ['unknown', 'known', 4]);
});

// The EA4.4 review: a world the server handed off could be too large for the base of its revision. The server now leaves
// every hand-off 2,048 bytes of the base's 64 KiB (its base-size); the browser fits the findings into what is left.
const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const PAD_CONFIG = '{"elements":64,"layout":"f32","strideFloats":4,"pingPong":false,"init":"zero"}';
const pad = (i, spaces) => ({ id: `pad${i}`, adapterId: 'ng.buffer.storage', adapterVersion: 1, config: PAD_CONFIG + ' '.repeat(spaces), inputs: [] });
/** The base program padded with unread buffers until design and program are `target` bytes, or just under it. */
function nearBound(target) {
    const nodes = [...BASE_PROGRAM.nodes];
    const size = () => bytesOf(DESIGN) + bytesOf({ nodes });
    for (let i = 0; ; i++) {
        nodes.push(pad(i, 0));
        const room = target - size();
        if (room < 0) { nodes.pop(); return { nodes }; }
        nodes[nodes.length - 1] = pad(i, Math.min(room, 4096 - PAD_CONFIG.length));
        if (size() >= target) return { nodes };
    }
}
const longFinding = (i) => ({ id: `ev-9.f${i}`, code: 'EA_RESOLVE', path: `/nodes/${i}/config/${'p'.repeat(150)}`, message: `${i}: ${'m'.repeat(390)}` });

test('EA-MR4 the EA4.4 review: a base is cut to the backend\'s bound; the findings give way, the last first, then the one left shortens; S and W never', async () => {
    const bound = BASE_CAPS.bytes - BASE_CAPS.margin;
    // At the size the server's base-size allows a hand-off, with 32 long findings: the later ones give way.
    const program = nearBound(BASE_CAPS.bytes - 2_048);
    const near = bytesOf(DESIGN) + bytesOf(program);
    assert.ok(near > BASE_CAPS.bytes - 2_048 - 200 && near <= BASE_CAPS.bytes - 2_048, `design and program: ${near} bytes`);
    const many = reviserOver(res(REVISED));
    await many.revise(request({ program, findings: Array.from({ length: 32 }, (_, i) => longFinding(i)) }), new AbortController().signal);
    const sent = JSON.parse(many.requests[0].body).base;
    assert.ok(bytesOf(sent) <= bound, `base: ${bytesOf(sent)} bytes`);
    assert.ok(sent.findings.length >= 1 && sent.findings.length < 32, `${sent.findings.length} findings`);
    assert.deepEqual(sent.findings, Array.from({ length: sent.findings.length }, (_, i) => longFinding(i)), 'the first ones, whole');
    assert.deepEqual([sent.design, sent.program], [DESIGN, program], 'S and W unchanged');
    // Closer than any hand-off comes: one finding is left, its message shortened from its end; nothing else changes.
    const tight = nearBound(bound - 500);
    const one = reviserOver(res(REVISED));
    await one.revise(request({ program: tight, findings: [longFinding(0), longFinding(1)] }), new AbortController().signal);
    const cut = JSON.parse(one.requests[0].body).base;
    assert.ok(bytesOf(cut) <= bound, `base: ${bytesOf(cut)} bytes`);
    assert.equal(cut.findings.length, 1);
    assert.ok(cut.findings[0].message.length < longFinding(0).message.length && longFinding(0).message.startsWith(cut.findings[0].message));
    assert.deepEqual({ ...cut.findings[0], message: null }, { ...longFinding(0), message: null });
    assert.deepEqual(cut.program, tight);
});

test('EA-MR6 a revision\'s notes to its modules (EA6.3) reach the machine as its stream had them, checked; a first turn\'s stream with notes is refused', async () => {
    const notes = eventData(wire('revised-notes.sse'), 'repairs')[0].repairs;
    assert.deepEqual(notes, [{ module: 'place', message: 'Lower every block by 2 units, so they stand on the ground.' }]);
    const result = await reviserOver(res(wire('revised-notes.sse'))).revise(request(), new AbortController().signal);
    assert.deepEqual([result.status, result.repairs], ['handed-off', notes]);
    // The same stream answering a first turn: no base, so no code to repair, and the reader refuses it.
    const first = fakeFetch(res(wire('revised-notes.sse')));
    const refused = await createAgentClient(createApi(CONFIG, identity(), first.fetchImpl)).turn(R, () => {}, new AbortController().signal).catch(e => e);
    assert.match(String(refused?.message), /a first turn handed off repairs/);
});

test('EA-MR7 a base finding is cut in code points, as the backend counts it: emoji kept whole, never half of one (the independent review of EA6.3)', async () => {
    const { revise, requests } = reviserOver(res(REVISED));
    const castles = { id: 'ev-9.f1', code: 'creator', path: null, message: '\u{1F3F0}'.repeat(450) };
    await revise(request({ findings: [FINDING, castles] }), new AbortController().signal);
    const sent = JSON.parse(requests[0].body).base.findings[1].message;
    assert.deepEqual([[...sent].length, sent.length], [400, 800]);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sent), false, 'no lone half of a pair');
});
