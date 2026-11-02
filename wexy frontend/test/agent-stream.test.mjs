// EA-S series, headless (EA2.5; the backend's agent-loop design §15.1, gate B1): the agent turn's stream
// (src/forge-client/agent-stream.ts) and its client (agent-client.ts), on the backend's own wire: the recordings its
// AgentWireTest writes (test/fixtures/agent-wire). Every way a turn ends, as recorded; then each recording broken the
// ways a network, a proxy or a bug could break it: cut, split, padded with heartbeats, reordered, malformed, oversized,
// quoting another bundle; then a cancel, the client's request and its deadline, and that nothing is ever sent twice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ADAPTER_MANIFEST_HASH } from '../src/contract/adapters/index.ts';
import { AGENT_DEADLINE_MS, createAgentClient, ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';
import { AGENT_STREAM_LIMITS, AgentVersionError, readAgentStream } from '../src/forge-client/agent-stream.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { createApi } from '../src/forge-client/http.ts';
import { readForgeStream } from '../src/forge-client/sse.ts';

const enc = new TextEncoder();
const wire = (name) => readFileSync(new URL(`./fixtures/agent-wire/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** The recordings that stream; denied.json is the envelope of a refused first charge. */
const STREAMS = ['handed-off', 'asked', 'declined', 'exhausted-revisions', 'exhausted-deadline', 'context-limit', 'error-budget', 'error-upstream'];

/** A body delivered in the given chunks (strings or bytes), as a network splits it; `state.cancelled` says if it was. */
function body(chunks, { keepOpen = false } = {}) {
    const state = { cancelled: false };
    const stream = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
            if (!keepOpen) controller.close();
        },
        cancel() { state.cancelled = true; },
    });
    return Object.assign(stream, { state });
}

/** A recording's events as [name, data] pairs, and pairs back to the wire as the backend writes it. */
const events = (text) => [...text.matchAll(/^event:(.*)\ndata:(.*)$/gm)].map(m => [m[1], m[2]]);
const sse = (pairs) => pairs.map(([e, d]) => `event:${e}\ndata:${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');
const res = (text, opts) => new Response(body([text], opts), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

async function read(text, options = {}) {
    const seen = [];
    const result = await readAgentStream(res(text), e => seen.push(e), { bundleHash: ENGINE_BUNDLE_HASH, ...options });
    return { result, seen };
}

/** The read's ForgeError, of `code` and matching `pattern`; a stream that is accepted fails the test. */
async function refuses(text, code, pattern, options = {}) {
    const error = await read(text, options).then(() => null, e => e);
    assert.ok(error, `accepted, but should fail ${code} ${pattern}`);
    assert.ok(error instanceof ForgeError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
}

const waitFor = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(condition(), 'waited a second for it');
};

test('EA-S1 every recorded way a turn ends reads to its typed result, each event handed on as it was checked', async () => {
    const handedOff = await read(wire('handed-off.sse'));
    assert.equal(handedOff.result.status, 'handed-off');
    assert.deepEqual(handedOff.seen.map(e => e.type), ['meta', 'call', 'usage', 'tools', 'call', 'usage', 'check', 'call', 'usage', 'check', 'design', 'program']);
    assert.deepEqual(handedOff.result.calls.map(c => [c.n, c.purpose, c.usage?.generationId, c.tools?.results.length ?? null, c.check?.ok ?? null]),
        [[1, 'first', 'gen-1', 2, null], [2, 'after-tools', 'gen-2', null, false], [3, 'revise', 'gen-3', null, true]]);
    assert.equal(handedOff.result.calls[1].check.findings[0].code, 'buffer-producer');
    assert.equal(handedOff.result.costMicroUsd, 3 * 46_000);
    assert.deepEqual(handedOff.result.meta, { turnId: 'turn-1', model: 'muse-spark-1.3', source: 'live', promptVersion: 'agent.v5', bundleHash: ENGINE_BUNDLE_HASH,
        actionSchema: 'agent-action.v2', manifestHash: ADAPTER_MANIFEST_HASH });
    const recorded = Object.fromEntries(events(wire('handed-off.sse')).filter(([e]) => e === 'design' || e === 'program').map(([e, d]) => [e, JSON.parse(d)[e]]));
    assert.deepEqual(handedOff.result.design, recorded.design);
    assert.deepEqual(handedOff.result.program, recorded.program);
    assert.ok(Object.isFrozen(handedOff.result.program.nodes[4].inputs), 'what was checked cannot change after');

    const asked = await read(wire('asked.sse'));
    assert.equal(asked.result.status, 'asked');
    assert.equal(asked.result.question, 'Blocks of stone, or of wood — and does the river run?');

    const declined = await read(wire('declined.sse'));
    assert.equal(declined.result.status, 'declined');
    assert.equal(declined.result.reason, 'That names no place or thing to show — I can\'t build a world from it.');

    const revisions = await read(wire('exhausted-revisions.sse'));
    assert.equal(revisions.result.status, 'exhausted');
    assert.equal(revisions.result.diagnostic, 'EA_TURN_BUDGET');
    assert.equal(revisions.result.reason, 'EA_TURN_BUDGET: the check still fails after 2 revisions');
    assert.deepEqual(revisions.result.calls.map(c => c.check.ok), [false, false, false]);

    // The turn's time ran out inside its call: no usage came, so the cost is unknown, never zero.
    const deadline = await read(wire('exhausted-deadline.sse'));
    assert.equal(deadline.result.status, 'exhausted');
    assert.equal(deadline.result.calls[0].usage, null);
    assert.equal(deadline.result.costMicroUsd, null);

    const limit = await read(wire('context-limit.sse'));
    assert.equal(limit.result.status, 'handed-off');
    assert.deepEqual(limit.result.calls.map(c => [c.tools?.round ?? null, c.tools?.error ?? null]), [[1, null], [2, null], [3, 'EA_CONTEXT_LIMIT'], [null, null]]);
    assert.deepEqual(limit.result.calls[2].tools.results, []);
});

test('EA-S2 the recorded failures are the backend\'s own errors, after everything before them was handed on', async () => {
    const budget = await read(wire('error-budget.sse')).catch(e => e);
    assert.ok(budget instanceof ForgeError);
    assert.equal(budget.code, 'budget');
    assert.equal(budget.message, 'Live creation has reached its spending limit for now.');
    const seen = [];
    await readAgentStream(res(wire('error-budget.sse')), e => seen.push(e), { bundleHash: ENGINE_BUNDLE_HASH }).catch(() => {});
    assert.deepEqual(seen.map(e => e.type), ['meta', 'call', 'usage', 'tools']);
    // No usage came for the first call, so its reservation stands as its cost, and its tokens are unknown.
    assert.deepEqual(seen[2].usage, { n: 1, generationId: 'gen-1', in: null, out: null, reasoning: null, cached: null, costMicroUsd: 156_247 });

    await refuses(wire('error-upstream.sse'), 'upstream', /missed the action schema after a repair/);
});

test('EA-S3 a turn split at every byte, or with heartbeats and comments between and inside its events, reads the same', async () => {
    const text = wire('handed-off.sse');
    const whole = (await read(text)).result;
    const bytes = [...enc.encode(text)].map(b => new Uint8Array([b]));
    const split = await readAgentStream(new Response(body(bytes)), () => {}, { bundleHash: ENGINE_BUNDLE_HASH });
    assert.deepEqual(split, whole);
    // The backend's heartbeat is a comment and a blank line between events; a lone comment line may sit inside one.
    const padded = `:hb\n\n${text.replace(/\n\n/g, '\n\n:hb\n\n').replace(/\ndata:/g, '\n: note\ndata:')}`;
    assert.deepEqual((await read(padded)).result, whole);
    assert.deepEqual((await read(text.replace(/\n/g, '\r\n'))).result, whole);
});

test('EA-S4 a turn cut before its last event, or inside it, fails as unavailable, never as an ending', async () => {
    for (const name of STREAMS) {
        const text = wire(`${name}.sse`);
        const last = text.lastIndexOf('event:');
        for (const cut of [last, last + 8, text.length - 1]) {
            await refuses(text.slice(0, cut), 'unavailable', /ended before its last event/);
        }
    }
});

test('EA-S5 meta comes first and once; an error before it is still the backend\'s; h1\'s reader never takes a turn', async () => {
    const pairs = events(wire('asked.sse'));
    await refuses(sse(pairs.slice(1)), 'internal', /the first event was "call", not meta/);
    await refuses(sse([pairs[0], ...pairs]), 'internal', /meta appeared more than once/);
    await refuses(sse([...pairs.slice(0, 3), pairs[0], ...pairs.slice(3)]), 'internal', /meta appeared more than once/);
    await refuses(sse([['error', { code: 'paused', message: 'Live creation is paused.' }]]), 'paused', /paused/);
    await refuses(sse([...pairs.slice(0, 2), ['error', { code: 'meltdown', message: 'm' }]]), 'internal', /^m$/);
    // A turn's meta names a turn, not a generation: h1's reader refuses it, so the two readers never mix.
    await assert.rejects(readForgeStream(res(wire('asked.sse'))), e => e instanceof ForgeError && e.code === 'internal' && /generationId/.test(e.message));
});

test('EA-S6 every payload is checked: not JSON, not an object, or a value of the wrong kind breaks the contract', async () => {
    const hand = events(wire('handed-off.sse'));
    // 0 meta, 1 call, 2 usage, 3 tools, 4 call, 5 usage, 6 check (fails), 7 call, 8 usage, 9 check (passes), 10 design, 11 program, 12 done
    const edit = (pairs, index, change) => sse(pairs.map(([e, d], i) => [e, i === index ? (typeof change === 'string' ? change : change(JSON.parse(d))) : d]));
    const asked = events(wire('asked.sse'));
    const revisions = events(wire('exhausted-revisions.sse'));
    const declined = events(wire('declined.sse'));
    const cases = [
        [edit(hand, 2, '{not json'), /not JSON/],
        [edit(hand, 1, '[1]'), /not an object/],
        [edit(hand, 0, m => ({ ...m, source: 'archive' })), /meta.source is "archive", not live/],
        [edit(hand, 0, m => ({ ...m, turnId: '' })), /"turnId"/],
        [edit(hand, 0, m => ({ ...m, bundleHash: 'abc' })), /"bundleHash"/],
        [edit(hand, 0, ({ promptVersion, ...m }) => m), /"promptVersion" is missing/],
        [edit(hand, 0, m => ({ ...m, actionSchema: 'v2' })), /"actionSchema"/],
        [edit(hand, 0, m => ({ ...m, manifestHash: 'abc' })), /"manifestHash"/],
        [edit(hand, 1, c => ({ ...c, n: '1' })), /"n" is not a whole number/],
        [edit(hand, 1, c => ({ ...c, purpose: '<b>first</b>' })), /"purpose"/],
        [edit(hand, 2, u => ({ ...u, in: -1 })), /"in" is not a whole number of at least 0/],
        [edit(hand, 2, u => ({ ...u, out: 1.5 })), /"out"/],
        [edit(hand, 2, ({ costMicroUsd, ...u }) => u), /"costMicroUsd" is missing/],
        [edit(hand, 3, t => ({ ...t, results: [{ ...t.results[0], ok: 'yes' }] })), /"ok" is not true or false/],
        [edit(hand, 3, t => ({ ...t, results: [{ ...t.results[0], error: 'refused' }] })), /ok=true with an error/],
        [edit(hand, 3, t => ({ ...t, results: Array(7).fill(t.results[0]) })), /at most 6/],
        [edit(hand, 3, t => ({ ...t, error: 'EA_CONTEXT_LIMIT' })), /carries EA_CONTEXT_LIMIT and results/],
        [edit(hand, 6, c => ({ ...c, ok: true })), /check.ok is true, but 1 findings fail/],
        [edit(hand, 9, c => ({ ...c, ok: false })), /check.ok is false, but 0 findings fail/],
        [edit(hand, 6, c => ({ ...c, findings: [{ ...c.findings[0], level: 'error' }] })), /a finding's level is "error"/],
        [edit(hand, 10, d => ({ design: { ...d.design, extra: 1 } })), /the design leaves agent-action.v2: \/design\/extra: is not in the schema/],
        [edit(hand, 11, p => ({ program: { ...p.program, nodes: [] } })), /the program leaves agent-action.v2: \/program\/nodes: has 0 items, under 1/],
        [edit(hand, 12, () => ({ status: 'ok', reason: null })), /done.status is "ok"/],
        [edit(hand, 12, () => ({ status: 'handed-off', reason: 'because' })), /done handed-off carries a reason/],
        [edit(revisions, revisions.length - 1, () => ({ status: 'exhausted', reason: null })), /done exhausted needs a reason/],
        [edit(declined, declined.length - 1, () => ({ status: 'declined', reason: ' ' })), /done declined needs a reason/],
        [edit(asked, 3, () => ({ text: 'x'.repeat(401) })), /"text" is not a string of 1 to 400 characters/],
    ];
    for (const [text, pattern] of cases) await refuses(text, 'internal', pattern);
});

test('EA-S7 the events keep the loop\'s order, correlated by n: nothing early, late, twice, or for another call', async () => {
    const hand = events(wire('handed-off.sse'));
    const without = (...drop) => sse(hand.filter((_, i) => !drop.includes(i)));
    const insert = (at, ...pairs) => sse([...hand.slice(0, at), ...pairs, ...hand.slice(at)]);
    const asked = events(wire('asked.sse'));
    const budget = events(wire('error-budget.sse'));
    const cases = [
        [without(10, 11), /done handed-off came while the turn was passed, before a checked design and program/],
        [without(11), /done handed-off came while the turn was designed/],
        [without(9), /design came after the turn was answered/],
        [insert(7, hand[10]), /design came after the turn was acted/],
        [sse([...hand.slice(0, 10), hand[11], hand[10], hand[12]]), /program came after the turn was passed/],
        [insert(11, hand[10]), /design came after the turn was designed/],
        [without(2), /tools came after the turn was calling/],
        [without(1, 2, 3), /call 2 came after call 0/],
        [without(2, 3), /call came after the turn was calling/],
        [insert(3, hand[2]), /usage came after the turn was answered/],
        [insert(4, ['check', { n: 1, ok: true, findings: [] }]), /check came after the turn was acted/],
        [sse(hand.map(([e, d], i) => [e, i === 2 ? d.replace('"n":1', '"n":2') : d])), /usage names call 2, but call 1 is open/],
        [sse(hand.map(([e, d], i) => [e, i === 3 ? d.replace('"n":1', '"n":3') : d])), /tools names call 3, but call 1 is open/],
        [insert(10, ['question', { text: 'And?' }]), /question came after the turn was passed/],
        [sse([...asked.slice(0, 3), asked[4]]), /done asked came while the turn was answered, with no question/],
        [sse([...budget.slice(0, 4), ['done', { status: 'declined', reason: 'no' }]]), /done declined came while the turn was acted/],
        [sse([...hand.slice(0, 11), ['done', { status: 'exhausted', reason: 'EA_TURN_BUDGET: x' }]]), /done exhausted came while the turn was designed/],
        [sse([hand[0], ['done', { status: 'exhausted', reason: 'EA_TURN_BUDGET: x' }]]), /done exhausted came while the turn was opened/],
    ];
    for (const [text, pattern] of cases) await refuses(text, 'internal', pattern);
});

test('EA-S8 the turn\'s caps hold: each event\'s own, the count and the total, an unknown event\'s included', async () => {
    const text = wire('handed-off.sse');
    const hand = events(text);
    const limits = (change) => ({ limits: { ...AGENT_STREAM_LIMITS, ...change } });
    await refuses(text, 'upstream', /passed 5 events/, limits({ events: 5 }));
    await refuses(text, 'upstream', /passed 2000 characters/, limits({ totalChars: 2_000 }));
    await refuses(text, 'upstream', /An agent program event passed 1000 characters/, limits({ eventChars: { ...AGENT_STREAM_LIMITS.eventChars, program: 1_000 } }));
    await refuses(sse([hand[0], ['call', { n: 1, purpose: 'first', pad: 'x'.repeat(300) }], ...hand.slice(2)]), 'upstream', /An agent call event passed 256 characters/);
    // Unknown events are skipped, but each is capped and counted, so a flood of them cannot grow a turn.
    await refuses(sse([hand[0], ...Array(300).fill(['progress', { pct: 1 }]), ...hand.slice(1)]), 'upstream', /passed 256 events/);
    await refuses(sse([hand[0], ['progress', 'x'.repeat(5_000)], ...hand.slice(1)]), 'upstream', /An agent progress event passed 4096 characters/);
    await refuses(sse([hand[0], ['toString', 'x'.repeat(5_000)], ...hand.slice(1)]), 'upstream', /An agent toString event passed 4096 characters/);
    // And an SSE line past the parser's own bound stops the read before it is held whole.
    await refuses(`${sse([hand[0]])}event:program\ndata:${'x'.repeat(262_200)}`, 'upstream', /An SSE event passed 262144 characters/);
});

test('EA-S9 an event this reader does not know is skipped wherever it comes: additive, by contract', async () => {
    const hand = events(wire('handed-off.sse'));
    const mixed = sse(hand.flatMap((p, i) => (i === 0 ? [p] : [['progress', { step: i }], p])));
    const { result, seen } = await read(mixed);
    assert.equal(result.status, 'handed-off');
    assert.equal(seen.length, 12);
});

test('EA-S10 a turn quoting another engine bundle is refused at its meta and cancelled: nothing of it is handed on', async () => {
    const b = body([wire('handed-off.sse')], { keepOpen: true });
    const seen = [];
    const error = await readAgentStream(new Response(b), e => seen.push(e), { bundleHash: 'f'.repeat(64) }).catch(e => e);
    assert.ok(error instanceof AgentVersionError && error instanceof ForgeError, String(error));
    assert.match(error.message, /^EA_VERSION_MISMATCH bundle d923cc218830, runtime ffffffffffff: /);
    assert.deepEqual([error.identity, error.server], ['bundle', ENGINE_BUNDLE_HASH]);
    assert.deepEqual(seen, []);
    assert.equal(b.state.cancelled, true);
});

test('EA-S11 a cancel mid-turn rejects with its AbortError and cancels the body; nothing said after it is handed on', { timeout: 5_000 }, async () => {
    let push = null;
    const state = { cancelled: false };
    const stream = new ReadableStream({
        start(c) { push = (t) => { try { c.enqueue(enc.encode(t)); } catch { /* cancelled */ } }; },
        cancel() { state.cancelled = true; },
    });
    const hand = events(wire('handed-off.sse'));
    const controller = new AbortController();
    const seen = [];
    const reading = readAgentStream(new Response(stream), e => seen.push(e.type), { bundleHash: ENGINE_BUNDLE_HASH, signal: controller.signal }).catch(e => e);
    push(sse(hand.slice(0, 3)));
    await waitFor(() => seen.length === 3);
    controller.abort();
    push(sse(hand.slice(3)));
    const error = await reading;
    assert.equal(error.name, 'AbortError');
    assert.deepEqual(seen, ['meta', 'call', 'usage']);
    assert.equal(state.cancelled, true);
});

const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };

function fakeIdentity() {
    const calls = [];
    let n = 0;
    return {
        calls,
        async authorization(forceRefresh) { calls.push(`auth${forceRefresh ? ' (refresh)' : ''}`); return `Bearer id-${++n}`; },
        async appCheck(singleUse) { calls.push(singleUse ? 'appcheck single-use' : 'appcheck cached'); return `ac-${++n}`; },
    };
}

function fakeFetch(...answers) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, method: init.method, headers: Object.fromEntries(init.headers.entries()), body: init.body });
        const next = answers.shift();
        if (!next) throw new Error(`no answer left for request ${requests.length}`);
        return typeof next === 'function' ? next() : next;
    };
    return { fetchImpl, requests };
}

const turn = (client, req = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 }, signal = new AbortController().signal) =>
    client.turn(req, () => {}, signal);

