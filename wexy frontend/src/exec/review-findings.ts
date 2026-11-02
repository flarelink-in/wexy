// The host's findings about a review (EA6.1; visual-review-design.md §7): what the host measures of the world on the
// stage before anyone looks at it. A batch that dwarfs the rest (EA_SCALE), a camera inside a box or a world too large
// to frame (EA_FRAME), a frame too dark to see (EA_DARK), washed out (EA_BLOWN) or almost uniform (EA_EMPTY), and the
// probe's slow steady frame (EA_SLOW). Each is a warning: a world may be meant to float, or to be dark, so a finding is
// shown and may be chosen into an improvement, never acted on alone. Detector profile `visual-host.v1`: its thresholds
// are candidates to calibrate, not quality scores. What was not measured is said, and never passes (P2).

import { eyeOf, type CameraView } from '../runtime/camera-path';
import { frameWorld, type WorldBounds } from './bounds';
import { luminance } from './probe';
import type { MissingView, ViewName } from './review-capture';

export const DETECTOR = 'visual-host.v1';
/** EA_DARK: the framed view's brightest pixel under this (luminance, 0 to 1). */
export const DARK_MAX = 0.08;
/** EA_BLOWN: the framed view's mean luminance over this. */
export const BLOWN_MEAN = 0.92;
/** EA_EMPTY: under this fraction of a view's pixels differ from its dominant colour, in every view there is. */
export const EMPTY_FRACTION = 0.02;
/** A pixel differs from the dominant colour past this many 8-bit steps on its farthest channel (16/255). */
export const DIFFER_STEPS = 16;

/** What the detectors read of one frame: its content alone, never its bars. */
export interface FrameLook {
    view: ViewName;
    /** Luminance as probe.ts weighs it (0.2126, 0.7152, 0.0722 of the 8-bit channels), 0 to 1. */
    mean: number;
    max: number;
    /** The dominant colour, 8-bit RGB: the mean of the fullest 16-level bin's pixels. */
    dominant: [number, number, number];
    /** The fraction of pixels farther than DIFFER_STEPS from it. */
    differing: number;
    pixels: number;
}

/** A frame's content: the pixels of `content` in a `width`-wide RGBA image, row by row. */
function contentOf(rgba: Uint8Array, width: number, content: { x: number; y: number; width: number; height: number }): Uint8Array {
    const out = new Uint8Array(content.width * content.height * 4);
    for (let y = 0; y < content.height; y++) {
        const from = ((content.y + y) * width + content.x) * 4;
        out.set(rgba.subarray(from, from + content.width * 4), y * content.width * 4);
    }
    return out;
}

/** The detectors' reading of one fitted frame (§7's profile): luminance, then the dominant colour and what differs from it. */
export function lookAt(view: ViewName, rgba: Uint8Array, width: number, content: { x: number; y: number; width: number; height: number }): FrameLook {
    const px = contentOf(rgba, width, content);
    const { mean, max } = luminance(px);
    const n = Math.floor(px.length / 4);
    // RGB in 16 bins a channel; the fullest bin, the lowest index on a tie; its pixels' mean is the dominant colour.
    const counts = new Uint32Array(4096);
    const sums = new Float64Array(4096 * 3);
    for (let i = 0; i < n; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        const bin = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        counts[bin]++;
        sums[bin * 3] += r;
        sums[bin * 3 + 1] += g;
        sums[bin * 3 + 2] += b;
    }
    let best = 0;
    for (let k = 1; k < 4096; k++) if (counts[k] > counts[best]) best = k;
    const c = Math.max(1, counts[best]);
    const dominant: [number, number, number] = [sums[best * 3] / c, sums[best * 3 + 1] / c, sums[best * 3 + 2] / c];
    let differing = 0;
    for (let i = 0; i < n; i++) {
        const d = Math.max(Math.abs(px[i * 4] - dominant[0]), Math.abs(px[i * 4 + 1] - dominant[1]), Math.abs(px[i * 4 + 2] - dominant[2]));
        if (d > DIFFER_STEPS) differing++;
    }
    return { view, mean, max, dominant, differing: n ? differing / n : 0, pixels: n };
}

export interface HostLookInput {
    /** Each frame there is, read. */
    looks: readonly FrameLook[];
    /** The views not drawn, and why. */
    missing: readonly MissingView[];
    bounds: WorldBounds | null;
    /** Where the boxes come from: the captured tick, the world's preparation (before it ran), or nowhere. */
    boundsAt: { when: 'capture' | 'preparation' | 'none'; tick: number | null; error: string | null };
    /** The framed view's camera as drawn (or as it would have been); null when there is none. */
    framed: CameraView | null;
    /** The canvas's aspect, width over height. */
    aspect: number;
    /** Nodes that draw with no box (custom batches): EA_SCALE and EA_FRAME cannot see them. */
    unboxed: readonly string[];
    /** The probe's report when the world was admitted: its warnings, its GPU and the size it measured at. */
    probe: { warnings: readonly string[]; gpu: string; width: number; height: number } | null;
}

export interface HostFinding {
    code: 'EA_SCALE' | 'EA_FRAME' | 'EA_DARK' | 'EA_BLOWN' | 'EA_EMPTY' | 'EA_SLOW';
    message: string;
}

