// Host h1's modules (core-loop-frontend.md §5.2; the backend's host/h1, embedded in ./h1): the host writes the
// whole WGSL module around each model-written function: the bindings, the structs, the helper library, the
// compute loop that calls `evolve`, the sprite shader that calls `look`, the backdrop that calls `sky`. The
// model's text is one function, placed between two marker comments, and `firstLine` says where, so a compiler
// diagnostic maps back onto the function's own lines (verify/gate.ts). The structs here must say what
// h1/particles.wgsl tells the model (test/host.test.mjs keeps them in step).

import { H1 } from './h1';
import type { FunctionName, UniformSpec } from './spec';
import { CAMERA_STRUCT, paramsStruct, SIM_STRUCT } from './wgsl';

export const PARTICLE_STRUCT = 'struct Particle { pos: vec3f, phase: f32, b: vec4f };';
export const LOOK_STRUCT = 'struct Look { color: vec3f, size: f32, opacity: f32 };';
export const MODEL_START = '// ---- model-written function: never edited by the host ----';
export const HOST_START = '// ---- host ----';

/** The compute stage: one invocation per particle; `b` is never written back (the host keeps the seeded numbers). */
const EVOLVE_HOST = `@compute @workgroup_size(128) fn cs_main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= sim.count) { return; }
    let a = particles[i * 2u];
    let next = evolve(Particle(a.xyz, a.w, particles[i * 2u + 1u]), i);
    particles[i * 2u] = vec4f(next.pos, next.phase);
}`;

/**
 * The sprite: a camera-facing triangle of radius `look.size` world units, projected at the particle's depth, and a
 * premultiplied fragment where opacity 0 adds light (a soft gaussian) and opacity 1 covers (a disc with a soft rim).
 */
const LOOK_HOST = `struct V {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec3f,
    @location(2) opacity: f32,
};

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> V {
    let a = particles[i * 2u];
    let lk = look(Particle(a.xyz, a.w, particles[i * 2u + 1u]), i);
    let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let uv = corners[v];
    var clip = camera.viewProj * vec4f(a.xyz, 1.0);
    let size = clamp(lk.size, 0.0, 10.0) * camera.proj[1][1];
    clip.x += uv.x * size / camera.aspect;
    clip.y += uv.y * size;
    var o: V;
    o.pos = clip;
    o.uv = uv;
    o.color = max(lk.color, vec3f(0.0));
    o.opacity = clamp(lk.opacity, 0.0, 1.0);
    return o;
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let r = dot(v.uv, v.uv);
    if (r > 1.0) { discard; }
    let soft = mix(exp(-r * 4.5), 1.0 - smoothstep(0.55, 1.0, r), v.opacity);
    return vec4f(v.color * soft, v.opacity * soft);
}`;

/** The backdrop: a fullscreen triangle at the far plane; each pixel's view direction goes to `sky`. */
const SKY_HOST = `struct V {
    @builtin(position) pos: vec4f,
    @location(0) ndc: vec2f,
};

@vertex fn vs_main(@builtin(vertex_index) i: u32) -> V {
    let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: V;
    o.pos = vec4f(p[i], 0.9999, 1.0);
    o.ndc = p[i];
    return o;
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let far = camera.invViewProj * vec4f(v.ndc, 1.0, 1.0);
    let dir = normalize(far.xyz / far.w - camera.eye);
    let col = max(sky(dir), vec3f(0.0)) + particles[0].xyz * 0.0;
    return vec4f(col, 1.0);
}`;

const HOST_CODE: Record<FunctionName, string> = { evolve: EVOLVE_HOST, look: LOOK_HOST, sky: SKY_HOST };

export interface AssembledModule {
    code: string;
    /** The module line (1-based) the function's first line sits on. */
    firstLine: number;
    /** How many lines the function has. */
    lines: number;
}

const banner = (fn: FunctionName) =>
    `// Wexy host h1: the ${fn === 'evolve' ? 'particle pass, compute stage' : fn === 'look' ? 'particle pass, sprite shader' : 'sky pass'}. The host owns every binding, loop and pass; the model wrote fn ${fn}.`;

/** The whole module one function compiles into, for the world's controls. */
export function assembleModule(fn: FunctionName, body: string, uniforms: Record<string, UniformSpec>): AssembledModule {
    const header = fn === 'evolve'
        ? [
            SIM_STRUCT,
            paramsStruct(uniforms),
            '@group(0) @binding(0) var<storage, read_write> particles: array<vec4f>;',
            '@group(0) @binding(1) var<uniform> sim: Sim;',
            '@group(0) @binding(2) var<uniform> params: Params;',
        ]
        : [
            CAMERA_STRUCT,
            '@group(0) @binding(0) var<uniform> camera: Camera;',
            '@group(0) @binding(1) var<storage, read> particles: array<vec4f>;',
            paramsStruct(uniforms),
            SIM_STRUCT,
            '@group(1) @binding(0) var<uniform> params: Params;',
            '@group(1) @binding(1) var<uniform> sim: Sim;',
        ];
    const structs = fn === 'sky' ? [] : [PARTICLE_STRUCT, LOOK_STRUCT, ''];
    const pre = [banner(fn), ...header, '', H1.helpers, '', ...structs, MODEL_START].join('\n');
    const post = ['', HOST_START, HOST_CODE[fn], ''].join('\n');
    return { code: `${pre}\n${body}\n${post}`, firstLine: pre.split('\n').length + 1, lines: body.split('\n').length };
}

/** A module line as a line of the function: 0 when it falls in the host's part (the function broke the module). */
export function functionLine(module: AssembledModule, moduleLine: number): number {
    const line = moduleLine - module.firstLine + 1;
    return line >= 1 && line <= module.lines ? line : 0;
}
