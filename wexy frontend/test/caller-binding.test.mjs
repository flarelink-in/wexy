// W3's review, its high (the creations platform companion F4): a save's retry went out under the account signed in
// meanwhile. The save controller checked the account before it called the transport, but the transport read its
// credentials after, and tried a 401 again with fresh ones, so the same text and key reached the platform as account B.
// Here, over the real transport (createApi), the real dev identity and the real session: a request bound to a caller
// (http.ts's `Caller`) goes out as that caller or not at all, its App Check token first so its ID token is the last
// thing awaited, the caller's epoch asked once more just before each fetch, the retry after a 401 included; the identity
// gives a bound request only that uid's own token, never a sign-in. No GPU, no model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { StaleCaller } from '../src/forge-client/errors.ts';
import { boundTo, createApi } from '../src/forge-client/http.ts';
import { boundToken, createIdentity, firebaseAuthorization } from '../src/forge-client/identity.ts';
import { parseWorld } from '../src/platform/artifact.ts';
import { openWorld } from '../src/platform/reopen.ts';
import { createSaveController } from '../src/platform/save-controller.ts';
import { AccountSession } from '../src/platform/session.ts';
import { createWorld, reviseWorld } from '../src/platform/worlds.ts';

const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };
const CASTLE = readFileSync(new URL('./fixtures/worlds/castle.wexy-world.json', import.meta.url), 'utf8');
const DESIGN = JSON.parse(CASTLE).design;
const SNAPSHOT = (await openWorld((await parseWorld(CASTLE, null)).world, 'test')).snapshot;
const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const REV = '01JC3W5F6Q7R8S9T0V1W2X3Y50';
const TIME = '2026-11-04T12:00:00.000Z';
const VIEW = { worldId: WORLD, title: 'The castle', rowVersion: 0, createdAt: TIME, updatedAt: TIME,
    head: { revisionId: REV, sha256: 'a'.repeat(64), bytes: 20541, format: 'wexy-world.v1', line: 'ea.v1', createdAt: TIME } };
const installed = (stage = 1) => ({ stage, source: 'live', snapshot: SNAPSHOT, design: DESIGN, view: null, title: 'The castle', improves: null });
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () => json(401, { code: 'auth', message: 'The ID token expired.' });
const noHint = { read: () => false, write: () => {} };

/** A fetch that records each request (its token, key and body) and answers with `answer(n, request)`. */
function recorder(answer) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        const r = { url, method: init.method, authorization: init.headers.get('authorization'), key: init.headers.get('idempotency-key'), body: init.body };
        requests.push(r);
        return answer(requests.length, r);
    };
    return { requests, fetchImpl };
}

/** A Storage stand-in on globalThis for the duration of `run` (the dev identity keeps its uid there). */
async function withStorage(run) {
    const kept = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const map = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) },
    });
    try { return await run(map); } finally {
        if (kept) Object.defineProperty(globalThis, 'localStorage', kept); else delete globalThis.localStorage;
    }
}

test('W3-review high: the reproduction: account A\'s save answered 401 while B signs in is never sent again as B', async () => {
    // As the review ran it: the identity hands out whoever is signed in when asked (account-1, then account-2), and the
    // switch lands while the transport handles the first try's 401.
    let who = 'account-1';
    const account = { epoch: 1, kind: 'active' };
    const identity = { authorization: async () => `Bearer ${who}`, appCheck: async () => null };
    const { requests, fetchImpl } = recorder(n => {
        if (n === 1) { who = 'account-2'; account.epoch = 2; return unauthorized(); }
        return json(201, VIEW);
    });
    const caller = { uid: 'account-1', still: () => account.epoch === 1 };
    const saves = createSaveController({
        api: createApi(CONFIG, identity, fetchImpl), account: () => ({ ...account, caller: account.epoch === 1 ? caller : null }),
        newKey: () => 'key-0000-0000-0001', wait: async () => {}, changed: () => {},
    });
    saves.installed(installed());
    await saves.settled();
    assert.deepEqual(requests.map(r => r.authorization), ['Bearer account-1'], 'one request, as account-1; none as account-2');
    assert.equal(saves.state().status, 'elsewhere', 'account-1\'s world, on the stage, never account-2\'s (Q129)');
});

