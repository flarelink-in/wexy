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
// Each save belongs to the account epoch it was asked under, checked before every send, retry and poll, and its requests
// are bound to that epoch's caller (http.ts's `Caller`), so the transport itself refuses to send one under anyone else,
// its own retry after a 401 included (W3's review, its high): nothing goes out under an account signed in meanwhile, and
// an answer that arrives after a change is dropped (F4). A world belongs to the account that made it (Q129, the user,
// 2026-11-04): only its owner's account saves it, never another, by itself or by a press; under another account, or none,
// it stays on the stage as a local world, and its owner's binding waits for its owner. Nothing here touches the stage:
// a failure says so and leaves the world where it is (F2).

import { canonicalJson, sha256Hex } from '../contract/adapters/canonical';
import type { SolutionDesign } from '../contract/agent';
import type { DeepReadonly } from '../contract/engine/frozen';
import { boundTo, type Api, type Caller } from '../forge-client/http';
import type { CameraKeyframe } from '../contract/spec';
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
    /**
     * The caller its Run was pressed as (the creator's Show it, the GPU go), or a reopened world's reader: its owner, whose
     * account alone ever saves it (Q129); null when no one was signed in then. Absent: the caller signed in at its install.
     */
    readonly ranAs?: string | null;
    /** A reopened world's saved head, its owner's (`ranAs`): its improvement is that world's revision, for its owner alone. */
    readonly saved?: { readonly worldId: string; readonly revisionId: string; readonly rowVersion: number };
    /** The studio's keyframes for it when installed (Q119 (a), EA9.4): a reopened world's saved ones; none for a new one. */
    readonly keyframes?: readonly CameraKeyframe[];
}

/** Who is signed in, as the session says it now: its epoch (E_auth), whether its account can save, and its caller. */
export interface AccountFacts {
    readonly epoch: number;
    readonly kind: 'anonymous' | 'active' | 'inactive' | 'unknown';
    /** The caller this epoch's requests may go out as (the session's `caller()`); a save is sent only bound to it. */
    readonly caller: Caller | null;
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
 * `conflict`: changed in another tab; `storage-full`; `too-large`; `not-saved`: its owner's account is not read yet
 * (or its read failed); `not-allowed`: its owner's account, read, cannot save (not active); `offline` and `failed`:
 * "Not saved", with "Try again" on the same key; `elsewhere`: the
 * account that made it is not the one signed in (Q129), so nothing is saved here, by itself or by a press; its state's
 * `worldId` says whether its owner has it saved. `changed`: saved, but its keyframes moved since (EA9.4, Q119): its
 * owner's Save keeps them, as a revision of that saved world (the companion §7's explicit Save).
 */
