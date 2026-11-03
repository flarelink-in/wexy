// A saved attempt replayed in the studio (11-02; the user: "add it as preset or link so i could verify visually the
// outputs"): the bundle Developer view downloads (`wexy-candidate-bundle.v2`, candidate.ts) or a live-candidate
// fixture, its program and bodies sealed again by this host and each body compiled by L3 on this device. Nothing in
// the file is trusted. The seal resolves, checks and derives from W itself and recomputes every hash; each body must be
// the text its codeHash names, written for the interface this host derives; a bundle's versions must be this build's.
// What follows is the studio's own Run: the developer's press, the gate, eligibility, the probe and the first frame,
// as for any candidate. No model is called and nothing is spent.
//
// Since Q113 (a) (2026-11-03, visual-review-design.md §9.1) a bundle may be `wexy-candidate-bundle.v3`, which also holds
// the reviews of the stage: what was judged, by the host, the creator and a model, and the frames they looked at. Those
// are read as strictly as the rest: at most BUNDLE_REVIEWS reviews and two frames each, at most 600,000 JPEG bytes in
// all, and each JPEG shown only when its SHA-256 is the one its frame names; anything else is left out and said.

import { BODY_CHECKER, checkBody, compileBody, type CompiledBody, type ModuleCompiler } from '../contract/adapters/bodies';
import { ABI_VERSION } from '../contract/adapters/interfaces';
import { resolveProgram } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import { BUNDLE_FRAMES, BUNDLE_JPEG_BYTES, BUNDLE_REVIEWS, CANDIDATE_BUNDLE, CANDIDATE_BUNDLE_V2 } from './candidate';
import { sealCandidate, type SealedCandidate } from './snapshot';

export interface Replay {
    /** The attempt it came from, as the file names it. */
    attempt: string;
    /** The idea it was written for, when the file holds one. */
    prompt: string | null;
    snapshot: DeepReadonly<SealedCandidate>;
    /** Its file's format: v2 holds no reviews. */
    format: string;
    /** What a v3 bundle's reviews judged, newest first (Q113 (a)); none for v2. */
    reviews: SavedReview[];
    /** What of them was left out, and why: a frame not in the file, past the bound, or not the bytes its hash names. */
    notes: string[];
}

/** A frame a saved review looked at: its identity, and its JPEG when the file held it and it is the one its hash names. */
export interface SavedFrame {
    id: string;
    view: string;
    describes: string;
    width: number;
    height: number;
    sha256: string;
    bytes: Uint8Array | null;
}

/** A saved review: which candidate it judged, at which tick, and what the host, the creator and a model said. */
export interface SavedReview {
    id: string;
    candidate: string;
    /** It judged the candidate this replay seals (else an earlier candidate of the attempt). */
    ofThis: boolean;
    tick: number | null;
    gpu: string;
    status: string;
    creator: string | null;
    host: { verdict: string; findings: { code: string; message: string }[] } | null;
    model: { verdict: string; model: string; issues: { kind: string; severity: string; sentence: string }[] } | null;
    frames: SavedFrame[];
}

export type Replayed = { ok: true; replay: Replay } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (v: unknown) => (typeof v === 'string' ? (v.length > 16 ? `${v.slice(0, 12)}…` : v) : String(v));

/** A saved attempt's text, sealed by this host: the sealed candidate, or why not, in a developer's words. */
export async function sealSaved(text: string): Promise<Replayed> {
    let file: unknown;
    try {
        file = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: `the file is not JSON: ${(e as Error).message}` };
    }
    if (!isObject(file)) return { ok: false, reason: 'the file is not a saved attempt' };
    if (file.format !== undefined && file.format !== CANDIDATE_BUNDLE && file.format !== CANDIDATE_BUNDLE_V2) {
        return { ok: false, reason: `the file is ${String(file.format)}, not ${CANDIDATE_BUNDLE} or ${CANDIDATE_BUNDLE_V2}` };
    }
    const nodes = isObject(file.program) ? file.program.nodes : undefined;
    if (!Array.isArray(nodes)) return { ok: false, reason: 'the file holds no program (program.nodes)' };
    const modules = Array.isArray(file.modules) ? file.modules : [];
    if (!modules.every(m => isObject(m) && typeof m.module === 'string' && typeof m.body === 'string' && typeof m.interfaceHash === 'string')) {
        return { ok: false, reason: 'the file\'s modules are not each {module, interfaceHash, body}' };
    }
    const resolved = await resolveProgram(nodes);
    if (!resolved.ok) {
        const d = resolved.diagnostics[0];
        return { ok: false, reason: `its program does not resolve here${d ? `: ${d.code} ${d.path}: ${d.message}` : ''}` };
    }
    const x = resolved.graph;
    // A downloaded bundle names what it was written against; a replay is of that attempt, so they must be this build's.
    if (isObject(file.versions)) {
        const here: Record<string, string> = { bundle: x.identity.bundleHash, manifest: x.identity.manifestHash, abi: ABI_VERSION, checker: BODY_CHECKER };
        for (const [k, want] of Object.entries(here)) {
            if (file.versions[k] !== want) return { ok: false, reason: `it was written against another ${k} (${short(file.versions[k])}); this build's is ${short(want)}` };
        }
    }
    const sealed = await sealCandidate({
        attempt: typeof file.attempt === 'string' ? file.attempt : 'replay',
        revision: Number.isSafeInteger(file.revision) ? file.revision as number : 0,
        program: nodes,
        graph: x.hash,
        bodies: (modules as Record<string, unknown>[]).map(m => ({
            module: m.module as string, interfaceHash: m.interfaceHash as string, body: m.body as string,
            ...(typeof m.codeHash === 'string' ? { codeHash: m.codeHash } : {}),
        })),
    });
    if (!sealed.ok) return { ok: false, reason: `the host does not seal it: ${sealed.reason}` };
    const request = isObject(file.request) ? file.request : null;
    const saved = file.format === CANDIDATE_BUNDLE ? await savedReviews(file.reviews, sealed.snapshot.id) : { reviews: [], notes: [] };
    return {
        ok: true,
        replay: {
            attempt: typeof file.attempt === 'string' ? file.attempt : 'a fixture',
            prompt: request && typeof request.prompt === 'string' ? request.prompt.trim() : null,
            snapshot: sealed.snapshot,
            format: typeof file.format === 'string' ? file.format : 'a fixture',
            reviews: saved.reviews,
            notes: saved.notes,
        },
    };
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].slice(0, max).join('') : '');
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * A v3 bundle's reviews, read strictly (nothing in the file is trusted): at most BUNDLE_REVIEWS of them and BUNDLE_FRAMES
 * frames each, every string cut to its bound, and each JPEG kept only when it is standard base64, within the bundle's
 * BUNDLE_JPEG_BYTES, and the bytes its frame's SHA-256 names. Whatever is left out is said in `notes`.
 */
