// The studio's account session (W1; the creations platform companion §6, F4): who is signed in, as the identity's account
// port says, and an epoch, E_auth, that moves whenever the account or its provider changes. An answer fetched for an
// earlier epoch is dropped on arrival, so a slow allowance read can never show one account's numbers to another. The
// session signs no one in by itself: it reads who is there after the creator's own Create or Sign in (a Create's `enter`
// runs the transport's own sign-in first, EA9.1), and from then on follows changes (another tab's sign-out included)
// through one listener. The world on the stage is never its business.
//
// W2 (the user's choice, 2026-11-03): one bit in the browser, "a Google session is here", written whenever the session
// learns its kind, so a reload can show a returning creator's account at once. It holds no identity; a fresh or
// anonymous visitor has none, so for them a page view still loads no Firebase (W1's rule).

import type { AccountPort, Collision, LinkOutcome, SignedIn } from '../forge-client/identity';

/** Where the hint lives: `1`, or nothing. */
export const GOOGLE_HINT_KEY = 'wexy.googleSession';

/** The one-bit hint that this browser holds a Google session. Storage may be missing or blocked: then it is just false. */
export interface SessionHint {
    read(): boolean;
    write(google: boolean): void;
}

export const browserHint: SessionHint = {
    read() {
        try {
            return localStorage.getItem(GOOGLE_HINT_KEY) === '1';
        } catch {
            return false;
        }
    },
    write(google) {
        try {
            if (google) localStorage.setItem(GOOGLE_HINT_KEY, '1');
            else localStorage.removeItem(GOOGLE_HINT_KEY);
        } catch {
            // Storage blocked: a reload shows Sign in until the creator's first click or Create, as in W1.
        }
    },
};

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
    private readonly hint: SessionHint;
    private readonly entry: () => Promise<unknown>;

    /**
     * `entry` is what an entry call (a Create) does before it is sent, the transport's own lazy sign-in (identity.ts's
     * `authorization`): the caller signed in, or a new anonymous one when no one is. Only {@link enter} calls it.
     */
    constructor(port: AccountPort, hint: SessionHint = browserHint, entry: () => Promise<unknown> = async () => {}) {
        this.port = port;
        this.hint = hint;
        this.entry = entry;
    }

    get current(): SessionState {
        return this.state;
    }

    /** A caller is signed in, as last read: anonymous or Google. Not before any reading, nor after a sign-out. */
    get established(): boolean {
        return this.state.kind === 'anonymous' || this.state.kind === 'google';
    }

    /** Whether this browser held a Google session when last seen (W2): worth reading who is signed in on a page load. */
    get hinted(): boolean {
        return this.hint.read();
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

    /**
     * The caller an entry's calls go out as, made or found before the first of them (EA9.1; agent-first-studio-design.md §6
     * step 1): `entry` signs in as that call would (an anonymous caller when no one is signed in), then the session reads
     * who it is. So the epoch after it is that caller's, and a creation binds its calls to E_auth only then: learning the
     * first identity, after a sign-out or on a first visit, is not a switch away from one. Called by the creator's Create,
     * never by a page view.
     */
    async enter(): Promise<SessionState> {
        if (this.disposed) return this.state;
        await this.entry();
        return this.refresh();
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
        this.hint.write(kind === 'google');
        const learning = this.state.kind === 'unknown';
        if (!learning && uid === this.uid && kind === this.state.kind) return;
        this.uid = uid;
        this.state = { epoch: learning ? this.state.epoch : this.state.epoch + 1, kind };
        for (const listener of [...this.listeners]) listener(this.state);
    }
}
