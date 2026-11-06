// Q_C, the candidate's budget (candidate-loop-design.md §8; Q84 decided 2026-10-31, revised 2026-11-02): what one attempt may
// spend on model calls, counted before each call starts. A cooperative bound on the browser's own attempt, not a
// security boundary: the backend's reservations and daily caps bound money (the design §6).
//
// Every reservation is synchronous: a check and its reservation have no await between them, so two jobs racing for the
// last slot cannot both pass. A slot is spent once its request is dispatched, whatever the server then charges; only a
// reservation never dispatched returns. A settled call counts as known; a call whose end was not seen (a cancel, a drop)
// counts as unknown, never zero. A revision reserves its whole allowance before it starts and is reconciled to its
// actual calls only on a trustworthy end; otherwise the whole reservation stays, unknown. No counter ever resets: a
// revision does not replenish authors or repairs, and a module's repairs follow its id.

/** Q_C's limits. */
export interface CandidateLimits {
    /** Model calls across the whole attempt, the turn's own included. */
    calls: number;
    /** Modules in any accepted graph. */
    modules: number;
    /** Author calls across all revisions: re-authoring a module consumes another. */
    authors: number;
    /** Module calls in flight at once, authors and repairs together. */
    concurrent: number;
    /** Repair calls in all, and for one module. */
    repairs: number;
    repairsPerModule: number;
    /** Program revisions, and the calls each may make (a turn of its own). */
    revisions: number;
    revisionCalls: number;
    /**
     * Visual rounds (EA6, B_v): the creator's "Improve it" presses an attempt accepts, each a program revision answering
     * what they saw. Not calls: each round's calls count in the rest of Q_C like any other.
     */
    visualRounds: number;
    /**
     * A model's reviews of the world on the stage (EA6.4, visual-review-design.md §9.1): each one call of `calls`, under
     * the ledger's kind `review`. Three: one before each visual round and one after the last.
     */
    reviews: number;
}

/**
 * Q84, revised 2026-11-02 (the user: "12 modules, 34 calls", after the black hole starter, about eight modules, was
 * stopped at four): at most 12 modules and 12 authors, 4 calls at once, 2 repairs a module and 10 in all, program
 * revisions of at most 6 calls each, and 34 calls an attempt, the turn's 6 included. Independent ceilings, not a promise
 * that every graph can finish. The backend holds a turn's program to the same 12 modules (`AgentTurn.MAX_MODULES`) and
 * paces the module route at an attempt's 22 module calls (`AgentTurn.MODULE_CALLS`, the authors and repairs here).
 * Decided first 2026-10-31: 4 modules, 2 at once, 3 repairs, 19 calls.
 *
 * Q110, decided 2026-11-02 night (the user: "revision limit can be raised but max cap as is"): 3 program revisions, up
 * from 1, and 2 visual rounds an attempt (visual-review-design.md §8.3), the 34 calls kept as the cap on everything. Three
 * revisions are ceilings, not three turns: 6 + 12 + 10 + 3 × 6 = 46 is past 34, so the calls refuse first.
 *
 * EA6.4 (Q112 (a), decided 2026-11-03): 3 reviews by a model an attempt, each one of the 34 calls. The backend holds a
 * prompt to two attempts' reviews (`review-calls`, 6) and paces them by `AgentTurn.REVIEWS`.
 */
export const Q_C: CandidateLimits = Object.freeze({
    calls: 34, modules: 12, authors: 12, concurrent: 4, repairs: 10, repairsPerModule: 2, revisions: 3, revisionCalls: 6, visualRounds: 2, reviews: 3,
});

/**
 * The most model calls one agent turn makes: the backend's `AgentTurn.MAX_CALLS`, what the gateway charges a turn (EA-K5b
 * pins the two equal). A turn a second try followed whose end was not seen counts this many, unknown (Q120 (b), the
 * outside review of EA9.5): the calls the browser saw may not be all it made.
 */
export const TURN_CALLS = 6;

/** A budget a refusal names. `concurrent` is the scheduler's bound: wait for a call to end, never an exhaustion. */
export type Budget = 'calls' | 'modules' | 'authors' | 'repairs' | 'repairs-per-module' | 'revisions' | 'concurrent' | 'visual-rounds' | 'reviews';

export type CallKind = 'author' | 'repair' | 'revision' | 'review';

export interface Reservation {
    readonly id: number;
    readonly kind: CallKind;
    /** The module an author or a repair is for; null for a revision or a review. */
    readonly module: string | null;
    /** Calls held: one for a module call, the revision's whole allowance for a revision. */
    readonly calls: number;
}

export type Reserved = { ok: true; reservation: Reservation } | { ok: false; budget: Budget; used: number; limit: number };