async function savedReviews(section: unknown, sealed: string): Promise<{ reviews: SavedReview[]; notes: string[] }> {
    const notes: string[] = [];
    if (!isObject(section) || !Array.isArray(section.records)) return { reviews: [], notes: ['the file\'s reviews are not a v3 reviews section: none shown'] };
    const records = section.records.filter(isObject);
    if (records.length > BUNDLE_REVIEWS) notes.push(`the file holds ${records.length} reviews; the newest ${BUNDLE_REVIEWS} are shown`);
    let held = 0;
    const reviews: SavedReview[] = [];
    for (const r of records.slice(0, BUNDLE_REVIEWS)) {
        const id = text(r.id, 64) || 'a review';
        const frames: SavedFrame[] = [];
        const list = Array.isArray(r.frames) ? r.frames.filter(isObject) : [];
        if (list.length > BUNDLE_FRAMES) notes.push(`${id}: ${list.length} frames; a review carries at most ${BUNDLE_FRAMES}`);
        for (const f of list.slice(0, BUNDLE_FRAMES)) {
            const frame: SavedFrame = {
                id: text(f.id, 64), view: text(f.view, 16), describes: text(f.describes, 200), width: Number.isSafeInteger(f.width) ? f.width as number : 0,
                height: Number.isSafeInteger(f.height) ? f.height as number : 0, sha256: typeof f.sha256 === 'string' && HEX64.test(f.sha256) ? f.sha256 : '', bytes: null,
            };
            frames.push(frame);
            if (f.jpeg === null || f.jpeg === undefined) continue;
            if (typeof f.jpeg !== 'string' || !BASE64.test(f.jpeg) || !frame.sha256) {
                notes.push(`${id}: ${frame.id || 'a frame'} is not standard base64 with its hash: not shown`);
                continue;
            }
            const size = Math.floor(f.jpeg.length / 4) * 3 - (f.jpeg.endsWith('==') ? 2 : f.jpeg.endsWith('=') ? 1 : 0);
            if (held + size > BUNDLE_JPEG_BYTES) {
                notes.push(`${id}: ${frame.id} is past the bundle's ${BUNDLE_JPEG_BYTES} JPEG bytes: not shown`);
                continue;
            }
            const bytes = Uint8Array.from(atob(f.jpeg), c => c.charCodeAt(0));
            if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== frame.sha256) {
                notes.push(`${id}: ${frame.id} is not the image its hash names: not shown`);
                continue;
            }
            held += bytes.length;
            frame.bytes = bytes;
        }
        const host = isObject(r.host) ? r.host : null;
        const model = isObject(r.model) ? r.model : null;
        const candidate = text(r.candidate, 64);
        reviews.push({
            id, candidate, ofThis: candidate === sealed, tick: Number.isSafeInteger(r.tick) ? r.tick as number : null, gpu: text(r.gpu, 120), status: text(r.status, 32),
            creator: typeof r.creator === 'string' ? text(r.creator, 32) : null,
            host: host ? {
                verdict: text(host.verdict, 16),
                findings: (Array.isArray(host.findings) ? host.findings.filter(isObject) : []).slice(0, 32).map(x => ({ code: text(x.code, 40), message: text(x.message, 400) })),
            } : null,
            model: model ? {
                verdict: text(model.verdict, 16), model: text(model.model, 64),
                issues: (Array.isArray(model.issues) ? model.issues.filter(isObject) : []).slice(0, 32).map(x => ({ kind: text(x.kind, 32), severity: text(x.severity, 16), sentence: text(x.sentence, 400) })),
            } : null,
            frames,
        });
    }
    const omitted = Array.isArray(section.omitted) ? section.omitted.filter(isObject) : [];
    for (const o of omitted.slice(0, 32)) notes.push(`${text(o.review, 64)}: ${text(o.frame, 64)} was left out when saved: ${text(o.why, 200)}`);
    return { reviews, notes };
}

/** Each body of a sealed replay compiled by L3 on this device, checked first as the candidate session checks it. */
export async function compileSaved(snapshot: DeepReadonly<SealedCandidate>, compiler: ModuleCompiler): Promise<DeepReadonly<CompiledBody>[]> {
    const out: DeepReadonly<CompiledBody>[] = [];
    for (const b of snapshot.bodies) {
        const iface = snapshot.interfaces.find(i => i.module === b.module)!;
        out.push(await compileBody(iface, await checkBody(iface, b.body), compiler));
    }
    return out;
}
