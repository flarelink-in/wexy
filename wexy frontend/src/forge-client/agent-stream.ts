// One agent turn's stream (the backend's agent-loop design §5.4, as EA2.4 built it and its AgentWireTest records it):
// several model calls in one server-sent event stream. It has its own reader over parseEventStream (sse.ts), not h1's
// readForgeStream, which wants a generation's meta and `done.status: ok`: an agent's meta names a turn, and its done has
// four statuses (§15.1, gate B1). Every event is parsed at the boundary, unknown in and a typed event out (coding
// principles §2), and held to the order the backend's loop emits it:
//   meta; then for each call n = 1, 2, …: `call` n, its `usage` n unless the call ended the turn, then at most one of
//   `tools` n, `check` n (a passing check is followed by `design`, `program`, in a revision turn `repairs`, and
//   `done handed-off`) or `question` (followed by `done asked`); and exactly one terminal, `done` or `error`.
// Events are correlated by `n`, the one id every call's events carry (`call` has no generation id; its `usage` has).
// An event this reader does not know is skipped, as h1's reader skips one, but it still counts against the turn's caps:
// its characters, its events and each event's own. meta's `bundleHash` must be the engine bundle this build embeds (I2),
// its `actionSchema` the action contract this build reads (agent-action.v3; a server before EA3.6 names none, and speaks
// v1), and its `manifestHash` the adapter manifest this build embeds, or the stream is cancelled at once, before any
// design or program is read; the server, seeing the client go, ends the turn (A8). A broken contract is a developer's
// error, said loudly (coding principles §4).
// `repairs` (EA6.3; the visual-review design §8.2) is a revision's notes to the modules whose code must change, the whole
// list held to the schema and to one note a module: a revision turn always hands it off, empty when there are none, and
// a first turn never does, so neither a missing list nor a stray one is read into silence.

import { ADAPTER_MANIFEST_HASH } from '../contract/adapters';
import { AGENT_ACTION, AGENT_ACTION_VERSION, parseDesign, parseProgram, parseRepairs, type ModuleRepair, type SolutionDesign, type WorldProgram } from '../contract/agent';
import { ERROR_STATUS, ForgeError, isErrorCode } from './errors';
import { abortable, parseEventStream } from './sse';

export interface AgentMeta {
    turnId: string;
    model: string;
    /** Always `live`: no archive replays a turn yet. */
    source: 'live';
    promptVersion: string;
    bundleHash: string;
    /** The action contract the server held the model to; null when it names none, as servers before EA3.6 (v1) do. */
    actionSchema: string | null;
    /** The adapter manifest the server checked the program's nodes against; null when it names none. */
    manifestHash: string | null;
}

export interface AgentCall {
    n: number;
    /** Why the loop made the call, in the backend's words: `first`, `after-tools`, `revise`, `repair`, `program`, `next`. */
    purpose: string;
}

export interface AgentUsage {
    n: number;
    generationId: string;
    /** Tokens as the call's stream reported them; null when it reported none. Unknown is never zero. */
    in: number | null;
    out: number | null;
    reasoning: number | null;
    cached: number | null;
    /** In micro-USD: what the usage cost, or what the call's reservation holds when no usage came (Q43). */
    costMicroUsd: number;
}

export interface AgentToolResult {
    tool: string;
    /** The document, symbol or query it named; empty when the request named none. */
    target: string;
    ok: boolean;
    /** What it took from the turn's document bytes; 0 for an error. */
    bytes: number;
    /** Why it was refused; null when it answered. */
    error: string | null;
}

export interface AgentTools {
    n: number;
    round: number;
    results: AgentToolResult[];
    /** `EA_CONTEXT_LIMIT` when the turn's reading rounds were spent and nothing was read; null otherwise. */
    error: string | null;
}

export interface AgentFinding {
    level: 'fail' | 'warn';
    code: string;
    path: string;
    message: string;
}

export interface AgentCheck {
    n: number;
    /** True exactly when no finding fails: the server's pure check passed the program. */
    ok: boolean;
    findings: AgentFinding[];
}

export type AgentEvent =
    | { type: 'meta'; meta: AgentMeta }
    | { type: 'call'; call: AgentCall }
    | { type: 'usage'; usage: AgentUsage }
    | { type: 'tools'; tools: AgentTools }
    | { type: 'check'; check: AgentCheck }
    | { type: 'design'; design: SolutionDesign }
    | { type: 'program'; program: WorldProgram }
    | { type: 'repairs'; repairs: ModuleRepair[] }
    | { type: 'question'; text: string };

