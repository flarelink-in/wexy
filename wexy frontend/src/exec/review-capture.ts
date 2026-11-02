// The review's capture (EA6.1; visual-review-design.md §6; Q108 decided 2026-11-02): the world on the stage drawn again
// from the review's views (the framed view, and a level side view) into private targets at the canvas's size, read back,
// fitted into 768 × 432 and encoded as JPEG, with its mesh boxes read at the same tick.
//
// It never steps, resets, resizes or replaces the world (I7). Every draw, the Head's camera written back and the output
// pointed back at the screen happen in one synchronous section, inside an error checkpoint, while the stage holds still;
// every readback is submitted before that section ends, so the reads see exactly those frames and the boxes that tick.
// A world whose frame writes state it keeps (a frame-phase compute stage, a swap, a copy) is never drawn again for a
// review, because an extra frame would move it (`captureSafety`): its views are said unavailable, and its boxes, which
// a read does not change, are still read. A post chain with a temporal effect (AutoExposure's adapted exposure) is the
// same: every frame drawn moves its history, so the review's frames would change what the world on the stage shows next
// and the side view would inherit the framed view's. Withheld too (the outside review of 11-02 night; policy v2): no
// measurement can show that history unchanged for every world, and the safe direction is not to draw. A cloned world
// at time zero is not the world as it is, so it is never a fallback.

import type { ExecutionGraph, XResource } from '../contract/adapters/graph';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { CameraView } from '../runtime/camera-path';
import { worldBounds, type Framing, type WorldBounds } from './bounds';
import type { EnginePort, Handle } from './engine-port';
import type { MemoryLedger, Reservation } from './gate';
import type { AgentRuntime } from './world-runtime';

type Graph = DeepReadonly<ExecutionGraph>;

/** The size a review frame is encoded at (Q108): the source aspect-fitted and letterboxed, never stretched. */
export const REVIEW_WIDTH = 768;
export const REVIEW_HEIGHT = 432;
/** A frame's JPEG at most, and a pair's (§6). */
export const FRAME_BYTES = 300_000;
export const PAIR_BYTES = 600_000;
/** The encoder's qualities: the first, then at most two retries for a frame past FRAME_BYTES. */
export const JPEG_QUALITIES: readonly number[] = Object.freeze([0.85, 0.7, 0.55]);
/**
 * What decides which worlds are drawn again for a review, and how: recorded with every review. v2 (11-02 night): a
 * temporal post effect's history withholds the capture as state does.
 */
export const CAPTURE_POLICY = 'ea6-capture.v2';

export type ViewName = 'framed' | 'side';

export interface ReviewView {
    name: ViewName;
    camera: CameraView;
    /** What it shows, for a reader who cannot see it (the panel's alt text). */
    describes: string;
}

export interface MissingView {
    name: ViewName;
    why: string;
}

const copyView = (v: CameraView): CameraView => ({ target: [v.target[0], v.target[1], v.target[2]], distance: v.distance, azimuth: v.azimuth, polar: v.polar, fov: v.fov });

/**
 * The review's views (Q108): v1 the framed view (frameWorld's, what the creator saw first); v2 level with the subject's
 * middle, from its side: the same target and distance, the azimuth a quarter turn on, the polar a right angle. It can
 * show a world floating or sunk; it cannot prove what stands on what. Without a framing (no mesh boxes) v1 is the
 * stage's own camera and v2 is unavailable: no subject is invented.
 */
export function reviewViews(framing: Framing | null, stageCamera: CameraView): { views: ReviewView[]; missing: MissingView[] } {
    if (!framing) {
        return {
            views: [{ name: 'framed', camera: copyView(stageCamera), describes: 'The world from the stage\'s own camera: it has no mesh to frame.' }],
            missing: [{ name: 'side', why: 'no mesh boxes, so no subject to look at level' }],
        };
    }
    const v = framing.view;
    return {
        views: [
            { name: 'framed', camera: copyView(v), describes: 'The world framed on what it built, from three-quarters and a little above.' },
            { name: 'side', camera: { ...copyView(v), azimuth: v.azimuth + Math.PI / 2, polar: Math.PI / 2 }, describes: 'The world from its side, level with its middle.' },
        ],
        missing: [],
    };
}

/** Whether the world on the stage can be drawn again without changing what it holds (EA6.1's state-safety gate). */
export interface CaptureSafety {
    /** Null when a frame of it changes nothing it keeps; else why an extra frame would move it. */
    unsafe: string | null;
    /** Post effects whose history takes every frame drawn (AutoExposure): each one withholds the capture (policy v2). */
    temporal: string[];
}

