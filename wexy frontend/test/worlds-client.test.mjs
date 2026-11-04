// PL-FE2 at the wire (W3; the creations platform companion §10's W3 note, §11): the world calls of src/platform/worlds.ts
// through the real transport (createApi) and the real error table (errorFromResponse), over a fake fetch and identity.
// Each call's method, path, body keys, Idempotency-Key and App Check kind, exactly; an id that is not a ULID refused
// before anything is sent; and each refusal the platform can give mapped to what the studio does with it: a conflict, a
// full storage (never a countdown), a refusal that sending again would not change, or "unavailable" (the same key again).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/forge-client/http.ts';
import { errorFromResponse } from '../src/forge-client/errors.ts';
import {
    createWorld, deleteWorld, listWorlds, readOperation, readRevision, readUsage, readWorld, renameWorld, reviseWorld,
} from '../src/platform/worlds.ts';

const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };
const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const REV = '01JC3W5F6Q7R8S9T0V1W2X3Y50';
const OP = '01JC3W5F6Q7R8S9T0V1W2X3Y60';
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SHA = 'b'.repeat(64);
const TIME = '2026-11-04T09:00:00.000Z';
const VIEW = { worldId: WORLD, title: 'The castle', rowVersion: 2, createdAt: TIME, updatedAt: TIME,
    head: { revisionId: REV, sha256: SHA, bytes: 20541, format: 'wexy-world.v1', line: 'ea.v1', createdAt: TIME } };
const REQUEST = { key: KEY, text: '{"format":"wexy-world.v1"}', sha256: SHA };

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const refusal = (status, code, headers = {}) => json(status, { code, message: `${code} said by the platform` }, headers);

/** The transport over a fake fetch answering from a list, recording each request and what the identity was asked. */
function wire(...answers) {
    const calls = [];
    const requests = [];
    let n = 0;
    const identity = {
        async authorization(force) { calls.push(force ? 'auth (refresh)' : 'auth'); return `Bearer id-${++n}`; },
        async appCheck(singleUse) { calls.push(singleUse ? 'appcheck single-use' : 'appcheck cached'); return `ac-${++n}`; },
    };
    const fetchImpl = async (url, init) => {
        requests.push({ url, method: init.method, headers: Object.fromEntries(init.headers.entries()), body: init.body });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next ?? json(200, {});
    };
    return { api: createApi(CONFIG, identity, fetchImpl), calls, requests };
}

test('PL-FE2 a save goes as the contract says: POST /v1/worlds with exactly {title, artifact, sha256}, its key, the cached App Check token', async () => {
    const w = wire(json(201, VIEW));
    const answer = await createWorld(w.api, 'The castle', REQUEST);
    assert.deepEqual(answer, { kind: 'saved', world: VIEW });
    const [r] = w.requests;
    assert.deepEqual([r.method, r.url], ['POST', 'http://localhost:8400/v1/worlds']);
    assert.equal(r.headers['idempotency-key'], KEY);
    assert.equal(r.headers['content-type'], 'application/json');
    const body = JSON.parse(r.body);
    assert.deepEqual(Object.keys(body).sort(), ['artifact', 'sha256', 'title']);
    assert.equal(typeof body.artifact, 'string', 'the canonical text travels as a string, never a nested object');
    assert.equal(body.artifact, REQUEST.text);
    assert.deepEqual(w.calls, ['auth', 'appcheck cached'], 'a save is not a single-use route (W2)');
});

test('PL-FE2 a revision names the head and the version it was read at, under its key; a 202 is the operation to follow', async () => {
    const w = wire(json(202, { operationId: OP, state: 'PENDING' }));
    const answer = await reviseWorld(w.api, { worldId: WORLD, revisionId: REV, rowVersion: 2 }, REQUEST);
    assert.deepEqual(answer, { kind: 'pending', operationId: OP });
    const [r] = w.requests;
    assert.deepEqual([r.method, r.url], ['POST', `http://localhost:8400/v1/worlds/${WORLD}/revisions`]);
    assert.equal(r.headers['idempotency-key'], KEY);
    assert.deepEqual(JSON.parse(r.body), { baseRevisionId: REV, expectedVersion: 2, artifact: REQUEST.text, sha256: SHA });
    assert.deepEqual(w.calls, ['auth', 'appcheck cached']);
});

