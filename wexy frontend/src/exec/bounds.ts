// A world's extent once its init has run (11-02, the castle's render): each mesh batch's box in world space, from its
// geometry's own box and its instances as written (null-graph's stock vertex shader scales each vertex, rotates it by
// the instance's quaternion, then moves it), read back from the device before commit. The studio frames its camera on
// it, and Developer view is told when one batch dwarfs the rest of the world (a primitive's size and its instances'
// scale multiply, which the castle doubled) or when the camera would start inside one. Custom batches draw where their
// own code puts them, so they have no box here, and fullscreen passes have none.

import { eyeOf, type CameraView } from '../runtime/camera-path';
import type { Handle } from './engine-port';

export type Vec3 = [number, number, number];
export interface Box { min: Vec3; max: Vec3 }
export interface BatchBox { node: string; box: Box; instances: number; sampled: number }
export interface WorldBounds { batches: BatchBox[] }

/** A mesh batch as the runtime holds it: its instances' buffer and count, and its geometry. */
export interface MeshBatchState { node: string; buffer: Handle; instances: number; geometry: Handle }

/** What the bounds read from the engine: an instance buffer's bytes, a geometry's own box. */
export interface BoundsPort {
    readBuffer?(buffer: Handle, bytes: number, offset?: number): Promise<ArrayBuffer>;
    geometryBox?(geometry: Handle): Box | null;
}

/** Instances read from a batch: all of them up to this, else this many in evenly spaced runs across it. */
export const BOUNDS_SAMPLE = 4096;
const RUNS = 16;
const INSTANCE_FLOATS = 14;
/** An agent world's camera reaches this far (null-graph-port's camera: near 0.1, far 200). */
export const CAMERA_REACH = 200;
/** A batch this many times the rest of the world, side for side, is said in Developer view. */
export const DWARFS = 20;

const size = (b: Box): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const largest = (b: Box) => Math.max(...size(b));
const union = (a: Box | null, b: Box): Box => (a === null ? { min: [...b.min], max: [...b.max] } : {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});
const round = (v: number) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const dims = (b: Box) => size(b).map(round).join(' × ');

/** A geometry's own box: the positions of its vertices, the first three floats of each. */
export function vertexBox(vertices: ArrayLike<number>, strideFloats: number): Box | null {
    let box: Box | null = null;
    for (let i = 0; i + 2 < vertices.length; i += strideFloats) {
        const p: Vec3 = [vertices[i], vertices[i + 1], vertices[i + 2]];
        if (!p.every(Number.isFinite)) continue;
        box = union(box, { min: p, max: p });
    }
    return box;
}

/** null-graph's rotateVector, quaternion (x, y, z, w): exactly what the stock shader does, unit or not. */
function rotate(v: Vec3, q: readonly number[]): Vec3 {
    const [qx, qy, qz, qw] = q;
    const t: Vec3 = [2 * (qy * v[2] - qz * v[1]), 2 * (qz * v[0] - qx * v[2]), 2 * (qx * v[1] - qy * v[0])];
    return [
        v[0] + qw * t[0] + (qy * t[2] - qz * t[1]),
        v[1] + qw * t[1] + (qz * t[0] - qx * t[2]),
        v[2] + qw * t[2] + (qx * t[1] - qy * t[0]),
    ];
}

/**
 * One instance's box in world space: its geometry's box scaled, rotated and moved as the stock shader moves each
 * vertex. The rotated box's own box, so never smaller than what is drawn. Null for an instance scaled to nothing
 * (one never written), which draws nothing.
 */
export function instanceBox(local: Box, record: ArrayLike<number>, at: number): Box | null {
    const p: Vec3 = [record[at + 1], record[at + 2], record[at + 3]];
    const q = [record[at + 4], record[at + 5], record[at + 6], record[at + 7]];
    const s: Vec3 = [record[at + 8], record[at + 9], record[at + 10]];
    if (![...p, ...q, ...s].every(Number.isFinite) || Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])) < 1e-9) return null;
    const c: Vec3 = [0, 1, 2].map(i => (local.min[i] + local.max[i]) / 2 * s[i]) as Vec3;
    const h: Vec3 = [0, 1, 2].map(i => (local.max[i] - local.min[i]) / 2 * Math.abs(s[i])) as Vec3;
    // The linear map's columns are the rotated axes; the box's half extents through it, axis by axis.
    const cols = [rotate([1, 0, 0], q), rotate([0, 1, 0], q), rotate([0, 0, 1], q)];
    const center = rotate(c, q).map((v, i) => v + p[i]) as Vec3;
    const half = [0, 1, 2].map(i => Math.abs(cols[0][i]) * h[0] + Math.abs(cols[1][i]) * h[1] + Math.abs(cols[2][i]) * h[2]) as Vec3;
    return { min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]], max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]] };
}

/**
 * A batch's instance records, read back: every one up to BOUNDS_SAMPLE, else RUNS evenly spaced runs. Every read is
 * asked for before the first await.
 */
async function sampled(read: NonNullable<BoundsPort['readBuffer']>, buffer: Handle, instances: number): Promise<Float32Array> {
    const bytes = INSTANCE_FLOATS * 4;
    if (instances <= BOUNDS_SAMPLE) return new Float32Array(await read(buffer, instances * bytes, 0));
    const run = Math.floor(BOUNDS_SAMPLE / RUNS);
    const runs = Array.from({ length: RUNS }, (_, k) => read(buffer, run * bytes, Math.floor(k * (instances - run) / (RUNS - 1)) * bytes));
    const out = new Float32Array(RUNS * run * INSTANCE_FLOATS);
    (await Promise.all(runs)).forEach((part, k) => out.set(new Float32Array(part), k * run * INSTANCE_FLOATS));
    return out;
}

