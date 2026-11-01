// The forge's streams (backend design guidelines §4; forge-loop-design.md §5.2): server-sent events named meta,
// delta, usage, done and error, with a comment line every 15 s as a heartbeat. parseEventStream reads the
// event-stream format (WHATWG HTML §9.2) for the parts the backend uses; readForgeStream holds the stream to its
// contract: meta first, one terminal event last, and a stream that ends without one is a failure, never a success.
// The fields Q26 added (accepted 2026-10-27: meta's role, fn and promptVersion; usage's reasoning and cached) are
// read when present and never required.

import { ERROR_STATUS, ForgeError, isErrorCode } from './errors';

export interface SseEvent {
    event: string;
    data: string;
}

/**
 * The events in an event-stream body, as they complete. Comments (the heartbeat), `id` and `retry` are skipped;
 * an event the stream ends in the middle of is dropped, as the format requires.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>, maxEventChars = 262_144): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    // UTF-8, decoded across chunk boundaries; a leading byte-order mark is dropped, as the format requires.
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data: string[] = [];
    let eventChars = 0;
    const checkSize = (size: number) => {
        if (size > maxEventChars) throw new ForgeError('upstream', 200,
            `An SSE event passed ${maxEventChars} characters; the client stopped reading it.`);
    };
    try {
        for (let done = false; !done;) {
            const chunk = await reader.read();
            done = chunk.done;
            buffer += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
            // Lines end in CRLF, LF or CR. A CR at the end of a chunk may be half of a CRLF still in flight; at the
            // end of the stream nothing can follow it, so it is a whole line end.
            if (done && buffer.endsWith('\r')) buffer += '\n';
            for (let end = lineEnd(buffer); end >= 0; end = lineEnd(buffer)) {
                const line = buffer.slice(0, end);
                checkSize(line.length);
                buffer = buffer.slice(buffer[end] === '\r' && buffer[end + 1] === '\n' ? end + 2 : end + 1);
                if (line === '') {
                    if (data.length) yield { event: event || 'message', data: data.join('\n') };
                    event = '';
                    data = [];
                    eventChars = 0;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                let fieldValue = colon < 0 ? '' : line.slice(colon + 1);
                if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
                if (field === 'event') event = fieldValue;
                else if (field === 'data') {
                    eventChars += fieldValue.length + 1;
                    checkSize(eventChars);
                    data.push(fieldValue);
                }
            }
            checkSize(buffer.length);
        }
    } finally {
        // Stopped early (a terminal event, a broken contract): cancelling the body closes the connection. After a
        // clean end it does nothing.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/**
 * `body`, stopping when `signal` aborts: the read rejects with the signal's reason and the body is cancelled. A real
 * fetch does this itself once its signal aborts; a body the caller built (a test's, the harness's) does not. The agent
 * turn's reader and a module call's both read through it.
 */
export function abortable(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let stop: () => void = () => {};
    return new ReadableStream<Uint8Array>({
        start(controller) {
            stop = () => {
                controller.error(signal.reason);
                reader.cancel(signal.reason).catch(() => {});
            };
            signal.addEventListener('abort', stop, { once: true });
        },
        async pull(controller) {
            const chunk = await reader.read();
            if (signal.aborted) return;
            if (chunk.done) {
                signal.removeEventListener('abort', stop);
                controller.close();
            } else {
                controller.enqueue(chunk.value);
            }
        },
        cancel(reason) {
            signal.removeEventListener('abort', stop);
            return reader.cancel(reason);
        },
    });
}

/** The index of the first complete line end in `s`, or -1. A trailing CR waits for the next chunk. */
function lineEnd(s: string): number {
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\n') return i;
        if (c === '\r') return i + 1 < s.length ? i : -1;
    }
    return -1;
}

export interface StreamMeta {
    generationId: string;
    model: string;
    /** `archive` when the backend replayed a recorded generation instead of calling a model. */
    source: 'live' | 'archive';
    role?: string;
    fn?: string;
    promptVersion?: string;
}

export interface StreamUsage {
    in: number;
    out: number;
    reasoning?: number;
    cached?: number;
}

export interface ForgeStreamHandlers {
    onMeta?(meta: StreamMeta): void;
    /** Each piece of visible text as it arrives, and the text so far. */
    onDelta?(text: string, soFar: string): void;
    onUsage?(usage: StreamUsage): void;
}

