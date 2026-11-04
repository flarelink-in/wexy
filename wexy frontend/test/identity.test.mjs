// U-series, headless: the identity without Firebase (src/forge-client/identity.ts). The Firebase path needs a
// browser and Wexy's web app; it is checked in the browser once the app is registered (playground-port design).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdentity, configureAppCheckDebug } from '../src/forge-client/identity.ts';

test('App Check debug attestation is limited to the local dev server, even with an injected global', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
        const page = {};
        configureAppCheckDebug(page, true, hostname);
        assert.equal(page.FIREBASE_APPCHECK_DEBUG_TOKEN, true);
        page.FIREBASE_APPCHECK_DEBUG_TOKEN = 'local-harness-token';
        configureAppCheckDebug(page, true, hostname);
        assert.equal(page.FIREBASE_APPCHECK_DEBUG_TOKEN, 'local-harness-token');
        configureAppCheckDebug(page, false, hostname);
        assert.equal(page.FIREBASE_APPCHECK_DEBUG_TOKEN, false);
    }
    for (const dev of [true, false]) {
        for (const hostname of ['wexy.ai', 'dev.wexy.ai', 'wexy-dev.web.app']) {
            const page = { FIREBASE_APPCHECK_DEBUG_TOKEN: 'must-not-be-used' };
            configureAppCheckDebug(page, dev, hostname);
            assert.equal(page.FIREBASE_APPCHECK_DEBUG_TOKEN, false);
        }
    }
});

const base = { firebase: null, appCheckSiteKey: null };

/** A Storage stand-in on globalThis for the duration of `run`. */
async function withStorage(run) {
    const kept = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const map = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) },
    });
    try { return await run(map); } finally {
        if (kept) Object.defineProperty(globalThis, 'localStorage', kept); else delete globalThis.localStorage;
    }
}

test('U33 a development build on a loopback gateway sends the local dev token, and keeps its uid', async () => {
    await withStorage(async map => {
        const id = createIdentity({ ...base, dev: true, apiOrigin: 'http://localhost:8400' });
        const auth = await id.authorization(false);
        assert.match(auth, /^Bearer dev\.anonymous\.[a-f0-9]{32}$/);
        assert.equal(await id.authorization(true), auth);
        assert.equal(await createIdentity({ ...base, dev: true, apiOrigin: 'http://127.0.0.1:8400' }).authorization(false), auth);
        assert.equal(map.get('wexy.devUid'), auth.split('.').pop());
        assert.equal(await id.appCheck(true), null);
    });
});

test('U34 nothing else gets a dev token: a production build, or a gateway that is not loopback', async () => {
    await withStorage(async () => {
        assert.equal(await createIdentity({ ...base, dev: false, apiOrigin: 'http://localhost:8400' }).authorization(false), null);
        assert.equal(await createIdentity({ ...base, dev: true, apiOrigin: 'https://api.wexy.ai' }).authorization(false), null);
        assert.equal(await createIdentity({ ...base, dev: true, apiOrigin: null }).authorization(false), null);
    });
});

test('U35 blocked storage costs only the uid\'s stability', async () => {
    const kept = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
        assert.match(await createIdentity({ ...base, dev: true, apiOrigin: 'http://localhost:8400' }).authorization(false), /^Bearer dev\.anonymous\.[a-f0-9]{32}$/);
    } finally {
        if (kept) Object.defineProperty(globalThis, 'localStorage', kept); else delete globalThis.localStorage;
    }
});
