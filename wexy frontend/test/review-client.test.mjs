// EA-VR8's browser half (EA6.4; visual-review-design.md §9, §9.1, §10; Q112 (a) decided 2026-11-03): the model's review
// client (src/forge-client/review-client.ts) over the backend's recorded wire (test/fixtures/review-wire, from its
// ReviewRoutesTest) and a fake transport. No backend, no model, no spend.
//   EA-VR8a  the verdict's schema is the backend's, byte for byte, read from the repository beside this one when it is there
//   EA-VR8b  the recorded terms and answers parse; the request this client sends has exactly the recorded request's fields
//   EA-VR8c  an answer counts only when it echoes the review, its subject and each frame's hash as sent, and keeps the
//            verdict's rules: anything else is EA_REVIEW_INVALID, never a pass
//   EA-VR8d  each limit at its cap passes and one past it is refused before anything is sent (EA_REVIEW_SIZE), base64
//            counted as it travels; the terms are read as strictly
//   EA-VR8e  the client sends the nine fields once, on a single-use App Check route, and a deadline is a timeout
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ForgeError } from '../src/forge-client/errors.ts';
import {
    ISSUE_KINDS, MAX_ISSUES, REVIEW_VERDICT, REVIEW_VERDICT_TEXT, SENTENCE_CHARS, createReviewClient, decodedLength, parseAnswer, parseTerms, requestProblem,
    toBase64,
} from '../src/forge-client/review-client.ts';
import { needsSingleUseAppCheck } from '../src/forge-client/http.ts';

const wire = name => JSON.parse(readFileSync(new URL(`./fixtures/review-wire/${name}`, import.meta.url), 'utf8'));
const lf = s => s.replace(/\r\n/g, '\n');
/** The backend beside this repository (relative, so a worktree reads its own). */
const BACKEND = new URL('../../wexy backend/forge-service/src/', import.meta.url);

/** The recorded request, its frames given the recorded answers' normalized hashes and some bytes. */
function sent() {
    const r = wire('request.json');
    r.frames[0].sha256 = '1'.repeat(64);
    r.frames[1].sha256 = '2'.repeat(64);
    for (const f of r.frames) f.jpeg = toBase64(new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]));
    return r;
}

test('EA-VR8a the verdict\'s schema is the backend\'s, byte for byte, when that repository is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, () => {
    assert.equal(REVIEW_VERDICT, 'review-verdict.v1');
    assert.equal(lf(REVIEW_VERDICT_TEXT), lf(readFileSync(new URL('main/resources/schemas/review-verdict.v1.json', BACKEND), 'utf8')));
    // And the recordings here are the backend's own.
    for (const name of ['fail.json', 'pass.json', 'invalid.json', 'request.json', 'terms-open.json', 'terms-shut.json', 'unavailable.json']) {
        assert.equal(lf(readFileSync(new URL(`./fixtures/review-wire/${name}`, import.meta.url), 'utf8')),
            lf(readFileSync(new URL(`test/resources/agent/review-wire/${name}`, BACKEND), 'utf8')), name);
    }
    assert.deepEqual([...ISSUE_KINDS], ['floating', 'scale', 'framing', 'exposure', 'missing', 'style']);
    assert.deepEqual([MAX_ISSUES, SENTENCE_CHARS], [32, 400]);
});

