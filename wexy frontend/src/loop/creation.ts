// The creation controller (EA9.1; agent-first-studio-design.md §3, §5 and §6; Q114, Q115 and Q118 decided by the user on
// 2026-11-03): one owner for a creation, from the creator's Create to the world on the stage. Create runs one agent turn
// and, once it hands off, writes its modules, their repairs included, as one attempt inside Q_C and W1's one world
// (Q118); no visual refinement runs by itself. Then it waits: "Show it" is the GPU go (Q115 (a)), the host's alone (I5).
// Developer view's panels watch this same controller, and their presses are presses on it (§3), so I1 holds in both views:
// "Run agent turn" is a Create that stops at the hand-off, "Write the modules" a new attempt from it, Run the go.
//
// Plain TypeScript over injected seams (one turn session, a factory of candidate sessions, the studio's stage, the
// account), so it runs under node --test with fakes, as agent-turn.ts and candidate.ts do. It holds no DOM, allocates no
// GPU object, and reaches none of h1's loop.
//
//   κ (n)       moves at each Create, each write, each cancel, a paid creation stopped by an account change, and a device
//               loss: the stage's Present reads it, so a Run under way stops at its next check (executor.ts)
//   creations   each with its own candidate session (I8): a new idea never starts on the session of the world on the
//               stage, which keeps its candidate, its review's binding and its budget until another world replaces it
//   ends        asked, declined, exhausted, failed, a candidate's stop, a Run refused, a cancel, an account change, a
//               device loss: each leaves the stage as it was and says one sentence (P2); a quota or a spent allowance
//               opens W1's dialog (the account port's `limit`). A Run refused or stopped is no end: its world, written
//               and paid for, waits for Show it again
//   kept        a world written and waiting for its go stays the creator's while a new idea's turn waits for its
//               admission, and comes back if that turn is refused at entry or stopped before it (Q126 (b))
//   staleness   every continuation checks, after each await, that its creation is neither superseded nor ended and that
//               its account is still the one signed in (I9): a late answer changes nothing and opens no dialog

import type { CompiledBody } from '../contract/adapters/bodies';
import type { DeepReadonly } from '../contract/engine/frozen';
import { cutCodePoints } from '../contract/text';
import type { AgentTurnRequest } from '../forge-client/agent-client';
import { ForgeError, isErrorCode } from '../forge-client/errors';
import type { AgentSession, AgentTurnState } from './agent-turn';
import { turnCallsOf, type CandidateSession, type CandidateState, type HandOff } from './candidate';
import { COPY } from './copy';
import { classifyError } from './failures';
import type { SealedCandidate } from './snapshot';

type Snapshot = DeepReadonly<SealedCandidate>;
type Compiled = readonly DeepReadonly<CompiledBody>[];
type Candidate = DeepReadonly<CandidateState>;

/**
 * Where a creation stands. `handed-off` is Developer view's alone: its turn stops there until "Write the modules". `ready`
 * waits for "Show it"; `installed` means its world is the one on the stage.
 */
export type CreationPhase = 'idle' | 'turn' | 'handed-off' | 'writing' | 'ready' | 'running' | 'installed' | 'stopped' | 'cancelled';
/** The Journey's four rows (journey.ts's StageId; guidelines §2's four steps). */
export type CreationRow = 'plan' | 'build' | 'check' | 'ready';
export type StepState = 'pending' | 'running' | 'done' | 'failed';
/** Why W1's limit dialog opens: the anonymous allowance spent, or early access's world of the day made. */
export type LimitKind = 'allowance' | 'quota';

/** What a Run came to (EA5.3): installed, or why not in the developer's words, and the probe's numbers in one line. */
export interface RunSummary {
    status: 'installed' | 'refused' | 'stopped' | 'failed';
    /** The developer's words: why it did not install; null when it did. */
    reason: string | null;
    /** The probe's and the sanity look's numbers, in one line; empty when none ran. */
    numbers: string;
}

/** What the studio is told of a creation's world as it installs it: its title, from the idea (§8.6). */
export interface RunAbout {
    readonly title: string;
}

/** The studio's stage as the controller reaches it (EA5.3, Q89, Q115): why it cannot run now, and the go. */
export interface CreationStage {
    /** Why a Run cannot start now (no stage yet, a Run, a capture, a film), or null. */
    blocked(): string | null;
    /** The GPU go for this sealed candidate, then its Run; an install puts it on the stage. */
    go(snapshot: Snapshot, compiled: Compiled, about?: RunAbout): Promise<RunSummary>;
}

