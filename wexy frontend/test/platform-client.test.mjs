// PL-FE3's W2 part (the creations platform companion §6.3, §10): the platform's account calls (src/platform/client.ts)
// against a fake gateway: the self DTO held to its closed shape, the bootstrap after a sign-in, the read and its 404, and
// a handle's claim, whose 409 is told apart by reading the account again, never by the server's words.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForgeError } from '../src/forge-client/errors.ts';
import { bootstrapAccount, claimHandle, parseAccount, readAccount, typedHandle } from '../src/platform/client.ts';

const ID = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';

function accountDto({ handle = null, rowVersion = 0, status = 'ACTIVE', displayName = null } = {}) {
    return { accountId: ID, status, policyVersion: 1, profile: { handle, displayName, bio: null, publicEnabled: false, rowVersion } };
}

/** A gateway that answers from `routes` ("METHOD path" → body, or an Error to throw) and records each request. */
function fakeApi(routes) {
    const sent = [];
    return {
        sent,
        async send(req) {
            sent.push({ method: req.method, path: req.path, body: req.body, auth: req.auth });
            const answer = routes[`${req.method} ${req.path}`];
            const next = Array.isArray(answer) ? answer.shift() : answer;
            if (next instanceof Error) throw next;
            if (next === undefined) throw new ForgeError('not-found', 404, 'No such route.');
            return new Response(JSON.stringify(next), { status: 200 });
        },
    };
}

test('PL-FE3 the self DTO is held to its closed shape: anything else is no account', () => {
    assert.deepEqual(parseAccount(accountDto({ handle: 'nova', rowVersion: 3 })), accountDto({ handle: 'nova', rowVersion: 3 }));
    const broken = [
        null, [], 'x', {},
        { ...accountDto(), extra: 1 },
        { ...accountDto(), accountId: 'uid-1' },
        { ...accountDto(), accountId: ID.toLowerCase() },
        { ...accountDto(), status: 'ADMIN' },
        { ...accountDto(), policyVersion: 0 },
        { ...accountDto(), profile: { ...accountDto().profile, handle: 'Nova' } },
        { ...accountDto(), profile: { ...accountDto().profile, handle: 'no' } },
        { ...accountDto(), profile: { ...accountDto().profile, rowVersion: -1 } },
        { ...accountDto(), profile: { ...accountDto().profile, rowVersion: 1.5 } },
        { ...accountDto(), profile: { ...accountDto().profile, publicEnabled: 'false' } },
        { ...accountDto(), profile: { ...accountDto().profile, displayName: 'x'.repeat(51) } },
        { ...accountDto(), profile: { ...accountDto().profile, owner: 'uid-2' } },
        { accountId: ID, status: 'ACTIVE', policyVersion: 1 },
    ];
    for (const body of broken) assert.equal(parseAccount(body), null, JSON.stringify(body));
    // Fifty emoji are fifty characters, as the server counts code points.
    assert.ok(parseAccount(accountDto({ displayName: '\u{1F30C}'.repeat(50) })));
});

test('PL-FE3 a typed handle is lowercased, an @ before it allowed; anything outside the rule is refused here, never mapped', () => {
    assert.equal(typedHandle('Nova_7'), 'nova_7');
    assert.equal(typedHandle(' @Nova '), 'nova');
    for (const raw of ['ab', 'a'.repeat(31), 'no va', 'növa', 'ｎｏｖａ', 'nova!', '@@nova', '']) assert.equal(typedHandle(raw), null, raw);
});

test('PL-FE3 the bootstrap is one POST /v1/me with an empty body; the read is GET /v1/me, and its 404 is "none"', async () => {
    const api = fakeApi({ 'POST /v1/me': accountDto(), 'GET /v1/me': new ForgeError('not-found', 404, 'not set up') });
    assert.deepEqual(await bootstrapAccount(api), { kind: 'account', account: accountDto() });
    assert.deepEqual(api.sent, [{ method: 'POST', path: '/v1/me', body: {}, auth: true }]);
    assert.deepEqual(await readAccount(api), { kind: 'none' });
    assert.equal(api.sent[1].method, 'GET');
});

