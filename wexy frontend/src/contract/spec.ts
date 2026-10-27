// The declarative boundary between the models and the engine: SceneSpec 2.0 (core-loop-frontend.md §5.1, refined
// by the FE1 design §5). The planner writes the draft (draft.ts), the author writes the functions, and the host
// owns every GPU object, binding, loop and pass (coding principles §1). A world's program is either the h1
// functions (the Standard setting: evolve, look, sky) or whole hooks (the expert setting, as the three playground
// examples are written; FE1 design Q37). Version 1.0 worlds do not load into 2.0.

export type Style = 'cinematic' | 'anime-cel' | 'cosmic' | 'brutalist';
export const STYLES: readonly Style[] = ['cinematic', 'anime-cel', 'cosmic', 'brutalist'];

export type Vec3 = [number, number, number];

/** The functions a model writes under host h1: the particle pass and the sky (`arrange` and `sdf` arrive with FE3). */
export type FunctionName = 'evolve' | 'look' | 'sky';
export const FUNCTIONS: readonly FunctionName[] = ['evolve', 'look', 'sky'];

/** The stages of the expert setting: whole compute and render hooks against the host header (wgsl.ts). */
export type HookName = 'evolve' | 'particles' | 'backdrop';
export const HOOKS: readonly HookName[] = ['evolve', 'particles', 'backdrop'];

/** What a diagnostic points at: a function of the Standard setting or a hook of the expert one. */
export type ProgramTarget = FunctionName | HookName;

/** The host library version every spec names: the headers, helpers and rules the functions compile against (Q28). */
export const HOST_VERSION = 'h1';
export const SPEC_VERSION = '2.0';

export interface UniformSpec {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
}

export interface CameraKeyframe {
    /** Normalized film time in [0, 1]; seconds = t × film duration. */
    t: number;
    target: Vec3;
    distance: number;
    /** Degrees. */
    azimuth: number;
    /** Degrees from +Y. */
    polar: number;
    /** Vertical field of view, degrees. */
    fov: number;
}

export type CameraMove = 'orbit' | 'dolly-in' | 'flyby' | 'crane';
export const CAMERA_MOVES: readonly CameraMove[] = ['orbit', 'dolly-in', 'flyby', 'crane'];

export interface CameraSpec {
    keyframes: CameraKeyframe[];
    /** The one camera move the planner chose; the keyframes carry it in v1, the move names it for FE4. */
    move?: CameraMove;
}

/**
 * How the host draws one immutable per-particle number (`b.x`, `b.y`, `b.z`, `b.w`): seeding is deterministic
 * and owned by the host, but its shape is scene-specific, so the model picks the distributions and the host runs
 * the seeded LCG. `use` is the planner's note on what the number is for, which the authors read.
 */
export type SpawnDistribution = (
    | { dist: 'uniform'; min: number; max: number }
    | { dist: 'power'; min: number; max: number; power: number }
    | { dist: 'triangular'; min: number; max: number }
) & { use?: string };

export interface SpawnSpec {
    /** Initial phase: zero, or a random angle in [0, 2π). */
    phase: 'zero' | 'random-angle';
    x: SpawnDistribution;
    y: SpawnDistribution;
    z: SpawnDistribution;
    w: SpawnDistribution;
}

export interface ParticlesSpec {
    /** Clamped by the host to the device's storage-buffer limits (spawn.ts). */
    count: number;
    /** The fixed step in seconds. A film advances exactly this much per 1/60 s. */
    dt: number;
    warmupSeconds: number;
    seed: number;
    spawn: SpawnSpec;
}

export interface PostSpec {
    bloom?: { threshold: number; intensity: number; knee?: number; mips?: number };
    halation?: { threshold: number; intensity: number; radius: number; tint: Vec3 };
    tonemap?: { curve: 'aces' | 'agx' | 'reinhard'; exposure: number };
    outline?: { thickness: number; depthSensitivity: number; color: Vec3; lumaSensitivity?: number; strength?: number };
    ssao?: { radius: number; bias: number; intensity: number };
    fxaa?: boolean;
    vignette?: { intensity: number; softness: number };
}

/**
 * The code of a world. `functions`: the Standard setting, h1's `evolve`, `look` and `sky`, each one function the
 * host wraps in its own module (host.ts). `hooks`: the expert setting, whole stages against the host header
 * (wgsl.ts): the playground examples. Absent text means the stage is not used (`sky: 'black'`, no backdrop).
 */
export type Program =
    | { kind: 'functions'; evolve?: string; look?: string; sky?: string }
    | { kind: 'hooks'; evolve: string; particles: string; backdrop?: string };

export interface SceneSpec {
    version: '2.0';
    host: 'h1';
    title: string;
    /** One sentence: what the world is and how it moves (the planner's, for the provenance sheet). */
    summary: string;
    style: Style;
    particles: ParticlesSpec;
    /** A painted backdrop (the `sky` function) or pure darkness. */
    sky: 'function' | 'black';
    /** Every entry becomes an f32 field of `params` and a slider; `quality` is the host's own (QUALITY_UNIFORM). */
    uniforms: Record<string, UniformSpec>;
    camera: CameraSpec;
    post: PostSpec;
    program: Program;
}

/**
 * A hook may declare this uniform, in [min, 1], to scale its own cost (raymarch steps, noise octaves). The preview
 * guard lowers it before it lowers resolution; export always renders at 1. A planner never names it.
 */
export const QUALITY_UNIFORM = 'quality';

/** The functions a Standard world needs: the particle pass always, the sky when it is painted. */
export function functionsOf(spec: Pick<SceneSpec, 'sky'>): FunctionName[] {
    return spec.sky === 'function' ? ['evolve', 'look', 'sky'] : ['evolve', 'look'];
}

/** The stages an expert world has. */
export function hooksOf(program: Extract<Program, { kind: 'hooks' }>): HookName[] {
    return program.backdrop !== undefined ? ['evolve', 'backdrop', 'particles'] : ['evolve', 'particles'];
}

/** Every piece of model-written text a spec carries, in the order the studio shows them. */
export function targetsOf(spec: SceneSpec): ProgramTarget[] {
    switch (spec.program.kind) {
        case 'functions': return functionsOf(spec);
        case 'hooks': return hooksOf(spec.program);
    }
}

export function programText(spec: SceneSpec, target: ProgramTarget): string | undefined {
    return (spec.program as Record<string, string | undefined>)[target];
}

/** A copy of `spec` with one piece of program text replaced; nothing is edited in place (versions are immutable, I5). */
export function withProgramText(spec: SceneSpec, target: ProgramTarget, text: string): SceneSpec {
    return { ...spec, program: { ...spec.program, [target]: text } as Program };
}