/** The account as a creation needs it (W1, W2): who is signed in (E_auth), W1's dialog, and the read after an entry. */
export interface CreationAccount {
    /** E_auth now (AccountSession's epoch): it moves when the account or its provider changes. */
    epoch(): number;
    /**
     * A caller is signed in now, as the session last read it, so a creation's E_auth is bound at once. False before any
     * reading (a first visit) and after a sign-out: the next call then makes a new anonymous caller.
     */
    established(): boolean;
    /**
     * With no caller established: makes or finds the one this entry's calls go out as (the transport's own lazy sign-in)
     * and reads who it is (§6 step 1). E_auth is bound after it, so learning that first identity moves the session's epoch
     * without being a switch away from anyone. Throws when no caller could be made.
     */
    enter(): Promise<void>;
    /** A sign-in, a sign-out or a collision's sign-in is under way: Create waits (W1's review). */
    changing(): boolean;
    /** Calls `listener` whenever the session changes; returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** After an entry call: who it made or found, and what the server says is left (AccountControl.afterEntry). */
    afterEntry(): void | Promise<void>;
    /** W1's limit dialog, with the sentence the refusal earned. */
    limit(kind: LimitKind, sentence: string): void;
}

export interface CreationDeps {
    /** The one turn session, made once: the controller hands it its listener. */
    turnSession(onChange: (state: AgentTurnState) => void): AgentSession;
    /** A candidate session for one creation, made at its first write; absent, a hand-off is where a creation stops. */
    candidateSession?(onChange: (state: Candidate) => void): CandidateSession;
    /** The studio's stage; absent, nothing is shown (a harness, or a page with no WebGPU). */
    stage?: CreationStage;
    /** The account; absent, every creation is one caller's (no backend account, a harness). */
    account?: CreationAccount;
    /** The clock its steps are timed by, in ms (EA9.2): `performance.now` unless a test says otherwise. */
    now?: () => number;
}

export interface CreationStep {
    readonly state: StepState;
    /** The creator's words for it: what is happening, what it came to, or why it stopped. */
    readonly detail: string;
    /** A running step's start, on the controller's clock: the view counts its elapsed time from it (EA9.2). */
    readonly since: number | null;
    /** How long a done step took, in ms; null when it was not timed here. */
    readonly took: number | null;
}

/** The controller's state, for the creator's view (the steps, the sentence) and Developer view (the turn, the candidate). */
export interface CreationState {
    /** κ. */
    readonly n: number;
    readonly phase: CreationPhase;
    readonly steps: Readonly<Record<CreationRow, CreationStep>>;
    /** Why it stopped, or why its last Run did not install, in one sentence; null otherwise. */
    readonly sentence: string | null;
    /** The turn's question, when it asked one (model-written: shown as text). */
    readonly question: string | null;
    /** The limit dialog its end opened; for a world given back (Q126 (b)), the one the newer idea's refusal opened. */
    readonly limit: LimitKind | null;
    readonly idea: AgentTurnRequest | null;
    /** The idea's title (titleOf), what the HUD names its world. */
    readonly title: string | null;
    readonly turn: AgentTurnState | null;
    readonly handOff: HandOff | null;
    readonly candidate: Candidate | null;
    /** The last Run of the candidate shown, while that candidate is the one shown. */
    readonly run: RunSummary | null;
    /** A world this controller made is on the stage. */
    readonly onStage: boolean;
}

export interface CreationController {
    readonly state: CreationState;
    /** κ, the stage's Present turn. */
    readonly n: number;
    /** The current creation's candidate session, which Developer view's candidate shows; null before its first write. */
    readonly session: CandidateSession | null;
    /**
     * The session whose candidate is on the stage (H's, I8): the review's. Null when none of this controller's worlds is
     * there, once the account it was made under is no longer signed in (its paid actions go with it, §6), and after a
     * device loss.
     */
    readonly installedSession: CandidateSession | null;
    /**
     * The session holding `candidate`, the one on the stage, for the review's paid actions (I8): H's, or the current
     * creation's while its install settles; null when none of this controller's does, its account is no longer the one
     * signed in, or the device was lost.
     */
    sessionFor(candidate: string | null): CandidateSession | null;
    /** Paid work or a Run is under way: Create reads Stop, and the account waits. */
    readonly busy: boolean;
    /**
     * A new creation, not a round on the world on the stage, is under way or waits for its go: the review's paid actions
     * wait (§6), so a round on the world on the stage never strands a paid world written for Show it.
     */
    readonly creating: boolean;
    /** A stage was handed in: worlds can be shown ("Run on this GPU" is offered). */
    readonly showable: boolean;
    /** Why the stage cannot run now, in its own words (no stage, a Run, a capture), or null. */
    stageBlocked(): string | null;
    subscribe(listener: (state: CreationState) => void): () => void;
    /**
     * Create: a turn, then its modules unless `write` is false (Developer view's step). It supersedes the creation before,
     * except a world written and waiting for its go, which is kept until the new turn is admitted and given back if it is
     * not (Q126 (b)).
     */
    create(idea: AgentTurnRequest, options?: { write?: boolean }): Promise<CreationState>;
    /** "Write the modules" (Developer view): the current hand-off's modules, as a new attempt once one has run. */
    write(): Promise<CreationState>;
    /** "Show it" (Q115 (a)): the GPU go for the candidate ready now. A second press while one runs makes no second Run. */
    show(): Promise<RunSummary | null>;
    /** Why Create cannot start now, or null. */
    createBlocked(): string | null;
    /** Why "Show it" cannot be pressed now, or null. */
    showBlocked(): string | null;
    /**
     * Stop: ends the turn or the attempt under way at its next check, and nothing is applied. A Run stops the same way,
     * and its world, written and checked, waits for Show it again (a new go).
     */
    cancel(): void;
    /**
     * The device was lost: its generation moved, every verdict and go is void (executor §7), the creation stops, and
     * nothing more is made or shown on this page (Create, Show it and the review's paid actions wait for a reload).
     */
    deviceLost(): void;
    /** Another world took the stage (h1's, a replay's): the session of the one that was there is released. */
    replaced(): void;
    /** The studio is done with it: anything under way is cancelled, listeners dropped. */
    dispose(): void;
}

