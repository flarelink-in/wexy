// The candidate machine (EA4.3; candidate-loop-design.md §2, §3, §5, §8 and §9; Q83 and Q84 decided 2026-10-31 as
// recommended, Q82 (a) on 11-01): a handed-off turn's program made into a statically verified candidate, in the browser, with
// no GPU. Pure TypeScript over injected seams (the module client, the checker, a fake compiler, a reviser), so it runs
// under node --test with fakes.
//
//   resolving   W → X (resolveProgram), its checks (checkGraph), its interfaces (deriveInterfaces), custom lighting gated
//   authoring   each module, at most two calls at once; a module whose (interface, body, checker) passed before is
//               reused with no call
//   checking    L1, L2 once, the final L1 decides (checkBody); then L3 when the attempt has a compiler: a fake in the
//               tests, the device's own in the studio (EA5.1), each verdict kept for EA5's admission
//   correcting  a body's finding repairs that module, at most twice a module and three times a candidate; a program's
//               finding asks for a program revision (Q82 (a): EA4.4's reviser.ts; with no reviser it ends the candidate)
//   static-verified  every module passed: the host seals the candidate (snapshot.ts), id(C) fixed, with a completion
//               record that references each module's own checks
// Any phase: a cancel → cancelled, a newer candidate → superseded, a budget → exhausted (the last static-verified
// candidate is kept, else the Head), a failure → failed, each with its scope, a developer's diagnostic and the
// creator's sentence (copy.ts).
//
// Every model call is reserved in the ledger before it starts (Q_C, I6). Every verdict is an evidence record about an
// immutable subject (I4). Every correction, the machine's own repairs included, is an envelope checked against the
// candidate as it is now, before its call and again before its result is applied: anything else is EA_STALE_EVIDENCE,
// with no call (P2). After every await, cancellation and the job's own inputs are checked again before anything
// changes; a late answer may settle the ledger's accounting, never content (P10). Nothing here admits, renders or
// touches the Head, and it reaches a device only through the compiler it is handed: the snapshot and its L3 verdicts go
// to EA5's authority.
//
// EA6 (visual-review-design.md §5, §8; Q110 decided 11-02): a review of the world on the stage is recorded here only
// while the candidate it looked at is still this session's sealed one (`review`), and the creator's "Improve it" is one
// visual round (`improve`): their words and the host's findings they chose, answered by a program revision, its round
// and its revision's allowance reserved at the press, before anything reopens. A visual verdict never moves a technical
// one (P4).
//
// EA6.3 (visual-review-design.md §8.2; Q111 (a)): a program revision may carry notes to the modules whose code must
// change (`repairs`, agent-action.v3), which a program cannot reach. Once its program is resolved and its interfaces
// derived, the whole plan is held to them, then each note goes where its module is: a body this candidate keeps (its
// interface unchanged) is repaired with the note as its finding, about that very body; a module to be written is
// authored with the note, once. A note to a module the program does not name refuses the plan whole, before any call.

import { checkBody, compileBody, BODY_CHECKER, type CheckedBody, type CompiledBody, type ModuleCompiler } from '../contract/adapters/bodies';
import { canonicalJson } from '../contract/adapters/canonical';
import { checkGraph } from '../contract/adapters/checks';
import { POLICY_V1 } from '../contract/adapters/graph';
import { deriveInterfaces, notAuthorable, type ModuleInterface } from '../contract/adapters/interfaces';
import { programHash, resolveProgram } from '../contract/adapters/resolve';
import { MAX_MODULE_REPAIRS, type ModuleRepair, type SolutionDesign, type WorldProgram } from '../contract/agent';
import { cutCodePoints } from '../contract/text';
import { deepFreeze, type DeepReadonly } from '../contract/engine/frozen';
import type { AgentTurnRequest } from '../forge-client/agent-client';
import type { AgentEvent, AgentTurnResult } from '../forge-client/agent-stream';
import { ForgeError, type ErrorCode } from '../forge-client/errors';
import { MODULE_VERSIONS, moduleNodes, wireInterface, type ModuleCallBody, type ModuleClient, type WireFinding } from '../forge-client/module-client';
import { ModuleStreamError, type ModuleOutcome, type ModuleUsage } from '../forge-client/module-stream';
import {
    EVIDENCE_LIMITS, EvidenceLimitError, EvidenceStore, route, verifyEnvelope, type CandidateEvidence, type EvidenceFinding, type EvidenceLimits,
    type EvidencePhase, type EvidenceSubject, type Envelope, type ProducedBy, type Scope, type Verdict,
} from './candidate-evidence';
import { Ledger, Q_C, budgetDiagnostic, type Budget, type CandidateLimits, type LedgerState, type Reservation } from './candidate-ledger';
import { COPY } from './copy';
import { sealCandidate, type SealedCandidate } from './snapshot';

type Interface = DeepReadonly<ModuleInterface>;
type Snapshot = DeepReadonly<SealedCandidate>;

export type CandidatePhase = 'resolving' | 'authoring' | 'checking' | 'correcting' | 'static-verified' | 'failed' | 'exhausted' | 'cancelled' | 'superseded';

/** One call of an agent turn, the hand-off's or a program revision's, as its events told it. */
export interface TurnCallRecord {
    n: number;
    /** Why the turn made it, in the backend's words (`first`, `revise`, `repair`, …). */
    purpose: string;
    /** Known when the call reported its usage; unknown when it did not. Never zero. */
    charge: 'known' | 'unknown';
    costMicroUsd: number | null;
    generationId: string | null;
}

/** A turn's calls as records, from the calls its reader or its state kept. */
export function turnCallsOf(calls: readonly { n: number; purpose: string; usage: { generationId: string; costMicroUsd: number } | null }[]): TurnCallRecord[] {
    return calls.map(c => ({
        n: c.n, purpose: c.purpose, charge: c.usage ? 'known' : 'unknown', costMicroUsd: c.usage?.costMicroUsd ?? null, generationId: c.usage?.generationId ?? null,
    }));
}

/** What the candidate starts from: a turn handed off (EA2), R and S verbatim, W, and the turn's actual calls. */
export interface HandOff {
    turnId: string;
    request: AgentTurnRequest;
    design: SolutionDesign;
    program: WorldProgram;
    /** The turn's model and template, from its meta. */
    model: string;
    promptVersion: string;
    /** The turn's own calls, as its records told them: the ledger is seeded with them (the design §8), the bundle lists them. */
    calls: TurnCallRecord[];
}

/** A handed-off turn's result as a hand-off. */
export function handOffOf(request: AgentTurnRequest, result: Extract<AgentTurnResult, { status: 'handed-off' }>): HandOff {
    return {
        turnId: result.meta.turnId, request, design: result.design, program: result.program, model: result.meta.model, promptVersion: result.meta.promptVersion,
        calls: turnCallsOf(result.calls),
    };
}

export type TurnStatus = 'running' | 'handed-off' | 'asked' | 'declined' | 'exhausted' | 'refused' | 'broken' | 'cancelled';

/**
 * An agent turn the attempt stands on, as Developer view and the bundle tell it (the EA4.5 review): the hand-off's own,
 * and each program revision's. Every call Q_C counts is a turn's call or a module job.
 */
export interface TurnRecord {
    role: 'hand-off' | 'revision';
    /** From its meta; null for a revision whose meta never came. */
    turnId: string | null;
    /**
     * The candidate revision its program became, or would have: 0 for the hand-off; for a program revision, the one
     * after the revision it answered (every judged body is a revision too, so it is not a count of program revisions).
     */
    revision: number;
    status: TurnStatus;
    model: string | null;
    promptVersion: string | null;
    /** Known when its end was seen and each of its calls reported a usage; unknown otherwise, never zero. */
    charge: 'known' | 'unknown';
    calls: TurnCallRecord[];
    error: string | null;
}

/** The body checker and its version: a passing verdict is reused only under the same version (the design §5). */
export interface BodyChecker {
    readonly version: string;
    check(iface: Interface, answer: string): Promise<DeepReadonly<CheckedBody>>;
}

export const HOST_CHECKER: BodyChecker = Object.freeze({ version: BODY_CHECKER, check: checkBody });

/** A program revision's request (Q82 (a)): R and S as they were, the base program, the findings it answers. */
export interface RevisionRequest {
    turnId: string;
    request: AgentTurnRequest;
    design: SolutionDesign;
    program: WorldProgram;
    subject: EvidenceSubject;
    findings: { id: string; code: string; path: string | null; message: string }[];
}

export type RevisionResult =
    /** `repairs`: the revision's notes to its modules (EA6.3), empty when it has none. */
    | { status: 'handed-off'; turnId: string; design: SolutionDesign; program: WorldProgram; repairs: readonly ModuleRepair[]; calls: number }
    | { status: 'asked' | 'declined' | 'exhausted'; reason: string; calls: number | null };

/**
 * The finding a revision's note becomes for a body the candidate keeps (EA6.3): what the revision asks of the module's
 * code, a model's instruction and never a check's verdict, which the module's repair answers.
 */
export const NOTE_CODE = 'EA_REVISION_NOTE';
/** The note's own words, after a few that say what it is: 66 and its 300 within the backend's 400 code points a finding. */
export const noteMessage = (message: string) => `The revision asks (a model's instruction, not a check's finding): ${message}`;
/**
 * A revision's note set aside with its program, which the browser then refused: passed, with what that revision
 * answered, to the revision that answers the refusal, so it may name the note again (the independent review of EA6.3).
 */
