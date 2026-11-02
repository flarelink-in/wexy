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

import '../src/styles/base.css';
import '../src/styles/studio.css';
import { createAgentClient, ENGINE_BUNDLE_HASH, type AgentClient, type AgentTurnRequest } from '../src/forge-client/agent-client';
import { readAgentStream, type AgentEvent, type AgentTurnResult } from '../src/forge-client/agent-stream';
import { createApi } from '../src/forge-client/http';
import { createModuleClient, type ModuleClient } from '../src/forge-client/module-client';
import type { Reviser } from '../src/loop/candidate';
import { COPY } from '../src/loop/copy';
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
        && !shown.includes('\\"layout\\"') && /agent-action\.v2, as this build/.test(v.meta ?? '') && /3c7775588fb8…, as this build/.test(v.meta ?? ''),
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
        && v.calls[0].includes('? in / ? out · $0.1562 held, no usage came'), v);

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
        && v.budget === 'Q_C: 4 of 34 calls · authors 1/12 · repairs 0/10 · revisions 0/1' && v.jobs.length === 1
        && /^job-1 place author: ok · \$0\.01\d\d · [^·]+ · module\.author\.v1$/.test(v.jobs[0])
        && v.evidence === 'Evidence 5 records' && requests.length === 1 && requests[0].purpose === 'author', v);
    candidateButton(p, 'Download bundle').click();
    const bundle = saved.length === 1 ? JSON.parse(saved[0].text) : null;
    check('EA-V7 Download bundle saves the candidate: its id, its body, its evidence, each call\'s charge, and no credential', saved.length === 1
        && saved[0].name === 'wexy-candidate-attempt-1.json' && bundle?.format === 'wexy-candidate-bundle.v2' && (v.id ?? '').includes(bundle.candidate.slice(0, 12))
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
        && v.jobs[1].includes('author: ok') && v.budget === 'Q_C: 5 of 34 calls · authors 2/12 · repairs 0/10 · revisions 0/1', v);
    const refused = candidatePanel(liveClient(() => stream(handedOffWire).response),
        moduleClient(() => new Response(moduleDeniedJson, { status: 503, headers: { 'Content-Type': 'application/json' } })), 'candidate: refused');
    await refused.run();
    candidateButton(refused, 'Write the modules').click();
    await until(() => settled(refused), 5_000);
    v = lookCandidate(refused);
    check('EA-V8 a refusal before the stream: failed, the creator\'s sentence and the developer\'s words, the call counted unknown', v.phase === 'failed'
        && v.status === 'Failed: no candidate' && v.note === COPY.failures.budget && v.reason === 'host budget: Live creation has reached its spending limit for now.'
        && v.jobs.length === 1 && v.jobs[0].includes('author: refused · charge unknown') && v.budget === 'Q_C: 4 of 34 calls, 1 unknown · authors 1/12 · repairs 0/10 · revisions 0/1'
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
        r.phase === 'static-verified' && r.budget === 'Q_C: 5 of 34 calls · authors 1/12 · repairs 0/10 · revisions 1/1' && r.turns.length === 2
        && r.turns[0].role === 'hand-off' && r.turns[0].head === 'turn-1 hand-off: handed-off · 3 calls · $0.1380 · muse-spark-1.3 · agent.v5'
        && r.turns[0].calls.length === 3 && r.turns[1].role === 'revision'
        && r.turns[1].head === 'turn-1 program revision: handed-off · 1 call · $0.0460 · muse-spark-1.3 · agent.v5'
        && JSON.stringify(r.turns[1].calls) === JSON.stringify(['1 revise: $0.0460 · gen-1']) && r.jobs.length === 1 && r.jobs[0].includes('place author: ok'), r);
    candidateButton(revising, 'Download bundle').click();
    const revisedBundle = revisedSaved.length === 1 ? JSON.parse(revisedSaved[0].text) : null;
    const revision = revisedBundle?.calls?.turns?.[1];
    const records = revisedBundle ? revisedBundle.calls.turns.reduce((n: number, t: { calls: unknown[] }) => n + t.calls.length, 0) + revisedBundle.calls.jobs.length : -1;
    check('EA-V11 the downloaded bundle holds the revision\'s turn: its call, charge, model and template; each call Q_C settled has its record',
        revisedBundle?.format === 'wexy-candidate-bundle.v2' && revision?.role === 'revision' && revision.status === 'handed-off' && revision.model === 'muse-spark-1.3'
        && revision.promptVersion === 'agent.v5' && revision.charge === 'known' && revision.calls.length === 1 && revision.calls[0].purpose === 'revise'
        && revision.calls[0].costMicroUsd === 46_000 && revisedBundle.versions.templates.includes('agent.v5') && records === revisedBundle.calls.budget.calls.settled,
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
