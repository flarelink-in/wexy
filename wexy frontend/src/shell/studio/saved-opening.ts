// A saved world opened by its id (`?world=<id>`; W3.6, the creations platform companion §8; F3, F4, F5): who is signed
// in read first (a saved world is its owner's alone), then the world read, checked and sealed (open-saved.ts) as that
// account's caller, compiled by L3 on this device, and offered on the empty stage's card, whose Show it is the GPU go
// (Q115). Only the world routes are called for it, never a model (F5); nothing here touches the stage, the Run does.
//
// The whole opening belongs to the account epoch it was read under (W3's review, its mid): an account change at any point
// after the read ends it ("You signed in or out while this world was opening"), so a world fetched for one account is
// never installed for another. Every step after an await asks again, the subscription ends it as soon as the session
// moves, Show it asks once more just before the Run, and a Run under way is stopped (the second review). Plain
// TypeScript over ports: test/saved-opening.test.mjs.

import type { CompiledBody } from '../../contract/adapters/bodies';
import type { DeepReadonly } from '../../contract/engine/frozen';
import { boundTo, type Api, type Caller } from '../../forge-client/http';
import { COPY } from '../../loop/copy';
import type { Opened, OpenedWorld, OpenRefusal } from '../../platform/open-saved';

/** The card's offer besides Show it: Sign in (no Google session), or the history (an end). */
export type OpeningOffer = 'sign-in' | 'your-worlds' | null;

/** What the empty stage's card shows of the opening. */
export interface OpeningView {
    readonly worldId: string;
    readonly sentence: string;
    readonly offer: OpeningOffer;
    /** Sealed and compiled here, under the epoch it was read in: Show it is offered. */
    readonly ready: boolean;
    readonly running: boolean;
}

/** The world as Show it runs it: sealed here, every body compiled by this device. */
export interface ReadyWorld {
    readonly world: OpenedWorld;
    readonly compiled: readonly DeepReadonly<CompiledBody>[];
}

/** The session as the opening reads it: who is signed in, its epoch, its caller, and its changes. */
export interface OpeningSession {
    readonly current: { readonly epoch: number; readonly kind: string };
    refresh(): Promise<unknown>;
    subscribe(listener: () => void): () => void;
    caller(): Caller | null;
}

export interface OpeningPorts {
    /** The gateway, or null when this build has none (or no way to sign in): the opening then says so and ends. */
    readonly api: Api | null;
    readonly session: OpeningSession | null;
    /** open-saved.ts's openSaved, over `api` bound to the epoch's caller. */
    open(api: Api, worldId: string): Promise<Opened>;
    /** L3 on this device, once the stage exists: every body compiled, or why not (a refusal, no compiler, a throw). */
    compile(world: OpenedWorld): Promise<{ readonly compiled: readonly DeepReadonly<CompiledBody>[] } | { readonly problem: string }>;
    /** Whether something else holds the stage now, so a Run would wait (stage-holds.ts): Show it does nothing then. */
    blocked(): boolean;
    /**
     * The stage's Run of the opened world, read under `epoch`: what it came to. `signal` aborts when the account changes
     * while it runs, so the Run stops with the Head unchanged (the stage's own Stop) instead of installing it (the second
     * review of W3).
     */
    run(ready: ReadyWorld, epoch: number, signal: AbortSignal): Promise<'installed' | 'stopped' | 'refused'>;
    /** The card changed. */
    changed(): void;
    /** Developer view's record of the read: ok or not, in a developer's words. */
    record(ok: boolean, text: string): void;
}

/** A saved world that did not open, in the creator's words (the companion §12): by its refusal's code, never its prose. */
export function openSentence(code: OpenRefusal): string {
    switch (code) {
        case 'missing': return COPY.open.missing;
        case 'unavailable':
        case 'corrupt': return COPY.open.unavailable;
        case 'too-large':
        case 'unreadable':
        case 'incompatible': return COPY.open.incompatible;
        case 'unsealed': return COPY.open.unsealed;
    }
}

export class SavedOpening {
    readonly worldId: string;
    private readonly ports: OpeningPorts;
    private sentence: string = COPY.open.opening;
    private offer: OpeningOffer = null;
    private ready: ReadyWorld | null = null;
    private running = false;
    /** The epoch the world was read under, and its caller; null until the read begins. */
    private epoch: number | null = null;
    private caller: Caller | null = null;
    private ended = false;
    /** The Run under way, stopped by an account change. */
    private stopRun: AbortController | null = null;
    private readonly off: () => void;