test('EA-S12 a turn is one POST of exactly its three fields, signed in, with a fresh single-use App Check token', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(res(wire('asked.sse')));
    const client = createAgentClient(createApi(CONFIG, identity, fetchImpl));
    const result = await turn(client, { prompt: 'a storm', style: 'cinematic', seconds: 12, image: 'data:image/png;base64,AA', budget: 99 });
    assert.equal(result.status, 'asked');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://localhost:8400/v1/agent/turn');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].body, '{"prompt":"a storm","style":"cinematic","seconds":12}');
    assert.equal(requests[0].headers.accept, 'text/event-stream');
    assert.equal(requests[0].headers['x-firebase-appcheck'], 'ac-2');
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use']);
});

test('EA-S13 only a 401 before the stream is retried, once, with a fresh App Check token; nothing else is sent twice', async () => {
    const identity = fakeIdentity();
    const retried = fakeFetch(new Response('{"code":"auth","message":"expired"}', { status: 401 }), res(wire('declined.sse')));
    assert.equal((await turn(createAgentClient(createApi(CONFIG, identity, retried.fetchImpl)))).status, 'declined');
    assert.equal(retried.requests.length, 2);
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use', 'auth (refresh)', 'appcheck single-use']);
    assert.notEqual(retried.requests[0].headers['x-firebase-appcheck'], retried.requests[1].headers['x-firebase-appcheck']);

    // A refused first charge is an envelope before any stream: its code and status, and not one event.
    const denied = JSON.parse(wire('denied.json'));
    const envelope = () => new Response(JSON.stringify(denied.body), { status: denied.status, headers: { 'Content-Type': 'application/json' } });
    const failures = [
        [envelope, 'budget', 503],
        [() => new Response('<html>Bad gateway</html>', { status: 502 }), 'upstream', 502],
        [() => res(wire('error-upstream.sse')), 'upstream', 200],
        [() => res(wire('error-budget.sse')), 'budget', 200],
        [() => res(wire('handed-off.sse').slice(0, 900)), 'unavailable', 200],
    ];
    for (const [answer, code, status] of failures) {
        const { fetchImpl, requests } = fakeFetch(answer, answer);
        const seen = [];
        const error = await createAgentClient(createApi(CONFIG, fakeIdentity(), fetchImpl)).turn({ prompt: 'x', style: 'auto', seconds: 12 }, e => seen.push(e), new AbortController().signal).catch(e => e);
        assert.ok(error instanceof ForgeError, String(error));
        assert.deepEqual([error.code, error.status], [code, status], error.message);
        assert.equal(requests.length, 1, `${code}: no replay once a turn may have started`);
        if (status !== 200) assert.deepEqual(seen, []);
    }

    // A cancel is the caller's own AbortError, never an error of the turn's.
    const controller = new AbortController();
    const open = fakeFetch(() => { controller.abort(); return res(wire('asked.sse'), { keepOpen: true }); });
    const cancelled = await turn(createAgentClient(createApi(CONFIG, fakeIdentity(), open.fetchImpl)), undefined, controller.signal).catch(e => e);
    assert.equal(cancelled.name, 'AbortError');
});

