// PL-FE10 and PL-FE4 (W3; the creations platform companion §7, F8, §11): the world on the stage saved once it is there
// (Q124), over a fake gateway that records every request: one save per Live install, a revision on the head its save
// produced, nothing for a starter, a replay, a reopened world, an anonymous caller or an old epoch; one key for every try
// of one request; a conflict, a full storage and a save still under way. And the world client's DTOs, held to their
// closed shapes. No GPU, no model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ForgeError } from '../src/forge-client/errors.ts';
import { parseWorld } from '../src/platform/artifact.ts';
import { openWorld } from '../src/platform/reopen.ts';
import { createSaveController } from '../src/platform/save-controller.ts';
import { createWorld, listWorlds, parseOperation, parseWorldView, readRevision } from '../src/platform/worlds.ts';

const CASTLE = readFileSync(new URL('./fixtures/worlds/castle.wexy-world.json', import.meta.url), 'utf8');
const DESIGN = JSON.parse(CASTLE).design;
const SNAPSHOT = (await openWorld((await parseWorld(CASTLE, null)).world, 'test')).snapshot;

const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const REV = ['01JC3W5F6Q7R8S9T0V1W2X3Y50', '01JC3W5F6Q7R8S9T0V1W2X3Y51', '01JC3W5F6Q7R8S9T0V1W2X3Y52'];
const OP = '01JC3W5F6Q7R8S9T0V1W2X3Y60';
const SHA = 'a'.repeat(64);
const TIME = '2026-11-03T12:00:00.000Z';
const world = (rev = 0, version = rev) => ({ worldId: WORLD, title: 'The castle', rowVersion: version, createdAt: TIME, updatedAt: TIME,
    head: { revisionId: REV[rev], sha256: SHA, bytes: 20541, format: 'wexy-world.v1', line: 'ea.v1', createdAt: TIME } });

/**
 * A gateway answering each "METHOD path" from a list (a body for 2xx, a ForgeError to throw, or a function of the
 * request), recording each request; `hold(route)` keeps that route's next answer until released.
 */
function fakeApi(routes) {
    const sent = [];
    const held = new Map();
    return {
        sent,
        hold(route) {
            let release;
            held.set(route, new Promise(r => { release = r; }));
            return () => release();
        },
        async send(req) {
            sent.push({ method: req.method, path: req.path, body: req.body, key: req.idempotencyKey });
            const route = `${req.method} ${req.path.replace(/\?.*$/, '')}`;
            if (held.has(route)) {
                const gate = held.get(route);
                held.delete(route);
                await gate;
            }
            const list = routes[route] ?? [];
            const next = typeof list === 'function' ? list(req) : list.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new ForgeError('not-found', 404, 'No such route.');
            return new Response(JSON.stringify(next.body ?? next), { status: next.status ?? 201 });
        },
    };
}

/** The controller over a fake gateway and account; `onWait` runs at each retry's or poll's pause (a switch, say). */
function harness(routes, accountKind = 'active', onWait = () => {}) {
    const api = fakeApi(routes);
    const account = { epoch: 1, kind: accountKind };
    const states = [];
    let n = 0;
    const saves = createSaveController({
        api, account: () => ({ ...account }), newKey: () => `key-0000-0000-000${++n}`, wait: async () => { onWait(account); },
        changed: s => states.push(s),
    });
    return { api, account, states, saves };
}

/**
 * Waits until the fake gateway has been sent `n` requests, at most 5 s: a save builds and hashes its text before it
 * sends, which a fixed pause under the whole suite's load did not always cover.
 */
async function sentAtLeast(h, n) {
    for (let i = 0; i < 500 && h.api.sent.length < n; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(h.api.sent.length >= n, `${n} request(s) sent`);
}

const installed = (stage, extra = {}) => ({ stage, source: 'live', snapshot: SNAPSHOT, design: DESIGN, view: null, title: 'The castle', improves: null, ...extra });

test('PL-FE10 a Live world installed while signed in is saved once, as the canonical text it was on the stage', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0)] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.equal(h.api.sent.length, 1);
    const [r] = h.api.sent;
    assert.deepEqual([r.method, r.path], ['POST', '/v1/worlds']);
    assert.deepEqual(Object.keys(r.body).sort(), ['artifact', 'sha256', 'title']);
    assert.equal(r.body.title, 'The castle');
    assert.equal(r.body.artifact, CASTLE, 'the very text the corpus holds: canonical, the same bytes');
    assert.match(r.key, /^key-/);
    assert.deepEqual(h.saves.state(), { stage: 1, status: 'saved', worldId: WORLD, revisionId: REV[0], rowVersion: 0, detail: '' });
});

