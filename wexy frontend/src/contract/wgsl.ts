// Host-side WGSL for the expert setting (whole hooks, as the playground examples are written): the headers
// injected in front of each hook, and the contract checks Tint cannot make. The model never declares a binding;
// it only reads `camera`, `particles`, `sim` and `params`, which keeps it away from bind-group layouts and buffer
// alignment entirely. The Standard setting's modules are assembled in host.ts from the same structs.

import { RESERVED_WORDS } from './reserved';
import type { HookName, UniformSpec } from './spec';

export const CAMERA_STRUCT = `struct Camera {
    viewProj: mat4x4f, view: mat4x4f, proj: mat4x4f, invViewProj: mat4x4f,
    invView: mat4x4f, invProj: mat4x4f, eye: vec3f, time: f32,
    near: f32, far: f32, fov: f32, aspect: f32, pad: vec4f,
};`;

/** The fixed-step clock, as h1/particles.wgsl shows it to the model. */
export const SIM_STRUCT = 'struct Sim { dt: f32, time: f32, frame: u32, count: u32 };';

const BANNER = '// Wexy host header: injected by the studio, never written by the model.';
const HOOK_START = '// ---- model-written hook ----';

/** Sim uniform: four 32-bit words, written once per evolve step. */
export const SIM_BYTES = 16;

export function paramsStruct(uniforms: Record<string, UniformSpec>): string {
    const names = Object.keys(uniforms);
    const fields = names.length ? names.map(n => `    ${n}: f32,`).join('\n') : '    _unused: f32,';
    return `struct Params {\n${fields}\n};`;
}

/** Bytes for the Params uniform: one f32 per uniform, rounded up to WGSL's 16-byte struct size. */
export function paramsBytes(uniforms: Record<string, UniformSpec>): number {
    return Math.max(16, Math.ceil(Object.keys(uniforms).length / 4) * 16);
}

export function hookHeader(hook: HookName, uniforms: Record<string, UniformSpec>): string {
    if (hook === 'evolve') {
        return [
            BANNER,
            SIM_STRUCT,
            paramsStruct(uniforms),
            '@group(0) @binding(0) var<storage, read_write> particles: array<vec4f>;',
            '@group(0) @binding(1) var<uniform> sim: Sim;',
            '@group(0) @binding(2) var<uniform> params: Params;',
            HOOK_START,
            '',
        ].join('\n');
    }
    return [
        BANNER,
        CAMERA_STRUCT,
        '@group(0) @binding(0) var<uniform> camera: Camera;',
        '@group(0) @binding(1) var<storage, read> particles: array<vec4f>;',
        paramsStruct(uniforms),
        '@group(1) @binding(0) var<uniform> params: Params;',
        HOOK_START,
        '',
    ].join('\n');
}

/** Number of lines the header adds, so Tint's module line numbers map back onto the hook body. */
export function headerLineCount(header: string): number {
    return header.split('\n').length - 1;
}

export function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Which host bindings a module references. Pipelines use `layout: 'auto'`, which drops every binding a shader
 * never touches, so the host must bind exactly these and no others.
 */
export function bindingUse(code: string): { camera: boolean; particles: boolean; sim: boolean; params: boolean } {
    const text = stripComments(code);
    return {
        camera: /\bcamera\./.test(text),
        particles: /\bparticles\s*\[/.test(text) || /arrayLength\s*\(\s*&particles/.test(text),
        sim: /\bsim\./.test(text),
        params: /\bparams\./.test(text),
    };
}

export interface ContractIssue {
    line: number;
    message: string;
}

/**
 * The host's side of the hook contract, checked before Tint sees the module: entry points the pipelines name,
 * the bindings null-graph always binds, and no bindings of the model's own.
 */
export function lintHook(hook: HookName, body: string): ContractIssue[] {
    const issues: ContractIssue[] = [];
    const code = stripComments(body);
    const lineOf = (re: RegExp) => {
        const lines = body.split('\n');
        const i = lines.findIndex(l => re.test(l));
        return i < 0 ? 0 : i + 1;
    };
    const use = bindingUse(body);

    const binding = lineOf(/@(group|binding)\s*\(/);
    if (binding) {
        issues.push({ line: binding, message: 'hooks must not declare bindings; the host header owns @group/@binding' });
    }
    if (hook === 'evolve') {
        if (!/@compute\s+@workgroup_size\s*\(\s*128\s*\)\s*fn\s+cs_main/.test(code)) {
            issues.push({ line: 0, message: 'evolve must define `@compute @workgroup_size(128) fn cs_main` (the host dispatches ceil(count / 128) groups)' });
        }
        if (!use.particles) issues.push({ line: 0, message: 'evolve must read or write `particles`' });
    } else {
        if (!/@vertex\s+fn\s+vs_main/.test(code)) issues.push({ line: 0, message: `${hook} must define \`@vertex fn vs_main\`` });
        if (!/@fragment\s+fn\s+fs_main/.test(code)) issues.push({ line: 0, message: `${hook} must define \`@fragment fn fs_main\`` });
        // null-graph binds camera and the instance buffer for every batch; an auto layout without
        // them rejects that bind group, so each render hook has to touch both.
        if (!use.camera) issues.push({ line: 0, message: `${hook} must reference \`camera\` (group 0 binding 0 is always bound)` });
        if (!use.particles) issues.push({ line: 0, message: `${hook} must reference \`particles\` (group 0 binding 1 is always bound)` });
    }
    return issues;
}

export function lintUniformNames(uniforms: Record<string, UniformSpec>): string[] {
    const problems: string[] = [];
    for (const [name, u] of Object.entries(uniforms)) {
        if (!/^[a-z][A-Za-z0-9_]*$/.test(name) || (RESERVED_WORDS.has(name) && name !== 'quality')) {
            problems.push(`uniform "${name}" is not a valid WGSL field name`);
        }
        if (!(u.min <= u.value && u.value <= u.max)) {
            problems.push(`uniform "${name}" default ${u.value} is outside [${u.min}, ${u.max}]`);
        }
    }
    return problems;
}
