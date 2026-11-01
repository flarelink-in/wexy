// Evidence, routing and corrections for the candidate loop (candidate-loop-design.md §5, §8 and §9; Q83 decided
// 2026-10-31: in memory for the session, bounded). Every verdict is a record about an immutable subject: the attempt
// and its revision, and whichever of the program's, the graph's, the interface's and the body's hashes exist when it is
// made, so a resolver refusal is addressable before any X exists, and two bodies under one X never share evidence (P10).
// Each record and each of its findings has an id that stays the same for the attempt.
//
// `route` is the design's routing table: a finding goes to the smallest scope that can fix it (I5). `verifyEnvelope`
// holds a correction to the evidence it cites: findings the store still holds, about the subject being corrected, as it
// is now. Anything else is EA_STALE_EVIDENCE, before any call (P2, EA-U7). A module correction also cites at least one
// such finding about each module it changes, and names each module and finding once (the EA4.3 review), so no module is
// reopened, or sent to a repair, with nothing to answer. The store keeps every record the candidate
// still stands on (pinned by the machine) and at most a bounded history besides, evicting the oldest history first and
// counting what it dropped. When the pinned records alone pass the byte bound it fails closed (EA_EVIDENCE_LIMIT): an
// admission premise is never dropped in silence.

import type { ModuleSubject } from '../forge-client/module-stream';

/** §5's subject: what a verdict is about. */
export type EvidenceSubject = ModuleSubject;

export type EvidencePhase = 'resolve' | 'check' | 'interface' | 'lint' | 'compile' | 'admission' | 'render' | 'visual' | 'candidate';

export type Verdict = 'pass' | 'fail' | 'unverified';

/** Whose verdict: the host's own checks, a fake (which proves nothing about a device, I6), a device, a model, the creator. */
export type ProducedBy = 'host' | 'fake' | 'device' | 'model' | 'creator';

export interface EvidenceFinding {
    /** `<evidence id>.f<n>`: stable for the attempt. */
    id: string;
    code: string;
    /** A JSON pointer into the program, or null. */
    path: string | null;
    /** 1-based line in the body, or null. */
    line: number | null;
    severity: 'error' | 'warning';
    message: string;
    /** For a body's findings: the rung that found it (L1 the lint, L3 the compiler); the place it landed for L3. */
    rung: 'L1' | 'L3' | null;
    /** L3 only: on the body's lines, the host's (preamble, epilogue, chunks), or no line at all. */
    place: 'body' | 'host' | 'unplaced' | null;
}

export interface CandidateEvidence {
    id: string;
    subject: EvidenceSubject;
    phase: EvidencePhase;
    verdict: Verdict;
    findings: EvidenceFinding[];
    /** Findings past the record's bound, counted, not kept. */
    omittedFindings: number;
    producedBy: ProducedBy;
    /** A completion's references: the per-module records it stands on, never relabelled (the design §5). */
    refs: string[];
}

/** The scopes a finding routes to (the design §8). */
export type Scope = 'modules' | 'program' | 'design' | 'host' | 'candidate';

/** At most this many findings a record keeps; the rest are counted. */
export const MAX_RECORD_FINDINGS = 64;

/** The bounds of §9's proposal (Q83 a): history beyond the pinned records, and the serialized bytes of all records kept. */
export interface EvidenceLimits {
    history: number;
    bytes: number;
}

export const EVIDENCE_LIMITS: EvidenceLimits = Object.freeze({ history: 256, bytes: 4 * 1024 * 1024 });

/**
 * Where a failing record routes; null when it fails nothing. The design's table:
 * - a body's lint error, or a compile error on the body's lines: `modules`, that module repaired, the others kept;
 * - a resolver refusal, an error from the checks on X (work and memory over P among them: the program reduces its work,
 *   P is never raised), an interface refusal: `program`, a program revision with the findings;
 * - a capability H lacks (no adapter, family or implementation for it): `design`, which EA4 never revises: the creator
 *   asks again. A gated value of an adapter H has (Q80's `upload`, custom lighting) is the program's to change;
 * - a compile error on the host's own lines (the preamble, the epilogue, an injected chunk): `host`, never a body repair;
 * - a compile error no line places: `candidate`, and no module is accused.
 * Protocol, auth and network failures never become evidence: the machine stops on them as `host` itself.
 */
export function route(e: Readonly<CandidateEvidence>): Scope | null {
    if (e.verdict !== 'fail') return null;
    const errors = e.findings.filter(f => f.severity === 'error');
    switch (e.phase) {
        case 'resolve':
            return errors.some(f => f.code === 'EA_CAPABILITY_UNSUPPORTED' && /\/(adapterId|adapterVersion)$/.test(f.path ?? '')) ? 'design' : 'program';
        case 'check':
        case 'interface':
            return 'program';
        case 'lint':
            return 'modules';
        case 'compile':
            if (errors.some(f => f.place === 'host')) return 'host';
            if (errors.some(f => f.place === 'body')) return 'modules';
            return 'candidate';
        case 'admission':
        case 'render':
        case 'candidate':
            return 'candidate';
        case 'visual':
            // A visual verdict is a verdict of its own: it may propose a scope, never decide one (EA-U11).
            return null;
    }
}

