// The planner's answer, parsed: rung L0 of the ladder (core-loop-frontend.md §7). A draft is the backend's
// scene-draft.v1 (forge-loop design §5.4): SceneSpec 2.0 without its program and host, with the controls as an
// array (Meta's strict subset) and every unused block null. The server validated it against the same schema; this
// parser is the browser's own authority over what it compiles (coding principles §2): unknown in, a typed draft
// out, ranges clamped and noted, anything else refused with a message a planner repair can use. The limits here
// mirror the backend's schemas/scene-draft.v1.json and DraftChecks; test/contract.test.mjs pins the embedded copy.

import { RESERVED_WORDS } from './reserved';
import {
    CAMERA_MOVES, HOST_VERSION, QUALITY_UNIFORM, SPEC_VERSION, STYLES,
    type CameraKeyframe, type CameraMove, type ParticlesSpec, type PostSpec, type Program, type SceneSpec,
    type SpawnDistribution, type SpawnSpec, type Style, type UniformSpec, type Vec3,
} from './spec';

export interface DraftUniform {
    /** camelCase, a valid WGSL field name; never `quality`. */
    name: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
}

export interface Draft {
    title: string;
    summary: string;
    style: Style;
    particles: ParticlesSpec;
    /** Geometry worlds come with FE3: always null in v1. */
    arrangement: null;
    light: null;
    sky: 'function' | 'black';
    uniforms: DraftUniform[];
    camera: { keyframes: CameraKeyframe[]; move: CameraMove | null };
    post: {
        bloom: { threshold: number; intensity: number } | null;
        halation: { threshold: number; intensity: number; radius: number; tint: Vec3 } | null;
        tonemap: { curve: 'aces' | 'agx' | 'reinhard'; exposure: number } | null;
        fxaa: boolean;
        vignette: { intensity: number; softness: number } | null;
    };
}

/** The schema's limits (scene-draft.v1.json), as [min, max] ranges or lengths. */
export const DRAFT_LIMITS = {
    count: [65_536, 2_097_152],
    dt: [0.004, 0.05],
    warmupSeconds: [0, 10],
    seed: [0, 2_147_483_647],
    power: [0.1, 8],
    uniforms: [1, 8],
    keyframes: [1, 6],
    title: 60,
    summary: 200,
    label: 32,
    use: 80,
    name: /^[a-z][A-Za-z0-9]{0,23}$/,
    t: [0, 1],
    distance: [1, 200],
    azimuth: [-360, 360],
    polar: [1, 179],
    fov: [15, 100],
    bloomThreshold: [0, 4],
    bloomIntensity: [0, 3],
    halationThreshold: [0, 4],
    halationIntensity: [0, 2],
    halationRadius: [0, 8],
    exposure: [0.1, 4],
    vignette: [0, 1],
} as const;

export interface DraftParse {
    /** The draft when nothing refused it; clamped values are already applied. */
    draft: Draft | null;
    /** What refused it: a path and the reason, in the order found. */
    problems: string[];
    /** What was clamped into range, for the provenance sheet and the outcome report. */
    clamped: string[];
}

type Range = readonly [number, number];

/** One frame of the film at 60 fps; a step must fit it a whole number of times, or null-graph/film refuses the world. */
const FRAME_SECONDS = 1 / 60;

/**
 * `dt` as a whole number of steps a frame, 1 to 4. The planner writes 0.0166667, which is not 1/60, and a step the film
 * cannot fit a whole number of times into a frame is refused at Record, after the world ran fine (found 2026-10-28,
 * on every live world). A rounding of the same step is snapped silently; a different step is listed as clamped.
 */
function snapDt(r: Reader, dt: number, at: string): number {
    const k = Math.min(4, Math.max(1, Math.round(FRAME_SECONDS / dt)));
    const snapped = FRAME_SECONDS / k;
    if (Math.abs(snapped - dt) > dt * 0.02) r.clamped.push(`${at}: ${dt} snapped to ${snapped.toPrecision(6)} (${k} step${k === 1 ? '' : 's'} a frame at 60 fps)`);
    return snapped;
}