export interface LedgerState {
    calls: {
        /** Calls whose end was seen: the turn's actual calls, and every call settled since. */
        settled: number;
        /** Held for calls in flight, and a revision's whole allowance while it runs. */
        reserved: number;
        /** Calls dispatched whose end was not seen: counted, never zero. */
        unknown: number;
    };
    authors: number;
    repairs: number;
    /** Each module's repairs, by its id. */
    moduleRepairs: Readonly<Record<string, number>>;
    revisions: number;
    /** Visual rounds accepted (EA6): a dispatched round stays counted whatever came of it. */
    visualRounds: number;
    /** A model's reviews reserved (EA6.4): a dispatched one stays counted whatever came of it. */
    reviews: number;
    /** Calls in flight but a revision's: module calls and a model's review. */
    inFlight: number;
}

/** The developer's words for a refusal (the design §11): `EA_TURN_BUDGET <which>: <used> of <limit>`. */
export const budgetDiagnostic = (r: { budget: Budget; used: number; limit: number }): string => `EA_TURN_BUDGET ${r.budget}: ${r.used} of ${r.limit}`;

interface Open {
    reservation: Reservation;
    dispatched: boolean;
}

export class Ledger {
    readonly limits: CandidateLimits;
    private settled: number;
    private reserved = 0;
    private unknown = 0;
    private authors = 0;
    private repairs = 0;
    private readonly moduleRepairs = new Map<string, number>();
    private revisions = 0;
    private visualRounds = 0;
    private reviews = 0;
    private readonly open = new Map<number, Open>();
    private next = 1;

    /**
     * Seeded from the turn's actual calls (the design §8), which count against the attempt's calls, and from
     * `unknownCalls`, calls counted before the attempt whose end was not seen: the whole allowance of a turn a second try
     * followed when that turn's end was not seen (Q120 (b), the outside review of EA9.5).
     */
    constructor(limits: CandidateLimits, turnCalls: number, unknownCalls = 0) {
        if (!Number.isSafeInteger(turnCalls) || turnCalls < 0) throw new Error(`ledger: the turn's calls are a whole number, not ${turnCalls}`);
        if (!Number.isSafeInteger(unknownCalls) || unknownCalls < 0) throw new Error(`ledger: the unknown calls are a whole number, not ${unknownCalls}`);
        this.limits = limits;
        this.settled = turnCalls;
        this.unknown = unknownCalls;
    }

    /** Calls spent or held: what the next reservation is measured against. */
    get used(): number {
        return this.settled + this.reserved + this.unknown;
    }

    get inFlight(): number {
        let n = 0;
        for (const o of this.open.values()) if (o.reservation.kind !== 'revision') n++;
        return n;
    }

    /** A module call's slot and its category, or the budget that refuses it. */
    reserveModule(kind: 'author' | 'repair', module: string): Reserved {
        if (this.revisionOpen() || this.reviewOpen()) return { ok: false, budget: 'concurrent', used: 1, limit: 0 };
        if (this.inFlight >= this.limits.concurrent) return { ok: false, budget: 'concurrent', used: this.inFlight, limit: this.limits.concurrent };
        if (this.used + 1 > this.limits.calls) return { ok: false, budget: 'calls', used: this.used, limit: this.limits.calls };
        if (kind === 'author') {
            if (this.authors + 1 > this.limits.authors) return { ok: false, budget: 'authors', used: this.authors, limit: this.limits.authors };
            this.authors++;
        } else {
            const mine = this.moduleRepairs.get(module) ?? 0;
            if (mine + 1 > this.limits.repairsPerModule) return { ok: false, budget: 'repairs-per-module', used: mine, limit: this.limits.repairsPerModule };
            if (this.repairs + 1 > this.limits.repairs) return { ok: false, budget: 'repairs', used: this.repairs, limit: this.limits.repairs };
            this.repairs++;
            this.moduleRepairs.set(module, mine + 1);
        }
        return { ok: true, reservation: this.hold(kind, module, 1) };
    }

    /**
     * A program revision's whole allowance, or the budget that refuses it. No module call may overlap a revision: the
     * caller drains its jobs first, and a revision with one in flight is refused as `concurrent`.
     */
    reserveRevision(): Reserved {
        if (this.inFlight > 0 || this.revisionOpen()) return { ok: false, budget: 'concurrent', used: this.inFlight, limit: 0 };
        if (this.revisions + 1 > this.limits.revisions) return { ok: false, budget: 'revisions', used: this.revisions, limit: this.limits.revisions };
        if (this.used + this.limits.revisionCalls > this.limits.calls) return { ok: false, budget: 'calls', used: this.used, limit: this.limits.calls };
        this.revisions++;
        return { ok: true, reservation: this.hold('revision', null, this.limits.revisionCalls) };
    }

