// L-series, headless: the loop's state machine (src/loop/machine.ts) over a fake client and a fake verifier: P1 for
// every model-side failure (the world stays what it was, a plain sentence comes back), the repair policy, the
// retry, the parallel author calls, the cancel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H1 } from '../src/contract/h1/index.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { clockTime, COPY } from '../src/loop/copy.ts';
import { runLoop } from '../src/loop/machine.ts';
import { autofix } from '../src/contract/autofix.ts';
import { withProgramText } from '../src/contract/spec.ts';
import { compactLadder } from '../src/loop/outcome.ts';

const REQ = { prompt: 'a spiral galaxy', style: 'auto', seconds: 12 };
const gen = (id, extra = {}) => ({ generationId: id, source: 'live', model: 'muse-spark-1.3', role: 'author', fn: null, promptVersion: 'v1', usage: { in: 100, out: 50 }, ms: 5, ttftMs: 2, ...extra });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** A client whose answers are scripted per call: a value, an Error to throw, or a function of the arguments. */
function fakeClient(script = {}) {
    const calls = [];
    let n = 0;
    const next = (name, args) => {
        const queue = script[name] ?? [];
        const answer = queue.length ? queue.shift() : undefined;
        return typeof answer === 'function' ? answer(...args) : answer;
    };
    const plan = { draft: JSON.parse(H1.plans.galaxy), text: H1.plans.galaxy, generation: gen('plan-1', { role: 'planner' }), clamped: [] };
    plan.draft.camera.move = plan.draft.camera.move ?? null;
    const client = {
        source: 'live',
        calls,
        async plan(req, progress, signal) {
            calls.push(['plan', req]);
            const a = next('plan', [req, progress, signal]);
            if (a instanceof Error) throw a;
            progress.onText?.('{"title":');
            return a ?? plan;
        },
        async author(fn, planId, progress, signal) {
            calls.push(['author', fn, planId]);
            const a = next(`author.${fn}`, [fn, planId, progress, signal]);
            if (a instanceof Error) throw a;
            if (a === 'slow') await sleep(1000, signal);
            progress.onText?.('fn ' + fn);
            return a && a !== 'slow' ? a : { fn, text: H1.exemplars.galaxy[fn], generation: gen(`author-${fn}-${++n}`, { fn }) };
        },
        async repair(fn, generationId, diagnostics, progress, signal) {
            calls.push(['repair', fn, generationId, diagnostics]);
            const a = next('repair', [fn, generationId, diagnostics, progress, signal]);
            if (a instanceof Error) throw a;
            return a ?? { fn, text: H1.exemplars.galaxy[fn] + '\n// repaired', generation: gen(`repair-${fn}-${++n}`, { fn, role: 'repairer' }) };
        },
        async direct() { throw new Error('not in this test'); },
        async report(outcome) { calls.push(['report', outcome]); },
    };
    return client;
}

const ok = (world = 'W') => ({ ok: true, world, report: { rungs: [{ rung: 'L1', ok: true, ms: 1 }], autofixes: {}, probe: null, totalMs: 1 } });
const failure = (reason, target, rung = 'L3') => ({
    ok: false,
    report: { rungs: [{ rung, ok: false, ms: 1 }], autofixes: {}, probe: null, totalMs: 1 },
    failure: { rung, reason, target, diagnostics: target ? [{ target, severity: 'error', source: ({ compile: 'tint', lint: 'contract' })[reason] ?? reason, line: 11, column: 25, message: 'type mismatch', snippet: 'let jitter = hash11(i);' }] : [], message: `${reason} failed` },
});
/** A verifier answering from a queue; the last answer repeats. A pass hands back the spec it was given, as the ladder does when nothing needed an auto-fix. */
const fakeVerifier = (...answers) => ({ verified: [], async verify(spec) {
    this.verified.push(spec);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return answer.ok && !answer.spec ? { ...answer, spec } : answer;
} });

const run = (client, verifier, options = {}) => {
    const events = [];
    const ac = new AbortController();
    return { events, promise: runLoop({ client, verifier, ...options }, REQ, e => events.push(e), options.signal ?? ac.signal) };
};

