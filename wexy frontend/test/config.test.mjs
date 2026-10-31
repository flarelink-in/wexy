// U-series, headless: the public configuration (src/forge-client/config.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopback, parseConfig } from '../src/forge-client/config.ts';

const FIREBASE = {
    VITE_FIREBASE_API_KEY: 'AIza-public-key', VITE_FIREBASE_AUTH_DOMAIN: 'wexy-bf8f8.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'wexy-bf8f8', VITE_FIREBASE_APP_ID: '1:795522259221:web:abc',
};

test('U8 a complete configuration parses with no problems', () => {
    const { config, problems } = parseConfig({ VITE_API_ORIGIN: 'https://api.wexy.ai', ...FIREBASE, VITE_APPCHECK_SITE_KEY: 'site-key', DEV: false });
    assert.deepEqual(problems, []);
    assert.equal(config.apiOrigin, 'https://api.wexy.ai');
    assert.equal(config.firebase?.projectId, 'wexy-bf8f8');
    assert.equal(config.appCheckSiteKey, 'site-key');
    assert.equal(config.dev, false);
});

test('U9 the origin: https anywhere, http only on loopback, a trailing slash tolerated, a path refused', () => {
    const origin = v => parseConfig({ VITE_API_ORIGIN: v }).config.apiOrigin;
    assert.equal(origin('http://localhost:8400'), 'http://localhost:8400');
    assert.equal(origin('http://127.0.0.1:8400/'), 'http://127.0.0.1:8400');
    assert.equal(origin('https://api.wexy.ai/'), 'https://api.wexy.ai');
    for (const bad of ['http://api.wexy.ai', 'https://api.wexy.ai/v1', 'api.wexy.ai', 'ftp://localhost', 'javascript:alert(1)']) {
        const { config, problems } = parseConfig({ VITE_API_ORIGIN: bad });
        assert.equal(config.apiOrigin, null, bad);
        assert.equal(problems.length, 1, bad);
    }
});

test('U10 a missing origin is a problem; a missing Firebase config is a choice', () => {
    const { config, problems } = parseConfig({ VITE_API_ORIGIN: 'http://localhost:8400' });
    assert.deepEqual(problems, []);
    assert.equal(config.firebase, null);
    assert.match(parseConfig({}).problems[0], /VITE_API_ORIGIN is not set/);
});

test('U11 a half Firebase config turns sign-in off and says which fields are missing', () => {
    const { config, problems } = parseConfig({ VITE_API_ORIGIN: 'http://localhost:8400', VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_PROJECT_ID: 'wexy-bf8f8' });
    assert.equal(config.firebase, null);
    assert.match(problems[0], /authDomain, appId not set/);
});

test('U12 App Check needs the Firebase config: a site key alone is refused, not half-used', () => {
    const { config, problems } = parseConfig({ VITE_API_ORIGIN: 'http://localhost:8400', VITE_APPCHECK_SITE_KEY: 'k' });
    assert.equal(config.appCheckSiteKey, null);
    assert.match(problems[0], /App Check stays off/);
});

test('U13 only DEV === true is a development build', () => {
    for (const [dev, want] of [[true, true], ['true', false], [1, false], [undefined, false]]) {
        assert.equal(parseConfig({ VITE_API_ORIGIN: 'http://localhost:8400', DEV: dev }).config.dev, want, String(dev));
    }
});

test('U14 loopback is localhost, 127/8 and ::1, nothing that merely looks like it', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.ok(isLoopback(h), h);
    for (const h of ['localhost.wexy.ai', '127.0.0.1.nip.io', '10.0.0.5', '0.0.0.0', 'wexy.ai']) assert.ok(!isLoopback(h), h);
});