/** A title has at most this many characters (grapheme clusters), its ellipsis included (§8.6, EA9-U10). */
export const TITLE_CHARS = 48;
/** A question is shown at most this long, in code points. */
const QUESTION_CHARS = 300;

/**
 * An agent world's title, from its idea (§8.6): S has none. The first sentence, its closing full stops dropped; past
 * {@link TITLE_CHARS} characters it is cut at a word where one is near, with an ellipsis, and never inside a character
 * (an emoji with its joiners and modifiers stays whole).
 */
export function titleOf(prompt: string): string {
    const text = prompt.replace(/\s+/g, ' ').trim();
    const first = firstSentence(text).replace(/\.+$/, '').trim() || text;
    const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(first)].map(s => s.segment);
    if (chars.length <= TITLE_CHARS) return first;
    let cut = chars.slice(0, TITLE_CHARS - 1).join('');
    const space = cut.lastIndexOf(' ');
    if (space >= TITLE_CHARS / 2) cut = cut.slice(0, space);
    return `${cut.replace(/[\s,;:–—-]+$/u, '')}…`;
}

/**
 * A Run that did not install, in the creator's words (G4, EA9.2; §11), chosen by the code its reason starts with, never
 * by its prose: a measurement that came out unclear says try again, a world too heavy for this device a simpler idea.
 */
export function runSentence(reason: string | null): string {
    switch (/^(EA_[A-Z_]+)/.exec(reason ?? '')?.[1]) {
        case 'EA_PROBE_UNVERIFIED': return COPY.creation.runUnclear;
        case 'EA_PROBE':
        case 'EA_ADMIT': return COPY.creation.runHeavy;
        case 'EA_SANITY': return COPY.creation.runDrawn;
        case 'EA_CALL': return COPY.creation.runBuilt;
        default: return COPY.creation.runRefused;
    }
}

/** Words a full stop ends inside a sentence: before a name ("Mt. Fuji", "St. Basil's"), and Latin ("e.g."). */
const ABBREVIATIONS: ReadonlySet<string> = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'ft', 'jr', 'sr', 'prof', 'no', 'vs', 'e.g', 'i.e']);

/**
 * The idea's first sentence: up to the first ".", "!" or "?" (or a run of them, "...") that ends one. A full stop after
 * an abbreviation, after the idea's first word alone ("Dr. Who's TARDIS"), or after a list's number ("1. A castle
 * 2. A moat") ends none (the EA9.1 review).
 */
function firstSentence(text: string): string {
    for (const m of text.matchAll(/[.!?]+(?=\s|$)/g)) {
        const before = text.slice(0, m.index);
        const word = /(?:^|\s)(\S+)$/.exec(before)?.[1] ?? '';
        if (m[0].startsWith('.') && (!/\s/.test(before) || /^\d+$/.test(word) || ABBREVIATIONS.has(word.toLowerCase()))) continue;
        return text.slice(0, m.index + m[0].length);
    }
    return text;
}

/** A handed-off turn's state as the hand-off its candidate starts from; null for any other end. */
export function handOffFrom(s: AgentTurnState): HandOff | null {
    if (s.phase !== 'handed-off' || !s.meta || !s.design || !s.program) return null;
    return {
        turnId: s.meta.turnId, request: s.request, design: s.design, program: s.program, model: s.meta.model, promptVersion: s.meta.promptVersion,
        calls: turnCallsOf(s.calls),
    };
}

const WRITING: ReadonlySet<string> = new Set(['resolving', 'authoring', 'checking', 'correcting']);
const BUSY: ReadonlySet<CreationPhase> = new Set(['turn', 'writing', 'running']);
const ROWS: readonly CreationRow[] = ['plan', 'build', 'check', 'ready'];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** What a candidate waiting for its go says: of its last Run, or of the newer idea that did not start (Q126 (b)). */
interface Notice {
    readonly sentence: string;
    /** Refused or failed: its step reads failed. A Stop is the creator's own: the step waits for Show it again. */
    readonly failed: boolean;
    /** The limit dialog the newer idea's refusal opened, when one did. */
    readonly limit?: LimitKind | null;
}