test('L1 the happy path: a plan, three functions at once, one verify, a world with its outcome', async () => {
    const client = fakeClient();
    const verifier = fakeVerifier(ok());
    const { events, promise } = run(client, verifier);
    const out = await promise;
    assert.equal(out.ok, true);
    assert.equal(out.world, 'W');
    assert.deepEqual(client.calls.map(c => c[0]), ['plan', 'author', 'author', 'author']);
    assert.deepEqual(client.calls.slice(1).map(c => c[1]), ['evolve', 'look', 'sky']);
    assert.ok(client.calls.slice(1).every(c => c[2] === 'plan-1'));
    assert.equal(out.spec.program.kind, 'functions');
    assert.equal(out.spec.program.evolve, H1.exemplars.galaxy.evolve);
    assert.equal(out.spec.title, 'Spiral Galaxy');
    assert.deepEqual(Object.keys(out.spec.uniforms), ['spin', 'armTwist', 'thickness', 'coreGlow']);
    assert.deepEqual(out.outcome.generationIds, ['plan-1', 'author-evolve-1', 'author-look-2', 'author-sky-3']);
    assert.equal(out.outcome.firstPassOk, true);
    assert.equal(out.stats.repairs, 0);
    assert.deepEqual(events.map(e => e.type), ['planning', 'plan-text', 'planned', 'authoring', 'function-text', 'function-text', 'function-text', 'authored', 'authored', 'authored', 'verifying', 'verified']);
    assert.equal(verifier.verified.length, 1);
});

test('L2 a compile failure is repaired with capped diagnostics, against the generation that wrote the function, then passes', async () => {
    const client = fakeClient();
    const verifier = fakeVerifier(failure('compile', 'evolve'), ok());
    const { events, promise } = run(client, verifier);
    const out = await promise;
    assert.equal(out.ok, true);
    const repair = client.calls.find(c => c[0] === 'repair');
    assert.equal(repair[1], 'evolve');
    assert.equal(repair[2], 'author-evolve-1');
    assert.deepEqual(repair[3], [{ source: 'tint', line: 11, column: 25, message: 'type mismatch', snippet: 'let jitter = hash11(i);' }]);
    assert.equal(out.spec.program.evolve, H1.exemplars.galaxy.evolve + '\n// repaired');
    assert.equal(out.outcome.firstPassOk, false);
    assert.equal(out.outcome.repairs, 1);
    assert.deepEqual(out.outcome.generationIds.slice(-1), ['repair-evolve-4']);
    assert.ok(events.some(e => e.type === 'repairing' && e.fn === 'evolve' && e.attempt === 1));
    assert.ok(events.some(e => e.type === 'repaired'));
    // A second repair of the same function goes to the generation that repaired it, not the author.
    const client2 = fakeClient();
    const { promise: p2 } = run(client2, fakeVerifier(failure('compile', 'evolve'), failure('sanity', 'evolve', 'L7'), ok()));
    assert.equal((await p2).ok, true);
    const repairs = client2.calls.filter(c => c[0] === 'repair');
    assert.equal(repairs[1][2], 'repair-evolve-4');
    assert.equal(repairs[1][3][0].source, 'sanity');
});

test('L3 the repairs run out after three, a build failure is not repairable, the probe says too heavy (P1)', async () => {
    const four = await run(fakeClient(), fakeVerifier(failure('compile', 'look'))).promise;
    assert.equal(four.ok, false);
    assert.equal(four.kind, 'verify');
    assert.equal(four.sentence, COPY.failures.verify);
    assert.equal(four.failure.reason, 'compile');
    const smoke = fakeClient();
    const s = await run(smoke, fakeVerifier(failure('smoke', null, 'L6'))).promise;
    assert.equal(s.kind, 'verify');
    assert.ok(!smoke.calls.some(c => c[0] === 'repair'));
    const heavy = fakeClient();
    const hv = await run(heavy, fakeVerifier(failure('probe', 'evolve', 'L5'))).promise;
    assert.equal(hv.kind, 'too-heavy');
    assert.equal(hv.sentence, COPY.failures['too-heavy']);
    assert.equal(heavy.calls.filter(c => c[0] === 'repair').length, 3);
});