/** A correction (the design §9): what it is based on, the scope it asks for, what it changes, the findings it answers. */
export interface Envelope {
    base: {
        attempt: string;
        revision: number;
        /** id(C) once the candidate is complete; null before. */
        candidate: string | null;
        programHash: string;
        graph: string | null;
    };
    scope: 'modules' | 'program' | 'design' | 'controls';
    /** For `modules`, the modules to repair. */
    changes: string[];
    /** Finding ids (`<evidence>.f<n>`) the correction answers. */
    findingsAddressed: string[];
}

/** What a correction is checked against: the candidate as it is now. */
export interface CurrentSubject {
    attempt: string;
    revision: number;
    candidate: string | null;
    programHash: string | null;
    graph: string | null;
    modules: ReadonlyMap<string, { interfaceHash: string; codeHash: string | null }>;
}

const short = (s: string | null | undefined) => (s === null || s === undefined ? 'none' : s.length > 16 ? s.slice(0, 12) : s);
const stale = (expected: string, got: string) => `EA_STALE_EVIDENCE expected ${expected}, got ${got}`;

/**
 * Null when the envelope may be acted on; otherwise why not, in a developer's words. Checked before dispatch and again
 * before a result is applied: a correction answers findings about the subject as it is now, or it is stale.
 */
export function verifyEnvelope(envelope: Readonly<Envelope>, current: CurrentSubject, find: (findingId: string) => { record: CandidateEvidence; finding: EvidenceFinding } | null): string | null {
    const base = envelope.base;
    if (base.attempt !== current.attempt) return stale(`attempt ${short(current.attempt)}`, `attempt ${short(base.attempt)}`);
    if (base.candidate !== null && base.candidate !== current.candidate) return stale(`candidate ${short(current.candidate)}`, `candidate ${short(base.candidate)}`);
    if (base.programHash !== current.programHash || base.graph !== current.graph) {
        return stale(`program ${short(current.programHash)} graph ${short(current.graph)}`, `program ${short(base.programHash)} graph ${short(base.graph)}`);
    }
    if (envelope.scope === 'design') return 'EA4 starts no design revision: a capability the host lacks is the creator\'s to ask again';
    if (envelope.scope === 'controls') return 'the controls tier waits for Q85: a v2 program has no controls';
    if (!envelope.findingsAddressed.length) return 'a correction answers findings: findingsAddressed is empty';
    const twice = envelope.findingsAddressed.find((id, i) => envelope.findingsAddressed.indexOf(id) !== i);
    if (twice !== undefined) return `a correction cites each finding once: ${short(twice)} is cited twice`;
    if (envelope.scope === 'modules') {
        if (!envelope.changes.length) return 'a module correction names the modules it changes';
        const named = new Set<string>();
        for (const m of envelope.changes) {
            if (!current.modules.has(m)) return stale(`a module of this candidate`, `module ${short(m)}`);
            if (named.has(m)) return `a module correction names each module once: ${short(m)} is named twice`;
            named.add(m);
        }
    }
    // The modules the cited findings answer, each counted once its finding holds.
    const answered = new Set<string>();
    for (const id of envelope.findingsAddressed) {
        const held = find(id);
        if (!held) return stale('a finding this attempt holds', `${short(id)}`);
        const s = held.record.subject;
        if (s.attempt !== current.attempt) return stale(`attempt ${short(current.attempt)}`, `attempt ${short(s.attempt)} (${id})`);
        if (envelope.scope === 'program') {
            // A program correction answers what was found in this program: its resolve, its checks, its interfaces, or a
            // verdict on the candidate made from it.
            if (s.programHash !== current.programHash) return stale(`program ${short(current.programHash)}`, `program ${short(s.programHash)} (${id})`);
            if (s.graph !== null && s.graph !== current.graph) return stale(`graph ${short(current.graph)}`, `graph ${short(s.graph)} (${id})`);
            continue;
        }
        // A module correction answers that module's own findings, about the body it has now: never another body's (P10).
        if (s.module === null || !envelope.changes.includes(s.module)) return stale(`a finding about ${envelope.changes.join(', ')}`, `one about ${short(s.module)} (${id})`);
        const mine = current.modules.get(s.module)!;
        if (s.graph !== current.graph) return stale(`graph ${short(current.graph)}`, `graph ${short(s.graph)} (${id})`);
        if (s.interfaceHash !== mine.interfaceHash) return stale(`interface ${short(mine.interfaceHash)}`, `interface ${short(s.interfaceHash)} (${id})`);
        if (s.codeHash !== mine.codeHash) return stale(`body ${short(mine.codeHash)}`, `body ${short(s.codeHash)} (${id})`);
        answered.add(s.module);
    }
    // The smallest scope (I5): each module named is repaired to answer what was found in it, so each has a finding cited.
    // A module named with none would be reopened for nothing, and its repair carry no finding, which the backend refuses.
    const uncited = envelope.scope === 'modules' ? envelope.changes.find(m => !answered.has(m)) : undefined;
    if (uncited !== undefined) return `a module correction answers a finding about each module it changes: none is cited about ${short(uncited)}`;
    return null;
}

