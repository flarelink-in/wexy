// One world on the stage (EA9.3; agent-first-studio-design.md §8, I3): H is one tagged value, empty, the backdrop, a
// legacy world (h1's Head) or an agent world, and `install` is the one way a world reaches the stage. Every action that
// reads the world on the stage (film, photo, the keys, framing, the timeline, the controls, a resize, a device loss, the
// review) reads H's kind and acts on H alone, never on fields another world left behind.
//
// The order (§8 step 1): the new world is prepared without touching H (its build, its check, its reservation: the
// caller's, before install); then, in one synchronous handover, the switch (the viewport's setRuntime, unless the stage's
// own Run already made it) and the new world published (its camera, timeline, controls, HUD); only then is H retired: its
// destroy attempted after the switch (L8), its reservation returned once even if destroy throws, an error said and the
// new world kept. Nothing here awaits or allocates. Pure: the studio hands in its port (main.ts), so the order and the
// ledger's count are tested without a browser (EA9-U7).
// The ledger (§8 step 2): a world built before the stage existed, h1's Head or the backdrop, is counted once both exist,
// at the largest canvas the viewport can give it, and again whenever it outgrows that (`account`); no candidate is
// admitted beside a world on the stage not counted yet (`uncounted`). A throw in the handover never undoes a switch.

/** What the stage's ledger holds for a world: its bytes, returned once, by its retirement. */
export interface Held {
    readonly bytes: number;
    release(): void;
}

/** H. The legacy, agent and backdrop variants carry the studio's own objects for them (`L`, `A`, `B`), untouched here. */
export type ActiveWorld<L, A, B> =
    | { readonly kind: 'empty' }
    | { readonly kind: 'backdrop'; readonly backdrop: B; readonly held: Held | null }
    | { readonly kind: 'legacy'; readonly legacy: L; readonly held: Held | null }
    | { readonly kind: 'agent'; readonly agent: A; readonly held: Held | null };

export type WorldKind = ActiveWorld<unknown, unknown, unknown>['kind'];

/** The studio as an install reaches it. */
export interface InstallPort<W> {
    /**
     * The switch: the viewport's setRuntime, synchronous and infallible (executor §9). Absent for an agent world, whose
     * Run already switched in the stage's own commit: a second commit after it is never made (§8 step 1).
     */
    commit?(next: W): void;
    /** The new world's state on the page: its camera, timeline, controls, HUD and badge, by its kind. Synchronous. */
    publish(next: W): void;
    /** The old world's teardown after the switch: its destroy attempted. Its reservation is install's to return. */
    destroy(old: W): void;
}

/** What an install came to: the world now on the stage, and any teardown error said (the new world stays). */
export interface Installed<W> {
    readonly world: W;
    readonly errors: readonly string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * `next` onto the stage in place of `current` (§8 step 1). `next` was prepared by the caller, its reservation (`held`)
 * among it. The handover is synchronous: commit, publish, and then the old world's retirement, its destroy attempted and
 * its reservation returned exactly once whatever destroy does. So once this returns, the ledger holds exactly the new
 * world's reservation (and nothing of the old one's), and every error a teardown raised is said, the new world kept.
 * Installing the world already on the stage is refused: it would retire itself.
 *
 * Nothing that throws here undoes a switch (EA9.3's review). A commit that throws switched nothing: the old world stays,
 * and the new one, never shown, is let go. Once committed, the new world is the one on the stage: a publication that
 * throws is said, and the old world is still retired, so the page and the ledger never keep the two.
 */
export function install<L, A, B>(current: ActiveWorld<L, A, B>, next: ActiveWorld<L, A, B>, port: InstallPort<ActiveWorld<L, A, B>>): Installed<ActiveWorld<L, A, B>> {
    if (next === current) return { world: current, errors: ['EA_INSTALL the world on the stage cannot replace itself'] };
    try {
        port.commit?.(next);
    } catch (e) {
        return { world: current, errors: [`EA_COMMIT ${next.kind}: ${message(e)}; the world on the stage stays`, ...retire(next, port)] };
    }
    const errors: string[] = [];
    try {
        port.publish(next);
    } catch (e) {
        errors.push(`EA_PUBLISH ${next.kind}: ${message(e)}; it is on the stage, and the old world is retired`);
    }
    return { world: next, errors: [...errors, ...retire(current, port)] };
}

/** `old`'s teardown: its destroy attempted, then its reservation returned once, each error said. Empty retires nothing. */
export function retire<L, A, B>(old: ActiveWorld<L, A, B>, port: Pick<InstallPort<ActiveWorld<L, A, B>>, 'destroy'>): string[] {
    if (old.kind === 'empty') return [];
    const errors: string[] = [];
    try {
        port.destroy(old);
    } catch (e) {
        errors.push(`EA_RELEASE ${old.kind}: ${message(e)}; the new world stays installed`);
    }
    try {
        old.held?.release();
    } catch (e) {
        errors.push(`EA_RELEASE ${old.kind}'s reservation: ${message(e)}`);
    }
    return errors;
}

/**
 * H counted in the stage's ledger (§8 step 2): a Head or a backdrop built before the stage was, once both exist; and
 * counted again, larger, when it may hold more than it was counted at (EA9.3's review: a resize grows a Head's post
 * chain, and an admission must never read a reservation H has outgrown). `bytes` is what H may hold (the studio's: at the
 * largest canvas the viewport can give it, never less than now), null while it is not built yet (a backdrop still
 * building); `record` is the ledger's, null before the stage exists. A reservation that covers `bytes` stays, so nothing
 * is counted twice; a larger one replaces it, recorded before the old one is returned. An agent world's reservation is
 * its own Run's, sized at its envelope (past which it pauses), and the empty stage holds nothing: both come back as they
 * were, as does any world nothing can count yet.
 */
export function account<L, A, B>(world: ActiveWorld<L, A, B>, bytes: number | null, record: ((label: string, bytes: number) => Held) | null, label: string): ActiveWorld<L, A, B> {
    if (world.kind === 'empty' || world.kind === 'agent' || !record || bytes === null) return world;
    if (world.held && world.held.bytes >= bytes) return world;
    const held = record(label, bytes);
    world.held?.release();
    return { ...world, held };
}

/**
 * A world on the stage the ledger does not count yet (§8 step 2): no candidate is admitted beside it until it is, since
 * the admission would leave its bytes out. The empty stage holds nothing.
 */
export function uncounted(world: ActiveWorld<unknown, unknown, unknown>): boolean {
    return world.kind !== 'empty' && !world.held;
}

/** The empty stage. */
export const EMPTY = Object.freeze({ kind: 'empty' as const });
