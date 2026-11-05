// The agent turn's Developer view in a real DOM, with no GPU (EA2.5; the backend's agent-loop design §15.1, gate B2).
// AgentPanel runs over the backend's wire recordings (test/fixtures/agent-wire) through the real client, reader and
// transport; only fetch is fake. The page starts no renderer and loads no runtime; dev/drive-agent-view.mjs runs it in
// headless Chrome with the GPU off, and reads window.__AV__: each check, what the page's traps counted, the browser.
//   EA-V1  each recorded ending shows its phase, its words and its numbers; only a hand-off is a success, and it says
//          checked, not rendered
//   EA-V2  text with markup in it, from the model or the backend, shows as text: no element made, no script run
//   EA-V3  the elapsed time runs while a turn runs, and stops when it ends
//   EA-V4  a superseding turn and a cancel, after which nothing the old turn says or settles to is shown: through the
//          real reader, and through a client that ignores its cancel
//   EA-V5  the world on the stage untouched; no WebGPU adapter, canvas context or markup write; no runtime, verifier,
//          capture, engine or Firebase module loaded
//   EA-V7  a hand-off's candidate (EA4.5) over the backend's module recordings (test/fixtures/module-wire): each module
//          with its body as checked and its verdicts, Q_C, the calls, the evidence, the sealed id(C), and the bundle
//          the developer downloads; a turn not handed off (running, or cancelled with its program) offers no modules
//   EA-V8  an unusable answer called again within Q_C; a refusal before the stream ends the candidate in both voices
//   EA-V9  markup in a module's body shows as text
//   EA-V10 while a candidate runs only Cancel is offered; a new turn, a cancel and the panel's dispose each stop it:
//          nothing their calls say after shows
//   EA-V11 (the EA4.5 review) a program the browser refuses, revised over the recorded wire (revised.sse) and its
//          module written: the revision's turn shown beside the hand-off's, each call with its charge, model and
//          template, and the downloaded bundle holding both
//   EA-V12 (EA5.3) Run on this GPU: not offered without the studio's stage; offered for a sealed candidate with a
//          device-labelled verdict on every body (a scripted stand-in here, which the real gate refuses by provenance)
//          once the stage is ready; a press hands the stage the sealed candidate and its verdicts, shows the Run while it
//          lasts, then a refusal in the developer's words, or the world on the stage with its numbers; markup in a reason
//          shows as text; a new write moves the turn the stage's Run is bound to
//   EA-VR11a (EA6.2) the review of the stage over a real candidate session and a stand-in stage and capture, no GPU: its
//          frames named, its findings as labelled checkboxes with model-written names as text, "Improve it" only with
//          words or a finding and then one revision citing exactly them, "Looks right" spending nothing, a busy stage
//          said in both voices, the panel within 320 px
//   EA-VR11b (EA6.4) a model's review over the real client and transport and the backend's recorded terms and verdict
//          (test/fixtures/review-wire), only fetch faked: the disclosure before anything is sent, the creator's consent,
//          one call with the nine fields, the model's issues as labelled checkboxes with model-written markup as text,
//          "Improve it" citing exactly the issue kept, the budget counting it, all within 320 px
//   EA9-E1 (EA9.1, agent-first-studio-design.md §10) the creator's Create behind ?create=agent as the studio mounts it
//          (creation-view.ts over the creation controller) over the same recordings, L3 and the stage stood in: Create runs
//          the turn and writes its module with Stop offered, then waits for "Show it"; its press is one go, a second press
//          none; installed, every step done; no h1 route asked; none of Developer view's words in the creator's view (P5),
//          within 320 px; an asked turn's question, markup and all, shown as text in its step
// Since EA9.1 every panel here watches a creation controller of its own (creation.ts), made over the client it is handed:
// "Run agent turn" is a Create that stops at its hand-off, and the candidate's presses are the controller's.

import '../src/styles/base.css';
import '../src/styles/studio.css';
import { createAgentClient, ENGINE_BUNDLE_HASH, type AgentClient, type AgentTurnRequest } from '../src/forge-client/agent-client';
import { readAgentStream, type AgentEvent, type AgentTurnResult } from '../src/forge-client/agent-stream';
import { createApi } from '../src/forge-client/http';
import { createModuleClient, type ModuleClient } from '../src/forge-client/module-client';
import { createReviewClient } from '../src/forge-client/review-client';
import type { Reviser } from '../src/loop/candidate';
import { COPY } from '../src/loop/copy';
import type { StageWorld } from '../src/loop/review';
import type { EnginePort } from '../src/exec/engine-port';
import type { AgentRuntime } from '../src/exec/world-runtime';
import { createReviser } from '../src/loop/reviser';
import type { ModuleCompiler } from '../src/contract/adapters/bodies';
import { AgentPanel } from '../src/shell/studio/agent-view';
import type { CandidatePanel, RunControl, RunSummary } from '../src/shell/studio/candidate-view';
import moduleAuthorWire from '../test/fixtures/module-wire/author.sse?raw';
import moduleDeniedJson from '../test/fixtures/module-wire/denied.json?raw';
import moduleEmptyWire from '../test/fixtures/module-wire/error-empty.sse?raw';
import askedWire from '../test/fixtures/agent-wire/asked.sse?raw';
import contextLimitWire from '../test/fixtures/agent-wire/context-limit.sse?raw';
import declinedWire from '../test/fixtures/agent-wire/declined.sse?raw';
import deniedJson from '../test/fixtures/agent-wire/denied.json?raw';
import errorBudgetWire from '../test/fixtures/agent-wire/error-budget.sse?raw';
import errorUpstreamWire from '../test/fixtures/agent-wire/error-upstream.sse?raw';
import exhaustedDeadlineWire from '../test/fixtures/agent-wire/exhausted-deadline.sse?raw';
import exhaustedRevisionsWire from '../test/fixtures/agent-wire/exhausted-revisions.sse?raw';
import handedOffWire from '../test/fixtures/agent-wire/handed-off.sse?raw';
import revisedWire from '../test/fixtures/agent-wire/revised.sse?raw';
import reviewTermsJson from '../test/fixtures/review-wire/terms-open.json?raw';
import reviewFailJson from '../test/fixtures/review-wire/fail.json?raw';

const trap = (window as unknown as { __trap__: { requestAdapter: number; getContext: number; innerHTML: number; armed: boolean } }).__trap__;
const logEl = document.getElementById('log')!;
const log = (line: string, level: 'log' | 'error' = 'log') => {
    console[level](`[av] ${line}`);
    logEl.textContent += `${line}\n`;
};
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok: !!ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`, ok ? 'log' : 'error');
};

const enc = new TextEncoder();
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(condition: () => boolean, ms = 3_000): Promise<void> {
    for (const t0 = performance.now(); !condition(); await sleep(10)) {
        if (performance.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${condition}`);
    }
}

/**
 * A recording with the data of its `nth` event called `name` rewritten. The harness's own fixtures, shaped by hand:
 * `any` here is the edit's convenience, never a boundary.
 */
function edit(text: string, name: string, nth: number, change: (data: any) => unknown): string {
    let seen = -1;
    return lf(text).replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event: string, data: string) =>
        (event !== name || ++seen !== nth ? whole : `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}`));
}

interface Stream { response: Response; release(): void; cancelled(): boolean }

/** A recording as a server would send it: its events `gapMs` apart, and only the first `hold` until release(). */
function stream(text: string, gapMs = 0, hold: number | null = null): Stream {
    const events = lf(text).split(/(?<=\n\n)/).filter(Boolean);
    let cancelled = false;
    let released = hold === null;
    let wake: () => void = () => {};
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            void (async () => {
                while (next < events.length && !cancelled) {
                    if (!released && next >= hold!) {
                        await new Promise<void>(r => { wake = r; });
                        continue;
                    }
                    if (gapMs) await sleep(gapMs);
                    if (cancelled) return;
                    controller.enqueue(enc.encode(events[next++]));
                }
                if (!cancelled) controller.close();
            })();
        },
        cancel() {
            cancelled = true;
            wake();
        },
    });
    return {
        response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        release() { released = true; wake(); },
        cancelled: () => cancelled,
    };
}

const CONFIG = { apiOrigin: 'http://127.0.0.1:9', firebase: null, appCheckSiteKey: null, dev: true };
const IDENTITY = { authorization: async () => 'Bearer dev.anonymous.harness', appCheck: async () => null };

/** The real transport and client, over a fetch that answers each request with the next of `answers`. */
function liveClient(...answers: (() => Response)[]): AgentClient {
    const fetchImpl = (async () => {
        const next = answers.shift();
        if (!next) throw new Error('the harness has no answer left');
        return next();
    }) as unknown as typeof fetch;
    return createAgentClient(createApi(CONFIG, IDENTITY, fetchImpl));
}

/** A client deaf to its cancel: it says every event of `script`, `gapMs` apart, then settles to its result regardless. */
function deaf(script: { events: AgentEvent[]; result: AgentTurnResult }, gapMs: number): AgentClient {
    return {
        async turn(_req, onEvent) {
            for (const e of script.events) {
                await sleep(gapMs);
                onEvent(e);
            }
            await sleep(gapMs);
            return script.result;
        },
    };
}

async function recorded(text: string): Promise<{ events: AgentEvent[]; result: AgentTurnResult }> {
    const events: AgentEvent[] = [];
    const result = await readAgentStream(new Response(lf(text)), e => events.push(e), { bundleHash: ENGINE_BUNDLE_HASH });
    return { events, result };
}

const REQUEST: AgentTurnRequest = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };
const panels = document.getElementById('panels')!;

