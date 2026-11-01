// The executor seam of EA3.5 (engine-adapters-design.md §9, EA-U10), bound to the candidate since EA4.3
// (candidate-loop-design.md §9, P8): the one door from a static, sealed candidate to device-backed construction, and the
// coordinator that keeps it.
//
// An admission is minted only by a host authority, for a candidate the host sealed (snapshot.ts: X, its passing checks,
// its interfaces and the exact checked text of every body, each hash recomputed), on device evidence for exactly that
// snapshot's bodies and the explicit GPU go. It is bound to the candidate's id(C) and X's hash (so to its manifest,
// policy and H), the turn it was issued in and the device generation, and spent once. A look-alike object, a copy, a
// candidate whose bodies changed after its checks, a fake compiler's pass, a stale turn, another device, or a spent
// admission opens nothing: the executor is never called. Through the door, the coordinator checks cancel, supersession
// and the device after each awaited step, and once more right before the switch, which is synchronous so nothing lands
// between. A stop releases what the attempted creates made, each release once, in X's dispose order (cleanupFor), and
// installs nothing; a step from a superseded turn is discarded the same way.
//
// EA3 and EA4 ship no executor and no authority that admits (Q75: static only). EA5's authority runs the device checks,
// and its executor builds and installs; until then the tests drive this contract with fakes that count their calls.

import type { CompiledBody } from '../contract/adapters/bodies';
import type { ExecutionGraph } from '../contract/adapters/graph';
import { cleanupFor } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import { isSealed, type SealedCandidate } from './snapshot';

type Graph = DeepReadonly<ExecutionGraph>;
type Snapshot = DeepReadonly<SealedCandidate>;

/** What builds a candidate on a device: one construction a door, its operations awaited one at a time (EA5 implements it). */
export interface Executor {
    /**
     * Opens a construction and acquires nothing: every acquisition is a `run` of X's init, which the coordinator knows
     * how to release. So when this throws there is nothing to release (the EA3.5 review). The snapshot is the one the
     * admission was issued on: its X and the exact bodies it sealed, never a body from anywhere else.
     */
    instantiate(snapshot: Snapshot, admission: Admission, signal: AbortSignal): Construction;
}

export interface Construction {
    /** Runs one operation of X's init: a create, an upload, an init stage, a copy. */
    run(operation: string): Promise<void>;
    /** Runs one release of X's dispose schedule. Idempotent: a release of what was never made does nothing. */
    release(operation: string): Promise<void>;
    /** Readies the switch, asynchronously (EA5's first frame and its check), without touching the Head. */
    prepare(): Promise<void>;
    /**
     * The switch: makes the prepared world the Head at once, synchronously, so nothing can land between the
     * coordinator's last check of the cancel, the turn and the device and it (the EA3.5 review: an awaited install
     * could finish after its turn had passed). It must not await, and changes nothing when it throws.
     */
    commit(): void;
}

/** Leave to build one candidate: what it is bound to. Only an authority makes one. */
export interface Admission {
    readonly graph: string;
    /** id(C): the exact bodies, under this X. */
    readonly candidate: string;
    readonly policy: string;
    readonly turn: number;
    readonly device: number;
}

/** The host's present: the current turn, and the device generation (it moves on a device loss). */
export interface Present {
    turn(): number;
    device(): number;
}

/**
 * What an admission is issued on, beyond the sealed snapshot (which holds X, its checks, its interfaces and its bodies).
 * A program supplies none of it.
 */
export interface Evidence {
    /** Each module's body compiled in its assembled module on this device (EA5's L3): exactly one a module. */
    compiled: readonly DeepReadonly<CompiledBody>[];
    /** The creator's or developer's explicit GPU go, from the host's own control (EA5); never from model output. */
    gpuGo: boolean;
}

/** The device-side decision (EA5: limits, features, the probe); null admits, a sentence refuses. */
export type Gate = (snapshot: Snapshot, evidence: Evidence) => string | null;

export type Admitted = { ok: true; admission: Admission } | { ok: false; reason: string };

export interface Authority {
    admit(snapshot: Snapshot, evidence: Evidence, present: Present): Admitted;
}

const MINTED = new WeakSet<Admission>();
const SPENT = new WeakSet<Admission>();

/** Why the compile evidence does not cover exactly the snapshot's bodies on a device; null when it does. */
function deviceEvidence(snapshot: Snapshot, compiled: readonly DeepReadonly<CompiledBody>[]): string | null {
    const seen = new Set<string>();
    for (const c of compiled) {
        if (seen.has(c.module)) return `module ${c.module} has two compile verdicts`;
        seen.add(c.module);
        const body = snapshot.bodies.find(b => b.module === c.module);
        if (!body) return `module ${c.module} is not one of this candidate's`;
        if (c.interfaceHash !== body.interfaceHash || c.codeHash !== body.codeHash) return `the compile verdict for ${c.module} is for another body than this candidate's`;
        // A fake compiler's pass proves nothing about a device (I6), nor does a model's or the creator's word.
        if (c.producedBy !== 'device') return `${c.module} was compiled by a ${c.producedBy}, which proves nothing about this device`;
        if (!c.ok) return `${c.module} does not compile on this device`;
    }
    for (const b of snapshot.bodies) if (!seen.has(b.module)) return `module ${b.module} has no compile verdict from this device`;
    return null;
}

