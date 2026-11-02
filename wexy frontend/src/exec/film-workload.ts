// Films and photos of an agent world (EA5.5; executor-design.md §9a; Q87 (b)): null-graph/film's workload for the world on
// the stage, built again from its sealed candidate C on the film's own engine. The stage's world is never filmed in place:
// the film's engine adopts the device, and a film starts from time zero (EA7 owns a film that continues from the stage).
//
// null-graph/film steps and draws a workload at the film's full size as soon as `createWorkload` returns: its calibration
// (guard.ts calibrateFilm) before any timing, and a photo (record.ts snapshot) with no guard at all. So each invocation
// runs the whole construction before it returns (I3): an admission minted for this film alone, then the coordinator
// (instantiate) with the stage's own preparation at the film's size (the probe on variants, init approved at full size,
// the offscreen first frame and its sanity look), and only then the workload. A refusal anywhere throws `EA_FILM` before a
// single unprobed full-size submission.
//
// The admission (§9a): every measurement (the dialog's dry run, on open and on every change), every film and every photo
// is a createWorkload of its own, and admissions are single-use (loop/executor.ts). Each therefore mints a fresh one from
// what admitted the Head: its device verdicts for exactly C's bodies (current only in this device generation), and the
// host's own go for the world it installed, pressed by the dialog's control, never by a program (Q89). It is bound to C's
// install (a new world on the stage supersedes it) and the device generation; nothing of the stage's own admission is
// reused. The gate is the stage's (limits, eligibility and memory at the film's size, beside the Head in the one ledger).
//
// Time zero (§9a): calibration steps and draws the workload, then the runner asks for its initial state again (`reset`),
// which R gives on the same construction (no second admission), and steps `s = round(1 / (fps · dt))` times before each
// frame, the first included. The first `s` after a reset are no-ops (`leadIn`, as h1's filmWorkload), so frame k shows
// k·s fixed steps from time zero and frame 0 is time zero exactly, as a photo is.

import { fitAspect, type CameraView as FilmView, type CreateFilmWorkload, type FilmWorkload } from 'null-graph/film';
import type { CompiledBody } from '../contract/adapters/bodies';
import type { DeepReadonly } from '../contract/engine/frozen';
import { createAuthority, instantiate, type Outcome, type Present } from '../loop/executor';
import type { SealedCandidate } from '../loop/snapshot';
import type { CameraView } from '../runtime/camera-path';
import { createEngineExecutor } from './engine-executor';
import type { EnginePort } from './engine-port';
import type { Environment, Parsed } from './eligibility';
import { createGate, createGoLedger, reservationFor, type DeviceLimits, type GateOptions, type MemoryLedger } from './gate';
import type { HeadlessPort } from './probe';
import { stagePreparation, type PrepareReport } from './stage';
import type { AgentRuntime } from './world-runtime';

type Snapshot = DeepReadonly<SealedCandidate>;

/** What a film's frames showed, said once it is disposed (EA-F2): frame k at k·s fixed steps from time zero. */
export interface FrameAccount {
    candidate: string;
    /** The fixed steps a frame. */
    stepsPerFrame: number;
    /** Frames drawn after the runner's reset: the film's own (calibration's draws come before it). */
    frames: number;
    /** Of those, the frames whose world was not at `index · stepsPerFrame` steps. */
    offTime: number;
    /** The steps the world had taken at frame 0, and at the last frame. */
    firstFrameSteps: number | null;
    last: { index: number; steps: number } | null;
}

export interface FilmDeps {
    /** The film's engine as a port (createNullGraphPort); a test's fake. */
    port(engine: unknown): EnginePort;
    /** A headless engine adopting the device, for the probe's variants. */
    headless(width: number, height: number): Promise<HeadlessPort>;
    now(): number;
    /** The probe's quiet window: the stage's Head holds (the viewport's pause; a film's dialog has paused it already). */
    quiet?: () => () => void;
    // The stage's gate, at the film's size.
    limits: DeviceLimits;
    compiler: GateOptions['compiler'];
    environment: Environment;
    gpu: string;
    eligibility?: Parsed;
    /** The stage's ledger: a film's construction reserves beside the Head (I7). */
    ledger: MemoryLedger;
    /** What a film is bound to: the Head's install (a counter the studio moves with each) and the device generation. */
    present: Present;
    /** The id(C) on the stage now, or null: a film of a world no longer there is refused. */
    onStage(): string | null;
    /** The device verdicts the Head was admitted on: each film's evidence. */
    compiled: readonly DeepReadonly<CompiledBody>[];
    /** Each preparation's report (the probe's numbers at the film's size), for Developer view. */
    report?(r: PrepareReport): void;
    /** A film's frames, said once it is disposed. */
    onFrames?(a: FrameAccount): void;
}

/** null-graph's view (readonly, `fov` optional) as R takes it. */
function asView(v: FilmView): CameraView {
    return { target: [v.target[0], v.target[1], v.target[2]], distance: v.distance, azimuth: v.azimuth, polar: v.polar, fov: v.fov ?? 45 };
}

const short = (hash: string) => `${hash.slice(0, 12)}…`;