export type SaveStatus = 'idle' | 'sign-in' | 'saving' | 'saved' | 'conflict' | 'storage-full' | 'too-large' | 'not-saved' | 'not-allowed' | 'offline' | 'failed' | 'elsewhere' | 'changed';

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
    /**
     * A world was installed on the stage (R = installed). The same world shown again as it was (the same candidate, as
     * Show it does past its envelope) is not saved again: its save stands (W3.6).
     */
    installed(world: InstalledWorld): void;
    /**
     * The stage now holds a world this controller does not save (h1's, the backdrop, nothing): nothing is said of the
     * one before any more, whose save, under way, still ends as it ends (it was installed, so it is kept: F8).
     */
    cleared(): void;
    /**
     * The creator's "Try again": the same key for the same request. Also after a full storage, once the creator has made
     * room (never by itself: PL-FE10). Its owner's alone: under another account it does nothing (Q129).
     */
    retry(): Promise<void>;
    /** After a conflict: the world on the stage as a new world, under a fresh key. */
    saveAsNew(): Promise<void>;
    /**
     * The world on the stage's keyframes changed (EA9.4, Q119 (a)): what its next save sends. A world saved already reads
     * `changed` until its owner's {@link saveChanges}; a save under way that sent the older ones ends `changed` too.
     */
    edited(keyframes: readonly CameraKeyframe[]): void;
    /** The creator's Save after `changed`: the world with its keyframes now, a revision of its saved head, its owner's alone. */
    saveChanges(): Promise<void>;
    /** The session's epoch moved (a sign-in, a switch, a sign-out), or its account's standing did (read, set up). */
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
    /** The epoch its requests go out under: its owner's latest, bound again when its owner signs in again. */
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
    /**
     * Its save stopped for want of its owner's account (anonymous, not read yet, or signed out mid-save): that account
     * saves it once active (an anonymous creator who links Google keeps the uid, P1; a read that answers late; its owner
     * signing in again), and no other.
     */
    waitingForAccount: boolean;
    /**
     * Whose world this is (the second review of W3; Q129, the user, 2026-11-04): the caller its Run was pressed as (a
     * reopened world's reader), or the one signed in at its install. Fixed: no press makes it another account's.
     */
    readonly owner: string | null;
    /** Its status before its owner signed out or another account signed in, given back when its owner returns. */
    away: SaveStatus | null;
    /** Its keyframes now (EA9.4, Q119 (a)): what its next save sends; the studio's edits replace them, never change them. */
    keyframes: readonly CameraKeyframe[];
    /**
     * The keyframes its saved head holds: a reopened world's as read, a live one's as its last save sent them; null before
     * its first save. `changed` is a difference from these, never a count of edits: K then Remove changes nothing, and an
     * edit made under another account is said when its owner returns (EA9.4's review).
     */
    savedKeys: readonly CameraKeyframe[] | null;
}

/** Two sets of keyframes the same, as a world's save would hold them. */
const sameKeys = (a: readonly CameraKeyframe[], b: readonly CameraKeyframe[]): boolean => JSON.stringify(a) === JSON.stringify(b);
const copyKeys = (keys: readonly CameraKeyframe[]): CameraKeyframe[] => keys.map(k => ({ ...k, target: [k.target[0], k.target[1], k.target[2]] }));

/** What one request came to, or `stale`: the account changed, so nothing more was sent and nothing is applied. */
type Outcome = SaveAnswer | 'stale';

const fresh = (): Lineage => ({ worldId: null, revisionId: null, rowVersion: null, epoch: null, unresolved: null });

