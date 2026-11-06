// One agent turn as Developer view shows it (the backend's agent-loop design §15.1, gate B2): the reader's events
// folded into a state, and a session that runs one turn at a time. Pure TypeScript over an AgentClient, so it runs
// under node --test with a fake client and an injected clock. A new turn supersedes the one before: that one is
// cancelled and closed, and anything it still says, or resolves to, is ignored; so is anything a turn says after its
// cancel. A hand-off means the server's pure check passed a design and a program. Nothing here builds, renders or swaps
// a world (EA3 resolves programs), so the running world is never touched, and the state says "checked, not rendered".

import type { SolutionDesign, WorldProgram } from '../contract/agent';
import type { AgentClient, AgentTurnRequest } from '../forge-client/agent-client';
import { AgentVersionError, type AgentCallRecord, type AgentEvent, type AgentFinding, type AgentMeta, type AgentTurnResult } from '../forge-client/agent-stream';
import { ForgeError } from '../forge-client/errors';

export type TurnPhase = 'running' | 'handed-off' | 'asked' | 'exhausted' | 'declined' | 'failed' | 'cancelled';

/**
 * How each phase reads, and whether it is a success: only a hand-off is, and only as checked. Asked, exhausted and
 * declined are honest ends of a turn, but no world comes of them.
 */
export const TURN_PHASES: Readonly<Record<TurnPhase, { label: string; tone: 'quiet' | 'ok' | 'warn' | 'err'; success: boolean; note: string }>> = {
    'running': { label: 'Running', tone: 'quiet', success: false, note: '' },
    'handed-off': {
        label: 'Handed off: checked, not rendered', tone: 'ok', success: true,
        note: 'The server\'s program check passed this design and program. Nothing was built or rendered from them, and the world on the stage is unchanged: resolving a program is EA3.',
    },
    'asked': {
        label: 'Asked a question: no world', tone: 'warn', success: false,
        note: 'A turn ends at its question. Add the answer to the idea and run the turn again: it follows this one inside the same world (Q120 (b)), once.',
    },
    'exhausted': { label: 'Stopped by a budget: no world', tone: 'warn', success: false, note: 'A turn budget refused the next call, or the turn\'s time ran out.' },
    'declined': { label: 'Declined by the model: no world', tone: 'warn', success: false, note: 'The model gave up on this request, with its reason.' },
    'failed': { label: 'Failed: no world', tone: 'err', success: false, note: '' },
    'cancelled': { label: 'Cancelled: no world', tone: 'quiet', success: false, note: 'Cancelled here. Anything the turn said after that is ignored.' },
};

/** The backend's words for why a call was made (AgentLoop's purposes), for a developer's line; another is shown as is. */
export const PURPOSES: Readonly<Record<string, string>> = {
    'first': 'first call',
    'after-tools': 'after the reads',
    'revise': 'a revision',
    'repair': 'a schema repair',
    'program': 'the program, after its design',
    'next': 'the next action',
};

export interface TurnCall extends AgentCallRecord {
    /** On the session's clock, in ms: when the call was charged, and when its usage came. */
    startedMs: number;
    answeredMs: number | null;
}

export interface AgentTurnState {
    /** Which of the session's turns this is, from 1. */
    seq: number;
    request: AgentTurnRequest;
    phase: TurnPhase;
    meta: AgentMeta | null;
    calls: TurnCall[];
    /** The latest check's findings; empty before a check. */
    findings: AgentFinding[];
    design: SolutionDesign | null;
    program: WorldProgram | null;
    question: string | null;
    /** Why it stopped, in the backend's words or the error's: exhausted, declined, failed. */
    reason: string | null;
    /** What goes with the reason: a diagnostic (EA_TURN_BUDGET, EA_VERSION_MISMATCH) or an error code (budget, upstream). */
    code: string | null;
    /**
     * When a refusal or failure from the transport ended the turn (a ForgeError): its HTTP status (0: no answer) and its
     * Retry-After in seconds, so the creator's sentence can say when early access's next world opens (EA9.1). Null otherwise.
     */
    httpStatus: number | null;
    retryAfterSeconds: number | null;
    /**
     * That refusal's code is its HTTP status's alone (ForgeError.bare: an edge's or a proxy's page, no envelope), so a
     * 403 there is no word on the account (the independent review of account-guards). False otherwise.
     */
    bare: boolean;
    /**
     * Its failure was the stream's own last event (ForgeError.terminal): the service ended the turn there. False for an
     * end the client decided or could not see (a cap, a dropped connection, a deadline). Q120 (b) retries only the first.
     */
    terminal: boolean;
    /** What the calls reported so far, in micro-USD: their costs, or their reservations when no usage came. */
    costMicroUsd: number;
    /** Calls that ended the turn without any usage: their cost is unknown, never zero. */
    unreported: number;
    /** On the session's clock, in ms. */
    startedMs: number;
    endedMs: number | null;
}

/** How long the turn has run, or ran: frozen once it has ended. */
export function elapsedMs(state: AgentTurnState, now: number): number {
    return (state.endedMs ?? now) - state.startedMs;
}

/**
 * The turn ended on the service's own last word: a `done` (handed off, asked, declined, exhausted), or its `error`
 * event (`terminal`). The loop sends each call's `call` before it dispatches the call, and makes none after its last
 * word, so the calls seen are every call the turn made. Not so for a cancel (a Stop, a newer turn), a dropped connection,
 * a deadline, or a cap or a contract of the client's: the service goes on until it sees the client go, and may make calls
 * this browser never hears of (the outside review of EA9.5, its mid).
 */
export function endSeen(state: AgentTurnState): boolean {
    switch (state.phase) {
        case 'handed-off':
        case 'asked':
        case 'declined':
        case 'exhausted': return true;
        case 'failed': return state.terminal;
        default: return false;
    }
}

