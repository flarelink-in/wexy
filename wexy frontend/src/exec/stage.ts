// The stage's Run (EA5.3; executor-design.md §3, §7, §9; Q89): the one path from a sealed candidate with its device
// verdicts to the world on the stage, behind ?agent=1 in Developer view.
//
//   press      the developer's "Run on this GPU", for one id(C) in this turn on this device generation (the go)
//   admit      the authority, with this file's gate: provenance, the go, the allowlist, limits, eligibility, memory
//   build      the coordinator (instantiate) runs X's init through the engine executor on the viewport's engine:
//              allocations, async compiles, bounded uploads; init's GPU work queued, never submitted
//   prepare    the probe on isolated variants, then (only if every submission is predicted under the cap) init's work at
//              full size, then the offscreen first frame at the canvas's size into a private target, the Head's camera
//              written back in the same synchronous section (in a finally, whatever the frame does), its pixels and the
//              world's f32 state judged; the world's output pointed back at the screen only once all of that passed.
//              Every submission runs inside an error checkpoint and is fenced; after every await, and right before each
//              full-size submission, the preparation checks it is still wanted (a cancel, a newer turn, another device
//              generation) and submits nothing more if not (the EA5.3 review)
//   commit     synchronous: the viewport's setRuntime, nothing else (no allocation, await or teardown)
//
// prepare() never writes the canvas or the Head's buffers, depth, lights or post targets. The engine's camera uniform is
// the one thing shared: every post pass binds it (null-graph's PostChain), so the candidate's offscreen frame writes it,
// and the Head's camera is written back before anything else can run. What the studio does after an install (the old
// world's teardown, its reservation returned, the controls an agent world has) is its own, after the switch: a teardown
// that fails cannot undo an install (§9).

import type { CompiledBody } from '../contract/adapters/bodies';
import type { DeepReadonly } from '../contract/engine/frozen';
import { createAuthority, instantiate, type Present } from '../loop/executor';
import type { SealedCandidate } from '../loop/snapshot';
import type { CameraView } from '../runtime/camera-path';
import { worldBounds, type WorldBounds } from './bounds';
import { createEngineExecutor, type PreparedWorld } from './engine-executor';
import type { EnginePort } from './engine-port';
import type { Environment, Parsed } from './eligibility';
import {
    createGate, createGoLedger, createMemoryLedger, reservationFor, type Bootstrap, type DeviceLimits, type GateOptions, type GoLedger, type MemoryLedger, type Reservation,
    type ReservationNeed, type Target,
} from './gate';
import { probeCandidate, sanityLook, type HeadlessPort, type SanityNumbers, type WorldProbe } from './probe';
import type { AgentRuntime } from './world-runtime';

type Snapshot = DeepReadonly<SealedCandidate>;

/** What a preparation found, for Developer view: the probe's numbers, the sanity look's, the reservation, a refusal. */
export interface PrepareReport {
    candidate: string;
    probe: WorldProbe | Partial<WorldProbe> | null;
    sanity: SanityNumbers | null;
    reservation: ReservationNeed;
    /** The first frame's size, once drawn. */
    firstFrame: Target | null;
    /**
     * The full-size work as it ran, each to its fence: init's suffix and the first frame (its pipelines' first use
     * included). EA-G1 holds the probe's predictions to these (§9: "compare predictions with target work").
     */
    actual: { initMs: number | null; firstFrameMs: number | null };
    /**
     * Each mesh batch's box once init has run, read back before commit (bounds.ts, 11-02): what the studio frames its
     * camera on. Null when this engine cannot read them back, or reading them failed (the world is not refused for it).
     */
    bounds: WorldBounds | null;
    refused: string | null;
}