test('PL-FE2 a rename is a PATCH of exactly {expectedVersion, title}, with no key; a deletion a DELETE with no body, its version in the query and its key', async () => {
    const w = wire(json(200, { ...VIEW, title: 'Renamed', rowVersion: 3 }), json(202, { operationId: OP, state: 'PENDING' }));
    assert.equal((await renameWorld(w.api, VIEW, 'Renamed')).kind, 'done');
    assert.equal((await deleteWorld(w.api, VIEW, KEY)).kind, 'deleting');
    const [rename, del] = w.requests;
    assert.deepEqual([rename.method, rename.url], ['PATCH', `http://localhost:8400/v1/worlds/${WORLD}`]);
    assert.deepEqual(JSON.parse(rename.body), { expectedVersion: 2, title: 'Renamed' });
    assert.equal(rename.headers['idempotency-key'], undefined);
    assert.deepEqual([del.method, del.url], ['DELETE', `http://localhost:8400/v1/worlds/${WORLD}?expectedVersion=2`]);
    assert.equal(del.body, undefined, 'a DELETE sends no body');
    assert.equal(del.headers['content-type'], undefined);
    assert.equal(del.headers['idempotency-key'], KEY);
    assert.deepEqual(w.calls, ['auth', 'appcheck cached', 'auth', 'appcheck cached'], 'neither is single-use');
});

test('PL-FE2 the reads: the history\'s page by its limit and cursor, a world, a revision, the usage and an operation, all GETs with no key', async () => {
    const revision = { worldId: WORLD, revisionId: REV, sha256: SHA, bytes: 26, format: 'wexy-world.v1', line: 'ea.v1', createdAt: TIME, artifact: REQUEST.text };
    const w = wire(json(200, { worlds: [VIEW], next: 'cursor_2-x' }), json(200, VIEW), json(200, revision),
        json(200, { usedBytes: 20541, reservedBytes: 0, worlds: 1, limits: { bytes: 104857600, worlds: 50 } }),
        json(200, { operationId: OP, state: 'DONE', status: 201, result: VIEW }));
    assert.deepEqual(await listWorlds(w.api, { limit: 24, cursor: 'cursor_1-x' }), { worlds: [VIEW], next: 'cursor_2-x' });
    assert.deepEqual(await readWorld(w.api, WORLD), VIEW);
    assert.equal((await readRevision(w.api, WORLD, REV)).artifact, REQUEST.text);
    assert.equal((await readUsage(w.api)).limits.worlds, 50);
    assert.equal((await readOperation(w.api, OP)).status, 201);
    assert.deepEqual(w.requests.map(r => [r.method, r.url.replace('http://localhost:8400', '')]), [
        ['GET', '/v1/me/worlds?limit=24&cursor=cursor_1-x'], ['GET', `/v1/worlds/${WORLD}`], ['GET', `/v1/worlds/${WORLD}/revisions/${REV}`],
        ['GET', '/v1/me/usage'], ['GET', `/v1/me/operations/${OP}`]]);
    assert.ok(w.requests.every(r => r.body === undefined && r.headers['idempotency-key'] === undefined));
});

test('PL-FE2 an id that is not a ULID never reaches a path: nothing is sent', async () => {
    const w = wire();
    for (const bad of ['../me', 'abc', `${WORLD}/x`, WORLD.toLowerCase(), `${WORLD}?expectedVersion=0`, '01JC3W5F6Q7R8S9T0V1W2X3Y4I']) {
        assert.equal((await reviseWorld(w.api, { worldId: bad, revisionId: REV, rowVersion: 0 }, REQUEST)).kind, 'refused', bad);
        assert.equal((await renameWorld(w.api, { ...VIEW, worldId: bad }, 't')).kind, 'missing', bad);
        assert.equal((await deleteWorld(w.api, { ...VIEW, worldId: bad }, KEY)).kind, 'missing', bad);
        assert.equal(await readWorld(w.api, bad), 'missing', bad);
        assert.equal(await readRevision(w.api, WORLD, bad), 'missing', bad);
        assert.equal(await readOperation(w.api, bad), null, bad);
    }
    assert.equal(w.requests.length, 0);
});