function initial(seq: number, request: AgentTurnRequest, now: number): AgentTurnState {
    return {
        seq, request, phase: 'running', meta: null, calls: [], findings: [], design: null, program: null, question: null,
        reason: null, code: null, httpStatus: null, retryAfterSeconds: null, bare: false, terminal: false, costMicroUsd: 0, unreported: 0,
        startedMs: now, endedMs: null,
    };
}

/** The state after one checked event. The reader has held the events to their order, so the last call is theirs. */
export function reduceTurn(state: AgentTurnState, event: AgentEvent, now: number): AgentTurnState {
    const last = (change: Partial<TurnCall>): TurnCall[] => state.calls.map((c, i) => (i === state.calls.length - 1 ? { ...c, ...change } : c));
    switch (event.type) {
        case 'meta': return { ...state, meta: event.meta };
        case 'call': return { ...state, calls: [...state.calls, { ...event.call, usage: null, tools: null, check: null, startedMs: now, answeredMs: null }] };
        case 'usage': return { ...state, calls: last({ usage: event.usage, answeredMs: now }), costMicroUsd: state.costMicroUsd + event.usage.costMicroUsd };
        case 'tools': return { ...state, calls: last({ tools: event.tools }) };
        case 'check': return { ...state, calls: last({ check: event.check }), findings: event.check.findings };
        case 'design': return { ...state, design: event.design };
        case 'program': return { ...state, program: event.program };
        // A revision's notes to its modules (EA6.3): a first turn's reader refuses them, so this turn never holds any.
        case 'repairs': return state;
        case 'question': return { ...state, question: event.text };
    }
}

function finished(state: AgentTurnState, result: AgentTurnResult, now: number): AgentTurnState {
    const unreported = result.calls.filter(c => !c.usage).length;
    const end = { ...state, phase: result.status, unreported, endedMs: now };
    switch (result.status) {
        case 'handed-off': return { ...end, design: result.design, program: result.program };
        case 'asked': return { ...end, question: result.question };
        case 'exhausted': return { ...end, reason: result.reason, code: result.diagnostic };
        case 'declined': return { ...end, reason: result.reason };
    }
}

function failed(state: AgentTurnState, error: unknown, now: number): AgentTurnState {
    const end = { ...state, unreported: state.calls.filter(c => !c.usage).length, endedMs: now };
    if ((error as Error)?.name === 'AbortError') return { ...end, phase: 'cancelled' };
    if (error instanceof AgentVersionError) return { ...end, phase: 'failed', code: 'EA_VERSION_MISMATCH', reason: error.message };
    if (error instanceof ForgeError) {
        // Where it came from: an envelope before any stream (its status), the stream itself (200), or no answer at all.
        const where = error.status === 0 ? 'no answer' : error.status === 200 ? 'in the stream' : `HTTP ${error.status}`;
        return {
            ...end, phase: 'failed', code: error.code, reason: `${where}: ${error.message}`, httpStatus: error.status, retryAfterSeconds: error.retryAfterSeconds,
            bare: error.bare, terminal: error.terminal === true,
        };
    }
    return { ...end, phase: 'failed', code: 'internal', reason: (error as Error)?.message ?? String(error) };
}

export interface AgentSession {
    /** The current turn's state; null before the first. */
    readonly state: AgentTurnState | null;
    /** Runs a turn, cancelling the one still running; resolves with the turn's last state, however it ended. */
    start(request: AgentTurnRequest): Promise<AgentTurnState>;
    /** Cancels the running turn, if one is; it is shown cancelled at once. */
    cancel(): void;
}

interface Turn {
    seq: number;
    controller: AbortController;
    state: AgentTurnState;
    /** Ended, cancelled or superseded: nothing it says or resolves to changes anything after. */
    closed: boolean;
}

/** One turn at a time over `client`, each state handed to `onChange` as it happens; `now` is the clock, in ms. */
export function createAgentSession(client: AgentClient, onChange: (state: AgentTurnState) => void, now: () => number = () => performance.now()): AgentSession {
    let seq = 0;
    let current: Turn | null = null;
    const publish = (turn: Turn) => {
        if (current === turn) onChange(turn.state);
    };
    return {
        get state() {
            return current?.state ?? null;
        },
        async start(request) {
            const previous = current;
            if (previous && !previous.closed) {
                // Superseded: closed before it is aborted, so its own rejection and any late event are ignored. Its
                // caller hears it was cancelled; the view hears nothing more of it.
                previous.closed = true;
                previous.state = { ...previous.state, phase: 'cancelled', unreported: previous.state.calls.filter(c => !c.usage).length, endedMs: now() };
                previous.controller.abort();
            }
            const turn: Turn = { seq: ++seq, controller: new AbortController(), state: initial(seq, request, now()), closed: false };
            current = turn;
            publish(turn);
            const apply = (event: AgentEvent) => {
                if (turn.closed) return;
                turn.state = reduceTurn(turn.state, event, now());
                publish(turn);
            };
            try {
                const result = await client.turn(request, apply, turn.controller.signal);
                if (!turn.closed) turn.state = finished(turn.state, result, now());
            } catch (error) {
                if (!turn.closed) turn.state = failed(turn.state, error, now());
            }
            if (!turn.closed) {
                turn.closed = true;
                publish(turn);
            }
            return turn.state;
        },
        cancel() {
            const turn = current;
            if (!turn || turn.closed) return;
            turn.closed = true;
            turn.controller.abort();
            turn.state = { ...turn.state, phase: 'cancelled', unreported: turn.state.calls.filter(c => !c.usage).length, endedMs: now() };
            publish(turn);
        },
    };
}