export interface PreparationDeps {
    headless(width: number, height: number): Promise<HeadlessPort>;
    now(): number;
    view(): CameraView;
    /** The admitted envelope: what the probe predicts for. */
    target: Target;
    need: ReservationNeed;
    signal: AbortSignal;
    /**
     * Why the construction is stale (a newer turn, another device generation), or null: asked after every await and right
     * before each full-size submission, so a superseded candidate's work stops where it is (the EA5.3 review, M1).
     */
    stale(): string | null;
    /** Writes the Head's camera back: called in the same synchronous section as the candidate's first frame. */
    restoreHeadCamera(): void;
    /** The probe's quiet window (probe.ts ProbeDeps.quiet): the Head holds while a submission is timed. */
    quiet?: () => () => void;
    report(r: PrepareReport): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The stage's preparation (§9): the probe, the approved init at full size, the offscreen first frame and its sanity
 * look, the output back at the screen. Any refusal throws, so the coordinator releases the construction; the report goes
 * out either way.
 */
export function stagePreparation(snapshot: Snapshot, port: EnginePort, deps: PreparationDeps): (world: PreparedWorld) => Promise<void> {
    return async world => {
        const report: PrepareReport = {
            candidate: snapshot.id, probe: null, sanity: null, reservation: deps.need, firstFrame: null, actual: { initMs: null, firstFrameMs: null }, bounds: null,
            refused: null,
        };
        /** Still wanted: neither cancelled nor stale. A stop throws, and the coordinator, seeing the same, stops and releases. */
        const fresh = () => {
            deps.signal.throwIfAborted();
            const why = deps.stale();
            if (why !== null) throw new Error(`EA_STOP ${why}: nothing more of this candidate is submitted`);
        };
        try {
            // Every submission of this preparation is checked for errors and fenced, or none is made (the EA5.3 review, H1).
            const checkpoint = port.checkpoint?.bind(port);
            const settle = port.settle?.bind(port);
            if (!checkpoint || !settle) throw new Error('EA_PROBE_UNVERIFIED this engine cannot check its submissions for errors, or fence them; no full-size work submitted');
            if (!port.offscreenTarget || !port.readTarget || !port.destroyTarget) {
                throw new Error('EA_CALL: this engine cannot draw a world offscreen, so no first frame is checked before commit');
            }
            const probed = await probeCandidate(snapshot, {
                headless: deps.headless, now: deps.now, view: deps.view, signal: deps.signal, target: deps.target, shared: true, stale: deps.stale, quiet: deps.quiet,
            });
            report.probe = { ...probed.probe, peakBytes: deps.need.total };
            if (!probed.ok) throw new Error(probed.reason);

            // Approved: init's work at full size, inside an error checkpoint, fenced; still wanted right before it. Its time,
            // to its fence, is what EA-G1 holds the probe's prediction to.
            fresh();
            const initStart = deps.now();
            const initError = await checkpoint(() => world.runInit());
            if (initError !== null) throw new Error(`EA_PROBE_UNVERIFIED init at full size: ${initError}`);
            await settle();
            report.actual.initMs = deps.now() - initStart;
            // After init's fence, and so right before the first frame: nothing awaits between the two.
            fresh();

            // The offscreen first frame, at the canvas's size, from the stage's view at time zero.
            const size = { width: port.width, height: port.height };
            const target = port.offscreenTarget(size.width, size.height);
            try {
                world.runtime.redirectOutput(target);
                const view = deps.view();
                // The engine's camera uniform is the Head's too (every post pass binds it): written back whatever the
                // candidate's frame does, in this same synchronous section (the EA5.3 review, M2).
                const frame = () => {
                    try {
                        world.runtime.view(view, 0);
                        port.render(world.runtime.draw());
                    } finally {
                        deps.restoreHeadCamera();
                    }
                };
                const frameStart = deps.now();
                const frameError = await checkpoint(frame);
                if (frameError !== null) throw new Error(`EA_SANITY the first frame: ${frameError}`);
                await settle();
                report.actual.firstFrameMs = deps.now() - frameStart;
                fresh();
                const pixels = await port.readTarget(target);
                report.firstFrame = size;
                const sanity = await sanityLook(world.runtime, port, snapshot.x, pixels);
                report.sanity = sanity.numbers;
                if (!sanity.ok) throw new Error(sanity.reason);
                fresh();
                // Where the world is, for the studio's camera: advisory, so a failed read leaves it unframed, never refused.
                try {
                    report.bounds = await worldBounds(world.runtime.meshBatches(), port);
                } catch {
                    report.bounds = null;
                }
                fresh();
                // Back at the screen only now; a refused world stays pointed at nothing visible until it is released.
                world.runtime.redirectOutput(null);
            } finally {
                port.destroyTarget(target);
            }
        } catch (e) {
            report.refused = message(e);
            throw e;
        } finally {
            deps.report(report);
        }
    };
}

// ------------------------------------------------------------------ the stage

export interface StageDeps {
    /** The port over the viewport's engine. */
    port: EnginePort;
    headless(width: number, height: number): Promise<HeadlessPort>;
    limits: DeviceLimits;
    compiler: GateOptions['compiler'];
    present: Present;
    /** This device's environment (eligibility.ts's environmentOf); an unknown one matches no eligibility. */
    environment: Environment;
    gpu: string;
    /** The live canvas's size: the first frame's, and the envelope's shape. */
    size(): Target;
    /** The viewport's live pixel cap: the envelope a stage world is admitted and probed for. */
    maxPixels: number;
    view(): CameraView;
    restoreHeadCamera(): void;
    /** The Head held while the probe times a submission (the viewport's pause), so no timing measures its frames. */
    quiet?: () => () => void;
    /** The switch, synchronous: the viewport's setRuntime. Nothing fallible. */
    commit(runtime: AgentRuntime): void;
    now(): number;
    /** Where an installed world says it paused past its envelope (EA_RESIZE). */
    onRefusal?(message: string): void;
    ledger?: MemoryLedger;
    goes?: GoLedger;
    eligibility?: Parsed;
    /** EA-G1's harness alone (dev/ea-g1.ts; §7's bootstrap): the one candidate it runs, pinned. The studio never passes it. */
    bootstrap?: Bootstrap;
}

export type RunResult =
    | { status: 'installed'; runtime: AgentRuntime; held: Reservation; report: PrepareReport | null }
    | { status: 'refused' | 'stopped' | 'failed'; reason: string; report: PrepareReport | null };

export interface Stage {
    readonly goes: GoLedger;
    readonly ledger: MemoryLedger;
    readonly busy: boolean;
    /** The developer's press (Q89): the GPU go for this candidate, in this turn, on this device generation. */
    press(snapshot: Snapshot): void;
    /** One attempt: admitted, built, prepared and committed, or refused, stopped or failed with the Head unchanged. */
    run(snapshot: Snapshot, compiled: readonly DeepReadonly<CompiledBody>[] | null, signal?: AbortSignal): Promise<RunResult>;
}

/**
 * The old Head's teardown, after the switch (§9): its releases attempted and its reservation returned, whatever its
 * destroy does. A failure is said (EA_RELEASE) and the new Head stays installed: nothing here can undo the install.
 */
export function retire(old: { destroy(): void } | null, held: Reservation | null): string | null {
    let error: string | null = null;
    try {
        old?.destroy();
    } catch (e) {
        error = `EA_RELEASE ${message(e)}; the new world stays installed`;
    }
    held?.release();
    return error;
}

/** The envelope a stage world is admitted for: the live shape at the viewport's pixel cap, never below the live size. */
export function envelopeOf(size: Target, maxPixels: number): Target {
    const aspect = size.width / Math.max(1, size.height);
    const pixels = Math.max(maxPixels, size.width * size.height);
    return { width: Math.max(size.width, Math.ceil(Math.sqrt(pixels * aspect))), height: Math.max(size.height, Math.ceil(Math.sqrt(pixels / aspect))) };
}

export function createStage(deps: StageDeps): Stage {
    const goes = deps.goes ?? createGoLedger();
    const ledger = deps.ledger ?? createMemoryLedger();
    let envelope: Target = envelopeOf(deps.size(), deps.maxPixels);
    const gate = createGate({
        limits: deps.limits, compiler: deps.compiler, goes, present: deps.present, ledger, target: () => envelope,
        environment: deps.environment, gpu: deps.gpu, eligibility: deps.eligibility, bootstrap: deps.bootstrap,
    });
    const authority = createAuthority(gate.gate);
    let busy = false;

    return {
        goes,
        ledger,
        get busy() { return busy; },
        press(snapshot) {
            goes.press(snapshot.id, deps.present.turn(), deps.present.device());
        },
        async run(snapshot, compiled, signal = new AbortController().signal) {
            if (busy) return { status: 'refused', reason: 'a Run is under way already', report: null };
            busy = true;
            try {
                envelope = envelopeOf(deps.size(), deps.maxPixels);
                const evidence = { compiled: compiled ?? [], gpuGo: goes.holds(snapshot.id, deps.present.turn(), deps.present.device()) };
                const admitted = authority.admit(snapshot, evidence, deps.present);
                if (!admitted.ok) return { status: 'refused', reason: admitted.reason, report: null };
                const held = gate.claim(snapshot);
                if (!held) return { status: 'failed', reason: 'internal: the admission made no reservation', report: null };
                const need = reservationFor(snapshot.x, envelope);
                // The coordinator's own test of the present (executor.ts), handed to the preparation so a newer turn or a
                // lost device stops its work where it is, not after it (the EA5.3 review, M1).
                const { turn, device } = admitted.admission;
                const stale = (): string | null => (signal.aborted ? 'cancelled' : deps.present.turn() !== turn ? 'superseded'
                    : deps.present.device() !== device ? 'device-lost' : null);
                // Written from the executor's callbacks: held in an object, which flow analysis does not narrow away.
                const got: { report: PrepareReport | null; installed: AgentRuntime | null } = { report: null, installed: null };
                try {
                    const executor = createEngineExecutor({
                        port: deps.port, maxPixels: envelope.width * envelope.height, onRefusal: deps.onRefusal,
                        prepare: stagePreparation(snapshot, deps.port, {
                            headless: deps.headless, now: deps.now, view: deps.view, target: envelope, need, signal, stale, restoreHeadCamera: deps.restoreHeadCamera, quiet: deps.quiet,
                            report: r => { got.report = r; },
                        }),
                        onCommit: runtime => {
                            deps.commit(runtime);
                            got.installed = runtime;
                        },
                    });
                    const outcome = await instantiate(snapshot, admitted.admission, executor, deps.present, signal);
                    const released = (errors: readonly string[]) => (errors.length ? `; releases failed: ${errors.join('; ')}` : '');
                    switch (outcome.status) {
                        case 'installed':
                            if (!got.installed) return { status: 'failed', reason: 'internal: installed with no runtime', report: got.report };
                            // The probe's and the readback's shares are gone; the Head holds the candidate's own.
                            held.shrink(need.candidate);
                            return { status: 'installed', runtime: got.installed, held, report: got.report };
                        case 'refused': return { status: 'refused', reason: outcome.reason, report: got.report };
                        case 'stopped': return { status: 'stopped', reason: `${outcome.why}${released(outcome.releaseErrors)}`, report: got.report };
                        case 'failed': return { status: 'failed', reason: `${outcome.error}${released(outcome.releaseErrors)}`, report: got.report };
                    }
                } finally {
                    if (!got.installed) held.release();
                }
            } finally {
                busy = false;
            }
        },
    };
}