function panel(client: AgentClient | null, label: string): AgentPanel {
    const p = new AgentPanel(client, () => REQUEST);
    p.el.dataset.case = label;
    panels.append(p.el);
    return p;
}

/** What a panel shows, read from its DOM as a person would see it. */
function look(p: AgentPanel) {
    const el = (selector: string) => p.el.querySelector<HTMLElement>(selector);
    const text = (selector: string) => {
        const e = el(selector);
        return e && !e.hidden ? e.textContent : null;
    };
    const part = (selector: string) => (el(selector)?.hidden === false ? el(`${selector} .agent-tag`)?.textContent ?? '' : null);
    return {
        phase: p.el.dataset.phase,
        success: p.el.dataset.success,
        status: text('.agent-phase'),
        note: text('.agent-note'),
        reason: text('.agent-reason'),
        question: text('.agent-question'),
        calls: [...p.el.querySelectorAll('.agent-call')].map(c => c.textContent ?? ''),
        findings: [...p.el.querySelectorAll('.agent-finding')].map(f => f.textContent ?? ''),
        design: part('.agent-design'),
        program: part('.agent-program'),
        /** The program as shown, folded or not: the nodes, each config parsed from the JSON text it came as (EA3.6). */
        programText: el('.agent-program pre')?.textContent ?? null,
        cost: text('.agent-cost'),
        elapsed: text('.agent-elapsed'),
        meta: text('.agent-meta'),
    };
}

