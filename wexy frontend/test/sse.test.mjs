// U-series, headless: the forge's stream format and contract (src/forge-client/sse.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEventStream, readForgeStream } from '../src/forge-client/sse.ts';
import { ForgeError } from '../src/forge-client/errors.ts';

const enc = new TextEncoder();

/** A body delivered in the given chunks (strings or bytes), as a network splits it; `cancelled` says if it was. */
function body(chunks, { keepOpen = false } = {}) {
    const state = { cancelled: false };
    const stream = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
            if (!keepOpen) controller.close();
        },
        cancel() { state.cancelled = true; },
    });
    return Object.assign(stream, { state });
}

const sse = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const META = { generationId: 'g1', model: 'muse-spark-1.3', source: 'live' };
const stream = (...events) => new Response(body([events.join('')]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

async function collect(b) {
    const out = [];
    for await (const e of parseEventStream(b)) out.push(e);
    return out;
}

test('U24 events split anywhere by the network come out whole: mid-line, mid-character, CRLF split in two', async () => {
    const text = 'event: delta\r\ndata: {"text":"fn evolve(p: Particle) — «ok»"}\r\n\r\n: hb\r\n\r\nevent: done\r\ndata: {"status":"ok"}\r\n\r\n';
    const bytes = enc.encode(text);
    // One byte at a time: every possible split, including inside the em dash's three bytes and between \r and \n.
    const events = await collect(body([...bytes].map(b => new Uint8Array([b]))));
    assert.deepEqual(events, [
        { event: 'delta', data: '{"text":"fn evolve(p: Particle) — «ok»"}' },
        { event: 'done', data: '{"status":"ok"}' },
    ]);
});

test('U25 LF, CRLF and lone CR all end lines; comments, id and retry are skipped; data lines join with LF', async () => {
    const events = await collect(body(['﻿: hello\rid: 7\nretry: 100\r\nevent: x\ndata: one\rdata:two\r\ndata:  three\n\ndata: plain\n\n']));
    assert.deepEqual(events, [{ event: 'x', data: 'one\ntwo\n three' }, { event: 'message', data: 'plain' }]);
});

test('U26 an event the stream ends in the middle of is dropped; a CR at the very end still ends its line', async () => {
    assert.deepEqual(await collect(body(['event: done\ndata: {"status":"ok"}\n'])), []);
    assert.deepEqual(await collect(body(['data: a\r', '\r'])), [{ event: 'message', data: 'a' }]);
});

test('U27 a whole stream: meta, deltas, usage, done; heartbeats ignored; the extra Q26 fields kept', async () => {
    const deltas = [];
    const res = stream(
        sse('meta', { ...META, role: 'author', fn: 'evolve', promptVersion: 'author.evolve v1' }),
        ': hb\n\n', sse('delta', { text: 'fn evolve(' }), ': hb\n\n', sse('delta', { text: 'p: Particle) {}' }),
        sse('usage', { in: 2500, out: 400, reasoning: 120, cached: 2048 }), sse('done', { status: 'ok' }),
    );
    const result = await readForgeStream(res, { onDelta: (piece, soFar) => deltas.push([piece, soFar]) });
    assert.equal(result.text, 'fn evolve(p: Particle) {}');
    assert.deepEqual(result.meta, { ...META, role: 'author', fn: 'evolve', promptVersion: 'author.evolve v1' });
    assert.deepEqual(result.usage, { in: 2500, out: 400, reasoning: 120, cached: 2048 });
    assert.deepEqual(deltas, [['fn evolve(', 'fn evolve('], ['p: Particle) {}', 'fn evolve(p: Particle) {}']]);
});

test('U28 the minimal contract is enough: no usage, no extra fields, an unknown event skipped', async () => {
    const result = await readForgeStream(stream(sse('meta', META), sse('progress', { pct: 50 }), sse('delta', { text: 'x' }), sse('done', { status: 'ok' })));
    assert.deepEqual(result, { meta: META, text: 'x', usage: null });
});

test('U29 a stream that ends without done or error is a failure, never a success', async () => {
    await assert.rejects(readForgeStream(stream(sse('meta', META), sse('delta', { text: 'half a func' }))),
        e => e instanceof ForgeError && e.code === 'unavailable');
});

test('U30 an error event is the backend\'s code; an unknown code is internal', async () => {
    await assert.rejects(readForgeStream(stream(sse('meta', META), sse('delta', { text: 'x' }), sse('error', { code: 'timeout', message: 'Over the role\'s timeout.' }))),
        e => e instanceof ForgeError && e.code === 'timeout' && e.message === 'Over the role\'s timeout.');
    await assert.rejects(readForgeStream(stream(sse('meta', META), sse('error', { code: 'meltdown', message: 'm' }))),
        e => e instanceof ForgeError && e.code === 'internal');
    // An error before meta (the response committed, then the charge failed) is still the backend's error.
    await assert.rejects(readForgeStream(stream(sse('error', { code: 'budget', message: 'cap' }))), e => e.code === 'budget');
});

test('U31 a broken contract is internal: meta not first, bad JSON, a field of the wrong type, an unknown source', async () => {
    const cases = [
        stream(sse('delta', { text: 'x' }), sse('done', { status: 'ok' })),
        stream(sse('meta', '{not json'), sse('done', { status: 'ok' })),
        stream(sse('meta', { ...META, generationId: 42 }), sse('done', { status: 'ok' })),
        stream(sse('meta', { ...META, source: 'mock' }), sse('done', { status: 'ok' })),
        stream(sse('meta', META), sse('delta', { text: null }), sse('done', { status: 'ok' })),
        stream(sse('meta', META), sse('usage', { in: 'many', out: 1 }), sse('done', { status: 'ok' })),
    ];
    for (const [i, res] of cases.entries()) {
        await assert.rejects(readForgeStream(res), e => e instanceof ForgeError && e.code === 'internal', `case ${i}`);
    }
});

test('U32 the client stops reading past its cap, and cancels the body when it stops', async () => {
    const b = body([sse('meta', META), sse('delta', { text: 'x'.repeat(40) }), sse('delta', { text: 'y'.repeat(40) }), sse('done', { status: 'ok' })]);
    await assert.rejects(readForgeStream(new Response(b), {}, 64), e => e instanceof ForgeError && e.code === 'upstream');
    // The terminal event ends the read even while the server holds the connection open, and the body is cancelled
    // so the connection closes; nothing after the terminal event is read.
    const open = body([sse('meta', META), sse('done', { status: 'ok' }), sse('delta', { text: 'after the end' })], { keepOpen: true });
    const result = await readForgeStream(new Response(open));
    assert.equal(result.text, '');
    assert.equal(open.state.cancelled, true);
});

test('U39 only a valid done payload succeeds, and meta cannot repeat', async () => {
    for (const event of [sse('done', 'not JSON'), sse('done', {}), sse('done', { status: 'error' }), sse('meta', META)]) {
        await assert.rejects(readForgeStream(stream(sse('meta', META), event, sse('done', { status: 'ok' }))),
            e => e instanceof ForgeError && e.code === 'internal');
    }
});

test('U40 unfinished SSE lines and accumulated data have a bound, and close the body', { timeout: 2000 }, async () => {
    for (const chunks of [['data: ' + 'x'.repeat(129)], Array(30).fill('data: 1234\n')]) {
        const b = body(chunks, { keepOpen: true });
        await assert.rejects(async () => {
            for await (const _ of parseEventStream(b, 128)) { /* consume */ }
        }, e => e instanceof ForgeError && e.code === 'upstream');
        assert.equal(b.state.cancelled, true);
        assert.equal(b.locked, false);
    }
});