    constructor(worldId: string, ports: OpeningPorts) {
        this.worldId = worldId;
        this.ports = ports;
        // As soon as the session moves past the epoch the world was read under, the opening is over (F4).
        this.off = ports.session?.subscribe(() => { if (this.epoch !== null && !this.holds()) this.lost(); }) ?? (() => {});
    }

    view(): OpeningView {
        return { worldId: this.worldId, sentence: this.running ? COPY.open.testing : this.sentence, offer: this.offer, ready: !!this.ready && !this.running, running: this.running };
    }

    /** Whether it is still the read epoch's: not ended, read, and the session and the caller both still that epoch's. */
    private holds(): boolean {
        const session = this.ports.session;
        return !this.ended && this.epoch !== null && !!session && session.current.epoch === this.epoch && !!this.caller?.still();
    }

    private say(sentence: string, offer: OpeningOffer = null): void {
        if (this.ended) return;
        this.sentence = sentence;
        this.offer = offer;
        this.ports.changed();
    }

    /**
     * The account changed after the read: nothing of this opening is offered any more, a Run of it under way is stopped,
     * and it reopens from the history.
     */
    private lost(): void {
        if (this.ended) return;
        this.ready = null;
        this.stopRun?.abort(new Error('the account changed while the saved world ran'));
        this.say(COPY.open.accountChanged, 'your-worlds');
    }

    /** The opening, from the sign-in to Show it offered: an end at any refusal, or at any account change after the read. */
    async start(): Promise<void> {
        const { api, session } = this.ports;
        if (!api || !session) return this.say(COPY.creation.noGateway);
        this.ports.changed();
        try {
            await session.refresh();
        } catch {
            // No identity could be read: the creator is asked to sign in, as with none.
        }
        while (session.current.kind !== 'google') {
            if (this.ended) return;
            this.say(COPY.open.signIn, 'sign-in');
            await new Promise<void>(resolve => { const off = session.subscribe(() => { off(); resolve(); }); });
        }
        if (this.ended) return;
        const caller = session.caller();
        if (!caller) return this.say(COPY.open.accountChanged, 'your-worlds');
        this.epoch = session.current.epoch;
        this.caller = caller;
        this.say(COPY.open.opening);
        // Read as this epoch's caller alone: the transport sends nothing under an account signed in meanwhile.
        const opened = await this.ports.open(boundTo(api, caller), this.worldId);
        if (!this.holds()) return this.lost();
        if (!opened.ok) {
            this.ports.record(false, opened.reason);
            return this.say(openSentence(opened.code), 'your-worlds');
        }
        const o = opened.world;
        this.ports.record(true, `${o.worldId} at ${o.revisionId}, sealed here: id(C) ${o.snapshot.id.slice(0, 12)}…; the file's X and id(C) ${o.provenance.same ? 'are this build\'s' : 'differ from this build\'s (provenance only)'}`);
        this.say(COPY.open.checking);
        const l3 = await this.ports.compile(o);
        if (!this.holds()) return this.lost();
        if ('problem' in l3) {
            this.ports.record(false, l3.problem);
            return this.say(COPY.open.notHere, 'your-worlds');
        }
        this.ready = { world: o, compiled: l3.compiled };
        this.say(COPY.open.ready(o.title));
    }

    /** The creator's Show it: the GPU go, then the stage's Run, as for any world (Q115), if the read epoch still holds. */
    async show(): Promise<void> {
        const ready = this.ready;
        if (!ready || this.running || this.ended || this.ports.blocked()) return;
        if (!this.holds()) return this.lost();
        this.running = true;
        this.ports.changed();
        const stop = new AbortController();
        this.stopRun = stop;
        const status = await this.ports.run(ready, this.epoch as number, stop.signal).finally(() => { this.stopRun = null; });
        // Installed: the world reached the stage, which ended the opening (end()). Otherwise it waits for another press,
        // unless the account changed meanwhile.
        if (this.ended) return;
        this.running = false;
        if (!this.holds()) return this.lost();
        this.say(status === 'stopped' ? COPY.open.ready(ready.world.title) : COPY.open.runRefused);
    }

    /** Over: a world reached the stage (this one or another), or the page leaves. Nothing more is said or offered. */
    end(): void {
        if (this.ended) return;
        this.ended = true;
        this.ready = null;
        this.off();
    }
}