/** One call as its events told it. */
export interface AgentCallRecord {
    n: number;
    purpose: string;
    usage: AgentUsage | null;
    tools: AgentTools | null;
    check: AgentCheck | null;
}

export type AgentDiagnostic = 'EA_TURN_BUDGET' | 'EA_CONTEXT_LIMIT';

interface TurnBase {
    meta: AgentMeta;
    calls: AgentCallRecord[];
    /** The calls' costs as reported, reservations included where no usage came; null when a call reported nothing. */
    costMicroUsd: number | null;
}

export type AgentTurnResult = TurnBase & (
    /**
     * The server's pure check passed this design and program. Nothing has built or rendered them: that is EA3. `repairs`
     * is a revision's notes to its modules (EA6.3), empty when it has none, and always empty in a first turn.
     */
    | { status: 'handed-off'; design: SolutionDesign; program: WorldProgram; repairs: ModuleRepair[] }
    /** The model asked one question. In EA2 the turn ends there: nothing resumes it. */
    | { status: 'asked'; question: string }
    /** A budget refused the next call, or the turn's time ran out; the diagnostic when the reason starts with one. */
    | { status: 'exhausted'; reason: string; diagnostic: AgentDiagnostic | null }
    /** The model gave up (its `finish`), with its reason. */
    | { status: 'declined'; reason: string });

/** The identities a turn's meta names, each of which must be this build's (I2; EA3.6). */
export type AgentIdentity = 'bundle' | 'actionSchema' | 'manifest';

const DIFFERS: Record<AgentIdentity, string> = {
    bundle: 'the turn quotes another engine bundle than this build embeds',
    actionSchema: 'the turn speaks another action contract than this build reads (a server that names none speaks agent-action.v1)',
    manifest: 'the turn was checked against another adapter manifest than this build embeds',
};

/**
 * meta named another engine bundle, action contract or adapter manifest than this build's: the turn's documents,
 * program or checks are not the ones here (I2), so nothing of it is read.
 */
export class AgentVersionError extends ForgeError {
    readonly identity: AgentIdentity;
    /** What the server named ('none' when it named nothing), and what this build has. */
    readonly server: string;
    readonly client: string;

    constructor(identity: AgentIdentity, server: string, client: string, status: number) {
        const shown = (s: string) => (identity === 'actionSchema' ? s.slice(0, 40) : s.slice(0, 12));
        super('internal', status, `EA_VERSION_MISMATCH ${identity} ${shown(server)}, runtime ${shown(client)}: ${DIFFERS[identity]}, `
            + 'so it was cancelled before any design or program was read.');
        this.name = 'AgentVersionError';
        this.identity = identity;
        this.server = server;
        this.client = client;
    }
}

/** The client's own bounds on a turn, in characters of event data: the server's are its budgets, these are ours. */
export interface AgentStreamLimits {
    /** All of a turn's event data. */
    totalChars: number;
    /** Events of any name; comments (heartbeats) are not events. */
    events: number;
    /** Each event's data, by name; `other` for a name this reader does not know. */
    eventChars: Readonly<Record<string, number>>;
}

/**
 * The most characters one event's data may carry: the backend's AgentTurn.MAX_EVENT_CHARS, which it holds a hand-off
 * to (a design or program past it is a `wire-size` finding to revise), and sse.ts's own bound on an event. The schema
 * bounds a design's strings, not their escaping (a control character is six characters as JSON), so a schema-valid
 * design can pass 200,000 and a program a megabyte: the wire, not the schema, is the limit both sides agree on.
 * test/agent-contract.test.mjs pins the two equal.
 */
export const AGENT_EVENT_CHARS = 262_144;

/**
 * A turn is at most six calls (AgentTurn.MAX_CALLS) of a few small events each, a design, a program and up to three
 * checks, each of those within AGENT_EVENT_CHARS; the small events' caps are many times what the backend sends.
 */
export const AGENT_STREAM_LIMITS: AgentStreamLimits = {
    totalChars: 2_097_152,
    events: 256,
    eventChars: {
        meta: 1_024, call: 256, usage: 512, tools: 16_384, check: AGENT_EVENT_CHARS, design: AGENT_EVENT_CHARS,
        // Twelve notes of a 40-character module and a 300-character message, every character escaped (six each) at most.
        program: AGENT_EVENT_CHARS, repairs: 32_768, question: 4_096, done: 4_096, error: 4_096, other: 4_096,
    },
};