export interface HostLook {
    detector: string;
    /** `fail`: a heuristic fired; `unverified`: none fired, but something was not measured; `pass`: every check ran clean. */
    verdict: 'pass' | 'fail' | 'unverified';
    findings: HostFinding[];
    /** What was not measured: any one keeps the verdict from `pass`. */
    gaps: string[];
    /** What a reader should know of what was measured. */
    notes: string[];
}

const pct = (v: number) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
const round = (v: number) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const dims = (b: { min: number[]; max: number[] }) => b.max.map((v, i) => round(v - b.min[i])).join(' × ');

/** The host's findings and what they cover (§7), from the frames' looks, the boxes and the probe's report. Deterministic. */
export function hostLook(input: HostLookInput): HostLook {
    const findings: HostFinding[] = [];
    const gaps: string[] = [];
    const notes: string[] = [];
    const missingWhy = (name: ViewName) => input.missing.find(m => m.name === name)?.why ?? null;

    // The boxes: EA_SCALE and the world too large to frame, as frameWorld says them; the framed view's own camera inside a box.
    const bounds = input.bounds && input.bounds.batches.length ? input.bounds : null;
    const at = input.boundsAt.when === 'capture' ? `boxes read at tick ${input.boundsAt.tick ?? '?'}` : 'boxes from the world\'s preparation, before it ran';
    if (bounds) {
        if (input.boundsAt.when !== 'capture') gaps.push('the mesh boxes are the preparation\'s, not the captured tick\'s: EA_SCALE and EA_FRAME describe the world before it ran');
        const fov = input.framed?.fov ?? 45;
        for (const note of frameWorld(bounds, fov, input.aspect)?.notes ?? []) {
            if (note.startsWith('EA_SCALE ')) findings.push({ code: 'EA_SCALE', message: `${note.slice(9)} (${at})` });
            else if (note.startsWith('EA_FRAME the world is')) findings.push({ code: 'EA_FRAME', message: `${note.slice(9)} (${at})` });
        }
        if (input.framed) {
            const eye = eyeOf(input.framed);
            for (const b of bounds.batches) {
                // A bounding box, not the geometry: inside it is not inside a solid, so what blocks the view is a maybe.
                if (eye.every((v, i) => v > b.box.min[i] && v < b.box.max[i])) {
                    findings.push({ code: 'EA_FRAME', message: `the framed view's camera is inside ${b.node}'s bounding box (${dims(b.box)} units): its geometry may block the view (${at})` });
                }
            }
        }
        for (const b of bounds.batches) if (b.sampled < b.instances) notes.push(`${b.node}'s box is from ${b.sampled} of its ${b.instances} instances, sampled`);
    } else {
        gaps.push(`no mesh boxes${input.boundsAt.error ? ` (${input.boundsAt.error})` : ''}: EA_SCALE and EA_FRAME unverified`);
    }
    if (input.unboxed.length) gaps.push(`${input.unboxed.join(', ')} draw where their own code puts them, with no box: EA_SCALE and EA_FRAME do not see them`);

    // The frames: EA_DARK and EA_BLOWN on the framed view; EA_EMPTY on every view there is.
    const framed = input.looks.find(l => l.view === 'framed') ?? null;
    if (framed) {
        if (framed.max < DARK_MAX) findings.push({ code: 'EA_DARK', message: `the framed view's brightest pixel is ${pct(framed.max)} of white, under ${pct(DARK_MAX)}: the world is drawn too dark to see` });
        if (framed.mean > BLOWN_MEAN) findings.push({ code: 'EA_BLOWN', message: `the framed view's mean brightness is ${pct(framed.mean)} of white, over ${pct(BLOWN_MEAN)}: the world is washed out` });
    } else {
        gaps.push(`no framed view${missingWhy('framed') ? ` (${missingWhy('framed')})` : ''}: EA_DARK and EA_BLOWN unverified`);
    }
    if (input.looks.length) {
        if (input.looks.every(l => l.differing < EMPTY_FRACTION)) {
            const said = input.looks.map(l => `${pct(l.differing)} of the ${l.view} view's`).join(' and ');
            findings.push({ code: 'EA_EMPTY', message: `${said} pixels differ from its dominant colour, under ${pct(EMPTY_FRACTION)}: the views are almost uniform, and the subject may be missing` });
        }
        const side = input.looks.some(l => l.view === 'side');
        if (!side) gaps.push(`no side view${missingWhy('side') ? ` (${missingWhy('side')})` : ''}: EA_EMPTY judged on one view, a partial result`);
    } else {
        gaps.push('no frames: EA_EMPTY unverified');
    }

    // The probe's own report, as it was when the world was admitted: never measured again here.
    if (input.probe) {
        for (const w of input.probe.warnings) {
            if (!w.startsWith('EA_SLOW ')) continue;
            findings.push({ code: 'EA_SLOW', message: `${w.slice(8)} (the probe's measurement on ${input.probe.gpu} at ${input.probe.width}×${input.probe.height} when the world was admitted, not measured again for this review)` });
        }
    } else {
        gaps.push('no probe report: EA_SLOW unverified');
    }
    return { detector: DETECTOR, verdict: findings.length ? 'fail' : gaps.length ? 'unverified' : 'pass', findings, gaps, notes };
}
