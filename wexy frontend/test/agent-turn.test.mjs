// EA-T series, headless (EA2.5; the backend's agent-loop design §15.1, gate B2): one agent turn's state and the session
// that runs one turn at a time (src/loop/agent-turn.ts), with an injected clock. Over the backend's recordings through
// the real reader: each ending's phase, and whether it is a success (only a hand-off, and only as checked). Over a
// client the test drives, one that keeps talking after it was told to stop: a superseding turn and a cancel, after
// which nothing late changes anything. Then the elapsed time, how failures read, and, from the sources, that the
// agent's modules cannot reach the world, the GPU or HTML.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';
import { AgentVersionError, readAgentStream } from '../src/forge-client/agent-stream.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { createAgentSession, elapsedMs, TURN_PHASES } from '../src/loop/agent-turn.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wire = (name) => readFileSync(join(ROOT, 'test/fixtures/agent-wire', name), 'utf8').replace(/\r\n/g, '\n');
const REQUEST = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };

/** A client answering every turn with one recording, through the real reader. */
const replaying = (name) => ({
    turn: (req, onEvent, signal) => readAgentStream(new Response(wire(`${name}.sse`)), onEvent, { bundleHash: ENGINE_BUNDLE_HASH, signal }),
});

/** A recording's checked events and result, to feed a scripted turn by hand. */
async function recorded(name) {
    const events = [];
    const result = await readAgentStream(new Response(wire(`${name}.sse`)), e => events.push(e), { bundleHash: ENGINE_BUNDLE_HASH });
    return { events, result };
}

/** A client the test drives: it says what it is told and settles when told, after a cancel too, as a racing transport might. */
function scripted() {
    const turns = [];
    return {
        turns,
        turn: (req, onEvent, signal) => new Promise((ok, fail) => turns.push({ req, onEvent, signal, ok, fail })),
    };
}

/** A clock the test moves. */
function clock(start = 1_000) {
    const c = { t: start, now: () => c.t };
    return c;
}

test('EA-T1 each recorded ending has its phase, and only a hand-off is a success, labelled checked, not rendered', async () => {
    const endings = [
        ['handed-off', 'handed-off'], ['context-limit', 'handed-off'], ['asked', 'asked'], ['declined', 'declined'],
        ['exhausted-revisions', 'exhausted'], ['exhausted-deadline', 'exhausted'], ['error-budget', 'failed'], ['error-upstream', 'failed'],
    ];
    for (const [name, phase] of endings) {
        const states = [];
        const end = await createAgentSession(replaying(name), s => states.push(s), clock().now).start(REQUEST);
        assert.equal(end.phase, phase, name);
        assert.equal(TURN_PHASES[end.phase].success, phase === 'handed-off', name);
        assert.deepEqual(states.at(-1), end, `${name}: the last state shown is the end`);
        assert.ok(states.slice(0, -1).every(s => s.phase === 'running'), `${name}: running until the end`);
        assert.equal(end.request, REQUEST);
    }
    assert.equal(TURN_PHASES['handed-off'].label, 'Handed off: checked, not rendered');
    assert.match(TURN_PHASES['handed-off'].note, /Nothing was built or rendered/);
    for (const phase of ['asked', 'exhausted', 'declined', 'failed', 'cancelled']) assert.match(TURN_PHASES[phase].label, /: no world$/, phase);

    const hand = await createAgentSession(replaying('handed-off'), () => {}, clock().now).start(REQUEST);
    assert.ok(hand.design && hand.program && hand.meta.turnId === 'turn-1');
    assert.deepEqual([hand.calls.length, hand.costMicroUsd, hand.unreported, hand.findings], [3, 138_000, 0, []]);
    const asked = await createAgentSession(replaying('asked'), () => {}, clock().now).start(REQUEST);
    assert.deepEqual([asked.question, asked.design, asked.program], ['Blocks of stone, or of wood — and does the river run?', null, null]);
    assert.match(TURN_PHASES.asked.note, /no way to answer it yet/);
    const revisions = await createAgentSession(replaying('exhausted-revisions'), () => {}, clock().now).start(REQUEST);
    assert.deepEqual([revisions.code, revisions.reason, revisions.findings[0].code], ['EA_TURN_BUDGET', 'EA_TURN_BUDGET: the check still fails after 2 revisions', 'buffer-producer']);
    const deadline = await createAgentSession(replaying('exhausted-deadline'), () => {}, clock().now).start(REQUEST);
    assert.deepEqual([deadline.unreported, deadline.costMicroUsd], [1, 0], 'one call reported nothing: its cost is unknown, and counted so');
    const budget = await createAgentSession(replaying('error-budget'), () => {}, clock().now).start(REQUEST);
    assert.deepEqual([budget.code, budget.reason, budget.costMicroUsd], ['budget', 'in the stream: Live creation has reached its spending limit for now.', 164_675]);
});