/** A parse in progress: the problems and clamps it collects, and the readers that add to them. */
class Reader {
    readonly problems: string[] = [];
    readonly clamped: string[] = [];

    obj(v: unknown, at: string): Record<string, unknown> | null {
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
        this.problems.push(`${at}: expected an object`);
        return null;
    }

    str(v: unknown, at: string, max: number): string {
        if (typeof v !== 'string' || !v.trim()) {
            this.problems.push(`${at}: expected a non-empty string`);
            return '';
        }
        const s = v.trim();
        if (s.length > max) {
            this.clamped.push(`${at}: cut to ${max} characters`);
            return s.slice(0, max);
        }
        return s;
    }

    /** A finite number, clamped into `range` when one is given. */
    num(v: unknown, at: string, range?: Range): number {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            this.problems.push(`${at}: expected a number`);
            return range ? range[0] : 0;
        }
        if (range && (v < range[0] || v > range[1])) {
            const c = Math.min(range[1], Math.max(range[0], v));
            this.clamped.push(`${at}: ${v} clamped to ${c}`);
            return c;
        }
        return v;
    }

    int(v: unknown, at: string, range: Range): number {
        const n = this.num(v, at, range);
        return Number.isInteger(n) ? n : Math.round(n);
    }

    bool(v: unknown, at: string): boolean {
        if (typeof v === 'boolean') return v;
        this.problems.push(`${at}: expected true or false`);
        return false;
    }

    enumOf<T extends string>(v: unknown, at: string, allowed: readonly T[]): T {
        if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
        this.problems.push(`${at}: expected one of ${allowed.join(', ')}`);
        return allowed[0];
    }

    vec3(v: unknown, at: string): Vec3 {
        if (!Array.isArray(v) || v.length !== 3) {
            this.problems.push(`${at}: expected three numbers`);
            return [0, 0, 0];
        }
        return [this.num(v[0], `${at}[0]`), this.num(v[1], `${at}[1]`), this.num(v[2], `${at}[2]`)];
    }

    /** An array within a length range; too many items are refused, not cut, because order would decide what is lost. */
    list(v: unknown, at: string, range: Range): unknown[] | null {
        if (!Array.isArray(v)) {
            this.problems.push(`${at}: expected an array`);
            return null;
        }
        if (v.length < range[0] || v.length > range[1]) {
            this.problems.push(`${at}: ${v.length} items; expected ${range[0]} to ${range[1]}`);
            return null;
        }
        return v;
    }
}

function distribution(r: Reader, v: unknown, at: string): SpawnDistribution {
    const o = r.obj(v, at);
    if (!o) return { dist: 'uniform', min: 0, max: 1 };
    const dist = r.enumOf(o.dist, `${at}.dist`, ['uniform', 'power', 'triangular'] as const);
    const min = r.num(o.min, `${at}.min`);
    const max = r.num(o.max, `${at}.max`);
    const use = typeof o.use === 'string' && o.use.trim() ? r.str(o.use, `${at}.use`, DRAFT_LIMITS.use) : undefined;
    const base = dist === 'power'
        ? { dist, min, max, power: r.num(o.power, `${at}.power`, DRAFT_LIMITS.power) }
        : { dist, min, max };
    return use ? { ...base, use } : base;
}

function keyframe(r: Reader, v: unknown, at: string): CameraKeyframe {
    const o = r.obj(v, at);
    if (!o) return { t: 0, target: [0, 0, 0], distance: 12, azimuth: 0, polar: 70, fov: 45 };
    return {
        t: r.num(o.t, `${at}.t`, DRAFT_LIMITS.t),
        target: r.vec3(o.target, `${at}.target`),
        distance: r.num(o.distance, `${at}.distance`, DRAFT_LIMITS.distance),
        azimuth: r.num(o.azimuth, `${at}.azimuth`, DRAFT_LIMITS.azimuth),
        polar: r.num(o.polar, `${at}.polar`, DRAFT_LIMITS.polar),
        fov: r.num(o.fov, `${at}.fov`, DRAFT_LIMITS.fov),
    };
}

