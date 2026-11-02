// PL-FE8 (the creations platform companion §1, §9, §11; the backend's §10, I13): the allowance as the server says it,
// held to its closed shape, and the chip's words. The browser counts nothing, and an answer it cannot read is
// "unavailable", never zero or unlimited.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForgeError } from '../src/forge-client/errors.ts';
import { clockTime } from '../src/loop/copy.ts';
import { chipText, parseAllowance, readAllowance } from '../src/platform/allowance.ts';

test('PL-FE8 the DTO is read exactly: three keys, a known label, a whole count, an ISO reset or null', () => {
    assert.deepEqual(parseAllowance({ label: 'Free', left: 1, resetsAt: null }), { label: 'Free', left: 1, resetsAt: null });
    const early = parseAllowance({ label: 'Early access', left: 0, resetsAt: '2026-11-03T00:00:00Z' });
    assert.equal(early.resetsAt.toISOString(), '2026-11-03T00:00:00.000Z');
    for (const bad of [null, [], 'Free', {}, { label: 'Free', left: 1 }, { label: 'Admin', left: 20, resetsAt: null },
        { label: 'Free', left: -1, resetsAt: null }, { label: 'Free', left: 1.5, resetsAt: null }, { label: 'Free', left: '1', resetsAt: null },
        { label: 'Free', left: 1, resetsAt: 'tomorrow' }, { label: 'Free', left: 1, resetsAt: 7 },
        { label: 'Free', left: 1, resetsAt: null, role: 'admin' }, { label: 'Early access', left: Infinity, resetsAt: null }]) {
        assert.equal(parseAllowance(bad), null, JSON.stringify(bad));
    }
});

test('PL-FE8 the chip says what the server said: one free world, then early access with its count or its reset', () => {
    const now = new Date(2026, 10, 2, 21, 0);
    assert.equal(chipText({ label: 'Free', left: 1, resetsAt: null }, now), '1 free world');
    assert.equal(chipText({ label: 'Free', left: 0, resetsAt: null }, now), 'Free world made');
    assert.equal(chipText({ label: 'Early access', left: 1, resetsAt: null }, now), 'Early access: 1 world today');
    assert.equal(chipText({ label: 'Early access', left: 19, resetsAt: null }, now), 'Early access: 19 worlds today');
    const reset = new Date(2026, 10, 3, 5, 30);
    assert.equal(chipText({ label: 'Early access', left: 0, resetsAt: reset }, now), `Early access: next world at ${clockTime(reset, now)}`);
    assert.equal(chipText({ label: 'Early access', left: 0, resetsAt: null }, now), 'Early access: today\'s world made');
    // Unknown is unavailable: never "0 worlds", never unlimited.
    assert.equal(chipText(null, now), 'Allowance unavailable');
});

test('PL-FE8 the read is the caller\'s own GET with its token; a refusal, a broken body or no answer is unavailable; a cancel is a cancel', async () => {
    const sent = [];
    const api = answer => ({ async send(req) { sent.push(req); if (answer instanceof Error) throw answer; return answer; } });
    const ok = new Response(JSON.stringify({ label: 'Early access', left: 1, resetsAt: '2026-11-03T00:00:00Z' }), { status: 200 });
    assert.equal((await readAllowance(api(ok))).left, 1);
    assert.deepEqual(sent[0], { method: 'GET', path: '/v1/forge/allowance', auth: true, signal: undefined });

    assert.equal(await readAllowance(api(new ForgeError('unavailable', 503, 'Redis is down'))), null);
    assert.equal(await readAllowance(api(new Response('<html>', { status: 200 }))), null);
    assert.equal(await readAllowance(api(new Response(JSON.stringify({ label: 'Free', left: 1, resetsAt: null, usage: 3 }), { status: 200 }))), null);
    const cancel = new DOMException('cancelled', 'AbortError');
    await assert.rejects(readAllowance(api(cancel)), e => e === cancel);
});