test('EA-S14 the deadline is absolute: heartbeats through a silence never extend it, and it ends the turn as a timeout', { timeout: 5_000 }, async () => {
    assert.equal(AGENT_DEADLINE_MS, 315_000, 'the server\'s 300 s, a call in flight included, and 15 s for the last event');
    const hand = events(wire('handed-off.sse'));
    let timer = 0;
    const state = { cancelled: false };
    const silent = () => new Response(new ReadableStream({
        start(c) {
            c.enqueue(enc.encode(sse(hand.slice(0, 2))));
            // Unref'd: if a broken cancel never stops this fake server, the test still ends at its timeout.
            timer = setInterval(() => { try { c.enqueue(enc.encode(':hb\n\n')); } catch { /* cancelled */ } }, 10).unref();
        },
        cancel() { state.cancelled = true; clearInterval(timer); },
    }), { status: 200 });
    const { fetchImpl } = fakeFetch(silent);
    const client = createAgentClient(createApi(CONFIG, fakeIdentity(), fetchImpl), { deadlineMs: 150 });
    const t0 = performance.now();
    const error = await turn(client).catch(e => e);
    const ms = performance.now() - t0;
    clearInterval(timer);
    assert.ok(error instanceof ForgeError && error.code === 'timeout', String(error));
    assert.match(error.message, /no last event within 0 s/);
    assert.ok(ms >= 140 && ms < 1_000, `the turn ended after ${Math.round(ms)} ms`);
    assert.equal(state.cancelled, true);
});