const cancelButton = (p: AgentPanel) => [...p.el.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!;
const ms = (shown: string | null) => (shown === null ? NaN : shown.endsWith(' ms') ? parseFloat(shown) : parseFloat(shown) * 1000);

async function ending(text: string, label: string): Promise<ReturnType<typeof look>> {
    const p = panel(liveClient(() => stream(text).response), label);
    await p.run();
    return look(p);
}

async function endings(): Promise<void> {
    let v = await ending(handedOffWire, 'handed-off');
    check('EA-V1 handed-off: the one success, said as checked, not rendered, with its design and program', v.phase === 'handed-off' && v.success === 'true'
        && v.status === 'Turn 1: Handed off: checked, not rendered' && /Nothing was built or rendered/.test(v.note ?? '')
        && v.design === 'checked, not rendered' && v.program === 'checked, not rendered' && v.calls.length === 3
        && v.cost === '3 model calls · $0.1380 reported' && /turn-1/.test(v.meta ?? ''), v);
    const shown = v.programText ?? '';
    check('EA-V1 handed-off: the program is its adapter nodes, each config shown parsed, under the contract and adapters it was checked by',
        /"adapterId": "ng\.buffer\.storage"/.test(shown) && /"layout": "instance14"/.test(shown) && /"effect": "Tonemap"/.test(shown)
        && !shown.includes('\\"layout\\"') && /agent-action\.v3, as this build/.test(v.meta ?? '') && /3c7775588fb8…, as this build/.test(v.meta ?? ''),
        { program: shown.slice(0, 600), meta: v.meta });

    v = await ending(askedWire, 'asked');
    check('EA-V1 asked: not a success; its question shown as written, with no promise of an answer', v.phase === 'asked' && v.success === 'false'
        && v.question === 'Blocks of stone, or of wood — and does the river run?' && /: no world$/.test(v.status ?? '')
        && /no way to answer it yet/.test(v.note ?? '') && v.design === null && v.program === null, v);

    v = await ending(declinedWire, 'declined');
    check('EA-V1 declined: not a success; the model\'s reason shown', v.phase === 'declined' && v.success === 'false'
        && v.reason === 'That names no place or thing to show — I can\'t build a world from it.', v);

    v = await ending(exhaustedRevisionsWire, 'exhausted-revisions');
    check('EA-V1 exhausted by revisions: not a success; the budget\'s reason once, three failing checks and the finding', v.phase === 'exhausted'
        && v.success === 'false' && v.reason === 'EA_TURN_BUDGET: the check still fails after 2 revisions'
        && v.calls.length === 3 && v.calls.every(c => c.includes('Check failed: 1 failing'))
        && v.findings.length === 3 && v.findings.every(f => f.startsWith('fail buffer-producer /program/nodes/0: blocks is read to draw')), v);

    v = await ending(exhaustedDeadlineWire, 'exhausted-deadline');
    check('EA-V1 exhausted by the deadline: the call\'s cost is unknown, not zero', v.phase === 'exhausted' && v.success === 'false'
        && v.calls[0].includes('no usage reported: cost unknown') && v.cost === '1 model call · $0.0000 reported · 1 call reported no usage: cost unknown', v);

    v = await ending(handedOffWire, 'handed-off, its revision');
    check('EA-V1 a hand-off after a revision keeps the failed check\'s finding in its call', v.findings.length === 1
        && v.calls[1].includes('Check failed: 1 failing') && v.calls[1].includes('fail buffer-producer') && v.calls[2].includes('Check passed'), v);

    v = await ending(contextLimitWire, 'context-limit');
    check('EA-V1 past the reading rounds: round 3 says it read nothing, and the turn still hands off', v.phase === 'handed-off'
        && v.calls.length === 4 && v.calls[2].includes('EA_CONTEXT_LIMIT: no reads left in this turn'), v);

    v = await ending(errorBudgetWire, 'error-budget');
    check('EA-V1 a later charge refused: failed, the code and where, the first call\'s reservation held', v.phase === 'failed' && v.success === 'false'
        && v.reason === 'budget in the stream: Live creation has reached its spending limit for now.'
        && v.calls[0].includes('? in / ? out · $0.1606 held, no usage came'), v);

    v = await ending(errorUpstreamWire, 'error-upstream');
    check('EA-V1 answers off the schema twice: failed, as upstream', v.phase === 'failed'
        && (v.reason ?? '').startsWith('upstream in the stream: the model\'s answer missed the action schema after a repair'), v);

    const envelope = JSON.parse(deniedJson) as { status: number; body: unknown };
    const p = panel(liveClient(() => new Response(JSON.stringify(envelope.body), { status: envelope.status, headers: { 'Content-Type': 'application/json' } })), 'denied');
    await p.run();
    v = look(p);
    check('EA-V1 a refused first charge: failed before any stream, with no call and no meta', v.phase === 'failed'
        && v.reason === 'budget HTTP 503: Live creation has reached its spending limit for now.' && v.calls.length === 0 && v.meta === null, v);

    const offline = panel(null, 'no backend');
    v = look(offline);
    check('EA-V1 a build with no gateway says so, and cannot run a turn', v.status === 'No backend' && /VITE_API_ORIGIN/.test(v.note ?? '')
        && [...offline.el.querySelectorAll('button')].every(b => b.disabled), v);
}

async function markup(): Promise<void> {
    const script = '<img src=x onerror="window.__xss=1"><b>bold</b> & <script>window.__xss=2</scr' + 'ipt>';
    const askedPanel = panel(liveClient(() => stream(edit(askedWire, 'question', 0, () => ({ text: script }))).response), 'markup: question');
    await askedPanel.run();
    const declinedPanel = panel(liveClient(() => stream(edit(declinedWire, 'done', 0, d => ({ ...d, reason: '<iframe src="javascript:window.__xss=3"></iframe> no' }))).response), 'markup: reason');
    await declinedPanel.run();
    let hand = edit(handedOffWire, 'design', 0, d => ({ design: { ...d.design, intent: '<svg onload="window.__xss=4"></svg> blocks' } }));
    hand = edit(hand, 'tools', 0, t => ({ ...t, results: [{ ...t.results[0], target: '<img src=y onerror="window.__xss=5">' }, t.results[1]] }));
    hand = edit(hand, 'check', 0, c => ({ ...c, findings: [{ ...c.findings[0], message: '<a href="javascript:window.__xss=6">fix</a>' }] }));
    hand = edit(hand, 'meta', 0, m => ({ ...m, model: '<b>muse</b>' }));
    const handPanel = panel(liveClient(() => stream(hand).response), 'markup: design, read, finding, model');
    await handPanel.run();
    await sleep(300); // time for any onerror or onload to have run, had markup been made
    const made = [askedPanel, declinedPanel, handPanel].flatMap(p => [...p.el.querySelectorAll('img, script, iframe, svg, a')]);
    const bold = [askedPanel, declinedPanel, handPanel].flatMap(p => [...p.el.querySelectorAll('b')]).filter(b => !/^Call \d+$/.test(b.textContent ?? ''));
    const xss = (window as unknown as { __xss?: unknown }).__xss;
    const v = { asked: look(askedPanel), declined: look(declinedPanel), hand: look(handPanel) };
    check('EA-V2 markup from the model or the backend is text: no element made, no script run', made.length === 0 && bold.length === 0 && xss === undefined
        && v.asked.question === script && v.declined.reason === '<iframe src="javascript:window.__xss=3"></iframe> no'
        // The design is shown as JSON, so the string appears JSON-encoded, its quotes escaped.
        && (handPanel.el.querySelector('.agent-design pre')?.textContent ?? '').includes(JSON.stringify('<svg onload="window.__xss=4"></svg> blocks'))
        && v.hand.calls[0].includes('<img src=y onerror="window.__xss=5">') && v.hand.findings[0].includes('<a href="javascript:window.__xss=6">fix</a>')
        && (v.hand.meta ?? '').includes('<b>muse</b>'), { made: made.length, bold: bold.length, xss, v });
}

async function elapsed(): Promise<void> {
    const p = panel(liveClient(() => stream(askedWire, 200).response), 'elapsed');
    const running = p.run();
    await sleep(150);
    const a = look(p).elapsed;
    await sleep(250);
    const b = look(p).elapsed;
    await running;
    const c = look(p).elapsed;
    await sleep(300);
    const d = look(p).elapsed;
    check('EA-V3 the elapsed time runs while the turn does, and stops when it ends', ms(a) > 0 && ms(b) > ms(a) && c === d && ms(c) >= 900 && look(p).phase === 'asked', { a, b, c, d });
}

async function superseding(): Promise<void> {
    // Through the real reader: the old turn's server keeps talking after the new turn began.
    const held = stream(handedOffWire, 0, 2);
    const p = panel(liveClient(() => held.response, () => stream(askedWire, 20).response), 'superseded (reader)');
    void p.run();
    await until(() => look(p).calls.length === 1);
    const second = p.run();
    held.release();
    await second;
    await sleep(200);
    let v = look(p);
    check('EA-V4 a superseding turn, through the reader: only the new turn shows, and the old one\'s body was cancelled', v.phase === 'asked'
        && (v.status ?? '').startsWith('Turn 2: ') && v.design === null && v.program === null && v.calls.length === 1 && held.cancelled(), v);

    // Through a client deaf to its cancel: the old turn says all it has, then settles as handed off, after the new one ended.
    const hand = await recorded(handedOffWire);
    const asked = await recorded(askedWire);
    const turns = [deaf(hand, 40), deaf(asked, 5)];
    let i = 0;
    const deafPanel = panel({ turn: (req, onEvent, signal) => turns[i++].turn(req, onEvent, signal) }, 'superseded (deaf client)');
    void deafPanel.run();
    await until(() => look(deafPanel).calls.length >= 1);
    await deafPanel.run();
    await sleep(800);
    v = look(deafPanel);
    check('EA-V4 a superseding turn, over a client deaf to its cancel: the old turn\'s late events and hand-off never show', v.phase === 'asked'
        && (v.status ?? '').startsWith('Turn 2: ') && v.design === null && v.calls.length === 1, v);
}

async function cancelling(): Promise<void> {
    const held = stream(handedOffWire, 0, 3);
    const p = panel(liveClient(() => held.response), 'cancelled (reader)');
    const running = p.run();
    await until(() => look(p).calls.length === 1 && (look(p).note ?? '').includes('answered'));
    cancelButton(p).click();
    const atCancel = look(p);
    held.release();
    await running;
    await sleep(300);
    let after = look(p);
    check('EA-V4 a cancel shows at once, its time stops, and nothing the turn sends after it shows', atCancel.phase === 'cancelled' && atCancel.success === 'false'
        && JSON.stringify(after) === JSON.stringify(atCancel) && held.cancelled() && cancelButton(p).disabled, { atCancel, after });

    const hand = await recorded(handedOffWire);
    const deafPanel = panel(deaf(hand, 30), 'cancelled (deaf client)');
    void deafPanel.run();
    await until(() => look(deafPanel).calls.length >= 1);
    cancelButton(deafPanel).click();
    const shown = look(deafPanel);
    await sleep(700);
    after = look(deafPanel);
    check('EA-V4 a cancel over a client deaf to it: the events and the hand-off it sends after are never shown', shown.phase === 'cancelled'
        && JSON.stringify(after) === JSON.stringify(shown) && after.design === null, { shown, after });
}

// ---- EA4.5: a hand-off's candidate, over the backend's module recordings -------------------------------------------

/** A recorded module answer for `request`: its job identity the request's, as the backend echoes every call's. */
function echoed(text: string, request: any): string {
    return lf(text).replace(/^event:meta\ndata:(.*)$/m, (_, data: string) =>
        `event:meta\ndata:${JSON.stringify({ ...JSON.parse(data), turnId: request.turnId, jobId: request.jobId, purpose: request.purpose, subject: request.subject })}`);
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
/** The recorded answer's text: its deltas, joined. */
const RECORDED_BODY = [...lf(moduleAuthorWire).matchAll(/^event:delta\ndata:(.*)$/gm)].map(m => (JSON.parse(m[1]) as { text: string }).text).join('');

/** A module stream of the harness's own for `request`: the recording's meta (echoed) and usage, `answer`, its own done. */
async function answered(answer: string, request: any): Promise<string> {
    const recorded = lf(moduleAuthorWire);
    const meta = JSON.parse(echoed(recorded, request).match(/^event:meta\ndata:(.*)$/m)![1]);
    const usage = JSON.parse(recorded.match(/^event:usage\ndata:(.*)$/m)![1]);
    const sha = hex(await crypto.subtle.digest('SHA-256', enc.encode(answer)));
    const half = Math.floor(answer.length / 2);
    return [['meta', meta], ['delta', { text: answer.slice(0, half) }], ['delta', { text: answer.slice(half) }], ['usage', usage],
        ['done', { status: 'ok', answerSha256: sha, answerChars: answer.length }]].map(([e, d]) => `event:${e}\ndata:${JSON.stringify(d)}\n\n`).join('');
}

/** The real module client and transport, over a fetch that answers each request (its body parsed) by `answer`. */
function moduleClient(answer: (request: any) => Response | Promise<Response>): ModuleClient {
    const fetchImpl = (async (_url: string, init: RequestInit) => answer(JSON.parse(String(init.body)))) as unknown as typeof fetch;
    return createModuleClient(createApi(CONFIG, IDENTITY, fetchImpl));
}

function candidatePanel(client: AgentClient, modules: ModuleClient, label: string, saved: { name: string; text: string }[] = [], revise?: Reviser): AgentPanel {
    const p = new AgentPanel(client, () => REQUEST, { candidate: { modules, revise, attemptId: () => 'attempt-1', save: (name, text) => saved.push({ name, text }) } });
    p.el.dataset.case = label;
    panels.append(p.el);
    return p;
}

/** What a panel's candidate shows, read from its DOM as a person would see it. */
function lookCandidate(p: AgentPanel) {
    const c = p.el.querySelector<HTMLElement>('.cand')!;
    const text = (selector: string) => {
        const e = c.querySelector<HTMLElement>(selector);
        return e && !e.hidden ? e.textContent : null;
    };
    return {
        phase: c.dataset.phase,
        status: text('.cand-phase'),
        id: text('.cand-id') || null,
        note: text('.cand-note'),
        reason: text('.cand-reason'),
        budget: text('.cand-budget'),
        modules: [...c.querySelectorAll<HTMLElement>('.cand-module')].map(m => ({
            module: m.dataset.module, phase: m.dataset.phase, head: m.querySelector('.cand-module-head')?.textContent ?? '',
            verdicts: [...m.querySelectorAll('.cand-verdict')].map(v => v.textContent ?? ''), body: m.querySelector('.cand-body pre')?.textContent ?? null,
        })),
        turns: [...c.querySelectorAll<HTMLElement>('.cand-turn')].map(t => ({
            role: t.dataset.role, head: t.querySelector('.cand-turn-head')?.textContent ?? '', calls: [...t.querySelectorAll('.cand-turn-call')].map(x => x.textContent ?? ''),
        })),
        jobs: [...c.querySelectorAll('.cand-job')].map(j => j.textContent ?? ''),
        evidence: text('.cand-evidence summary'),
        enabled: Object.fromEntries([...c.querySelectorAll('button')].map(b => [b.textContent ?? '', !b.disabled])),
    };
}

const candidateButton = (p: AgentPanel, label: string) => [...p.el.querySelectorAll<HTMLButtonElement>('.cand button')].find(b => (b.textContent ?? '').startsWith(label))!;
const settled = (p: AgentPanel) => !['resolving', 'authoring', 'checking', 'correcting'].includes(lookCandidate(p).phase ?? '');

async function candidates(): Promise<void> {
    // EA-V7: the recorded hand-off, its module written by the recorded answer, checked, sealed; then the bundle.
    const saved: { name: string; text: string }[] = [];
    const requests: any[] = [];
    const p = candidatePanel(liveClient(() => stream(handedOffWire).response),
        moduleClient(r => { requests.push(r); return stream(echoed(moduleAuthorWire, r), 10).response; }), 'candidate', saved);
    const before = lookCandidate(p);
    await p.run();
    const ready = lookCandidate(p);
    candidateButton(p, 'Write the modules').click();
    await until(() => settled(p), 5_000);
    let v = lookCandidate(p);
    check('EA-V7 a hand-off\'s candidate: none before the hand-off, Write the modules after it', before.phase === 'idle' && before.enabled['Write the modules'] === false
        && before.note === 'A turn that hands off comes first.' && ready.enabled['Write the modules'] === true && ready.status === 'No candidate yet', { before, ready });
    const [place] = v.modules;
    check('EA-V7 static-verified over the recorded module answer: its body as checked, its verdict, Q_C, the call and its charge, id(C)',
        v.phase === 'static-verified' && v.status === 'Static-verified: checked, not compiled' && /^id\(C\) [0-9a-f]{12}…$/.test(v.id ?? '')
        && v.modules.length === 1 && place.module === 'place' && place.phase === 'passed' && /^place · compute · passed · 1 call · body [0-9a-f]{12}…$/.test(place.head)
        && place.body === RECORDED_BODY && place.verdicts.length === 1 && place.verdicts[0].startsWith('lint pass (host, current)')
        && v.budget === 'Q_C: 4 of 34 calls · authors 1/12 · repairs 0/10 · revisions 0/3' && v.jobs.length === 1
        && /^job-1 place author: ok · \$0\.01\d\d · [^·]+ · module\.author\.v3$/.test(v.jobs[0])
        && v.evidence === 'Evidence 5 records' && requests.length === 1 && requests[0].purpose === 'author', v);
    candidateButton(p, 'Download bundle').click();
    const bundle = saved.length === 1 ? JSON.parse(saved[0].text) : null;
    check('EA-V7 Download bundle saves the candidate: its id, its body, its evidence, each call\'s charge, and no credential', saved.length === 1
        && saved[0].name === 'wexy-candidate-attempt-1.json' && bundle?.format === 'wexy-candidate-bundle.v3' && (v.id ?? '').includes(bundle.candidate.slice(0, 12))
        && bundle.modules[0].body === RECORDED_BODY && bundle.evidence.length === 5 && bundle.calls.jobs[0].charge === 'known'
        && !/Bearer|dev\.anonymous/.test(saved[0]?.text ?? ''), { name: saved[0]?.name, candidate: bundle?.candidate, evidence: bundle?.evidence?.length });

    // A turn holds its design and program before it ends (a program the browser refuses, or a cancel, leaves them there):
    // only a hand-off offers its modules.
    const late = stream(handedOffWire, 0, 12);
    const unfinished = candidatePanel(liveClient(() => late.response), moduleClient(() => { throw new Error('no module call is expected'); }),
        'candidate: a turn not handed off');
    const turning = unfinished.run();
    await until(() => look(unfinished).program !== null);
    const whileRunning = lookCandidate(unfinished);
    cancelButton(unfinished).click();
    await turning;
    const once = lookCandidate(unfinished);
    check('EA-V7 a turn not handed off offers no modules: not while it runs with its design and program, nor once it is cancelled',
        look(unfinished).phase === 'cancelled' && look(unfinished).program !== null && whileRunning.enabled['Write the modules'] === false
        && once.enabled['Write the modules'] === false && once.note === 'A turn that hands off comes first.' && once.phase === 'idle', { whileRunning, once });

    // EA-V8: an answer the server judged unusable is called again within Q_C; a refusal before the stream ends it.
    let calls = 0;
    const retry = candidatePanel(liveClient(() => stream(handedOffWire).response),
        moduleClient(r => stream(echoed(calls++ === 0 ? moduleEmptyWire : moduleAuthorWire, r)).response), 'candidate: unusable then written');
    await retry.run();
    candidateButton(retry, 'Write the modules').click();
    await until(() => settled(retry), 5_000);
    v = lookCandidate(retry);
    check('EA-V8 an unusable answer is called again within Q_C, and the second is checked and sealed', v.phase === 'static-verified'
        && v.jobs.length === 2 && v.jobs[0].includes('author: unusable') && v.jobs[0].includes('upstream: The model wrote nothing for this part.')
        && v.jobs[1].includes('author: ok') && v.budget === 'Q_C: 5 of 34 calls · authors 2/12 · repairs 0/10 · revisions 0/3', v);
    const refused = candidatePanel(liveClient(() => stream(handedOffWire).response),
        moduleClient(() => new Response(moduleDeniedJson, { status: 503, headers: { 'Content-Type': 'application/json' } })), 'candidate: refused');
    await refused.run();
    candidateButton(refused, 'Write the modules').click();
    await until(() => settled(refused), 5_000);
    v = lookCandidate(refused);
    check('EA-V8 a refusal before the stream: failed, the creator\'s sentence and the developer\'s words, the call counted unknown', v.phase === 'failed'
        && v.status === 'Failed: no candidate' && v.note === COPY.failures.budget && v.reason === 'host budget: Live creation has reached its spending limit for now.'
        && v.jobs.length === 1 && v.jobs[0].includes('author: refused · charge unknown') && v.budget === 'Q_C: 4 of 34 calls, 1 unknown · authors 1/12 · repairs 0/10 · revisions 0/3'
        && v.enabled['Write the modules again'] === true && v.id === null, v);

    // EA-V9: markup in a body (a comment, which the lint passes) is text.
    const marked = `// <img src=x onerror="window.__xss=7"> <script>window.__xss=8</scr${'ipt'}>\n${RECORDED_BODY}`;
    const markupPanel = candidatePanel(liveClient(() => stream(handedOffWire).response),
        moduleClient(async r => stream(await answered(marked, r)).response), 'candidate: markup in a body');
    await markupPanel.run();
    candidateButton(markupPanel, 'Write the modules').click();
    await until(() => settled(markupPanel), 5_000);
    await sleep(300);
    v = lookCandidate(markupPanel);
    const made = [...markupPanel.el.querySelectorAll('.cand img, .cand script')];
    check('EA-V9 markup in a module\'s body is text: no element made, no script run', v.phase === 'static-verified' && v.modules[0].body === marked
        && made.length === 0 && (window as unknown as { __xss?: unknown }).__xss === undefined, { phase: v.phase, made: made.length });

    // EA-V10: a new turn retires a running candidate; a cancel stops one. Their held calls are cancelled, and nothing they
    // say after shows.
    const held: Stream[] = [];
    const hold = moduleClient(r => { const s = stream(echoed(moduleAuthorWire, r), 0, 1); held.push(s); return s.response; });
    const retired = candidatePanel(liveClient(() => stream(handedOffWire).response, () => stream(askedWire).response), hold, 'candidate: retired by a new turn');
    await retired.run();
    candidateButton(retired, 'Write the modules').click();
    await until(() => held.length === 1 && lookCandidate(retired).phase === 'authoring');
    await retired.run();
    const atNewTurn = lookCandidate(retired);
    held[0].release();
    await sleep(300);
    const afterNewTurn = lookCandidate(retired);
    check('EA-V10 a new turn retires the running candidate: shown as none, its call cancelled, nothing after shows', atNewTurn.phase === 'idle'
        && atNewTurn.modules.length === 0 && atNewTurn.enabled['Write the modules'] === false && held[0].cancelled()
        && JSON.stringify(afterNewTurn) === JSON.stringify(atNewTurn), { atNewTurn, afterNewTurn });
    const stopped = candidatePanel(liveClient(() => stream(handedOffWire).response), hold, 'candidate: cancelled');
    await stopped.run();
    candidateButton(stopped, 'Write the modules').click();
    await until(() => held.length === 2 && lookCandidate(stopped).phase === 'authoring');
    // While it runs, a second click must not start another candidate's calls: only Cancel is offered.
    const running = lookCandidate(stopped);
    candidateButton(stopped, 'Cancel').click();
    const atCancel = lookCandidate(stopped);
    held[1].release();
    await sleep(300);
    const afterCancel = lookCandidate(stopped);
    check('EA-V10 while a candidate runs only Cancel is offered; a cancel shows at once, its call is cancelled and nothing after shows',
        running.enabled['Write the modules'] === false && running.enabled.Cancel === true && atCancel.phase === 'cancelled' && atCancel.status === 'Cancelled'
        && held[1].cancelled() && JSON.stringify(afterCancel) === JSON.stringify(atCancel) && atCancel.enabled.Cancel === false, { running, atCancel, afterCancel });
    // The panel disposed (the studio done with it): a running candidate is cancelled with it, its call too.
    const disposed = candidatePanel(liveClient(() => stream(handedOffWire).response), hold, 'candidate: disposed');
    await disposed.run();
    candidateButton(disposed, 'Write the modules').click();
    await until(() => held.length === 3 && lookCandidate(disposed).phase === 'authoring');
    disposed.dispose();
    const atDispose = lookCandidate(disposed);
    held[2].release();
    await sleep(300);
    const afterDispose = lookCandidate(disposed);
    check('EA-V10 dispose cancels a running candidate: its call is cancelled and nothing after shows', atDispose.phase === 'cancelled' && held[2].cancelled()
        && JSON.stringify(afterDispose) === JSON.stringify(atDispose), { atDispose, afterDispose });

    // EA-V11 (the EA4.5 review): the recorded hand-off with its place stage's entry named `step`, which the browser
    // refuses; the program revised over the recorded wire (its turn hands the recorded program back), and its module
    // written by the recorded answer. The revision's turn shows beside the hand-off's, and the bundle holds both.
    const stepped = edit(handedOffWire, 'program', 0, (d: any) => ({
        program: { nodes: d.program.nodes.map((n: any) => (n.id === 'place' ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), entry: 'step' }) } : n)) },
    }));
    const revisedSaved: { name: string; text: string }[] = [];
    const revising = candidatePanel(liveClient(() => stream(stepped).response), moduleClient(r => stream(echoed(moduleAuthorWire, r)).response),
        'candidate: refused, revised, written', revisedSaved, createReviser(liveClient(() => stream(revisedWire).response)));
    await revising.run();
    candidateButton(revising, 'Write the modules').click();
    await until(() => settled(revising), 5_000);
    const r = lookCandidate(revising);
    check('EA-V11 a program the browser refuses is revised: the revision\'s turn shows beside the hand-off\'s, each call with its charge, model and template',
        r.phase === 'static-verified' && r.budget === 'Q_C: 5 of 34 calls · authors 1/12 · repairs 0/10 · revisions 1/3' && r.turns.length === 2
        && r.turns[0].role === 'hand-off' && r.turns[0].head === 'turn-1 hand-off: handed-off · 3 calls · $0.1380 · muse-spark-1.3 · agent.v6'
        && r.turns[0].calls.length === 3 && r.turns[1].role === 'revision'
        && r.turns[1].head === 'turn-1 program revision: handed-off · 1 call · $0.0460 · muse-spark-1.3 · agent.v6'
        && JSON.stringify(r.turns[1].calls) === JSON.stringify(['1 revise: $0.0460 · gen-1']) && r.jobs.length === 1 && r.jobs[0].includes('place author: ok'), r);
    candidateButton(revising, 'Download bundle').click();
    const revisedBundle = revisedSaved.length === 1 ? JSON.parse(revisedSaved[0].text) : null;
    const revision = revisedBundle?.calls?.turns?.[1];
    const records = revisedBundle ? revisedBundle.calls.turns.reduce((n: number, t: { calls: unknown[] }) => n + t.calls.length, 0) + revisedBundle.calls.jobs.length : -1;
    check('EA-V11 the downloaded bundle holds the revision\'s turn: its call, charge, model and template; each call Q_C settled has its record',
        revisedBundle?.format === 'wexy-candidate-bundle.v3' && revision?.role === 'revision' && revision.status === 'handed-off' && revision.model === 'muse-spark-1.3'
        && revision.promptVersion === 'agent.v6' && revision.charge === 'known' && revision.calls.length === 1 && revision.calls[0].purpose === 'revise'
        && revision.calls[0].costMicroUsd === 46_000 && revisedBundle.versions.templates.includes('agent.v6') && records === revisedBundle.calls.budget.calls.settled,
        { turns: revisedBundle?.calls?.turns, templates: revisedBundle?.versions?.templates, records });
}