test('L4 model-side failures end in a plain sentence, and nothing is authored after a refused plan (P1)', async () => {
    const cases = [
        [new ForgeError('budget', 503, 'cap'), 'budget', COPY.failures.budget],
        [new ForgeError('paused', 503, 'no key'), 'paused', COPY.failures.paused],
        [new ForgeError('unavailable', 0, 'offline'), 'offline', COPY.failures.offline],
        [new ForgeError('unavailable', 503, 'meter'), 'paused', COPY.failures.paused],
        [new ForgeError('rate', 429, 'slow down', 130), 'rate', COPY.rateWithMinutes(3)],
        [new ForgeError('rate', 429, 'slow down'), 'rate', COPY.failures.rate],
        [new ForgeError('auth', 401, 'no'), 'sign-in', COPY.failures['sign-in']],
        // W1 (PL-FE8, PL-FE9): the anonymous allowance spent offers sign-in, never a reload; early access's world of the
        // day made says when the next opens only when the server said so; a refused idea says so; none counts anything.
        [new ForgeError('account-required', 403, 'spent'), 'allowance', COPY.failures.allowance],
        [new ForgeError('quota', 429, 'made'), 'quota', COPY.failures.quota],
        [new ForgeError('content-refused', 422, 'unsafe'), 'refused', COPY.failures.refused],
        [new ForgeError('timeout', 504, 'late'), 'plan', COPY.failures.plan],
        [new ForgeError('too-large', 413, 'bug'), 'internal', COPY.failures.internal],
        [new Error('boom'), 'internal', COPY.failures.internal],
    ];
    for (const [error, kind, sentence] of cases) {
        const client = fakeClient({ plan: [error, error] });
        const out = await run(client, fakeVerifier(ok())).promise;
        assert.equal(out.ok, false, error.message);
        assert.equal(out.kind, kind, error.message);
        assert.equal(out.sentence, sentence, error.message);
        assert.ok(!client.calls.some(c => c[0] === 'author'), error.message);
    }
});

test('PL-FE8 early access\'s reset is the server\'s Retry-After, said as a time on this device\'s clock; a day ahead names its weekday', async () => {
    const client = fakeClient({ plan: [new ForgeError('quota', 429, 'made', 3 * 3600), new ForgeError('quota', 429, 'made', 3 * 3600)] });
    const before = Date.now();
    const out = await run(client, fakeVerifier(ok())).promise;
    assert.equal(out.kind, 'quota');
    const at = [before, Date.now()].map(t => COPY.quotaUntil(new Date(t + 3 * 3600 * 1000)));
    assert.ok(at.includes(out.sentence), out.sentence);
    assert.match(out.sentence, /^You've made today's world\. Early access gives one a day; the next opens at .+\. You can still open, film and export your worlds\.$/);
    const now = new Date(2026, 10, 2, 22, 0);
    assert.equal(clockTime(new Date(2026, 10, 2, 23, 30), now), new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 10, 2, 23, 30)));
    const tomorrow = clockTime(new Date(2026, 10, 3, 5, 30), now);
    assert.ok(tomorrow.startsWith(new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 10, 3))), tomorrow);
});

test('L5 upstream is retried once: a plan that fails twice is "didn\'t come through"; an author that ran out of room says so; one with no usable answer twice says the AI couldn\'t write it', async () => {
    const once = fakeClient({ plan: [new ForgeError('upstream', 502, 'bad plan')] });
    const { events, promise } = run(once, fakeVerifier(ok()));
    assert.equal((await promise).ok, true);
    assert.equal(once.calls.filter(c => c[0] === 'plan').length, 2);
    assert.ok(events.some(e => e.type === 'retrying' && e.what === 'plan'));
    const twice = fakeClient({ plan: [new ForgeError('upstream', 502, 'bad'), new ForgeError('upstream', 502, 'bad again')] });
    const out = await run(twice, fakeVerifier(ok())).promise;
    assert.equal(out.kind, 'plan');
    assert.equal(twice.calls.filter(c => c[0] === 'plan').length, 2);
    const room = fakeClient({ 'author.look': [new ForgeError('upstream', 502, 'The model ran out of room. Try a simpler idea.'), new ForgeError('upstream', 502, 'The model ran out of room. Try a simpler idea.')] });
    const r = await run(room, fakeVerifier(ok())).promise;
    assert.equal(r.kind, 'ran-out');
    assert.equal(r.sentence, COPY.failures['ran-out']);
    // The live run of 2026-10-28: the backend judged the author's answer empty, twice. Not "too long".
    const empty = fakeClient({ 'author.sky': [new ForgeError('upstream', 502, 'The model answered nothing.'), new ForgeError('upstream', 502, 'The model answered nothing.')] });
    const e = await run(empty, fakeVerifier(ok())).promise;
    assert.equal(e.kind, 'author-failed', 'an author with no usable answer twice is not "too long"');
    assert.equal(e.sentence, COPY.failures['author-failed']);
});