export interface ForgeStreamResult {
    meta: StreamMeta;
    text: string;
    usage: StreamUsage | null;
}

/** A model's answer is capped on the server by its role; this is the client's own bound on what it will hold. */
export const MAX_STREAM_CHARS = 65_536;

/**
 * Reads one forge stream to its terminal event: the whole text on `done`; a ForgeError on an `error` event (its
 * code, the status the response arrived with), and on a broken contract. The stream is cancelled once it ends.
 */
export async function readForgeStream(res: Response, handlers: ForgeStreamHandlers = {}, maxChars = MAX_STREAM_CHARS): Promise<ForgeStreamResult> {
    if (!res.body) throw broken(res, 'the response has no body');
    let meta: StreamMeta | null = null;
    let text = '';
    let usage: StreamUsage | null = null;
    const events = parseEventStream(res.body);
    try {
        for await (const { event, data } of events) {
            if (!meta) {
                if (event !== 'meta') {
                    if (event === 'error') throw streamError(res, data);
                    throw broken(res, `the first event was "${event}", not meta`);
                }
                meta = parseMeta(res, data);
                handlers.onMeta?.(meta);
                continue;
            }
            switch (event) {
                case 'meta':
                    throw broken(res, 'meta appeared more than once');
                case 'delta': {
                    const piece = field(json(res, data), 'text', 'string', res);
                    text += piece;
                    if (text.length > maxChars) {
                        throw new ForgeError('upstream', res.status, `The model's answer passed ${maxChars} characters; the client stopped reading it.`);
                    }
                    handlers.onDelta?.(piece, text);
                    break;
                }
                case 'usage': {
                    const u = json(res, data);
                    usage = { in: field(u, 'in', 'number', res), out: field(u, 'out', 'number', res) };
                    const { reasoning, cached } = u as { reasoning?: unknown; cached?: unknown };
                    if (typeof reasoning === 'number') usage.reasoning = reasoning;
                    if (typeof cached === 'number') usage.cached = cached;
                    handlers.onUsage?.(usage);
                    break;
                }
                case 'done':
                    if (field(json(res, data), 'status', 'string', res) !== 'ok') {
                        throw broken(res, 'done.status is not ok');
                    }
                    return { meta, text, usage };
                case 'error':
                    throw streamError(res, data);
                default:
                    // An event this client does not know yet: additive by contract, so it is skipped.
                    break;
            }
        }
    } finally {
        await events.return(undefined);
    }
    throw new ForgeError('unavailable', res.status, 'The stream ended before its last event: the connection dropped, or a proxy cut it.');
}

function parseMeta(res: Response, data: string): StreamMeta {
    const m = json(res, data);
    const source = field(m, 'source', 'string', res);
    if (source !== 'live' && source !== 'archive') throw broken(res, `meta.source is "${source}"`);
    const meta: StreamMeta = { generationId: field(m, 'generationId', 'string', res), model: field(m, 'model', 'string', res), source };
    for (const key of ['role', 'fn', 'promptVersion'] as const) {
        const v = (m as Record<string, unknown>)[key];
        if (typeof v === 'string') meta[key] = v;
    }
    return meta;
}

function streamError(res: Response, data: string): ForgeError {
    const e = json(res, data) as { code?: unknown; message?: unknown };
    const code = isErrorCode(e.code) ? e.code : 'internal';
    const message = typeof e.message === 'string' && e.message ? e.message.slice(0, 300) : `The stream failed (${String(e.code)}).`;
    return new ForgeError(code, res.ok ? res.status : ERROR_STATUS[code], message);
}

function json(res: Response, data: string): object {
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw broken(res, `an event's data is not JSON: ${data.slice(0, 80)}`); }
    if (!value || typeof value !== 'object') throw broken(res, `an event's data is not an object: ${data.slice(0, 80)}`);
    return value;
}

function field<T extends 'string' | 'number'>(o: object, key: string, type: T, res: Response): T extends 'string' ? string : number {
    const v = (o as Record<string, unknown>)[key];
    if (typeof v !== type || (type === 'number' && !Number.isFinite(v))) throw broken(res, `"${key}" is not a ${type}`);
    return v as T extends 'string' ? string : number;
}

/** The backend broke its own stream contract: a bug there, reported in a developer's words. */
function broken(res: Response, why: string): ForgeError {
    return new ForgeError('internal', res.status, `The forge stream broke its contract: ${why}.`);
}