    /**
     * A visual round (EA6, B_v), taken at once with the creator's press, or the budget that refuses it. A round is not a
     * call; its revision reserves its own allowance. A limit absent from older limits is none (the safe direction).
     */
    reserveVisualRound(): { ok: true } | { ok: false; budget: 'visual-rounds'; used: number; limit: number } {
        const limit = this.limits.visualRounds ?? 0;
        if (this.visualRounds + 1 > limit) return { ok: false, budget: 'visual-rounds', used: this.visualRounds, limit };
        this.visualRounds++;
        return { ok: true };
    }

    /**
     * A model's review (EA6.4): one call, or the budget that refuses it. It competes with every other paid action, so
     * none may be open: a revision or a module call in flight refuses it as `concurrent`, and while it is open a revision
     * or a module call is refused the same way. A limit absent from older limits is none (the safe direction).
     */
    reserveReview(): Reserved {
        if (this.open.size > 0) return { ok: false, budget: 'concurrent', used: this.open.size, limit: 0 };
        const limit = this.limits.reviews ?? 0;
        if (this.reviews + 1 > limit) return { ok: false, budget: 'reviews', used: this.reviews, limit };
        if (this.used + 1 > this.limits.calls) return { ok: false, budget: 'calls', used: this.used, limit: this.limits.calls };
        this.reviews++;
        return { ok: true, reservation: this.hold('review', null, 1) };
    }

    /** Gives a visual round back: only for a round whose revision was never dispatched (the caller's word). */
    returnVisualRound(): void {
        this.visualRounds = Math.max(0, this.visualRounds - 1);
    }

    /** The request has gone: its slot is spent, whatever the server charges. */
    dispatched(r: Reservation): void {
        const o = this.open.get(r.id);
        if (!o) throw new Error(`ledger: reservation ${r.id} is not open`);
        o.dispatched = true;
    }

    /** Returns a reservation that was never dispatched; a dispatched one is spent, and stays. */
    release(r: Reservation): boolean {
        const o = this.open.get(r.id);
        if (!o || o.dispatched) return false;
        this.open.delete(r.id);
        this.reserved -= r.calls;
        if (r.kind === 'author') this.authors--;
        if (r.kind === 'repair') {
            this.repairs--;
            this.moduleRepairs.set(r.module!, (this.moduleRepairs.get(r.module!) ?? 1) - 1);
        }
        if (r.kind === 'revision') this.revisions--;
        if (r.kind === 'review') this.reviews--;
        return true;
    }

    /**
     * A dispatched revision the backend refused at its admission, before any record or charge (EA9.4: its base's words
     * failed content safety, which the backend screens before it joins the revision or calls a model): nothing was
     * spent there, so nothing is here. Its calls are not counted, and the revision is given back. Only for that answer,
     * an HTTP refusal whose code the backend gives before any stream: a request whose end was not seen settles unknown.
     */
    refusedAtAdmission(r: Reservation): void {
        const o = this.open.get(r.id);
        if (!o || r.kind !== 'revision') return;
        this.open.delete(r.id);
        this.reserved -= r.calls;
        this.revisions--;
    }

    /**
     * Ends a dispatched reservation: `actual` calls known, or null when its end was not seen, which keeps the whole
     * reservation as unknown. A revision reconciles to its actual calls, at most its allowance.
     */
    settle(r: Reservation, actual: number | null): void {
        const o = this.open.get(r.id);
        if (!o) return;
        this.open.delete(r.id);
        this.reserved -= r.calls;
        if (actual === null) this.unknown += r.calls;
        else this.settled += Math.min(Math.max(0, actual), r.calls);
    }

    get state(): LedgerState {
        return {
            calls: { settled: this.settled, reserved: this.reserved, unknown: this.unknown },
            authors: this.authors,
            repairs: this.repairs,
            moduleRepairs: Object.freeze(Object.fromEntries(this.moduleRepairs)),
            revisions: this.revisions,
            visualRounds: this.visualRounds,
            reviews: this.reviews,
            inFlight: this.inFlight,
        };
    }

    private revisionOpen(): boolean {
        for (const o of this.open.values()) if (o.reservation.kind === 'revision') return true;
        return false;
    }

    private reviewOpen(): boolean {
        for (const o of this.open.values()) if (o.reservation.kind === 'review') return true;
        return false;
    }

    private hold(kind: CallKind, module: string | null, calls: number): Reservation {
        const reservation: Reservation = Object.freeze({ id: this.next++, kind, module, calls });
        this.open.set(reservation.id, { reservation, dispatched: false });
        this.reserved += calls;
        return reservation;
    }
}
