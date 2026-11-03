// The world on the stage, saved once it is there (W3; the creations platform companion §7 and F8; Q124, the user,
// 2026-11-03: "yes creations should be automatically saved if its on stage run"). Plain TypeScript, every dependency a
// port, so it runs under node --test; W3.6 wires it to EA9's install step.
//
// A Live world installed for an active account is saved: its first install makes a world (POST /v1/worlds), and the
// install of a world that improved it ("Improve it") a revision on the head the save before it produced. Saves run one at
// a time, in install order, so an improvement installed while its world is still being saved waits for that save and
// builds on its head; an improvement that was itself improved before its turn is skipped, the newest standing for it.
// Starters, the archive's replays and reopened worlds are not saved again; h1 worlds never reach here (Q123). Every try
// of one request goes with one Idempotency-Key, so an answer lost to the network costs no second world; a request with
// no answer stays the creation's until it is resolved under that key, so an improvement never makes a second world.
// Each save belongs to the account epoch it was asked under, checked before every send, retry and poll: nothing goes
// out under an account signed in meanwhile, and an answer that arrives after a change is dropped (F4). Nothing here
// touches the stage: a failure says so and leaves the world where it is (F2).

import { canonicalJson, sha256Hex } from '../contract/adapters/canonical';
import type { SolutionDesign } from '../contract/agent';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { Api } from '../forge-client/http';
import type { SealedCandidate } from '../loop/snapshot';
import type { CameraView } from '../runtime/camera-path';
import { worldArtifact } from './artifact';
import { createWorld, parseWorldView, readOperation, reviseWorld, type SaveAnswer } from './worlds';

/** Where the world on the stage came from (design guidelines §3's sources). Only `live` is saved on install. */
export type WorldSource = 'live' | 'reopened' | 'starter' | 'archive';

/** A world just installed on the stage, as EA9's install step hands it (W3.6). */
export interface InstalledWorld {
    /** The install's own number: each install has a new one. */
    readonly stage: number;
    readonly source: WorldSource;
    readonly snapshot: DeepReadonly<SealedCandidate>;
    /** S, from the turn that made it; null for a world with none (it cannot be saved). */
    readonly design: DeepReadonly<SolutionDesign> | null;
    readonly view: CameraView | null;
    /** The creation's title at its first save: EA9's title from the idea, else "Untitled world". */
    readonly title: string;
    /** The install number of the world this one improved ("Improve it"), or null. */
    readonly improves: number | null;
    /** A reopened world's saved head, so its improvement is that world's revision. */
    readonly saved?: { readonly worldId: string; readonly revisionId: string; readonly rowVersion: number };
}

/** Who is signed in, as the session says it now: its epoch (E_auth) and whether its account can save. */
export interface AccountFacts {
    readonly epoch: number;
    readonly kind: 'anonymous' | 'active' | 'inactive' | 'unknown';
}

export interface SavePorts {
    readonly api: Api;
    account(): AccountFacts;
    /** A fresh Idempotency-Key: crypto.randomUUID() in the studio. */
    newKey(): string;
    /** A pause before a retry or a poll; the tests make it immediate. */
    wait(ms: number): Promise<void>;
    /** The world on the stage's save changed state: the studio says it. */
    changed(state: SaveState): void;
}

/**
 * `idle`: nothing to save (a starter, a replay); `sign-in`: anonymous, "Sign in to keep this world"; `saving`; `saved`;
 * `conflict`: changed in another tab; `storage-full`; `too-large`; `not-saved`: the account cannot save, or changed;
 * `offline` and `failed`: "Not saved", with "Try again" on the same key.
 */
export type SaveStatus = 'idle' | 'sign-in' | 'saving' | 'saved' | 'conflict' | 'storage-full' | 'too-large' | 'not-saved' | 'offline' | 'failed';