/** EA_EVIDENCE_LIMIT: the records the candidate stands on alone pass the bound, and none of them may be dropped. */
export class EvidenceLimitError extends Error {
    readonly bytes: number;
    readonly limit: number;
    constructor(bytes: number, limit: number) {
        super(`EA_EVIDENCE_LIMIT ${bytes} of ${limit}; required records cannot be evicted`);
        this.name = 'EvidenceLimitError';
        this.bytes = bytes;
        this.limit = limit;
    }
}

const utf8 = new TextEncoder();

/**
 * The attempt's evidence, in memory and bounded (Q83 a). `pinned` names the records the candidate stands on now: its
 * current checks, each module's current verdicts, what reuse needs and the last static-verified candidate. Everything
 * else is history: at most `limits.history` records, the oldest dropped first, and the bytes of all kept at most
 * `limits.bytes`. Dropped records are counted, by phase.
 */
export class EvidenceStore {
    private readonly records = new Map<string, { record: CandidateEvidence; bytes: number }>();
    private readonly findings = new Map<string, string>();
    private bytes = 0;
    private next = 1;
    private readonly omitted = new Map<EvidencePhase, number>();
    readonly limits: EvidenceLimits;
    private readonly pinned: () => ReadonlySet<string>;

    constructor(limits: EvidenceLimits, pinned: () => ReadonlySet<string>) {
        this.limits = limits;
        this.pinned = pinned;
    }

    /**
     * Records a verdict, ids given here, and enforces the bounds. `pin` names the new record's id to the pinned set
     * before the bounds are applied (the machine pins it right after); a record not pinned may be evicted at once.
     */
    add(input: { subject: EvidenceSubject; phase: EvidencePhase; verdict: Verdict; producedBy: ProducedBy; refs?: string[];
        findings?: Omit<EvidenceFinding, 'id'>[] }, pin?: (id: string) => void): CandidateEvidence {
        const id = `ev-${this.next++}`;
        const all = input.findings ?? [];
        const kept = all.slice(0, MAX_RECORD_FINDINGS).map((f, i): EvidenceFinding => Object.freeze({ ...f, id: `${id}.f${i + 1}` }));
        const record: CandidateEvidence = Object.freeze({
            id,
            subject: Object.freeze({ ...input.subject }),
            phase: input.phase,
            verdict: input.verdict,
            findings: Object.freeze(kept) as EvidenceFinding[],
            omittedFindings: all.length - kept.length,
            producedBy: input.producedBy,
            refs: Object.freeze([...(input.refs ?? [])]) as string[],
        });
        const bytes = utf8.encode(JSON.stringify(record)).length;
        this.records.set(id, { record, bytes });
        for (const f of kept) this.findings.set(f.id, id);
        this.bytes += bytes;
        pin?.(id);
        this.enforce();
        return record;
    }

    /** A record still held, by id. */
    get(id: string): CandidateEvidence | null {
        return this.records.get(id)?.record ?? null;
    }

    /** A finding still held, with its record. */
    finding(id: string): { record: CandidateEvidence; finding: EvidenceFinding } | null {
        const owner = this.findings.get(id);
        const record = owner ? this.records.get(owner)?.record : undefined;
        const finding = record?.findings.find(f => f.id === id);
        return record && finding ? { record, finding } : null;
    }

    /** Every record held, oldest first. */
    list(): CandidateEvidence[] {
        return [...this.records.values()].map(r => r.record);
    }

    /** Records dropped, by phase. */
    get omissions(): Readonly<Record<string, number>> {
        return Object.freeze(Object.fromEntries(this.omitted));
    }

    get size(): { records: number; bytes: number } {
        return { records: this.records.size, bytes: this.bytes };
    }

    /** Drops history past the bounds, oldest first; fails closed when the pinned records alone pass the bytes. */
    enforce(): void {
        const pinned = this.pinned();
        const history = [...this.records.keys()].filter(id => !pinned.has(id));
        let over = history.length - this.limits.history;
        for (const id of history) {
            if (over <= 0 && this.bytes <= this.limits.bytes) break;
            this.evict(id);
            over--;
        }
        if (this.bytes > this.limits.bytes) throw new EvidenceLimitError(this.bytes, this.limits.bytes);
    }

    private evict(id: string): void {
        const held = this.records.get(id);
        if (!held) return;
        this.records.delete(id);
        for (const f of held.record.findings) this.findings.delete(f.id);
        this.bytes -= held.bytes;
        this.omitted.set(held.record.phase, (this.omitted.get(held.record.phase) ?? 0) + 1);
    }
}