test('W3-review high: a bound request is sent only as its caller: App Check first, the ID token last, the epoch asked just before the fetch', async () => {
    const calls = [];
    const identity = {
        authorization: async (force, as) => { calls.push(`auth${force ? ' (refresh)' : ''} as ${as ?? '-'}`); return 'Bearer id'; },
        appCheck: async singleUse => { calls.push(singleUse ? 'appcheck single-use' : 'appcheck cached'); return 'ac'; },
    };
    let holds = true;
    const ok = recorder(() => json(201, VIEW));
    const api = boundTo(createApi(CONFIG, identity, ok.fetchImpl), { uid: 'u1', still: () => holds });
    await api.send({ method: 'POST', path: '/v1/worlds', body: {}, auth: true, idempotencyKey: 'key-0000-0000-0001' });
    assert.deepEqual(calls, ['appcheck cached', 'auth as u1'], 'the caller\'s own token, read last');
    assert.equal(ok.requests.length, 1);

    // The epoch moved while the credentials were read: nothing is sent.
    calls.length = 0;
    const late = { ...identity, authorization: async (force, as) => { holds = false; return identity.authorization(force, as); } };
    const none = recorder(() => json(201, VIEW));
    await assert.rejects(boundTo(createApi(CONFIG, late, none.fetchImpl), { uid: 'u1', still: () => holds })
        .send({ method: 'POST', path: '/v1/worlds', body: {}, auth: true }), StaleCaller);
    assert.equal(none.requests.length, 0);

    // The identity has no token for that caller: nothing is sent, never an unsigned request.
    holds = true;
    const tokenless = recorder(() => json(201, VIEW));
    await assert.rejects(boundTo(createApi(CONFIG, { authorization: async () => null, appCheck: async () => null }, tokenless.fetchImpl), { uid: 'u1', still: () => true })
        .send({ method: 'GET', path: '/v1/me/worlds', auth: true }), StaleCaller);
    assert.equal(tokenless.requests.length, 0);

    // An unbound request is as it was: the ID token, then App Check, and no caller asked of the identity.
    calls.length = 0;
    await createApi(CONFIG, identity, recorder(() => json(200, {})).fetchImpl).send({ method: 'GET', path: '/v1/forge/allowance', auth: true });
    assert.deepEqual(calls, ['auth as -', 'appcheck cached']);
});

test('W3-review high: a save whose caller no longer holds is answered "stale", never "unavailable" (which would be sent again)', async () => {
    const identity = { authorization: async () => 'Bearer id', appCheck: async () => null };
    const sent = recorder(() => json(201, VIEW));
    const api = boundTo(createApi(CONFIG, identity, sent.fetchImpl), { uid: 'u1', still: () => false });
    assert.deepEqual(await createWorld(api, 'The castle', { key: 'key-0000-0000-0001', text: CASTLE, sha256: 'a'.repeat(64) }), { kind: 'stale' });
    assert.deepEqual(await reviseWorld(api, { worldId: WORLD, revisionId: REV, rowVersion: 0 }, { key: 'key-0000-0000-0002', text: CASTLE, sha256: 'a'.repeat(64) }), { kind: 'stale' });
    assert.equal(sent.requests.length, 0);
});

test('W3-review high: the dev identity gives a bound request only its own uid\'s token, and never makes a uid for it', async () => {
    await withStorage(async map => {
        const id = createIdentity(CONFIG);
        await id.account.linkGoogle();
        const uid = map.get('wexy.devUid');
        assert.equal(await id.authorization(false, uid), `Bearer dev.google.${uid}`);
        await id.account.signOut();
        await assert.rejects(id.authorization(false, uid), StaleCaller, 'signed out: no token for the caller');
        assert.equal(map.get('wexy.devUid'), undefined, 'and no new caller made for it');
        await id.account.linkGoogle();
        assert.notEqual(map.get('wexy.devUid'), uid);
        await assert.rejects(id.authorization(true, uid), StaleCaller, 'another caller signed in: none for the first');
        assert.match(await id.authorization(false), /^Bearer dev\.google\./, 'an unbound request still goes as whoever is signed in');
    });
});