/**
 * State: a buffer the world keeps from frame to frame. An uploaded one (the post chain's parameters, the camera) is
 * written whole with the same words each frame, and a pass's targets are drawn whole each frame: neither is state.
 */
const isState = (r: DeepReadonly<XResource> | undefined) => !!r && r.kind === 'buffer' && r.content !== 'upload';

/**
 * EA6.1's gate, from X alone: every write of the frame schedule to state is a reason, and so is every post chain whose
 * effects keep a history (policy v2).
 */
export function captureSafety(x: Graph): CaptureSafety {
    const resources = new Map(x.resources.map(r => [r.id, r]));
    const ops = new Map(x.operations.map(o => [o.id, o]));
    const reasons: string[] = [];
    for (const id of x.schedule.frame) {
        const op = ops.get(id);
        if (!op) continue;
        const state = [...new Set(op.accesses.filter(a => a.mode !== 'read' && isState(resources.get(a.resource))).map(a => a.resource))];
        if (!state.length) continue;
        reasons.push(op.call === 'pingpong.swap' ? `${op.node} swaps ${state.join(', ')} every frame`
            : op.kind === 'compute' ? `${op.node} writes ${state.join(', ')} every frame`
                : `${op.id} (${op.call}) writes ${state.join(', ')} every frame`);
    }
    const temporal = temporalEffects(x);
    for (const [chain, effects] of temporal) reasons.push(`${chain} keeps the history of ${effects.join(', ')}, which every frame drawn moves`);
    return {
        unsafe: reasons.length ? `${reasons.join('; ')}: an extra frame for a review would move it` : null,
        temporal: [...new Set([...temporal.values()].flat())],
    };
}

/** Each post chain's effects with a history: their targets are pairs (two allocations), named `<chain>#e<i>.<pass>`. */
function temporalEffects(x: Graph): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const op of x.operations) {
        if (op.call !== 'post.sequence') continue;
        const effects = (op.args.effects as readonly string[] | undefined) ?? [];
        for (const r of x.resources) {
            if (r.node !== op.node || r.kind !== 'texture' || r.allocations !== 2) continue;
            const at = /#e(\d+)\./.exec(r.id);
            const effect = at ? effects[Number(at[1])] : undefined;
            if (!effect) continue;
            const list = out.get(op.node) ?? [];
            if (!list.includes(effect)) list.push(effect);
            out.set(op.node, list);
        }
    }
    return out;
}

export interface Fitted {
    rgba: Uint8Array;
    /** Where the world is in the frame; the rest is bars, which the detectors never read. */
    content: { x: number; y: number; width: number; height: number };
}

/**
 * `pixels` (RGBA8, `width` × `height`, red first) aspect-fitted into `outWidth` × `outHeight`: each output pixel the mean of
 * the source pixels it covers (a box filter; the nearest one when the source is smaller), opaque; the rest opaque black
 * bars. A portrait world gets bars at its sides; nothing is stretched.
 */
export function fitInto(pixels: Uint8Array, width: number, height: number, outWidth = REVIEW_WIDTH, outHeight = REVIEW_HEIGHT): Fitted {
    const scale = Math.min(outWidth / width, outHeight / height);
    const cw = Math.max(1, Math.min(outWidth, Math.round(width * scale)));
    const ch = Math.max(1, Math.min(outHeight, Math.round(height * scale)));
    const x0 = Math.floor((outWidth - cw) / 2);
    const y0 = Math.floor((outHeight - ch) / 2);
    const out = new Uint8Array(outWidth * outHeight * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    for (let oy = 0; oy < ch; oy++) {
        const sy0 = Math.floor(oy * height / ch);
        const sy1 = Math.max(sy0 + 1, Math.floor((oy + 1) * height / ch));
        for (let ox = 0; ox < cw; ox++) {
            const sx0 = Math.floor(ox * width / cw);
            const sx1 = Math.max(sx0 + 1, Math.floor((ox + 1) * width / cw));
            let r = 0, g = 0, b = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    const s = (sy * width + sx) * 4;
                    r += pixels[s];
                    g += pixels[s + 1];
                    b += pixels[s + 2];
                }
            }
            const n = (sy1 - sy0) * (sx1 - sx0);
            const o = ((y0 + oy) * outWidth + x0 + ox) * 4;
            out[o] = Math.round(r / n);
            out[o + 1] = Math.round(g / n);
            out[o + 2] = Math.round(b / n);
        }
    }
    return { rgba: out, content: { x: x0, y: y0, width: cw, height: ch } };
}