test('PL-FE10 an improvement installed while its world is being saved waits, then is a revision on that save\'s head', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0)], [`POST /v1/worlds/${WORLD}/revisions`]: [world(1)] });
    const release = h.api.hold('POST /v1/worlds');
    h.saves.installed(installed(1));
    await sentAtLeast(h, 1);
    assert.equal(h.api.sent.length, 1, 'the first save is under way');
    h.saves.installed(installed(2, { improves: 1 }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h.api.sent.length, 1, 'the revision waits for the first save');
    release();
    await h.saves.settled();
    assert.deepEqual(h.api.sent.map(r => r.path), ['/v1/worlds', `/v1/worlds/${WORLD}/revisions`]);
    const rev = h.api.sent[1];
    assert.deepEqual(Object.keys(rev.body).sort(), ['artifact', 'baseRevisionId', 'expectedVersion', 'sha256']);
    assert.deepEqual([rev.body.baseRevisionId, rev.body.expectedVersion], [REV[0], 0]);
    assert.notEqual(rev.key, h.api.sent[0].key, 'another request, another key');
    assert.equal(h.saves.state().revisionId, REV[1]);
});

test('PL-FE10 a world improved before its own save began is not saved: the newest stands for it, sent once', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0)] });
    h.saves.installed(installed(1));
    h.saves.installed(installed(2, { improves: 1 }));
    await h.saves.settled();
    assert.deepEqual(h.api.sent.map(r => r.path), ['/v1/worlds']);
    assert.equal(h.saves.state().stage, 2);
    assert.equal(h.saves.state().status, 'saved');
});

test('PL-FE10 starters, replays and reopened worlds are not saved again; a reopened world\'s improvement revises it', async () => {
    const h = harness({ [`POST /v1/worlds/${WORLD}/revisions`]: [world(2, 4)] });
    h.saves.installed(installed(1, { source: 'starter' }));
    h.saves.installed(installed(2, { source: 'archive' }));
    h.saves.installed(installed(3, { source: 'reopened', saved: { worldId: WORLD, revisionId: REV[1], rowVersion: 3 } }));
    await h.saves.settled();
    assert.equal(h.api.sent.length, 0);
    assert.equal(h.saves.state().status, 'saved');
    h.saves.installed(installed(4, { improves: 3 }));
    await h.saves.settled();
    assert.deepEqual(h.api.sent.map(r => [r.path, r.body.baseRevisionId, r.body.expectedVersion]), [[`/v1/worlds/${WORLD}/revisions`, REV[1], 3]]);
});

test('PL-FE10 anonymous: nothing is sent, "Sign in to keep this world"; once signed in, the world on the stage is saved', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0)] }, 'anonymous');
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.equal(h.api.sent.length, 0);
    assert.equal(h.saves.state().status, 'sign-in');
    Object.assign(h.account, { epoch: 2, kind: 'active' });
    h.saves.accountChanged();
    await h.saves.settled();
    assert.equal(h.api.sent.length, 1);
    assert.equal(h.saves.state().status, 'saved');
});

test('PL-FE10 an answer for an account no longer signed in is dropped, and another account does not continue the world by itself', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0), world(0)] });
    const release = h.api.hold('POST /v1/worlds');
    h.saves.installed(installed(1));
    await sentAtLeast(h, 1);
    h.account.epoch = 2;
    release();
    await h.saves.settled();
    assert.deepEqual([h.saves.state().status, h.saves.state().worldId], ['not-saved', null]);
    // Saved under epoch 2, then a switch to epoch 3: nothing is sent; Save is the creator's.
    await h.saves.retry();
    assert.equal(h.saves.state().status, 'saved');
    h.account.epoch = 3;
    h.saves.accountChanged();
    await h.saves.settled();
    assert.deepEqual([h.api.sent.length, h.saves.state().status, h.saves.state().worldId], [2, 'not-saved', null]);
});

