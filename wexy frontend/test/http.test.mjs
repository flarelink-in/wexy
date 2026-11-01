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

test('U15 the single-use App Check routes are exactly the gateway\'s (ForgeRoutesTest: forge-plan, agent-turn, agent-module, worlds-publish)', () => {
    assert.deepEqual([...SINGLE_USE_ROUTES], ['POST /v1/forge/plan', 'POST /v1/agent/turn', 'POST /v1/agent/module', 'POST /v1/worlds']);
    assert.ok(needsSingleUseAppCheck('POST', '/v1/forge/plan'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/turn'));
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/module'));
    assert.ok(needsSingleUseAppCheck('post', '/v1/worlds?draft=1'));
    for (const [m, p] of [['POST', '/v1/forge/author'], ['POST', '/v1/worlds/abc/complete'], ['GET', '/v1/worlds'], ['GET', '/v1/forge/plan'], ['GET', '/v1/agent/turn'], ['POST', '/v1/agent/turns']]) {
        assert.ok(!needsSingleUseAppCheck(m, p), `${m} ${p}`);
    }
});

test('U16 a signed-in POST carries the ID token, a fresh limited-use App Check token, and JSON', async () => {
    const identity = fakeIdentity();
    const { fetchImpl, requests } = fakeFetch(new Response('ok', { status: 200 }));
    const res = await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/forge/plan', body: { prompt: 'a storm' }, auth: true, accept: 'text/event-stream' });
    assert.equal(await res.text(), 'ok');
    const [r] = requests;
    assert.equal(r.url, 'http://localhost:8400/v1/forge/plan');
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
    for (const path of ['/v1/forge/x/../plan', '/v1/forge/%70lan', '/v1/worlds#draft']) {
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
        method: 'POST', path: '/v1/forge/plan', auth: true, signal: controller.signal,
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
        method: 'POST', path: '/v1/forge/plan', auth: true, signal: controller.signal,
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
    await createApi(CONFIG, identity, fetchImpl).send({ method: 'POST', path: '/v1/forge/plan', body: {}, auth: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(identity.calls, ['auth', 'appcheck single-use', 'auth (refresh)', 'appcheck single-use']);
    assert.notEqual(requests[0].headers['x-firebase-appcheck'], requests[1].headers['x-firebase-appcheck']);
});

test('U20 a second 401 is the caller\'s answer: no third request', async () => {
    const { fetchImpl, requests } = fakeFetch(
        new Response('{"code":"auth","message":"no"}', { status: 401 }),
        new Response('{"code":"auth","message":"still no"}', { status: 401 }),
    );
    await assert.rejects(createApi(CONFIG, fakeIdentity(), fetchImpl).send({ method: 'POST', path: '/v1/forge/plan', body: {}, auth: true }),
        e => e instanceof ForgeError && e.code === 'auth' && e.message === 'still no');
    assert.equal(requests.length, 2);
});

test('U21 a refusal is a ForgeError with the backend\'s code', async () => {
    const { fetchImpl } = fakeFetch(new Response('{"code":"budget","message":"The daily cap is reached."}', { status: 503 }));
    await assert.rejects(createApi(CONFIG, fakeIdentity(), fetchImpl).send({ method: 'POST', path: '/v1/forge/plan', body: {}, auth: true }),
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
    for (const path of ['https://evil.example/v1/forge/plan', '//evil.example/v1/x', '/admin', 'v1/forge/plan', '/v1/../../evil']) {
        await assert.rejects(api.send({ method: 'POST', path, body: {}, auth: true }), /api: /, path);
    }
    assert.equal(requests.length, 0);
    assert.deepEqual(identity.calls, []);
    await assert.rejects(createApi({ ...CONFIG, apiOrigin: null }, identity, fetchImpl).send({ method: 'GET', path: '/v1/forge/mode', auth: false }), /VITE_API_ORIGIN is not set/);
});
