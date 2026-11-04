// U-series, headless: the backend's error contract as the client holds it (src/forge-client/errors.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeForStatus, ERROR_STATUS, errorFromResponse, ForgeError, isErrorCode } from '../src/forge-client/errors.ts';

// ai.wexy.common.ErrorCode, 2026-10-27, with W1's content-refused and quota (2026-11-02, the creations platform designs
// §10), W2's conflict (2026-11-03) and W3's storage-full (2026-11-03 evening): change both on the same day (design
// guidelines §1).
const BACKEND = {
    'bad-request': 400, 'auth': 401, 'appcheck': 403, 'account-required': 403, 'forbidden': 403, 'storage-full': 403, 'not-found': 404,
    'conflict': 409, 'too-large': 413, 'content-refused': 422, 'rate': 429, 'quota': 429, 'internal': 500, 'upstream': 502,
    'budget': 503, 'paused': 503, 'unavailable': 503, 'timeout': 504,
};

test('U1 the eighteen codes and their statuses are the backend\'s, exactly', () => {
    assert.deepEqual({ ...ERROR_STATUS }, BACKEND);
});

test('U2 a status without one of our codes maps as ErrorCode.forStatus does: a bare 422 is no refusal, a bare 429 no quota, a bare 409 a conflict', () => {
    const want = { 401: 'auth', 403: 'forbidden', 404: 'not-found', 409: 'conflict', 413: 'too-large', 422: 'bad-request', 429: 'rate', 502: 'upstream',
        503: 'unavailable', 504: 'timeout', 500: 'internal', 501: 'internal', 599: 'internal', 400: 'bad-request', 418: 'bad-request', 0: 'bad-request' };
    for (const [status, code] of Object.entries(want)) assert.equal(codeForStatus(Number(status)), code, `status ${status}`);
});

test('U3 isErrorCode accepts the closed set only', () => {
    for (const code of Object.keys(BACKEND)) assert.ok(isErrorCode(code), code);
    for (const v of ['Auth', 'ok', '', null, 401, 'toString', '__proto__']) assert.ok(!isErrorCode(v), String(v));
});

const response = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('U4 the envelope gives the code and the message; the status travels with it', async () => {
    const e = await errorFromResponse(response(503, { code: 'paused', message: 'Live creation is paused.' }));
    assert.ok(e instanceof ForgeError);
    assert.deepEqual([e.code, e.status, e.message, e.retryAfterSeconds], ['paused', 503, 'Live creation is paused.', null]);
});

test('U5 a body that is not ours, or a code we do not know, falls back to the status', async () => {
    const html = await errorFromResponse(response(502, '<html>Bad gateway</html>'));
    assert.deepEqual([html.code, html.message], ['upstream', 'HTTP 502']);
    const unknown = await errorFromResponse(response(503, { code: 'meltdown', message: 'x' }));
    assert.equal(unknown.code, 'unavailable');
});

test('U6 Retry-After counts only on rate and quota, only as whole seconds; absent is unknown, never zero', async () => {
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }, { 'Retry-After': '120' }))).retryAfterSeconds, 120);
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }))).retryAfterSeconds, null);
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).retryAfterSeconds, null);
    assert.equal((await errorFromResponse(response(503, { code: 'budget', message: 'm' }, { 'Retry-After': '60' }))).retryAfterSeconds, null);
    // W1: early access's world of the day is made; the wait is the time to the reset, which the studio shows.
    const quota = await errorFromResponse(response(429, { code: 'quota', message: 'Today\'s world is made.' }, { 'Retry-After': '30600' }));
    assert.deepEqual([quota.code, quota.status, quota.retryAfterSeconds], ['quota', 429, 30_600]);
    assert.equal((await errorFromResponse(response(429, { code: 'quota', message: 'm' }))).retryAfterSeconds, null, 'absent is unknown');
    // A refusal and a spent anonymous allowance have no wait: no countdown is ever made up for them.
    const refused = await errorFromResponse(response(422, { code: 'content-refused', message: 'm' }, { 'Retry-After': '60' }));
    assert.deepEqual([refused.code, refused.retryAfterSeconds], ['content-refused', null]);
    assert.equal((await errorFromResponse(response(403, { code: 'account-required', message: 'm' }, { 'Retry-After': '60' }))).retryAfterSeconds, null);
    // W3: a full storage is met by deleting a world, so it never carries a countdown, whatever a header says.
    const full = await errorFromResponse(response(403, { code: 'storage-full', message: 'm' }, { 'Retry-After': '60' }));
    assert.deepEqual([full.code, full.status, full.retryAfterSeconds], ['storage-full', 403, null]);
});

test('U7 a message is capped, so a misbehaving server cannot flood the log', async () => {
    const e = await errorFromResponse(response(500, { code: 'internal', message: 'x'.repeat(5000) }));
    assert.equal(e.message.length, 300);
});

test('U8 a 403 without our envelope (an edge\'s page) is bare, no service\'s word on the account; the gateway\'s own forbidden is not (2026-11-04)', async () => {
    const page = await errorFromResponse(new Response('<html>403</html>', { status: 403 }));
    assert.deepEqual([page.code, page.bare], ['forbidden', true]);
    const theirs = await errorFromResponse(new Response(JSON.stringify({ code: 'forbidden', message: 'This account can\'t make worlds right now.' }), { status: 403 }));
    assert.deepEqual([theirs.code, theirs.bare], ['forbidden', false]);
    const unknown = await errorFromResponse(new Response(JSON.stringify({ code: 'nope', message: 'm' }), { status: 403 }));
    assert.equal(unknown.bare, true, 'a body whose code is not ours is no word of ours');
    assert.equal(new ForgeError('forbidden', 403, 'x').bare, false, 'a code the backend sent in its own stream is its word');
});