// ---- EA5.3: Run on this GPU, over a stage the harness stands in -----------------------------------------------------

/** A compiler that labels its verdicts the device's and passes every body: what the real gate refuses by provenance. */
const SCRIPTED_DEVICE: ModuleCompiler = { producedBy: 'device', gpu: 'a scripted stand-in', compile: async () => [] };

async function running(): Promise<void> {
    const runButton = (p: AgentPanel) => candidateButton(p, 'Run') ?? candidateButton(p, 'Running');
    const runLine = (p: AgentPanel) => p.el.querySelector<HTMLElement>('.cand-run')!;
    const runState = (p: AgentPanel) => p.el.querySelector<HTMLElement>('.cand')!.dataset.run;

    // No stage, no Run: the studio hands the panel one only behind ?agent=1, once its device compiler exists.
    const none = candidatePanel(liveClient(() => stream(handedOffWire).response), moduleClient(r => stream(echoed(moduleAuthorWire, r)).response), 'run: no stage');
    await none.run();
    check('EA-V12 without the studio\'s stage, Run is not offered', runButton(none).hidden && runLine(none).hidden && runState(none) === 'idle');

    let ready = false;
    const calls: { candidate: string; compiled: number; producedBy: string[] }[] = [];
    let answer: (s: RunSummary) => void = () => {};
    const control: RunControl = {
        blocked: () => (ready ? null : 'The stage is starting: its device compiler loads first.'),
        go: (snapshot, compiled) => {
            calls.push({ candidate: snapshot.id, compiled: compiled.length, producedBy: compiled.map(c => c.producedBy) });
            return new Promise(resolve => { answer = resolve; });
        },
    };
    const p = new AgentPanel(liveClient(() => stream(handedOffWire).response), () => REQUEST, {
        candidate: { modules: moduleClient(r => stream(echoed(moduleAuthorWire, r)).response), attemptId: () => 'attempt-1', compiler: () => SCRIPTED_DEVICE, run: control },
    });
    p.el.dataset.case = 'run: Run on this GPU';
    panels.append(p.el);
    const panel = p.candidate as CandidatePanel;
    await p.run();
    const unsealed = { disabled: runButton(p).disabled, line: runLine(p).textContent, title: runButton(p).title };
    const epoch = panel.epoch;
    candidateButton(p, 'Write the modules').click();
    await until(() => settled(p), 5_000);
    const sealedLook = lookCandidate(p);
    const starting = { disabled: runButton(p).disabled, line: runLine(p).textContent };
    check('EA-V12 Run waits for a sealed candidate with this device\'s verdicts, and for the stage', !runButton(p).hidden && unsealed.disabled
        && unsealed.line === 'Run needs a sealed candidate: Write the modules first.' && unsealed.title === unsealed.line
        && sealedLook.phase === 'static-verified' && sealedLook.status === 'Static-verified: compiled on this device'
        && starting.disabled && starting.line === 'The stage is starting: its device compiler loads first.' && panel.epoch === epoch + 1, { unsealed, starting, sealedLook, epoch: panel.epoch });
    ready = true;
    panel.refresh();
    const offered = { disabled: runButton(p).disabled, line: runLine(p).textContent };
    runButton(p).click();
    await until(() => runState(p) === 'running');
    const during = { label: runButton(p).textContent, disabled: runButton(p).disabled, write: candidateButton(p, 'Write the modules again').disabled, line: runLine(p).textContent };
    check('EA-V12 a press hands the stage the sealed candidate and its verdict on every body, and shows the Run while it lasts', !offered.disabled
        && offered.line?.startsWith('Ready: Run on this GPU puts it on the stage') && calls.length === 1 && (sealedLook.id ?? '').includes(calls[0].candidate.slice(0, 12))
        // Write stays offered: a newer candidate supersedes the Run (its turn moves), the way to stop one.
        && calls[0].compiled === 1 && calls[0].producedBy.join() === 'device' && during.label === 'Running…' && during.disabled && !during.write
        && during.line?.startsWith('Running on this GPU: the gate, the build, the probe, the first frame offscreen.'), { offered, during, calls });
    answer({ status: 'refused', reason: 'EA_ELIGIBILITY ng.buffer.storage@1 (node blocks) has no coverage for amd/gcn-5 chrome/156 (ea5-exec.v1); static only', numbers: '' });
    await until(() => runState(p) === 'refused');
    const refused = runLine(p).textContent;
    runButton(p).click();
    await until(() => runState(p) === 'running');
    answer({ status: 'failed', reason: 'EA_SANITY black: <img src=x onerror="window.__ran__=1"> declares at least 2.0', numbers: 'probe: init 3.0 ms' });
    await until(() => runState(p) === 'failed');
    const marked = { line: runLine(p).textContent, images: p.el.querySelectorAll('.cand-run img').length };
    runButton(p).click();
    await until(() => runState(p) === 'running');
    answer({ status: 'installed', reason: null, numbers: 'probe: init 3.0 ms, step 0.0 ms, frame 2.1 ms · worst submission 3.0 ms of 250 ms' });
    await until(() => runState(p) === 'installed');
    const installed = { line: runLine(p).textContent, enabled: !runButton(p).disabled };
    check('EA-V12 a refusal shows in the developer\'s words, markup in it as text; an install shows the world on the stage with its numbers',
        refused === 'refused: EA_ELIGIBILITY ng.buffer.storage@1 (node blocks) has no coverage for amd/gcn-5 chrome/156 (ea5-exec.v1); static only'
        && marked.line === 'failed: EA_SANITY black: <img src=x onerror="window.__ran__=1"> declares at least 2.0 · probe: init 3.0 ms' && marked.images === 0
        && !(window as unknown as { __ran__?: number }).__ran__ && calls.length === 3
        && /^On the stage: id\(C\) [0-9a-f]{12}… · probe: init 3\.0 ms, step 0\.0 ms, frame 2\.1 ms · worst submission 3\.0 ms of 250 ms$/.test(installed.line ?? '')
        && installed.enabled, { refused, marked, installed });
}