export const SET_ASIDE_CODE = 'EA_NOTE_SET_ASIDE';
/** How many notes the attempt can still answer, told to every revision as a finding of the host's own (the same review). */
export const REPAIR_BUDGET_CODE = 'EA_REPAIR_BUDGET';

/**
 * EA4.4's seam: one revision turn. It rejects when its stream breaks, and then its calls are unknown. Each of the turn's
 * events goes to `onEvent` as it comes, so the candidate keeps the turn's calls (the EA4.5 review).
 */
export type Reviser = (request: RevisionRequest, signal: AbortSignal, onEvent?: (event: AgentEvent) => void) => Promise<RevisionResult>;

/** What judged L3 in an attempt: a fake, or a device and its GPU. */
export interface L3Judge {
    producedBy: ModuleCompiler['producedBy'];
    gpu: string | null;
}

export interface CandidateDeps {
    modules: ModuleClient;
    /**
     * L3: a scripted fake in the tests (labelled `fake`), the device's own compiler in the studio (EA5.1). A function is
     * asked once at each attempt's start, so a device that comes later serves the attempts after it, and one attempt
     * never changes its compiler. Absent, or null from the function: L3 is not run, and the candidate is static only.
     */
    compiler?: ModuleCompiler | (() => ModuleCompiler | null);
    /** A program revision (EA4.4: `createReviser`, a turn with a base). Absent: a program's finding ends the candidate. */
    revise?: Reviser;
    checker?: BodyChecker;
    limits?: CandidateLimits;
    evidence?: EvidenceLimits;
    /** A new attempt's id; random by default. */
    attemptId?: () => string;
    /** The clock, in ms. */
    now?: () => number;
}

export type ModulePhase = 'waiting' | 'authoring' | 'checking' | 'repairing' | 'passed' | 'failed';

export interface ModuleState {
    module: string;
    kind: ModuleInterface['kind'];
    /** The node that names it. */
    node: string;
    interfaceHash: string;
    /** As checked: after the auto-fix, the text hashed. */
    body: string | null;
    /** The answer as it came, unfenced; never compiled. */
    originalBody: string | null;
    codeHash: string | null;
    phase: ModulePhase;
    /** What it needs next: an author, a repair, or nothing. */
    needs: 'author' | 'repair' | null;
    /** Its author and repair calls in this attempt. */
    calls: number;
    repairs: number;
    checkerVersion: string | null;
    /** Its current verdicts' records: the lint, and the compile when L3 ran. */
    evidence: string[];
    /** The findings its next repair answers, by id. */
    addressed: string[];
    /** Its body was reused from an earlier revision, with no call. */
    reused: boolean;
    /**
     * A program revision's note to it (EA6.3), which its next author call carries, once: until an answer is judged. Null
     * when it has none; a body the candidate keeps gets its note as a finding instead.
     */
    note: string | null;
}

export type JobStatus = 'running' | 'ok' | 'unusable' | 'refused' | 'broken' | 'cancelled' | 'stale';

/** One module call, as the ledger and the bundle tell it. */
export interface JobRecord {
    jobId: string;
    module: string;
    purpose: 'author' | 'repair';
    revision: number;
    status: JobStatus;
    /** Known when the call reported its usage; unknown when it did not, or its end was not seen. Never zero. */
    charge: 'known' | 'unknown';
    costMicroUsd: number | null;
    generationId: string | null;
    model: string | null;
    promptVersion: string | null;
    error: string | null;
}

export interface CandidateStop {
    scope: Scope | 'budget' | 'evidence';
    /** A developer's words: the code, the offender, the number. */
    diagnostic: string;
    /** The creator's one sentence (copy.ts). */
    sentence: string;
}

export interface CandidateState {
    attempt: string;
    revision: number;
    /** id(C), once the current revision is static-verified. */
    id: string | null;
    phase: CandidatePhase;
    turnId: string;
    request: AgentTurnRequest;
    design: SolutionDesign;
    program: WorldProgram;
    programHash: string | null;
    graph: string | null;
    modules: ModuleState[];
    evidence: CandidateEvidence[];
    /** Records dropped from the history, by phase. */
    omitted: Readonly<Record<string, number>>;
    budget: LedgerState;
    limits: CandidateLimits;
    /** The hand-off's turn, then each program revision's. */
    turns: TurnRecord[];
    jobs: JobRecord[];
    /** What judged L3 in this attempt; null when L3 was not run (no compiler, as with no device). */
    l3: L3Judge | null;
    stop: CandidateStop | null;
    /** The last static-verified candidate of this attempt, kept through a later failure or exhaustion. */
    verified: { id: string; revision: number } | null;
    startedMs: number;
    endedMs: number | null;
}

/**
 * What a visual round came to (`improve`): a new sealed candidate, or none, and then whether the session went back to
 * the candidate the round started from (the one on the stage), so another round may follow within what is left.
 */
export interface Round {
    improved: boolean;
    /** Why the round ended with no candidate; null when it improved. */
    stop: CandidateStop | null;
    restored: boolean;
}

export type Corrected = { ok: true; state: DeepReadonly<CandidateState>; round?: Round } | { ok: false; diagnostic: string };

/** What a review looked at (EA6): this attempt's sealed candidate, by its id(C). */
export interface ReviewExpectation {
    attempt: string;
    candidate: string;
}

/**
 * A review's record (EA6 §5): the host's look at the stage (`render`, by the `device`), or a verdict on it (`visual`, by
 * the creator or a model). Its findings are warnings unless said otherwise; messages are cut to the backend's 400.
 */
export interface ReviewInput {
    expected: ReviewExpectation;
    phase: 'render' | 'visual';
    verdict: Verdict;
    producedBy: 'device' | 'creator' | 'model';
    findings?: { code: string; message: string; severity?: 'error' | 'warning' }[];
    /** The records it stands on: a creator's verdict on the host's findings it chose. */
    refs?: string[];
}

export type Reviewed = { ok: true; evidence: CandidateEvidence } | { ok: false; diagnostic: string };

/** The creator's "Improve it" (EA6 §8.1): their words, and the host's findings about the stage they chose, by id. */
export interface ImproveInput {
    expected: ReviewExpectation;
    words: string;
    findings: readonly string[];
}

/** The backend's bounds on a revision's findings (AgentBase: MAX_FINDINGS, MESSAGE_CHARS): refused past them, never cut. */
export const IMPROVE_FINDINGS = 32;
export const IMPROVE_WORDS = 400;

export interface CandidateSession {
    /** The current attempt's state; null before the first. */
    readonly state: DeepReadonly<CandidateState> | null;
    /** The current revision's sealed candidate once static-verified, for EA5's authority; null otherwise. */
    readonly snapshot: Snapshot | null;
    /**
     * The sealed candidate's L3 verdicts, exactly one a body, each the very object its compiler made (EA5.1: a device
     * compiler's admission accepts no copy); null without a snapshot, or when L3 did not judge every body.
     */
    readonly compiled: readonly DeepReadonly<CompiledBody>[] | null;
    /** Runs a candidate from a hand-off, superseding the one before; resolves with its last state, however it ended. */
    start(handOff: HandOff): Promise<DeepReadonly<CandidateState>>;
    /** Cancels the current attempt: shown cancelled at once, no call after, nothing applied. */
    cancel(): void;
    /** A correction on a settled candidate: refused before any call when stale or out of scope; run otherwise. */
    correct(envelope: Envelope): Promise<Corrected>;
    /** A visual verdict (EA6): recorded as its own evidence; it never moves a technical verdict (P4). */
    visual(input: { verdict: 'pass' | 'fail'; producedBy: 'model' | 'creator'; findings?: { code: string; message: string; path?: string | null }[] }): CandidateEvidence | null;
    /** Whether a correction here can revise the program: a session with no reviser offers no paid improvement (EA6). */
    readonly revisable: boolean;
    /**
     * A review's record (EA6 §5): kept only while `expected` is still this session's sealed candidate, else
     * EA_STALE_EVIDENCE and nothing recorded, so an answer that arrives late is never pinned on a newer candidate.
     */
    review(input: ReviewInput): Reviewed;
    /**
     * The creator's "Improve it" (EA6 §8, Q110): one visual round, a program revision answering their words and the
     * findings they chose. Its round and its revision's allowance are reserved at once, before anything reopens; refused
     * before any call when stale, empty, past 32 findings or 400 characters, or out of budget, the candidate unchanged.
     */
    improve(input: ImproveInput): Promise<Corrected>;
}

