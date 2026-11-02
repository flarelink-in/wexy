// The loop's state machine (core-loop-frontend.md §2): plan → author → verify (→ repair → verify) → live, as pure
// TypeScript over a ForgeClient and a Verifier, so it runs under node --test with fakes (P1) and in the studio
// over the backend and the GPU. It never touches the DOM or a device: the studio draws what it emits. Invariant
// I1 is kept by construction: the world it hands back has passed the verifier, and a failure hands back nothing.

import { specFromDraft, type Draft } from '../contract/draft';
import { functionsOf, withProgramText, type FunctionName, type Program, type SceneSpec, type Style } from '../contract/spec';
import { toRepairDiagnostics, type ForgeClient, type FunctionResult, type GenerationInfo, type OutcomeReport } from '../forge-client/client';
import { ForgeError } from '../forge-client/errors';
import { COPY, type FailureKind } from './copy';
import { buildOutcome } from './outcome';
import type { GateDiagnostic } from '../verify/gate';

export interface LoopRequest {
    prompt: string;
    style: Style | 'auto';
    seconds: number;
}

/** The ladder's rungs (core-loop-frontend.md §7); L4 (pipelines) happens inside L6's build, L8 is the studio's swap. */
export type Rung = 'L0' | 'L1' | 'L2' | 'L3' | 'L5' | 'L6' | 'L7';

/** Each rung's name, for a developer's line beside its id (core-loop-frontend.md §7). */
export const RUNG_NAMES: Record<Rung, string> = { L0: 'parse', L1: 'lint', L2: 'auto-fix', L3: 'compile', L5: 'probe', L6: 'build', L7: 'sanity' };

export interface RungResult {
    rung: Rung;
    ok: boolean;
    ms: number;
    detail?: string;
}

export interface ProbeNumbers {
    /** One full-size step, predicted from the probe's small world. */
    stepMs: number;
    /** One full-size frame's draws, predicted; null when a step was refused before any frame was timed (F4). */
    frameMs: number | null;
    predictedMs: number;
    budgetMs: number;
    /** What the probe itself measured, per step and per frame, at its size. */
    measuredStepMs: number;
    measuredFrameMs: number | null;
}

export interface LadderReport {
    rungs: RungResult[];
    /** Auto-fixes applied, per function. */
    autofixes: Partial<Record<FunctionName, { line: number; rule: string }[]>>;
    probe: ProbeNumbers | null;
    totalMs: number;
}

export type FailureReason = 'missing' | 'lint' | 'compile' | 'probe' | 'smoke' | 'sanity';

export interface VerifyFailure {
    rung: Rung;
    reason: FailureReason;
    /** The function a repair would be sent for; null when no repair can help (the build itself failed). */
    target: FunctionName | null;
    diagnostics: GateDiagnostic[];
    /** A developer's sentence: the offender, the number, the way out. */
    message: string;
}

export type VerifyResult<W> =
    /** `spec` is the world as compiled, auto-fixes applied: what runs, shows its code and films (invariant I5). */
    | { ok: true; world: W; report: LadderReport; spec: SceneSpec }
    | { ok: false; report: LadderReport; failure: VerifyFailure };

/** The ladder, L1 to L7, on a device: verify/ladder.ts in the studio, a fake under test. */
export interface Verifier<W> {
    verify(spec: SceneSpec, signal: AbortSignal): Promise<VerifyResult<W>>;
}

export type LoopEvent =
    | { type: 'planning' }
    | { type: 'plan-text'; soFar: string }
    | { type: 'planned'; draft: Draft; generation: GenerationInfo; clamped: string[]; ready: boolean }
    | { type: 'authoring'; fns: FunctionName[] }
    | { type: 'function-text'; fn: FunctionName; soFar: string }
    | { type: 'authored'; fn: FunctionName; text: string; generation: GenerationInfo }
    | { type: 'verifying'; attempt: number; spec: SceneSpec }
    | { type: 'verified'; attempt: number; result: VerifyResult<unknown> }
    | { type: 'repairing'; fn: FunctionName; attempt: number; failure: VerifyFailure }
    | { type: 'repaired'; fn: FunctionName; text: string; generation: GenerationInfo }
    | { type: 'retrying'; what: 'plan' | FunctionName; error: ForgeError }
    | { type: 'slow'; what: 'plan' | 'repair' | FunctionName };

export interface LoopSuccess<W> {
    ok: true;
    spec: SceneSpec;
    world: W;
    report: LadderReport;
    generations: GenerationInfo[];
    /** The report for the backend, without what only the live world can tell (fps, the adapter, the browser). */
    outcome: OutcomeReport;
    stats: { planMs: number; authorMs: number; repairs: number; autofixes: number; firstPassOk: boolean };
}