export interface AgentStreamOptions {
    /** The engine bundle this build embeds (src/contract/engine/bundle.json): a turn that quotes another is refused. */
    bundleHash: string;
    /**
     * Whether the turn revises a base (EA4.4): its hand-off then carries `repairs` after its program (EA6.3), and a first
     * turn's never does.
     */
    revision?: boolean;
    /** The adapter manifest this build embeds, ADAPTER_MANIFEST_HASH unless a test names another. */
    manifestHash?: string;
    /** Stops the read: the body is cancelled, and the read rejects with the signal's reason. */
    signal?: AbortSignal;
    limits?: AgentStreamLimits;
}

/** Where the turn is, between events: what may come next follows from it. */
type Phase = 'meta' | 'opened' | 'calling' | 'answered' | 'acted' | 'passed' | 'designed' | 'programmed' | 'repaired' | 'asked';

const PURPOSE = /^[a-z][a-z-]{0,39}$/;
const ID = /^[\w-]{1,64}$/;
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const HASH = /^[0-9a-f]{64}$/;
const SCHEMA_NAME = /^[a-z][a-z-]{0,30}\.v[1-9][0-9]{0,2}$/;

/** The schema's own bound on a top-level string (`question`) or the finish summary, so the two cannot drift. */
function schemaMaxLength(name: 'question' | 'finish'): number {
    const props = AGENT_ACTION.properties as Record<string, { anyOf: { maxLength?: number; properties?: Record<string, { maxLength: number }> }[] }>;
    const branch = props[name].anyOf[0];
    const max = name === 'question' ? branch.maxLength : branch.properties?.summary.maxLength;
    if (typeof max !== 'number') throw new Error(`${AGENT_ACTION_VERSION}: ${name} has no maxLength.`);
    return max;
}

const QUESTION_MAX = schemaMaxLength('question');
/** A declined turn's reason is the model's summary, or the backend's own few words when it gave none. */
const REASON_MAX = Math.max(schemaMaxLength('finish'), 600);

/**
 * Reads one agent turn to its terminal event: the typed result on `done`; a ForgeError on an `error` event (its code)
 * and on a broken contract; an AgentVersionError when meta names another engine bundle, action contract or adapter
 * manifest. Each event is handed to
 * `onEvent` once it has been checked, in order. The stream is cancelled once the read ends, however it ends.
 */