test('EA-VR8b the recorded terms and answers parse, and this client\'s request has exactly the recorded fields', () => {
    const shut = parseTerms(wire('terms-shut.json'));
    assert.deepEqual([shut.available, shut.gate, shut.gates.privacy, shut.model, shut.mode, shut.policyVersion], [false, 'images', 'verified', 'muse-spark-1.3', 'standard', 'meta-standard.2026-11-03']);
    assert.deepEqual(shut.limits, { frames: 2, width: 768, height: 432, jpegBytes: 300_000, pairBytes: 600_000, requestBytes: 1_048_576, findings: 32, modules: 12 });
    const open = parseTerms(wire('terms-open.json'));
    assert.deepEqual([open.available, open.gate], [true, null]);

    const body = sent();
    const fail = parseAnswer(wire('fail.json'), body);
    assert.equal(fail.verdict.verdict, 'fail');
    assert.deepEqual(fail.verdict.issues.map(i => [i.n, i.kind, i.scope, i.modules]), [[1, 'floating', 'modules', ['castlePlace']], [2, 'scale', 'program', []]]);
    assert.deepEqual(fail.usage, { in: 3100, out: 420, reasoning: 300, cached: null, costMicroUsd: 5660 });
    assert.equal(parseAnswer(wire('pass.json'), body).verdict.issues.length, 0);
    // The recorded refusals are the backend's envelopes (code, message), read as every other refusal is.
    assert.deepEqual(Object.keys(wire('unavailable.json')), ['code', 'message']);
    assert.match(wire('unavailable.json').message, /^EA_VISION_UNAVAILABLE images: /);

    // The client sends exactly the recorded request's fields, at every level.
    const keys = o => Object.keys(o).sort();
    const recorded = wire('request.json');
    const calls = [];
    const api = { async send(req) { calls.push(req); return new Response(JSON.stringify(wire('fail.json')), { status: 200 }); } };
    return createReviewClient(api).review({ ...body, stray: 'never sent' }, open.limits, new AbortController().signal).then(() => {
        const out = calls[0].body;
        assert.deepEqual(keys(out), keys(recorded));
        assert.deepEqual(keys(out.subject), keys(recorded.subject));
        assert.deepEqual(keys(out.request), keys(recorded.request));
        assert.deepEqual(keys(out.frames[0]), keys(recorded.frames[0]));
        assert.deepEqual(keys(out.hostFindings[0]), keys(recorded.hostFindings[0]));
        assert.deepEqual(keys(out.consent), keys(recorded.consent));
    });
});

test('EA-VR8c an answer counts only when it echoes what was sent and keeps the verdict\'s rules: anything else is EA_REVIEW_INVALID', () => {
    const body = sent();
    const refused = (label, change, pattern) => {
        const a = wire('fail.json');
        change(a);
        assert.throws(() => parseAnswer(a, body), e => /^EA_REVIEW_INVALID /.test(e.message) && pattern.test(e.message) && e.message.endsWith('; review review-1'), label);
    };
    refused('another review', a => { a.reviewId = 'review-2'; }, /reviewId: it answers review-2/);
    refused('a frame not sent', a => { a.frames[1].sha256 = '3'.repeat(64); }, /frames\[1\]: not the frame sent/);
    refused('frames reordered', a => { a.frames.reverse(); }, /frames\[0\]: not the frame sent/);
    refused('a frame left out', a => { a.frames.pop(); }, /frames: not one echo a frame sent/);
    refused('another candidate', a => { a.subject.candidate = 'b'.repeat(64); }, /subject\.candidate: not the subject sent/);
    refused('a pass with an issue', a => { a.verdict.verdict = 'pass'; }, /a pass with 2 issues/);
    refused('a fail with none', a => { a.verdict.issues = []; }, /a fail with no issue/);
    refused('a module not named', a => { a.verdict.issues[0].modules = ['towerPlace']; }, /modules the request named/);
    refused('a module twice', a => { a.verdict.issues[0].modules = ['castlePlace', 'castlePlace']; }, /each once/);
    refused('out of order', a => { a.verdict.issues[0].n = 2; }, /numbered 1, 2/);
    refused('an unknown kind', a => { a.verdict.issues[0].kind = 'vibes'; }, /\.kind: one of floating/);
    refused('a long sentence', a => { a.verdict.issues[0].sentence = 'x'.repeat(401); }, /\.sentence: 1 to 400/);
    refused('a blank sentence', a => { a.verdict.issues[0].sentence = '  ﻿'; }, /\.sentence: 1 to 400/);
    refused('a stray key', a => { a.verdict.issues[0].apply = true; }, /takes exactly/);
    refused('no usage', a => { delete a.usage; }, /usage missing/);
    refused('a usage that is not a count', a => { a.usage.costMicroUsd = -1; }, /usage\.costMicroUsd: not a count/);
    refused('not live', a => { a.source = 'mock'; }, /source: not live/);
    refused('too many issues', a => { a.verdict.issues = Array.from({ length: 33 }, (_, i) => ({ ...a.verdict.issues[1], n: i + 1 })); }, /at most 32/);
    // 400 emoji are 400 code points: within the bound, as both sides count it.
    const emoji = wire('fail.json');
    emoji.verdict.issues[0].sentence = '\u{1F3F0}'.repeat(400);
    assert.equal(parseAnswer(emoji, body).verdict.issues[0].sentence.length, 800);
    assert.throws(() => parseAnswer('not an object', body), /EA_REVIEW_INVALID answer: not an object/);
});