export interface LoopFailure {
    ok: false;
    kind: FailureKind;
    /** The creator's sentence (copy.ts); empty for a cancel. */
    sentence: string;
    /** The developer's: the code, the stage, the offender. */
    detail: string;
    generations: GenerationInfo[];
    failure?: VerifyFailure;
    /**
     * The report for the backend when the ladder ran at least once: a failed world's evidence (F6), the last
     * ladder with every generation and the repairs that came back. None for a cancel, or before the ladder.
     */
    outcome?: OutcomeReport;
    error?: unknown;
}

export type LoopOutcome<W> = LoopSuccess<W> | LoopFailure;

export interface LoopDeps<W> {
    client: ForgeClient;
    verifier: Verifier<W>;
    /** Repairs per world before the loop gives up: the server allows three per function chain (repairer, repairer, escalator). */
    maxRepairs?: number;
    /** When to say "still writing…". */
    slowAfterMs?: number;
}

const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_SLOW_MS = 15_000;

const abortError = () => new DOMException('The loop was cancelled.', 'AbortError');

/** A call, retried once when the backend answered `upstream` (its §16: a bad answer is retried once, by the studio). */
async function retryOnce<T>(run: () => Promise<T>, onRetry: (error: ForgeError) => void): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof ForgeError && error.code === 'upstream') {
            onRetry(error);
            return run();
        }
        throw error;
    }
}

/** `run`, with a "slow" event if it takes longer than `ms`. */
async function withSlow<T>(ms: number, slow: () => void, run: () => Promise<T>): Promise<T> {
    const timer = setTimeout(slow, ms);
    try {
        return await run();
    } finally {
        clearTimeout(timer);
    }
}

/** A failure the creator can read: the kind, its sentence and the developer's detail. */
export function classifyError(error: unknown, stage: 'plan' | 'author' | 'repair'): { kind: FailureKind; sentence: string; detail: string } {
    if ((error as Error)?.name === 'AbortError') return { kind: 'cancelled', sentence: '', detail: 'cancelled' };
    if (error instanceof ForgeError) {
        const detail = `${stage}: ${error.code} (HTTP ${error.status}): ${error.message}`;
        const sentence = (kind: FailureKind) => ({ kind, sentence: COPY.failures[kind], detail });
        switch (error.code) {
            case 'budget': return sentence('budget');
            case 'paused': return sentence('paused');
            case 'unavailable': return error.status === 0 ? sentence('offline') : sentence('paused');
            case 'rate': {
                const minutes = error.retryAfterSeconds === null ? null : Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
                return { kind: 'rate', sentence: minutes === null ? COPY.failures.rate : COPY.rateWithMinutes(minutes), detail };
            }
            // W1: on a forge route, account-required is the anonymous allowance spent (the account's one world, or its
            // network's for the day): the studio offers Google sign-in, never a reload.
            case 'account-required': return sentence('allowance');
            case 'quota': {
                const reset = error.retryAfterSeconds === null ? null : new Date(Date.now() + error.retryAfterSeconds * 1000);
                return { kind: 'quota', sentence: reset === null ? COPY.failures.quota : COPY.quotaUntil(reset), detail };
            }
            case 'content-refused': return sentence('refused');
            case 'auth': case 'appcheck': case 'forbidden': return sentence('sign-in');
            case 'timeout': return stage === 'plan' ? sentence('plan') : sentence('author-slow');
            case 'upstream':
                // The backend judged the answer (empty, no function, declined) or Meta failed, twice: not slowness.
                if (/ran out of room/i.test(error.message)) return sentence('ran-out');
                return stage === 'plan' ? sentence('plan') : sentence('author-failed');
            case 'not-found': return sentence('plan');
            default: return sentence('internal');
        }
    }
    return { kind: 'internal', sentence: COPY.failures.internal, detail: `${stage}: ${(error as Error)?.message ?? String(error)}` };
}