function uniform(r: Reader, v: unknown, at: string, seen: Set<string>): DraftUniform {
    const o = r.obj(v, at);
    if (!o) return { name: 'x', label: 'x', value: 0, min: 0, max: 1, step: 0.01 };
    const name = typeof o.name === 'string' ? o.name : '';
    if (!DRAFT_LIMITS.name.test(name)) r.problems.push(`${at}.name: "${name}" is not a camelCase WGSL field name`);
    else if (name === QUALITY_UNIFORM || RESERVED_WORDS.has(name)) r.problems.push(`${at}.name: "${name}" is reserved`);
    else if (seen.has(name)) r.problems.push(`${at}.name: "${name}" is used twice`);
    seen.add(name);
    const label = r.str(o.label, `${at}.label`, DRAFT_LIMITS.label);
    const min = r.num(o.min, `${at}.min`);
    const max = r.num(o.max, `${at}.max`);
    let value = r.num(o.value, `${at}.value`);
    let step = r.num(o.step, `${at}.step`);
    if (!(min < max)) {
        r.problems.push(`${at}: min ${min} is not below max ${max}`);
    } else {
        if (value < min || value > max) {
            const c = Math.min(max, Math.max(min, value));
            r.clamped.push(`${at}.value: ${value} clamped to ${c}, inside [${min}, ${max}]`);
            value = c;
        }
        if (!(step > 0)) {
            const c = (max - min) / 100;
            r.clamped.push(`${at}.step: ${step} replaced by ${c}`);
            step = c;
        }
    }
    return { name, label, value, min, max, step };
}

function post(r: Reader, v: unknown, at: string): Draft['post'] {
    const o = r.obj(v, at) ?? {};
    const block = <T>(key: string, read: (b: Record<string, unknown>, at: string) => T): T | null => {
        const b = o[key];
        if (b === null || b === undefined) {
            if (b === undefined) r.problems.push(`${at}.${key}: missing (null leaves the effect out)`);
            return null;
        }
        const bo = r.obj(b, `${at}.${key}`);
        return bo ? read(bo, `${at}.${key}`) : null;
    };
    return {
        bloom: block('bloom', (b, p) => ({
            threshold: r.num(b.threshold, `${p}.threshold`, DRAFT_LIMITS.bloomThreshold),
            intensity: r.num(b.intensity, `${p}.intensity`, DRAFT_LIMITS.bloomIntensity),
        })),
        halation: block('halation', (b, p) => ({
            threshold: r.num(b.threshold, `${p}.threshold`, DRAFT_LIMITS.halationThreshold),
            intensity: r.num(b.intensity, `${p}.intensity`, DRAFT_LIMITS.halationIntensity),
            radius: r.num(b.radius, `${p}.radius`, DRAFT_LIMITS.halationRadius),
            tint: r.vec3(b.tint, `${p}.tint`),
        })),
        tonemap: block('tonemap', (b, p) => ({
            curve: r.enumOf(b.curve, `${p}.curve`, ['aces', 'agx', 'reinhard'] as const),
            exposure: r.num(b.exposure, `${p}.exposure`, DRAFT_LIMITS.exposure),
        })),
        fxaa: r.bool(o.fxaa, `${at}.fxaa`),
        vignette: block('vignette', (b, p) => ({
            intensity: r.num(b.intensity, `${p}.intensity`, DRAFT_LIMITS.vignette),
            softness: r.num(b.softness, `${p}.softness`, DRAFT_LIMITS.vignette),
        })),
    };
}

/**
 * The draft in `input` (parsed JSON, or the text of the planner's answer). Numbers out of range are clamped and
 * listed; a wrong shape, a bad control name or an unsound range is a problem, and then there is no draft.
 */
