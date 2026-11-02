// The review of the world on the stage (EA6.1 and EA6.2; visual-review-design.md §5, §6, §8; Q107 to Q110 decided
// 2026-11-02 night, Q113 held): after an agent world is installed, the stage is captured (two views at the current
// tick), the host's findings are measured, and the creator answers: "Looks right" (recorded, nothing spent) or "Improve
// it" (their words and the findings they chose, one visual round through the candidate session: a program revision).
// Plain TypeScript over injected seams (the studio's capture, the session, the stage), so it runs under node --test.
//
// Every review names the install it looked at (its epoch, id(C), X's hash), the device generation, the tick and the
// GPU; each frame its view, size and the SHA-256 of its JPEG (I1). Its records reach the candidate session only while
// that session still holds the candidate on the stage (the session's `review`), so an answer that arrives late is never
// pinned on a newer candidate (I4, EA-VR7). Only the newest review of the world on the stage can authorize a round; a
// superseded one stays as history. The newest three reviews keep their JPEGs (at most 1,800,000 bytes); older ones keep
// their metadata, with their bytes said dropped; at most REVIEW_HISTORY reviews are kept, the evictions counted. The
// bundle is unchanged (Q113 held): the creations platform will save and replay creations.

import type { CameraView } from '../runtime/camera-path';
import type { WorldBounds } from '../exec/bounds';
import type { CaptureOutcome, MissingView, ViewName } from '../exec/review-capture';
import { hostLook, lookAt, type HostLook } from '../exec/review-findings';
import type { CandidateSession } from './candidate';
import { COPY } from './copy';

/** Reviews whose JPEGs are kept, and the bytes they may hold together (§6's bound). */
export const KEEP_FRAMES = 3;
export const KEPT_BYTES = 1_800_000;
/** Reviews whose metadata is kept; older ones are dropped and counted. */
export const REVIEW_HISTORY = 16;

/** The world on the stage, as a review sees it. */
export interface StageWorld {
    /** Its install's number: each install has its own reviews. */
    epoch: number;
    /** id(C). */
    candidate: string;
    /** X's hash. */
    graph: string;
    gpu: string;
    /** The probe's report when it was admitted: its warnings, at the size it measured. */
    probe: { warnings: readonly string[]; width: number; height: number } | null;
    /** Nodes that draw with no box (custom batches). */
    unboxed: readonly string[];
}

/** What the studio's capture came to (review-capture.ts's outcome), with what the review needs beside it. */
export interface StageCapture {
    outcome: CaptureOutcome;
    /** Views the studio did not try (no subject for a side view), and why. */
    missing: readonly MissingView[];
    /** The framed view's camera, as drawn or as it would have been. */
    framed: CameraView | null;
    /** The canvas's aspect when captured. */
    aspect: number;
    /** The world's boxes from its preparation: used, and said, when none could be read at the captured tick. */
    prepared: WorldBounds | null;
}

export interface ReviewDeps {
    /** The world on the stage now; null for an h1 world or none. */
    stage(): StageWorld | null;
    /** One capture of it; `stale` says when it is no longer wanted. */
    capture(world: StageWorld, stale: () => string | null): Promise<StageCapture>;
    /** The candidate session that may record and improve; null without a backend. */
    session(): CandidateSession | null;
    /** The device's generation: it moves on a loss, and a review from before proves nothing after. */
    generation(): number;
    /** Why the stage cannot be captured now (a Run, a film or a photo holds it), or null. */
    busy?(): string | null;
    onChange(): void;
    /** The frames whose JPEGs were dropped, so whatever shows them lets them go. */
    onDrop?(frameIds: readonly string[]): void;
}

export type ReviewStatus =
    | 'capturing' | 'ready' | 'capture-failed' | 'approved' | 'improving' | 'awaiting-run' | 'not-improved' | 'superseded';

/** A frame's identity (§5's a): what it shows and how, and the hash of its bytes. The bytes live apart, bounded. */
export interface FrameRef {
    id: string;
    view: ViewName;
    describes: string;
    camera: CameraView;
    tick: number;
    seconds: number;
    renderOrdinal: number;
    deviceGeneration: number;
    sourceWidth: number;
    sourceHeight: number;
    width: number;
    height: number;
    content: { x: number; y: number; width: number; height: number };
    gpu: string;
    mime: 'image/jpeg';
    quality: number;
    bytes: number;
    sha256: string;
}