test('PL-FE2 each refusal the platform gives is what the studio does with it; a full storage never carries a countdown', async () => {
    // What the error table makes of the envelope: storage-full keeps no Retry-After even when one is sent; quota keeps it.
    const full = await errorFromResponse(refusal(403, 'storage-full', { 'Retry-After': '60' }));
    assert.deepEqual([full.code, full.status, full.retryAfterSeconds], ['storage-full', 403, null]);
    const quota = await errorFromResponse(refusal(429, 'quota', { 'Retry-After': '3600' }));
    assert.deepEqual([quota.code, quota.retryAfterSeconds], ['quota', 3600]);
    const bare = await errorFromResponse(new Response('<html>403</html>', { status: 403 }));
    assert.equal(bare.code, 'forbidden', 'a bare 403 (an edge\'s HTML) is forbidden, never storage-full');

    const cases = [
        [refusal(409, 'conflict'), { kind: 'conflict' }],
        [refusal(403, 'storage-full', { 'Retry-After': '60' }), { kind: 'storage-full' }],
        [refusal(403, 'forbidden'), 'refused:forbidden'],
        [refusal(400, 'bad-request'), 'refused:bad-request'],
        [refusal(413, 'too-large'), 'refused:too-large'],
        [refusal(404, 'not-found'), 'refused:not-found'],
        [refusal(429, 'rate', { 'Retry-After': '2' }), { kind: 'unavailable', status: 429 }],
        [refusal(503, 'unavailable'), { kind: 'unavailable', status: 503 }],
        [new TypeError('Failed to fetch'), 'unavailable:0'],
        [json(201, { ...VIEW, extra: 1 }), { kind: 'unavailable', status: 201 }],
    ];
    for (const [answer, expected] of cases) {
        const w = wire(answer);
        const got = await createWorld(w.api, 'The castle', REQUEST);
        if (typeof expected === 'string') {
            const [kind, detail] = expected.split(':');
            assert.equal(got.kind, kind, expected);
            if (kind === 'refused') assert.equal(got.code, detail, expected);
            else assert.equal(got.status, Number(detail), expected);
        } else {
            assert.deepEqual(got, expected, JSON.stringify(expected));
        }
        assert.equal(w.requests.length, 1, 'answered once: retrying is the controller\'s, under the same key');
    }
});

test('PL-FE2 a rename\'s and a deletion\'s refusals: a stale version is a conflict, a world gone or another\'s is missing, the rest unavailable', async () => {
    const rename = async res => (await renameWorld(wire(res).api, VIEW, 'New')).kind;
    const del = async res => (await deleteWorld(wire(res).api, VIEW, KEY)).kind;
    assert.equal(await rename(refusal(409, 'conflict')), 'conflict');
    assert.equal(await rename(refusal(404, 'not-found')), 'missing');
    assert.equal(await rename(refusal(400, 'bad-request')), 'refused');
    assert.equal(await rename(refusal(503, 'unavailable')), 'unavailable');
    assert.equal(await del(refusal(409, 'conflict')), 'conflict');
    assert.equal(await del(refusal(404, 'not-found')), 'missing');
    assert.equal(await del(refusal(403, 'forbidden')), 'unavailable');
    assert.equal(await del(json(200, VIEW)), 'unavailable', 'a deletion is accepted (202 and its operation), never a world');
    assert.equal(await readWorld(wire(refusal(503, 'unavailable')).api, WORLD), 'unavailable', 'a 503 is never "gone"');
    assert.equal(await readRevision(wire(refusal(404, 'not-found')).api, WORLD, REV), 'missing');
});