export function parseDraft(input: unknown): DraftParse {
    const r = new Reader();
    let value: unknown = input;
    if (typeof input === 'string') {
        try {
            value = JSON.parse(input);
        } catch (e) {
            return { draft: null, problems: [`not JSON: ${(e as Error).message}`], clamped: [] };
        }
    }
    const o = r.obj(value, '$');
    if (!o) return { draft: null, problems: r.problems, clamped: r.clamped };

    const title = r.str(o.title, '$.title', DRAFT_LIMITS.title);
    const summary = r.str(o.summary, '$.summary', DRAFT_LIMITS.summary);
    const style = r.enumOf(o.style, '$.style', STYLES);

    const p = r.obj(o.particles, '$.particles');
    const spawnObj = p ? r.obj(p.spawn, '$.particles.spawn') : null;
    const spawn: SpawnSpec = {
        phase: r.enumOf(spawnObj?.phase, '$.particles.spawn.phase', ['zero', 'random-angle'] as const),
        x: distribution(r, spawnObj?.x, '$.particles.spawn.x'),
        y: distribution(r, spawnObj?.y, '$.particles.spawn.y'),
        z: distribution(r, spawnObj?.z, '$.particles.spawn.z'),
        w: distribution(r, spawnObj?.w, '$.particles.spawn.w'),
    };
    const particles: ParticlesSpec = {
        count: r.int(p?.count, '$.particles.count', DRAFT_LIMITS.count),
        dt: snapDt(r, r.num(p?.dt, '$.particles.dt', DRAFT_LIMITS.dt), '$.particles.dt'),
        warmupSeconds: r.num(p?.warmupSeconds, '$.particles.warmupSeconds', DRAFT_LIMITS.warmupSeconds),
        seed: r.int(p?.seed, '$.particles.seed', DRAFT_LIMITS.seed),
        spawn,
    };

    if (o.arrangement !== null && o.arrangement !== undefined) r.problems.push('$.arrangement: must be null in v1');
    if (o.light !== null && o.light !== undefined) r.problems.push('$.light: must be null in v1');
    const sky = r.enumOf(o.sky, '$.sky', ['function', 'black'] as const);

    const seen = new Set<string>();
    const uniforms = (r.list(o.uniforms, '$.uniforms', DRAFT_LIMITS.uniforms) ?? []).map((u, i) => uniform(r, u, `$.uniforms[${i}]`, seen));

    const c = r.obj(o.camera, '$.camera');
    const keyframes = (r.list(c?.keyframes, '$.camera.keyframes', DRAFT_LIMITS.keyframes) ?? []).map((k, i) => keyframe(r, k, `$.camera.keyframes[${i}]`));
    let move: CameraMove | null = null;
    if (c && c.move !== null && c.move !== undefined) move = r.enumOf(c.move, '$.camera.move', CAMERA_MOVES);

    const draft: Draft = {
        title, summary, style, particles, arrangement: null, light: null, sky, uniforms,
        camera: { keyframes, move }, post: post(r, o.post, '$.post'),
    };
    return { draft: r.problems.length ? null : draft, problems: r.problems, clamped: r.clamped };
}

/** The spec a draft and its program make: controls become the map the engine and the director read, in order. */
export function specFromDraft(draft: Draft, program: Program): SceneSpec {
    const uniforms: Record<string, UniformSpec> = {};
    for (const u of draft.uniforms) uniforms[u.name] = { label: u.label, value: u.value, min: u.min, max: u.max, step: u.step };
    const post: PostSpec = {};
    if (draft.post.bloom) post.bloom = { ...draft.post.bloom };
    if (draft.post.halation) post.halation = { ...draft.post.halation, tint: [...draft.post.halation.tint] };
    if (draft.post.tonemap) post.tonemap = { ...draft.post.tonemap };
    if (draft.post.fxaa) post.fxaa = true;
    if (draft.post.vignette) post.vignette = { ...draft.post.vignette };
    const camera: SceneSpec['camera'] = { keyframes: draft.camera.keyframes.map(k => ({ ...k, target: [...k.target] as Vec3 })) };
    if (draft.camera.move) camera.move = draft.camera.move;
    return {
        version: SPEC_VERSION,
        host: HOST_VERSION,
        title: draft.title,
        summary: draft.summary,
        style: draft.style,
        particles: structuredClone(draft.particles),
        sky: draft.sky,
        uniforms,
        camera,
        post,
        program,
    };
}