// ---- EA6.2: the review of the stage, over a stage and a capture the harness stands in (no GPU) -----------------------

/** The castle's boxes as written (bounds.test.mjs), its hill named with markup: a node id is the model's text. */
const MARKED = '<img src=x onerror="window.__ran__=2">';
const CASTLE = { batches: [
    { node: MARKED, box: { min: [-234, -54, -234] as [number, number, number], max: [234, 50, 234] as [number, number, number] }, instances: 1, sampled: 1 },
    { node: 'batchtower', box: { min: [-7.9, -2.9, -7.9] as [number, number, number], max: [7.9, 13.9, 7.9] as [number, number, number] }, instances: 6, sampled: 6 },
    { node: 'batchroof', box: { min: [-8, 6.3, -8] as [number, number, number], max: [8, 14.7, 8] as [number, number, number] }, instances: 6, sampled: 6 },
] };
const FRAMED = { target: [0, 5.5, 0] as [number, number, number], distance: 23, azimuth: 0.6, polar: 1.15, fov: 45 };

/** A captured pair as the studio's capture gives it: a scene's pixels, a JPEG-shaped body, its hash. */
async function capturedPair(shade: number) {
    const rgba = new Uint8Array(768 * 432 * 4);
    for (let y = 0; y < 432; y++) for (let x = 0; x < 768; x++) rgba.set(x > 256 && x < 512 && y > 100 ? [180, 120 + shade, 60, 255] : y > 300 ? [70, 70, 70, 255] : [40, 60, 120, 255], (y * 768 + x) * 4);
    const frame = async (view: 'framed' | 'side', i: number) => {
        const jpeg = new Uint8Array(2048);
        jpeg.set([0xff, 0xd8, 0xff, i, shade]);
        return {
            view, camera: view === 'framed' ? FRAMED : { ...FRAMED, azimuth: FRAMED.azimuth + Math.PI / 2, polar: Math.PI / 2 }, describes: `The world, the ${view} view.`,
            renderOrdinal: i, sourceWidth: 1280, sourceHeight: 720, width: 768, height: 432, content: { x: 0, y: 0, width: 768, height: 432 }, rgba, jpeg, quality: 0.85,
            sha256: hex(await crypto.subtle.digest('SHA-256', jpeg)),
        };
    };
    return [await frame('framed', 1), await frame('side', 2)];
}

/**
 * EA-VR11a (EA6.2, no GPU): the review panel over a real candidate session (the recorded hand-off, its module written by
 * the recorded answer) and a stand-in stage and capture: two frames named by their view, size and hash; the host's
 * findings as labelled checkboxes, model-written names in them as text; "Improve it" offered only with words or a finding,
 * one revision citing exactly what was kept; the improved candidate awaiting Run; "Looks right" on the next review; a busy
 * stage said in both voices; the panel inside 320 px with no horizontal overflow.
 */