test('L6 one slow function fails the author step and stops its siblings; "still writing" is said after the slow interval', async () => {
    const client = fakeClient({ 'author.sky': [new ForgeError('timeout', 504, 'late')], 'author.evolve': ['slow'] });
    const t0 = performance.now();
    const { events, promise } = run(client, fakeVerifier(ok()), { slowAfterMs: 20 });
    const out = await promise;
    assert.equal(out.kind, 'author-slow');
    assert.equal(out.sentence, COPY.failures['author-slow']);
    assert.ok(performance.now() - t0 < 900, 'the slow evolve was abandoned with its sibling\'s failure');
    const slowClient = fakeClient({ 'author.look': [async (fn, planId, progress, signal) => { await sleep(60, signal); return { fn, text: H1.exemplars.galaxy.look, generation: gen('look-late', { fn }) }; }] });
    const { events: slowEvents, promise: p2 } = run(slowClient, fakeVerifier(ok()), { slowAfterMs: 20 });
    assert.equal((await p2).ok, true);
    assert.ok(slowEvents.some(e => e.type === 'slow' && e.what === 'look'));
    assert.ok(!events.some(e => e.type === 'slow' && e.what === 'sky'));
});

test('L7 a cancel ends the loop with no sentence and no world, wherever it lands', async () => {
    const ac = new AbortController();
    const client = fakeClient({ plan: [async (req, progress, signal) => { ac.abort(); await sleep(50, signal); }] });
    const out = await run(client, fakeVerifier(ok()), { signal: ac.signal }).promise;
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'cancelled');
    assert.equal(out.sentence, '');
    const before = new AbortController();
    before.abort();
    const early = await run(fakeClient(), fakeVerifier(ok()), { signal: before.signal }).promise;
    assert.equal(early.kind, 'cancelled');
});

test('L8 a source that hands the world over with the plan skips the author step; the backend forgetting the plan re-plans once', async () => {
    const ready = { version: '2.0', host: 'h1', title: 'Kerr', summary: 's', style: 'cosmic', particles: { count: 65536, dt: 1 / 60, warmupSeconds: 0, seed: 1, spawn: {} }, sky: 'function', uniforms: {}, camera: { keyframes: [] }, post: {}, program: { kind: 'hooks', evolve: 'a', particles: 'b' } };
    const client = fakeClient({ plan: [async () => ({ draft: JSON.parse(H1.plans.storm), text: '', generation: gen('p', { role: 'planner', source: 'mock' }), clamped: [], ready })] });
    const { events, promise } = run(client, fakeVerifier(ok()));
    const out = await promise;
    assert.equal(out.ok, true);
    assert.equal(out.spec, ready);
    assert.ok(!client.calls.some(c => c[0] === 'author'));
    assert.ok(events.some(e => e.type === 'planned' && e.ready === true));
    assert.ok(!events.some(e => e.type === 'authoring'));
    const forgot = fakeClient({ 'author.evolve': [new ForgeError('not-found', 404, 'This world isn\'t available.'), new ForgeError('not-found', 404, 'gone')] });
    const o = await run(forgot, fakeVerifier(ok())).promise;
    assert.equal(o.kind, 'plan');
});