export function createSaveController(ports: SavePorts): SaveController {
    let current: Binding | null = null;
    let chain: Promise<void> = Promise.resolve();
    let disposed = false;

    const view = (b: Binding): SaveState => {
        // Another account's world (Q129) names a saved world only when this world itself was saved for its owner: an
        // improvement shares its parent's lineage, so an unsaved one would otherwise read "Saved" (the independent review).
        const kept = b.status !== 'elsewhere' || b.away === 'saved';
        return {
            stage: b.world.stage, status: b.status, worldId: kept ? b.lineage.worldId : null, revisionId: kept ? b.lineage.revisionId : null,
            rowVersion: kept ? b.lineage.rowVersion : null, detail: b.detail,
        };
    };
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

    const send = (api: Api, r: Unresolved): Promise<SaveAnswer> => {
        const request = { key: r.key, text: r.text, sha256: r.sha256 };
        return r.base ? reviseWorld(api, r.base, request) : createWorld(api, r.title, request);
    };

    /**
     * `r` sent, retried once when unanswered, and followed to its answer when under way; the account checked before
     * every send, retry and poll (the 11-03 review's high: a retry must never go out under an account signed in
     * meanwhile), and once more when the answer arrives (F4). Every request goes out bound to `caller`, so the transport
     * checks it again once the credentials are in hand, its own retry after a 401 included (W3's review, its high).
     */
    const dispatch = async (r: Unresolved, live: () => boolean, caller: Caller): Promise<Outcome> => {
        if (!live()) return 'stale';
        const api = boundTo(ports.api, { uid: caller.uid, still: () => live() && caller.still() });
        let answer = await send(api, r);
        if (answer.kind === 'stale') return 'stale';
        if (answer.kind === 'unavailable') {
            await ports.wait(RETRY_MS);
            if (!live()) return 'stale';
            answer = await send(api, r);
            if (answer.kind === 'stale') return 'stale';
        }
        if (answer.kind === 'pending') {
            const operationId = answer.operationId;
            answer = { kind: 'unavailable', status: 202 };
            for (let i = 0; i < POLLS; i++) {
                await ports.wait(POLL_MS);
                if (!live()) return 'stale';
                const op = await readOperation(api, operationId);
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
            case 'stale': return ['not-saved', 'another account signed in before it was sent'];
            default: return [answer.status === 0 ? 'offline' : 'failed', `no answer to keep (status ${answer.status})`];
        }
    };

    /** Whether `b`'s owner is the caller signed in now: only then is anything of it sent, or said "Saved" (Q129). */
    const ownerHere = (b: Binding): boolean => {
        const caller = ports.account().caller;
        return caller !== null && caller.uid === b.owner;
    };

    /**
     * Another account, or none, holds the session: `b` stays on the stage as a local world, its owner's binding kept for its
     * owner, nothing of it sent (Q129). Its status is kept to be given back when its owner returns.
     */
    const awayFrom = (b: Binding, detail: string): void => {
        if (b.status !== 'elsewhere') b.away = b.status;
        set(b, 'elsewhere', detail);
    };

    /** A save that stopped because the account changed under it: its owner's, waiting for its owner (Q129). */
    const stopped = (b: Binding, detail: string): void => {
        b.waitingForAccount = true;
        if (ownerHere(b)) set(b, 'not-saved', detail);
        else awayFrom(b, detail);
    };

    /** `b`'s save, as asked for under `epoch` (the install's, its owner's return, or the creator's press). */
    const save = async (b: Binding, epoch: number, asNew = false): Promise<void> => {
        // Saved already: a press and an account's word queued together save it once (the independent review).
        if (disposed || b.superseded || (b.status === 'saved' && !asNew)) return;
        const live = () => !disposed && ports.account().epoch === epoch;
        if (!live()) return stopped(b, 'the account changed before it was saved');
        const account = ports.account();
        // Only the account that made it saves it (Q129): another, or no one, never does, by itself or by a press.
        if (b.owner === null || (account.caller?.uid ?? null) !== b.owner) return awayFrom(b, 'the account that made it is not signed in');
        if (account.kind === 'anonymous' || account.kind === 'unknown') {
            b.waitingForAccount = true;
            return set(b, account.kind === 'anonymous' ? 'sign-in' : 'not-saved', `the account is ${account.kind}`);
        }
        b.waitingForAccount = false;
        // Its owner's account, read, cannot save (suspended, being deleted): said, with nothing to press.
        if (account.kind !== 'active') return set(b, 'not-allowed', `the account is ${account.kind}`);
        // The caller this epoch was read as: every request of this save goes out as it, or not at all.
        const caller = account.caller;
        if (!caller) return set(b, 'not-saved', 'no signed-in caller to save as');
        const l = b.lineage;
        // Its owner signed in again (a new epoch, the same uid): its requests go out under this epoch from now on.
        l.epoch = epoch;
        set(b, 'saving');
        // The creation's last request may have committed: resolved first, so an improvement never makes a second world.
        const before = l.unresolved;
        if (before && before.stage !== b.world.stage) {
            const resolved = await dispatch(before, live, caller);
            if (resolved === 'stale') return stopped(b, 'the account changed while it was saved');
            settle(l, before, resolved);
            if (l.unresolved) {
                const [status, detail] = statusOf(resolved);
                return set(b, status, `the save before it is still unanswered: ${detail}`);
            }
        }
        if (!b.world.design) return set(b, 'failed', 'the world has no design to save');
        // Its keyframes as they are now (EA9.4): an edit after this point leaves it `changed`, for its owner's Save.
        const sent = b.keyframes;
        const built = await worldArtifact({ snapshot: b.world.snapshot, design: b.world.design, view: b.world.view, keyframes: sent });
        if (!built.ok) return set(b, built.code === 'too-large' ? 'too-large' : 'failed', built.reason);
        const base = !asNew && l.worldId && l.revisionId && l.rowVersion !== null
            ? { worldId: l.worldId, revisionId: l.revisionId, rowVersion: l.rowVersion } : null;
        const hash = await sha256Hex(canonicalJson({ base, title: b.world.title, sha256: built.world.sha256 }));
        if (!live()) return stopped(b, 'the account changed before it was saved');
        const own = l.unresolved && l.unresolved.stage === b.world.stage && l.unresolved.hash === hash ? l.unresolved : null;
        const r: Unresolved = own ?? {
            stage: b.world.stage, key: ports.newKey(), hash, title: b.world.title, text: built.world.text, sha256: built.world.sha256, base,
        };
        l.unresolved = r;
        const outcome = await dispatch(r, live, caller);
        if (outcome === 'stale') return stopped(b, 'the account changed while it was saved');
        settle(l, r, outcome);
        const [status, detail] = statusOf(outcome);
        // Saved with the keyframes it had when sent: those are its saved head's now. An edit since that left them otherwise
        // is not saved, and Save is offered for it (EA9.4).
        if (status === 'saved') {
            b.savedKeys = sent;
            if (!sameKeys(b.keyframes, sent)) return set(b, 'changed', 'its keyframes changed while it was saved');
        }
        return set(b, status, detail);
    };

    return {
        installed(world) {
            if (disposed) return;
            const before = current;
            // The same world again (Show it past its envelope): the same text, so the same save, which stands as it is.
            if (before && world.improves !== null && before.world.stage === world.improves && before.world.snapshot.id === world.snapshot.id
                && before.world.source === world.source) {
                ports.changed(view(before));
                return;
            }
            // Its owner, fixed: the caller its Run was pressed as (a reopened world's reader), else the one signed in now.
            const owner = world.ranAs !== undefined ? world.ranAs : ports.account().caller?.uid ?? null;
            let lineage: Lineage;
            if (world.source === 'reopened' && world.saved) {
                // Its owner's saved head: its improvement is that world's revision, for its owner alone.
                lineage = { ...world.saved, epoch: null, unresolved: null };
            } else if (world.improves !== null && before && before.world.stage === world.improves && before.owner === owner) {
                // The improved world continues its creation: the same lineage, so it saves on the head its save produced.
                // Improved as another account, it is that account's own world: another account's creation is not its.
                lineage = before.lineage;
                if (before.status !== 'saved' && world.source === 'live') before.superseded = true;
            } else {
                lineage = fresh();
            }
            const b: Binding = {
                world, lineage, status: 'idle', detail: '', superseded: false, waitingForAccount: false, owner, away: null,
                keyframes: copyKeys(world.keyframes ?? []),
                // A reopened world is its saved head, its keyframes as read; a new one has none saved yet.
                savedKeys: world.source === 'reopened' ? copyKeys(world.keyframes ?? []) : null,
            };
            current = b;
            if (world.source === 'reopened') {
                if (!ownerHere(b)) {
                    b.away = lineage.worldId ? 'saved' : 'idle';
                    set(b, 'elsewhere', 'read for the account that made it, which is not signed in now');
                } else set(b, lineage.worldId ? 'saved' : 'idle');
                return;
            }
            if (world.source !== 'live') {
                set(b, 'idle', "not the creator's world: nothing to save");
                return;
            }
            set(b, 'saving');
            const epoch = ports.account().epoch;
            void enqueue(() => save(b, epoch));
        },
        cleared() {
            current = null;
        },
        retry() {
            const b = current;
            // The creator's "Try again", for its owner alone: under another account nothing of it is offered or sent (Q129).
            if (!b || b.world.source !== 'live' || !ownerHere(b)
                || !['failed', 'offline', 'sign-in', 'not-saved', 'storage-full'].includes(b.status)) return Promise.resolve();
            b.superseded = false;
            const epoch = ports.account().epoch;
            return enqueue(() => save(b, epoch));
        },
        saveAsNew() {
            const b = current;
            if (!b || b.status !== 'conflict' || !ownerHere(b)) return Promise.resolve();
            // A conflict is known not to have committed: the world is saved as a creation of its own, still its owner's.
            b.lineage = fresh();
            const epoch = ports.account().epoch;
            return enqueue(() => save(b, epoch, true));
        },
        edited(keyframes) {
            const b = current;
            if (!b || disposed) return;
            b.keyframes = copyKeys(keyframes);
            // Saved already: its owner's Save keeps a change from what is saved, and one undone is saved again. Under way,
            // or not saved yet: its next save sends them. Any other's world stays as it is (Q129), its owner's return says
            // it; a starter or a replay is nobody's to save.
            if (!ownerHere(b) || (b.world.source !== 'live' && b.world.source !== 'reopened')) return;
            const differs = b.savedKeys !== null && !sameKeys(b.keyframes, b.savedKeys);
            if (b.status === 'saved' && differs) set(b, 'changed');
            else if (b.status === 'changed' && !differs) set(b, 'saved', 'its views are as saved again');
        },
        saveChanges() {
            const b = current;
            if (!b || b.status !== 'changed' || !ownerHere(b)) return Promise.resolve();
            const epoch = ports.account().epoch;
            set(b, 'saving');
            return enqueue(() => save(b, epoch));
        },
        accountChanged() {
            const b = current;
            if (!b || disposed || (b.world.source !== 'live' && b.world.source !== 'reopened')) return;
            const account = ports.account();
            if (!ownerHere(b)) {
                // Another account, or none: the world stays on the stage as a local world, never saved here, by itself or
                // by a press (Q129). Its owner's binding stays its owner's; a request of it under way is refused unsent.
                awayFrom(b, 'the account that made it is not signed in');
                return;
            }
            if (b.status === 'elsewhere') {
                // Its owner is back: what it was, given back. Saved, it is said saved (nothing sent); a save that was
                // waiting, or stopped by the change, goes on; a refusal waits for the creator's press as before.
                const was = b.away ?? 'idle';
                b.away = null;
                if (b.world.source === 'live' && (b.waitingForAccount || ['saving', 'sign-in', 'not-saved', 'not-allowed'].includes(was))) {
                    if (account.kind === 'active') {
                        b.waitingForAccount = false;
                        // Said at once, so the account's second word (its read after the session's) finds it under way.
                        set(b, 'saving');
                        void enqueue(() => save(b, account.epoch));
                    } else if (account.kind === 'inactive') {
                        b.waitingForAccount = false;
                        set(b, 'not-allowed', 'the account is inactive');
                    } else {
                        // Not read yet (its read to come): it waits for that read, which says the account's word again.
                        b.waitingForAccount = true;
                        set(b, account.kind === 'anonymous' ? 'sign-in' : 'not-saved', `the account is ${account.kind}`);
                    }
                    return;
                }
                // Saved, its views said as they stand against the saved head: edited meanwhile, `changed`, for its Save
                // (EA9.4's review: it said Saved over views that differed).
                if (was === 'saved' || was === 'changed') {
                    const differs = b.savedKeys !== null && !sameKeys(b.keyframes, b.savedKeys);
                    set(b, differs ? 'changed' : 'saved', 'its owner signed in again');
                    return;
                }
                set(b, was, 'its owner signed in again');
                return;
            }
            if (b.waitingForAccount && account.kind === 'active') {
                // Its owner's account is active: the anonymous creator who linked Google (the companion's P1, the same
                // uid), or an account whose read answered late. Once: a second word of the same account (its session's
                // change, then its account read) must not send it twice.
                b.waitingForAccount = false;
                set(b, 'saving');
                void enqueue(() => save(b, account.epoch));
            } else if (b.waitingForAccount && account.kind === 'inactive') {
                // Read late, and barred (suspended, being deleted): said so, with nothing to press (the independent review).
                b.waitingForAccount = false;
                set(b, 'not-allowed', 'the account is inactive');
            }
        },
        state: () => (current ? view(current) : null),
        settled: () => chain,
        dispose() {
            disposed = true;
        },
    };
}