test('W3-review high: a Firebase user\'s bound token: that uid signed in before the token is read and still after, never a sign-in', async () => {
    const user = (uid, during = () => {}) => ({ uid, getIdToken: async force => { during(); return `token-${uid}${force ? '-fresh' : ''}`; } });
    assert.equal(await boundToken({ currentUser: user('a') }, 'a', true), 'Bearer token-a-fresh');
    await assert.rejects(boundToken({ currentUser: null }, 'a', false), StaleCaller, 'no one signed in: no anonymous sign-in for it');
    await assert.rejects(boundToken({ currentUser: user('b') }, 'a', false), StaleCaller, 'someone else');
    const auth = { currentUser: null };
    auth.currentUser = user('a', () => { auth.currentUser = user('b'); });
    await assert.rejects(boundToken(auth, 'a', false), StaleCaller, 'the account switched while the token was read');
    // Someone else's token, read while they were signed in, never goes out as the caller who is back by the end.
    const back = { currentUser: null };
    back.currentUser = user('b', () => { back.currentUser = user('a'); });
    await assert.rejects(boundToken(back, 'a', false), StaleCaller, 'a token read from another user is not the caller\'s');
});

test('W3-review high: before the session hears of a switch, the identity still refuses: the real session, identity and transport', async () => {
    await withStorage(async map => {
        const identity = createIdentity(CONFIG);
        const session = new AccountSession(identity.account, noHint, () => identity.authorization(false));
        await identity.account.linkGoogle();
        await session.refresh();
        const uidA = map.get('wexy.devUid');
        // The session's word for the save, taken at the install and never refreshed: as if its listener had not run yet.
        const facts = { epoch: session.current.epoch, kind: 'active', caller: { uid: uidA, still: () => true } };
        const { requests, fetchImpl } = recorder(async n => {
            if (n === 1) {
                // Another tab signs out and in as someone else while this first try is answered.
                await identity.account.signOut();
                await identity.account.linkGoogle();
                return unauthorized();
            }
            return json(201, VIEW);
        });
        const saves = createSaveController({
            api: createApi(CONFIG, identity, fetchImpl), account: () => facts,
            newKey: () => 'key-0000-0000-0002', wait: async () => {}, changed: () => {},
        });
        saves.installed(installed());
        await saves.settled();
        assert.deepEqual(requests.map(r => r.authorization), [`Bearer dev.google.${uidA}`], 'one request, as A; nothing as the caller signed in after');
        assert.notEqual(map.get('wexy.devUid'), uidA);
    });
});

test('W3-review high: the session\'s caller is its epoch\'s: none before anyone is known, and it stops holding once the epoch moves', async () => {
    await withStorage(async () => {
        const identity = createIdentity(CONFIG);
        const session = new AccountSession(identity.account, noHint, () => identity.authorization(false));
        assert.equal(session.caller(), null, 'nobody read yet');
        await identity.account.linkGoogle();
        await session.refresh();
        const caller = session.caller();
        assert.equal(caller.uid, (await identity.account.current()).uid);
        assert.equal(caller.still(), true);
        await session.signOut();
        assert.equal(caller.still(), false, 'the epoch moved: the old caller holds no more');
        assert.notEqual(session.caller()?.uid, caller.uid);
        session.dispose();
    });
});

test('W3-review2: the Firebase identity sends a bound request to boundToken, never to a sign-in; an unbound one may sign in', async () => {
    const signIns = [];
    const user = uid => ({ uid, getIdToken: async force => `token-${uid}${force ? '-fresh' : ''}` });
    const over = auth => firebaseAuthorization(async () => ({ auth, signIn: async () => { signIns.push('anonymous'); return user('anon'); } }));
    await assert.rejects(over({ currentUser: null })(false, 'a'), StaleCaller, 'bound, nobody signed in: refused');
    await assert.rejects(over({ currentUser: user('b') })(false, 'a'), StaleCaller, 'bound, someone else: refused');
    assert.deepEqual(signIns, [], 'a bound request never signs anyone in');
    assert.equal(await over({ currentUser: user('a') })(true, 'a'), 'Bearer token-a-fresh');
    assert.equal(await over({ currentUser: null })(false), 'Bearer token-anon', 'unbound, nobody signed in: the first world\'s anonymous caller');
    assert.deepEqual(signIns, ['anonymous']);
});