function outcomeWords(o: Exclude<Outcome, { status: 'installed' }>): string {
    const released = 'releaseErrors' in o && o.releaseErrors.length ? `; releases failed: ${o.releaseErrors.join('; ')}` : '';
    switch (o.status) {
        case 'refused': return o.reason;
        case 'stopped': return `${o.why}${released}`;
        case 'failed': return `${o.error}${released}`;
    }
}

/**
 * The workload of `snapshot`, the world on the stage, for a film at `fps` (or a photo), its view `still` where the film
 * has no camera path. Each invocation is admitted and built on its own (above); it throws `EA_FILM <id> at WxH: <why>`
 * when anything refuses, with nothing left of it.
 */
export function agentFilmWorkload(snapshot: Snapshot, deps: FilmDeps, { fps, still }: { fps: number; still: CameraView }): CreateFilmWorkload {
    return async ({ engine, width, height, signal }) => {
        const where = `EA_FILM ${short(snapshot.id)} at ${width}x${height}`;
        const refuse = (why: string): never => {
            // A cancel is the runner's to say, as one (it rejects a cancelled film with an AbortError).
            signal.throwIfAborted();
            throw new Error(`${where}: ${why}`);
        };
        if (deps.onStage() !== snapshot.id) refuse('this world is no longer on the stage');
        const target = { width, height };
        const goes = createGoLedger();
        const gate = createGate({
            limits: deps.limits, compiler: deps.compiler, goes, present: deps.present, ledger: deps.ledger, target: () => target,
            environment: deps.environment, gpu: deps.gpu, eligibility: deps.eligibility,
        });
        // The host's go for a film of the world it installed: the dialog's own control, for this one admission (Q89).
        goes.press(snapshot.id, deps.present.turn(), deps.present.device());
        const admitted = createAuthority(gate.gate).admit(snapshot, {
            compiled: deps.compiled, gpuGo: goes.holds(snapshot.id, deps.present.turn(), deps.present.device()),
        }, deps.present);
        if (!admitted.ok) return refuse(admitted.reason);
        const held = gate.claim(snapshot);
        if (!held) return refuse('internal: the admission made no reservation');
        const need = reservationFor(snapshot.x, target);
        const { turn, device } = admitted.admission;
        const stale = (): string | null => (signal.aborted ? 'cancelled' : deps.present.turn() !== turn ? 'superseded'
            : deps.present.device() !== device ? 'device-lost' : null);
        const aspect = width / height;
        const first = asView(fitAspect(still, aspect));
        // Written from the executor's callbacks: held in an object, which flow analysis does not narrow away (gotchas).
        const got: { runtime: AgentRuntime | null } = { runtime: null };
        let runtime: AgentRuntime;
        try {
            const port = deps.port(engine);
            // No envelope to pause past: a film's engine keeps its size.
            const executor = createEngineExecutor({
                port,
                prepare: stagePreparation(snapshot, port, {
                    headless: deps.headless, now: deps.now, view: () => first, target, need, signal, stale, quiet: deps.quiet,
                    // The film's engine has a camera of its own: nothing of the Head's to write back.
                    restoreHeadCamera: () => {},
                    coverageWarning: gate.coverageWarning(snapshot), report: r => deps.report?.(r),
                }),
                onCommit: runtime => { got.runtime = runtime; },
            });
            const outcome = await instantiate(snapshot, admitted.admission, executor, deps.present, signal);
            if (outcome.status !== 'installed') return refuse(outcomeWords(outcome));
            if (!got.runtime) return refuse('internal: built with no runtime');
            runtime = got.runtime;
        } catch (e) {
            held.release();
            throw e;
        }
        // The probe's and the readback's shares are gone; the film's construction holds its own until it is disposed.
        held.shrink(need.candidate);

        const s = Math.round(1 / (fps * runtime.dt));
        let leadIn = 0;
        let reset = false;
        let disposed = false;
        const account: FrameAccount = { candidate: snapshot.id, stepsPerFrame: s, frames: 0, offTime: 0, firstFrameSteps: null, last: null };
        const workload: FilmWorkload = {
            dt: runtime.dt,
            // After calibration: time zero again on this construction, and the lead-in that keeps frame 0 there.
            reset() {
                runtime.reset();
                leadIn = s;
                reset = true;
            },
            step() {
                if (leadIn > 0) {
                    leadIn--;
                    return;
                }
                runtime.step();
            },
            draw(frame) {
                runtime.view(asView(fitAspect(frame.view ?? still, aspect)), frame.seconds);
                if (reset) {
                    account.frames++;
                    if (runtime.steps !== frame.index * s) account.offTime++;
                    if (frame.index === 0) account.firstFrameSteps = runtime.steps;
                    account.last = { index: frame.index, steps: runtime.steps };
                }
                return runtime.draw();
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    runtime.destroy();
                } finally {
                    held.release();
                    if (reset) deps.onFrames?.({ ...account, last: account.last && { ...account.last } });
                }
            },
            info: { candidate: snapshot.id, leadInSteps: s, executorDt: runtime.dt },
        };
        return workload;
    };
}