export async function readAgentStream(res: Response, onEvent: (event: AgentEvent) => void, options: AgentStreamOptions): Promise<AgentTurnResult> {
    if (!res.body) throw broken(res, 'the response has no body');
    const limits = options.limits ?? AGENT_STREAM_LIMITS;
    if (options.signal?.aborted) {
        await res.body.cancel(options.signal.reason).catch(() => {});
        throw options.signal.reason;
    }
    const events = parseEventStream(options.signal ? abortable(res.body, options.signal) : res.body);

    let phase: Phase = 'meta';
    let meta: AgentMeta | null = null;
    const calls: AgentCallRecord[] = [];
    let design: SolutionDesign | null = null;
    let program: WorldProgram | null = null;
    let repairs: ModuleRepair[] | null = null;
    let question: string | null = null;
    const revision = options.revision === true;
    let total = 0;
    let count = 0;
    const current = () => calls[calls.length - 1];
    /** The event must be the current call's, and come where its phase allows it. */
    const expect = (event: string, allowed: readonly Phase[]) => {
        if (!allowed.includes(phase)) throw broken(res, `${event} came after ${phase === 'opened' ? 'meta' : `the turn was ${phase}`}`);
    };
    const sameCall = (event: string, n: number) => {
        if (!current() || n !== current().n) throw broken(res, `${event} names call ${n}, but call ${current()?.n ?? 'none'} is open`);
    };
    const emit = (event: AgentEvent) => onEvent(event);

    try {
        for await (const { event, data } of events) {
            // A cancel from inside a callback stops the turn here, though more events sit parsed in the same chunk.
            options.signal?.throwIfAborted();
            count++;
            total += data.length;
            if (count > limits.events) throw new ForgeError('upstream', res.status, `The agent stream passed ${limits.events} events; the client stopped reading it.`);
            if (total > limits.totalChars) throw new ForgeError('upstream', res.status, `The agent stream passed ${limits.totalChars} characters; the client stopped reading it.`);
            // Own names only: an event called `toString` must not read Object.prototype's function as its cap.
            const cap = Object.hasOwn(limits.eventChars, event) ? limits.eventChars[event] : limits.eventChars.other;
            if (data.length > cap) throw new ForgeError('upstream', res.status, `An agent ${event} event passed ${cap} characters; the client stopped reading it.`);

            if (event === 'error') throw turnError(res, data);
            if (phase === 'meta') {
                if (event !== 'meta') throw broken(res, `the first event was "${event}", not meta`);
                meta = deepFreeze(readMeta(res, data));
                if (meta.bundleHash !== options.bundleHash) throw new AgentVersionError('bundle', meta.bundleHash, options.bundleHash, res.status);
                if (meta.actionSchema !== AGENT_ACTION_VERSION) throw new AgentVersionError('actionSchema', meta.actionSchema ?? 'none', AGENT_ACTION_VERSION, res.status);
                const manifestHash = options.manifestHash ?? ADAPTER_MANIFEST_HASH;
                if (meta.manifestHash !== manifestHash) throw new AgentVersionError('manifest', meta.manifestHash ?? 'none', manifestHash, res.status);
                phase = 'opened';
                emit({ type: 'meta', meta });
                continue;
            }
            switch (event) {
                case 'meta':
                    throw broken(res, 'meta appeared more than once');
                case 'call': {
                    const call = deepFreeze(readCall(res, data));
                    expect('call', calls.length === 0 ? ['opened'] : ['answered', 'acted']);
                    if (call.n !== calls.length + 1) throw broken(res, `call ${call.n} came after call ${calls.length}`);
                    calls.push({ n: call.n, purpose: call.purpose, usage: null, tools: null, check: null });
                    phase = 'calling';
                    emit({ type: 'call', call });
                    break;
                }
                case 'usage': {
                    const usage = deepFreeze(readUsage(res, data));
                    expect('usage', ['calling']);
                    sameCall('usage', usage.n);
                    current().usage = usage;
                    phase = 'answered';
                    emit({ type: 'usage', usage });
                    break;
                }
                case 'tools': {
                    const tools = deepFreeze(readTools(res, data));
                    expect('tools', ['answered']);
                    sameCall('tools', tools.n);
                    current().tools = tools;
                    phase = 'acted';
                    emit({ type: 'tools', tools });
                    break;
                }
                case 'check': {
                    const check = deepFreeze(readCheck(res, data));
                    expect('check', ['answered']);
                    sameCall('check', check.n);
                    current().check = check;
                    phase = check.ok ? 'passed' : 'acted';
                    emit({ type: 'check', check });
                    break;
                }
                case 'design': {
                    expect('design', ['passed']);
                    const parsed = parseDesign(field(res, json(res, data), 'design'));
                    if (!parsed.ok) throw broken(res, `the design leaves ${AGENT_ACTION_VERSION}: ${parsed.problems.slice(0, 3).join('; ')}`);
                    design = deepFreeze(parsed.value);
                    phase = 'designed';
                    emit({ type: 'design', design });
                    break;
                }
                case 'program': {
                    expect('program', ['designed']);
                    const parsed = parseProgram(field(res, json(res, data), 'program'));
                    if (!parsed.ok) throw broken(res, `the program leaves ${AGENT_ACTION_VERSION}: ${parsed.problems.slice(0, 3).join('; ')}`);
                    program = deepFreeze(parsed.value);
                    phase = 'programmed';
                    emit({ type: 'program', program });
                    break;
                }
                case 'repairs': {
                    expect('repairs', ['programmed']);
                    if (!revision) throw broken(res, 'a first turn handed off repairs: it has no code to repair');
                    const parsed = parseRepairs(field(res, json(res, data), 'repairs'));
                    if (!parsed.ok) throw broken(res, `the repairs leave ${AGENT_ACTION_VERSION}: ${parsed.problems.slice(0, 3).join('; ')}`);
                    repairs = deepFreeze(parsed.value);
                    phase = 'repaired';
                    emit({ type: 'repairs', repairs });
                    break;
                }
                case 'question': {
                    expect('question', ['answered']);
                    question = text(res, json(res, data), 'text', QUESTION_MAX);
                    phase = 'asked';
                    emit({ type: 'question', text: question });
                    break;
                }
                case 'done':
                    // What was checked is what is returned: frozen, so no callback or caller can change it after.
                    return deepFreeze(done(res, data, phase, meta!, calls, design, program, repairs, question, revision));
                default:
                    // An event this reader does not know yet: additive by contract, so it is skipped (and was counted).
                    break;
            }
        }
    } finally {
        await events.return(undefined);
    }
    options.signal?.throwIfAborted();
    throw new ForgeError('unavailable', res.status, 'The agent stream ended before its last event: the connection dropped, or a proxy cut it.');
}

