// The review of the world on the stage (EA6.1, EA6.2 and EA6.4; visual-review-design.md §5, §6, §8, §9, §9.1; Q107 to
// Q113 decided, Q112 and Q113 on 2026-11-03): after an agent world is installed, the stage is captured (two views at the
// current tick), the host's findings are measured, and the creator answers: "Looks right" (recorded, nothing spent),
// "Improve it" (their words and the findings they chose, one visual round through the candidate session: a program
// revision), or, once Q62's four gates are verified and they consented, "Review with AI": one model call that looks at
// the frames, whose issues join the host's findings for "Improve it". Plain TypeScript over injected seams (the studio's
// capture, the session, the stage, the review client, the consent's storage), so it runs under node --test.
//
// Every review names the install it looked at (its epoch, id(C), X's hash), the device generation, the tick and the
// GPU; each frame its view, size and the SHA-256 of its JPEG (I1). Its records reach the candidate session only while
// that session still holds the candidate on the stage (the session's `review` and `modelReview`), so an answer that
// arrives late is never pinned on a newer candidate (I4, EA-VR7). Only the newest review of the world on the stage can
// authorize a round or a model's review; a superseded one stays as history. The newest three reviews keep their JPEGs
// (at most 1,800,000 bytes); older ones keep their metadata, with their bytes said dropped; at most REVIEW_HISTORY reviews
// are kept, the evictions counted. A model's review sends nothing before its terms say every gate is verified, this
// browser holds the creator's consent to exactly that provider, model and policy, and the request fits the terms'
// limits (I5, P5); its verdict is advice the creator chooses from, never applied alone.

import type { CameraView } from '../runtime/camera-path';
import type { WorldBounds } from '../exec/bounds';
import type { CaptureOutcome, MissingView, ViewName } from '../exec/review-capture';
import { hostLook, lookAt, type HostLook } from '../exec/review-findings';
import { cutCodePoints } from '../contract/text';
import { requestProblem, toBase64, type ModelIssue, type ReviewAnswer, type ReviewCallBody, type ReviewConsent, type ReviewLimits, type ReviewTerms } from '../forge-client/review-client';
import { ForgeError } from '../forge-client/errors';
import { BUNDLE_FRAMES, BUNDLE_JPEG_BYTES, type CandidateSession } from './candidate';
import { COPY } from './copy';

/** Reviews whose JPEGs are kept, and the bytes they may hold together (§6's bound). */
export const KEEP_FRAMES = 3;
export const KEPT_BYTES = 1_800_000;
/** Reviews whose metadata is kept; older ones are dropped and counted. */
export const REVIEW_HISTORY = 16;
/** The JPEG bytes a downloaded bundle holds across its reviews, and a review's frames there (Q113 (a), §9.1). */
export { BUNDLE_FRAMES, BUNDLE_JPEG_BYTES } from './candidate';

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

/** A model's review over the transport (review-client.ts): its terms, and one call. */
export interface Reviewer {
    terms(signal?: AbortSignal): Promise<ReviewTerms>;
    review(body: ReviewCallBody, limits: ReviewLimits, signal: AbortSignal): Promise<ReviewAnswer>;
}

/** Where this browser keeps the creator's consent (§9's privacy gate): revocable, read again before every review. */
export interface ConsentStore {
    read(): ReviewConsent | null;
    write(consent: ReviewConsent | null): void;
    /**
     * Calls `changed` when another tab of this browser gives, changes or withdraws the consent, or the site's data is
     * cleared; returns how to stop. Absent: nothing but this page changes it.
     */
    watch?(changed: () => void): () => void;
    /** True while this page holds a consent, or a withdrawal, that its storage would not keep: the creator is told. */
    pageOnly?(): boolean;
}

/** A consent store that forgets with the page: the fallback when the browser keeps nothing. */
export function memoryConsent(): ConsentStore {
    let held: ReviewConsent | null = null;
    return { read: () => held, write: c => { held = c; } };
}

/** The part of Web Storage a consent store uses; `localStorage` in the studio, a fake in the tests. */
export interface ConsentStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Where the studio keeps the creator's consent. */
export const CONSENT_KEY = 'wexy.review.consent.v1';