test('EA-T2 a new turn supersedes the running one: it is cancelled, and nothing it says or resolves to is heard', async () => {
    const { events, result } = await recorded('handed-off');
    const client = scripted();
    const states = [];
    const session = createAgentSession(client, s => states.push(s), clock().now);
    const first = session.start(REQUEST);
    client.turns[0].onEvent(events[0]);
    client.turns[0].onEvent(events[1]);
    const second = session.start({ ...REQUEST, prompt: 'a storm' });
    assert.equal(client.turns[0].signal.aborted, true, 'the superseded turn is cancelled');
    assert.equal(session.state.seq, 2);
    const shown = states.length;
    // The first turn keeps talking, then settles as if it had handed off: none of it is shown, or kept.
    for (const e of events.slice(2)) client.turns[0].onEvent(e);
    client.turns[0].ok(result);
    const firstEnd = await first;
    assert.equal(firstEnd.phase, 'cancelled', 'its caller hears it was cancelled');
    assert.equal(firstEnd.design, null);
    assert.equal(states.length, shown, 'nothing of the first turn was shown after the second began');
    assert.equal(states.at(-1).seq, 2);
    // The second runs as usual.
    const asked = await recorded('asked');
    for (const e of asked.events) client.turns[1].onEvent(e);
    client.turns[1].ok(asked.result);
    const secondEnd = await second;
    assert.deepEqual([secondEnd.seq, secondEnd.phase, secondEnd.request.prompt], [2, 'asked', 'a storm']);
    assert.ok(states.filter(s => s.seq === 1).every(s => s.phase === 'running'), 'the first turn was never shown ending');
});

test('EA-T3 a cancel shows at once; whatever the turn says or resolves to after it changes nothing', async () => {
    const { events, result } = await recorded('handed-off');
    const client = scripted();
    const states = [];
    const c = clock();
    const session = createAgentSession(client, s => states.push(s), c.now);
    const running = session.start(REQUEST);
    client.turns[0].onEvent(events[0]);
    client.turns[0].onEvent(events[1]);
    c.t = 4_000;
    session.cancel();
    assert.equal(client.turns[0].signal.aborted, true);
    assert.deepEqual([session.state.phase, session.state.endedMs, session.state.unreported], ['cancelled', 4_000, 1]);
    const shown = states.length;
    for (const e of events.slice(2)) client.turns[0].onEvent(e);
    client.turns[0].ok(result);
    const end = await running;
    assert.equal(end.phase, 'cancelled');
    assert.equal(end.design, null);
    assert.equal(states.length, shown);
    session.cancel();
    assert.equal(states.length, shown, 'a cancel with nothing running does nothing');

    // The usual end of a cancelled fetch, its AbortError, changes nothing either.
    const next = session.start(REQUEST);
    session.cancel();
    client.turns[1].fail(new DOMException('The operation was aborted.', 'AbortError'));
    assert.equal((await next).phase, 'cancelled');
});

test('EA-T4 the elapsed time runs on the session\'s clock while the turn runs, and stops when it ends', async () => {
    const { events, result } = await recorded('asked');
    const client = scripted();
    const c = clock(1_000);
    const session = createAgentSession(client, () => {}, c.now);
    const running = session.start(REQUEST);
    c.t = 1_200;
    client.turns[0].onEvent(events[0]);
    client.turns[0].onEvent(events[1]);
    c.t = 1_700;
    client.turns[0].onEvent(events[2]);
    assert.equal(elapsedMs(session.state, 2_000), 1_000);
    assert.deepEqual([session.state.calls[0].startedMs, session.state.calls[0].answeredMs], [1_200, 1_700]);
    c.t = 3_000;
    client.turns[0].onEvent(events[3]);
    client.turns[0].ok(result);
    const end = await running;
    assert.equal(end.endedMs, 3_000);
    assert.equal(elapsedMs(end, 99_999), 2_000, 'frozen once it ended');
});

test('EA-T5 a failure says what failed and where: an envelope\'s status, the stream, no answer; a cancel is a cancel', async () => {
    const failures = [
        [new ForgeError('budget', 503, 'Live creation has reached its spending limit for now.'), 'failed', 'budget', 'HTTP 503: Live creation has reached its spending limit for now.'],
        [new ForgeError('upstream', 200, 'missed the schema'), 'failed', 'upstream', 'in the stream: missed the schema'],
        [new ForgeError('timeout', 0, 'The agent turn had no last event within 315 s; the connection was dropped.'), 'failed', 'timeout', 'no answer: The agent turn had no last event within 315 s; the connection was dropped.'],
        [new AgentVersionError('bundle', 'a'.repeat(64), 'b'.repeat(64), 200), 'failed', 'EA_VERSION_MISMATCH', /^EA_VERSION_MISMATCH bundle aaaaaaaaaaaa, runtime bbbbbbbbbbbb/],
        [new AgentVersionError('actionSchema', 'none', 'agent-action.v2', 200), 'failed', 'EA_VERSION_MISMATCH', /^EA_VERSION_MISMATCH actionSchema none, runtime agent-action.v2: .*speaks agent-action.v1/],
        [new Error('boom'), 'failed', 'internal', 'boom'],
        [new DOMException('The operation was aborted.', 'AbortError'), 'cancelled', null, null],
    ];
    for (const [error, phase, code, reason] of failures) {
        const client = scripted();
        const session = createAgentSession(client, () => {}, clock().now);
        const running = session.start(REQUEST);
        client.turns[0].fail(error);
        const end = await running;
        assert.deepEqual([end.phase, end.code], [phase, code], String(error));
        if (reason instanceof RegExp) assert.match(end.reason, reason);
        else assert.equal(end.reason, reason);
        assert.equal(TURN_PHASES[end.phase].success, false);
    }
});

