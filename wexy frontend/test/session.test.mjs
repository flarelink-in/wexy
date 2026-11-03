// PL-FE3's W1 part (the creations platform companion §6, §11; F2, F4): the account session over the identity's
// account port, and that port over Firebase Auth's functions, both with fakes: no Firebase, no popup, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdentity, firebaseAccount } from '../src/forge-client/identity.ts';
import { AccountSession, STALE } from '../src/platform/session.ts';

/** An account port whose answers the test sets, counting its listeners. */
function fakePort(initial = null) {
    let who = initial;
    const listeners = new Set();
    const port = {
        registered: 0,
        set(next) { who = next; for (const l of [...listeners]) l(); },
        async current() { return who; },
        async linkGoogle() { return port.next ?? { kind: 'linked' }; },
        async signInExisting() { return { kind: 'signed-in' }; },
        async signOut() { who = null; },
        onChange(listener) {
            port.registered++;
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        get listening() { return listeners.size; },
    };
    return port;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('PL-FE3 the session learns who is signed in without signing anyone in, and follows changes through one listener', async () => {
    const port = fakePort(null);
    const session = new AccountSession(port);
    assert.deepEqual(session.current, { epoch: 0, kind: 'unknown' });

    assert.deepEqual(await session.refresh(), { epoch: 0, kind: 'none' }, 'the first reading only learns');
    await session.refresh();
    await session.refresh();
    assert.equal(port.registered, 1, 'repeated reads leave one listener');

    // The first Create made an anonymous caller: the listener hears it, and the epoch moves (a new uid).
    const seen = [];
    session.subscribe(state => seen.push(state));
    port.set({ uid: 'u1', provider: 'anonymous' });
    await settle();
    assert.deepEqual(session.current, { epoch: 1, kind: 'anonymous' });
    assert.deepEqual(seen, [{ epoch: 1, kind: 'anonymous' }]);

    session.dispose();
    assert.equal(port.listening, 0, 'disposed, it listens no more');
});

test('PL-FE3 a Google link keeps the uid and moves the epoch, so the allowance is read again under the new token', async () => {
    const port = fakePort({ uid: 'u1', provider: 'anonymous' });
    const session = new AccountSession(port);
    await session.refresh();
    port.linkGoogle = async () => { port.set({ uid: 'u1', provider: 'google' }); return { kind: 'linked' }; };

    assert.deepEqual(await session.linkGoogle(), { kind: 'linked' });
    assert.equal(session.current.kind, 'google');
    assert.ok(session.current.epoch >= 1, 'the provider changed: a new epoch');
});

test('PL-FE3 a cancelled, blocked or failed sign-in, and a collision, change nothing until the creator chooses', async () => {
    const port = fakePort({ uid: 'u1', provider: 'anonymous' });
    const session = new AccountSession(port);
    await session.refresh();
    const before = session.current;
    for (const outcome of [{ kind: 'cancelled' }, { kind: 'blocked' }, { kind: 'failed', code: 'auth/network-request-failed' },
        { kind: 'collision', collision: { credential: 'c' } }]) {
        port.next = outcome;
        assert.deepEqual(await session.linkGoogle(), outcome);
        assert.deepEqual(session.current, before, outcome.kind);
    }
    // The creator chose the existing account: another uid, a new epoch.
    port.signInExisting = async () => { port.set({ uid: 'u9', provider: 'google' }); return { kind: 'signed-in' }; };
    assert.deepEqual(await session.signInExisting({ credential: 'c' }), { kind: 'signed-in' });
    assert.equal(session.current.kind, 'google');
    assert.ok(session.current.epoch > before.epoch);
});

test('PL-FE3 sign-out and an account switch move the epoch: an answer fetched before arrives stale and is dropped (F4)', async () => {
    const port = fakePort({ uid: 'u1', provider: 'google' });
    const session = new AccountSession(port);
    await session.refresh();

    let release;
    const slow = session.guard(() => new Promise(resolve => { release = resolve; }));
    await session.signOut();
    assert.equal(session.current.kind, 'none');
    release({ label: 'Early access', left: 1, resetsAt: null });
    assert.equal(await slow, STALE, 'the old account\'s answer is never shown');

    // An answer that arrives under its own epoch is kept.
    assert.deepEqual(await session.guard(async () => 42), 42);

    // Another tab signs in as someone else: heard through the listener, the epoch moves again.
    const epoch = session.current.epoch;
    port.set({ uid: 'u2', provider: 'google' });
    await settle();
    assert.ok(session.current.epoch > epoch);
});

test('EA9.1 enter(): the entry\'s own sign-in makes the caller before any call, read under its own epoch; a first visit only learns it', async () => {
    // As identity.ts's transport does: the signed-in user, or a new anonymous one; Firebase tells its listener later.
    const port = fakePort({ uid: 'g1', provider: 'google' });
    let made = 0;
    const entry = async () => {
        if (await port.current()) return;
        made++;
        port.set({ uid: `anon-${made}`, provider: 'anonymous' });
    };
    const session = new AccountSession(port, memoryHint(), entry);
    await session.refresh();
    assert.equal(session.established, true);
    await session.signOut();
    const out = session.current;
    assert.deepEqual([out.kind, session.established], ['none', false], 'signed out: no caller until the next call makes one');
    const seen = [];
    session.subscribe(state => seen.push(state));
    const entered = await session.enter();
    assert.deepEqual(entered, { epoch: out.epoch + 1, kind: 'anonymous' }, 'the caller it made, read before enter resolves');
    assert.deepEqual([made, session.established], [1, true]);
    await settle();
    assert.deepEqual(seen, [entered], 'one move: the listener\'s own reading found nothing new');
    // A caller already there: nothing made, nothing moved.
    assert.deepEqual(await session.enter(), entered);
    assert.equal(made, 1);

    // A first visit: nothing read yet, no listener; enter makes the caller and learns it without a move, then listens.
    const fresh = fakePort(null);
    let freshMade = 0;
    const first = new AccountSession(fresh, memoryHint(), async () => { if (!(await fresh.current())) { freshMade++; fresh.set({ uid: 'anon-x', provider: 'anonymous' }); } });
    assert.deepEqual([first.current, first.established], [{ epoch: 0, kind: 'unknown' }, false]);
    assert.deepEqual(await first.enter(), { epoch: 0, kind: 'anonymous' }, 'the first reading only learns');
    assert.deepEqual([freshMade, fresh.registered], [1, 1]);
    // An entry that cannot make a caller says so, and the session is as it was.
    const broken = new AccountSession(fakePort(null), memoryHint(), async () => { throw new Error('identity: anonymous sign-in failed (auth/network-request-failed)'); });
    await assert.rejects(broken.enter(), /anonymous sign-in failed/);
    assert.deepEqual(broken.current, { epoch: 0, kind: 'unknown' });
});

/** Firebase Auth's functions, faked: a current user, and what each call does. */
function fakeAuth({ user = null, link, popup, credential } = {}) {
    const calls = [];
    const auth = { currentUser: user };
    const fns = {
        async linkWithPopup(u, provider) { calls.push(['link', u.uid, provider]); return link(u); },
        async signInWithPopup(a, provider) { calls.push(['popup', provider]); return popup(a); },
        async signInWithCredential(a, c) { calls.push(['credential', c]); a.currentUser = { uid: 'other', isAnonymous: false, getIdToken: async () => 't' }; return { user: a.currentUser }; },
        async signOut(a) { calls.push(['signOut']); a.currentUser = null; },
        onAuthStateChanged(a, next) { calls.push(['listen']); return () => calls.push(['unlisten']); },
        googleProvider: () => 'google-provider',
        credentialFromError: error => credential ?? error.credential ?? null,
    };
    return { auth, fns, calls, port: firebaseAccount(async () => ({ auth, fns })) };
}

const anonymousUser = uid => {
    const user = { uid, isAnonymous: true, refreshed: [] };
    user.getIdToken = async force => { user.refreshed.push(force); return 'token'; };
    return user;
};

test('PL-FE3 linking an anonymous user keeps its uid and forces a fresh ID token, since the cached one still says anonymous', async () => {
    const user = anonymousUser('anon-1');
    const { port, calls } = fakeAuth({ user, link: async u => { u.isAnonymous = false; return { user: u }; } });

    assert.deepEqual(await port.current(), { uid: 'anon-1', provider: 'anonymous' });
    assert.deepEqual(await port.linkGoogle(), { kind: 'linked' });
    assert.deepEqual(calls[0], ['link', 'anon-1', 'google-provider'], 'linkWithPopup on the current user, never a new sign-in');
    assert.deepEqual(user.refreshed, [true], 'getIdToken(true) right after the link');
    assert.deepEqual(await port.current(), { uid: 'anon-1', provider: 'google' }, 'the same uid');
});

test('PL-FE3 a Google credential another account holds is a collision, offered, never merged; the creator\'s choice signs in to it', async () => {
    const error = Object.assign(new Error('in use'), { code: 'auth/credential-already-in-use' });
    const { port, calls, auth } = fakeAuth({ user: anonymousUser('anon-1'), link: async () => { throw error; }, credential: 'the-credential' });

    const outcome = await port.linkGoogle();
    assert.deepEqual(outcome, { kind: 'collision', collision: { credential: 'the-credential' } });
    assert.equal(auth.currentUser.uid, 'anon-1', 'nothing changed until the creator chooses');

    assert.deepEqual(await port.signInExisting(outcome.collision), { kind: 'signed-in' });
    assert.deepEqual(calls.at(-1), ['credential', 'the-credential']);
    assert.equal(auth.currentUser.uid, 'other');
});

test('PL-FE3 a closed or blocked popup is said as such and changes nothing; with no user yet, Google signs in directly', async () => {
    for (const [code, kind] of [['auth/popup-closed-by-user', 'cancelled'], ['auth/cancelled-popup-request', 'cancelled'],
        ['auth/popup-blocked', 'blocked'], ['auth/network-request-failed', 'failed']]) {
        const user = anonymousUser('anon-1');
        const { port } = fakeAuth({ user, link: async () => { throw Object.assign(new Error(code), { code }); } });
        const outcome = await port.linkGoogle();
        assert.equal(outcome.kind, kind, code);
        assert.deepEqual(user.refreshed, [], `${code}: no token refreshed`);
        assert.equal(user.isAnonymous, true);
    }
    const { port, calls } = fakeAuth({ user: null, popup: async () => ({ user: { uid: 'g', isAnonymous: false } }) });
    assert.deepEqual(await port.linkGoogle(), { kind: 'signed-in' });
    assert.deepEqual(calls, [['popup', 'google-provider']], 'no anonymous user is made first');
});

test('PL-FE3 the port listens through one onAuthStateChanged, and its unsubscribe stops it', async () => {
    const { port, calls } = fakeAuth({ user: anonymousUser('a') });
    const off = port.onChange(() => {});
    await settle();
    off();
    assert.deepEqual(calls, [['listen'], ['unlisten']]);
});

/** A Storage stand-in on globalThis for the duration of `run`. */
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

test('PL-FE3 the loopback dev identity signs in as a link does: dev.google with the same uid; sign-out makes a new anonymous caller', async () => {
    await withStorage(async map => {
        const id = createIdentity({ firebase: null, appCheckSiteKey: null, dev: true, apiOrigin: 'http://localhost:8400' });
        const anonymous = await id.authorization(false);
        assert.match(anonymous, /^Bearer dev\.anonymous\.[a-f0-9]{32}$/);
        const uid = anonymous.split('.').pop();
        assert.deepEqual(await id.account.current(), { uid, provider: 'anonymous' });

        let heard = 0;
        const off = id.account.onChange(() => heard++);
        assert.deepEqual(await id.account.linkGoogle(), { kind: 'linked' });
        assert.equal(await id.authorization(false), `Bearer dev.google.${uid}`, 'the gateway\'s local dev token for an account');
        assert.equal(map.get('wexy.devProvider'), 'google', 'a reload keeps it');

        await id.account.signOut();
        const next = await id.authorization(false);
        assert.match(next, /^Bearer dev\.anonymous\.[a-f0-9]{32}$/);
        assert.notEqual(next.split('.').pop(), uid, 'a new anonymous caller');
        assert.equal(heard, 2);
        off();
        // A production build, or a gateway off loopback, has no account to offer.
        assert.equal(createIdentity({ firebase: null, appCheckSiteKey: null, dev: false, apiOrigin: 'http://localhost:8400' }).account, undefined);
    });
});

/** A hint the test reads: what the session last wrote. */
function memoryHint(initial = false) {
    const hint = { value: initial, writes: [], read: () => hint.value, write(google) { hint.value = google; hint.writes.push(google); } };
    return hint;
}

test('W2 the session keeps one bit, "a Google session is here", for a reload to show the account at once; no identity in it', async () => {
    const port = fakePort({ uid: 'u1', provider: 'anonymous' });
    const hint = memoryHint(false);
    const session = new AccountSession(port, hint);
    assert.equal(session.hinted, false, 'a fresh browser holds no hint: a page view loads nothing');

    await session.refresh();
    assert.equal(hint.value, false, 'an anonymous caller is no Google session');
    port.linkGoogle = async () => { port.set({ uid: 'u1', provider: 'google' }); return { kind: 'linked' }; };
    await session.linkGoogle();
    assert.equal(hint.value, true);
    assert.equal(session.hinted, true);
    assert.ok(hint.writes.every(w => typeof w === 'boolean'), 'one bit, never a uid');

    await session.signOut();
    assert.equal(hint.value, false, 'signed out: the next page view loads nothing again');
});

test('W2 a stale hint corrects itself: a reload that finds no Google session clears it', async () => {
    const hint = memoryHint(true);
    const session = new AccountSession(fakePort(null), hint);
    assert.equal(session.hinted, true);
    await session.refresh();
    assert.equal(hint.value, false);
});

test('W2 the browser\'s hint is one key, "1" or absent, and blocked storage is just no hint', async () => {
    const { browserHint, GOOGLE_HINT_KEY } = await import('../src/platform/session.ts');
    await withStorage(async map => {
        assert.equal(browserHint.read(), false);
        browserHint.write(true);
        assert.deepEqual([...map.entries()], [[GOOGLE_HINT_KEY, '1']]);
        assert.equal(browserHint.read(), true);
        browserHint.write(false);
        assert.equal(map.size, 0);
        // Only "1" is a hint: anything else another script might leave there is none.
        map.set(GOOGLE_HINT_KEY, 'true');
        assert.equal(browserHint.read(), false);
    });
    const kept = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
        assert.equal(browserHint.read(), false);
        browserHint.write(true);
    } finally {
        if (kept) Object.defineProperty(globalThis, 'localStorage', kept); else delete globalThis.localStorage;
    }
});
