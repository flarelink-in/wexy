// U-series, headless: the backend's error contract as the client holds it (src/forge-client/errors.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeForStatus, ERROR_STATUS, errorFromResponse, ForgeError, isErrorCode } from '../src/forge-client/errors.ts';

// ai.wexy.common.ErrorCode, 2026-10-27: change both on the same day (design guidelines §1).
const BACKEND = {
    'bad-request': 400, 'auth': 401, 'appcheck': 403, 'account-required': 403, 'forbidden': 403, 'not-found': 404,
    'too-large': 413, 'rate': 429, 'internal': 500, 'upstream': 502, 'budget': 503, 'paused': 503,
    'unavailable': 503, 'timeout': 504,
};

test('U1 the fourteen codes and their statuses are the backend\'s, exactly', () => {
    assert.deepEqual({ ...ERROR_STATUS }, BACKEND);
});

test('U2 a status without one of our codes maps as ErrorCode.forStatus does', () => {
    const want = { 401: 'auth', 403: 'forbidden', 404: 'not-found', 413: 'too-large', 429: 'rate', 502: 'upstream',
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

test('U6 Retry-After counts only on rate, only as whole seconds; absent is unknown, never zero', async () => {
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }, { 'Retry-After': '120' }))).retryAfterSeconds, 120);
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }))).retryAfterSeconds, null);
    assert.equal((await errorFromResponse(response(429, { code: 'rate', message: 'm' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).retryAfterSeconds, null);
    assert.equal((await errorFromResponse(response(503, { code: 'budget', message: 'm' }, { 'Retry-After': '60' }))).retryAfterSeconds, null);
});

test('U7 a message is capped, so a misbehaving server cannot flood the log', async () => {
    const e = await errorFromResponse(response(500, { code: 'internal', message: 'x'.repeat(5000) }));
    assert.equal(e.message.length, 300);
});