export interface SaveState {
    readonly stage: number;
    readonly status: SaveStatus;
    readonly worldId: string | null;
    readonly revisionId: string | null;
    readonly rowVersion: number | null;
    /** The last answer in a developer's words; never shown to a creator as is. */
    readonly detail: string;
}

export interface SaveController {
    /** A world was installed on the stage (R = installed). */
    installed(world: InstalledWorld): void;
    /** "Try again", or "Save" after a refusal: the same key for the same request. */
    retry(): Promise<void>;
    /** After a conflict: the world on the stage as a new world, under a fresh key. */
    saveAsNew(): Promise<void>;
    /** The session's epoch moved (a sign-in, a switch, a sign-out). */
    accountChanged(): void;
    /** The world on the stage's save, or null before any install. */
    state(): SaveState | null;
    /** Every save in order, done: for the tests and a page that is closing. */
    settled(): Promise<void>;
    dispose(): void;
}

/** Polls of a save still under way: every two seconds, for half a minute. */
export const POLLS = 15;
export const POLL_MS = 2_000;
/** One automatic retry of an answer lost to the network, after this pause. */
export const RETRY_MS = 3_000;

/**
 * A request sent for a creation whose outcome is not known: no answer, or still under way after the polls. It may have
 * committed, so nothing new is sent for that creation until it is resolved, by sending it again, the same body under the
 * same key, which the platform answers as it answered the first (the review of 11-03: an improvement had made a second
 * world while its parent's create was unanswered).
 */
interface Unresolved {
    /** The install whose request it is. */
    readonly stage: number;
    readonly key: string;
    readonly hash: string;
    readonly title: string;
    readonly text: string;
    readonly sha256: string;
    /** The head a revision was based on; null for a new world. */
    readonly base: { readonly worldId: string; readonly revisionId: string; readonly rowVersion: number } | null;
}

/** A creation as its saves know it: shared by a world and the worlds that improve it. */
interface Lineage {
    worldId: string | null;
    revisionId: string | null;
    rowVersion: number | null;
    /** The epoch its first request was made under: another account never continues it, nor resolves its requests. */
    epoch: number | null;
    unresolved: Unresolved | null;
}

interface Binding {
    readonly world: InstalledWorld;
    lineage: Lineage;
    status: SaveStatus;
    detail: string;
    /** A later install improved this one before its save ran: the later one stands for it. */
    superseded: boolean;
    /** Its save stopped for want of an account (anonymous, or not known yet): one that signs in saves it. */
    waitingForAccount: boolean;
}

/** What one request came to, or `stale`: the account changed, so nothing more was sent and nothing is applied. */
type Outcome = SaveAnswer | 'stale';

const fresh = (): Lineage => ({ worldId: null, revisionId: null, rowVersion: null, epoch: null, unresolved: null });