/**
 * The modules a source loads through its static imports, as relative paths and bare names. `import type` is erased
 * before anything runs, so it loads nothing and is not followed; `import { X, type Y }` loads its module and is.
 */
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
            // A file, never a folder: '../contract/agent' is its index.ts.
            const found = [base, `${base}.ts`, `${base}/index.ts`].find(p => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile());
            assert.ok(found, `${file} imports ${spec}, which is not on disk`);
            visit(found);
        }
    };
    for (const r of roots) visit(r);
    return seen;
}

test('EA-T6 the agent\'s modules reach no runtime, verifier, capture or engine code, set no HTML, and load only behind ?agent=1 or ?create=agent', () => {
    // EA4.5: the candidate path too (its panel, machine, reviser and module client), which checks bodies. EA5.1: and the
    // device compiler, handed a GPUDevice alone, which the panel never imports: the studio hands it in. 11-02: and a
    // saved attempt's replay, its view and its seal. EA9.1: and the creation controller and the creator's controls.
    const modules = [
        'src/shell/studio/agent-view.ts', 'src/shell/studio/candidate-view.ts', 'src/loop/agent-turn.ts', 'src/loop/candidate.ts', 'src/loop/reviser.ts',
        'src/shell/studio/replay-view.ts', 'src/loop/replay.ts', 'src/loop/creation.ts', 'src/shell/studio/creation-view.ts',
        'src/forge-client/agent-client.ts', 'src/forge-client/agent-stream.ts', 'src/forge-client/module-client.ts', 'src/forge-client/module-stream.ts',
        'src/contract/agent/index.ts', 'src/exec/device-compiler.ts',
    ];
    const reached = [...reach(modules)];
    assert.ok(reached.includes('src/forge-client/sse.ts') && reached.includes('src/shared/dom.ts'), 'the walk follows imports');
    assert.ok(reached.includes('src/loop/snapshot.ts') && reached.includes('src/contract/lint.ts'), 'the walk follows the candidate into its checks');
    assert.deepEqual(reached.filter(p => /^src\/(runtime|verify|capture)\//.test(p) || /^(null-graph|mediabunny|firebase)(\/|$)/.test(p)), [],
        'nothing the agent path loads can reach the world, the GPU, a film or Firebase');
    // Firebase arrives only through the Api the studio hands the clients; the views are handed no world at all.
    for (const file of ['src/shell/studio/agent-view.ts', 'src/shell/studio/candidate-view.ts', 'src/shell/studio/replay-view.ts', 'src/shell/studio/creation-view.ts']) {
        const view = readFileSync(join(ROOT, file), 'utf8');
        for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', "html:", "'html'"]) {
            assert.ok(!view.includes(sink), `${file} uses ${sink}`);
        }
    }
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.ok(!/^import [^;]*(agent-view|agent-client|agent-stream|agent-turn|candidate-view|replay-view|loop\/replay|module-client|module-stream|loop\/candidate|reviser|exec\/|loop\/creation|creation-view)/m.test(main),
        'the studio does not load the agent path statically');
    assert.match(main, /import\('\.\.\/\.\.\/loop\/creation'\)/);
    assert.match(main, /import\('\.\/creation-view'\)/);
    assert.match(main, /import\('\.\/agent-view'\)/);
    assert.match(main, /import\('\.\/replay-view'\)/);
    assert.match(main, /import\('\.\.\/\.\.\/forge-client\/module-client'\)/);
    assert.match(main, /import\('\.\.\/\.\.\/loop\/reviser'\)/);
    assert.match(main, /import\('\.\.\/\.\.\/exec\/device-compiler'\)/);
    // EA9.1: the agent path (?agent=1, ?create=agent) is selected once, from the URL, by creation-path.ts.
    assert.match(main, /if \(path\.agentPath\) void this\.mountDeviceCompiler\(vp\)/, 'the device compiler only on the agent path');
    assert.match(main, /if \(path\.agentPath\) void this\.mountCreation\(api\)/, 'the agent path\'s controller only on the agent path');
    for (const file of ['src/shell/studio/candidate-view.ts', 'src/shell/studio/replay-view.ts', 'src/loop/replay.ts']) {
        assert.ok(!readFileSync(join(ROOT, file), 'utf8').includes('exec/'), `${file} is handed its compiler and its stage`);
    }
    const selection = readFileSync(join(ROOT, 'src/shell/studio/creation-path.ts'), 'utf8');
    assert.match(selection, /params\.get\('agent'\) === '1'/);
    assert.match(selection, /params\.get\('create'\) === 'agent'/);
    assert.ok(!/^import /m.test(selection), 'the selection imports nothing: the plain page pays for none of the agent path');
});
