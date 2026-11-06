// EA9-U series, headless (EA9.1; agent-first-studio-design.md §2, §6, §9, §10; Q114, Q115 and Q118 decided 2026-11-03):
// the creation controller (src/loop/creation.ts) over the real turn session and the real candidate sessions, the backend
// answered from its own recordings (test/fixtures/agent-wire, module-wire) through the real clients, reader and
// transport, only fetch faked; a fake L3 compiler, a stand-in stage and account. Then the title (U10), the controller's
// import graph (U12) and the URL's creation path (U16). No model, no backend, no GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { retire } from '../src/exec/stage.ts';
import { createAgentClient } from '../src/forge-client/agent-client.ts';
import { createApi } from '../src/forge-client/http.ts';
import { createModuleClient } from '../src/forge-client/module-client.ts';
import { createAgentSession } from '../src/loop/agent-turn.ts';
import { candidateBundle, createCandidateSession, turnCallsOf } from '../src/loop/candidate.ts';
import { TURN_CALLS } from '../src/loop/candidate-ledger.ts';
import { COPY } from '../src/loop/copy.ts';
import { createCreationController, handOffFrom, runSentence, TITLE_CHARS, titleOf } from '../src/loop/creation.ts';
import { elapsed, roundCameBack, spoken, timed } from '../src/shell/studio/creation-view.ts';
import { AccountSession } from '../src/platform/session.ts';
import { Viewport } from '../src/runtime/viewport.ts';
import { creationAccount } from '../src/shell/studio/account.ts';
import { selectCreationPath, worldLink } from '../src/shell/studio/creation-path.ts';
import { stageTaken } from '../src/shell/studio/stage-holds.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wire = (dir, name) => readFileSync(join(ROOT, 'test/fixtures', dir, name), 'utf8').replace(/\r\n/g, '\n');
const sse = text => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const refusal = (status, code, message, headers = {}) => new Response(JSON.stringify({ code, message }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };
const IDENTITY = { async authorization() { return 'Bearer id-test'; }, async appCheck() { return 'ac-test'; } };
/** The idea the backend recorded its turns for (AgentWireTest's BODY). */
const IDEA = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };
const AUTHOR = wire('module-wire', 'author.sse');
const HANDED_OFF = wire('agent-wire', 'handed-off.sse');
/** A module answer for this request: the recorded author's, its job the request's, as the backend echoes every call's. */
const echoed = (text, request) => text.replace(/^event:meta\ndata:(.*)$/m, (_, data) =>
    `event:meta\ndata:${JSON.stringify({ ...JSON.parse(data), turnId: request.turnId, jobId: request.jobId, purpose: request.purpose, subject: request.subject })}`);
/** The recorded author's body, its deltas joined. */
const BODY = [...AUTHOR.matchAll(/^event:delta\ndata:(.*)$/gm)].map(m => JSON.parse(m[1]).text).join('');
/** A module answer with `answer` as its body (its hash and length as the backend reports them), the job the request's. */
function answered(answer, request) {
    const meta = JSON.parse(echoed(AUTHOR, request).match(/^event:meta\ndata:(.*)$/m)[1]);
    const usage = JSON.parse(AUTHOR.match(/^event:usage\ndata:(.*)$/m)[1]);
    const sha256 = createHash('sha256').update(answer, 'utf8').digest('hex');
    return [['meta', meta], ['delta', { text: answer }], ['usage', usage], ['done', { status: 'ok', answerSha256: sha256, answerChars: answer.length }]]
        .map(([e, d]) => `event:${e}\ndata:${JSON.stringify(d)}\n\n`).join('');
}
/** A fake L3, labelled so, passing every body: its verdicts are objects the session keeps, as a device's are. */
const COMPILER = { producedBy: 'fake', gpu: null, compile: async () => [] };
const INSTALLED = { status: 'installed', reason: null, numbers: '' };
const settle = () => new Promise(r => setTimeout(r, 15));
const waitFor = async (condition, label) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(condition(), `waited for ${label}`);
};

/** A route that answers nothing until its request is aborted, then fails as a cancel does: a call before its stream. */
const unanswered = init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The request was aborted', 'AbortError')), { once: true });
});

/** A stream that sends its first event, then waits for release (or its reader's abort): a call held open. */
function held(text) {
    const events = text.split(/(?<=\n\n)/).filter(Boolean);
    const enc = new TextEncoder();
    let release = () => {};
    const gate = new Promise(r => { release = r; });
    const body = new ReadableStream({
        async start(controller) {
            controller.enqueue(enc.encode(events[0]));
            await gate;
            try {
                for (const e of events.slice(1)) controller.enqueue(enc.encode(e));
                controller.close();
            } catch { /* cancelled by its reader */ }
        },
    });
    return { response: sse(body), release };
}

/**
 * The backend as the agent path meets it: the turn and module routes from the recordings unless a test says otherwise;
 * each request's caller (its Authorization) recorded, `identity` the transport's (a fixed token unless a test says).
 */
function backend(routes = {}, identity = IDENTITY, agentOptions = {}) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        const path = new URL(url).pathname;
        const body = init?.body ? JSON.parse(init.body) : null;
        requests.push({ path, body, auth: new Headers(init?.headers).get('Authorization') });
        if (path === '/v1/agent/turn') return (routes.turn ?? (() => sse(HANDED_OFF)))(body, requests.length, init);
        if (path === '/v1/agent/module') return (routes.module ?? (b => sse(echoed(AUTHOR, b))))(body, requests.length, init);
        return refusal(404, 'not-found', `no route ${path}`);
    };
    const api = createApi(CONFIG, identity, fetchImpl);
    return { requests, paths: () => requests.map(r => r.path), agent: createAgentClient(api, agentOptions), modules: createModuleClient(api) };
}

/**
 * The account (W1, W2): its epoch moved on demand, a caller established, its dialog and its reads after an entry counted.
 * `move()` is an account change, another uid signed in; `link()` an anonymous creator gaining Google, the same uid.
 */
function account() {
    const a = {
        e: 0, u: 'uid-0', changingNow: false, listeners: new Set(), entries: 0, limits: [], known: true, enters: 0,
        epoch: () => a.e,
        uid: () => (a.known ? a.u : null),
        established: () => a.known,
        async enter() { a.enters++; a.known = true; },
        changing: () => a.changingNow,
        subscribe(listener) { a.listeners.add(listener); return () => a.listeners.delete(listener); },
        afterEntry() { a.entries++; },
        limit(kind, sentence) { a.limits.push({ kind, sentence }); },
        move() { a.e++; a.u = `uid-${a.e}`; for (const l of [...a.listeners]) l(); },
        link() { a.e++; for (const l of [...a.listeners]) l(); },
    };
    return a;
}

/**
 * The studio's stage, standing in: each go recorded and answered as told (at once by `answer`, or held until the test
 * answers it). As the real stage's Present does, an answer to install after κ moved is a stop, and nothing installs; an
 * install retires the world before it once (stage.ts's retire, whose destroy may throw).
 */
function stagePort(ref, answer) {
    const port = {
        gos: [], installs: 0, releases: 0, retired: [], blockedWhy: null, onStage: null, destroyThrows: false,
        blocked: () => port.blockedWhy,
        go(snapshot, compiled, about) {
            const call = { snapshot, compiled, about, turn: ref.controller.n };
            port.gos.push(call);
            return new Promise(resolve => {
                call.answer = summary => {
                    // `committed`: the commit happened before κ moved, so the install stands whatever came after.
                    if (summary.status === 'installed' && ref.controller.n !== call.turn && !port.committed) return resolve({ status: 'stopped', reason: 'superseded', numbers: '' });
                    if (summary.status === 'installed') {
                        port.installs++;
                        if (port.onStage) {
                            const old = port.onStage;
                            port.retired.push(retire({ destroy() { if (port.destroyThrows) throw new Error('the old world would not let go'); } },
                                { release() { port.releases++; }, id: old }));
                        }
                        port.onStage = snapshot.id;
                    }
                    resolve(summary);
                };
                if (answer) call.answer(answer(call));
            });
        },
    };
    return port;
}

/**
 * A controller over the recordings, the fake compiler, the stage and the account; each candidate session's cancels
 * counted. `identity` is the transport's, `acct` an account port of the test's own (the studio's, EA9-U17).
 */