function done(res: Response, data: string, phase: Phase, meta: AgentMeta, calls: AgentCallRecord[],
    design: SolutionDesign | null, program: WorldProgram | null, repairs: ModuleRepair[] | null, question: string | null, revision: boolean): AgentTurnResult {
    const d = json(res, data);
    const status = field(res, d, 'status');
    const reason = field(res, d, 'reason');
    const base: TurnBase = {
        meta,
        calls,
        costMicroUsd: calls.every(c => c.usage) ? calls.reduce((sum, c) => sum + c.usage!.costMicroUsd, 0) : null,
    };
    const noReason = () => {
        if (reason !== null) throw broken(res, `done ${String(status)} carries a reason`);
    };
    const words = () => {
        if (typeof reason !== 'string' || !reason.trim() || codePoints(reason) > REASON_MAX) {
            throw broken(res, `done ${String(status)} needs a reason of 1 to ${REASON_MAX} characters`);
        }
        return reason;
    };
    switch (status) {
        case 'handed-off':
            if (phase === 'programmed' && revision) throw broken(res, 'done handed-off came before the revision\'s repairs');
            if (phase !== 'programmed' && phase !== 'repaired') throw broken(res, `done handed-off came while the turn was ${phase}, before a checked design and program`);
            noReason();
            return { ...base, status: 'handed-off', design: design!, program: program!, repairs: repairs ?? [] };
        case 'asked':
            if (phase !== 'asked') throw broken(res, `done asked came while the turn was ${phase}, with no question`);
            noReason();
            return { ...base, status: 'asked', question: question! };
        case 'exhausted': {
            if (!['calling', 'answered', 'acted'].includes(phase)) throw broken(res, `done exhausted came while the turn was ${phase}`);
            const why = words();
            const code = /^(EA_TURN_BUDGET|EA_CONTEXT_LIMIT)\b/.exec(why)?.[1] as AgentDiagnostic | undefined;
            return { ...base, status: 'exhausted', reason: why, diagnostic: code ?? null };
        }
        case 'declined':
            if (phase !== 'answered') throw broken(res, `done declined came while the turn was ${phase}`);
            return { ...base, status: 'declined', reason: words() };
        default:
            throw broken(res, `done.status is ${JSON.stringify(status)?.slice(0, 40)}, not handed-off, asked, exhausted or declined`);
    }
}

function readMeta(res: Response, data: string): AgentMeta {
    const m = json(res, data);
    if (field(res, m, 'source') !== 'live') throw broken(res, `meta.source is ${JSON.stringify(m.source)?.slice(0, 20)}, not live`);
    return {
        turnId: matching(res, m, 'turnId', ID),
        model: text(res, m, 'model', 100),
        source: 'live',
        promptVersion: text(res, m, 'promptVersion', 40),
        bundleHash: matching(res, m, 'bundleHash', HASH),
        // Absent is a server before EA3.6, which speaks v1: the caller refuses it as a version, not a broken contract.
        actionSchema: m.actionSchema === undefined ? null : matching(res, m, 'actionSchema', SCHEMA_NAME),
        manifestHash: m.manifestHash === undefined ? null : matching(res, m, 'manifestHash', HASH),
    };
}

function readCall(res: Response, data: string): AgentCall {
    const c = json(res, data);
    return { n: count(res, c, 'n', 1), purpose: matching(res, c, 'purpose', PURPOSE) };
}

function readUsage(res: Response, data: string): AgentUsage {
    const u = json(res, data);
    return {
        n: count(res, u, 'n', 1),
        generationId: matching(res, u, 'generationId', ID),
        in: countOrNull(res, u, 'in'),
        out: countOrNull(res, u, 'out'),
        reasoning: countOrNull(res, u, 'reasoning'),
        cached: countOrNull(res, u, 'cached'),
        costMicroUsd: count(res, u, 'costMicroUsd', 0),
    };
}