// EA2.5's review (2026-10-29): four boundary defects, each reproduced here before it was fixed.

test('EA-S15 a stalled sign-in or App Check token is bounded too: the deadline and a cancel end the turn, and nothing is sent', { timeout: 5_000 }, async () => {
    const never = () => new Promise(() => {});
    const stalled = (which) => ({ authorization: which === 'auth' ? never : async () => 'Bearer id', appCheck: which === 'appcheck' ? never : async () => 'ac' });
    for (const which of ['auth', 'appcheck']) {
        const timed = fakeFetch(res(wire('asked.sse')));
        const t0 = performance.now();
        const error = await turn(createAgentClient(createApi(CONFIG, stalled(which), timed.fetchImpl), { deadlineMs: 30 })).catch(e => e);
        assert.ok(error instanceof ForgeError && error.code === 'timeout', `${which}: ${error}`);
        assert.ok(performance.now() - t0 < 1_000, `${which}: the deadline held`);
        assert.equal(timed.requests.length, 0);

        const cancelled = fakeFetch(res(wire('asked.sse')));
        const controller = new AbortController();
        const pending = turn(createAgentClient(createApi(CONFIG, stalled(which), cancelled.fetchImpl)), undefined, controller.signal).catch(e => e);
        setTimeout(() => controller.abort(), 20);
        assert.equal((await pending).name, 'AbortError', which);
        assert.equal(cancelled.requests.length, 0);
    }
});

