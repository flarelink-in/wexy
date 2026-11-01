// One module call's stream (candidate-loop-design.md §5, "The module call's wire", and §6): the backend's ModuleHandler,
// as EA4.2 built it and its ModuleRoutesTest records it (test/fixtures/module-wire). One metered call that writes or
// repairs one module's body, read to its terminal event, unknown in and a typed outcome out (coding principles §2), in
// the order the handler emits:
//   meta; then the answer as `delta`s; then at most one `usage`; then exactly one `done` or `error`.
// meta must echo the job this browser sent, field by field: its turn and job, its purpose, its subject, the versions it
// pinned, the module and its interfaceHash. Another echo is another job's stream, so it is cancelled before any of its
// text is read. `done` names the unfenced answer's SHA-256 and length; the text the deltas carry is unfenced and hashed
// here, and only that whole text, matching, is an answer (the design §5: EOF without done, an oversized answer or a
// mismatched echo never installs a partial body). An `error` event is the call's own end: it was made, and its answer
// was unusable. Anything else is EA_MODULE_STREAM, its charge known only when a usage came first. Nothing here retries:
// a second request could buy a second model call (the design §8).

import { BODY_DIAL } from '../contract/adapters/bodies';
import { canonicalJson, sha256Hex } from '../contract/adapters/canonical';
import { unfence } from '../contract/unfence';
import { ForgeError, isErrorCode, type ErrorCode } from './errors';
import { abortable, parseEventStream } from './sse';

/** What a module call is about (the design §5's EvidenceSubject): the attempt and its revision, and the hashes known. */
export interface ModuleSubject {
    attempt: string;
    revision: number;
    /** W's hash; known even when W does not resolve. */
    programHash: string;
    /** X's hash; null only for a resolver refusal, which no module call follows. */
    graph: string | null;
    /** id(C), only for a complete body snapshot. */
    candidate: string | null;
    module: string | null;
    interfaceHash: string | null;
    /** The exact text judged: a repair's previous body; null for an author call. */
    codeHash: string | null;
}

/** The pins a module call names (the backend's ModuleRequest.pins): a mismatch is refused there, before any charge. */
export interface ModuleVersions {
    bundle: string;
    actionSchema: string;
    manifest: string;
    abi: string;
    checker: string;
}

export type ModulePurpose = 'author' | 'repair';

/** The job a stream must echo: what this browser sent. */
export interface ModuleJob {
    turnId: string;
    jobId: string;
    purpose: ModulePurpose;
    subject: ModuleSubject;
    versions: ModuleVersions;
    module: string;
    interfaceHash: string;
}

export interface ModuleMeta extends ModuleJob {
    generationId: string;
    model: string;
    /** Always `live`: no archive replays a module call. */
    source: 'live';
    role: 'module';
    promptVersion: string;
}

export interface ModuleUsage {
    /** Tokens as the call's stream reported them; null when it reported none. Unknown is never zero. */
    in: number | null;
    out: number | null;
    reasoning: number | null;
    cached: number | null;
    /** In micro-USD, as the backend priced the usage. */
    costMicroUsd: number;
}

export type ModuleEvent =
    | { type: 'meta'; meta: ModuleMeta }
    /** A piece of the answer, and how many characters of it have come so far. */
    | { type: 'delta'; text: string; chars: number }
    | { type: 'usage'; usage: ModuleUsage };

export type ModuleOutcome =
    /** The whole answer, unfenced, its hash the one `done` named: the text checkBody judges. Nothing has checked it yet. */
    | { status: 'ok'; meta: ModuleMeta; answer: string; answerSha256: string; usage: ModuleUsage | null }
    /** The call ended in its own `error`: it was made, and its answer was unusable (empty, cut, too long, no entry). */
    | { status: 'error'; meta: ModuleMeta; code: ErrorCode; message: string; usage: ModuleUsage | null };

/**
 * A module stream that broke its contract, or ended before its terminal event: never a body, never retried. Its
 * charge is known when a usage came before the break, and unknown otherwise: the server's reservation stands.
 */
export class ModuleStreamError extends ForgeError {
    readonly job: string;
    readonly reason: string;
    readonly charge: 'known' | 'unknown';
    readonly usage: ModuleUsage | null;

    constructor(code: ErrorCode, status: number, job: string, reason: string, usage: ModuleUsage | null) {
        const charge = usage ? 'known' : 'unknown';
        super(code, status, `EA_MODULE_STREAM ${job}: ${reason}; charge ${charge}`);
        this.name = 'ModuleStreamError';
        this.job = job;
        this.reason = reason;
        this.charge = charge;
        this.usage = usage;
    }
}

