// L-series, headless: the live ForgeClient over a fake transport (src/forge-client/live-client.ts): the request of
// each endpoint as the backend's records expect it, the stream read to a result, the fence rule, L0 on the plan, the
// deadline, the direct document and the outcome report.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H1 } from '../src/contract/h1/index.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { createLiveClient } from '../src/forge-client/live-client.ts';

const sse = (event, data) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
const META = { generationId: '01JGEN', model: 'muse-spark-1.3', source: 'live', role: 'author', fn: 'evolve', promptVersion: 'author.evolve.v1' };
const streamOf = (...events) => new Response(events.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

/** An Api answering from a list, and recording each request; `hang` answers only when the signal aborts. */
function fakeApi(...answers) {
    const requests = [];
    return {
        requests,
        async send(req) {
            requests.push(req);
            const next = answers.shift();
            if (next === 'hang') {
                await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
            }
            if (next instanceof Error) throw next;
            return next ?? new Response('{}', { status: 202 });
        },
    };
}

const signal = () => new AbortController().signal;

test('L9 plan: the request, the streamed text, L0 applied, the generation from meta and usage', async () => {
    const api = fakeApi(streamOf(sse('meta', { ...META, role: 'planner', fn: undefined }), sse('delta', { text: H1.plans.galaxy.slice(0, 20) }), sse('delta', { text: H1.plans.galaxy.slice(20) }), sse('usage', { in: 2200, out: 400, reasoning: 90, cached: 2048 }), sse('done', { status: 'ok' })));
    const client = createLiveClient(api);
    const texts = [];
    const r = await client.plan({ prompt: 'a galaxy', style: 'cosmic', seconds: 12 }, { onText: t => texts.push(t) }, signal());
    assert.deepEqual(api.requests[0], { ...api.requests[0], method: 'POST', path: '/v1/forge/plan', body: { prompt: 'a galaxy', style: 'cosmic', seconds: 12 }, auth: true, accept: 'text/event-stream' });
    assert.equal(r.draft.title, 'Spiral Galaxy');
    assert.equal(r.text, H1.plans.galaxy);
    assert.equal(texts.length, 2);
    assert.equal(r.generation.generationId, '01JGEN');
    assert.equal(r.generation.role, 'planner');
    assert.equal(r.generation.fn, null);
    assert.deepEqual(r.generation.usage, { in: 2200, out: 400, reasoning: 90, cached: 2048 });
    assert.ok(r.generation.ms >= 0 && r.generation.ttftMs !== null);
    assert.equal(client.source, 'live');
});

test('the W1 bug hunt: a re-plan names the plan it replaces in retryOf (a first plan sends none: L9)', async () => {
    const api = fakeApi(streamOf(sse('meta', { ...META, role: 'planner', fn: undefined }), sse('delta', { text: H1.plans.galaxy }), sse('usage', { in: 2200, out: 400, reasoning: 90, cached: 2048 }), sse('done', { status: 'ok' })));
    const client = createLiveClient(api);
    await client.plan({ prompt: 'a galaxy', style: 'cosmic', seconds: 12, retryOf: '01JPLAN0000000000000000000' }, {}, signal());
    assert.deepEqual(api.requests[0].body, { prompt: 'a galaxy', style: 'cosmic', seconds: 12, retryOf: '01JPLAN0000000000000000000' });
});

test('L10 a plan the server let through but L0 refuses is "upstream", said with the first problems', async () => {
    const bad = JSON.stringify({ ...JSON.parse(H1.plans.galaxy), uniforms: [] });
    const api = fakeApi(streamOf(sse('meta', META), sse('delta', { text: bad }), sse('done', { status: 'ok' })));
    await assert.rejects(createLiveClient(api).plan({ prompt: 'x', style: 'auto', seconds: 6 }, {}, signal()),
        e => e instanceof ForgeError && e.code === 'upstream' && /The plan didn't come through: \$\.uniforms: 0 items/.test(e.message));
});

test('L11 author and repair: the requests, the fence rule on the answer, and the function named in meta', async () => {
    const fenced = '```wgsl\n' + H1.exemplars.galaxy.evolve + '\n```';
    const api = fakeApi(
        streamOf(sse('meta', META), sse('delta', { text: fenced }), sse('usage', { in: 1, out: 2 }), sse('done', { status: 'ok' })),
        streamOf(sse('meta', { ...META, role: 'repairer', generationId: '01JREP' }), sse('delta', { text: H1.exemplars.galaxy.evolve }), sse('done', { status: 'ok' })),
    );
    const client = createLiveClient(api);
    const a = await client.author('evolve', '01JPLAN', {}, signal());
    assert.deepEqual(api.requests[0].body, { planId: '01JPLAN', fn: 'evolve' });
    assert.equal(api.requests[0].path, '/v1/forge/author');
    assert.equal(a.text, H1.exemplars.galaxy.evolve);
    assert.equal(a.generation.fn, 'evolve');
    const diagnostics = [{ source: 'tint', line: 11, column: 25, message: 'type mismatch', snippet: 'let jitter = hash11(i) * 0.02;' }];
    const r = await client.repair('evolve', '01JGEN', diagnostics, {}, signal());
    assert.deepEqual(api.requests[1].body, { generationId: '01JGEN', diagnostics });
    assert.equal(api.requests[1].path, '/v1/forge/repair');
    assert.equal(r.generation.generationId, '01JREP');
    assert.equal(r.generation.role, 'repairer');
});

test('L12 the client\'s deadline is the server\'s plus a margin, and a stream that stops answering ends in "timeout"', async () => {
    const api = fakeApi('hang');
    const client = createLiveClient(api, { planMs: 30, authorMs: 30, repairMs: 30, directMs: 30, reportMs: 30 });
    const t0 = performance.now();
    await assert.rejects(client.plan({ prompt: 'x', style: 'auto', seconds: 6 }, {}, signal()),
        e => e instanceof ForgeError && e.code === 'timeout' && e.status === 0 && /planner gave no answer within 0 s/.test(e.message));
    assert.ok(performance.now() - t0 < 1000);
    // The caller's own cancel stays an AbortError.
    const ac = new AbortController();
    const api2 = fakeApi('hang');
    const pending = createLiveClient(api2, { planMs: 5000, authorMs: 5000, repairMs: 5000, directMs: 5000, reportMs: 5000 }).author('look', 'p', {}, ac.signal);
    ac.abort();
    await assert.rejects(pending, e => e.name === 'AbortError');
});

test('L13 direct answers one document: the edit parsed, the generation from the document; outcomes are posted as they are', async () => {
    const doc = { generationId: '01JDIR', model: 'muse-spark-1.3', source: 'live', role: 'director', promptVersion: 'director.v1', edit: { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.9 }], summary: 'Brighter.' }, usage: { in: 500, out: 40 } };
    const api = fakeApi(new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } }), new Response('{}', { status: 202 }));
    const client = createLiveClient(api);
    const spec = { version: '2.0', title: 'x', uniforms: {} };
    const d = await client.direct(spec, 'make it glow more', signal());
    assert.deepEqual(api.requests[0].body, { spec, turn: 'make it glow more' }, 'no plan named: the turn spends a prompt of its own (W1)');
    assert.equal(api.requests[0].path, '/v1/forge/direct');
    assert.equal(api.requests[0].accept, undefined);
    assert.deepEqual(d.edit, { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.9 }], summary: 'Brighter.' });
    assert.equal(d.generation.generationId, '01JDIR');
    assert.equal(d.generation.role, 'director');
    assert.deepEqual(d.generation.usage, { in: 500, out: 40 });
    const outcome = { generationIds: ['01JGEN'], ladder: { L1: { ok: true, ms: 1 } }, firstPassOk: true, repairs: 0, autofixes: 0, probeMs: 1, predictedMs: 2, fps: 60, adapter: 'amd gcn-5', browser: 'Chrome 155' };
    await client.report(outcome);
    assert.deepEqual(api.requests[1].body, outcome);
    assert.equal(api.requests[1].path, '/v1/forge/outcomes');
    // A document whose edit breaks the contract is the backend's bug, said as internal.
    const broken = fakeApi(new Response(JSON.stringify({ ...doc, edit: { kind: 'undo' } }), { status: 200 }));
    await assert.rejects(createLiveClient(broken).direct(spec, 't', signal()), e => e instanceof ForgeError && e.code === 'internal' && /edit\.kind/.test(e.message));
});

test('PL-FE9 a Director turn on a planned world names its plan, so it runs inside that plan\'s prompt (W1)', async () => {
    const doc = { generationId: '01JDIR', model: 'muse-spark-1.3', source: 'live', role: 'director', promptVersion: 'director.v1', edit: { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.4 }], summary: 'Softer.' } };
    const api = fakeApi(new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const spec = { version: '2.0', title: 'x', uniforms: {} };
    await createLiveClient(api).direct(spec, 'slower', signal(), '01JPLAN0000000000000000000');
    assert.deepEqual(api.requests[0].body, { spec, turn: 'slower', planId: '01JPLAN0000000000000000000' });
});