async function reviewing(): Promise<void> {
    // Loaded only now: the review reads the camera's geometry (src/runtime/camera-path.ts), which EA-V5 keeps off the turn.
    const [{ ReviewPanel }, { StageReviews, memoryConsent }] = await Promise.all([import('../src/shell/studio/review-view'), import('../src/loop/review')]);
    // A model's review (EA-VR11b): the real client and transport; fetch answers with the backend's recorded terms, and its
    // recorded verdict echoing what was sent, a model-written sentence carrying markup.
    const reviewCalls: { method: string; url: string; body: any }[] = [];
    const reviewFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        reviewCalls.push({ method, url: String(input), body });
        if (method === 'GET') return new Response(reviewTermsJson, { status: 200, headers: { 'Content-Type': 'application/json' } });
        const answer = JSON.parse(reviewFailJson);
        answer.reviewId = body.reviewId;
        answer.subject = body.subject;
        answer.frames = body.frames.map((f: { id: string; sha256: string }) => ({ id: f.id, sha256: f.sha256 }));
        answer.verdict.issues[0].modules = body.modules.slice(0, 1);
        answer.verdict.issues[0].sentence = `The castle floats ${MARKED} above the hill in the side view.`;
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const reviewer = createReviewClient(createApi(CONFIG, IDENTITY, reviewFetch));
    const revisions: Parameters<Reviser>[0][] = [];
    // The castle's own kind of correction: the program's sizes halved, no module written again.
    const revise: Reviser = async request => {
        revisions.push(structuredClone(request));
        const nodes = request.program.nodes.map(n => {
            if (n.adapterId !== 'ng.geometry.primitive') return n;
            const c = JSON.parse(n.config) as { size?: number };
            return { ...n, config: JSON.stringify({ ...c, size: (c.size ?? 1) / 2 }) };
        });
        return { status: 'handed-off', turnId: 'turn-review', design: request.design, program: { nodes }, repairs: [], calls: 1 };
    };
    const p = candidatePanel(liveClient(() => stream(handedOffWire).response), moduleClient(r => stream(echoed(moduleAuthorWire, r)).response), 'review', [], revise);
    await p.run();
    candidateButton(p, 'Write the modules').click();
    await until(() => settled(p), 5_000);
    const session = (p.candidate as CandidatePanel).session!;
    const first = session.snapshot!;
    let world: StageWorld | null = null;
    let busy: string | null = null;
    let view: InstanceType<typeof ReviewPanel> | null = null;
    const reviews = new StageReviews({
        stage: () => world,
        capture: async () => ({
            outcome: { ok: true, tick: 240, seconds: 4, frames: await capturedPair(world?.epoch ?? 0), missing: [], temporal: [], bounds: CASTLE, boundsError: null, policy: 'ea6-capture.v1' },
            missing: [], framed: FRAMED, aspect: 16 / 9, prepared: null,
        }),
        session: () => session,
        generation: () => 1,
        busy: () => busy,
        reviewer: () => reviewer,
        consent: memoryConsent(),
        onChange: () => view?.render(),
        onDrop: ids => view?.dropped(ids),
    });
    view = new ReviewPanel(reviews);
    const narrow = document.createElement('div');
    narrow.style.width = '320px';
    narrow.dataset.case = 'review: 320 px';
    narrow.append(view.el);
    panels.append(narrow);
    const el = view.el;
    const q = <T extends Element>(s: string) => el.querySelector<T>(s);
    const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.textContent ?? '').startsWith(label))!;
    const empty = { status: q('.rev-status')!.textContent, verdict: q<HTMLElement>('.rev-verdict')!.hidden, frames: el.querySelectorAll('.rev-frame').length };

    world = { epoch: 1, candidate: first.id, graph: first.x.hash, gpu: 'a stand-in GPU', probe: { warnings: [], width: 1920, height: 1080 }, unboxed: [] };
    reviews.installed(world);
    await until(() => reviews.latest?.status === 'ready');
    const figures = [...el.querySelectorAll<HTMLElement>('.rev-frame')].map(f => ({ alt: f.querySelector('img')?.alt, src: f.querySelector('img')?.src.startsWith('blob:'), caption: f.querySelector('figcaption')?.textContent }));
    const boxes = [...el.querySelectorAll<HTMLInputElement>('.rev-findings input[type=checkbox]')];
    const findings = boxes.map(b => ({ checked: b.checked, tab: b.tabIndex, label: b.closest('label')?.textContent ?? '' }));
    const words = q<HTMLTextAreaElement>('.rev-words')!;
    check('EA-VR11a no world, no review: the panel says so and offers nothing; once one is on the stage, its two frames, each named by its view, tick, size and hash',
        empty.status?.startsWith('No agent world on the stage yet') === true && empty.verdict && empty.frames === 0
        && figures.length === 2 && figures.every(f => f.src && /Tick 240, 4\.00 s\.$/.test(f.alt ?? '') && /1280×720 fitted into 768×432 · JPEG 0\.85 · 2\.0 kB · sha256 [0-9a-f]{12}…$/.test(f.caption ?? ''))
        && figures[0].caption?.startsWith('Framed view') === true && figures[1].caption?.startsWith('Side view, level') === true
        && (q('.rev-status')!.textContent ?? '').includes(`in attempt ${session.state!.attempt}`), { empty, figures, status: q('.rev-status')?.textContent });
    check('EA-VR11a the host\'s findings are labelled, keyboard-reachable checkboxes, checked at first; a model-written name in one is text, never markup',
        findings.length === 2 && findings.every(f => f.checked && f.tab === 0) && findings[0].label.includes(`EA_SCALE ${MARKED} spans 468 × 104 × 468 units`)
        && findings[1].label.startsWith(' EA_FRAME the framed view\'s camera is inside') && !el.querySelector('.rev-findings img') && !(window as unknown as { __ran__?: number }).__ran__
        && q<HTMLLabelElement>(`label[for="${words.id}"]`) !== null && !button('Improve it').disabled && !button('Looks right').disabled, { findings });

    // Nothing kept and nothing said: no improvement; a quick word: one, citing exactly that.
    for (const b of boxes) b.click();
    const none = { disabled: button('Improve it').disabled, why: q('.rev-why')!.textContent };
    button('floating').click();
    const said = { value: words.value, disabled: button('Improve it').disabled, count: q('.rev-count')!.textContent };
    button('Improve it').click();
    await until(() => reviews.latest?.status === 'awaiting-run', 5_000);
    const improved = reviews.latest!;
    check('EA-VR11a "Improve it" waits for words or a finding; then one program revision citing exactly them, and the improved candidate awaits Run',
        none.disabled && none.why === 'Say what should change, or keep a finding checked.' && said.value === 'floating' && !said.disabled && said.count === '8/400'
        // The creator's words, then the host's own line on the notes the attempt can still answer (the EA6.3 review).
        && revisions.length === 1 && revisions[0].findings.length === 2 && revisions[0].findings[0].code === 'creator' && revisions[0].findings[0].message === 'floating'
        && revisions[0].findings[1].code === 'EA_REPAIR_BUDGET'
        && improved.improvedTo === session.snapshot?.id && improved.improvedTo !== first.id && q('.cand-phase')!.textContent === 'Improved: awaiting Run'
        && (q('.rev-status')!.textContent ?? '').includes('Run on this GPU puts it on the stage') && words.value === '',
        { none, said, revisions: revisions.map(r => r.findings), status: q('.rev-status')?.textContent, budget: q('.cand-budget')?.textContent });

    // Run puts it on the stage: its review, and the creator's "Looks right", which spends nothing.
    const spent = JSON.stringify(session.state!.budget);
    world = { ...world, epoch: 2, candidate: improved.improvedTo!, graph: session.snapshot!.x.hash };
    reviews.installed(world);
    await until(() => reviews.latest?.status === 'ready' && reviews.latest.epoch === 2);
    button('Looks right').click();
    const approved = { phase: q('.cand-phase')!.textContent, verdict: q<HTMLElement>('.rev-verdict')!.hidden };
    check('EA-VR11a "Looks right" on the improved world\'s review: the creator\'s pass recorded in its attempt, nothing spent',
        approved.phase === 'Looks right' && JSON.stringify(session.state!.budget) === spent
        && session.state!.evidence.some(e => e.phase === 'visual' && e.verdict === 'pass' && e.producedBy === 'creator' && e.subject.candidate === improved.improvedTo)
        && (q('.cand-budget')!.textContent ?? '').startsWith('visual rounds 1 of 2 · calls'), { approved, budget: q('.cand-budget')?.textContent });

    // EA-VR11b, a model's review of the improved world: its terms read once its review reached the session; the
    // disclosure before anything is sent, and nothing sent until the creator allows it.
    await until(() => reviews.terms !== null);
    view.render();
    const asked = {
        disclosure: q<HTMLElement>('.rev-disclosure')!.hidden ? null : q('.rev-disclosure')!.textContent,
        links: [...el.querySelectorAll<HTMLAnchorElement>('.rev-disclosure a')].map(a => [a.href, a.rel, a.target]),
        agree: button('Allow AI review')?.hidden === false, review: button('Review with AI')?.hidden, posts: reviewCalls.filter(c => c.method === 'POST').length,
        width: narrow.scrollWidth,
    };
    check('EA-VR11b before anything is sent: the provider, what goes, what its policy says, its links, and the creator\'s go; within 320 px',
        asked.disclosure !== null && asked.disclosure.includes('to Meta\'s model muse-spark-1.3') && asked.disclosure.includes('does not state for how long')
        && asked.links.length === 3 && asked.links.every(([href, rel, target]) => href.startsWith('https://') && rel === 'noopener noreferrer' && target === '_blank')
        && asked.agree && asked.review === true && asked.posts === 0 && asked.width <= 320, asked);
    button('Allow AI review').click();
    const consented = { review: button('Review with AI')?.hidden, disabled: button('Review with AI')?.disabled, withdraw: button('Withdraw consent')?.hidden };
    // The host's findings unticked: none is sent, and none goes into the round below.
    for (const b of el.querySelectorAll<HTMLInputElement>('.rev-findings-box:not([hidden]) .rev-findings:not(.rev-ai-issues) input[type=checkbox]')) if (b.checked) b.click();
    const spentBefore = session.state!.budget.calls.settled;
    button('Review with AI').click();
    await until(() => reviews.latest?.model !== null && !reviews.reviewing, 5_000);
    view.render();
    const post = reviewCalls.find(c => c.method === 'POST')!;
    const issues = [...el.querySelectorAll<HTMLInputElement>('.rev-ai-issues input[type=checkbox]')].map(b => ({ checked: b.checked, tab: b.tabIndex, label: b.closest('label')?.textContent ?? '' }));
    check('EA-VR11b "Review with AI": one call with the nine fields, the kept JPEGs and no host finding; the model\'s issues as checkboxes, its markup as text',
        consented.review === false && consented.disabled === false && consented.withdraw === false
        && reviewCalls.filter(c => c.method === 'POST').length === 1 && post.url.endsWith('/v1/agent/review')
        && Object.keys(post.body).sort().join() === 'consent,design,frames,hostFindings,modules,request,reviewId,subject,turnId'
        && post.body.frames.length === 2 && post.body.frames.every((f: { jpeg: string }) => atob(f.jpeg).length === 2048) && post.body.hostFindings.length === 0
        && post.body.consent.policyVersion === 'meta-standard.2026-11-03' && post.body.subject.candidate === reviews.latest!.candidate
        && issues.length === 2 && issues.every(i => i.checked && i.tab === 0) && issues[0].label.includes(`floating · error The castle floats ${MARKED} above`)
        && !el.querySelector('.rev-ai-issues img') && !(window as unknown as { __ran__?: number }).__ran__
        && session.state!.budget.calls.settled === spentBefore + 1 && (q('.cand-budget')!.textContent ?? '').endsWith('AI reviews 1 of 3')
        && narrow.scrollWidth <= 320, { consented, post: post && { keys: Object.keys(post.body), frames: post.body.frames.length, findings: post.body.hostFindings }, issues, budget: q('.cand-budget')?.textContent, width: narrow.scrollWidth });
    // "Improve it" with only the model's floating issue kept: one revision citing exactly it.
    const aiBoxes = [...el.querySelectorAll<HTMLInputElement>('.rev-ai-issues input[type=checkbox]')];
    aiBoxes[1].click();
    button('Improve it').click();
    await until(() => reviews.latest?.status === 'awaiting-run', 5_000);
    const second = revisions.at(-1)!;
    const model = session.state!.evidence.find(e => e.producedBy === 'model' && e.phase === 'visual')!;
    check('EA-VR11b "Improve it" cites exactly the model\'s issue kept: one revision, its finding the model\'s, the round counted',
        revisions.length === 2 && second.findings.filter(f => f.code !== 'EA_REPAIR_BUDGET').map(f => f.id).join() === model.findings[0].id
        && second.findings[0].code === 'floating' && session.state!.budget.visualRounds === 2,
        { findings: second.findings.map(f => [f.code, f.message]), rounds: session.state!.budget.visualRounds });

    // A stage held by a film: the capture refused in both voices, nothing captured.
    busy = 'a film is being made';
    const before = reviews.records.length;
    button('Capture again').click();
    await sleep(20);
    const refused = { note: q('.cand-note')!.textContent, reason: q('.cand-reason')!.textContent, records: reviews.records.length };
    check('EA-VR11a a busy stage is not captured: the creator\'s sentence and the developer\'s words', refused.records === before
        && refused.note === COPY.review.busy && refused.reason === 'EA_REVIEW_BUSY a film is being made', refused);
    check('EA-VR11a the panel fits 320 px with no horizontal overflow', narrow.scrollWidth <= 320 && el.scrollWidth <= el.clientWidth + 1,
        { narrow: narrow.scrollWidth, panel: [el.scrollWidth, el.clientWidth] });

    // A readback refused while the section's checkpoint is still settling (as a device's scopes settle, after a macrotask):
    // the capture says so, and no rejection is ever unhandled in the page (the outside review of 11-02 night: the one
    // breakage Node could not see).
    const { captureInstalled } = await import('../src/exec/review-capture');
    const unhandled: string[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(String(e.reason)); e.preventDefault(); };
    window.addEventListener('unhandledrejection', onUnhandled);
    const stubPort = {
        canvasFormat: 'bgra8unorm', width: 64, height: 36,
        offscreenTarget: () => ({ label: 'target' }), destroyTarget: () => {}, redirectOutput: () => {}, render: () => {},
        readTarget: () => Promise.reject(new Error('mapAsync refused')),
        checkpoint: async (work: () => void) => {
            try { work(); } catch (e) { return String(e); }
            await sleep(50);
            return null;
        },
    } as unknown as EnginePort;
    const stubRuntime = { steps: 3, simTime: 0.05, isPaused: false, redirectOutput: () => {}, view: () => {}, draw: () => [], meshBatches: () => [] } as unknown as AgentRuntime;
    const stubX = { resources: [], operations: [], schedule: { frame: [] } } as unknown as Parameters<typeof captureInstalled>[0]['x'];
    const refusedRead = await captureInstalled({
        port: stubPort, runtime: stubRuntime, x: stubX, views: [{ name: 'framed', camera: FRAMED, describes: 'a stand-in' }], restoreHeadCamera: () => {},
        hold: () => () => {}, stale: () => null, encode: async () => new Uint8Array([0xff, 0xd8, 0xff, 0]),
    });
    await sleep(100);
    window.removeEventListener('unhandledrejection', onUnhandled);
    check('EA-VR11a a readback refused while the capture\'s checkpoint settles is said, and never an unhandled rejection in the page',
        !refusedRead.ok && refusedRead.message === 'EA_CAPTURE read: mapAsync refused' && unhandled.length === 0, { outcome: refusedRead, unhandled });
}