/** An authority that admits a sealed candidate on device evidence for exactly its bodies, the GPU go, and its gate. */
export function createAuthority(gate: Gate): Authority {
    return {
        admit(snapshot, evidence, present) {
            if (!isSealed(snapshot)) return { ok: false, reason: 'not a candidate the host sealed' };
            const device = deviceEvidence(snapshot, evidence.compiled);
            if (device !== null) return { ok: false, reason: device };
            if (evidence.gpuGo !== true) return { ok: false, reason: 'no GPU go: the host gives it, never a program' };
            const refused = gate(snapshot, evidence);
            if (refused !== null) return { ok: false, reason: refused };
            const admission: Admission = Object.freeze({
                graph: snapshot.x.hash, candidate: snapshot.id, policy: snapshot.x.identity.policyHash, turn: present.turn(), device: present.device(),
            });
            MINTED.add(admission);
            return { ok: true, admission };
        },
    };
}

/** The authority EA3 and EA4 ship: none. A candidate is static only (Q75), and admissions come with EA5's device checks. */
export const STATIC_ONLY: Authority = {
    admit: () => ({ ok: false, reason: 'EA3 is static only (Q75): admissions come with EA5\'s device checks and the GPU go' }),
};

export type Stop = 'cancelled' | 'superseded' | 'device-lost';

export type Outcome =
    /** The door stayed shut: the executor was not called. */
    | { status: 'refused'; reason: string }
    | { status: 'installed'; ran: string[] }
    /** Stopped through the door: what was attempted is released; nothing installed. */
    | { status: 'stopped'; why: Stop; ran: string[]; released: string[]; releaseErrors: string[] }
    | { status: 'failed'; error: string; ran: string[]; released: string[]; releaseErrors: string[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Builds the sealed candidate through `executor` under `admission`, or refuses before the door. Each awaited step is
 * followed by a check of the signal, the turn and the device, and so is the last step before installing.
 */
export async function instantiate(snapshot: Snapshot, admission: Admission, executor: Executor, present: Present, signal: AbortSignal): Promise<Outcome> {
    if (!isSealed(snapshot)) return { status: 'refused', reason: 'not a candidate the host sealed' };
    if (!MINTED.has(admission)) return { status: 'refused', reason: 'not an admission the host issued' };
    if (SPENT.has(admission)) return { status: 'refused', reason: 'this admission was spent already' };
    const x: Graph = snapshot.x;
    // X's hash covers its identity, so a manifest, policy or H of its own is another X too; id(C) covers the bodies.
    if (admission.graph !== x.hash) return { status: 'refused', reason: 'this admission is for another X' };
    if (admission.candidate !== snapshot.id) return { status: 'refused', reason: 'this admission is for another candidate' };
    const stale = (): Stop | null => (signal.aborted ? 'cancelled' : present.turn() !== admission.turn ? 'superseded' : present.device() !== admission.device ? 'device-lost' : null);
    const early = stale();
    if (early) return { status: 'refused', reason: `${early} before construction` };

    SPENT.add(admission);
    let construction: Construction;
    try {
        construction = executor.instantiate(snapshot, admission, signal);
    } catch (e) {
        // Construction entry acquires nothing (Executor.instantiate), so there is nothing to release; the admission stays
        // spent. A cancel, a newer turn or a lost device that landed meanwhile is what stopped it.
        const why = stale();
        return why ? { status: 'stopped', why, ran: [], released: [], releaseErrors: [] } : { status: 'failed', error: message(e), ran: [], released: [], releaseErrors: [] };
    }
    const creates = new Set(x.operations.filter(o => o.kind === 'create').map(o => o.id));
    const attempted = new Set<string>();
    const ran: string[] = [];
    // Every release of what was attempted runs, once each, whatever the others do: one that throws is reported, not final.
    const release = async () => {
        const released: string[] = [];
        const releaseErrors: string[] = [];
        for (const op of cleanupFor(x, attempted)) {
            try {
                await construction.release(op);
                released.push(op);
            } catch (e) {
                releaseErrors.push(`${op}: ${message(e)}`);
            }
        }
        return { released, releaseErrors };
    };
    const stop = async (why: Stop): Promise<Outcome> => ({ status: 'stopped', why, ran, ...await release() });
    const fail = async (e: unknown): Promise<Outcome> => {
        const why = stale();
        return why ? stop(why) : { status: 'failed', error: message(e), ran, ...await release() };
    };

    for (const op of x.schedule.init) {
        const why = stale();
        if (why) return stop(why);
        // A create counts as attempted before it runs: one that fails half way has made something to release.
        if (creates.has(op)) attempted.add(op);
        try {
            await construction.run(op);
        } catch (e) {
            return fail(e);
        }
        ran.push(op);
    }
    const why = stale();
    if (why) return stop(why);
    try {
        await construction.prepare();
    } catch (e) {
        return fail(e);
    }
    // The last check and the switch, with no await between them: no cancel, turn or device change can land in it.
    const last = stale();
    if (last) return stop(last);
    let switched: unknown;
    try {
        switched = construction.commit();
    } catch (e) {
        return fail(e);
    }
    if (switched !== undefined && typeof (switched as { then?: unknown }).then === 'function') {
        // A commit that awaits breaks the contract: the Head may change later, so nothing is released that may be live.
        return { status: 'failed', error: 'commit returned a promise: the switch must be synchronous, so whether it happened is unknown', ran, released: [], releaseErrors: [] };
    }
    return { status: 'installed', ran };
}