interface End {
    phase: 'stopped' | 'cancelled';
    /** The row it stopped on. */
    at: CreationRow;
    sentence: string | null;
    question: string | null;
    limit: LimitKind | null;
}

interface Creation {
    readonly idea: AgentTurnRequest;
    readonly title: string;
    /** Developer view's turn: it stops at the hand-off until "Write the modules". */
    readonly manual: boolean;
    /**
     * E_auth its calls are bound to: that account's (I9). Null without an account port, and while a Create with no caller
     * established makes its own (create's first step): no move of the epoch stops it until its caller is known.
     */
    authEpoch: number | null;
    /** Its own (I8), made at its first write. */
    session: CandidateSession | null;
    turn: AgentTurnState | null;
    handOff: HandOff | null;
    candidate: Candidate | null;
    /** Its go is under way. */
    running: boolean;
    run: { candidate: string; summary: RunSummary } | null;
    /** The id(C) of its candidate on the stage; null when none of its is. */
    onStage: string | null;
    /** Its last Run was refused, failed or stopped: the creator's sentence, and "Show it" offered again. */
    notice: Notice | null;
    /** Its steps' times on the controller's clock (EA9.2): each running step's start, each done one's length. */
    planSince: number;
    planMs: number | null;
    buildSince: number | null;
    buildMs: number | null;
    runSince: number | null;
    runMs: number | null;
    end: End | null;
    /** Superseded or released: nothing it says or resolves to changes anything after. */
    closed: boolean;
}

/** The turn's failure in the creator's words (failures.ts, as h1's plan's), and the limit dialog it opens. */
function turnFailure(t: AgentTurnState): { sentence: string; limit: LimitKind | null } {
    if (!t.code || !isErrorCode(t.code)) return { sentence: COPY.failures.internal, limit: null };
    const f = classifyError(new ForgeError(t.code, t.httpStatus ?? 0, t.reason ?? '', t.retryAfterSeconds), 'plan');
    return { sentence: f.sentence, limit: f.kind === 'allowance' ? 'allowance' : f.kind === 'quota' ? 'quota' : null };
}

function phaseOf(c: Creation): CreationPhase {
    if (c.end) return c.end.phase;
    if (c.running) return 'running';
    const s = c.candidate;
    if (!s) return c.turn?.phase === 'handed-off' ? (c.manual || !c.session ? 'handed-off' : 'writing') : 'turn';
    if (WRITING.has(s.phase)) return 'writing';
    const sealed = c.session?.snapshot ?? null;
    if (s.phase === 'static-verified' && sealed) {
        if (sealed.id === c.onStage) return 'installed';
        if (c.session?.compiled) return 'ready';
    }
    // A round on the world on the stage that brought no new world: that world is still there, as its review says.
    if (c.onStage) return 'installed';
    // The attempt has ended, and its continuation is about to say how.
    return 'writing';
}

function rowOf(phase: CreationPhase): CreationRow {
    switch (phase) {
        case 'handed-off':
        case 'writing': return 'build';
        case 'ready':
        case 'running': return 'check';
        case 'installed': return 'ready';
        default: return 'plan';
    }
}

/** The Journey's four rows for `c`: counts and plain words only (§7; guidelines §2). */
function stepsOf(c: Creation | null, phase: CreationPhase): Record<CreationRow, CreationStep> {
    const step = (state: StepState, detail: string, since: number | null = null, took: number | null = null): CreationStep => ({ state, detail, since, took });
    const pending = (detail = ''): CreationStep => step('pending', detail);
    const steps: Record<CreationRow, CreationStep> = { plan: pending(), build: pending(), check: pending(), ready: pending() };
    if (!c) return steps;
    const modules = c.candidate?.modules ?? [];
    const total = modules.length;
    const written = modules.filter(m => m.phase === 'passed').length;
    // Counts and elapsed time, never a percentage or an estimate (§7; guidelines §2): each done step says how long it took.
    const done: Record<CreationRow, CreationStep> = {
        plan: step('done', COPY.creation.planned, null, c.planMs),
        build: step('done', total ? COPY.creation.written(total) : '', null, c.buildMs),
        check: step('done', COPY.runs, null, c.runMs),
        ready: step('done', COPY.ready),
    };
    const at = c.end ? c.end.at : rowOf(phase);
    ROWS.slice(0, ROWS.indexOf(at)).forEach(row => { steps[row] = done[row]; });
    if (c.end) {
        steps[at] = step('failed', c.end.sentence ?? '');
        return steps;
    }
    switch (phase) {
        case 'turn': steps.plan = step('running', COPY.creation.planning, c.planSince); break;
        case 'handed-off': steps.build = pending(COPY.creation.writingStart); break;
        case 'writing': steps.build = step('running', total ? COPY.creation.writing(written, total) : COPY.creation.writingStart, c.buildSince); break;
        case 'ready': steps.check = c.notice ? step(c.notice.failed ? 'failed' : 'pending', c.notice.sentence) : pending(COPY.creation.readyToShow); break;
        case 'running': steps.check = step('running', COPY.creation.testing, c.runSince); break;
        case 'installed': steps.check = done.check; steps.ready = done.ready; break;
        default: break;
    }
    return steps;
}