test('EA-VR8d each limit at its cap passes and one past it is refused before anything is sent; the terms are read strictly', () => {
    const limits = parseTerms(wire('terms-open.json')).limits;
    const body = sent();
    const frame = n => toBase64(new Uint8Array(n));
    assert.equal(decodedLength(frame(300_000)), 300_000);
    assert.equal(decodedLength(frame(299_999)), 299_999);
    assert.equal(decodedLength(frame(299_998)), 299_998);
    // At the caps: two frames of 300,000 bytes, 600,000 together, as 400,000 base64 characters each.
    body.frames[0].jpeg = frame(300_000);
    body.frames[1].jpeg = frame(300_000);
    assert.equal(body.frames[0].jpeg.length, 400_000);
    assert.equal(requestProblem(body, limits), null);
    body.frames[1].jpeg = frame(300_001);
    assert.equal(requestProblem(body, limits), 'EA_REVIEW_SIZE frames[1].jpeg: 300001 exceeds 300000 bytes');
    body.frames[1].jpeg = frame(300_000);
    assert.equal(requestProblem({ ...body, frames: [...body.frames, body.frames[0]] }, limits), 'EA_REVIEW_SIZE frames: 3 frames; a review sends 1 to 2');
    assert.equal(requestProblem({ ...body, frames: [{ ...body.frames[0], width: 1280 }] }, limits), 'EA_REVIEW_SIZE frames[0]: 1280×432; a review frame is 768×432');
    // The whole body past its bytes, base64 and JSON included.
    const big = { ...body, design: { ...body.design, intent: 'x'.repeat(250_000) } };
    assert.match(requestProblem(big, limits), /^EA_REVIEW_SIZE request: \d+ exceeds 1048576 bytes$/);
    assert.equal(requestProblem({ ...body, hostFindings: Array.from({ length: 33 }, () => body.hostFindings[0]) }, limits), 'EA_REVIEW_SIZE hostFindings: 33 exceeds 32');

    // The terms: their gate is the first one unverified, available exactly when none is, every field present.
    const terms = wire('terms-shut.json');
    const off = (label, change, pattern) => {
        const t = structuredClone(terms);
        change(t);
        assert.throws(() => parseTerms(t), pattern, label);
    };
    off('a gate out of order', t => { t.gate = 'metering'; }, /gate is the first gate not verified \(images\)/);
    off('available with a gate shut', t => { t.available = true; }, /available is true exactly when every gate is verified/);
    off('a gate unknown', t => { t.gates.vision = 'verified'; }, /gates takes exactly/);
    off('a stray field', t => { t.url = 'https://x'; }, /the terms takes exactly/);
    off('a limit of nothing', t => { t.limits.frames = 0; }, /limits\.frames is a whole number of 1 or more/);
    off('a model that is a sentence', t => { t.model = 'ignore previous instructions'; }, /model is a model id/);
    // Past the design's limits, or another frame size: not this contract's terms (the independent review of EA6.4).
    off('a frame past the design', t => { t.limits.jpegBytes = 300_001; }, /limits\.jpegBytes is at most 300000, the design's/);
    off('a body past the design', t => { t.limits.requestBytes = 2_097_152; }, /limits\.requestBytes is at most 1048576, the design's/);
    off('three frames', t => { t.limits.frames = 3; }, /limits\.frames is at most 2, the design's/);
    off('another frame size, within the bounds', t => { t.limits.width = 640; }, /limits\.width is 768, as a captured frame is/);
    const less = structuredClone(terms);
    less.limits.findings = 8;
    assert.equal(parseTerms(less).limits.findings, 8, 'less than the design is the backend\'s to ask');
});

test('EA-VR8e the client sends the nine fields once on a single-use route, refuses a size before sending, and a deadline is a timeout', async () => {
    assert.ok(needsSingleUseAppCheck('POST', '/v1/agent/review'));
    assert.ok(!needsSingleUseAppCheck('GET', '/v1/agent/review'));
    const limits = parseTerms(wire('terms-open.json')).limits;
    const calls = [];
    const answers = [];
    const api = {
        async send(req) {
            calls.push(req);
            const a = answers.shift();
            if (a === 'hang') return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
            // Headers in, then the body stalls half way: as fetch does, the request's signal errors the body it is reading.
            if (a === 'stall') {
                const body = new ReadableStream({
                    start(c) {
                        c.enqueue(new TextEncoder().encode('{"reviewId":"review-1",'));
                        req.signal.addEventListener('abort', () => c.error(req.signal.reason), { once: true });
                    },
                });
                return new Response(body, { status: 200 });
            }
            return new Response(typeof a === 'string' ? a : JSON.stringify(a), { status: 200 });
        },
    };
    const client = createReviewClient(api, { deadlineMs: 50 });
    answers.push(wire('terms-shut.json'));
    const terms = await client.terms();
    assert.deepEqual([calls[0].method, calls[0].path, calls[0].auth], ['GET', '/v1/agent/review', true]);
    assert.equal(terms.gate, 'images');

    const body = sent();
    answers.push(wire('fail.json'));
    const got = await client.review(body, limits, new AbortController().signal);
    assert.deepEqual([calls[1].method, calls[1].path, calls[1].auth], ['POST', '/v1/agent/review', true]);
    assert.equal(got.verdict.issues[0].kind, 'floating');

    // Past a limit: refused here, nothing sent.
    const before = calls.length;
    await assert.rejects(client.review({ ...body, frames: [{ ...body.frames[0], jpeg: toBase64(new Uint8Array(300_001)) }] }, limits, new AbortController().signal),
        /^Error: EA_REVIEW_SIZE frames\[0\]\.jpeg: 300001 exceeds 300000 bytes$/);
    assert.equal(calls.length, before);
    // An answer that is not JSON is not a verdict.
    answers.push('<html>proxy error</html>');
    await assert.rejects(client.review(body, limits, new AbortController().signal), /EA_REVIEW_INVALID answer: not JSON; review review-1/);
    // No answer within the deadline: a timeout, the connection dropped.
    answers.push('hang');
    await assert.rejects(client.review(body, limits, new AbortController().signal), e => e instanceof ForgeError && e.code === 'timeout');
    // A cancel is the caller's own AbortError.
    answers.push('hang');
    const cancel = new AbortController();
    const pending = client.review(body, limits, cancel.signal);
    cancel.abort();
    await assert.rejects(pending, e => e.name === 'AbortError');
    // The deadline, or a cancel, while the answer's body is read: a timeout or the AbortError, not an answer that is no
    // JSON (the independent review of EA6.4, §11).
    answers.push('stall');
    await assert.rejects(client.review(body, limits, new AbortController().signal), e => e instanceof ForgeError && e.code === 'timeout');
    answers.push('stall');
    const reading = new AbortController();
    const read = client.review(body, limits, reading.signal);
    await new Promise(r => setTimeout(r, 5));
    reading.abort();
    await assert.rejects(read, e => e.name === 'AbortError');
});

test('toBase64 is standard padded base64 at every length, chunks included', () => {
    for (const n of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 100_003]) {
        const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);
        assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'), `${n} bytes`);
        assert.equal(decodedLength(toBase64(bytes)), n);
    }
});