/**
 * The creator's consent in a storage this browser's tabs share (§9's privacy gate). While the storage answers, its entry
 * is the whole truth: no entry is no consent, whether it was withdrawn in another tab, cleared with the site's data or
 * never given, and an entry that does not read as a consent is none (the outside review of EA6.4: a tab used to fall back
 * on its own memory of a consent another tab had withdrawn). This page's own word stands only where the storage could not
 * keep it: no storage at all, or a write the storage refused, until this page writes again or another tab's word reaches
 * it through `watch` (the newest word wins); and a withdrawal the storage refused still withdraws here. `pageOnly` says
 * so, for the creator to be told (coding principles §4: no silent fallback).
 */
export function storedConsent(storage: () => ConsentStorage | null, key = CONSENT_KEY, watch?: (changed: () => void) => () => void): ConsentStore {
    let page: ReviewConsent | null = null;
    let pageOnly = false;
    return {
        pageOnly: () => pageOnly,
        ...(watch ? {
            watch: (changed: () => void) => watch(() => {
                // Another tab wrote: its word is newer than this page's own.
                pageOnly = false;
                page = null;
                changed();
            }),
        } : {}),
        read() {
            if (pageOnly) return page;
            let text: string | null;
            try {
                const s = storage();
                if (!s) return page;
                text = s.getItem(key);
            } catch {
                return page;
            }
            if (text === null) return null;
            try {
                const v = JSON.parse(text) as Record<string, unknown> | null;
                return v && typeof v.provider === 'string' && typeof v.model === 'string' && typeof v.policyVersion === 'string'
                    ? { provider: v.provider, model: v.model, policyVersion: v.policyVersion } : null;
            } catch {
                return null;
            }
        },
        write(consent) {
            page = consent;
            try {
                const s = storage();
                if (!s) {
                    pageOnly = true;
                    return;
                }
                if (consent) s.setItem(key, JSON.stringify({ ...consent, at: new Date().toISOString() }));
                else s.removeItem(key);
                pageOnly = false;
            } catch {
                pageOnly = true;
            }
        },
    };
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
    /** A model's review (EA6.4); null or absent without a backend. */
    reviewer?(): Reviewer | null;
    /** The creator's consent; absent, it lasts as long as this object. */
    consent?: ConsentStore;
    onChange(): void;
    /** The frames whose JPEGs were dropped, so whatever shows them lets them go. */
    onDrop?(frameIds: readonly string[]): void;
}

export type ReviewStatus =
    | 'capturing' | 'ready' | 'capture-failed' | 'approved' | 'reviewing' | 'improving' | 'awaiting-run' | 'not-improved' | 'superseded';

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