// ---- EA9.1: the creator's Create on the agent path, GPU off --------------------------------------------------------

/**
 * EA9-E1 (EA9.1, GPU off): the creator's Create behind ?create=agent, as the studio mounts it (creation-view.ts over the
 * creation controller), over the backend's recordings through the real clients, reader and transport (only fetch faked),
 * L3 a scripted stand-in and the stage a stand-in. Run unarmed: the Journey's own status icons are host markup.
 */
/** A done step's time on the Journey (creation-view.ts's elapsed): seconds, or minutes and seconds (EA9.2). */
const TOOK = '(\\d+ s|\\d+ min \\d\\d s)';

async function creating(): Promise<void> {
    const [{ CreationView }, { Journey }, { createCreationController }, { createAgentSession }, { createCandidateSession }] = await Promise.all([
        import('../src/shell/studio/creation-view'), import('../src/shell/studio/journey'), import('../src/loop/creation'), import('../src/loop/agent-turn'),
        import('../src/loop/candidate'),
    ]);
    const requests: string[] = [];
    let turnWire = handedOffWire;
    /** E6's case: the turn sends its first event, then holds, silent, until released, so only the tick moves its count. */
    let holdTurn = false;
    let heldTurn: Stream | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === '/v1/agent/turn' && holdTurn) {
            heldTurn = stream(turnWire, 0, 1);
            return heldTurn.response;
        }
        if (path === '/v1/agent/turn') return stream(turnWire, 5).response;
        if (path === '/v1/agent/module') return stream(echoed(moduleAuthorWire, JSON.parse(String(init?.body))), 5).response;
        return new Response('{"code":"not-found","message":"no such route"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const api = createApi(CONFIG, IDENTITY, fetchImpl);
    const gos: string[] = [];
    let answerGo: (s: RunSummary) => void = () => {};
    const controller = createCreationController({
        turnSession: onChange => createAgentSession(createAgentClient(api), onChange),
        candidateSession: onChange => createCandidateSession({ modules: createModuleClient(api), compiler: () => SCRIPTED_DEVICE }, onChange),
        stage: {
            blocked: () => null,
            go: (snapshot, _compiled, about) => {
                gos.push(`${snapshot.id}|${about?.title ?? ''}`);
                return new Promise(resolve => { answerGo = resolve; });
            },
        },
    });
    // The idea box's primary button as the studio makes it: its label in a span, its shortcut in a kbd.
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'btn btn-primary btn-forge';
    const labelEl = document.createElement('span');
    labelEl.textContent = 'Create world';
    const kbd = document.createElement('kbd');
    kbd.textContent = 'Ctrl ⏎';
    primary.append(labelEl, kbd);
    const journey = new Journey();
    let idea: AgentTurnRequest = REQUEST;
    /** The world on the stage paused past its envelope (EA_RESIZE), as the studio's frames would report it. */
    let pausedNow = false;
    const view = new CreationView(controller, { primary, journey, idea: () => idea, blocked: () => null, paused: () => pausedNow });
    const card = document.createElement('section');
    card.className = 'prompt-card';
    card.append(primary, view.again);
    const narrow = document.createElement('div');
    narrow.style.width = '320px';
    narrow.dataset.case = 'creation: the creator\'s Create (?create=agent)';
    narrow.append(card, journey.el);
    panels.append(narrow);
    const label = () => labelEl.textContent ?? '';
    const rows = () => [...journey.el.querySelectorAll<HTMLElement>('.journey-step')].map(r => `${r.className.replace('journey-step is-', '')}: ${r.querySelector('.journey-detail')?.textContent ?? ''}`);

    const idle = label();
    primary.click();
    await until(() => controller.state.phase === 'turn' || controller.state.phase === 'writing');
    const working = { label: label(), disabled: primary.disabled, kbd: kbd.hidden };
    await until(() => controller.state.phase === 'ready', 5_000);
    const ready = { label: label(), again: !view.again.hidden, rows: rows() };
    check('EA9-E1 Create runs the turn and writes its module, Stop offered meanwhile; then it waits for "Show it", nothing shown yet',
        idle === 'Create world' && working.label === 'Stop' && !working.disabled && working.kbd && ready.label === 'Show it' && ready.again && gos.length === 0
        && JSON.stringify(requests) === JSON.stringify(['/v1/agent/turn', '/v1/agent/module'])
        && new RegExp(`^done: ${COPY.creation.planned} · ${TOOK}$`).test(ready.rows[0]) && new RegExp(`^done: ${COPY.creation.written(1)} · ${TOOK}$`).test(ready.rows[1])
        && ready.rows[2] === `pending: ${COPY.creation.readyToShow}`, { idle, working, ready, requests });
    // A double click on "Show it", as a mouse makes one: its second click lands on the button once it reads Stop.
    primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    const showing = { label: label(), phase: controller.state.phase, gos: gos.length };
    answerGo({ status: 'installed', reason: null, numbers: 'probe: init 3.0 ms' });
    await until(() => controller.state.phase === 'installed');
    const done = { label: label(), rows: rows(), again: !view.again.hidden };
    check('EA9-E1 "Show it" is one go (a second press makes none), titled from the idea; installed, the four steps done, Create offered again',
        showing.phase === 'running' && showing.label === 'Stop' && showing.gos === 1 && gos.length === 1 && gos[0].endsWith(`|${REQUEST.prompt}`)
        && done.label === 'Create world' && !done.again && done.rows.length === 4 && done.rows.every(r => r.startsWith('done: '))
        && !requests.some(p => p.startsWith('/v1/forge/')), { showing, done, gos, requests });
    // P5: the creator's view names no id(C), Q_C, WGSL, JSON, GPU number or code.
    const words = narrow.textContent ?? '';
    const developer = [/\b[0-9a-f]{12}…/, /id\(C\)/, /Q_C/, /WGSL/, /JSON/, /\d+(\.\d+)? ms\b/, /\bEA_[A-Z]/, /\bL3\b/, /\bprobe\b/i, /agent\.v\d|module\.(author|repair)/];
    check('EA9-E1 the creator\'s view holds none of Developer view\'s words (P5), and fits 320 px', developer.every(re => !re.test(words))
        && narrow.scrollWidth <= 320, { found: developer.filter(re => re.test(words)).map(String), width: narrow.scrollWidth });
    // An asked turn: the model's question, markup and all, as text in its step; the world on the stage stays; Create again.
    turnWire = edit(askedWire, 'question', 0, (d: any) => ({ ...d, text: 'Stone or wood <img src=x onerror="window.__ran__=9">?' }));
    idea = { ...REQUEST, prompt: 'a river through a stone town' };
    primary.click();
    await until(() => controller.state.phase === 'stopped', 5_000);
    const asked = { label: label(), rows: rows(), images: narrow.querySelectorAll('img').length };
    check('EA9-E1 an asked turn: its question in its step as text, the world on the stage kept, Create offered again',
        asked.label === 'Create world' && asked.rows[0].startsWith('failed: One more detail would help: Stone or wood <img') && asked.images === 0
        && !(window as unknown as { __ran__?: number }).__ran__ && gos.length === 1 && controller.installedSession !== null, asked);

    // EA9.2's E6: a running step counts its elapsed time once a second, and a screen reader hears one sentence a phase,
    // never a tick (the list is no live region; its status line changes with the phase alone). A held Enter presses once.
    const heard: string[] = [];
    const announce = journey.announce.bind(journey);
    journey.announce = (text: string) => { heard.push(text); announce(text); };
    const status = journey.el.querySelector<HTMLElement>('[role="status"]');
    turnWire = handedOffWire;
    holdTurn = true;
    idea = { ...REQUEST, prompt: 'a lantern festival over a lake' };
    primary.click();
    await until(() => controller.state.phase === 'turn' && heldTurn !== null && controller.state.turn?.meta !== null);
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true, bubbles: true });
    const single = new KeyboardEvent('keydown', { key: 'Enter', repeat: false, cancelable: true, bubbles: true });
    primary.dispatchEvent(repeat);
    primary.dispatchEvent(single);
    const counted = rows()[0];
    // Nothing comes from the turn meanwhile: only the view's own tick can move the count.
    await sleep(1_250);
    const countedLater = rows()[0];
    const heardWhilePlanning = [...heard];
    holdTurn = false;
    heldTurn!.release();
    await until(() => controller.state.phase === 'ready', 8_000);
    primary.click();
    answerGo({ status: 'installed', reason: null, numbers: 'probe: init 3.0 ms' });
    await until(() => controller.state.phase === 'installed');
    const listLive = journey.el.getAttribute('aria-live');
    check('EA9-E6 the steps count elapsed time while one runs; a screen reader hears each phase once, never a tick; a held Enter presses once',
        /^running: .* 0 s$/.test(counted) && /^running: .* 1 s$/.test(countedLater) && listLive === null && status?.getAttribute('role') === 'status'
        && JSON.stringify(heardWhilePlanning) === JSON.stringify([COPY.creation.planning])
        && JSON.stringify(heard) === JSON.stringify([COPY.creation.planning, COPY.creation.planned, COPY.creation.writingStart, COPY.creation.readyToShow, COPY.creation.testing, COPY.creation.onStage])
        && status?.textContent === COPY.creation.onStage && repeat.defaultPrevented && !single.defaultPrevented,
        { counted, countedLater, heard, listLive, said: status?.textContent ?? null, repeatPrevented: repeat.defaultPrevented, singlePrevented: single.defaultPrevented });

    // The EA9.2 review: a world on the stage paused past its envelope (EA_RESIZE: a window grown, a page zoomed) offers
    // Show it again, a new go that tests it at this size, with no paid call; running again, Create world is back.
    pausedNow = true;
    view.render();
    const paused = { label: label(), rows: rows(), gos: gos.length, again: !view.again.hidden, said: status?.textContent ?? null };
    const paidBefore = requests.length;
    primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const reprobed = gos.length;
    const pressed = controller.state.phase;
    // A press that made no go (a new paid Create, say) leaves no Run to answer: the check below says so, rather than a
    // wait for an install that never comes.
    if (reprobed > paused.gos) {
        answerGo({ status: 'installed', reason: null, numbers: 'probe: init 3.0 ms' });
        await until(() => controller.state.phase === 'installed');
    }
    pausedNow = false;
    view.render();
    const resumed = { label: label(), rows: rows() };
    check('EA9-E6b a world on the stage paused past its envelope offers Show it again, which tests it at this size; running again, Create world is back',
        paused.label === 'Show it' && paused.rows[3] === `pending: ${COPY.creation.resized}` && paused.again && paused.said === COPY.creation.resized
        && reprobed === paused.gos + 1 && pressed === 'running' && requests.length === paidBefore && resumed.label === 'Create world'
        && resumed.rows.every(r => r.startsWith('done: ')),
        { paused, reprobed, pressed, resumed, paid: requests.length - paidBefore });
    view.dispose();
    controller.dispose();
}