export interface CaptureDeps {
    /** A port over the stage's engine: its offscreen targets, readbacks, renders and error checkpoints. */
    port: EnginePort;
    /** The world on the stage. */
    runtime: AgentRuntime;
    x: Graph;
    views: readonly ReviewView[];
    /** The Head's own camera written back (the viewport's writeCamera): in the same synchronous section as the draws. */
    restoreHeadCamera(): void;
    /** The stage held still (the viewport's pause): no step, frame or resize of the Head while the views are drawn. */
    hold(): () => void;
    /** Why the capture is no longer wanted (another world on the stage, the device lost, a newer review), or null. */
    stale(): string | null;
    /** The device's ledger: the targets and their readbacks reserved before they are made. */
    ledger?: MemoryLedger;
    /** JPEG bytes of opaque RGBA at `quality` (the browser's encoder; a fake in the tests). */
    encode(rgba: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array>;
    /** SHA-256 of the bytes, hex: Web Crypto's by default. */
    sha256?(bytes: Uint8Array): Promise<string>;
}

export interface CapturedFrame {
    view: ViewName;
    camera: CameraView;
    describes: string;
    /** Its draw within this capture: 1, then 2. Equal ticks and views alone never promise equal pixels or bytes. */
    renderOrdinal: number;
    sourceWidth: number;
    sourceHeight: number;
    width: number;
    height: number;
    content: Fitted['content'];
    /** The fitted pixels, for the host's detectors (review-findings.ts); dropped once judged, never kept with a review. */
    rgba: Uint8Array;
    jpeg: Uint8Array;
    quality: number;
    sha256: string;
}

export type CaptureOutcome =
    | {
        ok: true; tick: number; seconds: number; frames: CapturedFrame[]; missing: MissingView[]; temporal: string[];
        /** The mesh boxes at the captured tick; null when none could be read (`boundsError` says why, if anything failed). */
        bounds: WorldBounds | null; boundsError: string | null; policy: string;
    }
    | { ok: false; code: 'EA_CAPTURE' | 'EA_REVIEW_SIZE' | 'EA_STOP'; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** A JPEG starts FF D8 FF. */
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * One capture of the world on the stage (§6). Its views, drawn and read in one quiet section; its boxes read at the
 * same tick; each frame fitted, encoded within FRAME_BYTES (the quality lowered at most twice) and hashed. Stale after
 * any await (a newer world, a lost device, a newer review): nothing is returned but why. Whatever happens, the camera
 * and the output are back before the section ends, every target is destroyed once after its readback settles, and the
 * reservation is returned.
 */
export async function captureInstalled(deps: CaptureDeps): Promise<CaptureOutcome> {
    const { port, runtime } = deps;
    const hash = deps.sha256 ?? sha256Hex;
    const tick = runtime.steps;
    const seconds = runtime.simTime;
    const safety = captureSafety(deps.x);
    const blocked = !port.offscreenTarget || !port.readTarget || !port.destroyTarget || !port.redirectOutput || !port.checkpoint
        ? 'EA_CAPTURE_UNAVAILABLE offscreen: this engine cannot draw a world offscreen and check what it drew'
        : safety.unsafe ? `EA_CAPTURE_UNAVAILABLE state: ${safety.unsafe}`
            : runtime.isPaused ? 'EA_CAPTURE_UNAVAILABLE envelope: the world is paused past the size it was approved for'
                : null;
    const views = blocked ? [] : [...deps.views];
    const missing: MissingView[] = blocked ? deps.views.map(v => ({ name: v.name, why: blocked })) : [];
    const width = port.width;
    const height = port.height;
    let held: Reservation | null = null;
    if (views.length && deps.ledger) {
        // Colour and depth a target (4 bytes a texel each), and its readback's padded rows.
        const r = deps.ledger.reserve('a review\'s capture', views.length * (width * height * 8 + Math.ceil(width * 4 / 256) * 256 * height));
        if (typeof r === 'string') return { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE reserve: ${r}` };
        held = r;
    }
    const targets: Handle[] = [];
    const reads: Promise<Uint8Array>[] = [];
    let boundsError: string | null = null;
    let bounds: Promise<WorldBounds | null> = Promise.resolve(null);
    let step = 'hold';
    /** The section ran to its end: an error it then reports is the device's, from its draws or reads, not a throw. */
    let completed = false;
    try {
        // The quiet section: no await from the first draw to the last read submitted.
        const section = () => {
            const release = deps.hold();
            try {
                try {
                    views.forEach(v => {
                        step = `target ${v.name}`;
                        const target = port.offscreenTarget!(width, height);
                        targets.push(target);
                        step = `redirect ${v.name}`;
                        runtime.redirectOutput(target);
                        try {
                            step = `view ${v.name}`;
                            runtime.view(v.camera, seconds);
                            step = `draw ${v.name}`;
                            port.render(runtime.draw());
                        } finally {
                            runtime.redirectOutput(null);
                        }
                    });
                } finally {
                    deps.restoreHeadCamera();
                }
                step = 'read';
                for (const t of targets) {
                    const read = port.readTarget!(t);
                    // Handled at once: a read that fails while the checkpoint is still settling is never an unhandled
                    // rejection; it is judged below with the rest.
                    read.catch(() => {});
                    reads.push(read);
                }
                step = 'bounds';
                bounds = worldBounds(runtime.meshBatches(), port).catch(e => {
                    boundsError = message(e);
                    return null;
                });
                completed = true;
            } finally {
                release();
            }
        };
        // An engine that cannot check its submissions draws nothing here (blocked above); its boxes are still read, a read
        // changing nothing.
        let error: string | null;
        if (port.checkpoint) error = await port.checkpoint(section);
        else {
            try {
                section();
                error = null;
            } catch (e) {
                error = message(e);
            }
        }
        if (error !== null) return { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE ${completed ? 'draws' : step}: ${error}` };
        step = 'read';
        const settled = await Promise.allSettled(reads);
        const lost = deps.stale();
        if (lost) return { ok: false, code: 'EA_STOP', message: `EA_STOP ${lost}: the capture is discarded` };
        const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
        if (failed) return { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE read: ${message(failed.reason)}` };
        const frames: CapturedFrame[] = [];
        let total = 0;
        for (let i = 0; i < views.length; i++) {
            const v = views[i];
            step = `encode ${v.name}`;
            const fitted = fitInto((settled[i] as PromiseFulfilledResult<Uint8Array>).value, width, height);
            let jpeg: Uint8Array | null = null;
            let quality = 0;
            let size = 0;
            for (const q of JPEG_QUALITIES) {
                const bytes = await deps.encode(fitted.rgba, REVIEW_WIDTH, REVIEW_HEIGHT, q);
                const why = deps.stale();
                if (why) return { ok: false, code: 'EA_STOP', message: `EA_STOP ${why}: the capture is discarded` };
                if (!isJpeg(bytes)) return { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE encode ${v.name}: the encoder gave no JPEG` };
                size = bytes.length;
                if (size <= FRAME_BYTES) {
                    jpeg = bytes;
                    quality = q;
                    break;
                }
            }
            if (!jpeg) return { ok: false, code: 'EA_REVIEW_SIZE', message: `EA_REVIEW_SIZE ${v.name}: ${size} exceeds ${FRAME_BYTES} bytes` };
            total += jpeg.length;
            if (total > PAIR_BYTES) return { ok: false, code: 'EA_REVIEW_SIZE', message: `EA_REVIEW_SIZE frames: ${total} exceeds ${PAIR_BYTES} bytes` };
            const sha256 = await hash(jpeg);
            const why = deps.stale();
            if (why) return { ok: false, code: 'EA_STOP', message: `EA_STOP ${why}: the capture is discarded` };
            frames.push({
                view: v.name, camera: v.camera, describes: v.describes, renderOrdinal: i + 1, sourceWidth: width, sourceHeight: height,
                width: REVIEW_WIDTH, height: REVIEW_HEIGHT, content: fitted.content, rgba: fitted.rgba, jpeg, quality, sha256,
            });
        }
        step = 'bounds';
        const boxes = await bounds;
        const late = deps.stale();
        if (late) return { ok: false, code: 'EA_STOP', message: `EA_STOP ${late}: the capture is discarded` };
        return { ok: true, tick, seconds, frames, missing, temporal: safety.temporal, bounds: boxes, boundsError, policy: CAPTURE_POLICY };
    } catch (e) {
        return { ok: false, code: 'EA_CAPTURE', message: `EA_CAPTURE ${step}: ${message(e)}` };
    } finally {
        // Each target lives until its readback settled, then goes once; the reservation goes with them.
        await Promise.allSettled(reads);
        await bounds;
        for (const t of targets) {
            try {
                port.destroyTarget?.(t);
            } catch {
                // A target the device already lost is gone with it.
            }
        }
        held?.release();
    }
}
