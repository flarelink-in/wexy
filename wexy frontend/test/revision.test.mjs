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
import { createCandidateSession } from '../src/loop/candidate.ts';
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
    assert.deepEqual(Object.keys(sent.base), ['versions', 'design', 'program', 'findings']);
    assert.deepEqual(sent.base.versions, { actionSchema: 'agent-action.v2', bundle: ENGINE_BUNDLE_HASH, manifest: ADAPTER_MANIFEST_HASH });
    assert.deepEqual(sent.base.versions, { ...TURN_VERSIONS });
    assert.deepEqual([sent.base.design, sent.base.program], [DESIGN, BASE_PROGRAM], 'S and W as handed off');
    // Cut to the backend's caps (AgentBase), so a base is never refused for a finding's length or their number.
    assert.equal(sent.base.findings.length, BASE_CAPS.findings);
    assert.deepEqual(sent.base.findings[0], FINDING);
    assert.deepEqual(sent.base.findings[1], { id: 'x'.repeat(64), code: 'c'.repeat(40), path: `/${'p'.repeat(199)}`, message: 'm'.repeat(400) });
    // The recorded revision: one call, the revise; its hand-off with the revision's own turn id and that call.
    assert.deepEqual(eventData(REVISED, 'call').map(c => c.purpose), ['revise']);
    assert.deepEqual(eventData(REVISED, 'meta')[0].promptVersion, 'agent.v4');
    assert.deepEqual(result, { status: 'handed-off', turnId: 'turn-1', design: DESIGN, program: PROGRAM, calls: 1 });
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

const handOff = (over = {}) => ({ turnId: 'turn-0', request: R, design: DESIGN, program: BASE_PROGRAM, turnCalls: 3, ...over });

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
    assert.deepEqual(sent.base.findings.map(f => [f.id, f.code, f.path]), refusal.findings.map(f => [f.id, f.code, f.path]));
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
