// A saved world opened from the platform (W3.6; the creations platform companion §8, F3, F5, P6): the world's head read
// (`GET /v1/worlds/{id}`), its revision's exact text (`GET /v1/worlds/{id}/revisions/{revisionId}`), then the file's own
// checks before anything trusts it (artifact.ts's parseWorld: the byte cap and the SHA-256 the server names, both before
// the text is parsed; canonical; the schema, which has no room for a device's verdict or any evidence; the line), then
// sealed by this host (reopen.ts). Nothing here compiles, runs or touches the stage: the studio's L3 on this device
// (loop/replay.ts's compileSaved), the creator's Show it and the stage's Run follow, as for any candidate. Only the world
// routes are called: never a model (F5).

import type { SolutionDesign } from '../contract/agent';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { Api } from '../forge-client/http';
import type { SealedCandidate } from '../loop/snapshot';
import { parseWorld, type SavedView, type WorldRefusal } from './artifact';
import { opensLine, OPENS_LINES } from './lines';
import { openWorld } from './reopen';
import { readRevision, readWorld } from './worlds';

/** A saved world, sealed here and ready for this device's L3: what the stage's Run and the save binding need. */
export interface OpenedWorld {
    readonly worldId: string;
    /** The creation's title, the server's (never the file's: it has none). */
    readonly title: string;
    readonly revisionId: string;
    readonly rowVersion: number;
    readonly snapshot: DeepReadonly<SealedCandidate>;
    readonly design: DeepReadonly<SolutionDesign>;
    /** The camera it was saved with, or null: then the world is framed on what it builds. */
    readonly view: DeepReadonly<SavedView> | null;
    /** What the file said beside what this build sealed (Developer view); never a reason to refuse, nor to trust (§8). */
    readonly provenance: { readonly graph: string; readonly candidate: string; readonly same: boolean };
}

/**
 * Why it did not open: `missing`, gone or another's (one 404); `unavailable`, no answer, or the platform's own 503;
 * the file's refusals (`too-large`, `corrupt`, `unreadable`, `incompatible`: artifact.ts); `unsealed`, the host does not
 * seal what the file holds (a body for another interface, a lint error, a program that does not resolve).
 */
export type OpenRefusal = 'missing' | 'unavailable' | WorldRefusal | 'unsealed';

export type Opened =
    | { readonly ok: true; readonly world: OpenedWorld }
    | { readonly ok: false; readonly code: OpenRefusal; readonly reason: string };

const refuse = (code: OpenRefusal, reason: string): Opened => ({ ok: false, code, reason });

/** The file's refusals in §12's developer words: a hash mismatch is the platform's, the rest the file's. */
const PREFIX: Readonly<Record<WorldRefusal, string>> = {
    'too-large': 'PL_TOO_LARGE', 'corrupt': 'PL_UNAVAILABLE', 'unreadable': 'PL_INCOMPATIBLE', 'incompatible': 'PL_INCOMPATIBLE',
};

/** `worldId`'s head, read, checked and sealed (§8's steps 1 to 3); a refusal says which check it failed. */
export async function openSaved(api: Api, worldId: string, signal?: AbortSignal): Promise<Opened> {
    const world = await readWorld(api, worldId, signal);
    if (world === 'missing') return refuse('missing', `PL_NOT_FOUND /v1/worlds/${worldId.slice(0, 26)}: 404`);
    if (world === 'unavailable') return refuse('unavailable', `PL_UNAVAILABLE /v1/worlds/${worldId}: no answer to keep`);
    const head = world.head;
    // A line this build does not open stops here, before its text is even fetched, and never reaches a seal (§8 step 2).
    if (!opensLine(head.line)) {
        return refuse('incompatible', `PL_INCOMPATIBLE ${worldId}: line ${head.line} not in OPENS_LINES (${OPENS_LINES.join(', ')})`);
    }
    const revision = await readRevision(api, worldId, head.revisionId, signal);
    if (revision === 'missing') return refuse('missing', `PL_NOT_FOUND /v1/worlds/${worldId}/revisions/${head.revisionId}: 404`);
    if (revision === 'unavailable') return refuse('unavailable', `PL_UNAVAILABLE /v1/worlds/${worldId}/revisions/${head.revisionId}: no answer to keep`);
    if (revision.revisionId !== head.revisionId || revision.worldId !== worldId) {
        return refuse('unavailable', `PL_UNAVAILABLE ${worldId}: the revision read is not the head asked for`);
    }
    // Two answers that disagree on the bytes (the head moved between them): nothing to trust yet; opening again may do.
    if (revision.sha256 !== head.sha256) return refuse('unavailable', `PL_UNAVAILABLE ${worldId}: the revision's sha256 is not the head's`);
    // The bytes the server names, checked before the text is parsed (artifact.ts).
    const parsed = await parseWorld(revision.artifact, head.sha256);
    if (!parsed.ok) return refuse(parsed.code, `${PREFIX[parsed.code]} ${worldId}: ${parsed.reason}`);
    const sealed = await openWorld(parsed.world, worldId);
    if (!sealed.ok) return refuse('unsealed', `PL_UNSEALED ${worldId}: ${sealed.reason}`);
    return {
        ok: true,
        world: {
            worldId, title: world.title, revisionId: head.revisionId, rowVersion: world.rowVersion, snapshot: sealed.snapshot,
            design: parsed.world.design, view: parsed.world.view, provenance: sealed.provenance,
        },
    };
}