/** One creation at a time over `deps` (§6); each state handed to its listeners as it happens. */
export function createCreationController(deps: CreationDeps): CreationController {
    let n = 0;
    let current: Creation | null = null;
    /** H: the creation whose candidate is on the stage. */
    let installed: Creation | null = null;
    /** The creation whose turn the turn session runs now. */
    let turnOwner: Creation | null = null;
    let disposed = false;
    /** The device was lost: nothing more can be checked or shown on this page, so nothing more is paid for (I6). */
    let lost = false;
    /** A world written and waiting for its go, kept while the newer creation's turn waits for its admission (Q126 (b)). */
    let kept: Creation | null = null;
    const clock = deps.now ?? (() => performance.now());
    const listeners = new Set<(state: CreationState) => void>();
    let state: CreationState = view();
    const turns = deps.turnSession(s => {
        const c = turnOwner;
        if (!c || c.closed) return;
        c.turn = s;
        // Admitted the moment its stream begins (meta, after W1's entry admission): a world kept for its go goes then, so
        // a newer Create that supersedes this one cannot bring it back (Q126 (b): once admitted, it goes; the EA9.2 review).
        if (s.meta && kept && current === c) decide(c, true);
        publish(c);
    });
    const offAccount = deps.account?.subscribe(() => accountMoved()) ?? null;

    function view(): CreationState {
        const c = current;
        const phase: CreationPhase = c ? phaseOf(c) : 'idle';
        const shown = c?.session?.snapshot?.id ?? null;
        return Object.freeze({
            n, phase, steps: Object.freeze(stepsOf(c, phase)),
            sentence: c?.end?.sentence ?? (phase === 'ready' ? c?.notice?.sentence ?? null : null),
            question: c?.end?.question ?? null,
            limit: c?.end?.limit ?? (phase === 'ready' ? c?.notice?.limit ?? null : null),
            idea: c?.idea ?? null,
            title: c?.title ?? null,
            turn: c?.turn ?? null,
            handOff: c?.handOff ?? null,
            candidate: c?.candidate ?? null,
            run: c?.run && shown !== null && c.run.candidate === shown ? c.run.summary : null,
            onStage: installed !== null,
        });
    }

    /** The views hear the current creation, and H's (an improvement of the world on the stage); nothing else's. */
    function publish(from?: Creation): void {
        if (from && from !== current && from !== installed) return;
        state = view();
        for (const listener of [...listeners]) listener(state);
    }

    const accountMovedFor = (c: Creation) => !!deps.account && c.authEpoch !== null && deps.account.epoch() !== c.authEpoch;
    const improving = (c: Creation | null) => !!c && c === installed && WRITING.has(c.candidate?.phase ?? '');
    /**
     * A creation other than H's is under way or waits for its go (handed off, or written and checked): a round on H would
     * take the views from it and strand it, paid for and out of reach (the EA9.1 review), so the review's paid actions wait.
     */
    const replacing = () => !!current && current !== installed && !current.closed && !current.end;

    function newCreation(idea: AgentTurnRequest, manual: boolean, from?: Creation): Creation {
        // E_auth: the attempt's own turn's, an established caller's now, or (no caller yet) bound once create() has made one.
        const authEpoch = from ? from.authEpoch : deps.account?.established() ? deps.account.epoch() : null;
        return {
            idea, title: titleOf(idea.prompt), manual, authEpoch, session: null,
            turn: from?.turn ?? null, handOff: from?.handOff ?? null, candidate: null, running: false, run: null, onStage: null, notice: null,
            planSince: clock(), planMs: from?.planMs ?? null, buildSince: null, buildMs: null, runSince: null, runMs: null,
            end: null, closed: false,
        };
    }

    function sessionOf(c: Creation): CandidateSession | null {
        if (!c.session && deps.candidateSession) c.session = deps.candidateSession(s => onCandidate(c, s));
        return c.session;
    }

    function onCandidate(c: Creation, s: Candidate): void {
        if (c.closed) return;
        const was = c.candidate?.phase ?? null;
        c.candidate = s;
        // Its writing timed (EA9.2), a round on the world on the stage's as well: from its first phase to its last.
        if (WRITING.has(s.phase) && (was === null || !WRITING.has(was))) c.buildSince = clock();
        if (!WRITING.has(s.phase) && was !== null && WRITING.has(was) && c.buildSince !== null) c.buildMs = clock() - c.buildSince;
        if (WRITING.has(s.phase)) {
            c.notice = null;
            // A round on the world on the stage (the review's "Improve it"): the views follow it, unless another creation
            // is under way or waits for its go (it cannot be: the review's paid actions wait while one is, and Create
            // while a round is).
            if (c === installed && c !== current && !replacing()) current = c;
        }
        publish(c);
    }

    /** Ends `c` where it is, with its one sentence; a limit opens W1's dialog. Once. */
    function finish(c: Creation, phase: End['phase'], sentence: string | null, extra: { question?: string | null; limit?: LimitKind | null } = {}): void {
        if (c.end || c.closed) return;
        c.end = { phase, at: rowOf(phaseOf(c)), sentence, question: extra.question ?? null, limit: extra.limit ?? null };
        if (c.end.limit && c.end.sentence) deps.account?.limit(c.end.limit, c.end.sentence);
        publish(c);
    }

    /** A newer creation took its place: its turn and its attempt cancelled, nothing of it shown again. Never H's (I8). */
    function supersede(c: Creation): void {
        if (c.closed || c === installed) return;
        c.closed = true;
        if (turnOwner === c) {
            turnOwner = null;
            turns.cancel();
        }
        c.session?.cancel();
    }

    /** `c` left the stage, or never will reach it: its session goes, and every paid action on it. */
    function release(c: Creation): void {
        c.onStage = null;
        c.closed = true;
        c.session?.cancel();
    }

    /**
     * A newer creation takes `c`'s place. A world written and waiting for its go is kept, unshown, until the newer one's
     * turn is admitted (Q126 (b), the user, 2026-11-03): it runs nothing, so nothing of it is cancelled yet. Any other is
     * superseded.
     */
    function setAside(c: Creation): void {
        if (c !== installed && !c.closed && !c.end && phaseOf(c) === 'ready') {
            if (kept && kept !== c) release(kept);
            kept = c;
            return;
        }
        supersede(c);
    }

    /**
     * The newest creation `c`'s turn is decided (Q126 (b)). Admitted (its stream began), the world kept for its go goes.
     * Not admitted (refused at entry, unanswered, stopped, its caller not made, the account changed), that world comes
     * back, ready, its sentence saying why the new idea did not start. A superseded creation decides nothing: the kept
     * world is the next one's to decide.
     */
    function decide(c: Creation, admitted: boolean): void {
        const w = kept;
        if (!w || current !== c) return;
        kept = null;
        if (admitted) {
            release(w);
            return;
        }
        const why = c.end && c.end.phase !== 'cancelled' ? c.end.sentence : null;
        w.notice = { sentence: why ? COPY.creation.kept(why) : COPY.creation.keptStopped, failed: false, limit: c.end?.limit ?? null };
        current = w;
        publish(w);
    }

    function createBlocked(): string | null {
        if (disposed) return 'the studio is done with this controller';
        // A world made now could never be shown here: its turn and modules would be paid for nothing (the EA9.1 review).
        if (lost) return 'the device was lost: the page must be reloaded before another world is made';
        if (deps.account?.changing()) return 'the account is changing: Create waits until it is done';
        if (improving(installed)) return 'an improvement of the world on the stage is under way';
        return null;
    }

    async function create(idea: AgentTurnRequest, options: { write?: boolean } = {}): Promise<CreationState> {
        if (!idea.prompt.trim() || createBlocked() !== null) return state;
        n++;
        if (current) setAside(current);
        const c = newCreation(idea, options.write === false);
        current = c;
        publish(c);
        const account = deps.account;
        if (account && c.authEpoch === null) {
            // No caller yet (a first visit, or a sign-out): the one this Create's calls go out as is made or found first,
            // and E_auth bound to it after (§6 step 1, I9). Its own anonymous sign-in moves the session's epoch, which is
            // no switch, so nothing is stopped; a switch after the binding still stops the creation's paid work.
            try {
                await account.enter();
            } catch {
                finish(c, 'stopped', COPY.failures['sign-in']);
                decide(c, false);
                return state;
            }
            if (c.closed || c.end) {
                decide(c, false);
                return state;
            }
            c.authEpoch = account.epoch();
        }
        // The turn session is this creation's only from here: what the one it superseded still says is not shown as its.
        turnOwner = c;
        let end: AgentTurnState;
        try {
            end = await turns.start(idea);
        } finally {
            if (turnOwner === c) turnOwner = null;
            // The call made or found an identity: who it is, and what the server says is left (W1), however it ended.
            if (deps.account) void Promise.resolve().then(() => deps.account?.afterEntry()).catch(() => {});
        }
        if (!c.closed && !c.end) ended(c, end);
        // Admitted once its stream began: meta is the backend's first word, after the entry's admission (W1). An entry's
        // refusal comes before any stream.
        decide(c, end.meta !== null);
        if (c.closed || c.end || c.manual || !deps.candidateSession) {
            if (!c.closed && !c.end) publish(c);
            return state;
        }
        return writing(c);
    }

    /** What `c`'s turn came to: its hand-off, or its end in one sentence. */
    function ended(c: Creation, end: AgentTurnState): void {
        c.turn = end;
        if (accountMovedFor(c)) {
            finish(c, 'stopped', COPY.creation.accountChanged);
            return;
        }
        switch (end.phase) {
            case 'handed-off':
                c.handOff = handOffFrom(end);
                c.planMs = clock() - c.planSince;
                if (!c.handOff) finish(c, 'stopped', COPY.failures.internal);
                return;
            case 'asked': {
                const question = cutCodePoints(end.question ?? '', QUESTION_CHARS);
                finish(c, 'stopped', COPY.creation.asked(question), { question });
                return;
            }
            case 'declined':
                finish(c, 'stopped', COPY.creation.declined);
                return;
            case 'exhausted':
                finish(c, 'stopped', COPY.creation.exhausted);
                return;
            case 'failed': {
                const f = turnFailure(end);
                finish(c, 'stopped', f.sentence, { limit: f.limit });
                return;
            }
            case 'cancelled':
            case 'running':
                finish(c, 'cancelled', COPY.creation.cancelled);
        }
    }

    /** Writes `c`'s hand-off as its attempt, to ready (Show it waits) or to its end. */
    async function writing(c: Creation): Promise<CreationState> {
        const session = sessionOf(c);
        const handOff = c.handOff;
        if (!session || !handOff) return state;
        const st = await session.start(handOff);
        if (c.closed || c.end) return state;
        if (accountMovedFor(c)) {
            finish(c, 'stopped', COPY.creation.accountChanged);
            return state;
        }
        if (st.phase === 'static-verified') {
            // Show it needs this device's verdict on every body (EA5.1); without one this device cannot test it.
            if (!session.snapshot || !session.compiled) finish(c, 'stopped', COPY.creation.notHere);
            else publish(c);
            return state;
        }
        if (st.phase === 'cancelled' || st.phase === 'superseded') {
            finish(c, 'cancelled', COPY.creation.cancelled);
            return state;
        }
        const stop = st.stop;
        const limit: LimitKind | null = stop?.code === 'quota' ? 'quota' : stop?.code === 'account-required' ? 'allowance' : null;
        finish(c, 'stopped', stop?.sentence ?? COPY.candidate.refused, { limit });
        return state;
    }

    async function write(): Promise<CreationState> {
        const from = current;
        if (disposed || lost || !from?.handOff || !deps.candidateSession || deps.account?.changing() || accountMovedFor(from)) return state;
        // One attempt at a time: while one is written, only Cancel is offered.
        if (WRITING.has(from.candidate?.phase ?? '')) return state;
        n++;
        let c = from;
        if (from.session || from === installed || from.end || from.closed) {
            // Another attempt from the same hand-off, in a session of its own: a world on the stage keeps its own (I8).
            supersede(from);
            c = newCreation(from.idea, true, from);
            current = c;
        }
        publish(c);
        return writing(c);
    }

    const stageBlocked = (): string | null => (deps.stage ? deps.stage.blocked() : 'no stage here');

    /**
     * Why the go cannot be pressed now. The candidate ready now, or (Developer view's Run, as before EA9.1) the one already
     * on the stage, built again; never one still being written, or while its Run is under way.
     */
    function showBlocked(): string | null {
        const c = current;
        if (disposed) return 'the studio is done with this controller';
        if (!deps.stage) return 'no stage here';
        // Every verdict and go was the lost device's (executor §7), an improved world of the stage's included.
        if (lost) return 'the device was lost: the page must be reloaded';
        const phase = c ? phaseOf(c) : 'idle';
        if (phase === 'running') return 'a Run of it is under way';
        if (!c || (phase !== 'ready' && phase !== 'installed') || !c.session?.snapshot || !c.session.compiled) return 'nothing is ready to show';
        return stageBlocked();
    }

    async function show(): Promise<RunSummary | null> {
        const c = current;
        const stage = deps.stage;
        if (!c || !stage || showBlocked() !== null) return null;
        const snapshot = c.session?.snapshot ?? null;
        const compiled = c.session?.compiled ?? null;
        if (!snapshot || !compiled) return null;
        // Running before anything is awaited (P7): a second press now finds no ready candidate.
        c.running = true;
        c.notice = null;
        c.runSince = clock();
        publish(c);
        let summary: RunSummary;
        try {
            summary = await stage.go(snapshot, compiled, { title: c.title });
        } catch (e) {
            summary = { status: 'failed', reason: `internal: ${message(e)}`, numbers: '' };
        }
        c.running = false;
        c.run = { candidate: snapshot.id, summary };
        if (summary.status === 'installed') {
            // The stage holds this candidate now, whatever moved meanwhile: a cancel that came after its commit stopped
            // nothing. H is this creation; the one it replaced lets its session go only now (I8).
            const old = installed;
            installed = c;
            c.onStage = snapshot.id;
            c.runMs = c.runSince === null ? null : clock() - c.runSince;
            if (c.end?.phase === 'cancelled') c.end = null;
            if (old && old !== c) release(old);
            publish(c);
            return summary;
        }
        // The world on the stage is unchanged. A refusal or a failure may be pressed again, a new go, as may a Run the
        // creator stopped (cancel() has said so); a stop from a newer creation or a device loss says its own end.
        if (!c.closed && !c.end && summary.status !== 'stopped') c.notice = { sentence: runSentence(summary.reason), failed: true };
        publish(c);
        return summary;
    }

    function cancel(): void {
        const c = current;
        if (disposed || !c || c.closed || c.end) return;
        const phase = phaseOf(c);
        if (!BUSY.has(phase)) return;
        n++;
        if (c === installed) {
            // A round on the world on the stage: it stops, and the world stays, as its review says.
            if (WRITING.has(c.candidate?.phase ?? '')) c.session?.cancel();
            publish(c);
            return;
        }
        if (phase === 'running') {
            // The Run stops at its next check (κ moved). It spends nothing, and the world it tests stays written, checked
            // and sealed, so it waits for Show it again, a new go (I5): a second press on the button, which reads Stop by
            // then, never throws away a paid world (the EA9.1 review). A commit that beat the cancel installs (show()),
            // and its notice is never said: an installed world says none, and a later round or go clears it first.
            c.notice = { sentence: COPY.creation.runStopped, failed: false };
            publish(c);
            return;
        }
        c.end = { phase: 'cancelled', at: rowOf(phase), sentence: COPY.creation.cancelled, question: null, limit: null };
        if (turnOwner === c) turns.cancel();
        c.session?.cancel();
        publish(c);
        // Stopped before its turn was admitted (its sign-in, or its turn before the stream): the world kept for its go
        // comes back now, not when a stalled sign-in or request settles (Q126 (b)).
        decide(c, c.turn?.meta != null);
    }

    function deviceLost(): void {
        if (disposed) return;
        n++;
        lost = true;
        // A world kept for its go was checked on the lost device too: nothing can show it now, so it is not given back.
        if (kept) release(kept);
        kept = null;
        const c = current;
        if (c && !c.closed && !c.end) {
            if (c === installed) {
                if (WRITING.has(c.candidate?.phase ?? '')) c.session?.cancel();
            } else {
                const phase = phaseOf(c);
                c.end = { phase: 'stopped', at: rowOf(phase), sentence: COPY.creation.deviceLost, question: null, limit: null };
                if (turnOwner === c) turns.cancel();
                if (phase !== 'running') c.session?.cancel();
            }
        }
        publish();
    }

    /**
     * Who is signed in changed (I9): paid work under the account before stops, and H's paid actions go with that account
     * (installedSession). A candidate already written and waiting for "Show it" is kept: showing it spends nothing.
     */
    function accountMoved(): void {
        if (disposed) return;
        const c = current;
        if (c && !c.closed && !c.end && accountMovedFor(c)) {
            const phase = phaseOf(c);
            if (c === installed) {
                if (WRITING.has(c.candidate?.phase ?? '')) {
                    n++;
                    c.session?.cancel();
                }
            } else if (phase === 'turn' || phase === 'writing') {
                n++;
                c.end = { phase: 'stopped', at: rowOf(phase), sentence: COPY.creation.accountChanged, question: null, limit: null };
                if (turnOwner === c) turns.cancel();
                c.session?.cancel();
                // A world kept for its go stays, as any written world does (Q127 (a)): it comes back now (Q126 (b)).
                decide(c, c.turn?.meta != null);
            }
        }
        publish();
    }

    function replaced(): void {
        const h = installed;
        if (!h) return;
        installed = null;
        release(h);
        if (current === h) current = null;
        publish();
    }

    function dispose(): void {
        if (disposed) return;
        if (kept) release(kept);
        kept = null;
        const c = current;
        if (c && !c.closed && !c.end && BUSY.has(phaseOf(c))) cancel();
        if (improving(installed)) installed?.session?.cancel();
        disposed = true;
        n++;
        offAccount?.();
        publish();
        listeners.clear();
    }

    return {
        get state() { return state; },
        get n() { return n; },
        get session() { return current?.session ?? null; },
        get installedSession() {
            const h = installed;
            if (lost || !h || h.closed || !h.session || accountMovedFor(h)) return null;
            return h.session;
        },
        sessionFor(candidate) {
            if (lost || candidate === null) return null;
            for (const c of [installed, current]) {
                if (c && !c.closed && c.session?.snapshot?.id === candidate && !accountMovedFor(c)) return c.session;
            }
            return null;
        },
        get busy() {
            return (!!current && BUSY.has(phaseOf(current))) || improving(installed);
        },
        get creating() {
            return replacing();
        },
        get showable() {
            return !!deps.stage;
        },
        stageBlocked,
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        create, write, show, createBlocked, showBlocked, cancel, deviceLost, replaced, dispose,
    };
}