/**
 * Each mesh batch's box in world space, from its instances as the device holds them; null when this engine cannot read
 * them. Every batch's reads are submitted before the first await, so all of them see one tick: a review reads them in
 * the same quiet section as its frames (review-capture.ts, EA6).
 */
export async function worldBounds(batches: readonly MeshBatchState[], port: BoundsPort): Promise<WorldBounds | null> {
    if (!port.readBuffer || !port.geometryBox) return null;
    const read = port.readBuffer.bind(port);
    const geometryBox = port.geometryBox.bind(port);
    const asked = batches.map(b => {
        const local = geometryBox(b.geometry);
        return local && b.instances > 0 ? { b, local, records: sampled(read, b.buffer, b.instances) } : null;
    });
    const got = await Promise.all(asked.map(a => a?.records ?? null));
    const out: BatchBox[] = [];
    for (let i = 0; i < asked.length; i++) {
        const a = asked[i];
        const records = got[i];
        if (!a || !records) continue;
        const { b, local } = a;
        let box: Box | null = null;
        let count = 0;
        for (let at = 0; at + INSTANCE_FLOATS <= records.length; at += INSTANCE_FLOATS) {
            const ib = instanceBox(local, records, at);
            if (!ib) continue;
            box = union(box, ib);
            count++;
        }
        if (box) out.push({ node: b.node, box, instances: b.instances, sampled: count });
    }
    return { batches: out };
}

/** The batches at least DWARFS times the largest side of every other batch's, by the median of theirs. */
export function dwarfing(bounds: WorldBounds): { batch: BatchBox; ratio: number; rest: number }[] {
    if (bounds.batches.length < 2) return [];
    const out: { batch: BatchBox; ratio: number; rest: number }[] = [];
    for (const b of bounds.batches) {
        const others = bounds.batches.filter(o => o !== b).map(o => largest(o.box)).sort((x, y) => x - y);
        const rest = others[Math.floor((others.length - 1) / 2)];
        if (rest > 0 && largest(b.box) >= DWARFS * rest) out.push({ batch: b, ratio: largest(b.box) / rest, rest });
    }
    return out;
}

export interface Framing {
    view: CameraView;
    /** What it frames: every batch but those that dwarf the rest. */
    subject: Box;
    /** For Developer view: a batch that dwarfs the rest, the camera inside a batch's box, a world past the camera's reach. */
    notes: string[];
}

/**
 * The orbit view that frames the world: its subject (every batch but one that dwarfs the rest, which is the world's
 * ground or its mistake, and not what the shot is of) whole in the view, from a three-quarter angle a little above, no
 * farther than the orbit zooms out (`maxDistance`, the studio's 80) and the camera reaches. Null when no batch has a box
 * (custom batches and fullscreen passes alone).
 */
export function frameWorld(bounds: WorldBounds | null, fovDegrees: number, aspect: number, maxDistance = 80): Framing | null {
    if (!bounds || !bounds.batches.length) return null;
    const notes: string[] = [];
    const big = dwarfing(bounds);
    for (const d of big) {
        notes.push(`EA_SCALE ${d.batch.node} spans ${dims(d.batch.box)} units, ${Math.round(d.ratio)} times the rest of the world (${round(d.rest)} across): `
            + 'a primitive\'s size and its instances\' scale multiply, so one of them is likely meant as 1');
    }
    let subject: Box | null = null;
    for (const b of bounds.batches) if (!big.some(d => d.batch === b)) subject = union(subject, b.box);
    subject ??= bounds.batches.reduce<Box | null>((u, b) => union(u, b.box), null)!;
    const center = [0, 1, 2].map(i => (subject.min[i] + subject.max[i]) / 2) as Vec3;
    const radius = Math.max(0.5, Math.hypot(...size(subject)) / 2);
    const vertical = fovDegrees * Math.PI / 180;
    const half = Math.min(vertical, 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 1e-3))) / 2;
    const whole = radius / Math.sin(half) * 1.05;
    // The farthest the camera can be with the far side still in reach, and no farther than the orbit zooms out.
    const reach = Math.min(maxDistance, CAMERA_REACH * 0.95 - radius);
    let distance = whole;
    if (whole > reach) {
        distance = Math.max(1, Math.min(maxDistance, reach > 1 ? reach : CAMERA_REACH / 2));
        notes.push(`EA_FRAME the world is ${round(2 * radius)} units across, too large to see whole within the orbit's ${maxDistance} units and the camera's reach of ${CAMERA_REACH}: framed on its middle`);
    }
    const view: CameraView = { target: center, distance, azimuth: 0.6, polar: 1.15, fov: fovDegrees };
    const eye = eyeOf(view);
    for (const b of bounds.batches) {
        if (eye.every((v, i) => v > b.box.min[i] && v < b.box.max[i])) {
            notes.push(`EA_FRAME the camera starts inside ${b.node}'s bounding box (${dims(b.box)} units): its geometry may block the view`);
        }
    }
    return { view, subject, notes };
}