export interface ReviewRecord {
    id: string;
    epoch: number;
    candidate: string;
    graph: string;
    gpu: string;
    deviceGeneration: number;
    /** The attempt whose session holds the candidate, when the review reached it; null otherwise (a replay, another candidate). */
    attempt: string | null;
    /** Why the review did not reach a session, when it did not. */
    unbound: string | null;
    tick: number | null;
    seconds: number | null;
    frames: FrameRef[];
    missing: MissingView[];
    host: HostLook | null;
    policy: string | null;
    /** The host's findings as the session holds them, in `host.findings`' order; empty when unbound. */
    renderEvidenceId: string | null;
    hostFindingIds: string[];
    visualEvidenceIds: string[];
    /** The creator's verdict, kept here even when no session holds it. */
    creator: 'looks-right' | 'improve' | null;
    status: ReviewStatus;
    /** The candidate an improvement sealed, once it did: what Run puts on the stage next. */
    improvedTo: string | null;
    /** The developer's words for the last refusal or failure, and the creator's sentence. */
    error: string | null;
    sentence: string | null;
    /** Its JPEGs were dropped by the bound: its identities and hashes stay. */
    bytesDropped: boolean;
}

export type ReviewAct = { ok: true } | { ok: false; diagnostic: string; sentence: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const short = (s: string | null) => (s ? `${s.slice(0, 12)}…` : 'none');

/** The creator's sentence for a developer's diagnostic (§11): one module's words, reviewed together (copy.ts). */
export function sentenceOf(diagnostic: string): string {
    if (diagnostic.startsWith('EA_STALE_EVIDENCE') || diagnostic.startsWith('EA_STOP')) return COPY.review.stale;
    if (diagnostic.startsWith('EA_REVIEW_BUDGET') || diagnostic.startsWith('EA_TURN_BUDGET')) return COPY.review.budget;
    if (diagnostic.startsWith('EA_REVIEW_UNAVAILABLE')) return COPY.review.noSession;
    if (diagnostic.startsWith('EA_CAPTURE_UNAVAILABLE')) return COPY.review.unavailable;
    if (diagnostic.startsWith('EA_REVIEW_SIZE')) return COPY.review.tooLarge;
    if (diagnostic.startsWith('EA_CAPTURE')) return COPY.review.captureFailed;
    if (diagnostic.startsWith('EA_REVIEW_BUSY an improvement')) return COPY.review.improving;
    if (diagnostic.startsWith('EA_REVIEW_BUSY')) return COPY.review.busy;
    return COPY.review.notApplied;
}

/** The reviews of the stage, one studio session's: capture, the host's look, and the creator's two answers. */
export class StageReviews {
    private readonly deps: ReviewDeps;
    private readonly list: ReviewRecord[] = [];
    private readonly bytes = new Map<string, Uint8Array>();
    private seq = 0;
    private inFlight = 0;
    private improvingNow = false;
    /** Reviews dropped from the history, counted. */
    dropped = 0;
    /** The last refusal to capture (the stage busy), shown until the next capture. */
    refusal: { diagnostic: string; sentence: string } | null = null;

    constructor(deps: ReviewDeps) {
        this.deps = deps;
    }

    /** Every review kept, oldest first. */
    get records(): readonly ReviewRecord[] {
        return this.list;
    }

    /** The newest review, whatever world it looked at. */
    get latest(): ReviewRecord | null {
        return this.list.at(-1) ?? null;
    }

    get capturing(): boolean {
        return this.inFlight > 0;
    }

    get improving(): boolean {
        return this.improvingNow;
    }

    /** A frame's JPEG while it is kept; null once dropped. */
    bytesOf(frameId: string): Uint8Array | null {
        return this.bytes.get(frameId) ?? null;
    }

    /** JPEG bytes kept, over every review. */
    get keptBytes(): number {
        let n = 0;
        for (const b of this.bytes.values()) n += b.length;
        return n;
    }

    /**
     * A world was put on the stage (or none: an h1 world): every review of another install is superseded, and the new one
     * is captured at once (§6: "right after EA5 commits C").
     */
    installed(world: StageWorld | null): void {
        for (const r of this.list) if (r.epoch !== world?.epoch && !FINAL.has(r.status)) r.status = 'superseded';
        this.refusal = null;
        this.deps.onChange();
        if (world) void this.capture();
    }

    /**
     * Why "Improve it" cannot be pressed for `r` now, or null when it can (§8.1): the newest review of the world on the
     * stage, ready, on this device, and a session with a reviser holding that very candidate.
     */
    improvable(r: ReviewRecord | null = this.latest): string | null {
        if (!r) return 'EA_REVIEW_UNAVAILABLE no review yet';
        if (r !== this.latest) return `EA_STALE_EVIDENCE a newer review (${this.latest?.id}) supersedes ${r.id}`;
        const stage = this.deps.stage();
        if (!stage || stage.epoch !== r.epoch) return `EA_STALE_EVIDENCE expected the world on the stage (${short(stage?.candidate ?? null)}), the review is about ${short(r.candidate)}`;
        if (this.deps.generation() !== r.deviceGeneration) return 'EA_STALE_EVIDENCE the device was replaced since this review';
        if (this.improvingNow || r.status === 'improving') return 'EA_REVIEW_BUSY an improvement is under way';
        if (!ANSWERABLE.has(r.status)) return `EA_REVIEW_UNAVAILABLE the review is ${r.status}`;
        const session = this.deps.session();
        const held = session?.snapshot?.id ?? null;
        if (!session || !session.revisable || r.attempt === null || held !== r.candidate) {
            return `EA_REVIEW_UNAVAILABLE stage ${short(r.candidate)}, active revisable session ${session?.revisable ? short(held) : 'none'}`;
        }
        if (session.state?.attempt !== r.attempt) return `EA_STALE_EVIDENCE expected attempt ${session.state?.attempt ?? 'none'}, the review is about ${r.attempt}`;
        return null;
    }

    /** "Capture again" (§6), or the capture after an install: the newest review of the world on the stage. */
    async capture(): Promise<ReviewRecord | null> {
        const world = this.deps.stage();
        if (!world) return null;
        const busy = this.deps.busy?.() ?? null;
        if (busy) {
            const diagnostic = `EA_REVIEW_BUSY ${busy}`;
            this.refusal = { diagnostic, sentence: sentenceOf(diagnostic) };
            this.deps.onChange();
            return null;
        }
        this.refusal = null;
        const generation = this.deps.generation();
        const r: ReviewRecord = {
            id: `review-${++this.seq}`, epoch: world.epoch, candidate: world.candidate, graph: world.graph, gpu: world.gpu, deviceGeneration: generation,
            attempt: null, unbound: null, tick: null, seconds: null, frames: [], missing: [], host: null, policy: null, renderEvidenceId: null, hostFindingIds: [],
            visualEvidenceIds: [], creator: null, status: 'capturing', improvedTo: null, error: null, sentence: null, bytesDropped: false,
        };
        // A newer review supersedes the one before it, of whatever world.
        for (const old of this.list) if (!FINAL.has(old.status)) old.status = 'superseded';
        this.push(r);
        this.inFlight++;
        this.deps.onChange();
        const stale = () => (this.latest !== r ? 'a newer review' : this.deps.stage()?.epoch !== world.epoch ? 'another world is on the stage'
            : this.deps.generation() !== generation ? 'the device was replaced' : null);
        let got: StageCapture;
        try {
            got = await this.deps.capture(world, stale);
        } catch (e) {
            got = { outcome: { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE ${message(e)}` }, missing: [], framed: null, aspect: 1, prepared: null };
        } finally {
            this.inFlight--;
        }
        // Superseded meanwhile (a newer review, another world, another device): said, and nothing of it applied.
        const gone = stale();
        if (gone || (!got.outcome.ok && got.outcome.code === 'EA_STOP')) {
            r.status = 'superseded';
            r.error = gone ? `EA_STOP ${gone}: the capture is discarded` : (got.outcome as { message: string }).message;
            this.deps.onChange();
            return r;
        }
        if (!got.outcome.ok) {
            r.status = 'capture-failed';
            r.error = got.outcome.message;
            r.sentence = sentenceOf(got.outcome.message);
            this.deps.onChange();
            return r;
        }
        const o = got.outcome;
        r.tick = o.tick;
        r.seconds = o.seconds;
        r.policy = o.policy;
        r.missing = [...got.missing, ...o.missing];
        // The host's look: each frame's content read, then the frames' pixels dropped; only the JPEG and its hash stay.
        const looks = o.frames.map(f => lookAt(f.view, f.rgba, f.width, f.content));
        const boundsAt = o.bounds ? { when: 'capture' as const, tick: o.tick, error: null }
            : got.prepared ? { when: 'preparation' as const, tick: null, error: o.boundsError }
                : { when: 'none' as const, tick: null, error: o.boundsError };
        r.host = hostLook({
            looks, missing: r.missing, bounds: o.bounds ?? got.prepared, boundsAt, framed: got.framed, aspect: got.aspect, unboxed: world.unboxed,
            probe: world.probe ? { ...world.probe, gpu: world.gpu } : null,
        });
        r.frames = o.frames.map(f => ({
            id: `${r.id}.v${f.renderOrdinal}`, view: f.view, describes: f.describes, camera: f.camera, tick: o.tick, seconds: o.seconds, renderOrdinal: f.renderOrdinal,
            deviceGeneration: generation, sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight, width: f.width, height: f.height, content: f.content, gpu: world.gpu,
            mime: 'image/jpeg', quality: f.quality, bytes: f.jpeg.length, sha256: f.sha256,
        }));
        o.frames.forEach((f, i) => this.bytes.set(r.frames[i].id, f.jpeg));
        this.bind(r);
        r.status = 'ready';
        this.bound();
        this.deps.onChange();
        return r;
    }

    /** "Looks right" (§8.1): the creator's approval of this review, recorded; nothing spent; no detector's record erased. */
    looksRight(id: string): ReviewAct {
        const r = this.list.find(x => x.id === id) ?? null;
        const why = !r ? 'EA_STALE_EVIDENCE no such review' : r !== this.latest ? `EA_STALE_EVIDENCE a newer review supersedes ${id}`
            : !ANSWERABLE.has(r.status) || r.status === 'approved' ? `EA_REVIEW_UNAVAILABLE the review is ${r.status}`
                : this.deps.stage()?.epoch !== r.epoch ? 'EA_STALE_EVIDENCE another world is on the stage' : null;
        if (why) return this.refuse(r, why);
        const review = r!;
        if (review.attempt !== null) {
            const session = this.deps.session();
            const done = session?.review({ expected: { attempt: review.attempt, candidate: review.candidate }, phase: 'visual', verdict: 'pass', producedBy: 'creator' });
            if (!done || !done.ok) return this.refuse(review, done ? done.diagnostic : 'EA_REVIEW_UNAVAILABLE the session is gone');
            review.visualEvidenceIds.push(done.evidence.id);
        }
        review.creator = 'looks-right';
        review.status = 'approved';
        review.error = null;
        review.sentence = null;
        this.deps.onChange();
        return { ok: true };
    }

    /**
     * "Improve it" (§8.1, P3, Q110): the creator's words and the host's findings they chose (by index in the review's
     * findings), one visual round through the session. Refused before any call when the review is not the newest of the
     * world on the stage, the session does not hold that candidate, or the session refuses (stale, empty, over its bounds,
     * out of budget); the Head stays on the stage whatever happens.
     */
    async improve(id: string, words: string, chosen: readonly number[]): Promise<ReviewAct> {
        const r = this.list.find(x => x.id === id) ?? null;
        const why = this.improvable(r);
        if (why) return this.refuse(r, why);
        const review = r!;
        const bad = chosen.find(i => !Number.isInteger(i) || i < 0 || i >= review.hostFindingIds.length);
        if (bad !== undefined) return this.refuse(review, `EA_STALE_EVIDENCE finding ${bad} is not one of this review's`);
        const findings = [...new Set(chosen)].map(i => review.hostFindingIds[i]);
        const session = this.deps.session()!;
        const was = review.status;
        this.improvingNow = true;
        review.status = 'improving';
        review.error = null;
        review.sentence = null;
        this.deps.onChange();
        let result: Awaited<ReturnType<CandidateSession['improve']>>;
        try {
            result = await session.improve({ expected: { attempt: review.attempt!, candidate: review.candidate }, words, findings });
        } catch (e) {
            result = { ok: false, diagnostic: `internal: ${message(e)}` };
        } finally {
            this.improvingNow = false;
        }
        // A newer review (another world put on the stage meanwhile) keeps its place: this one says what came of its round.
        const current = review.status === 'improving';
        if (!result.ok) {
            if (current) review.status = was;
            return this.refuse(review, result.diagnostic);
        }
        review.creator = 'improve';
        const st = result.state;
        // The creator's verdict the session recorded: the newest visual record about this candidate.
        const verdict = [...st.evidence].reverse().find(e => e.phase === 'visual' && e.subject.candidate === review.candidate && e.producedBy === 'creator');
        if (verdict && !review.visualEvidenceIds.includes(verdict.id)) review.visualEvidenceIds.push(verdict.id);
        // The round's own account; a session that cannot give one is read from its state.
        const round = result.round ?? { improved: st.phase === 'static-verified' && !!st.id && st.id !== review.candidate, stop: st.stop, restored: false };
        if (round.improved) {
            if (current) review.status = 'awaiting-run';
            review.improvedTo = st.id;
        } else {
            if (current) review.status = 'not-improved';
            review.error = `${round.stop?.diagnostic ?? `the round ended ${st.phase}`}${round.restored ? '; the session is back on the candidate on the stage' : ''}`;
            // The review's own words: the world stays on the stage, the developer's line says why (EA-VR11 showed the
            // candidate's "setup problem" sentence reading oddly here, for a revision that asked a question).
            review.sentence = round.stop?.scope === 'budget' ? COPY.review.budget : COPY.review.notApplied;
        }
        this.deps.onChange();
        return { ok: true };
    }

    /**
     * Q_C as a round sees it (§8.3): the rounds, the calls (settled, held and unknown together, never reset) and the
     * revisions, each against its limit; null without a session.
     */
    budget(): string | null {
        const st = this.deps.session()?.state;
        if (!st) return null;
        const b = st.budget, l = st.limits;
        const used = b.calls.settled + b.calls.reserved + b.calls.unknown;
        return `visual rounds ${b.visualRounds} of ${l.visualRounds} · calls ${used} of ${l.calls}${b.calls.unknown ? ` (${b.calls.unknown} unknown)` : ''}`
            + ` · revisions ${b.revisions} of ${l.revisions}, each holding ${l.revisionCalls} calls while it runs · authors ${b.authors} of ${l.authors} · repairs ${b.repairs} of ${l.repairs}`;
    }

    private refuse(r: ReviewRecord | null, diagnostic: string): ReviewAct {
        const sentence = sentenceOf(diagnostic);
        if (r) {
            r.error = diagnostic;
            r.sentence = sentence;
        }
        this.deps.onChange();
        return { ok: false, diagnostic, sentence };
    }

    /** The host's look recorded in the session when, and only when, it still holds the candidate on the stage. */
    private bind(r: ReviewRecord): void {
        const session = this.deps.session();
        const st = session?.state ?? null;
        if (!session || !st || session.snapshot?.id !== r.candidate) {
            r.unbound = !session ? 'no candidate session here' : `the session holds ${short(session.snapshot?.id ?? null)}, the stage ${short(r.candidate)}`;
            return;
        }
        const host = r.host!;
        const done = session.review({
            expected: { attempt: st.attempt, candidate: r.candidate }, phase: 'render', verdict: host.verdict, producedBy: 'device',
            findings: host.findings.map(f => ({ code: f.code, message: f.message, severity: 'warning' as const })),
        });
        if (!done.ok) {
            r.unbound = done.diagnostic;
            return;
        }
        r.attempt = st.attempt;
        r.renderEvidenceId = done.evidence.id;
        r.hostFindingIds = done.evidence.findings.map(f => f.id);
    }

    private push(r: ReviewRecord): void {
        this.list.push(r);
        while (this.list.length > REVIEW_HISTORY) {
            const old = this.list.shift()!;
            this.drop(old);
            this.dropped++;
        }
    }

    /** The JPEG bound: the newest KEEP_FRAMES reviews with frames, and at most KEPT_BYTES; older ones' bytes dropped. */
    private bound(): void {
        const withBytes = this.list.filter(r => r.frames.some(f => this.bytes.has(f.id)));
        let kept = 0;
        let reviews = 0;
        for (let i = withBytes.length - 1; i >= 0; i--) {
            const r = withBytes[i];
            const size = r.frames.reduce((n, f) => n + (this.bytes.get(f.id)?.length ?? 0), 0);
            if (reviews < KEEP_FRAMES && kept + size <= KEPT_BYTES) {
                reviews++;
                kept += size;
            } else this.drop(r);
        }
    }

    private drop(r: ReviewRecord): void {
        const ids = r.frames.map(f => f.id).filter(id => this.bytes.delete(id));
        if (ids.length) {
            r.bytesDropped = true;
            this.deps.onDrop?.(ids);
        }
    }
}

/** A review in one of these is settled: a later review or install no longer marks it superseded. */
const FINAL: ReadonlySet<ReviewStatus> = new Set(['capture-failed', 'approved', 'awaiting-run', 'not-improved', 'superseded']);
/**
 * A review the creator may still answer: ready, approved (they may change their mind), or not improved, once its session
 * is back on the candidate on the stage (a restore after the round; `improvable` checks the session holds it).
 */
const ANSWERABLE: ReadonlySet<ReviewStatus> = new Set(['ready', 'approved', 'not-improved']);