async function run(): Promise<void> {
    const world = document.getElementById('world')!.outerHTML;
    trap.armed = true;
    await endings();
    await markup();
    await elapsed();
    await superseding();
    await cancelling();
    await candidates();
    await running();
    trap.armed = false;
    check('EA-V5 the world on the stage is untouched', document.getElementById('world')!.outerHTML === world);
    check('EA-V5 no WebGPU adapter, no canvas context, and no markup written while the turns ran', trap.requestAdapter === 0 && trap.getContext === 0 && trap.innerHTML === 0, { ...trap });
    const loaded = performance.getEntriesByType('resource').map(e => new URL(e.name).pathname);
    const forbidden = loaded.filter(n => /\/src\/(runtime|verify|capture)\//.test(n) || /null-graph|mediabunny|firebase/.test(n));
    check('EA-V5 no runtime, verifier, capture, engine or Firebase module was loaded', forbidden.length === 0 && loaded.some(n => n.endsWith('/src/shell/studio/agent-view.ts'))
        && loaded.some(n => n.endsWith('/src/shell/studio/candidate-view.ts')), { forbidden, loaded: loaded.length });
    await reviewing();
    await creating();
}

const out = window as unknown as { __AV__?: unknown };
run().then(() => {
    out.__AV__ = { ok: checks.every(c => c.ok), checks, trap: { ...trap }, browser: navigator.userAgent, webgpuExposed: 'gpu' in navigator };
    log(`done: ${checks.filter(c => c.ok).length}/${checks.length}`);
}, (e: unknown) => {
    trap.armed = false;
    out.__AV__ = { ok: false, checks, error: String((e as Error)?.stack ?? e), browser: navigator.userAgent };
    log(`failed: ${String(e)}`, 'error');
});