function readTools(res: Response, data: string): AgentTools {
    const t = json(res, data);
    const list = field(res, t, 'results');
    // A round runs at most six requests (the action's context.requests).
    if (!Array.isArray(list) || list.length > 6) throw broken(res, 'tools.results is not a list of at most 6');
    const results = list.map((r): AgentToolResult => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw broken(res, 'a tools result is not an object');
        const o = r as Record<string, unknown>;
        const ok = flag(res, o, 'ok');
        const error = o.error === null ? null : text(res, o, 'error', 2_000);
        if (ok !== (error === null)) throw broken(res, `a tools result is ok=${ok} with ${error === null ? 'no error' : 'an error'}`);
        return { tool: text(res, o, 'tool', 60, true), target: text(res, o, 'target', 200, true), ok, bytes: count(res, o, 'bytes', 0), error };
    });
    // `error` is there only when the rounds were spent (EA_CONTEXT_LIMIT), and then nothing was read.
    const error = t.error === undefined ? null : matching(res, t, 'error', /^EA_[A-Z_]{1,40}$/);
    if (error && results.length) throw broken(res, `tools carries ${error} and results`);
    return { n: count(res, t, 'n', 1), round: count(res, t, 'round', 1), results, error };
}

function readCheck(res: Response, data: string): AgentCheck {
    const c = json(res, data);
    const list = field(res, c, 'findings');
    if (!Array.isArray(list)) throw broken(res, 'check.findings is not a list');
    const findings = list.map((f): AgentFinding => {
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw broken(res, 'a finding is not an object');
        const o = f as Record<string, unknown>;
        const level = field(res, o, 'level');
        if (level !== 'fail' && level !== 'warn') throw broken(res, `a finding's level is ${JSON.stringify(level)?.slice(0, 20)}`);
        return { level, code: matching(res, o, 'code', CODE), path: text(res, o, 'path', 400), message: text(res, o, 'message', 2_000) };
    });
    const ok = flag(res, c, 'ok');
    // A hand-off means the check passed: ok must agree with the findings, or a failing program could pass as checked.
    if (ok !== !findings.some(f => f.level === 'fail')) throw broken(res, `check.ok is ${ok}, but ${findings.filter(f => f.level === 'fail').length} findings fail`);
    return { n: count(res, c, 'n', 1), ok, findings };
}

/** The `error` event: the backend's code (an unknown one is internal) and its message, capped. */
function turnError(res: Response, data: string): ForgeError {
    const e = json(res, data);
    const code = isErrorCode(e.code) ? e.code : 'internal';
    const message = typeof e.message === 'string' && e.message ? e.message.slice(0, 300) : `The turn failed (${String(e.code).slice(0, 40)}).`;
    return new ForgeError(code, res.ok ? res.status : ERROR_STATUS[code], message);
}

function json(res: Response, data: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw broken(res, `an event's data is not JSON: ${data.slice(0, 80)}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw broken(res, `an event's data is not an object: ${data.slice(0, 80)}`);
    return value as Record<string, unknown>;
}

function field(res: Response, o: Record<string, unknown>, key: string): unknown {
    if (!Object.hasOwn(o, key)) throw broken(res, `"${key}" is missing`);
    return o[key];
}

const codePoints = (s: string): number => {
    let n = 0;
    for (const _ of s) n++;
    return n;
};

/** A string of at most `max` characters (code points, as the schema counts), not blank unless `blank` allows it. */
function text(res: Response, o: Record<string, unknown>, key: string, max: number, blank = false): string {
    const v = field(res, o, key);
    if (typeof v !== 'string' || (!blank && !v.trim()) || codePoints(v) > max) throw broken(res, `"${key}" is not a string of ${blank ? 0 : 1} to ${max} characters`);
    return v;
}

function matching(res: Response, o: Record<string, unknown>, key: string, pattern: RegExp): string {
    const v = field(res, o, key);
    if (typeof v !== 'string' || !pattern.test(v)) throw broken(res, `"${key}" is not what it should be: ${JSON.stringify(v)?.slice(0, 40)}`);
    return v;
}

function count(res: Response, o: Record<string, unknown>, key: string, min: number): number {
    const v = field(res, o, key);
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw broken(res, `"${key}" is not a whole number of at least ${min}`);
    return v;
}

function countOrNull(res: Response, o: Record<string, unknown>, key: string): number | null {
    return field(res, o, key) === null ? null : count(res, o, key, 0);
}

function flag(res: Response, o: Record<string, unknown>, key: string): boolean {
    const v = field(res, o, key);
    if (typeof v !== 'boolean') throw broken(res, `"${key}" is not true or false`);
    return v;
}

/** A payload, frozen once checked: a callback, the view or the caller holds it, and none can change what was checked. */
function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/** The backend broke the turn's contract: a bug there, reported in a developer's words. */
function broken(res: Response, why: string): ForgeError {
    return new ForgeError('internal', res.status, `The agent stream broke its contract: ${why}.`);
}