test('W3-review2: a bound request\'s 401 is tried once more as the same caller: a fresh ID token, the same key, a fresh single-use App Check token', async () => {
    const calls = [];
    let n = 0;
    const identity = {
        authorization: async (force, as) => { calls.push(`auth${force ? ' (refresh)' : ''} as ${as}`); return `Bearer id-${++n}`; },
        appCheck: async singleUse => { calls.push(singleUse ? 'appcheck single-use' : 'appcheck cached'); return `ac-${++n}`; },
    };
    const save = recorder(k => (k === 1 ? unauthorized() : json(201, VIEW)));
    const caller = { uid: 'u1', still: () => true };
    await boundTo(createApi(CONFIG, identity, save.fetchImpl), caller).send({ method: 'POST', path: '/v1/worlds', body: {}, auth: true, idempotencyKey: 'key-0000-0000-0003' });
    assert.equal(save.requests.length, 2);
    assert.deepEqual(save.requests.map(r => r.key), ['key-0000-0000-0003', 'key-0000-0000-0003'], 'one request, tried twice, one key');
    assert.notEqual(save.requests[0].authorization, save.requests[1].authorization, 'the second try\'s token is a new one');
    assert.deepEqual(calls, ['appcheck cached', 'auth as u1', 'appcheck cached', 'auth (refresh) as u1']);
    // A single-use route mints its App Check token again for the second try.
    calls.length = 0;
    const me = recorder(k => (k === 1 ? unauthorized() : json(201, {})));
    await boundTo(createApi(CONFIG, identity, me.fetchImpl), caller).send({ method: 'POST', path: '/v1/me', body: {}, auth: true });
    assert.deepEqual(calls, ['appcheck single-use', 'auth as u1', 'appcheck single-use', 'auth (refresh) as u1']);
});

test('W3-review2 high: the studio\'s wiring, the real session and transport: A\'s world waiting for A\'s account is not saved as B after a switch', async () => {
    // A Firebase-like port and identity over one "signed in" user, as identity.ts's Firebase branch behaves.
    const auth = { user: { uid: 'uid-A', provider: 'google' } };
    const listeners = new Set();
    const port = {
        current: async () => (auth.user ? { uid: auth.user.uid, provider: auth.user.provider } : null),
        linkGoogle: async () => ({ kind: 'signed-in' }), signInExisting: async () => ({ kind: 'failed', code: 'x' }),
        signOut: async () => { auth.user = null; for (const l of [...listeners]) l(); },
        onChange: l => { listeners.add(l); return () => listeners.delete(l); },
    };
    const identity = {
        authorization: firebaseAuthorization(async () => ({
            auth: { get currentUser() { return auth.user ? { uid: auth.user.uid, getIdToken: async () => auth.user.uid } : null; } },
            signIn: async () => { throw new Error('no anonymous sign-in in this test'); },
        })),
        appCheck: async () => null,
    };
    const session = new AccountSession(port, noHint);
    await session.refresh();
    const sent = recorder(() => json(201, VIEW));
    // main.ts's mountSaves: the facts from the session and the account's standing, the account's word on every change.
    let read = false;
    const facts = () => {
        const s = session.current;
        return { epoch: s.epoch, kind: s.kind === 'anonymous' ? 'anonymous' : s.kind === 'google' ? (read ? 'active' : 'unknown') : 'unknown', caller: session.caller() };
    };
    const saves = createSaveController({ api: createApi(CONFIG, identity, sent.fetchImpl), account: facts, newKey: () => crypto.randomUUID(), wait: async () => {}, changed: () => {} });
    let heard = `${facts().epoch}|${facts().kind}`;
    const moved = () => { const f = facts(); const now = `${f.epoch}|${f.kind}`; if (now === heard) return; heard = now; saves.accountChanged(); };
    session.subscribe(() => { read = false; moved(); });
    // A's account not read yet (the platform slow, or down): A's world waits.
    saves.installed(installed());
    await saves.settled();
    // A signs out; B signs in; B's account is read.
    await session.signOut();
    auth.user = { uid: 'uid-B', provider: 'google' };
    for (const l of [...listeners]) l();
    await new Promise(r => setTimeout(r, 5));
    read = true;
    moved();
    await saves.settled();
    assert.deepEqual(sent.requests.map(r => r.authorization), [], 'nothing sent as B by itself');
    assert.equal(saves.state().status, 'elsewhere');
    session.dispose();
});
