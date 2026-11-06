// U-series, headless: the transport to the gateway (src/forge-client/http.ts), against a fake fetch and identity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, needsSingleUseAppCheck, SINGLE_USE_ROUTES } from '../src/forge-client/http.ts';
import { ForgeError } from '../src/forge-client/errors.ts';

const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };

/** An identity that records what it was asked for and hands out numbered tokens. */
function fakeIdentity() {
    const calls = [];
    let n = 0;
    return {
        calls,
        async authorization(forceRefresh) { calls.push(`auth${forceRefresh ? ' (refresh)' : ''}`); return `Bearer id-${++n}`; },
        async appCheck(singleUse) { calls.push(singleUse ? 'appcheck single-use' : 'appcheck cached'); return `ac-${++n}`; },
    };
}

/** A fetch that answers from a list and records each request. */
function fakeFetch(...answers) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, method: init.method, headers: Object.fromEntries(init.headers.entries()), body: init.body, credentials: init.credentials, redirect: init.redirect });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response('{}', { status: 200 });
    };
    return { fetchImpl, requests };
}

test('U15 the single-use App Check routes are exactly the gateway\'s (ForgeRoutesTest: agent-turn, agent-module, agent-review, me-bootstrap, me-delete, worlds-submit, waitlist)', () => {
    assert.deepEqual([...SINGLE_USE_ROUTES], ['POST /v1/agent/turn', 'POST /v1/agent/module',
        'POST /v1/agent/review', 'POST /v1/me', 'DELETE /v1/me', 'POST /v1/worlds/{id}/submissions', 'POST /v1/waitlist']);
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/turn'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/turn'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/module'));
    // EA6.4: a model's review spends its token; its terms (GET) do not.
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/review'));
    // W2 (the creations platform design §10): the platform's, a world's id standing for its one segment.
    assert.ok(needsSingleUseAppCheck('post', '/v1/me'));
    assert.ok(needsSingleUseAppCheck('DELETE', '/v1/me?x=1'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/worlds/01JC3W5F6Q7R8S9T0V1W2X3Y4Z/submissions'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/waitlist'));
    for (const [m, p] of [['POST', '/v1/forge/author'], ['POST', '/v1/worlds'], ['POST', '/v1/worlds?draft=1'], ['POST', '/v1/worlds/abc/complete'],
        ['GET', '/v1/worlds'], ['POST', '/v1/forge/plan'], ['GET', '/v1/agent/turn'], ['POST', '/v1/agent/turns'], ['GET', '/v1/me'],
        ['PATCH', '/v1/me/profile'], ['POST', '/v1/me/profile'], ['DELETE', '/v1/worlds/abc'], ['POST', '/v1/worlds//submissions'],
        ['POST', '/v1/worlds/a/b/submissions'], ['GET', '/v1/worlds/abc/submissions'], ['POST', '/v1/worlds/abc/submissions/x'],
        ['GET', '/v1/agent/review'], ['POST', '/v1/agent/review/x']]) {
        assert.ok(!needsSingleUseAppCheck(m, p), `${m} ${p}`);
    }
});

test('U39 a PATCH goes as a PATCH with its JSON and the cached App Check token (W2: the profile is not a single-use route)', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(new Response('{}', { status: 200 }));
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'PATCH', path: '/v1/me/profile', body: { expectedVersion: 0, handle: 'nova' }, auth: true });
    const [r] = requests;
    assert.equal(r.method, 'PATCH');
    assert.equal(r.url, 'http://localhost:8400/v1/me/profile');
    assert.equal(r.body, '{"expectedVersion":0,"handle":"nova"}');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.deepEqual(identity.calls, ['auth', 'appcheck cached']);
});

test('U41 an idempotency key goes as Idempotency-Key, the same on the retry after a 401; a key of another shape is refused before anything is sent (W3)', async () => {
    const identity = fakeIdentity();
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const { fetchImpl, requests } = fakeFetch(new Response('{"code":"auth","message":"m"}', { status: 401 }), new Response('{}', { status: 201 }));
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/worlds', body: { title: 't' }, auth: true, idempotencyKey: key });
    assert.deepEqual(requests.map(r => [r.method, r.headers['idempotency-key']]), [['POST', key], ['POST', key]]);
    // A save takes the cached App Check token (W2: POST /v1/worlds left the single-use set).
    assert.deepEqual(identity.calls, ['auth', 'appcheck cached', 'auth (refresh)', 'appcheck cached']);
    const none = fakeFetch(new Response('{}', { status: 200 }));
    await createApi(CONFIG, fakeIdentity(), none.fetchImpl).send({ method: 'GET', path: '/v1/me/worlds', auth: true });
    assert.equal(none.requests[0].headers['idempotency-key'], undefined, 'no key, no header');
    for (const bad of ['', 'short', 'x'.repeat(65), 'has space in it 12345', 'key\r\nX-Evil: 1-23456789', 'ключ-0123456789abcdef']) {
        const sent = fakeFetch();
        await assert.rejects(createApi(CONFIG, fakeIdentity(), sent.fetchImpl).send({ method: 'POST', path: '/v1/worlds', body: {}, auth: true, idempotencyKey: bad }),
            /is not an idempotency key/, JSON.stringify(bad));
        assert.equal(sent.requests.length, 0, 'nothing sent');
    }
});

