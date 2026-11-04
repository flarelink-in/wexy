// EA-W11 to W15, headless (EA4.3; candidate-loop-design.md §5, §6, §8): a module call's stream
// (src/forge-client/module-stream.ts) and its client (module-client.ts), on the backend's own wire: the recordings its
// ModuleRoutesTest writes (test/fixtures/module-wire). Every recorded way a call ends; then each recording broken the
// ways a network, a proxy or a bug could break it: another job's echo, out of order, a done whose hash is not the deltas',
// cut, oversized; then the client's request (exactly eleven fields, a fresh single-use App Check token, never sent twice),
// its cancel and its deadline; then the wire's own helpers. No backend runs, no GPU, no call.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BODY_DIAL } from '../src/contract/adapters/bodies.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { unfence } from '../src/contract/unfence.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { createApi } from '../src/forge-client/http.ts';
import {
    MODULE_DEADLINE_MS, MODULE_VERSIONS, OMITTED_CODE, PREVIOUS_CAPS, cappedPrevious, createModuleClient, moduleNodes, wireInterface,
} from '../src/forge-client/module-client.ts';
import { MODULE_STREAM_LIMITS, ModuleStreamError, readModuleStream } from '../src/forge-client/module-stream.ts';

const BACKEND = 'D:/orion-realms/wexy/wexy backend/forge-service/src';
const onDisk = { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' };
const enc = new TextEncoder();
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const wire = (name) => readFileSync(new URL(`./fixtures/module-wire/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** A recording's events as [name, data] pairs, and pairs back to the wire as the backend writes it. */
const events = (text) => [...text.matchAll(/^event:(.*)\ndata:(.*)$/gm)].map(m => [m[1], m[2]]);
const sse = (pairs) => pairs.map(([e, d]) => `event:${e}\ndata:${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');

/** A body delivered in the given chunks, as a network splits it; `state.cancelled` says if it was. */
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
const res = (text, opts) => new Response(body([text], opts), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

/** The job a recording answers: what the browser sent, as its meta echoes it. */
function jobOf(name) {
    const meta = JSON.parse(events(wire(name))[0][1]);
    return { turnId: meta.turnId, jobId: meta.jobId, purpose: meta.purpose, subject: meta.subject, versions: meta.versions, module: meta.module, interfaceHash: meta.interfaceHash };
}
const JOB = jobOf('author.sse');

async function read(text, job = JOB, options = {}) {
    const seen = [];
    const outcome = await readModuleStream(res(text), job, e => seen.push(e), options);
    return { outcome, seen };
}

/** The read's ModuleStreamError, matching `pattern`, with the charge it states; a stream that is accepted fails the test. */
async function broken(text, pattern, charge = 'unknown', job = JOB, code = 'internal') {
    const seen = [];
    const error = await readModuleStream(res(text), job, e => seen.push(e)).then(() => null, e => e);
    assert.ok(error, `accepted, but should break: ${pattern}`);
    assert.ok(error instanceof ModuleStreamError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    assert.match(error.message, new RegExp(`^EA_MODULE_STREAM ${job.jobId}: .*; charge ${charge}$`));
    assert.equal(error.charge, charge);
    return { error, seen };
}

test('EA-W11 every recorded way a module call ends reads to its outcome: the whole body on a matching done, the call\'s own error otherwise', async () => {
    const author = await read(wire('author.sse'));
    const deltas = events(wire('author.sse')).filter(([e]) => e === 'delta').map(([, d]) => JSON.parse(d).text);
    assert.equal(author.outcome.status, 'ok');
    assert.equal(author.outcome.answer, unfence(deltas.join('')));
    assert.deepEqual([author.outcome.answer.length, sha(author.outcome.answer)], [758, 'f7e5f973dc3a33bddf8fcea42104dec6e6d7f5efd7ef4489e3cc99c0cd943a07']);
    assert.equal(author.outcome.answerSha256, sha(author.outcome.answer));
    assert.deepEqual(author.outcome.usage, { in: 9000, out: 1500, reasoning: 900, cached: null, costMicroUsd: 17625 });
    assert.deepEqual(author.seen.map(e => e.type), ['meta', 'delta', 'delta', 'delta', 'usage']);
    assert.deepEqual(author.seen.filter(e => e.type === 'delta').map(e => e.chars), [deltas[0].length, deltas[0].length + deltas[1].length, deltas.join('').length]);
    const meta = author.outcome.meta;
    assert.deepEqual({ ...meta, subject: { ...meta.subject }, versions: { ...meta.versions } }, {
        ...JOB, generationId: 'gen-1', model: 'm-1', source: 'live', role: 'module', promptVersion: 'module.author.v3',
    });
    assert.ok(Object.isFrozen(author.outcome) && Object.isFrozen(meta) && Object.isFrozen(meta.subject), 'what was checked cannot change after');

    const repair = await read(wire('repair.sse'), jobOf('repair.sse'));
    assert.equal(repair.outcome.status, 'ok');
    assert.equal(repair.outcome.meta.purpose, 'repair');
    assert.equal(repair.outcome.meta.subject.codeHash, '05e30ae0534aa299d1cfb3f5981e2230878000af2ebc1d3461cc20a5eccd2d67');

    for (const [name, says] of [['error-empty.sse', 'The model wrote nothing for this part.'], ['error-length.sse', 'The model ran out of room writing this part. Try a simpler world.']]) {
        const { outcome, seen } = await read(wire(name));
        assert.deepEqual([outcome.status, outcome.code, outcome.message], ['error', 'upstream', says], name);
        // The call was made and its usage reported: known, never a body.
        assert.equal(outcome.usage.costMicroUsd, 17625, name);
        assert.equal(outcome.answer, undefined, `${name}: no body`);
        assert.equal(seen.at(-1).type, 'usage', name);
    }

    // A fenced answer is unfenced as the backend's CodeBlocks.unfence does it, and done names the unfenced text.
    const [metaEvent, , , , usageEvent] = events(wire('author.sse'));
    const fenced = `Here is the body:\n\`\`\`wgsl\n${author.outcome.answer}\n\`\`\`\nIt places the blocks.`;
    const unfenced = await read(sse([metaEvent, ['delta', { text: fenced.slice(0, 40) }], ['delta', { text: fenced.slice(40) }], usageEvent,
        ['done', { status: 'ok', answerSha256: sha(author.outcome.answer), answerChars: author.outcome.answer.length }]]));
    assert.equal(unfenced.outcome.answer, author.outcome.answer);

    // Heartbeats and any split of the bytes read the same: one byte at a time, comments between events.
    const bytes = enc.encode(wire('author.sse').replace(/\n\nevent:/g, '\n\n: heartbeat\n\nevent:'));
    const split = await readModuleStream(new Response(body([...bytes].map(b => new Uint8Array([b]))), { status: 200 }), JOB, () => {});
    assert.equal(split.answer, author.outcome.answer);
});

test('EA-W12 a stream that answers another job is cancelled at meta, before any of its text is read', async () => {
    const pairs = events(wire('author.sse'));
    const meta = JSON.parse(pairs[0][1]);
    const withMeta = (m) => sse([['meta', m], ...pairs.slice(1)]);
    for (const [label, change, says] of [
        ['another turn', m => ({ ...m, turnId: 'turn-2' }), /its turnId is "turn-2"/],
        ['another job', m => ({ ...m, jobId: 'job-2' }), /its jobId is "job-2"/],
        ['another purpose', m => ({ ...m, purpose: 'repair' }), /its purpose is "repair"/],
        ['another module', m => ({ ...m, module: 'other' }), /its module is "other"/],
        ['another interface', m => ({ ...m, interfaceHash: '0'.repeat(64) }), /its interfaceHash is/],
        ['another body', m => ({ ...m, subject: { ...m.subject, codeHash: '1'.repeat(64) } }), /its subject differs/],
        ['another revision', m => ({ ...m, subject: { ...m.subject, revision: 1 } }), /its subject differs/],
        ['another ABI', m => ({ ...m, versions: { ...m.versions, abi: 'ea-abi.v1' } }), /its versions differs/],
        ['another checker', m => ({ ...m, versions: { ...m.versions, checker: 'ea4-body.v0' } }), /its versions differs/],
    ]) {
        const stream = res(withMeta(change(meta)));
        const seen = [];
        const error = await readModuleStream(stream, JOB, e => seen.push(e)).then(() => null, e => e);
        assert.ok(error instanceof ModuleStreamError, `${label}: ${error}`);
        assert.match(error.message, /meta echoes another job/, label);
        assert.match(error.message, says, label);
        assert.equal(error.charge, 'unknown', label);
        assert.deepEqual(seen, [], `${label}: nothing handed on`);
    }
    // Keys in another order are the same echo: the subject and the versions are compared as canonical JSON.
    const reordered = { ...meta, subject: Object.fromEntries(Object.entries(meta.subject).reverse()), versions: Object.fromEntries(Object.entries(meta.versions).reverse()) };
    assert.equal((await read(withMeta(reordered))).outcome.status, 'ok');
    await broken(withMeta({ ...meta, source: 'archive' }), /meta.source is "archive", not live/);
    await broken(withMeta({ ...meta, role: 'author' }), /meta.role is "author", not module/);
    await broken(withMeta({ ...meta, generationId: 'gen 1' }), /meta.generationId is not an id/);
    const { promptVersion, ...noVersion } = meta;
    assert.ok(promptVersion);
    await broken(withMeta(noVersion), /"promptVersion" is missing/);
});

test('EA-W13 a stream out of order, a done that is not the deltas\', or a stream cut short is EA_MODULE_STREAM, its charge stated; never a body', async () => {
    const pairs = events(wire('author.sse'));
    const [meta, d1, d2, d3, usage, done] = pairs;
    const doneData = JSON.parse(done[1]);
    await broken(sse([d1, meta, d2, d3, usage, done]), /the first event was "delta", not meta/);
    await broken(sse([meta, meta, d1, d2, d3, usage, done]), /meta appeared more than once/);
    await broken(sse([meta, d1, d2, usage, d3, done]), /a delta came after the usage/, 'known');
    await broken(sse([meta, d1, d2, d3, usage, usage, done]), /usage appeared more than once/, 'known');
    await broken(sse([['error', { code: 'upstream', message: 'x' }], meta]), /the first event was "error", not meta/);
    // done names another answer: a delta lost, a delta changed, the length or the hash moved.
    await broken(sse([meta, d1, d3, usage, done]), /done names an answer of 758 characters \(f7e5f973dc3a\), not the \d+ the deltas carry/, 'known');
    await broken(sse([meta, d1, ['delta', { text: JSON.parse(d2[1]).text.replace('0.5', '0.6') }], d3, usage, done]), /done names an answer/, 'known');
    await broken(sse([meta, d1, d2, d3, usage, ['done', { ...doneData, answerChars: 757 }]]), /done names an answer of 757 characters/, 'known');
    await broken(sse([meta, d1, d2, d3, usage, ['done', { ...doneData, answerSha256: '0'.repeat(64) }]]), /done names an answer/, 'known');
    await broken(sse([meta, d1, d2, d3, usage, ['done', { ...doneData, status: 'passed' }]]), /done.status is "passed", not ok/, 'known');
    await broken(sse([meta, d1, d2, d3, usage, ['done', { ...doneData, answerChars: BODY_DIAL.maxChars + 1 }]]), new RegExp(`done.answerChars is not 1 to ${BODY_DIAL.maxChars}`), 'known');
    await broken(sse([meta, ['delta', { text: 42 }], usage, done]), /"text" is not a string/);
    await broken(sse([meta, d1, d2, d3, ['usage', { in: 1, out: 1, reasoning: null, cached: null, costMicroUsd: -1 }], done]), /usage.costMicroUsd is not a whole number/);
    await broken(sse([meta, d1, d2, d3, ['usage', { in: 1.5, out: 1, reasoning: null, cached: null, costMicroUsd: 1 }], done]), /usage.in is not a whole number or null/);
    await broken(sse([meta, d1, d2, d3, usage]).replace(/data:\{"in"/, 'data:{in'), /an event's data is not JSON/);
    // Cut: the connection dropped before the terminal. Unknown before a usage came, known after.
    await broken(sse([meta, d1, d2]), /the stream ended before its done or error/, 'unknown', JOB, 'unavailable');
    await broken(sse([meta, d1, d2, d3, usage]), /the stream ended before its done or error/, 'known', JOB, 'unavailable');
    await broken('', /the stream ended before its done or error/, 'unknown', JOB, 'unavailable');
    // An event this reader does not know is skipped, and counted; done ends the read, whatever follows it.
    const extra = await read(sse([meta, ['progress', { pct: 50 }], d1, d2, d3, usage, done, ['delta', { text: 'more' }]]));
    assert.equal(extra.outcome.status, 'ok');
    assert.equal(extra.outcome.answer.length, 758);
    // The caps: an event over its own, too many events, an answer past the text bound.
    await broken(sse([meta, ['delta', { text: 'x'.repeat(MODULE_STREAM_LIMITS.eventChars.delta) }], usage, done]), /a delta event passed 65536 characters/);
    const tight = { ...MODULE_STREAM_LIMITS, events: 4 };
    const many = await readModuleStream(res(sse(pairs)), JOB, () => {}, { limits: tight }).then(() => null, e => e);
    assert.match(many.message, /it passed 4 events/);
    const short = { ...MODULE_STREAM_LIMITS, textChars: 300 };
    const long = await readModuleStream(res(sse(pairs)), JOB, () => {}, { limits: short }).then(() => null, e => e);
    assert.match(long.message, /the answer passed 300 characters/);
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
        return typeof next === 'function' ? next(init) : next;
    };
    return { fetchImpl, requests };
}

/** A request body for the recorded job, with a caller's extra field that must never be sent. */
function callBody(job = JOB, previous = null, note = null) {
    return {
        turnId: job.turnId, jobId: job.jobId, subject: job.subject, versions: job.versions, purpose: job.purpose,
        request: { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12, note: 'not sent' },
        design: { intent: 'blocks' }, nodes: [{ id: 'place', adapterId: 'ng.compute.stage', adapterVersion: 1, config: '{}', inputs: [] }],
        module: { id: job.module, kind: 'compute', interface: { interfaceHash: job.interfaceHash, abi: 'ea-abi.v2' }, extra: true },
        previous,
        note,
        unexpected: 'not sent',
    };
}

test('EA-W14 a module call is one POST of exactly the eleven fields, signed in, with a fresh single-use App Check token; a refusal is the envelope\'s', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(res(wire('author.sse')));
    const outcome = await createModuleClient(createApi(CONFIG, identity, fetchImpl)).call(callBody(), () => {}, new AbortController().signal);
    assert.equal(outcome.status, 'ok');
    assert.equal(requests.length, 1);
    const [r] = requests;
    assert.equal(r.url, 'http://localhost:8400/v1/agent/module');
    assert.equal(r.method, 'POST');
    assert.equal(r.headers.accept, 'text/event-stream');
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use']);
    const sent = JSON.parse(r.body);
    // The backend's ModuleRequest.FIELDS, exactly: a caller's own field is never sent (the server refuses any).
    assert.deepEqual(Object.keys(sent).sort(), ['design', 'jobId', 'module', 'nodes', 'note', 'previous', 'purpose', 'request', 'subject', 'turnId', 'versions']);
    assert.deepEqual(sent.request, { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 });
    assert.deepEqual(Object.keys(sent.module).sort(), ['id', 'interface', 'kind']);
    assert.equal(sent.previous, null);
    assert.equal(sent.note, null);

    // EA6.3: an author carries a program revision's note to its module; a repair never does (its note is a finding).
    const noted = fakeFetch(res(wire('author.sse')));
    await createModuleClient(createApi(CONFIG, fakeIdentity(), noted.fetchImpl)).call(callBody(JOB, null, 'Lower every block by 2 units.'), () => {}, new AbortController().signal);
    assert.equal(JSON.parse(noted.requests[0].body).note, 'Lower every block by 2 units.');

    // A repair's previous body is cut to the backend's caps before it goes.
    const findings = Array.from({ length: 40 }, (_, i) => ({ id: `ev-1.f${i + 1}`, rung: 'L1', code: 'c'.repeat(50), path: null, line: i + 1, severity: 'error', message: 'm'.repeat(500) }));
    const repairJob = jobOf('repair.sse');
    const capped = fakeFetch(res(wire('repair.sse')));
    await createModuleClient(createApi(CONFIG, fakeIdentity(), capped.fetchImpl))
        .call(callBody(repairJob, { body: 'fn placeBlocks(index: u32) {}', codeHash: repairJob.subject.codeHash, evidenceIds: Array.from({ length: 40 }, (_, i) => `ev-${i}`), findings }, 'Lower it.'), () => {}, new AbortController().signal);
    assert.equal(JSON.parse(capped.requests[0].body).note, null, "a repair's note is one of its findings");
    const previous = JSON.parse(capped.requests[0].body).previous;
    assert.equal(previous.findings.length, PREVIOUS_CAPS.findings);
    assert.equal(previous.evidenceIds.length, PREVIOUS_CAPS.evidenceIds);
    assert.deepEqual([previous.findings[0].message.length, previous.findings[0].code.length], [PREVIOUS_CAPS.message, PREVIOUS_CAPS.code]);

    // A refused charge is the envelope, before any stream: a ForgeError with its code, and the call is not repeated.
    const denied = fakeFetch(new Response(wire('denied.json'), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    const refusal = await createModuleClient(createApi(CONFIG, fakeIdentity(), denied.fetchImpl)).call(callBody(), () => {}, new AbortController().signal).catch(e => e);
    assert.ok(refusal instanceof ForgeError && !(refusal instanceof ModuleStreamError));
    assert.deepEqual([refusal.code, refusal.status, refusal.message], ['budget', 503, 'Live creation has reached its spending limit for now.']);
    assert.equal(denied.requests.length, 1, 'never sent twice');
    // A broken stream is never retried either: one request, its error.
    const cut = fakeFetch(res(sse(events(wire('author.sse')).slice(0, 3))));
    const dropped = await createModuleClient(createApi(CONFIG, fakeIdentity(), cut.fetchImpl)).call(callBody(), () => {}, new AbortController().signal).catch(e => e);
    assert.ok(dropped instanceof ModuleStreamError);
    assert.equal(cut.requests.length, 1);
});

test('EA-W15 a cancel stops the read and closes the stream; the deadline is fixed when the call starts, and said as a timeout', async () => {
    assert.equal(MODULE_DEADLINE_MS, 255_000, 'the module role\'s 240 s (2026-11-04) and 15 s for the identity, the gateway and the last event');
    // Cancelled after meta: the read rejects with the cancel itself, and the body is cancelled.
    const pairs = events(wire('author.sse'));
    const open = body([sse(pairs.slice(0, 2))], { keepOpen: true });
    const controller = new AbortController();
    const seen = [];
    const pending = readModuleStream(new Response(open, { status: 200 }), JOB, e => { seen.push(e); if (e.type === 'delta') controller.abort(); }, { signal: controller.signal });
    const error = await pending.catch(e => e);
    assert.equal(error.name, 'AbortError');
    assert.deepEqual(seen.map(e => e.type), ['meta', 'delta']);
    assert.ok(open.state.cancelled, 'the stream was cancelled');
    // A deadline that passes mid-stream is a timeout, status 0, with no body.
    const stalled = fakeFetch((init) => new Response(body([sse(pairs.slice(0, 2))], { keepOpen: true }), { status: 200 }));
    const timedOut = await createModuleClient(createApi(CONFIG, fakeIdentity(), stalled.fetchImpl), { deadlineMs: 40 }).call(callBody(), () => {}, new AbortController().signal).catch(e => e);
    assert.ok(timedOut instanceof ForgeError);
    assert.deepEqual([timedOut.code, timedOut.status], ['timeout', 0]);
    assert.match(timedOut.message, /The module call job-1 had no last event within 0 s/);
});

test('EA-W16 the wire\'s helpers: this build\'s pins, the interface\'s projection and the node slice, as the backend\'s fixture has them', onDisk, async () => {
    assert.deepEqual({ ...MODULE_VERSIONS }, JOB.versions, 'the recordings name this build\'s pins');
    const program = JSON.parse(readFileSync(join(BACKEND, 'main/resources/mock/agent/program.json'), 'utf8')).program;
    const r = await resolveProgram(program.nodes);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph);
    const place = d.interfaces.find(i => i.module === 'place');
    const fixture = JSON.parse(readFileSync(join(BACKEND, 'test/resources/agent/module/place.json'), 'utf8'));
    assert.deepEqual(wireInterface(place), fixture.interface, 'the projection the backend\'s tests send');
    // The node that names the module and the nodes wired to it, in program order; never the rest of the program.
    assert.deepEqual(moduleNodes(program, 'place').map(n => n.id), program.nodes.filter(n => n.id === 'place' || n.id === 'blocks').map(n => n.id));
    assert.deepEqual(moduleNodes(program, 'place').find(n => n.id === 'place'), program.nodes.find(n => n.id === 'place'));
    assert.throws(() => moduleNodes(program, 'nowhere'), /no node nowhere/);
    // cappedPrevious keeps what is within the caps as it is.
    const small = { body: 'b', codeHash: 'h', evidenceIds: ['ev-1'], findings: [{ id: 'ev-1.f1', rung: 'L1', code: 'call', path: null, line: 6, severity: 'error', message: 'calls noise2' }] };
    assert.deepEqual(cappedPrevious(small), small);
});

test('EA-W17 a repair\'s findings past the backend\'s 32 keep a revision\'s note and say how many were cut (the outside review of EA6.3)', () => {
    const error = (i) => ({ id: `ev-1.f${i}`, rung: 'L1', code: 'call', path: null, line: i, severity: 'error', message: `error ${i}` });
    const note = { id: 'ev-9.f1', rung: 'note', code: 'EA_REVISION_NOTE', path: null, line: null, severity: 'warning', message: 'Lower every block by 2 units.' };
    const previous = (findings) => ({ body: 'fn placeBlocks(index: u32) {}', codeHash: 'a'.repeat(64), evidenceIds: ['ev-1', 'ev-9'], findings });
    // 40 errors and the note, last: the note first, then 30 errors, then the host's own line for the 10 cut.
    const capped = cappedPrevious(previous([...Array.from({ length: 40 }, (_, i) => error(i + 1)), note])).findings;
    assert.equal(capped.length, PREVIOUS_CAPS.findings);
    assert.deepEqual(capped[0], note, 'the change the repair was asked to make is never the one cut');
    assert.deepEqual(capped.slice(1, 31).map(f => f.line), Array.from({ length: 30 }, (_, i) => i + 1), 'the rest in the order given');
    assert.deepEqual([capped[31].code, capped[31].rung, capped[31].severity, capped[31].line], [OMITTED_CODE, 'host', 'warning', null]);
    assert.match(capped[31].message, /^10 more of what the checks found are not listed: a request carries at most 32\./);
    // At the cap exactly, nothing is cut and nothing is said; under it, the note still leads.
    const at = cappedPrevious(previous([...Array.from({ length: 31 }, (_, i) => error(i + 1)), note])).findings;
    assert.deepEqual([at.length, at[0].code, at.some(f => f.code === OMITTED_CODE)], [32, 'EA_REVISION_NOTE', false]);
    // One past the cap: the line that says so takes a place too, so two are cut, never one.
    const over = cappedPrevious(previous([...Array.from({ length: 33 }, (_, i) => error(i + 1))])).findings;
    assert.deepEqual([over.length, over.at(-2).line, over.at(-1).message], [32, 31, '2 more of what the checks found are not listed: a request carries at most 32. Answer what is listed; the whole body is checked again after.']);
    assert.equal(cappedPrevious(previous(Array.from({ length: 32 }, (_, i) => error(i + 1)))).findings.at(-1).line, 32, 'exactly 32: none cut');
    // Counted in code points, as the backend counts them (the independent review of EA6.3): a note of emoji whole, and a
    // longer message cut between characters, never inside one.
    const castles = 'The revision asks (a model\'s instruction, not a check\'s finding): Lower it. ' + '\u{1F3F0}'.repeat(290);
    const wide = cappedPrevious(previous([{ ...note, message: castles }])).findings[0].message;
    assert.equal(wide, castles, 'whole: 366 code points, 656 UTF-16 units');
    const cut = cappedPrevious(previous([{ ...note, message: '\u{1F3F0}'.repeat(500) }])).findings[0].message;
    assert.deepEqual([[...cut].length, cut.length, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)], [400, 800, false]);
});
