// The executor seam of EA3.5 (engine-adapters-design.md §9, EA-U10): the one door from a static X to device-backed
// construction, and the coordinator that keeps it.
//
// An admission is minted only by a host authority, on evidence for one X (its checks and its interfaces, both passing,
// and the explicit GPU go), bound to that X's hash (so to its manifest, policy and H), the turn it was issued in and the
// device generation, and spent once. A look-alike object, a copy, a stale turn, another device, or a spent admission
// opens nothing: the executor is never called. Through the door, the coordinator checks cancel, supersession and the
// device after each awaited step, and once more right before the switch, which is synchronous so nothing lands between. A stop releases what the attempted creates made, each release
// once, in X's dispose order (cleanupFor), and installs nothing; a step from a superseded turn is discarded the same way.
//
// EA3 ships no executor and no authority that admits (Q75: static only). EA5's authority runs the device checks, and its
// executor builds and installs; until then the tests drive this contract with a fake that counts its calls.

import type { Checked } from '../contract/adapters/checks';
import type { ExecutionGraph } from '../contract/adapters/graph';
import type { Derived } from '../contract/adapters/interfaces';
import { cleanupFor } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';

type Graph = DeepReadonly<ExecutionGraph>;

/** What builds X on a device: one construction a door, its operations awaited one at a time (EA5 implements it). */
export interface Executor {
    /**
     * Opens a construction and acquires nothing: every acquisition is a `run` of X's init, which the coordinator knows
     * how to release. So when this throws there is nothing to release (the EA3.5 review).
     */
    instantiate(x: Graph, admission: Admission, signal: AbortSignal): Construction;
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

/** Leave to build one X: what it is bound to. Only an authority makes one. */
export interface Admission {
    readonly graph: string;
    readonly policy: string;
    readonly turn: number;
    readonly device: number;
}

/** The host's present: the current turn, and the device generation (it moves on a device loss). */
export interface Present {
    turn(): number;
    device(): number;
}

/** What an admission is issued on. A program supplies none of it. */
export interface Evidence {
    checked: Checked;
    interfaces: Derived;
    /** The creator's or developer's explicit GPU go, from the host's own control (EA5); never from model output. */
    gpuGo: boolean;
}

/** The device-side decision (EA5: limits, features, compiled shaders); null admits, a sentence refuses. */
export type Gate = (x: Graph, evidence: Evidence) => string | null;

export type Admitted = { ok: true; admission: Admission } | { ok: false; reason: string };

export interface Authority {
    admit(x: Graph, evidence: Evidence, present: Present): Admitted;
}

const MINTED = new WeakSet<Admission>();
const SPENT = new WeakSet<Admission>();

/** An authority that admits on passing evidence for X, the GPU go, and its gate. */
export function createAuthority(gate: Gate): Authority {
    return {
        admit(x, evidence, present) {
            const { checked, interfaces } = evidence;
            if (checked.graph !== x.hash || interfaces.graph !== x.hash) return { ok: false, reason: 'the evidence is for another X' };
            if (!checked.ok) return { ok: false, reason: 'X does not pass its checks' };
            if (!interfaces.ok) return { ok: false, reason: 'X\'s module interfaces cannot be derived' };
            if (evidence.gpuGo !== true) return { ok: false, reason: 'no GPU go: the host gives it, never a program' };
            const refused = gate(x, evidence);
            if (refused !== null) return { ok: false, reason: refused };
            const admission: Admission = Object.freeze({ graph: x.hash, policy: x.identity.policyHash, turn: present.turn(), device: present.device() });
            MINTED.add(admission);
            return { ok: true, admission };
        },
    };
}

/** The authority EA3 ships: none. X is static only (Q75), and admissions come with EA5's device checks. */
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
 * Builds X through `executor` under `admission`, or refuses before the door. Each awaited step is followed by a check
 * of the signal, the turn and the device, and so is the last step before installing.
 */
export async function instantiate(x: Graph, admission: Admission, executor: Executor, present: Present, signal: AbortSignal): Promise<Outcome> {
    if (!MINTED.has(admission)) return { status: 'refused', reason: 'not an admission the host issued' };
    if (SPENT.has(admission)) return { status: 'refused', reason: 'this admission was spent already' };
    // X's hash covers its identity, so a manifest, policy or H of its own is another X too.
    if (admission.graph !== x.hash) return { status: 'refused', reason: 'this admission is for another X' };
    const stale = (): Stop | null => (signal.aborted ? 'cancelled' : present.turn() !== admission.turn ? 'superseded' : present.device() !== admission.device ? 'device-lost' : null);
    const early = stale();
    if (early) return { status: 'refused', reason: `${early} before construction` };

    SPENT.add(admission);
    let construction: Construction;
    try {
        construction = executor.instantiate(x, admission, signal);
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