/** The creator's sentence for a refusal or failure the backend reported. */
function sentenceFor(code: ErrorCode): string {
    switch (code) {
        case 'budget':
        case 'paused': return COPY.failures.budget;
        case 'rate': return COPY.failures.rate;
        case 'unavailable': return COPY.failures.offline;
        case 'auth':
        case 'appcheck':
        case 'account-required':
        case 'forbidden': return COPY.failures['sign-in'];
        case 'timeout': return COPY.failures['author-slow'];
        case 'upstream': return COPY.candidate.stream;
        case 'bad-request':
        case 'not-found':
        case 'too-large':
        case 'internal': return COPY.candidate.refused;
    }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const reuseKey = (module: string, interfaceHash: string) => `${module}\u0000${interfaceHash}`;

interface ReuseEntry {
    body: string;
    originalBody: string | null;
    codeHash: string;
    checker: string;
    /** L3 judged it too (true when a compiler ran). */
    compiled: boolean;
    /** L3's verdict on it, as its compiler made it; null when no compiler ran. */
    verdict: DeepReadonly<CompiledBody> | null;
    evidence: string[];
}

interface Inputs {
    programHash: string | null;
    graph: string | null;
    interfaceHash: string;
    codeHash: string | null;
}

interface Active {
    module: string;
    promise: Promise<void>;
}

type Placement = 'graph' | 'completion' | 'history' | { module: ModuleState; reset: boolean };

/** One attempt: a hand-off and everything done for it, revision after revision. */
class Attempt {
    readonly id: string;
    revision = 0;
    turnId: string;
    readonly request: AgentTurnRequest;
    readonly design: SolutionDesign;
    program: WorldProgram;
    programHash: string | null = null;
    graph: string | null = null;
    interfaces: Interface[] = [];
    graphEvidence: string[] = [];
    verifiedEvidence: string[] = [];
    modules = new Map<string, ModuleState>();
    readonly reuse = new Map<string, ReuseEntry>();
    readonly turns: TurnRecord[];
    readonly jobs: JobRecord[] = [];
    readonly active = new Map<string, Active>();
    readonly ledger: Ledger;
    readonly store: EvidenceStore;
    /** resolving, correcting (a revision), static-verified or an end; null while module work decides the phase. */
    phase: CandidatePhase | null = 'resolving';
    revising = false;
    running = false;
    stop: CandidateStop | null = null;
    snapshot: Snapshot | null = null;
    /** The snapshot's L3 verdicts, one a body, when L3 judged every one; set with each snapshot, read only beside it. */
    compiled: readonly DeepReadonly<CompiledBody>[] | null = null;
    verified: Snapshot | null = null;
    /** The turn whose program the last static-verified candidate came from: what a restore goes back to (EA6). */
    verifiedTurn: string | null = null;
    /**
     * A program revision's notes to its modules (EA6.3), waiting for its program's interfaces: applied once, by the
     * resolve of that revision's turn, and only then. Every handed-off revision leaves one, its notes perhaps none, so a
     * refused program hands the next revision what it was for. `refs`: the records whose findings the revision answered;
     * `answered`: those findings, by id.
     */
    plan: { turnId: string; repairs: readonly ModuleRepair[]; refs: string[]; answered: string[] } | null = null;
    /** L3 for this attempt, fixed at its start; null: not run. */
    readonly compiler: ModuleCompiler | null;
    /** Each module's L3 verdict on its current body, once it passed. */
    verdicts = new Map<string, DeepReadonly<CompiledBody>>();
    /** Cancelled or superseded: nothing it does is shown or applied again. */
    closed = false;
    readonly controller = new AbortController();
    work = new AbortController();
    jobSeq = 0;
    readonly startedMs: number;
    endedMs: number | null = null;

    constructor(handOff: HandOff, id: string, limits: CandidateLimits, evidence: EvidenceLimits, now: number, compiler: ModuleCompiler | null) {
        this.id = id;
        this.compiler = compiler;
        this.turnId = handOff.turnId;
        // R, S and W as they were handed off, copied and frozen: nothing later changes what the attempt started from.
        this.request = deepFreeze(structuredClone({ prompt: handOff.request.prompt, style: handOff.request.style, seconds: handOff.request.seconds })) as AgentTurnRequest;
        this.design = deepFreeze(structuredClone(handOff.design)) as SolutionDesign;
        this.program = deepFreeze(structuredClone(handOff.program)) as WorldProgram;
        const calls = structuredClone(handOff.calls);
        this.turns = [{
            role: 'hand-off', turnId: handOff.turnId, revision: 0, status: 'handed-off', model: handOff.model, promptVersion: handOff.promptVersion,
            charge: calls.every(c => c.charge === 'known') ? 'known' : 'unknown', calls, error: null,
        }];
        this.ledger = new Ledger(limits, calls.length);
        this.store = new EvidenceStore(evidence, () => this.pinned());
        this.startedMs = now;
    }

    /** Still the attempt to act for: not cancelled, superseded or stopped. */
    live(): boolean {
        return !this.closed && this.stop === null;
    }

    subject(over: Partial<EvidenceSubject>): EvidenceSubject {
        return {
            attempt: this.id, revision: this.revision, programHash: this.programHash ?? '', graph: this.graph, candidate: null, module: null,
            interfaceHash: null, codeHash: null, ...over,
        };
    }

    /** The records the candidate stands on now: never evicted (the design §9). */
    pinned(): ReadonlySet<string> {
        const s = new Set<string>(this.graphEvidence);
        for (const m of this.modules.values()) {
            for (const id of m.evidence) s.add(id);
            for (const f of m.addressed) s.add(f.slice(0, f.lastIndexOf('.')));
        }
        for (const r of this.reuse.values()) for (const id of r.evidence) s.add(id);
        for (const id of this.verifiedEvidence) s.add(id);
        return s;
    }

    /** A verdict recorded and placed: pinned where the candidate stands on it, history otherwise. */
    record(input: { subject: EvidenceSubject; phase: EvidencePhase; verdict: Verdict; producedBy: ProducedBy; refs?: string[];
        findings?: Omit<EvidenceFinding, 'id'>[] }, place: Placement): CandidateEvidence {
        return this.store.add(input, id => {
            if (place === 'graph') this.graphEvidence.push(id);
            else if (place === 'completion') this.verifiedEvidence = [id, ...(input.refs ?? [])];
            else if (place !== 'history') {
                if (place.reset) place.module.evidence = [id];
                else place.module.evidence.push(id);
            }
        });
    }

    iface(module: string): Interface {
        const i = this.interfaces.find(f => f.module === module);
        if (!i) throw new Error(`candidate: no interface for module ${module}`);
        return i;
    }

    /** The candidate as it is now, for an envelope's check. */
    current(): { attempt: string; revision: number; candidate: string | null; programHash: string | null; graph: string | null;
        modules: ReadonlyMap<string, { interfaceHash: string; codeHash: string | null }> } {
        return {
            attempt: this.id, revision: this.revision, candidate: this.snapshot?.id ?? null, programHash: this.programHash, graph: this.graph,
            modules: new Map([...this.modules.values()].map(m => [m.module, { interfaceHash: m.interfaceHash, codeHash: m.codeHash }])),
        };
    }

    verify(envelope: Envelope): string | null {
        return verifyEnvelope(envelope, this.current(), id => this.store.finding(id));
    }

    /** A module's own repair, as an envelope: its findings, about its body as it is now. */
    repairEnvelope(m: ModuleState): Envelope {
        return {
            base: { attempt: this.id, revision: this.revision, candidate: null, programHash: this.programHash ?? '', graph: this.graph },
            scope: 'modules', changes: [m.module], findingsAddressed: [...m.addressed],
        };
    }

    /** Stops the attempt: its end, its reasons; every job still running is aborted, and settles its accounting only. */
    halt(stop: CandidateStop, phase: 'failed' | 'exhausted', now: number): void {
        if (!this.live()) return;
        this.stop = stop;
        this.phase = phase;
        this.snapshot = null;
        this.endedMs = now;
        this.work.abort();
    }

    close(phase: 'cancelled' | 'superseded', now: number): void {
        if (this.closed) return;
        this.closed = true;
        this.phase = phase;
        this.snapshot = null;
        this.endedMs = now;
        this.controller.abort();
        this.work.abort();
    }

    phaseNow(): CandidatePhase {
        if (this.phase !== null) return this.phase;
        const ms = [...this.modules.values()];
        // What a module needs counts only while it waits for it: one being checked still names the call it came from.
        if (ms.some(m => m.phase === 'repairing' || (m.needs === 'repair' && m.phase === 'waiting'))) return 'correcting';
        if (ms.some(m => m.phase === 'authoring' || (m.needs === 'author' && m.phase === 'waiting'))) return 'authoring';
        return 'checking';
    }

    view(): DeepReadonly<CandidateState> {
        return deepFreeze({
            attempt: this.id, revision: this.revision, id: this.snapshot?.id ?? null, phase: this.phaseNow(), turnId: this.turnId,
            request: this.request, design: this.design, program: this.program, programHash: this.programHash, graph: this.graph,
            modules: [...this.modules.values()].map(m => ({ ...m, evidence: [...m.evidence], addressed: [...m.addressed] })),
            evidence: this.store.list(), omitted: this.store.omissions,
            budget: this.ledger.state, limits: this.ledger.limits,
            turns: this.turns.map(t => ({ ...t, calls: t.calls.map(c => ({ ...c })) })),
            jobs: this.jobs.map(j => ({ ...j })),
            l3: this.compiler ? { producedBy: this.compiler.producedBy, gpu: this.compiler.gpu ?? null } : null,
            stop: this.stop, verified: this.verified ? { id: this.verified.id, revision: this.verified.revision } : null,
            startedMs: this.startedMs, endedMs: this.endedMs,
        });
    }
}

/** A module with nothing written for it yet. */
function fresh(iface: Interface): ModuleState {
    return {
        module: iface.module, kind: iface.kind, node: iface.node, interfaceHash: iface.interfaceHash, body: null, originalBody: null, codeHash: null,
        phase: 'waiting', needs: 'author', calls: 0, repairs: 0, checkerVersion: null, evidence: [], addressed: [], reused: false, note: null,
    };
}

/** Candidates, one attempt at a time, over `deps`, each state handed to `onChange` as it happens. */
export function createCandidateSession(deps: CandidateDeps, onChange: (state: DeepReadonly<CandidateState>) => void): CandidateSession {
    const now = deps.now ?? (() => performance.now());
    const checker = deps.checker ?? HOST_CHECKER;
    const limits = deps.limits ?? Q_C;
    const evidenceLimits = deps.evidence ?? EVIDENCE_LIMITS;
    const attemptId = deps.attemptId ?? (() => `attempt-${globalThis.crypto.randomUUID()}`);
    let current: Attempt | null = null;

    const publish = (a: Attempt, closing = false) => {
        if (current === a && (!a.closed || closing)) onChange(a.view());
    };

    /** A failure outside the routing table (a bug, the evidence bound): the attempt stops, in a developer's words. */
    const fail = (a: Attempt, error: unknown) => {
        if (error instanceof EvidenceLimitError) a.halt({ scope: 'evidence', diagnostic: error.message, sentence: COPY.candidate.tooLarge }, 'failed', now());
        else a.halt({ scope: 'host', diagnostic: `internal: ${message(error)}`, sentence: COPY.candidate.refused }, 'failed', now());
    };

    const exhausted = (a: Attempt, refusal: { budget: Budget; used: number; limit: number }) =>
        a.halt({ scope: 'budget', diagnostic: budgetDiagnostic(refusal), sentence: COPY.candidate.budget }, 'exhausted', now());

    /**
     * Where a failing graph-level record goes: a program revision, if there is one and Q_C allows it; else the end. When
     * the program refused came from a revision, its `plan` follows it (the independent review of EA6.3): the notes set
     * aside with that program, first, so the next revision may name them again; then what the browser found; then what
     * that revision answered (a creator's words among them), so the program's purpose is not lost with it.
     */
    async function routeGraph(a: Attempt, e: CandidateEvidence, plan: Attempt['plan'] = null): Promise<'again' | 'stop'> {
        const scope = route(e);
        const first = e.findings.find(f => f.severity === 'error') ?? e.findings[0];
        const said = !first ? `${e.phase} failed` : first.path ? `${first.code} ${first.path}: ${first.message}` : `${first.code}: ${first.message}`;
        if (scope === 'design') {
            a.halt({ scope: 'design', diagnostic: `${said}; EA4 starts no design revision: the creator asks again`, sentence: COPY.candidate.setup }, 'failed', now());
            return 'stop';
        }
        const errors = e.findings.filter(f => f.severity === 'error');
        const { notes, answered } = setAside(a, plan);
        return revise(a, [...notes, ...errors, ...answered], said);
    }

    /**
     * What a revision whose program the browser refused leaves to the next (the independent review of EA6.3): its notes,
     * recorded as set aside with that program (the model's, never a verdict), and the findings it answered that the
     * attempt still holds. Nothing when the program was not a revision's.
     */
    function setAside(a: Attempt, plan: Attempt['plan']): { notes: readonly EvidenceFinding[]; answered: readonly EvidenceFinding[] } {
        if (!plan || plan.turnId !== a.turnId) return { notes: [], answered: [] };
        const notes = plan.repairs.length === 0 ? [] : a.record({
            subject: a.subject({}), phase: 'visual', verdict: 'unverified', producedBy: 'model', refs: plan.refs,
            findings: plan.repairs.map(r => ({ code: SET_ASIDE_CODE, path: null, line: null, severity: 'warning' as const, message: `${r.module}: ${r.message}`, rung: null, place: null })),
        }, 'history').findings;
        const answered = plan.answered.map(id => a.store.finding(id)?.finding).filter((f): f is EvidenceFinding => f !== undefined);
        return { notes, answered };
    }

    /**
     * How many notes the attempt can still answer, as a finding of the host's own told to every revision (the independent
     * review of EA6.3): Q_C's repairs and calls left, and the modules whose repairs are spent. A plan past it is refused
     * whole, so the model is told before it writes one. Null when a plan of the schema's whole size would fit.
     */
    function repairBudget(a: Attempt): { id: string; code: string; path: null; message: string } | null {
        const { limits, state } = a.ledger;
        const left = Math.max(0, Math.min(limits.repairs - state.repairs, limits.calls - a.ledger.used));
        const spent = [...a.modules.values()].filter(m => (state.moduleRepairs[m.module] ?? 0) >= limits.repairsPerModule).map(m => m.module);
        if (left >= MAX_MODULE_REPAIRS && !spent.length) return null;
        const named = spent.length > 4 ? `${spent.slice(0, 4).join(', ')} and ${spent.length - 4} more` : spent.join(', ');
        const none = spent.length ? `, and none for ${named}, whose repairs are spent` : '';
        return {
            id: 'q_c.repairs', code: REPAIR_BUDGET_CODE, path: null,
            message: `This attempt can still repair ${left} module bod${left === 1 ? 'y' : 'ies'} with notes${none}: a plan past that is refused whole, before any of it is done.`,
        };
    }

    /**
     * A program revision answering `findings` (Q82 (a)); with no reviser, the candidate ends here. `reserved`: its
     * allowance, already taken at the creator's press (EA6's `improve`), so a refused budget never reopened anything.
     */
    async function revise(a: Attempt, findings: readonly EvidenceFinding[], said: string, reserved: Reservation | null = null): Promise<'again' | 'stop'> {
        if (!deps.revise) {
            if (reserved) a.ledger.release(reserved);
            a.halt({ scope: 'program', diagnostic: `${said}; no program revision: this candidate has no reviser`, sentence: COPY.candidate.setup }, 'failed', now());
            return 'stop';
        }
        let reservation: Reservation;
        if (reserved) reservation = reserved;
        else {
            const r = a.ledger.reserveRevision();
            if (!r.ok) {
                exhausted(a, r);
                return 'stop';
            }
            reservation = r.reservation;
        }
        a.phase = 'correcting';
        a.revising = true;
        // A new revision supersedes any notes still waiting: a plan rides only on the program its own turn handed off.
        a.plan = null;
        a.ledger.dispatched(reservation);
        // Its turn's record (the EA4.5 review): each call as the turn tells it, shown as it comes, until the attempt
        // closes. Nothing the turn says after a cancel or a newer candidate is kept or shown.
        const record: TurnRecord = {
            role: 'revision', turnId: null, revision: a.revision + 1, status: 'running', model: null, promptVersion: null, charge: 'unknown', calls: [], error: null,
        };
        a.turns.push(record);
        const observe = (event: AgentEvent) => {
            if (a.closed) return;
            if (event.type === 'meta') Object.assign(record, { turnId: event.meta.turnId, model: event.meta.model, promptVersion: event.meta.promptVersion });
            else if (event.type === 'call') record.calls.push({ n: event.call.n, purpose: event.call.purpose, charge: 'unknown', costMicroUsd: null, generationId: null });
            else if (event.type === 'usage') {
                const call = record.calls.find(c => c.n === event.usage.n);
                if (call) Object.assign(call, { charge: 'known', costMicroUsd: event.usage.costMicroUsd, generationId: event.usage.generationId });
            } else return;
            publish(a);
        };
        publish(a);
        let result: RevisionResult;
        // What the attempt can still answer with notes, the last of at most 32 (the independent review of EA6.3).
        const budget = repairBudget(a);
        const sent = findings.slice(0, budget ? 31 : 32).map(f => ({ id: f.id, code: f.code, path: f.path, message: cutCodePoints(f.message, 400) }));
        try {
            result = await deps.revise({
                turnId: a.turnId, request: a.request, design: a.design, program: a.program, subject: a.subject({}),
                findings: budget ? [...sent, budget] : sent,
            }, AbortSignal.any([a.controller.signal, a.work.signal]), observe);
        } catch (error) {
            // A revision whose end was not seen keeps its whole reservation, unknown (the design §8); its turn's charge
            // stays unknown too, whatever its calls reported.
            a.ledger.settle(reservation, null);
            a.revising = false;
            if (!a.live()) {
                record.status = 'cancelled';
                return 'stop';
            }
            record.error = message(error);
            // Refused before any stream (an HTTP status), or broken once it ran (an error event, a cut, another contract).
            record.status = error instanceof ForgeError && error.status >= 400 ? 'refused' : 'broken';
            const code = error instanceof ForgeError ? error.code : 'internal';
            a.halt({ scope: 'host', diagnostic: `revision: ${message(error)}; charge unknown`, sentence: sentenceFor(code) }, 'failed', now());
            return 'stop';
        }
        a.revising = false;
        a.ledger.settle(reservation, result.calls ?? null);
        // Its end seen: the turn's charge is known when each call the result counts is a record with its usage.
        record.charge = result.calls !== null && record.calls.length === result.calls && record.calls.every(c => c.charge === 'known') ? 'known' : 'unknown';
        if (!a.live()) {
            record.status = 'cancelled';
            return 'stop';
        }
        record.status = result.status;
        if (result.status !== 'handed-off') {
            a.halt({ scope: 'program', diagnostic: `the program revision ended ${result.status}: ${result.reason.slice(0, 200)}`, sentence: COPY.candidate.setup }, 'failed', now());
            return 'stop';
        }
        // S is immutable for a program revision: a changed design is another creator attempt, never this one's W.
        let same = false;
        try { same = canonicalJson(result.design) === canonicalJson(a.design); } catch { same = false; }
        if (!same) {
            a.halt({ scope: 'design', diagnostic: 'the program revision changed the design (S), which a program revision may not: no replacement', sentence: COPY.candidate.setup }, 'failed', now());
            return 'stop';
        }
        // W is replaced whole, at once: a new revision, resolved, checked and derived again.
        a.program = deepFreeze(structuredClone(result.program)) as WorldProgram;
        a.turnId = result.turnId;
        a.revision++;
        // Its notes to modules wait for that program's interfaces (EA6.3): the resolve of this very turn applies them, once.
        // With what it answered, so a program the browser refuses passes both to the next revision (the review, finding 1).
        a.plan = {
            turnId: result.turnId,
            repairs: deepFreeze(result.repairs.map(r => ({ module: r.module, message: r.message }))),
            refs: [...new Set(findings.map(f => f.id.slice(0, f.id.lastIndexOf('.'))))],
            answered: findings.map(f => f.id),
        };
        return 'again';
    }

    /**
     * W → X, its checks, its interfaces; then each module reused or waiting for its author; then the notes of the
     * revision that handed W off, if it carried any (EA6.3). They are taken here, at the start, so a resolve that stops
     * on the way drops them with its program: no later resolve (a restore's, another revision's) ever applies them. When
     * the browser refuses W, they go to the revision that answers the refusal, as findings it may name again.
     */
    async function resolving(a: Attempt): Promise<'ready' | 'again' | 'stop'> {
        const plan = a.plan;
        a.plan = null;
        a.phase = 'resolving';
        a.snapshot = null;
        a.graphEvidence = [];
        a.graph = null;
        a.modules = new Map();
        a.verdicts = new Map();
        publish(a);
        const nodes = a.program.nodes;
        a.programHash = await programHash(nodes);
        if (!a.live()) return 'stop';
        const r = await resolveProgram(nodes);
        if (!a.live()) return 'stop';
        if (!r.ok) {
            const e = a.record({
                subject: a.subject({}), phase: 'resolve', verdict: 'fail', producedBy: 'host',
                findings: r.diagnostics.map(d => ({ code: d.code, path: d.path, line: null, severity: 'error' as const, message: d.message, rung: null, place: null })),
            }, 'graph');
            return routeGraph(a, e, plan);
        }
        const x = r.graph;
        a.graph = x.hash;
        a.programHash = x.identity.programHash;
        a.record({ subject: a.subject({}), phase: 'resolve', verdict: 'pass', producedBy: 'host' }, 'graph');
        const checked = await checkGraph(x, POLICY_V1);
        if (!a.live()) return 'stop';
        const ce = a.record({
            subject: a.subject({}), phase: 'check', verdict: checked.ok ? 'pass' : 'fail', producedBy: 'host',
            findings: checked.findings.map(f => ({ code: f.check, path: f.path, line: null, severity: f.severity, message: f.message, rung: null, place: null })),
        }, 'graph');
        if (!checked.ok) return routeGraph(a, ce, plan);
        const derived = await deriveInterfaces(x);
        if (!a.live()) return 'stop';
        // Custom lighting stays gated until the host's lighting contract exists (the design §6): no call is spent on it.
        const gated = derived.ok ? derived.interfaces.flatMap(i => { const why = notAuthorable(i); return why ? [{ i, why }] : []; }) : [];
        const ie = a.record({
            subject: a.subject({}), phase: 'interface', verdict: derived.ok && !gated.length ? 'pass' : 'fail', producedBy: 'host',
            findings: derived.ok
                ? gated.map(g => ({ code: 'EA_CAPABILITY_UNSUPPORTED', path: g.i.paths[0] ?? null, line: null, severity: 'error' as const, message: g.why, rung: null, place: null }))
                : derived.diagnostics.map(d => ({ code: d.code, path: d.path, line: null, severity: 'error' as const, message: d.message, rung: null, place: null })),
        }, 'graph');
        if (ie.verdict === 'fail' || !derived.ok) return routeGraph(a, ie, plan);
        if (derived.interfaces.length > a.ledger.limits.modules) {
            exhausted(a, { budget: 'modules', used: derived.interfaces.length, limit: a.ledger.limits.modules });
            return 'stop';
        }
        a.interfaces = derived.interfaces;
        // Each module reused when its (module, interface) passed before under this checker, with no call; under another
        // checker its body is judged again, still with no call (the design §5); else it waits for its author.
        const modules = new Map<string, ModuleState>();
        const recheck: [ModuleState, string][] = [];
        for (const iface of derived.interfaces) {
            const entry = a.reuse.get(reuseKey(iface.module, iface.interfaceHash));
            const m = fresh(iface);
            if (entry && entry.checker === checker.version && (entry.compiled || !a.compiler)) {
                Object.assign(m, {
                    body: entry.body, originalBody: entry.originalBody, codeHash: entry.codeHash, phase: 'passed', needs: null,
                    checkerVersion: entry.checker, evidence: [...entry.evidence], reused: true,
                });
                if (entry.verdict) a.verdicts.set(iface.module, entry.verdict);
            } else if (entry) {
                Object.assign(m, { body: entry.body, originalBody: entry.originalBody, codeHash: entry.codeHash, needs: null, reused: true, phase: 'checking' });
                recheck.push([m, entry.body]);
            }
            modules.set(iface.module, m);
        }
        a.modules = modules;
        a.phase = null;
        publish(a);
        for (const [m, body] of recheck) {
            await judge(a, m, body, { programHash: a.programHash, graph: a.graph, interfaceHash: m.interfaceHash, codeHash: m.codeHash }, null);
            if (!a.live()) return 'stop';
        }
        return admit(a, plan) ? 'ready' : 'stop';
    }

    /**
     * What this resolve's module work may start, once its program's interfaces are derived and every kept body judged
     * (EA6.3; the design §8.2, §8.3; the outside review of 11-02 night).
     *
     * A program revision's notes first: the whole plan held to the interfaces. A note to a module the program does not
     * name, or a second note to one module, refuses the plan whole, before any call: nothing of it is applied.
     *
     * Then Q_C, once the attempt has revised its program: the known work (the authors its new interfaces need, the
     * repairs its rechecks and its notes need, each module's own repairs) must fit what is left before any of it starts,
     * so no call is paid for on a candidate Q_C already cannot finish, whichever module comes first. A shortfall of the
     * program's own work stops the attempt as the scheduler would have, only before anything was spent; one that only
     * the notes cause refuses the plan. A first resolve keeps the scheduler's own refusals: its authors are bounded by
     * the module cap.
     *
     * Then each note is recorded, linked to the records the revision answered, and routed: a body the candidate keeps (its
     * interface unchanged) is repaired with the note as its finding, about that very body; a module whose body is to be
     * written (new, or its interface changed) is authored with it, once. False when the attempt stopped.
     */
    function admit(a: Attempt, taken: Attempt['plan']): boolean {
        // Only the program its own turn handed off (the resolve that took it follows that revision at once).
        const plan = taken && taken.turnId === a.turnId ? taken : null;
        if (plan) {
            const named = new Set<string>();
            for (const [i, r] of plan.repairs.entries()) {
                const why = !a.modules.has(r.module) ? `${r.module.slice(0, 40)} is not a module of the revised program`
                    : named.has(r.module) ? `${r.module.slice(0, 40)} has a note already` : null;
                if (why) {
                    a.halt({ scope: 'program', diagnostic: `EA_RESOLVE moduleRepairs[${i}]: ${why}; plan refused`, sentence: COPY.candidate.planRefused }, 'failed', now());
                    return false;
                }
                named.add(r.module);
            }
        }
        const kept = (m: ModuleState) => m.body !== null && m.codeHash !== null;
        const ms = [...a.modules.values()];
        const authors = ms.filter(m => m.needs === 'author').length;
        const repairing = ms.filter(m => m.needs === 'repair');
        // The repair calls the plan adds: a kept body's note, unless its module needs a repair already (the note joins it).
        const added = plan ? plan.repairs.map(r => a.modules.get(r.module)!).filter(m => kept(m) && m.needs !== 'repair') : [];
        if (a.turns.length > 1) {
            const own = shortfall(a, authors, repairing);
            if (own) {
                a.halt({ scope: 'budget', diagnostic: `${budgetDiagnostic(own)}${own.module ? ` (${own.module})` : ''}`, sentence: COPY.candidate.budget }, 'exhausted', now());
                return false;
            }
            const short = shortfall(a, authors, [...repairing, ...added]);
            if (short) {
                const of = short.module ? ` (${short.module})` : '';
                const more = `${added.length} more repair${added.length === 1 ? '' : 's'}`;
                a.halt({
                    scope: 'budget', diagnostic: `${budgetDiagnostic(short)}${of}: the plan needs ${more}; plan refused`, sentence: COPY.candidate.budget,
                }, 'exhausted', now());
                return false;
            }
        }
        if (!plan) return true;
        for (const r of plan.repairs) {
            const m = a.modules.get(r.module)!;
            const keeps = kept(m);
            const e = a.record({
                subject: a.subject({ module: m.module, interfaceHash: m.interfaceHash, codeHash: keeps ? m.codeHash : null }), phase: 'visual',
                verdict: 'unverified', producedBy: 'model', refs: plan.refs,
                findings: [{ code: NOTE_CODE, path: null, line: null, severity: 'warning', message: noteMessage(r.message), rung: 'note', place: null }],
            }, 'history');
            if (keeps) {
                // Its repair answers the note beside whatever its own check found (a recheck under another checker).
                m.addressed = m.needs === 'repair' ? [...m.addressed, e.findings[0].id] : [e.findings[0].id];
                m.needs = 'repair';
                m.phase = 'waiting';
            } else {
                m.note = r.message;
            }
        }
        publish(a);
        return true;
    }

    /**
     * The first of Q_C's budgets that cannot hold `authors` author calls and a repair for each of `repairing`, beside
     * what the attempt has spent and holds: the authors, each module's repairs, the repairs, then the calls. Null when all
     * of them fit. The numbers are the ledger's own, as the scheduler's refusal would give them.
     */
    function shortfall(a: Attempt, authors: number, repairing: readonly ModuleState[]): { budget: Budget; used: number; limit: number; module?: string } | null {
        const { limits, state } = a.ledger;
        if (state.authors + authors > limits.authors) return { budget: 'authors', used: state.authors, limit: limits.authors };
        const spent = repairing.find(m => (state.moduleRepairs[m.module] ?? 0) + 1 > limits.repairsPerModule);
        if (spent) return { budget: 'repairs-per-module', used: state.moduleRepairs[spent.module] ?? 0, limit: limits.repairsPerModule, module: spent.module };
        if (state.repairs + repairing.length > limits.repairs) return { budget: 'repairs', used: state.repairs, limit: limits.repairs };
        if (a.ledger.used + authors + repairing.length > limits.calls) return { budget: 'calls', used: a.ledger.used, limit: limits.calls };
        return null;
    }

    /** A body's checks: L1, L2 once, the final L1 decides; then L3 when a compiler is given. Applies only while current. */
    async function judge(a: Attempt, m: ModuleState, answer: string, inputs: Inputs, jobId: string | null): Promise<void> {
        const still = () => a.live() && a.modules.get(m.module) === m && (jobId === null || a.active.has(jobId)) && a.programHash === inputs.programHash
            && a.graph === inputs.graph && m.interfaceHash === inputs.interfaceHash && m.codeHash === inputs.codeHash;
        m.phase = 'checking';
        publish(a);
        const iface = a.iface(m.module);
        const checked = await checker.check(iface, answer);
        if (!still()) return;
        // A new body for this module, as judged: a new revision of the candidate.
        a.revision++;
        m.body = checked.body;
        m.originalBody = checked.original;
        m.codeHash = checked.codeHash;
        m.checkerVersion = checker.version;
        inputs.codeHash = checked.codeHash;
        const lint = a.record({
            subject: a.subject({ module: m.module, interfaceHash: m.interfaceHash, codeHash: checked.codeHash }), phase: 'lint',
            verdict: checked.ok ? 'pass' : 'fail', producedBy: 'host',
            findings: checked.findings.map(f => ({ code: f.code, path: null, line: f.line, severity: f.severity, message: f.message, rung: f.rung, place: null })),
        }, { module: m, reset: true });
        if (!checked.ok) {
            m.addressed = lint.findings.map(f => f.id);
            m.needs = 'repair';
            m.phase = 'waiting';
            publish(a);
            return;
        }
        let verdict: DeepReadonly<CompiledBody> | null = null;
        if (a.compiler) {
            const compiled = await compileBody(iface, checked, a.compiler);
            if (!still()) return;
            verdict = compiled;
            const placed = (list: typeof compiled.body, place: 'body' | 'host' | 'unplaced') =>
                list.map(f => ({ code: f.code, path: null, line: f.line, severity: f.severity, message: f.message, rung: f.rung, place }));
            const ce = a.record({
                subject: a.subject({ module: m.module, interfaceHash: m.interfaceHash, codeHash: checked.codeHash }), phase: 'compile',
                verdict: compiled.ok ? 'pass' : 'fail', producedBy: compiled.producedBy,
                findings: [...placed(compiled.body, 'body'), ...placed(compiled.host, 'host'), ...placed(compiled.unplaced, 'unplaced')],
            }, { module: m, reset: false });
            if (!compiled.ok) {
                const scope = route(ce);
                const first = ce.findings.find(f => f.severity === 'error')!;
                if (scope === 'host') {
                    // The host's own code: never sent to a body repair (the design §7, §8).
                    m.phase = 'failed';
                    m.needs = null;
                    a.halt({ scope: 'host', diagnostic: `EA_MODULE ${m.module}: L3 in the host's generated source: ${first.message}`, sentence: COPY.candidate.refused }, 'failed', now());
                    return;
                }
                if (scope === 'candidate') {
                    m.needs = null;
                    a.halt({ scope: 'candidate', diagnostic: `EA_MODULE ${m.module}: L3 with no line: ${first.message}; no module is accused`, sentence: COPY.candidate.refused }, 'failed', now());
                    return;
                }
                m.addressed = ce.findings.filter(f => f.place === 'body').map(f => f.id);
                m.needs = 'repair';
                m.phase = 'waiting';
                publish(a);
                return;
            }
        }
        m.phase = 'passed';
        m.needs = null;
        m.addressed = [];
        if (verdict) a.verdicts.set(m.module, verdict);
        a.reuse.set(reuseKey(m.module, m.interfaceHash), {
            body: checked.body, originalBody: checked.original, codeHash: checked.codeHash, checker: checker.version, compiled: !!a.compiler, verdict,
            evidence: [...m.evidence],
        });
        publish(a);
    }

    /** One module call: reserved already; dispatched here, its answer judged while it is still current. Never rejects. */
    async function runJob(a: Attempt, m: ModuleState, kind: 'author' | 'repair', reservation: Reservation, jobId: string, record: JobRecord): Promise<void> {
        const inputs: Inputs = { programHash: a.programHash, graph: a.graph, interfaceHash: m.interfaceHash, codeHash: m.codeHash };
        let usage: ModuleUsage | null = null;
        const envelope = kind === 'repair' ? a.repairEnvelope(m) : null;
        try {
            const iface = a.iface(m.module);
            const previous = kind === 'repair' ? previousOf(a, m) : null;
            const body: ModuleCallBody = {
                turnId: a.turnId, jobId,
                subject: a.subject({ module: m.module, interfaceHash: m.interfaceHash, codeHash: kind === 'repair' ? m.codeHash : null }),
                versions: MODULE_VERSIONS, purpose: kind, request: a.request, design: a.design,
                nodes: moduleNodes(a.program, iface.node),
                module: { id: m.module, kind: iface.kind, interface: wireInterface(iface) },
                previous,
                // A revision's note to a module it adds or rewires goes with its author (EA6.3); a repair's is a finding.
                note: kind === 'author' ? m.note : null,
            };
            a.ledger.dispatched(reservation);
            let outcome: ModuleOutcome;
            try {
                outcome = await deps.modules.call(body, event => {
                    if (event.type === 'meta') Object.assign(record, { generationId: event.meta.generationId, model: event.meta.model, promptVersion: event.meta.promptVersion });
                    if (event.type === 'usage') usage = event.usage;
                }, AbortSignal.any([a.controller.signal, a.work.signal]));
            } catch (error) {
                // Its end was not seen: the slot is spent, the charge known only when a usage came (the design §8).
                a.ledger.settle(reservation, usage ? 1 : null);
                Object.assign(record, { charge: usage ? 'known' : 'unknown', costMicroUsd: (usage as ModuleUsage | null)?.costMicroUsd ?? null });
                if (!a.live()) {
                    record.status = 'cancelled';
                    return;
                }
                record.error = message(error);
                if (error instanceof ModuleStreamError) {
                    record.status = 'broken';
                    a.halt({ scope: 'host', diagnostic: error.message, sentence: COPY.candidate.stream }, 'failed', now());
                } else if (error instanceof ForgeError) {
                    record.status = 'refused';
                    a.halt({ scope: 'host', diagnostic: `${error.code}: ${error.message}`, sentence: sentenceFor(error.code) }, 'failed', now());
                } else {
                    record.status = 'broken';
                    a.halt({ scope: 'host', diagnostic: `module call ${jobId}: ${message(error)}`, sentence: COPY.candidate.refused }, 'failed', now());
                }
                return;
            }
            a.ledger.settle(reservation, 1);
            Object.assign(record, { charge: outcome.usage ? 'known' : 'unknown', costMicroUsd: outcome.usage?.costMicroUsd ?? null });
            if (!a.live()) {
                record.status = 'cancelled';
                return;
            }
            const stillCurrent = a.modules.get(m.module) === m && a.programHash === inputs.programHash && a.graph === inputs.graph
                && m.interfaceHash === inputs.interfaceHash && m.codeHash === inputs.codeHash;
            // A repair's envelope again, before its result is applied: the body and the findings it answers still current.
            const staleWhy = envelope ? a.verify(envelope) : null;
            if (!stillCurrent || staleWhy) {
                record.status = 'stale';
                record.error = staleWhy ?? 'its inputs changed while it ran';
                return;
            }
            if (outcome.status === 'error') {
                record.status = 'unusable';
                record.error = `${outcome.code}: ${outcome.message}`;
                if (outcome.code === 'upstream') {
                    // The call ended and its answer was unusable (empty, cut, no entry): the module needs the same call
                    // again, which Q_C counts like any other. Never a retry of a stream whose end was not seen.
                    m.phase = 'waiting';
                    publish(a);
                    return;
                }
                a.halt({ scope: 'host', diagnostic: `${outcome.code}: ${outcome.message}`, sentence: sentenceFor(outcome.code) }, 'failed', now());
                return;
            }
            record.status = 'ok';
            // The note was written with once (EA6.3): what this body gets judged on now is the checks', not the note again.
            if (kind === 'author') m.note = null;
            await judge(a, m, outcome.answer, inputs, jobId);
        } catch (error) {
            if (record.status === 'running') {
                record.status = 'broken';
                record.error = message(error);
            }
            if (a.live()) fail(a, error);
        }
    }

    /** A repair's previous body: exactly as judged, with the findings it answers and their records. */
    function previousOf(a: Attempt, m: ModuleState): ModuleCallBody['previous'] {
        const held = m.addressed.map(id => a.store.finding(id)).filter((h): h is NonNullable<typeof h> => h !== null);
        // A revision's note first (EA6.3: never the one the backend's 32 leave out), then errors, then warnings: a repair
        // answers what failed before what only warned.
        const rank = (f: EvidenceFinding) => (f.rung === 'note' ? 0 : f.severity === 'error' ? 1 : 2);
        held.sort((p, q) => rank(p.finding) - rank(q.finding));
        const findings: WireFinding[] = held.map(({ finding: f }) => ({
            id: f.id, rung: f.rung ?? 'L1', code: f.code, path: f.path, line: f.line, severity: f.severity, message: f.message,
        }));
        return { body: m.body!, codeHash: m.codeHash!, evidenceIds: [...new Set(held.map(h => h.record.id))], findings };
    }

    /** Dispatches module calls within Q_C until every module passed, or the attempt stops. */
    async function moduleWork(a: Attempt): Promise<boolean> {
        for (;;) {
            if (!a.live()) return false;
            for (const m of a.modules.values()) {
                if (!a.live()) break;
                if (m.needs === null || m.phase !== 'waiting' || [...a.active.values()].some(j => j.module === m.module)) continue;
                const kind = m.needs;
                const r = a.ledger.reserveModule(kind, m.module);
                if (!r.ok) {
                    if (r.budget === 'concurrent') break;
                    if (r.budget === 'repairs-per-module') {
                        const f = m.addressed.map(id => a.store.finding(id)).find(h => h?.finding.severity === 'error')?.finding;
                        m.phase = 'failed';
                        m.needs = null;
                        a.halt({
                            scope: 'modules',
                            diagnostic: `EA_MODULE ${m.module}: ${f?.rung ?? 'L1'} at line ${f?.line ?? '?'}: ${f?.message ?? 'its checks failed'}; ${m.repairs} repairs used`,
                            sentence: COPY.candidate.moduleFailed,
                        }, 'failed', now());
                    } else {
                        exhausted(a, r);
                    }
                    break;
                }
                // A repair answers the module's own findings, about its body as it is now: its envelope is built from this
                // very state, so it holds here by construction. A correction from outside was verified in `correct`, and
                // every result is verified again before it is applied (runJob).
                const jobId = `job-${++a.jobSeq}`;
                const record: JobRecord = {
                    jobId, module: m.module, purpose: kind, revision: a.revision, status: 'running', charge: 'unknown', costMicroUsd: null,
                    generationId: null, model: null, promptVersion: null, error: null,
                };
                a.jobs.push(record);
                m.phase = kind === 'author' ? 'authoring' : 'repairing';
                m.calls++;
                if (kind === 'repair') m.repairs++;
                const promise = runJob(a, m, kind, r.reservation, jobId, record).finally(() => {
                    a.active.delete(jobId);
                    publish(a);
                });
                a.active.set(jobId, { module: m.module, promise });
            }
            if (!a.live()) return false;
            if (a.active.size === 0) {
                if ([...a.modules.values()].every(m => m.phase === 'passed')) return true;
                a.halt({ scope: 'host', diagnostic: 'internal: no module call could start, and not every module passed', sentence: COPY.candidate.refused }, 'failed', now());
                return false;
            }
            publish(a);
            await Promise.race([...a.active.values()].map(j => j.promise));
        }
    }

    /**
     * Every module passed: the host seals the candidate, and its completion references each module's own checks. The seal
     * resolves W again and holds it to the X this attempt's evidence names; it takes no X, checks or interfaces from here.
     */
    async function verifying(a: Attempt): Promise<void> {
        const modules = [...a.modules.values()];
        const sealed = await sealCandidate({
            attempt: a.id, revision: a.revision, program: a.program.nodes, graph: a.graph!,
            bodies: modules.map(m => ({ module: m.module, interfaceHash: m.interfaceHash, body: m.body!, codeHash: m.codeHash!, evidence: m.evidence })),
        });
        if (!a.live()) return;
        if (!sealed.ok) {
            a.halt({ scope: 'candidate', diagnostic: `the host could not seal the candidate: ${sealed.reason}`, sentence: COPY.candidate.refused }, 'failed', now());
            return;
        }
        a.record({
            subject: a.subject({ candidate: sealed.snapshot.id }), phase: 'candidate', verdict: 'pass', producedBy: 'host',
            refs: modules.flatMap(m => m.evidence),
        }, 'completion');
        // L3's verdict on each sealed body, in the snapshot's order, the objects as their compiler made them: EA5's
        // admission evidence. A module passes only with a verdict on the body it passed with, and the authority checks
        // each against the snapshot again (the device compiler's provenance), trusting nothing kept here.
        const verdicts = sealed.snapshot.bodies.map(b => a.verdicts.get(b.module));
        a.compiled = a.compiler && verdicts.every(v => v !== undefined) ? Object.freeze(verdicts as DeepReadonly<CompiledBody>[]) : null;
        a.snapshot = sealed.snapshot;
        a.verified = sealed.snapshot;
        a.verifiedTurn = a.turnId;
        a.phase = 'static-verified';
        a.endedMs = now();
    }

    /** Runs an attempt from `step` to its end, and leaves nothing running behind it. */
    async function drive(a: Attempt, step: 'resolve' | 'modules' | { revise: readonly EvidenceFinding[]; said: string; reserved?: Reservation }): Promise<void> {
        a.running = true;
        // A fresh controller for this run's calls: an earlier stop aborted the last one, and must not abort these.
        a.work = new AbortController();
        try {
            let next = step;
            for (;;) {
                if (typeof next === 'object') {
                    if (await revise(a, next.revise, next.said, next.reserved ?? null) === 'stop') return;
                    next = 'resolve';
                }
                if (next === 'resolve') {
                    const r = await resolving(a);
                    if (r === 'stop') return;
                    if (r === 'again') continue;
                }
                if (!await moduleWork(a)) return;
                await verifying(a);
                return;
            }
        } catch (error) {
            if (a.live()) fail(a, error);
        } finally {
            // Every job still running was aborted by the stop; wait for each to settle its accounting.
            await Promise.allSettled([...a.active.values()].map(j => j.promise));
            a.running = false;
            publish(a);
        }
    }

    return {
        get state() {
            return current ? current.view() : null;
        },
        get snapshot() {
            return current && !current.closed ? current.snapshot : null;
        },
        get compiled() {
            return current && !current.closed && current.snapshot ? current.compiled : null;
        },
        async start(handOff) {
            const previous = current;
            const compiler = typeof deps.compiler === 'function' ? deps.compiler() : deps.compiler ?? null;
            const a = new Attempt(handOff, attemptId(), limits, evidenceLimits, now(), compiler);
            if (previous && !previous.closed) {
                // Superseded: closed before it is aborted, so nothing it says or resolves to changes anything after.
                previous.close('superseded', now());
            }
            current = a;
            publish(a);
            await drive(a, 'resolve');
            return a.view();
        },
        cancel() {
            const a = current;
            if (!a || a.closed) return;
            a.close('cancelled', now());
            publish(a, true);
        },
        async correct(envelope) {
            const a = current;
            if (!a || a.closed) return { ok: false, diagnostic: 'no candidate to correct' };
            if (a.running) return { ok: false, diagnostic: 'the candidate is still running: a correction waits until it settles' };
            const why = a.verify(envelope);
            if (why) return { ok: false, diagnostic: why };
            const held = envelope.findingsAddressed.map(id => a.store.finding(id)!);
            // Accepted: the candidate is reopened, and every counter goes on where it was (the design §8).
            a.stop = null;
            a.endedMs = null;
            a.snapshot = null;
            if (envelope.scope === 'program') {
                const first = held.find(h => h.finding.severity === 'error') ?? held[0];
                await drive(a, { revise: held.map(h => h.finding), said: `${first.finding.code}: ${first.finding.message}` });
            } else {
                for (const name of envelope.changes) {
                    const m = a.modules.get(name)!;
                    m.addressed = held.filter(h => h.record.subject.module === name).map(h => h.finding.id);
                    m.needs = 'repair';
                    m.phase = 'waiting';
                }
                a.phase = null;
                await drive(a, 'modules');
            }
            return { ok: true, state: a.view() };
        },
        visual(input) {
            const a = current;
            if (!a || a.closed) return null;
            const e = a.record({
                subject: a.subject({ candidate: a.snapshot?.id ?? null }), phase: 'visual', verdict: input.verdict, producedBy: input.producedBy,
                findings: (input.findings ?? []).map(f => ({ code: f.code.slice(0, 40), path: f.path ?? null, line: null, severity: 'error' as const, message: f.message.slice(0, 400), rung: null, place: null })),
            }, 'history');
            publish(a);
            return e;
        },
        get revisable() {
            return deps.revise !== undefined;
        },
        review(input) {
            const a = current;
            if (!a || a.closed) return { ok: false, diagnostic: 'EA_REVIEW_UNAVAILABLE no candidate in this session' };
            const why = expectation(a, input.expected);
            if (why) return { ok: false, diagnostic: why };
            // The host's look is the device's; a verdict is the creator's or a model's (P4: neither is a technical one).
            const fits = input.phase === 'render' ? input.producedBy === 'device' : input.producedBy !== 'device';
            if (!fits) return { ok: false, diagnostic: `a ${input.phase} record is not the ${input.producedBy}'s to make` };
            try {
                const e = a.record({
                    subject: a.subject({ candidate: a.snapshot!.id }), phase: input.phase, verdict: input.verdict, producedBy: input.producedBy, refs: input.refs,
                    findings: (input.findings ?? []).map(f => ({
                        code: f.code.slice(0, 40), path: null, line: null, severity: f.severity ?? 'warning', message: f.message.slice(0, IMPROVE_WORDS), rung: null, place: null,
                    })),
                }, 'history');
                publish(a);
                return { ok: true, evidence: e };
            } catch (error) {
                return { ok: false, diagnostic: message(error) };
            }
        },
        async improve(input) {
            const a = current;
            if (!a || a.closed) return { ok: false, diagnostic: 'EA_REVIEW_UNAVAILABLE no candidate in this session' };
            if (!deps.revise) return { ok: false, diagnostic: 'EA_REVIEW_UNAVAILABLE no program revision here: this session has no reviser' };
            if (a.running) return { ok: false, diagnostic: 'the candidate is still running: an improvement waits until it settles' };
            const why = expectation(a, input.expected);
            if (why) return { ok: false, diagnostic: why };
            const sealed = a.snapshot!;
            const words = input.words.trim();
            if (!words && !input.findings.length) return { ok: false, diagnostic: 'an improvement answers the creator\'s words or a finding they chose: there are neither' };
            if (words.length > IMPROVE_WORDS) return { ok: false, diagnostic: `the creator's words are at most ${IMPROVE_WORDS} characters: these are ${words.length}` };
            const cited = input.findings.length + (words ? 1 : 0);
            if (cited > IMPROVE_FINDINGS) return { ok: false, diagnostic: `an improvement cites at most ${IMPROVE_FINDINGS} findings, the revision's bound: this one cites ${cited}` };
            // The host's findings it chose: held now, the host's look at this very candidate, each once.
            const chosen: { record: CandidateEvidence; finding: EvidenceFinding }[] = [];
            for (const id of input.findings) {
                const held = a.store.finding(id);
                if (!held) return { ok: false, diagnostic: stale('a finding this attempt holds', id) };
                if (held.record.phase !== 'render') return { ok: false, diagnostic: `${id} is not one of the host's findings about the stage (${held.record.phase})` };
                if (held.record.subject.candidate !== sealed.id) return { ok: false, diagnostic: stale(`id(C) ${short(sealed.id)}`, `a finding about ${short(held.record.subject.candidate)} (${id})`) };
                if (chosen.some(c => c.finding.id === id)) return { ok: false, diagnostic: `a correction cites each finding once: ${id} is cited twice` };
                chosen.push(held);
            }
            // The round and the revision's allowance, both at once and synchronously: a duplicate press finds the attempt
            // running, and a refusal changes nothing (§8.3). A round whose revision never went out is given back.
            const round = a.ledger.reserveVisualRound();
            if (!round.ok) return { ok: false, diagnostic: `EA_REVIEW_BUDGET visual rounds ${round.used} of ${round.limit}` };
            const r = a.ledger.reserveRevision();
            if (!r.ok) {
                a.ledger.returnVisualRound();
                return { ok: false, diagnostic: budgetDiagnostic(r) };
            }
            const giveBack = () => {
                a.ledger.release(r.reservation);
                a.ledger.returnVisualRound();
            };
            let verdict: CandidateEvidence;
            try {
                // The creator's verdict (E_v): their words its one finding, standing on the host's findings they chose.
                verdict = a.record({
                    subject: a.subject({ candidate: sealed.id }), phase: 'visual', verdict: 'fail', producedBy: 'creator', refs: [...new Set(chosen.map(c => c.record.id))],
                    findings: words ? [{ code: 'creator', path: null, line: null, severity: 'error' as const, message: words, rung: null, place: null }] : [],
                }, 'history');
            } catch (error) {
                giveBack();
                return { ok: false, diagnostic: message(error) };
            }
            const envelope: Envelope = {
                base: { attempt: a.id, revision: a.revision, candidate: sealed.id, programHash: a.programHash ?? '', graph: a.graph },
                scope: 'program', changes: [], findingsAddressed: [...verdict.findings.map(f => f.id), ...chosen.map(c => c.finding.id)],
            };
            const refused = a.verify(envelope);
            if (refused) {
                giveBack();
                publish(a);
                return { ok: false, diagnostic: refused };
            }
            const held = envelope.findingsAddressed.map(id => a.store.finding(id)!);
            // What a restore puts back: the reuse entries the sealed candidate's bodies passed with, as they are now.
            const kept = sealed.bodies.map(b => [reuseKey(b.module, b.interfaceHash), a.reuse.get(reuseKey(b.module, b.interfaceHash))] as const);
            // Accepted: reopened as a correction reopens it; every counter goes on where it was.
            a.stop = null;
            a.endedMs = null;
            a.snapshot = null;
            const first = held[0].finding;
            await drive(a, { revise: held.map(h => h.finding), said: `${first.code}: ${first.message}`, reserved: r.reservation });
            // Read fresh: the round reassigned them (flow analysis still holds the nulls set above).
            const now = () => ({ snapshot: a.snapshot as Snapshot | null, stop: a.stop as CandidateStop | null, verified: a.verified as Snapshot | null });
            const after = now();
            if (after.snapshot && a.phase === 'static-verified' && after.snapshot.id !== sealed.id) return { ok: true, state: a.view(), round: { improved: true, stop: null, restored: false } };
            // No new candidate (the revision asked or declined, a budget refused, a stream broke): the session goes back to
            // the candidate the round started from, the one on the stage, with its own bodies and no call, so the creator
            // may try again within what is left (the outside review of 11-02 night). Every call and the round stay spent.
            // A cancel is the creator's own stop, and stays one.
            const stop = after.stop;
            let restored = false;
            if (!a.closed && after.verified?.id === sealed.id && kept.every(([, entry]) => entry !== undefined)) {
                for (const [key, entry] of kept) a.reuse.set(key, entry!);
                a.program = deepFreeze(structuredClone({ nodes: sealed.program as WorldProgram['nodes'] })) as WorldProgram;
                a.turnId = a.verifiedTurn ?? a.turnId;
                a.stop = null;
                a.endedMs = null;
                await drive(a, 'resolve');
                restored = !a.closed && now().snapshot?.id === sealed.id;
            }
            return { ok: true, state: a.view(), round: { improved: false, stop, restored } };
        },
    };
}

const short = (s: string | null | undefined) => (s === null || s === undefined ? 'none' : s.length > 16 ? s.slice(0, 12) : s);
const stale = (expected: string, got: string) => `EA_STALE_EVIDENCE expected ${expected}, got ${got}`;

/** Null when a review of `e` may still be recorded here: the same attempt, and its sealed candidate the one reviewed. */
function expectation(a: Attempt, e: ReviewExpectation): string | null {
    if (e.attempt !== a.id) return stale(`attempt ${short(a.id)}`, `attempt ${short(e.attempt)}`);
    const now = a.snapshot?.id ?? null;
    if (now !== e.candidate) return `EA_STALE_EVIDENCE expected id(C) ${short(now)}, the review is about ${short(e.candidate)}`;
    return null;
}

/** The bundle's format: what EA4.5's Developer view downloads (the design §9); v2 holds the turns (the EA4.5 review). */
export const CANDIDATE_BUNDLE = 'wexy-candidate-bundle.v2';

/**
 * A candidate as a downloadable bundle (the design §9): the candidate, its bodies, its evidence and its identities;
 * the omissions, the checker and template versions, and each call's usage, known or unknown: the turns' calls (the
 * hand-off's and each revision's) and the module jobs, so every call Q_C counts has its record. No credential or App
 * Check token is anywhere in a state, so none is here. It holds R and the bodies, so exporting it is a developer's act.
 */
export function candidateBundle(state: DeepReadonly<CandidateState>) {
    const omitted = Object.values(state.omitted).reduce((sum, n) => sum + n, 0);
    const templates = [...state.turns.map(t => t.promptVersion), ...state.jobs.map(j => j.promptVersion)].filter((v): v is string => v !== null);
    return {
        format: CANDIDATE_BUNDLE,
        attempt: state.attempt,
        revision: state.revision,
        candidate: state.id,
        phase: state.phase,
        versions: { ...MODULE_VERSIONS, templates: [...new Set(templates)] },
        request: state.request,
        design: state.design,
        program: state.program,
        programHash: state.programHash,
        graph: state.graph,
        modules: state.modules.map(m => ({
            module: m.module, kind: m.kind, interfaceHash: m.interfaceHash, codeHash: m.codeHash, body: m.body, originalBody: m.originalBody,
            checker: m.checkerVersion, phase: m.phase, reused: m.reused, calls: m.calls, repairs: m.repairs,
        })),
        evidence: state.evidence,
        omitted: { records: omitted, byPhase: state.omitted },
        calls: {
            budget: state.budget,
            limits: state.limits,
            turns: state.turns.map(t => ({
                role: t.role, turnId: t.turnId, revision: t.revision, status: t.status, model: t.model, promptVersion: t.promptVersion, charge: t.charge,
                calls: t.calls.map(c => ({ n: c.n, purpose: c.purpose, charge: c.charge, costMicroUsd: c.costMicroUsd, generationId: c.generationId })), error: t.error,
            })),
            jobs: state.jobs.map(j => ({ jobId: j.jobId, module: j.module, purpose: j.purpose, status: j.status, charge: j.charge, costMicroUsd: j.costMicroUsd, model: j.model, generationId: j.generationId, promptVersion: j.promptVersion })),
        },
        // What judged L3 (EA5.1): the device and its GPU, a fake, or nothing; each compile verdict is in `evidence`.
        l3: state.l3,
        stop: state.stop,
    };
}
