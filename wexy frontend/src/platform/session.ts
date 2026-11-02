// The studio's account session (W1; the creations platform companion §6, F4): who is signed in, as the identity's account
// port says, and an epoch, E_auth, that moves whenever the account or its provider changes. An answer fetched for an
// earlier epoch is dropped on arrival, so a slow allowance read can never show one account's numbers to another. The
// session signs no one in by itself: it reads who is there after the creator's own Create or Sign in, and from then on
// follows changes (another tab's sign-out included) through one listener. The world on the stage is never its business.

import type { AccountPort, Collision, LinkOutcome, SignedIn } from '../forge-client/identity';

/** Who is signed in: not known yet (before any Create or Sign in), no one, or a provider. */
export type AccountKind = 'unknown' | 'none' | SignedIn['provider'];

export interface SessionState {
    /** E_auth: every answer fetched under an older epoch is stale. */
    readonly epoch: number;
    readonly kind: AccountKind;
}

/** What {@link AccountSession.guard} hands back for an answer that arrived after the account changed. */
export const STALE: unique symbol = Symbol('stale');

export class AccountSession {
    private state: SessionState = { epoch: 0, kind: 'unknown' };
    private uid: string | null = null;
    private readonly listeners = new Set<(state: SessionState) => void>();
    private off: (() => void) | null = null;
    private disposed = false;
    private readonly port: AccountPort;

    constructor(port: AccountPort) {
        this.port = port;
    }

    get current(): SessionState {
        return this.state;
    }

    /** Calls `listener` on every change of account or provider; returns the unsubscribe. */
    subscribe(listener: (state: SessionState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /**
     * Reads who is signed in, and from the first read on follows every change through one listener, however often it is
     * called. Never signs anyone in.
     */
    async refresh(): Promise<SessionState> {
        if (this.disposed) return this.state;
        const who = await this.port.current();
        if (this.disposed) return this.state;
        this.apply(who);
        this.off ??= this.port.onChange(() => { void this.refresh().catch(() => {}); });
        return this.state;
    }

    /** Google for this browser (the creator's action): on a link or a sign-in, the account is read again and the epoch moves. */
    async linkGoogle(): Promise<LinkOutcome> {
        return this.settled(await this.port.linkGoogle());
    }

    /** After a collision, the creator's choice: the other account, under a new epoch. */
    async signInExisting(collision: Collision): Promise<LinkOutcome> {
        return this.settled(await this.port.signInExisting(collision));
    }

    /** Signed out: no one is signed in until the next call makes a new anonymous caller; the epoch moves. */
    async signOut(): Promise<void> {
        await this.port.signOut();
        await this.refresh();
    }

    /** `run`'s answer, or {@link STALE} when the account changed while it ran: an answer for another account is dropped (F4). */
    async guard<T>(run: () => Promise<T>): Promise<T | typeof STALE> {
        const epoch = this.state.epoch;
        const value = await run();
        return epoch === this.state.epoch && !this.disposed ? value : STALE;
    }

    dispose(): void {
        this.disposed = true;
        this.off?.();
        this.off = null;
        this.listeners.clear();
    }

    private async settled(outcome: LinkOutcome): Promise<LinkOutcome> {
        if (outcome.kind === 'linked' || outcome.kind === 'signed-in') await this.refresh();
        return outcome;
    }

    /** A new epoch whenever the uid or the provider differs from what was known: the first reading only learns. */
    private apply(who: SignedIn | null): void {
        const kind: AccountKind = who ? who.provider : 'none';
        const uid = who?.uid ?? null;
        const learning = this.state.kind === 'unknown';
        if (!learning && uid === this.uid && kind === this.state.kind) return;
        this.uid = uid;
        this.state = { epoch: learning ? this.state.epoch : this.state.epoch + 1, kind };
        for (const listener of [...this.listeners]) listener(this.state);
    }
}