/** The client's own bounds on a module stream, in characters: the server's are the role's caps, these are ours. */
export interface ModuleStreamLimits {
    /** All of a stream's event data. */
    totalChars: number;
    /** Events of any name; comments (heartbeats) are not events. */
    events: number;
    /** The answer's text as the deltas carry it, before unfencing. */
    textChars: number;
    /** Each event's data, by name; `other` for a name this reader does not know. */
    eventChars: Readonly<Record<string, number>>;
}

/**
 * The module role writes at most 12,000 output tokens (the backend's application.yaml), reasoning included, and the
 * backend sends one delta for each piece of text the model streams, about a token each: at most about 12,000 deltas of
 * at most some 50,000 characters in all. These caps are a few times that, so a sane stream never meets them and a
 * runaway one stops here. The body itself is at most BODY_DIAL.maxChars once unfenced, as the server holds it.
 */
export const MODULE_STREAM_LIMITS: ModuleStreamLimits = {
    totalChars: 1_048_576,
    events: 16_384,
    textChars: 131_072,
    eventChars: { meta: 8_192, delta: 65_536, usage: 512, done: 512, error: 4_096, other: 4_096 },
};

export interface ModuleStreamOptions {
    /** Stops the read: the body is cancelled, and the read rejects with the signal's reason. */
    signal?: AbortSignal;
    limits?: ModuleStreamLimits;
}

/** Where the stream is, between events: what may come next follows from it. */
type Phase = 'meta' | 'body' | 'used';

const ID = /^[\w-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Reads one module call to its terminal event: `ok` with the whole answer on a matching `done`; `error` on the call's
 * own `error`; a ModuleStreamError on a broken contract, a mismatched echo or a stream that ends too soon. Each event is
 * handed to `onEvent` once it has been checked, in order. The stream is cancelled once the read ends, however it ends.
 */
export async function readModuleStream(res: Response, job: ModuleJob, onEvent: (event: ModuleEvent) => void,
    options: ModuleStreamOptions = {}): Promise<ModuleOutcome> {
    let usage: ModuleUsage | null = null;
    /** The job broke its contract here: never a body. */
    const broken = (why: string) => new ModuleStreamError('internal', res.status, job.jobId, why, usage);
    if (!res.body) throw broken('the response has no body');
    const limits = options.limits ?? MODULE_STREAM_LIMITS;
    if (options.signal?.aborted) {
        await res.body.cancel(options.signal.reason).catch(() => {});
        throw options.signal.reason;
    }
    const events = parseEventStream(options.signal ? abortable(res.body, options.signal) : res.body);

    let phase: Phase = 'meta';
    let meta: ModuleMeta | null = null;
    const text: string[] = [];
    let chars = 0;
    let total = 0;
    let count = 0;
    try {
        for await (const { event, data } of events) {
            // A cancel from inside a callback stops the read here, though more events sit parsed in the same chunk.
            options.signal?.throwIfAborted();
            count++;
            total += data.length;
            if (count > limits.events) throw broken(`it passed ${limits.events} events`);
            if (total > limits.totalChars) throw broken(`it passed ${limits.totalChars} characters`);
            // Own names only: an event called `toString` must not read Object.prototype's function as its cap.
            const cap = Object.hasOwn(limits.eventChars, event) ? limits.eventChars[event] : limits.eventChars.other;
            if (data.length > cap) throw broken(`a ${event.slice(0, 40)} event passed ${cap} characters`);

            if (phase === 'meta') {
                if (event !== 'meta') throw broken(`the first event was "${event.slice(0, 40)}", not meta`);
                meta = readMeta(data, job, broken);
                phase = 'body';
                onEvent({ type: 'meta', meta });
                continue;
            }
            switch (event) {
                case 'meta':
                    throw broken('meta appeared more than once');
                case 'delta': {
                    if (phase !== 'body') throw broken('a delta came after the usage');
                    const piece = string(object(data, broken), 'text', broken);
                    chars += piece.length;
                    if (chars > limits.textChars) throw broken(`the answer passed ${limits.textChars} characters`);
                    text.push(piece);
                    onEvent({ type: 'delta', text: piece, chars });
                    break;
                }
                case 'usage':
                    if (phase !== 'body') throw broken('usage appeared more than once');
                    usage = readUsage(data, broken);
                    phase = 'used';
                    onEvent({ type: 'usage', usage });
                    break;
                case 'error': {
                    const e = object(data, broken);
                    const code: ErrorCode = isErrorCode(e.code) ? e.code : 'internal';
                    const message = typeof e.message === 'string' && e.message ? e.message.slice(0, 300) : `The module call failed (${String(e.code).slice(0, 40)}).`;
                    return Object.freeze({ status: 'error', meta: meta!, code, message, usage });
                }
                case 'done': {
                    const d = object(data, broken);
                    if (d.status !== 'ok') throw broken(`done.status is ${JSON.stringify(d.status)?.slice(0, 40)}, not ok`);
                    const sha = d.answerSha256;
                    const length = d.answerChars;
                    if (typeof sha !== 'string' || !HASH.test(sha)) throw broken('done.answerSha256 is not 64 lower-case hex digits');
                    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > BODY_DIAL.maxChars) {
                        throw broken(`done.answerChars is not 1 to ${BODY_DIAL.maxChars}`);
                    }
                    // The browser installs nothing but the whole text it hashed itself (the design §5).
                    const answer = unfence(text.join(''));
                    if (answer.length !== length || await sha256Hex(answer) !== sha) {
                        throw broken(`done names an answer of ${length} characters (${sha.slice(0, 12)}), not the ${answer.length} the deltas carry`);
                    }
                    return Object.freeze({ status: 'ok', meta: meta!, answer, answerSha256: sha, usage });
                }
                default:
                    // An event this reader does not know yet: additive by contract, so it is skipped (and was counted).
                    break;
            }
        }
    } finally {
        await events.return(undefined);
    }
    options.signal?.throwIfAborted();
    throw new ModuleStreamError('unavailable', res.status, job.jobId, 'the stream ended before its done or error: the connection dropped, or a proxy cut it', usage);
}