/** A model's look at a review (EA6.4): its checked verdict, the record the session holds of it, and its call. */
export interface ModelLook {
    verdict: 'pass' | 'fail';
    issues: ModelIssue[];
    /** The E_v the session recorded (producedBy model). */
    evidenceId: string;
    generationId: string;
    model: string;
    promptVersion: string;
    costMicroUsd: number;
    /** The host's findings the call carried, by code. */
    sent: string[];
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
    /** A model's verdict on it (EA6.4), once one answered for it; its issues as the session holds them, in order. */
    model: ModelLook | null;
    modelFindingIds: string[];
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

/** A frame as a bundle holds it: its identity, and its JPEG as base64, or null with the reason in `omitted`. */
export interface BundledFrame extends FrameRef {
    jpeg: string | null;
}

/** A review as a downloaded bundle holds it (Q113 (a)): what was judged, how, and by whom; its frames' bytes when they fit. */
export interface BundledReview {
    id: string;
    candidate: string;
    graph: string;
    gpu: string;
    deviceGeneration: number;
    attempt: string | null;
    tick: number | null;
    seconds: number | null;
    policy: string | null;
    status: ReviewStatus;
    creator: ReviewRecord['creator'];
    improvedTo: string | null;
    host: HostLook | null;
    model: ModelLook | null;
    renderEvidenceId: string | null;
    visualEvidenceIds: string[];
    missing: MissingView[];
    frames: BundledFrame[];
}

/** The reviews section of `wexy-candidate-bundle.v3`: newest first, the bytes it holds, and every frame it left out, with why. */
export interface BundledReviews {
    records: BundledReview[];
    /** JPEG bytes held, decoded, across the records: at most `bound`. */
    jpegBytes: number;
    bound: number;
    omitted: { review: string; frame: string; why: string }[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const short = (s: string | null) => (s ? `${s.slice(0, 12)}…` : 'none');

/** The creator's sentence for a developer's diagnostic (§11): one module's words, reviewed together (copy.ts). */
export function sentenceOf(diagnostic: string): string {
    if (diagnostic.startsWith('EA_STALE_EVIDENCE') || diagnostic.startsWith('EA_STOP')) return COPY.review.stale;
    if (diagnostic.includes('EA_VISION_UNAVAILABLE')) return COPY.review.aiUnavailable;
    if (diagnostic.startsWith('EA_REVIEW_CONSENT')) return COPY.review.aiConsent;
    if (diagnostic.startsWith('EA_REVIEW_INVALID')) return COPY.review.aiInvalid;
    if (diagnostic.startsWith('EA_REVIEW_DROPPED')) return COPY.review.aiDropped;
    if (diagnostic.startsWith('EA_REVIEW_FAILED')) return COPY.review.aiFailed;
    if (diagnostic.startsWith('EA_REVIEW_BUDGET') || diagnostic.startsWith('EA_TURN_BUDGET')) return COPY.review.budget;
    if (diagnostic.startsWith('EA_REVIEW_UNAVAILABLE')) return COPY.review.noSession;
    if (diagnostic.startsWith('EA_CAPTURE_UNAVAILABLE')) return COPY.review.unavailable;
    if (diagnostic.startsWith('EA_REVIEW_SIZE')) return COPY.review.tooLarge;
    if (diagnostic.startsWith('EA_CAPTURE')) return COPY.review.captureFailed;
    if (diagnostic.startsWith('EA_REVIEW_BUSY a model')) return COPY.review.aiBusy;
    if (diagnostic.startsWith('EA_REVIEW_BUSY an improvement')) return COPY.review.improving;
    if (diagnostic.startsWith('EA_REVIEW_BUSY')) return COPY.review.busy;
    return COPY.review.notApplied;
}

/** The disclosure this build holds for a policy version, or null: a version with no text keeps the review shut. */
export function disclosureFor(policyVersion: string | null) {
    return policyVersion !== null && Object.hasOwn(COPY.disclosures, policyVersion) ? COPY.disclosures[policyVersion] : null;
}

/**
 * The terms the creator reads and consents to, as one key (the independent review of EA6.4): the panel draws its
 * disclosure again whenever it moves, and a consent is taken only for the terms whose disclosure was on screen.
 */
export function termsKey(t: Pick<ReviewTerms, 'provider' | 'model' | 'mode' | 'policyVersion'> | null): string {
    return t ? JSON.stringify([t.provider, t.model, t.mode, t.policyVersion]) : '';
}

/** The same consent: the same provider, model and policy version. */
const sameConsent = (a: ReviewConsent | null, b: ReviewConsent | null) =>
    !!a && !!b && a.provider === b.provider && a.model === b.model && a.policyVersion === b.policyVersion;

/**
 * A failed review's diagnostic as §11 names it: the client's own and the session's as they are; the backend's 413 as the
 * size it is, and its refusal of a consent to other terms (they moved between the read and the call) as a consent; any
 * other refusal or failure as EA_REVIEW_FAILED.
 */
function failedReview(d: string): string {
    if (/^(EA_|internal)/.test(d) || d.includes('EA_VISION_UNAVAILABLE')) return d;
    const tooLarge = /^too-large: ([\s\S]*)$/.exec(d);
    if (tooLarge) return tooLarge[1].startsWith('EA_REVIEW_SIZE ') ? tooLarge[1] : `EA_REVIEW_SIZE request: ${tooLarge[1]}`;
    if (d.startsWith('bad-request: consent names ')) return `EA_REVIEW_CONSENT the backend's terms moved: ${d.slice('bad-request: '.length)}`;
    return `EA_REVIEW_FAILED ${d}`;
}

/** The reviews of the stage, one studio session's: capture, the host's look, a model's look, and the creator's two answers. */
export class StageReviews {
    private readonly deps: ReviewDeps;
    private readonly list: ReviewRecord[] = [];
    private readonly bytes = new Map<string, Uint8Array>();
    private readonly consents: ConsentStore;
    private seq = 0;
    private inFlight = 0;
    private improvingNow = false;
    private reviewingNow = false;
    private loadingTerms = false;
    /**
     * The model's review under way, if any: the consent it was sent under, and its own abort, which a withdrawal here or
     * in another tab pulls (the independent review of EA6.4: a withdrawal while the call waited for its App Check token
     * stopped nothing), saying why.
     */
    private ai: { consent: ReviewConsent; controller: AbortController; why: string | null } | null = null;
    private readonly unwatch: (() => void) | null;
    /** Reviews dropped from the history, counted. */
    dropped = 0;
    /** The last refusal to capture (the stage busy), shown until the next capture. */
    refusal: { diagnostic: string; sentence: string } | null = null;
    /** What the backend last said about a model's review (EA6.4), and why it could not be read. */
    terms: ReviewTerms | null = null;
    termsError: string | null = null;

    constructor(deps: ReviewDeps) {
        this.deps = deps;
        this.consents = deps.consent ?? memoryConsent();
        // Another tab's word on the consent: a review under way that it no longer covers stops, and the panel says so now.
        this.unwatch = this.consents.watch?.(() => {
            if (this.ai && !sameConsent(this.heldConsent, this.ai.consent)) this.stopAi('the consent was withdrawn or changed in another tab');
            this.deps.onChange();
        }) ?? null;
    }

    /** Stops listening to other tabs. */
    dispose(): void {
        this.unwatch?.();
    }

    /** Pulls the review under way, if any: nothing more of it is sent, its answer is not taken, and its call stays counted. */
    private stopAi(why: string): void {
        if (!this.ai || this.ai.controller.signal.aborted) return;
        this.ai.why = why;
        this.ai.controller.abort(new DOMException(why, 'AbortError'));
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

    /** A model's review is in flight. */
    get reviewing(): boolean {
        return this.reviewingNow;
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
        return this.current(r, true);
    }

    /**
     * Why `r` cannot be answered now by a paid action, or null (§8.1): the newest review of the world on the stage, on this
     * device, answerable, with no paid action under way, and a session that holds that very candidate in that attempt,
     * with a reviser when `reviser` (a revision needs one; a model's review does not).
     */
    private current(r: ReviewRecord | null, reviser: boolean): string | null {
        if (!r) return 'EA_REVIEW_UNAVAILABLE no review yet';
        if (r !== this.latest) return `EA_STALE_EVIDENCE a newer review (${this.latest?.id}) supersedes ${r.id}`;
        const stage = this.deps.stage();
        if (!stage || stage.epoch !== r.epoch) return `EA_STALE_EVIDENCE expected the world on the stage (${short(stage?.candidate ?? null)}), the review is about ${short(r.candidate)}`;
        if (this.deps.generation() !== r.deviceGeneration) return 'EA_STALE_EVIDENCE the device was replaced since this review';
        if (this.improvingNow || r.status === 'improving') return 'EA_REVIEW_BUSY an improvement is under way';
        if (this.reviewingNow || r.status === 'reviewing') return 'EA_REVIEW_BUSY a model\'s review is under way';
        if (!ANSWERABLE.has(r.status)) return `EA_REVIEW_UNAVAILABLE the review is ${r.status}`;
        const session = this.deps.session();
        const held = session?.snapshot?.id ?? null;
        if (!session || (reviser && !session.revisable) || r.attempt === null || held !== r.candidate) {
            return reviser ? `EA_REVIEW_UNAVAILABLE stage ${short(r.candidate)}, active revisable session ${session?.revisable ? short(held) : 'none'}`
                : `EA_REVIEW_UNAVAILABLE stage ${short(r.candidate)}, active session holding ${session ? short(held) : 'none'}`;
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
            visualEvidenceIds: [], model: null, modelFindingIds: [], creator: null, status: 'capturing', improvedTo: null, error: null, sentence: null,
            bytesDropped: false,
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
        // A model's review's terms, read once a review reaches a live session, whose caller is signed in: never at load. Read
        // again while they say it is shut, so gates opened meanwhile are seen without a reload (the independent review).
        if (r.attempt !== null && !this.terms?.available && !this.loadingTerms && this.deps.reviewer?.()) void this.loadTerms();
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
     * "Improve it" (§8.1, P3, Q110): the creator's words, the host's findings they chose and (EA6.4) a model's issues they
     * chose, each by index in its list, as one visual round through the session. Refused before any call when the review
     * is not the newest of the world on the stage, the session does not hold that candidate, or the session refuses
     * (stale, empty, over its bounds, out of budget); the Head stays on the stage whatever happens.
     */
    async improve(id: string, words: string, chosen: readonly number[], chosenModel: readonly number[] = []): Promise<ReviewAct> {
        const r = this.list.find(x => x.id === id) ?? null;
        const why = this.improvable(r);
        if (why) return this.refuse(r, why);
        const review = r!;
        const bad = chosen.find(i => !Number.isInteger(i) || i < 0 || i >= review.hostFindingIds.length);
        if (bad !== undefined) return this.refuse(review, `EA_STALE_EVIDENCE finding ${bad} is not one of this review's`);
        const badModel = chosenModel.find(i => !Number.isInteger(i) || i < 0 || i >= review.modelFindingIds.length);
        if (badModel !== undefined) return this.refuse(review, `EA_STALE_EVIDENCE issue ${badModel} is not one of this review's model's`);
        const findings = [...[...new Set(chosen)].map(i => review.hostFindingIds[i]), ...[...new Set(chosenModel)].map(i => review.modelFindingIds[i])];
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

    /** The creator's consent as this browser holds it, when it is to exactly the terms' provider, model and policy; else null. */
    get consent(): ReviewConsent | null {
        const t = this.terms;
        const held = this.heldConsent;
        if (!t || !held || held.provider !== t.provider || held.model !== t.model || held.policyVersion !== t.policyVersion) return null;
        return held;
    }

    /**
     * Whatever consent this browser holds, to these terms or to others (the independent review of EA6.4): the creator can
     * withdraw it while the backend is away or its terms moved, before old terms could come back and find it standing.
     */
    get heldConsent(): ReviewConsent | null {
        try {
            return this.consents.read();
        } catch {
            return null;
        }
    }

    /** Whether this page holds a consent, or a withdrawal, that its storage would not keep: the panel says so. */
    get consentPageOnly(): boolean {
        try {
            return this.consents.pageOnly?.() ?? false;
        } catch {
            return false;
        }
    }

    /** Reads the terms again (EA6.4): before the panel offers a model's review, and before each one. */
    async loadTerms(signal?: AbortSignal): Promise<ReviewTerms | null> {
        const reviewer = this.deps.reviewer?.() ?? null;
        if (!reviewer) {
            this.terms = null;
            this.termsError = null;
            this.deps.onChange();
            return null;
        }
        this.loadingTerms = true;
        try {
            this.terms = await reviewer.terms(signal);
            this.termsError = null;
        } catch (e) {
            this.terms = null;
            this.termsError = e instanceof ForgeError ? `${e.code}: ${e.message}` : message(e);
        } finally {
            this.loadingTerms = false;
        }
        this.deps.onChange();
        return this.terms;
    }

    /**
     * Why a model's review cannot be asked for now, or null (§9, P5): the terms read and every gate verified; a disclosure
     * this build holds for their policy; the creator's consent to exactly it; then `consented` decides whether a missing
     * consent is the reason. Gates first, so Developer view always names the first gate not met.
     */
    aiGate(consented = true): string | null {
        if (!this.deps.reviewer?.()) return 'EA_VISION_UNAVAILABLE backend: there is no backend here to review with';
        const t = this.terms;
        if (!t) return `EA_VISION_UNAVAILABLE terms: ${this.termsError ?? 'not read yet'}`;
        if (!t.available) return `EA_VISION_UNAVAILABLE ${t.gate}: the backend has not verified it`;
        const disclosure = disclosureFor(t.policyVersion);
        if (!t.provider || !disclosure) return `EA_VISION_UNAVAILABLE privacy: this build holds no disclosure for policy ${t.policyVersion ?? 'none'}`;
        // Words written for another provider or mode would tell the creator something untrue (the independent review).
        if (disclosure.providerId !== t.provider || disclosure.mode !== t.mode) {
            return `EA_VISION_UNAVAILABLE privacy: the disclosure for policy ${t.policyVersion} is for ${disclosure.providerId}'s ${disclosure.mode} mode, not ${t.provider}'s ${t.mode} mode`;
        }
        if (consented && !this.consent) return `EA_REVIEW_CONSENT the creator has not allowed review by ${t.provider}'s ${t.model} under policy ${t.policyVersion}`;
        return null;
    }

    /**
     * The creator allows a model's review under the terms as they are now: bound to that provider, model and policy (§9).
     * `shown` is the key of the terms whose disclosure the creator read (`termsKey`): terms that moved since are read
     * again before anything is allowed.
     */
    giveConsent(shown?: string): ReviewAct {
        const why = this.aiGate(false);
        if (why) return this.refuse(null, why);
        const t = this.terms!;
        if (shown !== undefined && shown !== termsKey(t)) return this.refuse(null, 'EA_REVIEW_CONSENT the terms moved after they were shown: read them again');
        try {
            this.consents.write({ provider: t.provider!, model: t.model, policyVersion: t.policyVersion! });
        } catch (e) {
            return this.refuse(null, `EA_REVIEW_CONSENT this browser could not keep it: ${message(e)}`);
        }
        this.deps.onChange();
        return { ok: true };
    }

    /**
     * The creator withdraws it, to whatever terms it was given: nothing more is sent until they allow it again, and a
     * review under way is stopped where it stands (if its call already left, its answer is not taken; it stays counted).
     */
    withdrawConsent(): void {
        try {
            this.consents.write(null);
        } catch {
            // Nothing kept is nothing to withdraw; the read refuses a consent it cannot see.
        }
        this.stopAi('the creator withdrew consent');
        this.deps.onChange();
    }

    /** Why "Review with AI" cannot be pressed for `r` now, or null when it can. */
    aiReviewable(r: ReviewRecord | null = this.latest): string | null {
        const gate = this.aiGate();
        if (gate) return gate;
        // A revisable session, as for "Improve it" (§9.1): a model's issues are there to be chosen for a revision.
        const why = this.current(r, true);
        if (why) return why;
        const review = r!;
        // A world whose capture was withheld has no frame to send, and capturing again does not help (§11): its own reason,
        // which the capture says in §11's words.
        if (!review.frames.length) {
            return review.missing.find(m => m.why.startsWith('EA_CAPTURE_UNAVAILABLE '))?.why
                ?? `EA_CAPTURE_UNAVAILABLE frames: ${review.missing.map(m => `${m.name}: ${m.why}`).join('; ') || 'no view was drawn'}`;
        }
        if (review.frames.some(f => !this.bytes.has(f.id))) return 'EA_REVIEW_DROPPED the frames\' JPEGs are no longer kept: capture the world again';
        return null;
    }

    /**
     * "Review with AI" (§9.1, Q112 (a)): the newest review's frames, R, S and the host's findings the creator keeps checked
     * (by index), sent once to the model the creator consented to, through the session, which counts the call. Its verdict
     * becomes E_v by the model and its issues join the review's findings; it changes nothing on the stage.
     */
    async aiReview(id: string, chosen: readonly number[]): Promise<ReviewAct> {
        const r = this.list.find(x => x.id === id) ?? null;
        const why = this.aiReviewable(r);
        if (why) return this.refuse(r, why);
        const review = r!;
        const bad = chosen.find(i => !Number.isInteger(i) || i < 0 || i >= review.hostFindingIds.length || !review.host?.findings[i]);
        if (bad !== undefined) return this.refuse(review, `EA_STALE_EVIDENCE finding ${bad} is not one of this review's`);
        const picked = [...new Set(chosen)].sort((a, b) => a - b);
        const session = this.deps.session()!;
        const st = session.state!;
        const snapshot = session.snapshot!;
        const terms = this.terms!;
        const consent = this.consent!;
        const body: ReviewCallBody = {
            reviewId: review.id, turnId: st.turnId,
            subject: { attempt: st.attempt, revision: st.revision, programHash: st.programHash ?? '', graph: st.graph, candidate: review.candidate, module: null, interfaceHash: null, codeHash: null },
            request: { prompt: st.request.prompt, style: st.request.style, seconds: st.request.seconds },
            design: st.design as ReviewCallBody['design'],
            modules: snapshot.bodies.map(b => b.module),
            frames: review.frames.map(f => ({ id: f.id, view: f.view, tick: f.tick, seconds: f.seconds, width: f.width, height: f.height, sha256: f.sha256, jpeg: toBase64(this.bytes.get(f.id)!) })),
            hostFindings: picked.map(i => ({ code: review.host!.findings[i].code, message: cutCodePoints(review.host!.findings[i].message, 400) })),
            consent: { ...consent },
        };
        // Past the terms' limits: refused here, before any call, identity or byte (EA_REVIEW_SIZE).
        const size = requestProblem(body, terms.limits);
        if (size) return this.refuse(review, size);
        const reviewer = this.deps.reviewer!()!;
        const was = review.status;
        // Its own abort, which a withdrawal pulls: until the call leaves (after its identity and its App Check token) nothing
        // of it is sent; after, its answer is not taken.
        const ai = { consent: { ...consent }, controller: new AbortController(), why: null as string | null };
        this.ai = ai;
        this.reviewingNow = true;
        review.status = 'reviewing';
        review.error = null;
        review.sentence = null;
        this.deps.onChange();
        // Held in an object: a `let` only the callback assigns reads as its initializer after the await (gotchas).
        const got: { answer: ReviewAnswer | null } = { answer: null };
        let result: Awaited<ReturnType<CandidateSession['modelReview']>>;
        // Still the review to answer once its answer is here (§9): its consent standing, the newest review, of the world on
        // the stage, on this device.
        const still = () => (ai.why ? ai.why : this.latest !== review ? `a newer review (${this.latest?.id ?? 'none'}) supersedes ${review.id}`
            : this.deps.stage()?.epoch !== review.epoch ? 'another world is on the stage'
                : this.deps.generation() !== review.deviceGeneration ? 'the device was replaced since this review' : null);
        try {
            result = await session.modelReview({
                expected: { attempt: review.attempt!, candidate: review.candidate }, reviewId: review.id, still,
                findings: picked.map(i => review.hostFindingIds[i]),
                run: async signal => {
                    const a = await reviewer.review(body, terms.limits, AbortSignal.any([signal, ai.controller.signal]));
                    got.answer = a;
                    return { verdict: a.verdict.verdict, issues: a.verdict.issues, generationId: a.generationId, model: a.model, promptVersion: a.promptVersion, costMicroUsd: a.usage.costMicroUsd };
                },
            });
        } catch (e) {
            result = { ok: false, diagnostic: `internal: ${message(e)}`, dispatched: true };
        } finally {
            this.reviewingNow = false;
            if (this.ai === ai) this.ai = null;
        }
        if (review.status === 'reviewing') review.status = was;
        if (!result.ok) {
            // Withdrawn while it ran, here or in another tab: said as the consent it is, not as a stale review.
            if (ai.why) return this.refuse(review, `EA_REVIEW_CONSENT ${ai.why} while the review was under way: it was stopped, and its call is counted`);
            // A call that went out and failed is the model's or the backend's, not a stale review's: said as such.
            const d = failedReview(result.diagnostic);
            // The backend's terms moved between their read and the call: read them again, so the panel asks again.
            if (d.startsWith('EA_REVIEW_CONSENT the backend\'s terms moved')) void this.loadTerms();
            return this.refuse(review, d);
        }
        const a = got.answer;
        if (!a) return this.refuse(review, 'internal: the session recorded a verdict the client never answered');
        // A refusal of a press made while this one ran (a double press) said nothing about this review: cleared.
        review.error = null;
        review.sentence = null;
        review.model = {
            verdict: a.verdict.verdict, issues: a.verdict.issues.map(i => ({ ...i, modules: [...i.modules] })), evidenceId: result.evidence.id,
            generationId: a.generationId, model: a.model, promptVersion: a.promptVersion, costMicroUsd: a.usage.costMicroUsd,
            sent: body.hostFindings.map(f => f.code),
        };
        review.modelFindingIds = result.evidence.findings.map(f => f.id);
        if (!review.visualEvidenceIds.includes(result.evidence.id)) review.visualEvidenceIds.push(result.evidence.id);
        this.deps.onChange();
        return { ok: true };
    }

    /**
     * This attempt's reviews as a downloaded bundle holds them (Q113 (a), §9.1): newest first, each frame's JPEG as base64
     * while it is kept here and the bundle's BUNDLE_JPEG_BYTES allow it, at most BUNDLE_FRAMES a review; every frame left
     * out is named with why. Reviews of other attempts, a replay's among them, are not this candidate's.
     */
    bundled(attempt: string): BundledReviews {
        const out: BundledReviews = { records: [], jpegBytes: 0, bound: BUNDLE_JPEG_BYTES, omitted: [] };
        for (const r of [...this.list].reverse()) {
            if (r.attempt !== attempt) continue;
            const frames = r.frames.map((f, i): BundledFrame => {
                const bytes = this.bytes.get(f.id) ?? null;
                let why: string | null = null;
                if (i >= BUNDLE_FRAMES) why = `a review carries at most ${BUNDLE_FRAMES} frames`;
                else if (!bytes) why = 'its bytes were dropped here: only the newest three reviews keep theirs';
                else if (out.jpegBytes + bytes.length > BUNDLE_JPEG_BYTES) why = `the bundle holds at most ${BUNDLE_JPEG_BYTES} JPEG bytes, newest reviews first`;
                if (why) {
                    out.omitted.push({ review: r.id, frame: f.id, why });
                    return { ...f, camera: { ...f.camera }, content: { ...f.content }, jpeg: null };
                }
                out.jpegBytes += bytes!.length;
                return { ...f, camera: { ...f.camera }, content: { ...f.content }, jpeg: toBase64(bytes!) };
            });
            out.records.push({
                id: r.id, candidate: r.candidate, graph: r.graph, gpu: r.gpu, deviceGeneration: r.deviceGeneration, attempt: r.attempt, tick: r.tick,
                seconds: r.seconds, policy: r.policy, status: r.status, creator: r.creator, improvedTo: r.improvedTo, host: r.host ? structuredClone(r.host) : null,
                model: r.model ? structuredClone(r.model) : null, renderEvidenceId: r.renderEvidenceId, visualEvidenceIds: [...r.visualEvidenceIds],
                missing: r.missing.map(m => ({ ...m })), frames,
            });
        }
        return out;
    }

    /**
     * Q_C as a round sees it (§8.3): the rounds, the calls (settled, held and unknown together, never reset), the
     * revisions and a model's reviews, each against its limit; null without a session.
     */
    budget(): string | null {
        const st = this.deps.session()?.state;
        if (!st) return null;
        const b = st.budget, l = st.limits;
        const used = b.calls.settled + b.calls.reserved + b.calls.unknown;
        return `visual rounds ${b.visualRounds} of ${l.visualRounds} · calls ${used} of ${l.calls}${b.calls.unknown ? ` (${b.calls.unknown} unknown)` : ''}`
            + ` · revisions ${b.revisions} of ${l.revisions}, each holding ${l.revisionCalls} calls while it runs · authors ${b.authors} of ${l.authors} · repairs ${b.repairs} of ${l.repairs}`
            + ` · AI reviews ${b.reviews ?? 0} of ${l.reviews ?? 0}`;
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
