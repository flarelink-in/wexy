// EA9.6: verification types retained for examples, backdrops and archived h1 worlds; no creation loop.
import type { FunctionName, SceneSpec } from '../contract/spec';
import type { GateDiagnostic } from '../verify/gate';

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