test('PL-FE4 an answer lost to the network is sent again with the same key; a 202 is followed to its answer', async () => {
    const h = harness({
        'POST /v1/worlds': [new ForgeError('unavailable', 0, 'no answer'), { status: 202, body: { operationId: OP, state: 'PENDING' } }],
        [`GET /v1/me/operations/${OP}`]: [{ status: 200, body: { operationId: OP, state: 'PENDING', status: null, result: null } },
            { status: 200, body: { operationId: OP, state: 'DONE', status: 201, result: world(0) } }],
    });
    h.saves.installed(installed(1));
    await h.saves.settled();
    const saves = h.api.sent.filter(r => r.method === 'POST');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].key, saves[1].key, 'one request, one key');
    assert.equal(h.api.sent.filter(r => r.method === 'GET').length, 2);
    assert.equal(h.saves.state().status, 'saved');
});

test('PL-FE4 still unanswered after its retry: "Not saved"; "Try again" sends the same key; a full storage is said once and never retried by itself', async () => {
    const lost = () => new ForgeError('unavailable', 503, 'Saving worlds is unavailable right now.');
    const h = harness({ 'POST /v1/worlds': [lost(), lost(), world(0)] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.equal(h.saves.state().status, 'failed');
    await h.saves.retry();
    assert.equal(h.saves.state().status, 'saved');
    assert.equal(new Set(h.api.sent.map(r => r.key)).size, 1, 'every try of the one request under one key');

    const full = harness({ 'POST /v1/worlds': [new ForgeError('storage-full', 403, 'full')] });
    full.saves.installed(installed(1));
    await full.saves.settled();
    assert.deepEqual([full.api.sent.length, full.saves.state().status], [1, 'storage-full']);
});

test('PL-FE4 a conflict keeps the world and its text; "Save as a new world" posts it as a world of its own under a fresh key', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0), world(0)], [`POST /v1/worlds/${WORLD}/revisions`]: [new ForgeError('conflict', 409, 'moved')] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    h.saves.installed(installed(2, { improves: 1 }));
    await h.saves.settled();
    assert.equal(h.saves.state().status, 'conflict');
    await h.saves.saveAsNew();
    const last = h.api.sent.at(-1);
    assert.deepEqual([last.path, Object.keys(last.body).sort()], ['/v1/worlds', ['artifact', 'sha256', 'title']]);
    assert.notEqual(last.key, h.api.sent[1].key);
    assert.equal(h.saves.state().status, 'saved');
});

// The review of 11-03, its high: the transport attaches whoever is signed in when it sends, so a request must never go
// out after the account it was asked under has changed. Each case switches the account at a different moment.
test('PL-FE10 a retry is never sent once another account has signed in', async () => {
    const h = harness({ 'POST /v1/worlds': [new ForgeError('unavailable', 0, 'no answer'), world(0)] }, 'active', a => { a.epoch = 2; });
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.equal(h.api.sent.length, 1, 'the first try only: the retry would have gone out under the new account');
    assert.deepEqual([h.saves.state().status, h.saves.state().worldId], ['not-saved', null]);
});

test('PL-FE10 a save queued behind another is not sent once another account has signed in', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0), world(0)] });
    const release = h.api.hold('POST /v1/worlds');
    h.saves.installed(installed(1));
    await sentAtLeast(h, 1);
    h.saves.installed(installed(2));
    h.account.epoch = 2;
    h.saves.accountChanged();
    release();
    await h.saves.settled();
    assert.equal(h.api.sent.length, 1, 'the second world, installed under the first account, is not saved for the next');
    assert.equal(h.saves.state().status, 'not-saved');
});

test('PL-FE10 a save under way is not followed once another account has signed in', async () => {
    const h = harness({ 'POST /v1/worlds': [{ status: 202, body: { operationId: OP, state: 'PENDING' } }],
        [`GET /v1/me/operations/${OP}`]: () => ({ status: 200, body: { operationId: OP, state: 'DONE', status: 201, result: world(0) } }) },
    'active', a => { a.epoch = 2; });
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.deepEqual(h.api.sent.map(r => r.method), ['POST'], 'no poll under the new account');
    assert.equal(h.saves.state().status, 'not-saved');
});