test('EA-S16 every schema-valid design fits the wire: escaping can grow it far past its schema\'s lengths', async () => {
    const hand = events(wire('handed-off.sse'));
    const design = JSON.parse(hand[10][1]).design;
    // A control character is one code point to the schema and six characters as JSON.
    const c = (n) => '\u0001'.repeat(n);
    design.techniques = Array.from({ length: 12 }, () => ({ purpose: c(240), symbols: Array(12).fill(c(80)), docIds: Array(6).fill(c(60)) }));
    const data = JSON.stringify({ design });
    assert.ok(data.length > 65_536 && data.length < 262_144, `${data.length} characters`);
    const { result } = await read(sse([...hand.slice(0, 10), ['design', data], ...hand.slice(11)]));
    assert.equal(result.status, 'handed-off');
    assert.equal(result.design.techniques[0].purpose.length, 240);
});

test('EA-S17 what a callback is handed is frozen: it cannot change the checked result', async () => {
    const attempts = [];
    const tamper = (change) => { try { change(); attempts.push('changed'); } catch { attempts.push('refused'); } };
    const result = await readAgentStream(res(wire('handed-off.sse')), (e) => {
        if (e.type === 'meta') tamper(() => { e.meta.bundleHash = 'f'.repeat(64); });
        if (e.type === 'usage') tamper(() => { e.usage.costMicroUsd = 0; });
        if (e.type === 'tools') tamper(() => { e.tools.results[0].ok = false; });
        if (e.type === 'check' && e.check.ok) tamper(() => { e.check.ok = false; e.check.findings.push({ level: 'fail' }); });
    }, { bundleHash: ENGINE_BUNDLE_HASH });
    assert.deepEqual(attempts, ['refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    assert.equal(result.costMicroUsd, 138_000);
    assert.deepEqual(result.calls[2].check, { n: 3, ok: true, findings: [] });
    assert.equal(result.meta.bundleHash, ENGINE_BUNDLE_HASH);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.calls[0]));
});