test('U16 a signed-in POST carries the ID token, a fresh limited-use App Check token, and JSON', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(new Response('ok', { status: 200 }));
    const res = await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/agent/turn', body: { prompt: 'a storm' }, auth: true, accept: 'text/event-stream' });
    assert.equal(await res.text(), 'ok');
    const [r] = requests;
    assert.equal(r.url, 'http://localhost:8400/v1/agent/turn');
    assert.equal(r.headers.authorization, 'Bearer id-1');
    assert.equal(r.headers['x-firebase-appcheck'], 'ac-2');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers.accept, 'text/event-stream');
    assert.equal(r.body, '{"prompt":"a storm"}');
    assert.equal(r.credentials, 'omit');
    assert.equal(r.redirect, 'error');
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use']);
});

test('U36 App Check policy follows the resolved path, not its unnormalised spelling', async () => {
    for (const path of ['/v1/agent/x/../turn', '/v1/agent/%74urn', '/v1/me#draft', '/v1/worlds/abc/%73ubmissions']) {
        const identity = fakeIdentity();
        const { fetchImpl } = fakeFetch();
        await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path, auth: true });
        assert.deepEqual(identity.calls, ['auth', 'appcheck single-use'], path);
    }
});

test('U37 an already cancelled request does not acquire credentials or send a request', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createApi(CONFIG, identity, fetchImpl).send({
        method: 'POST', path: '/v1/agent/turn', auth: true, signal: controller.signal,
    }), e => e.name === 'AbortError');
    assert.deepEqual(identity.calls, []);
    assert.equal(requests.length, 0);
});

test('U38 cancellation during identity acquisition stops App Check and dispatch', async () => {
    const controller = new AbortController();
    const identity = fakeIdentity();
    identity.authorization = async () => { controller.abort(); return 'Bearer id'; };
    const { fetchImpl, requests } = fakeFetch();
    await assert.rejects(createApi(CONFIG, identity, fetchImpl).send({
        method: 'POST', path: '/v1/agent/turn', auth: true, signal: controller.signal,
    }), e => e.name === 'AbortError');
    assert.deepEqual(identity.calls, []);
    assert.equal(requests.length, 0);
});

test('U17 a cached-token route asks for the cached App Check token', async () => {
    const identity = fakeIdentity();
    const { fetchImpl } = fakeFetch();
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/forge/author', body: { planId: 'p', fn: 'evolve' }, auth: true });
    assert.deepEqual(identity.calls, ['auth', 'appcheck cached']);
});

test('U18 a public read sends no token of any kind', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch();
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'GET', path: '/v1/forge/mode', auth: false });
    assert.deepEqual(identity.calls, []);
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['x-firebase-appcheck'], undefined);
});

test('U19 401 refreshes the ID token and retries once, with a fresh App Check token', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(
        new Response('{"code":"auth","message":"expired"}', { status: 401 }),
        new Response('ok', { status: 200 }),
    );
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/agent/turn', body: {}, auth: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use', 'auth (refresh)', 'appcheck single-use']);
    assert.notEqual(requests[0].headers['x-firebase-appcheck'], requests[1].headers['x-firebase-appcheck']);
});

test('U20 a second 401 is the caller\'s answer: no third request', async () => {
    const { fetchImpl, requests } = fakeFetch(
        new Response('{"code":"auth","message":"no"}', { status: 401 }),
        new Response('{"code":"auth","message":"still no"}', { status: 401 }),
    );
    await assert.rejects(createApi(CONFIG, fakeIdentity(), fetchImpl).send({ method: 'POST', path: '/v1/agent/turn', body: {}, auth: true }),
        e => e instanceof ForgeError && e.code === 'auth' && e.message === 'still no');
    assert.equal(requests.length, 2);
});

test('U21 a refusal is a ForgeError with the backend\'s code', async () => {
    const { fetchImpl } = fakeFetch(new Response('{"code":"budget","message":"The daily cap is reached."}', { status: 503 }));
    await assert.rejects(createApi(CONFIG, fakeIdentity(), fetchImpl).send({ method: 'POST', path: '/v1/agent/turn', body: {}, auth: true }),
        e => e instanceof ForgeError && e.code === 'budget' && e.status === 503);
});

test('U22 no answer at all is unavailable, status 0; a cancel stays an AbortError', async () => {
    const offline = fakeFetch(new TypeError('Failed to fetch'));
    await assert.rejects(createApi(CONFIG, fakeIdentity(), offline.fetchImpl).send({ method: 'GET', path: '/v1/forge/mode', auth: false }),
        e => e instanceof ForgeError && e.code === 'unavailable' && e.status === 0);
    const abort = new DOMException('Aborted', 'AbortError');
    const cancelled = fakeFetch(abort);
    await assert.rejects(createApi(CONFIG, fakeIdentity(), cancelled.fetchImpl).send({ method: 'GET', path: '/v1/forge/mode', auth: false }), e => e === abort);
});

test('U23 a path that is not the gateway\'s is refused before anything is sent', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch();
    const api = createApi(CONFIG, identity, fetchImpl);
    for (const path of ['https://evil.example/v1/agent/turn', '//evil.example/v1/x', '/admin', 'v1/forge/plan', '/v1/../../evil']) {
        await assert.rejects(api.send({ method: 'POST', path, body: {}, auth: true }), /api: /, path);
    }
    assert.equal(requests.length, 0);
    assert.deepEqual(identity.calls, []);
    await assert.rejects(createApi({ ...CONFIG, apiOrigin: null }, identity, fetchImpl).send({ method: 'GET', path: '/v1/forge/mode', auth: false }), /VITE_API_ORIGIN is not set/);
});