test('PL-FE10 a creation begun under another account is not continued, even before the switch is told', async () => {
    const h = harness({ 'POST /v1/worlds': [world(0)], [`POST /v1/worlds/${WORLD}/revisions`]: [world(1)] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    // The session moved on, and the studio has not said so yet: the improvement's save is the second layer.
    h.account.epoch = 2;
    h.saves.installed(installed(2, { improves: 1 }));
    await h.saves.settled();
    assert.deepEqual(h.api.sent.map(r => r.path), ['/v1/worlds'], 'no revision of the first account\'s world under the second');
    assert.equal(h.saves.state().status, 'not-saved');
});

// Its mid: a create with no answer may have committed. Its improvement resolves it first, the same body under the same
// key, so the platform answers as it answered the first, and never makes a second world.
test('PL-FE10 an improvement first resolves its parent\'s unanswered create under that create\'s key, then revises it', async () => {
    const lost = () => new ForgeError('unavailable', 0, 'no answer');
    const h = harness({ 'POST /v1/worlds': [lost(), lost(), world(0)], [`POST /v1/worlds/${WORLD}/revisions`]: [world(1)] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    assert.equal(h.saves.state().status, 'offline');
    h.saves.installed(installed(2, { improves: 1 }));
    await h.saves.settled();
    const creates = h.api.sent.filter(r => r.path === '/v1/worlds');
    assert.equal(creates.length, 3);
    assert.equal(new Set(creates.map(r => r.key)).size, 1, 'one create, one key: never a second world');
    assert.equal(creates[2].body.artifact, creates[0].body.artifact, 'the same body');
    const rev = h.api.sent.at(-1);
    assert.deepEqual([rev.path, rev.body.baseRevisionId], [`/v1/worlds/${WORLD}/revisions`, REV[0]]);
    assert.notEqual(rev.key, creates[0].key);
    assert.equal(h.saves.state().status, 'saved');
});

test('PL-FE10 while the parent stays unanswered nothing new is sent for its creation; "Try again" resolves it, then revises', async () => {
    const lost = () => new ForgeError('unavailable', 0, 'no answer');
    const h = harness({ 'POST /v1/worlds': [lost(), lost(), lost(), lost(), world(0)], [`POST /v1/worlds/${WORLD}/revisions`]: [world(1)] });
    h.saves.installed(installed(1));
    await h.saves.settled();
    h.saves.installed(installed(2, { improves: 1 }));
    await h.saves.settled();
    assert.equal(h.api.sent.length, 4, 'only the parent\'s create, tried again');
    assert.equal(new Set(h.api.sent.map(r => r.key)).size, 1);
    assert.equal(h.saves.state().status, 'offline');
    await h.saves.retry();
    assert.deepEqual(h.api.sent.slice(4).map(r => r.path), ['/v1/worlds', `/v1/worlds/${WORLD}/revisions`]);
    assert.equal(h.api.sent[4].key, h.api.sent[0].key);
    assert.equal(h.saves.state().status, 'saved');
});

test('PL-FE2 the world client holds each answer to its closed DTO; another shape is unavailable, never a world', async () => {
    assert.deepEqual(parseWorldView(world(0)), world(0));
    for (const broken of [{ ...world(0), ownerId: 'x' }, { ...world(0), worldId: 'uid-1' }, { ...world(0), title: '' },
        { ...world(0), rowVersion: -1 }, { ...world(0), createdAt: '2026-11-03T12:00:00Z' },
        { ...world(0), head: { ...world(0).head, line: 'EA 1' } }, { ...world(0), head: { ...world(0).head, sha256: 'A'.repeat(64) } }]) {
        assert.equal(parseWorldView(broken), null, JSON.stringify(broken).slice(0, 80));
    }
    assert.equal(parseOperation({ operationId: OP, state: 'RUNNING', status: null, result: null }), null);
    const api = fakeApi({ 'POST /v1/worlds': [{ ...world(0), extra: true }], 'GET /v1/me/worlds': [{ worlds: [world(0)], next: null }],
        [`GET /v1/worlds/${WORLD}/revisions/${REV[0]}`]: [new ForgeError('not-found', 404, 'gone')] });
    assert.deepEqual(await createWorld(api, 't', { key: 'key-0000-0000-0001', text: CASTLE, sha256: SHA }), { kind: 'unavailable', status: 201 });
    assert.deepEqual(await listWorlds(api, { limit: 24 }), { worlds: [world(0)], next: null });
    assert.equal(api.sent[1].path, '/v1/me/worlds?limit=24');
    assert.equal(await readRevision(api, WORLD, REV[0]), 'missing');
    assert.equal(await readRevision(api, '../../me', REV[0]), 'missing', 'an id that is not a ULID never reaches a path');
    assert.equal(api.sent.length, 3);
});