/** One run of the loop: a world that passed the verifier, or a failure the creator can read. */
export async function runLoop<W>(deps: LoopDeps<W>, req: LoopRequest, onEvent: (event: LoopEvent) => void, signal: AbortSignal): Promise<LoopOutcome<W>> {
    const { client, verifier } = deps;
    const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    const slowMs = deps.slowAfterMs ?? DEFAULT_SLOW_MS;
    const generations: GenerationInfo[] = [];
    const emit = onEvent;
    let repairs = 0;
    let lastReport: LadderReport | null = null;
    /** What the backend hears of a failed world (F6): every generation and the last ladder, never an fps. */
    const failedOutcome = (): OutcomeReport | undefined => {
        if (!lastReport) return undefined;
        const autofixes = Object.values(lastReport.autofixes).reduce((n, f) => n + (f?.length ?? 0), 0);
        return buildOutcome(generations, lastReport, { repairs, autofixes, firstPassOk: false });
    };
    const fail = (kind: FailureKind, detail: string, extra: Partial<LoopFailure> = {}): LoopFailure =>
        ({ ok: false, kind, sentence: COPY.failures[kind], detail, generations, outcome: failedOutcome(), ...extra });

    let stage: 'plan' | 'author' | 'repair' = 'plan';
    try {
        signal.throwIfAborted();

        // 1. The plan, re-planned once when the backend no longer holds it or answered badly.
        emit({ type: 'planning' });
        const t0 = performance.now();
        const plan = await withSlow(slowMs, () => emit({ type: 'slow', what: 'plan' }), () =>
            retryOnce(() => client.plan(req, { onText: soFar => emit({ type: 'plan-text', soFar }) }, signal), error => emit({ type: 'retrying', what: 'plan', error })));
        const planMs = performance.now() - t0;
        generations.push(plan.generation);
        emit({ type: 'planned', draft: plan.draft, generation: plan.generation, clamped: plan.clamped, ready: !!plan.ready });

        // 2. The functions, at once; a source that holds the code already skips this.
        stage = 'author';
        let spec: SceneSpec;
        const wrote: Partial<Record<FunctionName, GenerationInfo>> = {};
        let authorMs = 0;
        if (plan.ready) {
            spec = plan.ready;
        } else {
            const fns = functionsOf(plan.draft);
            emit({ type: 'authoring', fns });
            const t1 = performance.now();
            const inner = new AbortController();
            const onAbort = () => inner.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            // Each author is kept as it finishes (F5): a sibling's failure stops the others, but what came back
            // counts, in the plan's order, and the loop waits for the stopped ones so nothing is heard after it.
            const done: Partial<Record<FunctionName, FunctionResult>> = {};
            const calls = fns.map(fn => withSlow(slowMs, () => emit({ type: 'slow', what: fn }), () =>
                retryOnce(() => client.author(fn, plan.generation.generationId, { onText: soFar => emit({ type: 'function-text', fn, soFar }) }, inner.signal),
                    error => emit({ type: 'retrying', what: fn, error })))
                .then(r => {
                    done[fn] = r;
                    emit({ type: 'authored', fn, text: r.text, generation: r.generation });
                }, error => { inner.abort(); throw error; }));
            try {
                await Promise.all(calls);
            } catch (error) {
                await Promise.allSettled(calls);
                throw error;
            } finally {
                signal.removeEventListener('abort', onAbort);
                for (const fn of fns) {
                    const r = done[fn];
                    if (r) {
                        generations.push(r.generation);
                        wrote[fn] = r.generation;
                    }
                }
            }
            authorMs = performance.now() - t1;
            const program: Program = { kind: 'functions' };
            for (const fn of fns) program[fn] = done[fn]!.text;
            spec = specFromDraft(plan.draft, program);
        }

        // 3. Verify, repairing the function the ladder names, until it passes or the repairs run out.
        let firstPassOk = false;
        for (let attempt = 1; ; attempt++) {
            signal.throwIfAborted();
            emit({ type: 'verifying', attempt, spec });
            const result = await verifier.verify(spec, signal);
            emit({ type: 'verified', attempt, result });
            lastReport = result.report;
            if (attempt === 1) firstPassOk = result.ok;
            if (result.ok) {
                const autofixes = Object.values(result.report.autofixes).reduce((n, f) => n + (f?.length ?? 0), 0);
                const stats = { planMs, authorMs, repairs, autofixes, firstPassOk };
                return { ok: true, spec: result.spec, world: result.world, report: result.report, generations, outcome: buildOutcome(generations, result.report, stats), stats };
            }
            const { failure } = result;
            const written = failure.target ? wrote[failure.target] : undefined;
            const repairable = failure.target !== null && failure.reason !== 'smoke' && written !== undefined;
            if (!repairable || repairs >= maxRepairs) {
                const kind: FailureKind = failure.reason === 'probe' ? 'too-heavy' : 'verify';
                return fail(kind, `${failure.rung} ${failure.reason}: ${failure.message}`, { failure });
            }
            stage = 'repair';
            const fn = failure.target!;
            emit({ type: 'repairing', fn, attempt: repairs + 1, failure });
            const fixed = await withSlow(slowMs, () => emit({ type: 'slow', what: 'repair' }), () =>
                retryOnce(() => client.repair(fn, written!.generationId, toRepairDiagnostics(failure.diagnostics), { onText: soFar => emit({ type: 'function-text', fn, soFar }) }, signal),
                    error => emit({ type: 'retrying', what: fn, error })));
            repairs++;
            generations.push(fixed.generation);
            wrote[fn] = fixed.generation;
            spec = withProgramText(spec, fn, fixed.text);
            emit({ type: 'repaired', fn, text: fixed.text, generation: fixed.generation });
        }
    } catch (error) {
        if (signal.aborted && (error as Error)?.name !== 'AbortError') {
            return { ok: false, kind: 'cancelled', sentence: '', detail: 'cancelled', generations, error: abortError() };
        }
        const c = classifyError(error, stage);
        return { ok: false, ...c, generations, outcome: c.kind === 'cancelled' ? undefined : failedOutcome(), error };
    }
}
