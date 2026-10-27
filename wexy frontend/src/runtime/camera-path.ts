// Camera keyframes -> a smooth path, ported from NullGraph's tools/film/camera.mjs: each value is a
// cubic Hermite with Catmull-Rom slopes at inner keys and zero slope at the ends, and distance moves
// on a log scale so a long pull-back reads evenly. Keyframes are in the spec's units (normalized t,
// degrees); views come out in radians, the units OrbitalCameraState and the film tool use.

import type { CameraKeyframe, Vec3 } from '../contract/spec';

export interface CameraView {
    target: Vec3;
    distance: number;
    /** Radians. */
    azimuth: number;
    /** Radians from +Y. */
    polar: number;
    /** Degrees. */
    fov: number;
}

const RAD = Math.PI / 180;

export function keyframeToView(k: CameraKeyframe): CameraView {
    return { target: [...k.target], distance: k.distance, azimuth: k.azimuth * RAD, polar: k.polar * RAD, fov: k.fov };
}

/** The spec's opening shot, or a neutral one when the model wrote no keyframes. */
export function firstView(keyframes: CameraKeyframe[]): CameraView {
    const first = [...keyframes].sort((a, b) => a.t - b.t)[0];
    return first ? keyframeToView(first) : { target: [0, 0, 0], distance: 12, azimuth: 0, polar: 1.25, fov: 45 };
}

export function viewToKeyframe(v: CameraView, t: number): CameraKeyframe {
    const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
    return {
        t: round(t, 4),
        target: [round(v.target[0]), round(v.target[1]), round(v.target[2])],
        distance: round(v.distance),
        azimuth: round(v.azimuth / RAD, 2),
        polar: round(v.polar / RAD, 2),
        fov: round(v.fov, 1),
    };
}

/** Keyframes are composed for a 16:9 frame; fitView adapts them to other shapes. */
export const DESIGN_ASPECT = 16 / 9;
/** How much of the 16:9 width a narrower frame keeps: vertical video crops the sides, and a bigger subject reads better on a phone. */
const KEEP_WIDTH = 0.55;
/** Widen the field of view up to this; past it, wide-angle stretch shows, so pull back instead. */
const FIT_MAX_FOV = 60;

/**
 * The view for a frame of `aspect` (width / height). A frame narrower than 16:9 keeps
 * KEEP_WIDTH of the 16:9 width: first by widening the vertical field of view, then by moving
 * the camera back. A wider frame keeps the vertical field of view and shows more at the sides.
 */
export function fitView(v: CameraView, aspect: number): CameraView {
    if (aspect >= DESIGN_ASPECT) return v;
    const tanV = Math.tan((v.fov * RAD) / 2);
    const want = (tanV * DESIGN_ASPECT * KEEP_WIDTH) / aspect;
    if (want <= tanV) return v;
    const capFov = Math.max(v.fov, FIT_MAX_FOV);
    const cap = Math.tan((capFov * RAD) / 2);
    if (want <= cap) return { ...v, fov: (2 * Math.atan(want)) / RAD };
    return { ...v, fov: capFov, distance: (v.distance * want) / cap };
}

/**
 * A frame of `frameAspect`, shown whole on a canvas of `canvasAspect`. On a narrower canvas the
 * vertical field of view widens until the frame's full width fits, so a frame guide drawn at
 * min(width, height × frameAspect) wide marks exactly what the export will contain.
 */
export function containView(v: CameraView, frameAspect: number, canvasAspect: number): CameraView {
    const fitted = fitView(v, frameAspect);
    if (canvasAspect >= frameAspect) return fitted;
    const tan = (Math.tan((fitted.fov * RAD) / 2) * frameAspect) / canvasAspect;
    return { ...fitted, fov: (2 * Math.atan(tan)) / RAD };
}

export function eyeOf(v: CameraView): Vec3 {
    const s = Math.sin(v.polar);
    return [
        v.target[0] + v.distance * s * Math.sin(v.azimuth),
        v.target[1] + v.distance * Math.cos(v.polar),
        v.target[2] + v.distance * s * Math.cos(v.azimuth),
    ];
}

function hermite(t: number, t0: number, t1: number, p0: number, p1: number, m0: number, m1: number): number {
    const h = t1 - t0, u = (t - t0) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
}

function track(times: number[], values: number[]): (t: number) => number {
    const n = values.length;
    const slope = values.map((_, k) => (k === 0 || k === n - 1 ? 0 : (values[k + 1] - values[k - 1]) / (times[k + 1] - times[k - 1])));
    return t => {
        if (n === 1 || t <= times[0]) return values[0];
        if (t >= times[n - 1]) return values[n - 1];
        let k = 0;
        while (t > times[k + 1]) k++;
        return hermite(t, times[k], times[k + 1], values[k], values[k + 1], slope[k], slope[k + 1]);
    };
}

/** `(seconds) => view` through the keyframes, or null when there are none. */
export function cameraPath(keyframes: CameraKeyframe[], durationSeconds: number): ((seconds: number) => CameraView) | null {
    if (!keyframes.length) return null;
    const keys = [...keyframes].sort((a, b) => a.t - b.t).map(k => ({ ...keyframeToView(k), time: k.t * durationSeconds }));
    // Keys at the same instant would divide by zero in the Hermite; keep the last one.
    const unique = keys.filter((k, i) => i === keys.length - 1 || keys[i + 1].time > k.time);
    const times = unique.map(k => k.time);
    const tracks = {
        x: track(times, unique.map(k => k.target[0])),
        y: track(times, unique.map(k => k.target[1])),
        z: track(times, unique.map(k => k.target[2])),
        logDistance: track(times, unique.map(k => Math.log(k.distance))),
        azimuth: track(times, unique.map(k => k.azimuth)),
        polar: track(times, unique.map(k => k.polar)),
        fov: track(times, unique.map(k => k.fov)),
    };
    return seconds => ({
        target: [tracks.x(seconds), tracks.y(seconds), tracks.z(seconds)],
        distance: Math.exp(tracks.logDistance(seconds)),
        azimuth: tracks.azimuth(seconds),
        polar: tracks.polar(seconds),
        fov: tracks.fov(seconds),
    });
}