/** meta, held to the job: the server's echo of each field this browser sent, then its own few. */
function readMeta(data: string, job: ModuleJob, broken: (why: string) => ModuleStreamError): ModuleMeta {
    const m = object(data, broken);
    if (field(m, 'source', broken) !== 'live') throw broken(`meta.source is ${JSON.stringify(m.source)?.slice(0, 20)}, not live`);
    if (field(m, 'role', broken) !== 'module') throw broken(`meta.role is ${JSON.stringify(m.role)?.slice(0, 20)}, not module`);
    // Each echo against what was sent: a stream that answers another job is not this one's, whatever it carries.
    for (const key of ['turnId', 'jobId', 'purpose', 'module', 'interfaceHash'] as const) {
        if (field(m, key, broken) !== job[key]) throw broken(`meta echoes another job: its ${key} is ${JSON.stringify(m[key])?.slice(0, 40)}`);
    }
    for (const key of ['subject', 'versions'] as const) {
        const echoed = field(m, key, broken);
        let same = false;
        try { same = canonicalJson(echoed) === canonicalJson(job[key]); } catch { same = false; }
        if (!same) throw broken(`meta echoes another job: its ${key} differs`);
    }
    const generationId = string(m, 'generationId', broken);
    if (!ID.test(generationId)) throw broken('meta.generationId is not an id');
    const model = string(m, 'model', broken);
    const promptVersion = string(m, 'promptVersion', broken);
    if (!model || model.length > 100) throw broken('meta.model is not 1 to 100 characters');
    if (!promptVersion || promptVersion.length > 40) throw broken('meta.promptVersion is not 1 to 40 characters');
    return Object.freeze({
        ...job, subject: Object.freeze({ ...job.subject }), versions: Object.freeze({ ...job.versions }),
        generationId, model, source: 'live', role: 'module', promptVersion,
    });
}

function readUsage(data: string, broken: (why: string) => ModuleStreamError): ModuleUsage {
    const u = object(data, broken);
    const tokens = (key: string): number | null => {
        const v = field(u, key, broken);
        if (v === null) return null;
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw broken(`usage.${key} is not a whole number or null`);
        return v;
    };
    const cost = field(u, 'costMicroUsd', broken);
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) throw broken('usage.costMicroUsd is not a whole number');
    return Object.freeze({ in: tokens('in'), out: tokens('out'), reasoning: tokens('reasoning'), cached: tokens('cached'), costMicroUsd: cost });
}

function object(data: string, broken: (why: string) => ModuleStreamError): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw broken(`an event's data is not JSON: ${data.slice(0, 80)}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw broken(`an event's data is not an object: ${data.slice(0, 80)}`);
    return value as Record<string, unknown>;
}

function field(o: Record<string, unknown>, key: string, broken: (why: string) => ModuleStreamError): unknown {
    if (!Object.hasOwn(o, key)) throw broken(`"${key}" is missing`);
    return o[key];
}

function string(o: Record<string, unknown>, key: string, broken: (why: string) => ModuleStreamError): string {
    const v = field(o, key, broken);
    if (typeof v !== 'string') throw broken(`"${key}" is not a string`);
    return v;
}