function rig({ routes = {}, answer = () => INSTALLED, modules, withAccount = true, compiler = COMPILER, identity, acct: given, now, agent } = {}) {
    const net = backend(routes, identity, agent);
    const acct = given ?? (withAccount ? account() : undefined);
    const ref = {};
    const stage = stagePort(ref, answer);
    const sessions = [];
    const controller = createCreationController({
        turnSession: onChange => createAgentSession(net.agent, onChange, () => 0),
        candidateSession: onChange => {
            const inner = createCandidateSession({ modules: modules ?? net.modules, compiler, attemptId: () => `attempt-${sessions.length}`, now: () => 0 }, onChange);
            const spy = { inner, cancels: 0 };
            spy.session = new Proxy(inner, {
                get(target, key) {
                    if (key === 'cancel') return () => { spy.cancels++; target.cancel(); };
                    const value = target[key];
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            sessions.push(spy);
            return spy.session;
        },
        stage, account: acct, now,
    });
    ref.controller = controller;
    const states = [];
    controller.subscribe(s => states.push(s));
    return { controller, net, acct, stage, sessions, states };
}

test('EA9-U1 Create runs the turn and writes its module, then waits; Show it is one go and one install; no h1 route', async () => {
    const r = rig();
    const ready = await r.controller.create(IDEA);
    assert.equal(ready.phase, 'ready', ready.sentence ?? '');
    assert.equal(r.stage.gos.length, 0, 'Create alone never shows: the go is the press (I5, Q115 (a))');
    assert.deepEqual(r.net.paths(), ['/v1/agent/turn', '/v1/agent/module'], 'the turn once, its one module once');
    assert.deepEqual([ready.steps.plan.state, ready.steps.build.state, ready.steps.check.state, ready.steps.ready.state], ['done', 'done', 'pending', 'pending']);
    assert.deepEqual([ready.steps.build.detail, ready.steps.check.detail], [COPY.creation.written(1), COPY.creation.readyToShow]);
    assert.equal(ready.title, titleOf(IDEA.prompt));
    assert.deepEqual(ready.handOff, handOffFrom(ready.turn), 'the hand-off the candidate started from is the turn\'s own');
    const session = r.controller.session;
    const summary = await r.controller.show();
    assert.equal(summary.status, 'installed');
    assert.deepEqual([r.stage.gos.length, r.stage.installs], [1, 1]);
    const [go] = r.stage.gos;
    assert.equal(go.snapshot, session.snapshot, 'the session\'s own sealed candidate');
    assert.equal(go.compiled, session.compiled, 'its L3 verdicts, the very objects (EA5.1: no copy is admitted)');
    // W3.6: its save needs S and whether it revises the world on the stage; a first world revises nothing.
    assert.deepEqual(go.about, { title: titleOf(IDEA.prompt), design: ready.handOff.design, revises: false });
    const after = r.controller.state;
    assert.equal(after.phase, 'installed');
    assert.ok(Object.values(after.steps).every(s => s.state === 'done'), JSON.stringify(after.steps));
    assert.equal(r.controller.installedSession, session);
    assert.equal(r.controller.sessionFor(session.snapshot.id), session, 'the review binds to the session holding the world on the stage');
    assert.ok(!r.net.paths().some(p => p.startsWith('/v1/forge/')), 'none of h1\'s routes (I4)');
    assert.equal(r.net.paths().length, 2, 'Show it calls no model');
    await settle();
    assert.equal(r.acct.entries, 1, 'the account read once after the entry (W1\'s afterEntry)');
    assert.deepEqual(r.acct.limits, []);
});

test('EA9-U2 every end that does not install leaves the stage as it was, and says one sentence', async () => {
    const quotaHeaders = { 'Retry-After': '3600' };
    // Q120 (b), EA9.5: an end after the turn was admitted says what the next Create is. A failure on the model's side is
    // first tried once more by the studio, inside the same world, so after its second failure the next is a new world.
    const second = s => `${s} ${COPY.creation.secondTry}`;
    const ends = [
        ['asked', { routes: { turn: () => sse(wire('agent-wire', 'asked.sse')) } }, s => s.startsWith('One more detail would help: ') && s.endsWith(` Add it to your idea, then press Create. ${COPY.creation.secondTry}`)],
        ['declined', { routes: { turn: () => sse(wire('agent-wire', 'declined.sse')) } }, s => s === second(COPY.creation.declined)],
        ['exhausted', { routes: { turn: () => sse(wire('agent-wire', 'exhausted-revisions.sse')) } }, s => s === second(COPY.creation.exhausted)],
        ['failed (upstream)', { routes: { turn: () => sse(wire('agent-wire', 'error-upstream.sse')) } }, s => s === `${COPY.failures.plan} ${COPY.creation.newWorld}`],
        ['failed (budget)', { routes: { turn: () => sse(wire('agent-wire', 'error-budget.sse')) } }, s => s === second(COPY.failures.budget)],
        ['a candidate\'s stop', { routes: { module: () => new Response(wire('module-wire', 'denied.json'), { status: 503, headers: { 'Content-Type': 'application/json' } }) } }, s => s === COPY.failures.budget],
        ['quota', { routes: { turn: () => refusal(429, 'quota', 'Today\'s world is made.', quotaHeaders) } }, s => s.startsWith('You\'ve made today\'s world. Early access gives one a day; the next opens at ')],
        ['an idea content safety refused', { routes: { turn: () => refusal(422, 'content-refused', 'This idea was refused.') } }, s => s === COPY.failures.refused],
    ];
    for (const [label, options, said] of ends) {
        const r = rig(options);
        const end = await r.controller.create(IDEA);
        assert.equal(end.phase, 'stopped', label);
        assert.ok(typeof end.sentence === 'string' && said(end.sentence), `${label}: ${end.sentence}`);
        assert.deepEqual([r.stage.gos.length, r.stage.installs, r.stage.retired.length], [0, 0, 0], `${label}: nothing reached the stage`);
        assert.equal(r.controller.installedSession, null, label);
        assert.equal(Object.values(end.steps).filter(s => s.state === 'failed').length, 1, `${label}: one row says it`);
        assert.equal(await r.controller.show(), null, `${label}: nothing to show`);
    }
    // No device verdict on its bodies (no device compiler): checked, but this device cannot test it, so no "Show it".
    const unjudged = rig({ compiler: null });
    const notHere = await unjudged.controller.create(IDEA);
    assert.deepEqual([notHere.phase, notHere.sentence], ['stopped', COPY.creation.notHere]);
    assert.equal(notHere.candidate.phase, 'static-verified', 'its candidate checked and sealed, as Developer view still shows it');
    assert.notEqual(unjudged.controller.showBlocked(), null);
    // While the account is changing, Create does nothing at all (W1's review): no request, no κ.
    const changing = rig();
    changing.acct.changingNow = true;
    const before = changing.controller.n;
    assert.equal((await changing.controller.create(IDEA)).phase, 'idle');
    assert.deepEqual([changing.net.requests.length, changing.controller.n], [0, before]);
    assert.match(changing.controller.createBlocked(), /account is changing/);
    // A Run refused: the world on the stage stays, the candidate may be pressed again (a new go), its sentence said (G4).
    const refused = rig({ answer: () => ({ status: 'refused', reason: 'EA_PROBE frame 300 ms over the 250 ms cap', numbers: '' }) });
    await refused.controller.create(IDEA);
    const run = await refused.controller.show();
    assert.equal(run.status, 'refused');
    assert.deepEqual([refused.controller.state.phase, refused.controller.state.sentence], ['ready', COPY.creation.runHeavy]);
    assert.deepEqual([refused.stage.installs, refused.stage.retired.length], [0, 0]);
    assert.equal(refused.controller.showBlocked(), null, 'Show it offered again');
    // A cancel: during the turn, then during the writing.
    for (const where of ['turn', 'module']) {
        const h = held(where === 'turn' ? HANDED_OFF : AUTHOR);
        const r = rig({ routes: where === 'turn' ? { turn: () => h.response } : { module: () => h.response } });
        const creating = r.controller.create(IDEA);
        await waitFor(() => r.controller.state.phase === (where === 'turn' ? 'turn' : 'writing') && r.net.paths().length === (where === 'turn' ? 1 : 2), where);
        r.controller.cancel();
        const end = await creating;
        h.release();
        await settle();
        // Stopped after its turn was admitted (its meta came): the next Create is its second try (Q120 (b)).
        assert.deepEqual([end.phase, end.sentence], ['cancelled', where === 'turn' ? second(COPY.creation.cancelled) : COPY.creation.cancelled], where);
        assert.deepEqual([r.controller.state.phase, r.stage.gos.length, r.stage.installs], ['cancelled', 0, 0], where);
        assert.equal(r.net.paths().length, where === 'turn' ? 1 : 2, `${where}: no request after the cancel`);
    }
});

test('EA9-U3 a second Create while modules are written: the first cancelled, nothing of it after, κ moved', async () => {
    // A module client whose first call ignores its cancel and answers late, as a racing transport might.
    const late = [];
    const calls = [];
    const net = backend();
    const modules = {
        async call(body, onEvent, signal) {
            calls.push(body);
            if (calls.length === 1) return new Promise(resolve => late.push(() => resolve(net.modules.call(body, onEvent, new AbortController().signal))));
            return net.modules.call(body, onEvent, signal);
        },
    };
    const r = rig({ modules });
    const first = r.controller.create(IDEA);
    await waitFor(() => calls.length === 1 && r.controller.state.phase === 'writing', 'the first module call');
    const n = r.controller.n;
    const firstSession = r.controller.session;
    const second = r.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    assert.ok(r.controller.n > n, 'κ moved');
    assert.equal(r.sessions[0].cancels, 1, 'the first attempt cancelled');
    const ready = await second;
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.idea.prompt, 'a lighthouse on a cliff in a storm');
    assert.notEqual(r.controller.session, firstSession, 'a session of its own (I8)');
    const before = JSON.stringify(r.controller.state);
    // The first attempt waits for its call to settle its accounting (candidate.ts); its answer comes late, after the cancel.
    late[0]();
    assert.equal((await first).n, r.controller.n, 'the first Create resolves with the state now, the second\'s');
    await settle();
    assert.equal(JSON.stringify(r.controller.state), before, 'the first\'s late answer changes nothing');
    assert.equal(firstSession.snapshot, null);
    assert.equal(calls.length, 2, 'one module call each: none from the first after the cancel');
});

test('EA9-U4 a quota or a spent allowance, at the turn or at a module call: the limit and W1\'s sentence, no request after it', async () => {
    const cases = [
        ['turn quota', { turn: () => refusal(429, 'quota', 'Today\'s world is made.', { 'Retry-After': '120' }) }, 'quota', 1],
        ['turn allowance', { turn: () => refusal(403, 'account-required', 'Sign in for more.') }, 'allowance', 1],
        ['module quota', { module: () => refusal(429, 'quota', 'Today\'s world is made.') }, 'quota', 2],
        ['module allowance', { module: () => refusal(403, 'account-required', 'Sign in for more.') }, 'allowance', 2],
    ];
    for (const [label, routes, kind, requests] of cases) {
        const r = rig({ routes });
        const end = await r.controller.create(IDEA);
        await settle();
        assert.deepEqual([end.phase, end.limit], ['stopped', kind], label);
        const sentence = kind === 'allowance' ? COPY.failures.allowance : null;
        if (sentence) assert.equal(end.sentence, sentence, label);
        else assert.ok(/^You've made today's world\./.test(end.sentence), `${label}: ${end.sentence}`);
        assert.deepEqual(r.acct.limits, [{ kind, sentence: end.sentence }], `${label}: W1's dialog once, with that sentence`);
        assert.equal(r.net.requests.length, requests, `${label}: no request after it`);
        assert.equal(r.stage.gos.length, 0, label);
    }
});

test('EA9-U5 an asked turn: its question shown, the idea kept; the next Create follows it inside its world (Q120 (b))', async () => {
    let turns = 0;
    const r = rig({ routes: { turn: () => sse(wire('agent-wire', ++turns === 1 ? 'asked.sse' : 'handed-off.sse')) } });
    const asked = await r.controller.create(IDEA);
    assert.equal(asked.phase, 'stopped');
    assert.ok(asked.question && asked.question === asked.turn.question, 'the model\'s question, as it asked it');
    assert.equal(asked.sentence, `${COPY.creation.asked(asked.question)} ${COPY.creation.secondTry}`);
    assert.deepEqual(asked.idea, IDEA, 'the idea kept');
    assert.equal(asked.steps.plan.state, 'failed');
    const answered = `${IDEA.prompt}, stone blocks and a running river`;
    const again = await r.controller.create({ ...IDEA, prompt: answered });
    assert.equal(again.phase, 'ready');
    assert.equal(again.question, null);
    assert.deepEqual(r.net.paths(), ['/v1/agent/turn', '/v1/agent/turn', '/v1/agent/module']);
    // The answer goes as a follow-up of the asked turn, with the idea as the creator changed it, and nothing else.
    assert.deepEqual(r.net.requests[1].body, { prompt: answered, style: IDEA.style, seconds: IDEA.seconds, retryOf: asked.turn.meta.turnId });
    assert.equal(again.follows, asked.turn.meta.turnId);
    // Its attempt counts the asked turn's calls too (Q_C never resets on a second try), and lists them: every call Q_C
    // counts has its record, in the state and the bundle (the independent review of EA9.5).
    // Its end was the service's own done, so its calls are all it made (the outside review of EA9.5: an end not seen
    // counts a turn's whole allowance; EA9-U30).
    assert.deepEqual(again.handOff.followed, {
        turnId: asked.turn.meta.turnId, model: asked.turn.meta.model, promptVersion: asked.turn.meta.promptVersion, calls: turnCallsOf(asked.turn.calls), end: 'seen',
        // This recording's meta says nothing of the turn it follows, as a forge before the count (EA9-U31 has one that does).
        service: null,
    });
    assert.equal(r.controller.session.state.budget.calls.unknown, 0, 'nothing unknown: every call of both turns was seen');
    const st = r.controller.session.state;
    const spent = st.budget.calls;
    assert.equal(spent.settled + spent.unknown, asked.turn.calls.length + again.turn.calls.length + 1, 'both turns\' calls, and the module call');
    assert.deepEqual(st.followed, again.handOff.followed);
    const bundle = candidateBundle(st);
    assert.equal(bundle.calls.followed.calls.length + bundle.calls.turns.flatMap(t => t.calls).length + bundle.calls.jobs.length, spent.settled + spent.unknown,
        'every call Q_C counts has its record in the bundle');
});

test('EA9-U6 a device loss during the writing, and during the Run: the creation stopped, its go void, nothing installed', async () => {
    const h = held(AUTHOR);
    const writing = rig({ routes: { module: () => h.response } });
    const creating = writing.controller.create(IDEA);
    await waitFor(() => writing.controller.state.phase === 'writing' && writing.net.requests.length === 2, 'the module call');
    const n = writing.controller.n;
    writing.controller.deviceLost();
    const end = await creating;
    h.release();
    await settle();
    assert.ok(writing.controller.n > n, 'κ moved: a Run under way stops at its next check');
    assert.deepEqual([end.phase, end.sentence], ['stopped', COPY.creation.deviceLost]);
    assert.equal(writing.sessions[0].cancels, 1, 'its attempt cancelled: its verdicts are another generation\'s');
    assert.equal(await writing.controller.show(), null);
    assert.deepEqual([writing.stage.gos.length, writing.stage.installs], [0, 0]);

    const running = rig({ answer: null });
    await running.controller.create(IDEA);
    const showing = running.controller.show();
    assert.equal(running.controller.state.phase, 'running');
    running.controller.deviceLost();
    running.stage.gos[0].answer(INSTALLED);
    const summary = await showing;
    assert.equal(summary.status, 'stopped', 'the stage\'s Present moved: no commit');
    assert.deepEqual([running.controller.state.phase, running.controller.state.sentence], ['stopped', COPY.creation.deviceLost]);
    assert.deepEqual([running.stage.installs, running.controller.installedSession], [0, null]);
    assert.notEqual(running.controller.showBlocked(), null, 'its old go cannot be pressed again');

    // And nothing more is made or shown on this page, which only a reload brings back (the EA9.1 independent review):
    // a turn and its modules now would be paid for a world no Run can show.
    const paidBefore = running.net.requests.length;
    assert.match(running.controller.createBlocked() ?? '', /device was lost/);
    assert.equal((await running.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' })).phase, 'stopped');
    assert.equal(running.net.requests.length, paidBefore, 'no paid turn after the loss');
    // The world on the stage keeps no paid action, and nothing of it is shown again, an improved candidate included.
    const shown = rig();
    await shown.controller.create(IDEA);
    await shown.controller.show();
    const onStage = shown.controller.installedSession.snapshot.id;
    shown.controller.deviceLost();
    assert.deepEqual([shown.controller.installedSession, shown.controller.sessionFor(onStage)], [null, null]);
    assert.match(shown.controller.showBlocked() ?? '', /device was lost/);
    const paid = shown.net.requests.length;
    await shown.controller.write();
    await shown.controller.create(IDEA);
    assert.deepEqual([shown.net.requests.length, shown.stage.gos.length], [paid, 1], 'no write, no Create and no go after the loss');
});

test('EA9-U13 a double Show it is one Run; a cancel after the prepare commits nothing; late answers after a supersession or an account change open nothing', async () => {
    // Two presses: running at once, before anything is awaited; the second finds nothing to show.
    const r = rig({ answer: null });
    await r.controller.create(IDEA);
    const first = r.controller.show();
    assert.equal(r.controller.state.phase, 'running', 'running synchronously (P7)');
    assert.equal(await r.controller.show(), null);
    assert.equal(r.stage.gos.length, 1, 'one go');
    // A cancel while the stage prepares (a second press on the button, which reads Stop by then): κ moves, so the stage's
    // commit check refuses it, and nothing installs. The world it tested stays written and checked: Show it again is a
    // new go, and no call is paid for it (the EA9.1 independent review).
    r.controller.cancel();
    r.stage.gos[0].answer(INSTALLED);
    assert.equal((await first).status, 'stopped');
    assert.deepEqual([r.stage.installs, r.controller.state.phase, r.controller.state.sentence], [0, 'ready', COPY.creation.runStopped]);
    assert.equal(r.controller.state.steps.check.state, 'pending', 'the creator\'s own Stop is no failure');
    assert.equal(r.controller.showBlocked(), null, 'Show it offered again');
    const again = r.controller.show();
    r.stage.gos[1].answer(INSTALLED);
    assert.equal((await again).status, 'installed');
    assert.deepEqual([r.stage.gos.length, r.stage.installs, r.controller.state.phase, r.controller.state.sentence], [2, 1, 'installed', null]);
    assert.deepEqual(r.net.paths(), ['/v1/agent/turn', '/v1/agent/module'], 'the world shown is the one written: no new paid call');
    // A cancel that came after the commit: the world is on the stage, so the creation is installed, its session whole.
    const beat = rig({ answer: null });
    await beat.controller.create(IDEA);
    const sealed = beat.controller.session;
    const showing = beat.controller.show();
    beat.stage.committed = true;
    beat.controller.cancel();
    beat.stage.gos[0].answer(INSTALLED);
    assert.equal((await showing).status, 'installed');
    assert.deepEqual([beat.controller.state.phase, beat.controller.state.sentence, beat.stage.installs], ['installed', null, 1]);
    assert.equal(beat.controller.sessionFor(sealed.snapshot?.id ?? 'none'), sealed, 'the session of the world on the stage, not cancelled by the late stop');

    // The account changes while modules are written: the creation stops; the late answer opens no dialog, installs nothing.
    const late = [];
    const net = backend();
    const modules = { call: (body, onEvent) => new Promise(resolve => late.push(() => resolve(net.modules.call(body, onEvent, new AbortController().signal)))) };
    const moved = rig({ modules });
    const creating = moved.controller.create(IDEA);
    await waitFor(() => late.length === 1, 'the module call');
    moved.acct.move();
    assert.deepEqual([moved.controller.state.phase, moved.controller.state.sentence], ['stopped', COPY.creation.accountChanged]);
    late[0]();
    await creating;
    await settle();
    assert.deepEqual([moved.acct.limits.length, moved.stage.gos.length, moved.controller.state.phase], [0, 0, 'stopped']);

    // Busy belongs to the creation under way: the superseded one's end never clears it.
    const ha = held(HANDED_OFF);
    const hb = held(HANDED_OFF);
    let t = 0;
    const two = rig({ routes: { turn: () => (++t === 1 ? ha : hb).response } });
    const a = two.controller.create(IDEA);
    await waitFor(() => two.net.requests.length === 1, 'the first turn');
    const b = two.controller.create(IDEA);
    await a;
    assert.equal(two.controller.busy, true, 'the second turn still runs');
    hb.release();
    await b;
    assert.equal(two.controller.busy, false);
    assert.equal(two.controller.state.phase, 'ready');
    ha.release();
});

test('EA9-U14 the world on the stage keeps its session through a failed replacement; a successful one releases it once', async () => {
    let modulesRefused = false;
    // Each world its own body (a comment of its own, which the lint passes), so each candidate has its own id(C).
    let worlds = 0;
    const r = rig({
        routes: {
            module: body => (modulesRefused ? new Response(wire('module-wire', 'denied.json'), { status: 503, headers: { 'Content-Type': 'application/json' } })
                : sse(answered(`// world ${++worlds}\n${BODY}`, body))),
        },
    });
    await r.controller.create(IDEA);
    await r.controller.show();
    const a = r.controller.installedSession;
    const aId = a.snapshot.id;
    // Developer view's "Write the modules again" on the world on the stage: a new attempt in a session of its own (I8).
    const rewritten = await r.controller.write();
    assert.equal(rewritten.phase, 'ready');
    assert.notEqual(r.controller.session, a, 'a session of its own');
    assert.deepEqual([r.sessions[0].cancels, a.snapshot?.id, r.controller.installedSession], [0, aId, a], 'A\'s session never restarted');
    const aBefore = JSON.stringify(a.state);
    // B fails while it is written: A's session, its budget and its review's binding are untouched.
    modulesRefused = true;
    const creatingB = r.controller.create({ ...IDEA, prompt: 'a desert of glass dunes' });
    await waitFor(() => r.controller.creating, 'B under way');
    assert.equal(r.controller.sessionFor(aId), a, 'while B runs, A is still bound');
    const b = await creatingB;
    assert.deepEqual([b.phase, b.sentence], ['stopped', COPY.failures.budget]);
    assert.equal(r.controller.creating, false);
    assert.equal(r.controller.installedSession, a);
    assert.equal(r.controller.sessionFor(aId), a);
    assert.equal(JSON.stringify(a.state), aBefore, 'its attempt, budget and evidence as they were');
    assert.equal(r.sessions[0].cancels, 0, 'A\'s session was never touched');
    assert.ok(a.revisable !== undefined && a.snapshot.id === aId);
    // C installs, and A's world's destroy throws: C stays installed, A's reservation is returned once, A's session goes once.
    modulesRefused = false;
    r.stage.destroyThrows = true;
    await r.controller.create({ ...IDEA, prompt: 'a forest of paper lanterns' });
    await r.controller.show();
    const c = r.controller.installedSession;
    assert.notEqual(c, a);
    assert.equal(r.stage.releases, 1, 'A\'s reservation returned once');
    assert.match(r.stage.retired[0], /^EA_RELEASE the old world would not let go; the new world stays installed$/);
    assert.equal(r.sessions[0].cancels, 1, 'A\'s session released once');
    assert.equal(r.controller.sessionFor(aId), null);
    assert.equal(r.controller.sessionFor(c.snapshot.id), c);
    // A saved attempt replayed takes the stage: no creation's grant is behind it, so no paid action is offered.
    const cId = c.snapshot.id;
    r.controller.replaced();
    assert.deepEqual([r.controller.installedSession, r.controller.sessionFor(cId), r.controller.state.phase], [null, null, 'idle']);
    // An account change keeps the world on the stage but takes its paid actions with the old account.
    const s = rig();
    await s.controller.create(IDEA);
    await s.controller.show();
    const held2 = s.controller.installedSession;
    s.acct.move();
    assert.equal(s.controller.state.phase, 'installed');
    assert.deepEqual([s.controller.installedSession, s.controller.sessionFor(held2.snapshot.id)], [null, null]);
});

/**
 * Firebase as the studio's identity meets it (identity.ts): a user or none; the transport's own lazy anonymous sign-in,
 * which an entry call makes when no one is signed in, one for any number of calls at once; onAuthStateChanged telling the
 * session after, as Firebase does; another tab's sign-in. `signIn` is whether that sign-in works: at once, never, or once
 * the test lets it.
 */
function firebaseLike(user, signIn = async () => {}) {
    let who = user;
    const listeners = new Set();
    const tell = () => { for (const l of [...listeners]) queueMicrotask(l); };
    const fb = {
        made: 0,
        /** Another tab signs in or out: this tab's auth hears it. */
        switchTo(next) { who = next; tell(); },
        port: {
            async current() { return who; },
            async linkGoogle() { return { kind: 'linked' }; },
            async signInExisting() { return { kind: 'signed-in' }; },
            async signOut() { who = null; tell(); },
            onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        },
        identity: {
            async authorization() {
                if (!who) {
                    await signIn();
                    if (!who) {
                        fb.made++;
                        who = { uid: `anon-${fb.made}`, provider: 'anonymous' };
                        tell();
                    }
                }
                return `Bearer ${who.uid}`;
            },
            async appCheck() { return null; },
        },
    };
    return fb;
}

/** The studio's account port as main.ts wires it: account.ts's creationAccount over the real session, the transport's sign-in its entry. */
function studioAccount(fb) {
    const session = new AccountSession(fb.port, { read: () => false, write() {} }, () => fb.identity.authorization(false));
    const control = {
        changing: false, entries: 0, limits: [],
        async afterEntry() { control.entries++; await session.refresh(); },
        limit(kind, sentence) { control.limits.push({ kind, sentence }); },
    };
    return { session, control, port: creationAccount(session, control) };
}

test('EA9-U17 a Create with no caller yet makes its own first: its sign-in is no switch, so the creation runs; a real switch still stops it', async () => {
    // Signed in with Google, then signed out: the next call makes a new anonymous caller (W1's lazy sign-in).
    const fb = firebaseLike({ uid: 'g-1', provider: 'google' });
    const a = studioAccount(fb);
    await a.session.refresh();
    await a.session.signOut();
    const out = a.session.current;
    assert.equal(out.kind, 'none');
    // A module call held open once `holding`, its answer this request's own (echoed) until the test lets it go.
    let holding = false;
    let release = () => {};
    let kindAtTurn = null;
    const r = rig({
        identity: fb.identity, acct: a.port,
        routes: {
            turn: () => { kindAtTurn = a.session.current.kind; return sse(HANDED_OFF); },
            module: b => {
                if (!holding) return sse(echoed(AUTHOR, b));
                const h = held(echoed(AUTHOR, b));
                release = h.release;
                return h.response;
            },
        },
    });
    const ready = await r.controller.create(IDEA);
    assert.deepEqual([ready.phase, ready.sentence], ['ready', null], 'its own caller stopped nothing (the EA9.1 review\'s high finding)');
    assert.equal(fb.made, 1, 'one anonymous caller made');
    assert.equal(kindAtTurn, 'anonymous', 'the session knew that caller before the turn went out');
    assert.deepEqual(a.session.current, { epoch: out.epoch + 1, kind: 'anonymous' }, 'one move, before the binding');
    assert.deepEqual(r.net.requests.map(q => [q.path, q.auth]), [['/v1/agent/turn', 'Bearer anon-1'], ['/v1/agent/module', 'Bearer anon-1']],
        'the turn and its module once each, both that caller\'s');
    assert.equal((await r.controller.show()).status, 'installed');
    assert.ok(r.controller.installedSession, 'the world on the stage keeps its paid actions: they are this caller\'s');
    await settle();
    assert.equal(a.control.entries, 1, 'the account read once after the entry');

    // A real switch under the next creation's writing (another tab signs in with Google): its paid work stops, as before,
    // and the world on the stage stays, without its old account's paid actions.
    holding = true;
    const next = r.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    await waitFor(() => r.controller.state.phase === 'writing' && r.net.requests.length === 4, 'the next creation\'s module call');
    await settle();
    assert.equal(r.controller.state.phase, 'writing', 'its module call is held open, nothing refused');
    fb.switchTo({ uid: 'g-2', provider: 'google' });
    await waitFor(() => r.controller.state.phase === 'stopped', 'the switch heard');
    assert.equal(r.controller.state.sentence, COPY.creation.accountChanged);
    release();
    await next;
    await settle();
    assert.deepEqual([r.net.requests.length, r.stage.installs, fb.made], [4, 1, 1], 'no call after the switch, nothing installed, no new caller');
    assert.equal(r.controller.installedSession, null);

    // A first visit: nothing read yet, no listener. Create makes the caller, and the session learns it with no move.
    const fresh = firebaseLike(null);
    const f = studioAccount(fresh);
    const fr = rig({ identity: fresh.identity, acct: f.port });
    const first = await fr.controller.create(IDEA);
    assert.deepEqual([first.phase, f.session.current], ['ready', { epoch: 0, kind: 'anonymous' }]);
    assert.deepEqual([fresh.made, fr.net.requests.map(q => q.auth)], [1, ['Bearer anon-1', 'Bearer anon-1']]);

    // No caller can be made (the sign-in fails): nothing is sent, and the creator reads one sentence.
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
        const broken = firebaseLike(null, async () => { throw new Error('identity: anonymous sign-in failed (auth/network-request-failed)'); });
        const b = studioAccount(broken);
        const br = rig({ identity: broken.identity, acct: b.port });
        const refused = await br.controller.create(IDEA);
        await settle();
        assert.deepEqual([refused.phase, refused.sentence, refused.steps.plan.state], ['stopped', COPY.failures['sign-in'], 'failed']);
        assert.deepEqual([br.net.requests.length, b.control.entries, b.session.current.kind], [0, 0, 'unknown'], 'no call without a caller, and none read after');
        assert.equal(warned.length, 1, 'the developer is told why, in the console');
    } finally {
        console.warn = warn;
    }

    // The studio wires the same: its session's entry is the transport's own sign-in, its port the one these tests use.
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.match(main, /new AccountSession\(identity\.account, browserHint, \(\) => identity\.authorization\(false\)\)/);
    assert.match(main, /account: session && control \? creationAccount\(session, control\) : undefined/);

    // Stop while the caller is being made: stopped at once; the sign-in that lands after it sends nothing.
    let letIn = () => {};
    const slow = firebaseLike(null, () => new Promise(resolve => { letIn = resolve; }));
    const sr = rig({ identity: slow.identity, acct: studioAccount(slow).port });
    const creating = sr.controller.create(IDEA);
    assert.deepEqual([sr.controller.state.phase, sr.controller.busy], ['turn', true], 'Stop offered while its caller is made');
    sr.controller.cancel();
    assert.deepEqual([sr.controller.state.phase, sr.controller.state.sentence], ['cancelled', COPY.creation.cancelled]);
    letIn();
    await creating;
    await settle();
    assert.deepEqual([sr.net.requests.length, sr.controller.state.phase], [0, 'cancelled'], 'nothing sent after the Stop');
});

/** A method of main.ts's Studio, its text from its signature to its closing brace (four spaces in). */
function methodOf(source, signature) {
    const at = source.indexOf(signature);
    assert.ok(at >= 0, `main.ts has ${signature}`);
    return source.slice(at, source.indexOf('\n    }\n', at));
}

test('EA9-U18 one owner of the stage: a photo\'s or a film\'s hold keeps Show it waiting, its end offers it again, and no photo or film runs beside a Run', () => {
    // Who holds the stage, as a Run's admission reads it (stage-holds.ts): each holder alone, a photo's hold among them.
    const none = { running: false, building: false, capturing: false, recording: false, held: false };
    assert.equal(stageTaken(none), null);
    for (const holder of Object.keys(none)) assert.equal(typeof stageTaken({ ...none, [holder]: true }), 'string', `${holder} alone holds the stage`);
    assert.equal(stageTaken({ ...none, held: true }), 'A photo or a film holds the stage: Run once it is done.', 'the EA9.1 review\'s first mid finding');

    // The viewport says when the first pause takes it and the last one lets it go, once each; a listener's throw never
    // strands a pause without its release (viewport.ts's onHold).
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    const vp = Object.assign(Object.create(Viewport.prototype), { raf: 0, pauses: 0, lastNow: 0, wantsFrames: true });
    const told = [];
    vp.onHold = isHeld => told.push(isHeld);
    const photo = vp.pause();
    const probe = vp.pause();
    assert.deepEqual([told, vp.held, vp.pauseCount], [[true], true, 2]);
    photo();
    photo();
    assert.deepEqual([told, vp.held, vp.pauseCount], [[true], true, 1], 'held while any pause is; a second release counts nothing');
    probe();
    assert.deepEqual([told, vp.held, vp.pauseCount], [[true, false], false, 0]);
    const error = console.error;
    const said = [];
    console.error = (...args) => { said.push(args); };
    try {
        vp.onHold = () => { throw new Error('a listener\'s fault'); };
        const release = vp.pause();
        assert.equal(vp.held, true);
        release();
        assert.deepEqual([vp.held, said.length], [false, 2], 'held and let go as ever, each throw said');
    } finally {
        console.error = error;
    }

    // main.ts's wiring, which only a browser runs (dev/ea9-e1.mjs): what a Run reads, and every holder's end offering it again.
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.match(methodOf(main, 'private runBlocked()'), /return stageTaken\(this\.stageHolders\(\)\);/);
    // Any pause past the backdrop's own (EA9.3): its rest while scrolled out of sight keeps no Show it waiting.
    const holders = methodOf(main, 'private stageHolders()');
    assert.match(holders, /const own = this\.backdrop\?\.holdCount\(\) \?\? 0;/);
    assert.match(holders, /held: \(this\.viewport\?\.pauseCount \?\? 0\) > own/);
    const init = methodOf(main, 'async init()');
    assert.match(init, /if \(path\.agentPath\) vp\.onHold = \(\) => \{ if \(!this\.stage\?\.busy\) this\.refreshRun\(\); \};/,
        'a photo\'s, a measurement\'s or a capture\'s hold, start and end (a Run\'s own probe windows aside)');
    const onBusy = init.slice(init.indexOf('this.exporter.onBusy'), init.indexOf('};', init.indexOf('this.exporter.onBusy')));
    assert.match(onBusy, /this\.refreshRun\(\);/, 'a film\'s recording, start and end (the second mid finding)');
    // The review's one StageReviews, on the agent path since EA9.4 (mountReviews): Developer view's panel drawn, then every
    // control that offers a Run again, the creator's panel among them (EA9.4's review: its Show it after a film's end).
    const reviews = methodOf(main, 'private async mountReviews(');
    assert.match(reviews.slice(reviews.indexOf('onChange: () =>')), /^onChange: \(\) => \{\s*this\.reviewPanel\?\.render\(\);\s*this\.refreshRun\(\);/,
        'a review capture\'s start and end');
    assert.match(methodOf(main, 'private refreshRun()'), /this\.renderOpening\(\);\s*this\.improveView\?\.render\(\);/, 'the creator\'s panel with them');
    const run = methodOf(main, 'private async runCandidate(');
    // Any Run's end, a saved attempt's too. An installed one's after H is set, through afterSwitch (EA9.3's reviews: a
    // refresh that threw between the stage's commit and the install left the world drawn owned by nobody).
    const installed = run.slice(run.indexOf('if (r.status === \'installed\') {'), run.indexOf('return { status: \'installed\''));
    assert.ok(installed.indexOf('this.installAgent(') > 0, 'the installed branch sets H');
    assert.ok(installed.indexOf('this.afterSwitch(\'the controls that offer a Run\', () => this.refreshRun());') > installed.indexOf('this.installAgent('), 'an installed Run\'s end, after H');
    assert.match(run.slice(run.indexOf('return { status: \'installed\'')), /this\.refreshRun\(\);/, 'a refused Run\'s end');
    assert.match(methodOf(main, 'private refreshRun()'), /this\.renderCreate\(\);\s*this\.candidatePanel\?\.refresh\(\);\s*this\.replayPanel\?\.refresh\(\);/);
    // The other way round (P7): no photo or film beside a Run, whatever kind of world is on the stage.
    const photoBody = methodOf(main, 'private async takeSnapshot()');
    assert.ok(photoBody.indexOf('if (this.stage?.busy) return;') >= 0 && photoBody.indexOf('if (this.stage?.busy) return;') < photoBody.indexOf('const film = '), 'a photo of either kind of world');
    const filmBody = methodOf(main, 'private openExport()');
    // A film of either kind of world waits for a Run, and for an example's build as a photo does (EA9.3's review).
    const filmGuard = 'if (this.stage?.busy || this.busy) return;';
    assert.ok(filmBody.indexOf(filmGuard) >= 0 && filmBody.indexOf(filmGuard) < filmBody.indexOf('const world = '), 'a film of either kind of world');
});

test('EA9-U19 a world written for Show it is never stranded: the review\'s paid actions on the world on the stage wait for it, and a round there never takes the views', async () => {
    // Fakes at the controller's seams: a turn that hands off at once; sessions that seal at once, and whose round the test
    // starts as the review's "Improve it" does (the session's own writing phase); a stage that installs.
    const handedOff = request => ({
        seq: 1, request, phase: 'handed-off', meta: { turnId: 'turn-1', model: 'm', promptVersion: 'p' }, calls: [], findings: [],
        design: {}, program: { nodes: [] }, question: null, reason: null, code: null, httpStatus: null, retryAfterSeconds: null,
        costMicroUsd: 0, unreported: 0, startedMs: 0, endedMs: 0,
    });
    const sessions = [];
    const controller = createCreationController({
        turnSession: () => ({
            state: null,
            cancel() {},
            start: async request => (request.prompt.startsWith('declined:')
                ? { ...handedOff(request), phase: 'declined', design: null, program: null } : handedOff(request)),
        }),
        candidateSession: onChange => {
            const s = {
                k: sessions.length, cancels: 0, snapshot: null, compiled: null,
                async start() {
                    s.snapshot = { id: `world-${s.k}` };
                    s.compiled = [];
                    onChange({ phase: 'static-verified', modules: [] });
                    return { phase: 'static-verified' };
                },
                cancel() { s.cancels++; },
                round() { onChange({ phase: 'correcting', modules: [] }); },
            };
            sessions.push(s);
            return s;
        },
        stage: { blocked: () => null, go: async () => INSTALLED },
    });
    await controller.create(IDEA);
    await controller.show();
    assert.deepEqual([controller.state.phase, controller.creating], ['installed', false], 'A on the stage, nothing else under way: the review may spend on A');
    // B written and waiting for Show it: the review's paid actions on A wait (main.ts's paidBusy reads `creating`).
    const b = await controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    assert.deepEqual([b.phase, controller.creating], ['ready', true]);
    // Were a round on A to start anyway, B keeps the views, uncancelled, and Show it shows B (the EA9.1 independent review).
    sessions[0].round();
    assert.deepEqual([controller.state.idea.prompt, controller.session === sessions[1], sessions[1].cancels], ['a lighthouse on a cliff in a storm', true, 0]);
    assert.equal(controller.showBlocked(), null);
    await controller.show();
    assert.deepEqual([controller.state.phase, controller.installedSession === sessions[1], controller.creating], ['installed', true, false]);
    // Developer view's turn, stopped at its hand-off, holds them as well; a creation that ended holds nothing.
    const c = await controller.create({ ...IDEA, prompt: 'a forest of paper lanterns' }, { write: false });
    assert.deepEqual([c.phase, controller.creating], ['handed-off', true]);
    const d = await controller.create({ ...IDEA, prompt: 'declined: something this studio cannot make' });
    assert.deepEqual([d.phase, controller.creating], ['stopped', false]);
    // The review's panels read `creating` only as they render, so the studio shows them again whenever that (or the stage's
    // session) changes: "Improve it" is offered again once the waiting world is gone. Since EA9.4 one subscription draws
    // both (mountReviews): the creator's at every word, Developer view's when its gate moves.
    const panel = methodOf(readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8'), 'private async mountReviews(');
    assert.match(panel, /creation\.subscribe\(\(\) => \{\s*improve\.render\(\);\s*const now = `\$\{!!creation\.creating\}\|\$\{!!creation\.sessionFor\(this\.agentWorld\?\.candidate \?\? null\)\}`;\s*if \(now === gate\) return;\s*gate = now;\s*this\.reviewPanel\?\.render\(\);/);
});

test('W3.6 the go says what a save needs: its design, and whether it revises the world on the stage (a round, or the same world shown again), never another creation\'s', async () => {
    // The fakes of EA9-U19: a turn that hands off at once, sessions that seal at once and run a round on demand.
    const handedOff = (request, design) => ({
        seq: 1, request, phase: 'handed-off', meta: { turnId: 'turn-1', model: 'm', promptVersion: 'p' }, calls: [], findings: [],
        design, program: { nodes: [] }, question: null, reason: null, code: null, httpStatus: null, retryAfterSeconds: null,
        costMicroUsd: 0, unreported: 0, startedMs: 0, endedMs: 0,
    });
    const sessions = [];
    const gos = [];
    const controller = createCreationController({
        turnSession: () => ({ state: null, cancel() {}, start: async request => handedOff(request, { idea: request.prompt }) }),
        candidateSession: onChange => {
            const s = {
                k: sessions.length, snapshot: null, compiled: null, cancel() {},
                async start() {
                    s.snapshot = { id: `world-${s.k}` };
                    s.compiled = [];
                    onChange({ phase: 'static-verified', modules: [] });
                    return { phase: 'static-verified' };
                },
                // The review's "Improve it": a round, then its improved candidate sealed in the same session.
                improve() {
                    onChange({ phase: 'correcting', modules: [] });
                    s.snapshot = { id: `world-${s.k}-improved` };
                    onChange({ phase: 'static-verified', modules: [] });
                },
            };
            sessions.push(s);
            return s;
        },
        stage: { blocked: () => null, go: async (snapshot, compiled, about) => { gos.push({ id: snapshot.id, about }); return INSTALLED; } },
    });
    await controller.create(IDEA);
    await controller.show();
    sessions[0].improve();
    assert.equal(controller.state.phase, 'ready', 'the improved world waits for Show it');
    await controller.show();
    // Past its envelope, the same world again (the EA9.2 review's Show it).
    await controller.show();
    const b = { ...IDEA, prompt: 'a lighthouse on a cliff in a storm' };
    await controller.create(b);
    await controller.show();
    assert.deepEqual(gos.map(g => [g.id, g.about.revises, g.about.design.idea]), [
        ['world-0', false, IDEA.prompt],
        ['world-0-improved', true, IDEA.prompt],
        ['world-0-improved', true, IDEA.prompt],
        ['world-1', false, b.prompt],
    ], 'a round and the same world shown again revise; another creation never does, its own design with it');
});

test('EA9-U20 a world written for Show it outlives a new idea that never starts: refused at entry or stopped first, it comes back ready; admitted, it goes (Q126 (b))', async () => {
    // The turn route answers in order: A's hand-off first, then what each case puts on the queue.
    const answers = [];
    const r = rig({ routes: { turn: (body, n, init) => (answers.shift() ?? (() => sse(HANDED_OFF)))(init) } });
    await r.controller.create(IDEA);
    const a = r.controller.session;
    assert.equal(r.controller.state.phase, 'ready');

    // B refused at entry (an anonymous allowance spent): W1's dialog opens, and A comes back, ready and untouched.
    answers.push(() => refusal(403, 'account-required', 'Sign in for more.'));
    const b = await r.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    assert.deepEqual([b.phase, b.idea.prompt, b.limit, b.sentence], ['ready', IDEA.prompt, 'allowance', COPY.creation.kept(COPY.failures.allowance)]);
    assert.equal(b.steps.check.state, 'pending', 'no failure of A\'s');
    assert.deepEqual(r.acct.limits, [{ kind: 'allowance', sentence: COPY.failures.allowance }], 'W1\'s dialog once, in the refusal\'s own words');
    assert.deepEqual([r.controller.session, r.sessions[0].cancels, r.controller.creating], [a, 0, true], 'A\'s own session, never cancelled, waiting');

    // C stopped while its turn waits for an answer, before its stream began: A comes back again.
    answers.push(unanswered);
    const c = r.controller.create({ ...IDEA, prompt: 'a forest of paper lanterns' });
    await waitFor(() => r.net.requests.length === 4 && r.controller.state.phase === 'turn', 'C\'s turn asked');
    assert.equal(r.controller.state.idea.prompt, 'a forest of paper lanterns', 'C the one shown meanwhile');
    r.controller.cancel();
    const stopped = await c;
    assert.deepEqual([stopped.phase, stopped.sentence, r.controller.session, r.sessions[0].cancels], ['ready', COPY.creation.keptStopped, a, 0]);

    // D superseded before its stream by E, which is refused at entry (the day's quota): A comes back once, to E's words.
    answers.push(unanswered, () => refusal(429, 'quota', 'Today\'s world is made.', { 'Retry-After': '120' }));
    const d = r.controller.create({ ...IDEA, prompt: 'a desert of glass dunes' });
    await waitFor(() => r.net.requests.length === 5, 'D\'s turn asked');
    const e = await r.controller.create({ ...IDEA, prompt: 'a city of bells' });
    await d;
    assert.deepEqual([e.phase, e.idea.prompt, e.limit], ['ready', IDEA.prompt, 'quota']);
    assert.ok(e.sentence.startsWith('You\'ve made today\'s world.') && e.sentence.endsWith(' Your last world is still ready: press Show it to test it.'), e.sentence);
    assert.deepEqual([r.controller.session, r.sessions[0].cancels], [a, 0]);

    // F admitted (its stream begins): A goes, once, and F is written in its place. Show it then shows F.
    const f = await r.controller.create({ ...IDEA, prompt: 'a reef of glowing coral' });
    assert.deepEqual([f.phase, f.idea.prompt, f.sentence, r.sessions[0].cancels], ['ready', 'a reef of glowing coral', null, 1]);
    assert.notEqual(r.controller.session, a);
    assert.equal((await r.controller.show()).status, 'installed');
    assert.equal(r.stage.gos[0].snapshot, r.controller.installedSession.snapshot, 'F on the stage');
    assert.equal(r.net.paths().filter(p => p === '/v1/agent/module').length, 2, 'A\'s module and F\'s, each once: nothing written again');

    // Admitted, then superseded (the EA9.2 review): the world kept goes the moment the new turn's stream begins, so a still
    // newer idea refused at entry brings nothing back, as a Stop after the admission brings nothing back.
    const turned = held(HANDED_OFF);
    const late = rig({
        routes: { turn: (body, n) => (n === 1 ? sse(HANDED_OFF) : n === 3 ? turned.response : refusal(403, 'account-required', 'Sign in for more.')) },
    });
    await late.controller.create(IDEA);
    const admitted = late.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    await waitFor(() => late.controller.state.turn?.meta != null && late.controller.state.idea.prompt !== IDEA.prompt, 'B\'s stream begun');
    assert.equal(late.sessions[0].cancels, 1, 'A goes at B\'s admission, not at its end');
    const refusedLater = await late.controller.create({ ...IDEA, prompt: 'a forest of paper lanterns' });
    turned.release();
    await admitted;
    // Since EA9.5 (Q120 (b)) the newer idea goes as B's second try (B was admitted, then stopped by it), which this
    // stand-in refuses as an entry's allowance, a word a real forge never says of a follow-up: said, and the next Create
    // is a new world.
    assert.equal(turnBodies(late).at(-1).retryOf, 'turn-1');
    assert.deepEqual([refusedLater.phase, refusedLater.idea.prompt, refusedLater.sentence], ['stopped', 'a forest of paper lanterns', `${COPY.failures.allowance} ${COPY.creation.newWorld}`]);

    // A device loss under a new idea's turn: the world kept was checked on the lost device too, so it goes.
    const lossy = rig({ routes: { turn: (body, n, init) => (n === 1 ? sse(HANDED_OFF) : unanswered(init)) } });
    await lossy.controller.create(IDEA);
    const g = lossy.controller.create({ ...IDEA, prompt: 'a moon of ice' });
    await waitFor(() => lossy.net.requests.length === 3, 'G\'s turn asked');
    lossy.controller.deviceLost();
    const gone = await g;
    assert.deepEqual([gone.phase, gone.sentence, lossy.sessions[0].cancels], ['stopped', COPY.creation.deviceLost, 1]);

    // After a sign-out, the new idea's caller is made first (EA9-U17): a sign-in that fails gives the kept world back, and
    // a Stop while a sign-in stalls gives it back at once, not when the sign-in settles.
    const out = rig();
    await out.controller.create(IDEA);
    out.acct.known = false;
    out.acct.enter = async () => { throw new Error('identity: anonymous sign-in failed (auth/network-request-failed)'); };
    const failed = await out.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    assert.deepEqual([failed.phase, failed.idea.prompt, failed.sentence], ['ready', IDEA.prompt, COPY.creation.kept(COPY.failures['sign-in'])]);
    out.acct.enter = () => new Promise(() => {});
    void out.controller.create({ ...IDEA, prompt: 'a forest of paper lanterns' });
    assert.equal(out.controller.state.phase, 'turn');
    out.controller.cancel();
    assert.deepEqual([out.controller.state.phase, out.controller.state.idea.prompt, out.controller.state.sentence], ['ready', IDEA.prompt, COPY.creation.keptStopped]);
    assert.deepEqual([out.net.requests.length, out.sessions[0].cancels], [2, 0], 'no turn asked for either, A untouched');
    // The studio done with the controller: the kept world goes with it.
    const done = rig({ routes: { turn: (body, n, init) => (n === 1 ? sse(HANDED_OFF) : unanswered(init)) } });
    await done.controller.create(IDEA);
    void done.controller.create({ ...IDEA, prompt: 'a moon of ice' });
    await waitFor(() => done.net.requests.length === 3, 'the new idea\'s turn asked');
    done.controller.dispose();
    assert.equal(done.sessions[0].cancels, 1);
});

test('EA9-U21 an account change discards a world written for its go and stops its Run; a link keeps it (Q127 (a) reversed, Q129)', async () => {
    // Written and waiting for Show it: another account signs in, and the world goes. The stage is as it was.
    const r = rig({ answer: null });
    await r.controller.create(IDEA);
    assert.equal(r.controller.unshown, true, 'a sign-out would ask first');
    const n = r.controller.n;
    r.acct.move();
    assert.deepEqual([r.controller.state.phase, r.controller.state.sentence], ['stopped', COPY.creation.discarded]);
    assert.ok(r.controller.n > n, 'κ moved');
    assert.deepEqual([r.controller.unshown, r.controller.showBlocked() !== null], [false, true], 'nothing waits, nothing to show');
    assert.equal(await r.controller.show(), null);
    assert.deepEqual([r.stage.gos.length, r.stage.installs, r.sessions[0].cancels], [0, 0, 1], 'no go, no install, its session let go');
    assert.deepEqual([r.net.requests.length, r.acct.limits.length], [2, 0], 'nothing more asked of the backend');

    // Its Run under way: stopped (κ moved, so the stage answers a stop and installs nothing), and the world goes with it.
    const run = rig({ answer: null });
    await run.controller.create(IDEA);
    const showing = run.controller.show();
    const k0 = run.controller.n;
    run.acct.move();
    assert.ok(run.controller.n > k0, 'κ moved under the Run');
    run.stage.gos[0].answer(INSTALLED);
    assert.equal((await showing).status, 'stopped');
    assert.deepEqual([run.controller.state.phase, run.controller.state.sentence, run.stage.installs], ['stopped', COPY.creation.discarded, 0]);

    // A link (an anonymous creator gaining Google: the same uid, a new epoch) is no account change: the world stays, shown.
    const l = rig({ answer: null });
    await l.controller.create(IDEA);
    l.acct.link();
    assert.deepEqual([l.controller.state.phase, l.controller.showBlocked(), l.controller.unshown], ['ready', null, true]);
    const linked = l.controller.show();
    l.stage.gos[0].answer(INSTALLED);
    assert.equal((await linked).status, 'installed');
    assert.equal(l.controller.state.phase, 'installed');

    // A world kept for its go while a new idea's turn waits (Q126 (b)) goes too when another account signs in under that
    // turn: it is never given back to the account signed in after.
    const k = rig({ routes: { turn: (body, at, init) => (at === 1 ? sse(HANDED_OFF) : unanswered(init)) } });
    await k.controller.create(IDEA);
    const creating = k.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    await waitFor(() => k.net.requests.length === 3, 'the new idea\'s turn asked');
    k.acct.move();
    const back = await creating;
    assert.notEqual(back.phase, 'ready', 'not given back');
    assert.equal(back.idea.prompt, 'a lighthouse on a cliff in a storm');
    assert.deepEqual([k.sessions[0].cancels, k.controller.unshown], [1, false], 'the kept world let go');

    // A link under that turn gives the kept world back, as Q126 (b) does: it is still that creator's.
    const kl = rig({ routes: { turn: (body, at, init) => (at === 1 ? sse(HANDED_OFF) : unanswered(init)) } });
    await kl.controller.create(IDEA);
    const linking = kl.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    await waitFor(() => kl.net.requests.length === 3, 'the new idea\'s turn asked');
    kl.acct.link();
    const given = await linking;
    assert.deepEqual([given.phase, given.idea.prompt, given.sentence], ['ready', IDEA.prompt, COPY.creation.kept(COPY.creation.accountChanged)]);
    assert.equal(kl.sessions[0].cancels, 0);
});

test('EA9-U9 G4: a Run that did not install says why in one sentence chosen by its code: unclear says try again or a different idea, too heavy a simpler idea; no code in any', async () => {
    const cases = [
        // The probe's own words (probe.ts): a measurement that came out unclear, and the world's own error in a variant.
        ['EA_PROBE_UNVERIFIED init: 1/4 measured 0.812 ms, below 1/8\'s 0.903 ms, above the floor of 5.200 ms; no full-size work submitted', COPY.creation.runUnclear],
        ['EA_PROBE_UNVERIFIED init on the 1/8 variant raised an error: [Invalid BindGroupLayout "wexy/castle"] is invalid; no full-size work submitted', COPY.creation.runUnclear],
        ['EA_PROBE one frame: its 1/8 variant alone took 210.4 ms at 2023×1138, near the 250 ms cap; nothing repeated it', COPY.creation.runHeavy],
        ['EA_ADMIT memory: 1.2 GB over 0.9 GB on AMD Radeon(TM) Graphics', COPY.creation.runHeavy],
        ['EA_ADMIT maxStorageBuffersPerShaderStage: 12 over 8 on Fake GPU', COPY.creation.runHeavy],
        ['EA_SANITY black: the brightest pixel is 0.0 of 255', COPY.creation.runDrawn],
        ['EA_CALL init: createBindGroup refused', COPY.creation.runBuilt],
        ['EA_EVIDENCE 0123456789ab…: no GPU go for this candidate in turn 3 on device generation 0', COPY.creation.runRefused],
        ['internal: the admission made no reservation', COPY.creation.runRefused],
        [null, COPY.creation.runRefused],
    ];
    for (const [reason, sentence] of cases) assert.equal(runSentence(reason), sentence, String(reason));
    // A code with a longer name is never taken for a shorter one's prefix, nor the other way round.
    assert.notEqual(runSentence('EA_PROBE_UNVERIFIED x'), runSentence('EA_PROBE x'));
    assert.match(COPY.creation.runUnclear, /press Show it again/);
    // The same code carries a world's own error, which fails at every press: the sentence offers another way out (the
    // EA9.2 review).
    assert.match(COPY.creation.runUnclear, /different idea/);
    for (const s of [COPY.creation.runHeavy]) assert.match(s, /simpler idea/);
    for (const s of new Set(cases.map(c => c[1]))) {
        assert.ok(!/EA_|\bms\b|×|\bGPU\b|[0-9a-f]{12}/.test(s), `no developer word in "${s}" (P5)`);
        assert.ok(/unchanged|again/.test(s), `"${s}" says the world stays or what to do`);
    }
    // Through the controller: the refused candidate waits for Show it again, its step failed, its sentence G4's.
    for (const [reason, sentence] of cases.slice(0, 3)) {
        const r = rig({ answer: () => ({ status: 'refused', reason, numbers: '' }) });
        await r.controller.create(IDEA);
        await r.controller.show();
        assert.deepEqual([r.controller.state.phase, r.controller.state.sentence, r.controller.state.steps.check.state], ['ready', sentence, 'failed']);
        assert.equal(r.controller.showBlocked(), null, 'Show it offered again');
    }
});

test('EA9-U22 each step counts its elapsed time on the controller\'s clock, never an estimate; a screen reader hears one sentence a phase, no time in it', async () => {
    let t = 1_000;
    const turn = held(HANDED_OFF);
    let module = null;
    const r = rig({
        now: () => t, answer: null,
        routes: { turn: () => turn.response, module: b => { module = held(echoed(AUTHOR, b)); return module.response; } },
    });
    const creating = r.controller.create(IDEA);
    await waitFor(() => r.controller.state.phase === 'turn' && r.net.requests.length === 1, 'the turn');
    assert.deepEqual(r.controller.state.steps.plan, { state: 'running', detail: COPY.creation.planning, since: 1_000, took: null });
    assert.equal(spoken(r.controller.state), COPY.creation.planning);
    assert.equal(timed(r.controller.state.steps.plan, 13_400), `${COPY.creation.planning} 12 s`, 'counted from the press, as it runs');
    t = 13_500;
    turn.release();
    await waitFor(() => r.controller.state.phase === 'writing' && module !== null, 'the module call');
    assert.deepEqual([r.controller.state.steps.plan.took, r.controller.state.steps.build.since], [12_500, 13_500]);
    assert.equal(timed(r.controller.state.steps.plan, t), `${COPY.creation.planned} · 12 s`);
    assert.equal(spoken(r.controller.state), COPY.creation.writingStart);
    t = 54_500;
    module.release();
    await creating;
    const ready = r.controller.state;
    assert.deepEqual([ready.phase, ready.steps.build.took, ready.steps.check.since], ['ready', 41_000, null]);
    assert.equal(timed(ready.steps.build, t), `${COPY.creation.written(1)} · 41 s`);
    assert.equal(spoken(ready), COPY.creation.readyToShow);
    const showing = r.controller.show();
    assert.deepEqual([r.controller.state.steps.check.state, r.controller.state.steps.check.since], ['running', 54_500]);
    t = 58_700;
    r.stage.gos[0].answer(INSTALLED);
    await showing;
    const shown = r.controller.state;
    assert.deepEqual([shown.phase, shown.steps.check.took], ['installed', 4_200]);
    assert.equal(timed(shown.steps.check, t), `${COPY.runs} · 4 s`);
    assert.equal(spoken(shown), COPY.creation.onStage);
    // Plain counts: seconds, then minutes and seconds; nothing else ever ticks.
    assert.deepEqual([elapsed(0), elapsed(999), elapsed(59_999), elapsed(65_000), elapsed(-5)], ['0 s', '0 s', '59 s', '1 min 05 s', '0 s']);
    assert.equal(timed({ state: 'running', detail: '2 of 4 parts written', since: 0, took: null }, 65_000), '2 of 4 parts written · 1 min 05 s');
    assert.equal(timed({ state: 'pending', detail: COPY.creation.readyToShow, since: null, took: null }, 99_000), COPY.creation.readyToShow);
    for (const s of [ready, shown]) for (const step of Object.values(s.steps)) assert.ok(!/%|left|remaining|about/.test(timed(step, t)), 'no percentage or estimate');
    // An end says its sentence; a stopped one too.
    const stopped = rig({ routes: { turn: () => sse(wire('agent-wire', 'declined.sse')) } });
    assert.equal(spoken(await stopped.controller.create(IDEA)), `${COPY.creation.declined} ${COPY.creation.secondTry}`);
    // A world on the stage paused past its envelope says so, and what to press (the EA9.2 review).
    assert.deepEqual([spoken(shown, true), spoken(shown, false), spoken(ready, true)], [COPY.creation.resized, COPY.creation.onStage, COPY.creation.readyToShow]);
    // The keyboard (E6): a held Ctrl+Enter presses once; its repeats are only kept from the page (the EA9.2 review).
    const keys = methodOf(readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8'), 'private wireKeys()');
    const shortcut = keys.slice(keys.indexOf("e.key === 'Enter'"));
    assert.ok(shortcut.indexOf('if (e.repeat) return;') > shortcut.indexOf('e.preventDefault();')
        && shortcut.indexOf('if (e.repeat) return;') < shortcut.indexOf('this.creationView?.shortcut()'), 'the repeat ignored before either path presses');
    // A pause reaches the creator's controls: each frame watches the world on the stage, and the view asks it.
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.match(methodOf(main, 'private onFrame('), /const paused = !!this\.agentWorld\?\.runtime\.isPaused;\s*if \(paused !== this\.agentPaused\) \{\s*this\.agentPaused = paused;\s*this\.refreshRun\(\);/);
    assert.match(methodOf(main, 'private async mountCreation('), /paused: \(\) => !!this\.agentWorld\?\.runtime\.isPaused,/);
});

test('EA9-U10 a world\'s title is its idea\'s first sentence, at most 48 characters, never a character cut', () => {
    assert.equal(titleOf('A castle on a hill. It has four towers and a moat.'), 'A castle on a hill');
    assert.equal(titleOf('  A   storm\nover the sea!  And more. '), 'A storm over the sea!');
    const long = titleOf('A spiral galaxy, gold at the core and blue along the arms, threaded with dark dust');
    assert.ok([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(long)].length <= TITLE_CHARS, long);
    assert.equal(long, 'A spiral galaxy, gold at the core and blue…');
    const family = '👨‍👩‍👧‍👦';
    const emoji = titleOf(`${'a'.repeat(46)}${family}${family} more words here`);
    assert.ok(!emoji.includes('‍…') && !/[\ud800-\udbff]…$/.test(emoji), 'no joiner or half a surrogate before the ellipsis');
    const kept = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)].map(s => s.segment);
    assert.ok(kept.length <= TITLE_CHARS && kept.every(g => g === 'a' || g === family || g === '…'), emoji);
    assert.equal(titleOf('One sentence only'), 'One sentence only');
    // A full stop after an abbreviation, after the idea's first word alone or after a list's number ends no sentence,
    // and a closing ellipsis goes whole (the EA9.1 independent review).
    assert.equal(titleOf('Mt. Fuji at dawn, cherry blossoms drifting past. A temple.'), 'Mt. Fuji at dawn, cherry blossoms drifting past');
    assert.equal(titleOf('St. Basil\'s Cathedral in falling snow'), 'St. Basil\'s Cathedral in falling snow');
    assert.equal(titleOf('Dr. Who\'s TARDIS spinning through a nebula. Stars.'), 'Dr. Who\'s TARDIS spinning through a nebula');
    assert.equal(titleOf('1. A castle 2. A moat 3. Dragons'), '1. A castle 2. A moat 3. Dragons');
    assert.equal(titleOf('A tower near Mt. Fuji at dawn. Mist.'), 'A tower near Mt. Fuji at dawn');
    assert.equal(titleOf('Capt. Nemo\'s submarine under the ice. Dark.'), 'Capt. Nemo\'s submarine under the ice', 'an abbreviation no list names, first');
    assert.equal(titleOf('U.S. Route 66 at sunset. Neon signs.'), 'U.S. Route 66 at sunset');
    assert.equal(titleOf('A castle... Then a moat.'), 'A castle');
    assert.equal(titleOf('A big dog. It runs.'), 'A big dog');
});

/** Every module a file reaches through value imports (type-only imports are erased). */
function reach(roots) {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        if (!file.endsWith('.ts')) return;
        const text = readFileSync(join(ROOT, file), 'utf8');
        for (const m of text.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)) {
            const spec = m[1] ?? m[2];
            if (!spec.startsWith('.')) { seen.add(spec); continue; }
            const base = join(dirname(file), spec.replace(/\?raw$/, '')).replace(/\\/g, '/');
            const found = [base, `${base}.ts`, `${base}/index.ts`].find(p => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile());
            assert.ok(found, `${file} imports ${spec}, which is not on disk`);
            visit(found);
        }
    };
    for (const r of roots) visit(r);
    return seen;
}

test('EA9-U12 the controller and the creator\'s controls reach no runtime, verifier, capture, engine, Firebase or h1 loop; the studio loads them only behind the flag', () => {
    const reached = [...reach(['src/loop/creation.ts', 'src/shell/studio/creation-view.ts'])];
    assert.ok(reached.includes('src/loop/candidate.ts') && reached.includes('src/loop/failures.ts'), 'the walk follows the controller into its sessions');
    assert.deepEqual(reached.filter(p => /^src\/(runtime|verify|capture|exec)\//.test(p) || /^(null-graph|mediabunny|firebase)(\/|$)/.test(p)), [],
        'nothing reaches the world, the GPU, a film or Firebase');
    assert.deepEqual(reached.filter(p => /^src\/loop\/machine\.ts$|^src\/contract\/h1\/|^src\/forge-client\/(live|mock)-client\.ts$/.test(p)), [],
        'nothing of h1\'s loop, host or clients (I4)');
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.ok(!/^import [^;]*(loop\/creation|creation-view|loop\/candidate|agent-turn)'/m.test(main), 'no static import of the agent path');
    assert.match(main, /import\('\.\.\/\.\.\/loop\/creation'\)/);
    assert.match(main, /import\('\.\/creation-view'\)/);
    assert.match(main, /if \(path\.agentPath\) void this\.mountCreation\(api\)/);
    // The machine's failure table moved out, so the controller shares it without h1's loop; h1's loop still uses it.
    assert.match(readFileSync(join(ROOT, 'src/loop/machine.ts'), 'utf8'), /import \{ classifyError \} from '\.\/failures'/);
    assert.deepEqual([...reach(['src/shell/studio/creation-path.ts'])], ['src/shell/studio/creation-path.ts'], 'the selection imports nothing');
});

test('EA9-U16 the creation path from the URL: one path, legacy wins, a loader suppresses autorun, no silent fallback, no URL GPU go', () => {
    const say = { unavailable: 'no backend', invalid: 'unknown selector' };
    const pick = (query, facts = {}) => selectCreationPath(new URLSearchParams(query), { switched: false, gateway: true, ...facts }, say);
    const row = s => [s.create, s.agentPanels, s.agentPath, s.devView, s.autorun, s.unavailable, s.invalid];
    // Before the switch (EA9.1 to EA9.4): h1 unless ?create=agent.
    assert.deepEqual(row(pick('')), ['h1', false, false, false, false, null, null]);
    assert.deepEqual(row(pick('?create=agent')), ['agent', false, true, false, false, null, null]);
    assert.deepEqual(row(pick('?create=agent&legacy=1')), ['h1', false, false, false, false, null, null], 'legacy wins');
    assert.deepEqual(row(pick('?agent=1')), ['h1', true, true, true, false, null, null], 'today\'s harness entry: h1\'s Create, the agent\'s panels');
    assert.deepEqual(row(pick('?agent=1&create=agent')), ['agent', true, true, true, false, null, null]);
    assert.deepEqual(row(pick('?legacy=1&agent=1&create=agent')), ['h1', true, true, true, false, null, null], '?agent=1 never overrides legacy');
    assert.deepEqual(row(pick('?dev=1')), ['h1', false, false, true, false, null, null], '?dev=1 alone chooses no path');
    assert.deepEqual(row(pick('?dev=0')), ['h1', false, false, false, false, null, null]);
    // A Create on load: on the selected path only, and only with no loader beside it.
    assert.deepEqual(row(pick('?create=agent&autorun=1&prompt=a%20castle')), ['agent', false, true, false, true, null, null]);
    const scene = pick('?create=agent&scene=galaxy&autorun=1&prompt=a%20castle');
    assert.deepEqual([scene.loader, scene.autorun], [{ kind: 'scene', name: 'galaxy' }, false], 'a loader calls no model, and suppresses the autorun');
    const replay = pick('?agent=1&create=agent&replay=castle&autorun=1');
    assert.deepEqual([replay.loader, replay.autorun], [{ kind: 'replay', name: 'castle' }, false]);
    // W3.6: a saved world by its id is a loader too, and it needs the stage, so it selects the agent path; legacy still
    // wins, and then nothing opens (the studio needs the agent path's stage for it).
    const world = pick('?world=01JC3W5F6Q7R8S9T0V1W2X3Y4Z&autorun=1');
    assert.deepEqual([world.create, world.agentPath, world.loader, world.autorun], ['agent', true, { kind: 'world', name: '01JC3W5F6Q7R8S9T0V1W2X3Y4Z' }, false]);
    assert.deepEqual(row(pick('?world=01JC3W5F6Q7R8S9T0V1W2X3Y4Z&legacy=1')), ['h1', false, false, false, false, null, null], 'legacy wins');
    assert.equal(worldLink('01JC3W5F6Q7R8S9T0V1W2X3Y4Z'), '/studio.html?create=agent&world=01JC3W5F6Q7R8S9T0V1W2X3Y4Z');
    assert.deepEqual(pick(new URL(worldLink('a b&c'), 'http://x').search).loader, { kind: 'world', name: 'a b&c' }, 'an id is carried as given, for the studio to check');
    // Unknown selectors start nothing and say so; they never pick a path of their own.
    for (const q of ['?create=h2&autorun=1', '?legacy=yes&autorun=1', '?create=&autorun=1']) {
        const s = pick(q);
        assert.deepEqual([s.create, s.autorun, s.invalid], ['h1', false, 'unknown selector'], q);
    }
    // No backend: the agent's Create says so and starts nothing; h1's page is unaffected.
    assert.deepEqual(row(pick('?create=agent&autorun=1', { gateway: false })), ['agent', false, true, false, false, 'no backend', null]);
    assert.deepEqual(row(pick('?autorun=1', { gateway: false })), ['h1', false, false, false, true, null, null]);
    // After the switch (EA9.5): the agent's by default, ?legacy=1 for h1, and an unknown selector never falls back to h1.
    assert.deepEqual(row(pick('', { switched: true })), ['agent', false, true, false, false, null, null]);
    assert.deepEqual(row(pick('?legacy=1', { switched: true })), ['h1', false, false, false, false, null, null]);
    assert.deepEqual(row(pick('?legacy=0', { switched: true })), ['agent', false, true, false, false, null, null]);
    assert.deepEqual(row(pick('?create=bogus&autorun=1', { switched: true })), ['agent', false, true, false, false, null, 'unknown selector']);
    // Nothing in a selection can show a world: the go is a press (I5).
    assert.deepEqual(Object.keys(pick('?create=agent&autorun=1')).sort(), ['agentPanels', 'agentPath', 'autorun', 'create', 'devView', 'invalid', 'loader', 'unavailable']);
    // The studio's autorun waits for the stage and for the creator's controls, whichever loads last, so it is never lost
    // (the EA9.1 independent review).
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.match(methodOf(main, 'async init()'), /else if \(path\.autorun\) void Promise\.all\(\[this\.stageReady, this\.creationReady\]\)\.then\(\(\) => this\.creationView\?\.create\(\)\);/);
    const mounting = methodOf(main, 'private async mountCreation(');
    const marked = mounting.indexOf('this.markCreationReady();');
    assert.ok(marked > mounting.indexOf('this.creationView = new CreationView(') && marked < mounting.indexOf('await this.mountAgent('), 'once its controls exist, before the panels');
});

// ---- The independent review of account-guards (2026-11-04) -----------------------------------------------------------

test('account-guards review high: a bare 403 at the turn (an edge\'s page, no envelope) is said as a sign-in; the gateway\'s own forbidden as the account\'s', async () => {
    const page = () => new Response('<html><body>403 Forbidden</body></html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
    const bare = rig({ routes: { turn: page } });
    const edge = await bare.controller.create(IDEA);
    assert.deepEqual([edge.phase, edge.sentence], ['stopped', COPY.failures['sign-in']]);
    const theirs = rig({ routes: { turn: () => refusal(403, 'forbidden', 'This account can\'t make worlds right now.') } });
    const barred = await theirs.controller.create(IDEA);
    assert.deepEqual([barred.phase, barred.sentence], ['stopped', COPY.failures.suspended]);
});

test('account-guards review L2: a world kept for its go that goes with an account change under the new idea\'s turn is said with that stop', async () => {
    const k = rig({ routes: { turn: (body, at, init) => (at === 1 ? sse(HANDED_OFF) : unanswered(init)) } });
    await k.controller.create(IDEA);
    const creating = k.controller.create({ ...IDEA, prompt: 'a lighthouse on a cliff in a storm' });
    await waitFor(() => k.net.requests.length === 3, 'the new idea\'s turn asked');
    k.acct.move();
    const back = await creating;
    assert.deepEqual([back.phase, back.sentence], ['stopped', COPY.creation.accountChangedDiscarded]);
    // Nothing kept: the plain sentence.
    const plain = rig({ routes: { turn: (body, at, init) => unanswered(init) } });
    const going = plain.controller.create(IDEA);
    await waitFor(() => plain.net.requests.length === 1, 'the turn asked');
    plain.acct.move();
    assert.deepEqual([(await going).phase, plain.controller.state.sentence], ['stopped', COPY.creation.accountChanged]);
});

test('account-guards review: a first visit\'s own caller then its link to Google is one creator: the world written for its go stays, and is shown', async () => {
    const r = rig({ answer: null });
    r.acct.known = false;
    const ready = await r.controller.create(IDEA);
    assert.deepEqual([ready.phase, r.acct.enters], ['ready', 1], 'its caller made at Create, then bound');
    r.acct.link();
    assert.deepEqual([r.controller.state.phase, r.controller.showBlocked(), r.controller.unshown], ['ready', null, true]);
    const showing = r.controller.show();
    r.stage.gos[0].answer(INSTALLED);
    assert.equal((await showing).status, 'installed');
    assert.equal(r.stage.installs, 1);
});

/**
 * The fakes of EA9-U19 over this file's stage and account: a turn that hands off at once; sessions that seal at once,
 * run the review's "Improve it" on demand, and say a cancel as a candidate's does (its phase `cancelled`).
 */
function roundRig({ ends = [] } = {}) {
    const handedOff = request => ({
        seq: 1, request, phase: 'handed-off', meta: { turnId: 'turn-1', model: 'm', promptVersion: 'p' }, calls: [], findings: [],
        design: {}, program: { nodes: [] }, question: null, reason: null, code: null, httpStatus: null, retryAfterSeconds: null,
        bare: false, costMicroUsd: 0, unreported: 0, startedMs: 0, endedMs: 0,
    });
    // The turns after the first, as `ends` names them: 'declined' (admitted, no world), 'quota' (refused at entry, no stream).
    const endOf = (kind, request) => (kind === 'declined' ? { ...handedOff(request), phase: 'declined', design: null, program: null, reason: 'no' }
        : { ...handedOff(request), phase: 'failed', meta: null, design: null, program: null, code: 'quota', httpStatus: 429, reason: 'today\'s world is made' });
    let turns = 0;
    const sessions = [];
    const acct = account();
    const ref = {};
    const stage = stagePort(ref, null);
    const controller = createCreationController({
        turnSession: () => ({ state: null, cancel() {}, start: async request => (turns++ > 0 && ends.length ? endOf(ends.shift(), request) : handedOff(request)) }),
        candidateSession: onChange => {
            const s = {
                k: sessions.length, cancels: 0, roundStops: 0, snapshot: null, compiled: null,
                async start() {
                    s.snapshot = { id: `world-${s.k}` };
                    s.compiled = [];
                    onChange({ phase: 'static-verified', modules: [] });
                    return { phase: 'static-verified' };
                },
                // As a candidate session's close does: its sealed world goes with it (candidate.ts's close).
                cancel() { s.cancels++; s.snapshot = null; s.compiled = null; onChange({ phase: 'cancelled', modules: [] }); },
                // As its stopRound does (EA9.4's review): the round ends, and the session is back on the world on the stage.
                stopRound() { s.roundStops++; onChange({ phase: 'static-verified', modules: [] }); },
                improve() {
                    onChange({ phase: 'correcting', modules: [] });
                    s.snapshot = { id: `world-${s.k}-improved` };
                    onChange({ phase: 'static-verified', modules: [] });
                },
                // A round held under way, then let go to its improvement (Q128 (b)).
                hold() { onChange({ phase: 'correcting', modules: [] }); },
                letGo() {
                    s.snapshot = { id: `world-${s.k}-improved` };
                    onChange({ phase: 'static-verified', modules: [] });
                },
            };
            sessions.push(s);
            return s;
        },
        stage, account: acct,
    });
    ref.controller = controller;
    return { controller, sessions, acct, stage };
}

async function onStage(r) {
    await r.controller.create(IDEA);
    const showing = r.controller.show();
    r.stage.gos.at(-1).answer(INSTALLED);
    await showing;
    assert.equal(r.controller.state.phase, 'installed');
}

test('account-guards review: an improvement of the world on the stage, written or being shown, goes when another account signs in; the world stays; a link keeps it', async () => {
    // Written and waiting for Show it.
    const w = roundRig();
    await onStage(w);
    w.sessions[0].improve();
    assert.deepEqual([w.controller.state.phase, w.controller.unshown], ['ready', true]);
    const n = w.controller.n;
    w.acct.move();
    assert.ok(w.controller.n > n, 'κ moved');
    assert.deepEqual([w.controller.state.phase, w.sessions[0].cancels, w.controller.unshown], ['installed', 1, false], 'the world on the stage stays; its improvement goes');
    assert.equal(await w.controller.show(), null, 'nothing to show');
    assert.deepEqual([w.stage.gos.length, w.stage.installs, w.stage.onStage], [1, 1, 'world-0']);
    assert.equal(w.controller.installedSession, null, 'its paid actions went with the account that made it');

    // Being shown: the Run stops (κ moved), and nothing installs.
    const s = roundRig();
    await onStage(s);
    s.sessions[0].improve();
    const showing = s.controller.show();
    s.acct.move();
    s.stage.gos[1].answer(INSTALLED);
    assert.equal((await showing).status, 'stopped');
    assert.deepEqual([s.stage.installs, s.stage.onStage, s.controller.state.phase], [1, 'world-0', 'installed']);

    // A link: the same creator; its improvement waits for its go, then shows.
    const l = roundRig();
    await onStage(l);
    l.sessions[0].improve();
    l.acct.link();
    assert.deepEqual([l.controller.state.phase, l.sessions[0].cancels, l.controller.showBlocked()], ['ready', 0, null]);
    const linked = l.controller.show();
    l.stage.gos[1].answer(INSTALLED);
    assert.equal((await linked).status, 'installed');
    assert.equal(l.stage.onStage, 'world-0-improved');
});

test('EA9-U21b Q128 (b): a Google link keeps the world on the stage\'s paid actions and its round under way; another account takes both', async () => {
    // The world on the stage, then a link (the same uid, a new epoch): its session stays the review's, so Improve it stays.
    const l = roundRig();
    await onStage(l);
    const held = l.controller.installedSession;
    assert.ok(held, 'the world on the stage holds its session');
    l.acct.link();
    assert.equal(l.controller.installedSession, held, 'a link keeps it: the same uid, whose grant the backend joins');
    assert.equal(l.controller.sessionFor('world-0'), held);

    // A round under way when a link lands goes on, and its improvement shows; the world stays the creator's after.
    const r = roundRig();
    await onStage(r);
    r.sessions[0].hold();
    assert.equal(r.controller.busy, true, 'a round is under way');
    const n = r.controller.n;
    r.acct.link();
    assert.deepEqual([r.sessions[0].cancels, r.controller.n], [0, n], 'the round goes on, κ unmoved');
    r.sessions[0].letGo();
    assert.equal(r.controller.state.phase, 'ready');
    const showing = r.controller.show();
    r.stage.gos.at(-1).answer(INSTALLED);
    assert.equal((await showing).status, 'installed');
    assert.equal(r.controller.installedSession, r.sessions[0], 'still the creator\'s after its improvement\'s install');

    // Another account signed in: the round stops, and the world's paid actions go with the account that made it. The round
    // alone stops (EA9.4's review): its maker, signed in again, finds the world's session and what is left of it.
    const m = roundRig();
    await onStage(m);
    m.sessions[0].hold();
    m.acct.move();
    assert.deepEqual([m.sessions[0].roundStops, m.sessions[0].cancels], [1, 0], 'the round stopped, the session kept');
    assert.deepEqual([m.controller.installedSession, m.controller.sessionFor('world-0'), m.controller.stageMoved], [null, null, true]);
    m.acct.e++;
    m.acct.u = 'uid-0';
    for (const l of [...m.acct.listeners]) l();
    assert.deepEqual([m.controller.installedSession, m.controller.stageMoved], [m.sessions[0], false], 'its maker again: its improvements again');
});

test('EA9.4 review: Stop during a round on the world on the stage ends the round alone; the world keeps its session and what is left of it', async () => {
    const r = roundRig();
    await onStage(r);
    const held = r.controller.installedSession;
    r.sessions[0].hold();
    assert.deepEqual([r.controller.busy, r.controller.state.phase], [true, 'writing']);
    r.controller.cancel();
    assert.deepEqual([r.sessions[0].roundStops, r.sessions[0].cancels], [1, 0], 'the round stopped, never the session');
    assert.deepEqual([r.controller.state.phase, r.controller.busy, r.controller.installedSession, r.controller.stageMoved], ['installed', false, held, false]);
});

test('EA9.4 review: an improvement written for its go comes back when a newer idea ends without a world, admitted or refused at entry; its Show it installs it', async () => {
    for (const end of ['declined', 'quota']) {
        const r = roundRig({ ends: [end] });
        await onStage(r);
        r.sessions[0].improve();
        assert.deepEqual([r.controller.state.phase, r.controller.state.improves], ['ready', true]);
        await r.controller.create({ ...IDEA, prompt: 'a reef of glowing coral' });
        const st = r.controller.state;
        const why = end === 'declined' ? `${COPY.creation.declined} ${COPY.creation.secondTry}` : COPY.failures.quota;
        assert.deepEqual([st.phase, st.improves, st.sentence], ['ready', true, COPY.creation.keptImproved(why)], end);
        assert.equal(r.controller.showBlocked(), null, `${end}: its Show it offered again`);
        const showing = r.controller.show();
        r.stage.gos.at(-1).answer(INSTALLED);
        assert.equal((await showing).status, 'installed', end);
        assert.equal(r.stage.onStage, 'world-0-improved', end);
    }
});

test('account-guards review: a Run whose commit beat the account change installs: the world is on the stage, said installed, not discarded', async () => {
    const r = rig({ answer: null });
    await r.controller.create(IDEA);
    const showing = r.controller.show();
    r.stage.committed = true;
    r.acct.move();
    assert.equal(r.controller.state.sentence, COPY.creation.discarded, 'said discarded while the Run is out');
    r.stage.gos[0].answer(INSTALLED);
    assert.equal((await showing).status, 'installed');
    assert.deepEqual([r.controller.state.phase, r.controller.state.sentence, r.stage.installs], ['installed', null, 1]);
});

test('account-guards review: after a device loss nothing waits to be shown first: an improvement of the world on the stage cannot be shown, so Sign out asks nothing', async () => {
    const r = roundRig();
    await onStage(r);
    r.sessions[0].improve();
    assert.deepEqual([r.controller.state.phase, r.controller.unshown], ['ready', true]);
    r.controller.deviceLost();
    assert.deepEqual([r.controller.unshown, r.controller.showBlocked() !== null], [false, true]);
});

test('EA9.4 review: a round that brought no new world comes back to the world on the stage unannounced as one; an improvement shown is announced', async () => {
    const r = roundRig();
    await onStage(r);
    let last = { phase: r.controller.state.phase, improves: r.controller.state.improves };
    const seen = [];
    const off = r.controller.subscribe(st => {
        seen.push(roundCameBack(last, st));
        last = { phase: st.phase, improves: st.improves };
    });
    r.sessions[0].hold();
    r.controller.cancel();
    assert.equal(r.controller.state.phase, 'installed');
    // The first word after the round's is its coming back (the controller publishes again after, which the Journey hears as said).
    assert.equal(seen[seen.indexOf(true)], true, 'the Journey leaves it to the panel');
    assert.equal(seen.filter(Boolean).length, 1, 'once');
    // A round that brings an improvement, then its Show it: the new version is on the stage, said so.
    seen.length = 0;
    r.sessions[0].improve();
    const showing = r.controller.show();
    r.stage.gos.at(-1).answer(INSTALLED);
    await showing;
    assert.equal(r.controller.state.phase, 'installed');
    assert.ok(seen.length > 0 && seen.every(b => b === false), 'every step said, its install too');
    off();
});

// ---- Q120 (b), EA9.5: the follow-up (the user, 2026-11-05: "Build the follow-up"; the creations platform designs §10) ----

/** A recorded stream, its turn renamed: each turn of a test its own id, as the backend mints one a turn. */
const as = (text, turnId) => text.replaceAll('"turnId":"turn-1"', `"turnId":"${turnId}"`);
/** A turn route answering each request with the next of `answers` (a fixture's name or a Response maker), turn-1, turn-2, ... */
function turnsOf(...answers) {
    let n = 0;
    return (body, _count, init) => {
        const a = answers[Math.min(n, answers.length - 1)];
        n++;
        return typeof a === 'function' ? a(body, init) : sse(as(wire('agent-wire', a), `turn-${n}`));
    };
}
const turnBodies = r => r.net.requests.filter(q => q.path === '/v1/agent/turn').map(q => q.body);

test('EA9-U25 a failure on the model\'s side is tried once more by itself, inside the same world, with the same idea; its attempt counts both turns', async () => {
    const r = rig({ routes: { turn: turnsOf('error-upstream.sse', 'handed-off.sse') } });
    const details = [];
    r.controller.subscribe(s => { if (s.phase === 'turn') details.push(s.steps.plan.detail); });
    const ready = await r.controller.create(IDEA);
    assert.equal(ready.phase, 'ready', ready.sentence ?? '');
    assert.deepEqual(turnBodies(r), [IDEA, { ...IDEA, retryOf: 'turn-1' }], 'the retry names the failed turn, the idea unchanged');
    assert.deepEqual(r.net.paths(), ['/v1/agent/turn', '/v1/agent/turn', '/v1/agent/module']);
    assert.ok(details.includes(COPY.creation.retrying), 'the plan row says it tries once more');
    assert.equal(ready.follows, 'turn-1');
    assert.equal(ready.handOff.followed.calls.length, 3, 'the failed turn\'s three calls');
    const spent = r.controller.session.state.budget.calls;
    assert.equal(spent.settled + spent.unknown, 3 + ready.turn.calls.length + 1);
    await settle();
    assert.equal(r.acct.entries, 2, 'the allowance read after each turn');
    // Once only: a second failure says so, and the next Create is a new world, sent as an entry.
    const twice = rig({ routes: { turn: turnsOf('error-upstream.sse') } });
    const failed = await twice.controller.create(IDEA);
    assert.deepEqual([failed.phase, failed.sentence], ['stopped', `${COPY.failures.plan} ${COPY.creation.newWorld}`]);
    assert.equal(turnBodies(twice).length, 2);
    await twice.controller.create({ ...IDEA, prompt: 'a simpler world' });
    assert.equal(turnBodies(twice)[2].retryOf, undefined, 'a new world: no follow-up after a follow-up');
});

test('EA9-U26 nothing else is tried again by itself: a spent budget, a dropped stream, a refusal before any stream, a follow-up\'s own failure', async () => {
    const meta = HANDED_OFF.split(/(?<=\n\n)/)[0];
    const cases = [
        ['a budget in the stream', 'error-budget.sse', `${COPY.failures.budget} ${COPY.creation.secondTry}`],
        ['a stream that ended before its last event', () => sse(meta), null],
        // The client's own cap says `upstream` too, but the service never ended the turn: its end there is unknown.
        ['a stream past the client\'s cap', () => sse(`${meta}event:call\ndata:${'x'.repeat(270_000)}\n\n`), null],
        ['upstream before any stream (nothing spent)', () => refusal(502, 'upstream', 'The model failed.'), COPY.failures.plan],
    ];
    for (const [label, answer, said] of cases) {
        const r = rig({ routes: { turn: turnsOf(answer) } });
        const end = await r.controller.create(IDEA);
        assert.equal(end.phase, 'stopped', label);
        assert.equal(turnBodies(r).length, 1, `${label}: one turn, none sent by itself`);
        if (said) assert.equal(end.sentence, said, label);
        else assert.ok(end.sentence.endsWith(COPY.creation.secondTry), `${label}: admitted, so its next Create is a second try: ${end.sentence}`);
    }
    // A follow-up that fails on the model's side is not retried: one second try a world.
    const r = rig({ routes: { turn: turnsOf('asked.sse', 'error-upstream.sse') } });
    await r.controller.create(IDEA);
    const end = await r.controller.create({ ...IDEA, prompt: `${IDEA.prompt}, stone` });
    assert.equal(turnBodies(r).length, 2);
    assert.equal(end.sentence, `${COPY.failures.plan} ${COPY.creation.newWorld}`);
});

test('EA9-U27 the creator\'s second try after each end with no world; one a world; a refused one (409) said, and the next Create is a new world', async () => {
    for (const [label, first] of [['declined', 'declined.sse'], ['exhausted', 'exhausted-revisions.sse'], ['a budget', 'error-budget.sse']]) {
        const r = rig({ routes: { turn: turnsOf(first, 'asked.sse', 'handed-off.sse') } });
        await r.controller.create(IDEA);
        const second = await r.controller.create({ ...IDEA, prompt: 'a calmer idea' });
        assert.equal(turnBodies(r)[1].retryOf, 'turn-1', `${label}: the second try names the first`);
        assert.ok(second.sentence.endsWith(COPY.creation.newWorld), `${label}: a follow-up spent, so a new world next: ${second.sentence}`);
        await r.controller.create({ ...IDEA, prompt: 'another idea' });
        assert.equal(turnBodies(r)[2].retryOf, undefined, `${label}: the third Create is an entry`);
    }
    // Stopped after its turn was admitted: its next Create is its second try.
    const h = held(HANDED_OFF);
    const stopped = rig({ routes: { turn: turnsOf(() => h.response, 'handed-off.sse') } });
    const creating = stopped.controller.create(IDEA);
    await waitFor(() => stopped.controller.state.turn?.meta, 'the turn admitted');
    stopped.controller.cancel();
    assert.equal((await creating).sentence, `${COPY.creation.cancelled} ${COPY.creation.secondTry}`);
    h.release();
    assert.equal((await stopped.controller.create(IDEA)).phase, 'ready');
    assert.equal(turnBodies(stopped)[1].retryOf, 'turn-1');
    // The service refuses a follow-up (expired, its end not written, a race): said; the next Create is an entry.
    const refused = rig({ routes: { turn: turnsOf('asked.sse', () => refusal(409, 'conflict', 'This try can\'t be continued, so a new Create makes a new world.'), 'handed-off.sse') } });
    await refused.controller.create(IDEA);
    const conflict = await refused.controller.create({ ...IDEA, prompt: 'with stone' });
    assert.deepEqual([conflict.phase, conflict.sentence, conflict.limit], ['stopped', COPY.creation.followRefused, null]);
    assert.deepEqual(refused.acct.limits, [], 'no dialog: nothing was refused for the allowance');
    await refused.controller.create({ ...IDEA, prompt: 'with stone' });
    assert.equal(turnBodies(refused)[2].retryOf, undefined, 'the next Create is a new world, sent as one');
});

test('EA9-U28 a second try never admitted is still the creator\'s: a refusal before any stream, its idea refused, a Stop first', async () => {
    const answers = [
        ['the service unavailable', () => refusal(503, 'unavailable', 'Live creation is unavailable right now.')],
        ['its changed idea refused', () => refusal(422, 'content-refused', 'This idea can\'t be made here.')],
        ['a Stop before its stream', (_b, init) => unanswered(init)],
    ];
    for (const [label, second] of answers) {
        const r = rig({ routes: { turn: turnsOf('asked.sse', second, 'handed-off.sse') } });
        await r.controller.create(IDEA);
        const trying = r.controller.create({ ...IDEA, prompt: 'with stone' });
        if (label.startsWith('a Stop')) {
            await waitFor(() => turnBodies(r).length === 2, `${label}: sent`);
            r.controller.cancel();
        }
        const end = await trying;
        assert.equal(end.phase, label.startsWith('a Stop') ? 'cancelled' : 'stopped', label);
        assert.ok(end.sentence.endsWith(COPY.creation.secondTry), `${label}: ${end.sentence}`);
        await r.controller.create({ ...IDEA, prompt: 'with stone' });
        assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1', 'turn-1'], `${label}: the same second try, sent again`);
    }
    // A Stop during the studio's own retry, before its stream: the creator's next Create is still that second try.
    const r = rig({ routes: { turn: turnsOf('error-upstream.sse', (_b, init) => unanswered(init), 'handed-off.sse') } });
    const retrying = r.controller.create(IDEA);
    await waitFor(() => turnBodies(r).length === 2, 'the retry sent');
    r.controller.cancel();
    assert.equal((await retrying).sentence, `${COPY.creation.cancelled} ${COPY.creation.secondTry}`);
    assert.equal((await r.controller.create(IDEA)).phase, 'ready');
    assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1', 'turn-1']);
});

test('EA9-U28b a second try the service refuses as a request (a forge before EA9.5 answers retryOf with 400; a 404, a 500) is not sent again', async () => {
    const answers = [
        ['400, a forge before EA9.5', () => refusal(400, 'bad-request', 'A turn takes only prompt, style, seconds and base, not retryOf.')],
        ['404', () => refusal(404, 'not-found', 'No such route.')],
        ['500', () => refusal(500, 'internal', 'Something went wrong on our side.')],
    ];
    for (const [label, second] of answers) {
        const r = rig({ routes: { turn: turnsOf('asked.sse', second, 'handed-off.sse') } });
        await r.controller.create(IDEA);
        const end = await r.controller.create({ ...IDEA, prompt: 'with stone' });
        assert.equal(end.phase, 'stopped', label);
        assert.ok(end.sentence.endsWith(COPY.creation.newWorld), `${label}: said, and the next Create is a new world: ${end.sentence}`);
        assert.equal((await r.controller.create({ ...IDEA, prompt: 'with stone' })).phase, 'ready', label);
        assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1', undefined], `${label}: the third Create an entry, which a forge before EA9.5 takes`);
    }
});

test('EA9-U28c a Create that supersedes a second try under way, or lands before a stopped turn settles, follows what it should (the independent review of EA9.5)', async () => {
    // Developer view's Run agent turn, pressed again while a second try's request has no answer: that try goes back.
    const r = rig({ routes: { turn: turnsOf('asked.sse', (_b, init) => unanswered(init), 'handed-off.sse') } });
    await r.controller.create(IDEA);
    const first = r.controller.create({ ...IDEA, prompt: 'with stone' }, { write: false });
    await waitFor(() => turnBodies(r).length === 2, 'the second try sent');
    const again = await r.controller.create({ ...IDEA, prompt: 'with stone' });
    await first;
    assert.equal(again.phase, 'ready');
    assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1', 'turn-1'], 'the second try not admitted went back, and was sent again');
    // A Create pressed in the same breath as Stop, before the stopped turn's request settles: it follows the stopped turn.
    const h = held(HANDED_OFF);
    const s = rig({ routes: { turn: turnsOf(() => h.response, 'handed-off.sse') } });
    const creating = s.controller.create(IDEA);
    await waitFor(() => s.controller.state.turn?.meta, 'the turn admitted');
    s.controller.cancel();
    const next = s.controller.create({ ...IDEA, prompt: 'a calmer idea' });
    await creating;
    h.release();
    assert.equal((await next).phase, 'ready');
    assert.deepEqual(turnBodies(s).map(b => b.retryOf), [undefined, 'turn-1'], 'the stopped turn, admitted, followed');
    // Its stream had said only its meta, and its end was not seen: Q_C counts its whole allowance (the outside review).
    const st = s.controller.session.state;
    assert.deepEqual([st.followed.end, st.followed.calls.length, st.budget.calls.unknown], ['unseen', 0, 6]);
});

test('EA9-U29 a second try is its uid\'s: another account\'s Create starts its own world; a link (the same uid) keeps it', async () => {
    const moved = rig({ routes: { turn: turnsOf('asked.sse', 'handed-off.sse') } });
    await moved.controller.create(IDEA);
    moved.acct.move();
    await moved.controller.create(IDEA);
    assert.equal(turnBodies(moved)[1].retryOf, undefined, 'another uid: an entry of its own');
    const linked = rig({ routes: { turn: turnsOf('asked.sse', 'handed-off.sse') } });
    await linked.controller.create(IDEA);
    linked.acct.link();
    assert.equal((await linked.controller.create(IDEA)).phase, 'ready');
    assert.equal(turnBodies(linked)[1].retryOf, 'turn-1', 'a link keeps the uid, and the second try');
    // A follow-up's request never carries a base, and a revision never carries a retryOf (the wire's own rule).
    assert.ok(linked.net.requests.every(q => q.path !== '/v1/agent/turn' || !(q.body.base && q.body.retryOf)));
});

test('EA9-U30 a second try after a turn whose end was not seen counts that turn\'s whole allowance into Q_C, unknown (the outside review of EA9.5, its mid)', async () => {
    // The first turn as the browser saw it: its meta, its first call and that call's usage. The service, not yet aware
    // the client had gone, made five calls more (a turn makes at most six, AgentTurn.MAX_CALLS), which no event told.
    const BACKEND_CALLS = 6;
    const opening = HANDED_OFF.split(/(?<=\n\n)/).slice(0, 3).join('');
    /** A stream that sends `text`, then waits for its reader's abort: the turn still running when it is stopped. */
    const open = (text, init) => sse(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } }, { once: true });
        },
    }));
    const META = JSON.parse(opening.match(/^event:meta\ndata:(.*)$/m)[1]);
    const seenCalls = turnCallsOf([{ n: 1, purpose: 'first', usage: JSON.parse(opening.match(/^event:usage\ndata:(.*)$/m)[1]) }]);
    // The second try's recording says nothing of the turn it follows: a forge before the count (EA9-U31 counts as told).
    const UNSEEN = { turnId: 'turn-1', model: META.model, promptVersion: META.promptVersion, calls: seenCalls, end: 'unseen', service: null };
    /** The second try's attempt, as Q_C and its bundle count it: the first turn's whole allowance, unknown. */
    const counts = (r, again, label) => {
        assert.equal(again.phase, 'ready', `${label}: ${again.sentence ?? ''}`);
        assert.deepEqual(again.handOff.followed, UNSEEN, label);
        const st = r.controller.session.state;
        // Q_C: the follow-up's three calls and its module call settled; the first turn's whole allowance unknown, never
        // its one call seen (the review's probe seeded what the browser saw, five calls short here).
        assert.deepEqual(st.budget.calls, { settled: again.turn.calls.length + 1, reserved: 0, unknown: BACKEND_CALLS }, label);
        const counted = st.budget.calls.settled + st.budget.calls.unknown;
        assert.ok(counted >= BACKEND_CALLS + again.turn.calls.length + 1, `${label}: Q_C counts at least what the service made: ${counted}`);
        // The bundle says so: the calls seen, the end unseen, what Q_C counts for it and what made it; with it, every call
        // Q_C counts.
        const bundle = candidateBundle(st);
        const { followed } = bundle.calls;
        assert.deepEqual([followed.end, followed.counted, followed.calls.length, followed.model, followed.promptVersion],
            ['unseen', BACKEND_CALLS, 1, META.model, META.promptVersion], label);
        assert.equal(followed.counted + bundle.calls.turns.flatMap(t => t.calls).length + bundle.calls.jobs.length, counted, label);
    };
    const cases = [
        ['a dropped connection', () => sse(opening), null],
        ['a stream past the client\'s cap', () => sse(`${opening}event:call\ndata:${'x'.repeat(270_000)}\n\n`), null],
        ['a stream that broke its contract', () => sse(`${opening}event:meta\ndata:{}\n\n`), null],
        // The agent client's own deadline (agent-client.ts), the stream still open: the independent review's gap.
        ['the client\'s deadline', (_b, init) => open(opening, init), null, { deadlineMs: 80 }],
        ['the creator\'s Stop', (_b, init) => open(opening, init), r => r.controller.cancel()],
        // Developer view's Run agent turn pressed again: the turn under way superseded by the next Create, its second try.
        ['a newer Create', (_b, init) => open(opening, init), 'supersede'],
        // A link (the same uid) keeps the second try, and its end as it was (EA9-U29's is a seen one).
        ['a dropped connection, then a link', () => sse(opening), 'link'],
    ];
    for (const [label, first, interrupt, agent] of cases) {
        const r = rig({ routes: { turn: turnsOf(first, 'handed-off.sse') }, agent });
        let again;
        if (interrupt === 'supersede') {
            const firstTry = r.controller.create(IDEA, { write: false });
            await waitFor(() => r.controller.state.turn?.calls.length === 1, `${label}: the first call seen`);
            again = await r.controller.create({ ...IDEA, prompt: 'a calmer idea' });
            await firstTry;
        } else {
            const creating = r.controller.create(IDEA);
            if (typeof interrupt === 'function') {
                await waitFor(() => r.controller.state.turn?.calls.length === 1, `${label}: the first call seen`);
                interrupt(r);
            }
            const end = await creating;
            assert.ok(end.sentence.endsWith(COPY.creation.secondTry), `${label}: admitted, so a second try: ${end.sentence}`);
            if (interrupt === 'link') r.acct.link();
            again = await r.controller.create({ ...IDEA, prompt: 'a calmer idea' });
        }
        assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1'], `${label}: the second try follows the first`);
        counts(r, again, label);
    }

    // A second try refused before its admission (the service unavailable) is kept for the next Create as it was, its end
    // still unseen (EA9-U28's is a seen one: the independent review's gap). Then another attempt from the same hand-off
    // (Developer view's Write the modules) counts the followed turn again: each attempt is its own Q_C.
    const kept = rig({ routes: { turn: turnsOf(() => sse(opening), () => refusal(503, 'unavailable', 'Live creation is unavailable right now.'), 'handed-off.sse') } });
    await kept.controller.create(IDEA);
    const refused = await kept.controller.create({ ...IDEA, prompt: 'a calmer idea' });
    assert.ok(refused.sentence.endsWith(COPY.creation.secondTry), `kept: still a second try: ${refused.sentence}`);
    const third = await kept.controller.create({ ...IDEA, prompt: 'a calmer idea' });
    assert.deepEqual(turnBodies(kept).map(b => b.retryOf), [undefined, 'turn-1', 'turn-1'], 'kept: the same second try, sent again');
    counts(kept, third, 'kept');
    const first = kept.controller.session;
    await kept.controller.write();
    assert.notEqual(kept.controller.session, first, 'a new attempt');
    counts(kept, kept.controller.state, 'written again');
});

test('EA9-U31 a second try counts the turn it followed as the service counted it, on its meta (the user, 11-06: "yes u can go ahead with api change"); a count not said keeps the whole allowance', async () => {
    // As EA9-U30's: the browser saw the first turn's meta, its first call and that call's usage, and never its end. The
    // service, which saw the client go, wrote that turn's end with the calls it dispatched (here two: the Stop came while
    // its second was out), and says so on the second try's meta.
    const SERVICE_CALLS = 2;
    const opening = HANDED_OFF.split(/(?<=\n\n)/).slice(0, 3).join('');
    const open = (text, init) => sse(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } }, { once: true });
        },
    }));
    const META = JSON.parse(opening.match(/^event:meta\ndata:(.*)$/m)[1]);
    const seenCalls = turnCallsOf([{ n: 1, purpose: 'first', usage: JSON.parse(opening.match(/^event:usage\ndata:(.*)$/m)[1]) }]);
    /** The second try's hand-off, its meta saying what the service wrote of the first turn. */
    const told = (end, calls) => () => sse(as(HANDED_OFF, 'turn-2').replace(/^event:meta\ndata:(.*)$/m,
        (_, d) => `event:meta\ndata:${JSON.stringify({ ...JSON.parse(d), followed: { turnId: 'turn-1', end, calls } })}`));
    const counts = (r, again, label, service) => {
        assert.equal(again.phase, 'ready', `${label}: ${again.sentence ?? ''}`);
        assert.deepEqual(again.handOff.followed,
            { turnId: 'turn-1', model: META.model, promptVersion: META.promptVersion, calls: seenCalls, end: 'unseen', service }, label);
        const st = r.controller.session.state;
        const own = again.turn.calls.length + 1;
        // Q_C: the follow-up's calls and its module call, and the first turn's as the service counted them (never fewer
        // than the browser saw), all settled; with no count said, its whole allowance, unknown (EA9-U30).
        const exact = service.calls === null ? null : Math.max(service.calls, seenCalls.length);
        assert.deepEqual(st.budget.calls, exact === null
            ? { settled: own, reserved: 0, unknown: TURN_CALLS }
            : { settled: own + exact, reserved: 0, unknown: 0 }, label);
        const bundle = candidateBundle(st);
        const { followed } = bundle.calls;
        assert.deepEqual([followed.end, followed.service, followed.counted, followed.calls.length], ['unseen', service, exact ?? TURN_CALLS, 1], label);
        assert.equal(followed.counted + bundle.calls.turns.flatMap(t => t.calls).length + bundle.calls.jobs.length,
            st.budget.calls.settled + st.budget.calls.unknown, `${label}: every call Q_C counts`);
    };
    const cases = [
        ['the creator\'s Stop', (_b, init) => open(opening, init), r => r.controller.cancel(), { end: 'cancelled', calls: SERVICE_CALLS }],
        ['a dropped connection', () => sse(opening), null, { end: 'failed', calls: SERVICE_CALLS }],
        ['the client\'s deadline', (_b, init) => open(opening, init), null, { end: 'cancelled', calls: SERVICE_CALLS }, { deadlineMs: 80 }],
        ['a newer Create', (_b, init) => open(opening, init), 'supersede', { end: 'cancelled', calls: SERVICE_CALLS }],
        // The service's count is never fewer than the calls the browser saw.
        ['a count below what was seen', () => sse(opening), null, { end: 'failed', calls: 0 }],
        // An end written by a forge before the count: its calls unknown, so the whole allowance (the deploy's window).
        ['a count not said', (_b, init) => open(opening, init), r => r.controller.cancel(), { end: 'cancelled', calls: null }],
    ];
    for (const [label, first, interrupt, service, agent] of cases) {
        const r = rig({ routes: { turn: turnsOf(first, told(service.end, service.calls)) }, agent });
        let again;
        if (interrupt === 'supersede') {
            const firstTry = r.controller.create(IDEA, { write: false });
            await waitFor(() => r.controller.state.turn?.calls.length === 1, `${label}: the first call seen`);
            again = await r.controller.create({ ...IDEA, prompt: 'a calmer idea' });
            await firstTry;
        } else {
            const creating = r.controller.create(IDEA);
            if (typeof interrupt === 'function') {
                await waitFor(() => r.controller.state.turn?.calls.length === 1, `${label}: the first call seen`);
                interrupt(r);
            }
            const end = await creating;
            assert.ok(end.sentence.endsWith(COPY.creation.secondTry), `${label}: admitted, so a second try: ${end.sentence}`);
            again = await r.controller.create({ ...IDEA, prompt: 'a calmer idea' });
        }
        assert.deepEqual(turnBodies(r).map(b => b.retryOf), [undefined, 'turn-1'], `${label}: the second try follows the first`);
        counts(r, again, label, service);
    }

    // A second try's meta naming another turn than the one it followed breaks the contract: no hand-off, nothing written.
    const wrong = rig({ routes: { turn: turnsOf(() => sse(opening), () => sse(as(HANDED_OFF, 'turn-2').replace(/^event:meta\ndata:(.*)$/m,
        (_, d) => `event:meta\ndata:${JSON.stringify({ ...JSON.parse(d), followed: { turnId: 'turn-9', end: 'failed', calls: 1 } })}`))) } });
    await wrong.controller.create(IDEA);
    const broken = await wrong.controller.create({ ...IDEA, prompt: 'a calmer idea' });
    assert.notEqual(broken.phase, 'ready', `the wrong turn named: ${broken.sentence}`);
    assert.equal(broken.handOff, null);
    assert.deepEqual(wrong.net.paths().filter(p => p === '/v1/agent/module'), [], 'no module written for it');
});