test('EA-S18 a cancel from inside a callback stops the turn, though its other events were already parsed', async () => {
    const controller = new AbortController();
    const seen = [];
    const error = await readAgentStream(res(wire('asked.sse')), (e) => {
        seen.push(e.type);
        if (e.type === 'meta') controller.abort();
    }, { bundleHash: ENGINE_BUNDLE_HASH, signal: controller.signal }).catch(e => e);
    assert.equal(error.name, 'AbortError');
    assert.deepEqual(seen, ['meta']);
});

// EA3.6: the turn names its action contract and the adapter manifest it was checked against, and both are this build's.

test('EA-S19 a turn of another action contract or adapter manifest is refused at its meta, a v1 server\'s among them: nothing of it is handed on', async () => {
    const hand = events(wire('handed-off.sse'));
    const editMeta = (change) => sse(hand.map(([e, d], i) => [e, i === 0 ? change(JSON.parse(d)) : d]));
    // EA2's recorded hand-off (test/fixtures/agent-wire-v1): a server before EA3.6 names no contract, and speaks v1. The
    // archive quotes the engine bundle of its day; it is read here as quoting this build's, so what refuses it is its
    // contract, not the bundle (which EA-S10 refuses on its own).
    const v1 = readFileSync(new URL('./fixtures/agent-wire-v1/handed-off.sse', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
        .replace(/"bundleHash":"[0-9a-f]{64}"/, `"bundleHash":"${ENGINE_BUNDLE_HASH}"`);
    const cases = [
        [v1, 'actionSchema', 'none', /^EA_VERSION_MISMATCH actionSchema none, runtime agent-action\.v2: .*speaks agent-action\.v1/],
        [editMeta(m => ({ ...m, actionSchema: 'agent-action.v3' })), 'actionSchema', 'agent-action.v3', /^EA_VERSION_MISMATCH actionSchema agent-action\.v3, runtime agent-action\.v2: /],
        [editMeta(m => ({ ...m, manifestHash: 'f'.repeat(64) })), 'manifest', 'f'.repeat(64), /^EA_VERSION_MISMATCH manifest ffffffffffff, runtime 3c7775588fb8: /],
        [editMeta(({ manifestHash, ...m }) => m), 'manifest', 'none', /^EA_VERSION_MISMATCH manifest none, runtime 3c7775588fb8: /],
    ];
    for (const [text, identity, server, pattern] of cases) {
        const b = body([text], { keepOpen: true });
        const seen = [];
        const error = await readAgentStream(new Response(b), e => seen.push(e), { bundleHash: ENGINE_BUNDLE_HASH }).catch(e => e);
        assert.ok(error instanceof AgentVersionError && error instanceof ForgeError, String(error));
        assert.deepEqual([error.identity, error.server, error.code], [identity, server, 'internal']);
        assert.match(error.message, pattern);
        assert.deepEqual(seen, [], 'nothing of the turn is handed on');
        assert.equal(b.state.cancelled, true);
    }
    // The pin held is the build's own: a build with another manifest refuses this server's turn.
    const other = await read(wire('handed-off.sse'), { manifestHash: 'e'.repeat(64) }).catch(e => e);
    assert.ok(other instanceof AgentVersionError, String(other));
    assert.deepEqual([other.identity, other.client], ['manifest', 'e'.repeat(64)]);
});