export function createSaveController(ports: SavePorts): SaveController {
    let current: Binding | null = null;
    let chain: Promise<void> = Promise.resolve();
    let disposed = false;

    const view = (b: Binding): SaveState => ({
        stage: b.world.stage, status: b.status, worldId: b.lineage.worldId, revisionId: b.lineage.revisionId,
        rowVersion: b.lineage.rowVersion, detail: b.detail,
    });
    const set = (b: Binding, status: SaveStatus, detail = '') => {
        b.status = status;
        b.detail = detail;
        if (b === current && !disposed) ports.changed(view(b));
    };
    const enqueue = (task: () => Promise<void>): Promise<void> => {
        chain = chain.then(task).catch(error => {
            if (current) set(current, 'failed', `the save failed: ${(error as Error)?.message ?? error}`);
        });
        return chain;
    };

    const send = (r: Unresolved): Promise<SaveAnswer> => {
        const request = { key: r.key, text: r.text, sha256: r.sha256 };
        return r.base ? reviseWorld(ports.api, r.base, request) : createWorld(ports.api, r.title, request);
    };

    /**
     * `r` sent, retried once when unanswered, and followed to its answer when under way; the account checked before
     * every send, retry and poll (the review's high: a retry must never go out under an account signed in meanwhile,
     * since the transport attaches whoever is signed in when it sends), and once more when the answer arrives (F4).
     */
    const dispatch = async (r: Unresolved, live: () => boolean): Promise<Outcome> => {
        if (!live()) return 'stale';
        let answer = await send(r);
        if (answer.kind === 'unavailable') {
            await ports.wait(RETRY_MS);
            if (!live()) return 'stale';
            answer = await send(r);
        }
        if (answer.kind === 'pending') {
            const operationId = answer.operationId;
            answer = { kind: 'unavailable', status: 202 };
            for (let i = 0; i < POLLS; i++) {
                await ports.wait(POLL_MS);
                if (!live()) return 'stale';
                const op = await readOperation(ports.api, operationId);
                if (!op || op.state === 'PENDING') continue;
                const world = parseWorldView(op.result);
                answer = op.state === 'DONE' && op.status === 201 && world ? { kind: 'saved', world }
                    : op.state === 'DONE' && op.status === 409 ? { kind: 'conflict' }
                        : { kind: 'unavailable', status: op.status ?? 0 };
                break;
            }
        }
        return live() ? answer : 'stale';
    };

    /** What an answer means for the creation: its new head, or a request that may have committed kept unresolved. */
    const settle = (l: Lineage, r: Unresolved, answer: SaveAnswer) => {
        if (answer.kind === 'saved') {
            l.worldId = answer.world.worldId;
            l.revisionId = answer.world.head.revisionId;
            l.rowVersion = answer.world.rowVersion;
        }
        // Saved, or refused for what it is (a conflict, a full storage, a 4xx): it is known. No answer is not.
        if (answer.kind !== 'unavailable' && l.unresolved === r) l.unresolved = null;
    };

    const statusOf = (answer: SaveAnswer): [SaveStatus, string] => {
        switch (answer.kind) {
            case 'saved': return ['saved', ''];
            case 'conflict': return ['conflict', 'the world changed in another tab'];
            case 'storage-full': return ['storage-full', ''];
            case 'refused': return ['failed', `${answer.code}: ${answer.message}`];
            case 'pending': return ['failed', 'still under way'];
            default: return [answer.status === 0 ? 'offline' : 'failed', `no answer to keep (status ${answer.status})`];
        }
    };

    /** `b`'s save, as asked for under `epoch` (the install's, or the creator's press). */
    const save = async (b: Binding, epoch: number, asNew = false): Promise<void> => {
        if (disposed || b.superseded) return;
        const live = () => !disposed && ports.account().epoch === epoch;
        if (!live()) return set(b, 'not-saved', 'another account signed in before it was saved');
        const account = ports.account();
        if (account.kind === 'anonymous' || account.kind === 'unknown') {
            b.waitingForAccount = true;
            return set(b, account.kind === 'anonymous' ? 'sign-in' : 'not-saved', `the account is ${account.kind}`);
        }
        b.waitingForAccount = false;
        if (account.kind !== 'active') return set(b, 'not-saved', `the account is ${account.kind}`);
        const l = b.lineage;
        if (l.epoch !== null && l.epoch !== epoch) return set(b, 'not-saved', 'saved under another account');
        set(b, 'saving');
        // The creation's last request may have committed: resolved first, so an improvement never makes a second world.
        const before = l.unresolved;
        if (before && before.stage !== b.world.stage) {
            const resolved = await dispatch(before, live);
            if (resolved === 'stale') return set(b, 'not-saved', 'another account signed in while it was saved');
            settle(l, before, resolved);
            if (l.unresolved) {
                const [status, detail] = statusOf(resolved);
                return set(b, status, `the save before it is still unanswered: ${detail}`);
            }
        }
        if (!b.world.design) return set(b, 'failed', 'the world has no design to save');
        const built = await worldArtifact({ snapshot: b.world.snapshot, design: b.world.design, view: b.world.view });
        if (!built.ok) return set(b, built.code === 'too-large' ? 'too-large' : 'failed', built.reason);
        const base = !asNew && l.worldId && l.revisionId && l.rowVersion !== null
            ? { worldId: l.worldId, revisionId: l.revisionId, rowVersion: l.rowVersion } : null;
        const hash = await sha256Hex(canonicalJson({ base, title: b.world.title, sha256: built.world.sha256 }));
        if (!live()) return set(b, 'not-saved', 'another account signed in before it was saved');
        const own = l.unresolved && l.unresolved.stage === b.world.stage && l.unresolved.hash === hash ? l.unresolved : null;
        const r: Unresolved = own ?? {
            stage: b.world.stage, key: ports.newKey(), hash, title: b.world.title, text: built.world.text, sha256: built.world.sha256, base,
        };
        // Bound to this account from its first request; unknown until answered.
        l.epoch = epoch;
        l.unresolved = r;
        const outcome = await dispatch(r, live);
        if (outcome === 'stale') return set(b, 'not-saved', 'another account signed in while it was saved');
        settle(l, r, outcome);
        const [status, detail] = statusOf(outcome);
        return set(b, status, detail);
    };

    return {
        installed(world) {
            if (disposed) return;
            const before = current;
            let lineage: Lineage;
            if (world.source === 'reopened' && world.saved) {
                lineage = { ...world.saved, epoch: ports.account().epoch, unresolved: null };
            } else if (world.improves !== null && before && before.world.stage === world.improves) {
                // The improved world continues its creation: the same lineage, so it saves on the head its save produced.
                lineage = before.lineage;
                if (before.status !== 'saved' && world.source === 'live') before.superseded = true;
            } else {
                lineage = fresh();
            }
            const b: Binding = { world, lineage, status: 'idle', detail: '', superseded: false, waitingForAccount: false };
            current = b;
            if (world.source === 'reopened') {
                set(b, lineage.worldId ? 'saved' : 'idle');
                return;
            }
            if (world.source !== 'live') {
                set(b, 'idle', 'not the creator\'s world: nothing to save');
                return;
            }
            set(b, 'saving');
            const epoch = ports.account().epoch;
            void enqueue(() => save(b, epoch));
        },
        retry() {
            const b = current;
            if (!b || b.world.source !== 'live' || !['failed', 'offline', 'sign-in', 'not-saved'].includes(b.status)) return Promise.resolve();
            b.superseded = false;
            const epoch = ports.account().epoch;
            if (b.lineage.epoch !== null && b.lineage.epoch !== epoch) b.lineage = fresh();
            return enqueue(() => save(b, epoch));
        },
        saveAsNew() {
            const b = current;
            if (!b || b.status !== 'conflict') return Promise.resolve();
            // A conflict is known not to have committed: the world is saved as a creation of its own.
            b.lineage = fresh();
            const epoch = ports.account().epoch;
            return enqueue(() => save(b, epoch, true));
        },
        accountChanged() {
            const b = current;
            if (!b || disposed) return;
            const account = ports.account();
            // A creation another account's requests began is never continued, nor its unknown request resolved, here.
            const foreign = b.lineage.epoch !== null && b.lineage.epoch !== account.epoch;
            if (foreign) b.lineage = fresh();
            if (b.waitingForAccount && account.kind === 'active') {
                // The anonymous creator signed in (the companion's P1): the world on the stage is kept now.
                void enqueue(() => save(b, account.epoch));
            } else if (foreign && b.world.source === 'live') {
                // Saved under another account: not continued, nor copied, by itself. Save is the creator's press.
                set(b, 'not-saved', 'another account signed in');
            }
        },
        state: () => (current ? view(current) : null),
        settled: () => chain,
        dispose() {
            disposed = true;
        },
    };
}