test('PL-FE3 an answer that is not the DTO, or a failure, is unavailable, never an account; a cancel stays a cancel', async () => {
    assert.deepEqual(await readAccount(fakeApi({ 'GET /v1/me': { accountId: 'x' } })), { kind: 'unavailable' });
    assert.deepEqual(await readAccount(fakeApi({ 'GET /v1/me': new ForgeError('unavailable', 503, 'db') })), { kind: 'unavailable' });
    assert.deepEqual(await bootstrapAccount(fakeApi({ 'POST /v1/me': new ForgeError('account-required', 403, 'anon') })), { kind: 'unavailable' });
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    await assert.rejects(readAccount(fakeApi({ 'GET /v1/me': abort })), e => e.name === 'AbortError');
});

test('PL-FE3 a claim names its account and the version it read; a 409 is a taken handle when the profile has not moved, a stale read when it has', async () => {
    const read = accountDto();
    const claimed = fakeApi({ 'PATCH /v1/me/profile': accountDto({ handle: 'nova', rowVersion: 1 }) });
    assert.deepEqual(await claimHandle(claimed, read, 'nova'), { kind: 'claimed', account: accountDto({ handle: 'nova', rowVersion: 1 }) });
    assert.deepEqual(claimed.sent[0], { method: 'PATCH', path: '/v1/me/profile', body: { accountId: ID, expectedVersion: 0, handle: 'nova' }, auth: true });

    const conflict = () => new ForgeError('conflict', 409, 'words the studio never reads');
    const taken = fakeApi({ 'PATCH /v1/me/profile': conflict(), 'GET /v1/me': accountDto({ rowVersion: 0 }) });
    assert.deepEqual(await claimHandle(taken, read, 'nova'), { kind: 'taken' });
    const stale = fakeApi({ 'PATCH /v1/me/profile': conflict(), 'GET /v1/me': accountDto({ handle: 'other', rowVersion: 1 }) });
    assert.deepEqual(await claimHandle(stale, read, 'nova'), { kind: 'stale', account: accountDto({ handle: 'other', rowVersion: 1 }) });
    // The W2 review: another account signed in meanwhile; the server refused the claim made for this one.
    const other = { ...accountDto(), accountId: '01JC3W5F6Q7R8S9T0V1W2X3Y5B' };
    const switched = fakeApi({ 'PATCH /v1/me/profile': conflict(), 'GET /v1/me': other });
    assert.deepEqual(await claimHandle(switched, read, 'nova'), { kind: 'stale', account: other });

    assert.deepEqual(await claimHandle(fakeApi({ 'PATCH /v1/me/profile': new ForgeError('bad-request', 400, 'reserved') }), read, 'admin2'), { kind: 'refused' });
    assert.deepEqual(await claimHandle(fakeApi({ 'PATCH /v1/me/profile': new ForgeError('forbidden', 403, 'suspended') }), read, 'nova'), { kind: 'forbidden' });
    assert.deepEqual(await claimHandle(fakeApi({ 'PATCH /v1/me/profile': new ForgeError('unavailable', 0, 'network') }), read, 'nova'), { kind: 'unavailable' });
    // A 409 whose re-read fails says nothing it cannot know; a deadline (the W2 review) is unavailable too, not a cancel.
    assert.deepEqual(await claimHandle(fakeApi({ 'PATCH /v1/me/profile': conflict(), 'GET /v1/me': new ForgeError('unavailable', 503, 'x') }), read, 'nova'),
        { kind: 'unavailable' });
    const deadline = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    assert.deepEqual(await claimHandle(fakeApi({ 'PATCH /v1/me/profile': deadline }), read, 'nova'), { kind: 'unavailable' });
    assert.deepEqual(await readAccount(fakeApi({ 'GET /v1/me': deadline })), { kind: 'unavailable' });
});