test('T2 F2: the spec the loop hands back is the one the ladder compiled, auto-fixes included', async () => {
    // GLSL slips the auto-fix rewrites on their lines (rung L2): the ladder compiles the fixed text, and the world
    // that runs, shows its code and films must be built from that text, not from the one the model wrote.
    const written = H1.exemplars.galaxy.evolve.replace('let r = p.b.x;', 'let r = float(p.b.x);').replace('vec3f(r * cos', 'vec3<float>(r * cos');
    const client = fakeClient({ 'author.evolve': [{ fn: 'evolve', text: written, generation: gen('author-evolve-glsl', { fn: 'evolve' }) }] });
    const verifier = { verified: [], async verify(spec) {
        this.verified.push(spec);
        return { ...ok(), spec: withProgramText(spec, 'evolve', autofix(spec.program.evolve).body) };
    } };
    const out = await run(client, verifier).promise;
    assert.equal(out.ok, true);
    assert.equal(verifier.verified[0].program.evolve, written, 'the ladder is given the text as the model wrote it');
    assert.equal(autofix(written).fixes.length, 2);
    assert.equal(out.spec.program.evolve, autofix(written).body, 'the loop hands back the text the ladder compiled');
    assert.equal(out.spec.program.look, H1.exemplars.galaxy.look);
});

test('T5 F5: authors that finished are kept when a sibling fails, and no author is heard of after the outcome', async () => {
    const empty = () => new ForgeError('upstream', 502, 'The model answered nothing.');
    const late = async (fn, planId, progress, signal) => { await sleep(30, signal); throw empty(); };
    const client = fakeClient({ 'author.sky': [late, late] });
    const { events, promise } = run(client, fakeVerifier(ok()));
    const out = await promise;
    const after = events.length;
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'author-failed');
    assert.deepEqual(out.generations.map(g => g.generationId), ['plan-1', 'author-evolve-1', 'author-look-2'], 'both finished authors, in plan order');
    assert.deepEqual(events.filter(e => e.type === 'authored').map(e => e.fn), ['evolve', 'look'], 'each heard as it finished');
    // A sibling still writing when one fails is stopped, and the loop waits for it to stop: nothing arrives later.
    const slow = fakeClient({ 'author.evolve': ['slow'], 'author.sky': [late, late] });
    const s = run(slow, fakeVerifier(ok()));
    const o = await s.promise;
    const heard = s.events.length;
    await sleep(1100);
    assert.equal(s.events.length, heard, 'no event after the outcome');
    assert.deepEqual(o.generations.map(g => g.generationId), ['plan-1', 'author-look-1'], 'the stopped evolve never answered');
    assert.equal(events.length, after);
});

test('T6 F6: a loop that fails after the ladder ran carries its outcome for the backend; one that fails before, or is cancelled, has none', async () => {
    // The repairs run out: the report names every generation, the last ladder and the repairs, with no fps.
    const client = fakeClient();
    const last = failure('compile', 'evolve');
    const out = await run(client, fakeVerifier(last)).promise;
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'verify');
    assert.ok(out.outcome, 'a failed world is reported');
    assert.deepEqual(out.outcome.generationIds, ['plan-1', 'author-evolve-1', 'author-look-2', 'author-sky-3', 'repair-evolve-4', 'repair-evolve-5', 'repair-evolve-6']);
    assert.equal(out.outcome.firstPassOk, false);
    assert.equal(out.outcome.repairs, 3);
    assert.equal(out.outcome.fps, null);
    assert.deepEqual(out.outcome.ladder, compactLadder(last.report));
    // A repair call that fails after the ladder ran: the report counts the repairs that came back.
    const broken = fakeClient({ repair: [new ForgeError('upstream', 502, 'bad'), new ForgeError('upstream', 502, 'bad again')] });
    const b = await run(broken, fakeVerifier(failure('sanity', 'look', 'L7'))).promise;
    assert.equal(b.kind, 'author-failed');
    assert.equal(b.outcome.repairs, 0);
    assert.equal(b.outcome.firstPassOk, false);
    // A plan that never came, and a cancel mid-ladder, report nothing.
    const noPlan = await run(fakeClient({ plan: [new ForgeError('budget', 503, 'cap')] }), fakeVerifier(ok())).promise;
    assert.equal(noPlan.outcome, undefined);
    const ac = new AbortController();
    const cancelling = { async verify() { ac.abort(); return failure('compile', 'evolve'); } };
    const c = await run(fakeClient(), cancelling, { signal: ac.signal }).promise;
    assert.equal(c.kind, 'cancelled');
    assert.equal(c.outcome, undefined);
});
