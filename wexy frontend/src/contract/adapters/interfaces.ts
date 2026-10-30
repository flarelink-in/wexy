// Module interfaces of EA3.4 (engine-adapters-design.md §8): for each module a node of X asks for, what its body may
// use and must define, derived by the host from X alone: the engine entry point wrapping the program's entry, typed
// bindings with their groups, generated constants, the engine chunks it includes, and `interfaceHash` over all of it.
// The bindings come from the operations that use the module, never from the program's word. No body is written,
// compiled or trusted here: EA4 writes bodies against these interfaces and EA5 compiles them.
//
// ABI ea-abi.v1. Every generated name is prefixed (`b_`, `B_`, `EA_`) or the engine's own, so no program name can
// collide with one, and every binding is used statically in the generated entry: with layout 'auto' an unused binding
// is dropped and the bind group then fails (the gotcha "null-graph owns bind group 0").
//   compute: group 0 the stage's buffers in X's access order, each `array<f32>`, read-only when only read, read_write
//            when written; a ping-pong pair as two, `_current` and `_next`. Group 1 binding 0 the engine's camera, whose
//            simTime is the time (a fixed step's dt is not in v1). `cs_main` guards EA_INVOCATIONS and calls
//            `fn <entry>(index: u32)`.
//   custom batch: the engine's group 0 (camera, ecs); StandardLayout's three inputs when geometry is wired; `vs_main`
//            and `fs_main` call the program's two entries. Lights, when wired, are LightSystem's layout at group 2,
//            which the host injects (its id and configuration are hashed).
//   fullscreen: the engine's group 0; the host's fullscreen triangle as `vs_main`; the fragment entry takes the
//            screen's uv; the buffers it reads at group 1.

import type { DeepReadonly } from '../engine/frozen';
import { BUILTIN_FUNCTIONS, RESERVED_WORDS } from '../reserved';
import { canonicalHash, sha256Hex } from './canonical';
import type { ExecutionGraph, XAccess, XOperation } from './graph';
import type { ResolveDiagnostic } from './index';

export const ABI_VERSION = 'ea-abi.v1';

/** null-graph 1.2.0's `CommonChunks`, byte for byte (EA-X15 pins them against the engine). */
export const ENGINE_CHUNKS: Readonly<Record<'CameraStruct' | 'EngineBindings' | 'VertexOut', string>> = {
    CameraStruct: '\n        struct Camera {\n            viewProj: mat4x4<f32>,\n            view: mat4x4<f32>,\n            proj: mat4x4<f32>,\n            invViewProj: mat4x4<f32>,\n            invView: mat4x4<f32>,\n            invProj: mat4x4<f32>,\n\n            eyePos: vec3<f32>,\n            simTime: f32,\n\n            zNear: f32,\n            zFar: f32,\n            fovRads: f32,\n            aspect: f32,\n            _padEnd: vec4<f32>\n        };\n    ',
    EngineBindings: '\n        @group(0) @binding(0) var<uniform> camera: Camera;\n        @group(0) @binding(1) var<storage, read> ecs: array<f32>;\n    ',
    VertexOut: '\n        struct VertexOut {\n            @builtin(position) clipPos: vec4<f32>,\n            @location(0) worldPos: vec3<f32>,\n            @location(1) worldNormal: vec3<f32>,\n            @location(2) uv: vec2<f32>,\n            @location(3) ecsColor: vec3<f32>,\n        }\n    ',
};

/** WebGPU's default limit, which an adapter is not assumed to raise. */
export const MAX_STORAGE_BUFFERS_PER_STAGE = 8;

export interface InterfaceBinding {
    group: number;
    binding: number;
    name: string;
    /** Its WGSL declaration, as the preamble has it. */
    declaration: string;
    /** The X resource bound to it. */
    resource: string;
    access: 'read' | 'read_write' | 'uniform';
    version: XAccess['version'];
    /** Who binds it: the engine (createBatch's group 0), or the host's own bind group (EA5). */
    boundBy: 'engine' | 'host';
}

export interface InterfaceEntry {
    stage: 'compute' | 'vertex' | 'fragment';
    /** The program's function, which the body defines. */
    entry: string;
    /** Exactly as the body must declare it. */
    signature: string;
    /** The engine's entry point, generated, which calls it. */
    engineEntry: 'cs_main' | 'vs_main' | 'fs_main';
    path: string;
}

export interface ModuleInterface {
    module: string;
    node: string;
    kind: 'compute' | 'custom_batch' | 'fullscreen';
    abi: string;
    entries: InterfaceEntry[];
    bindings: InterfaceBinding[];
    /** Generated constants the body may read. */
    constants: { name: string; value: number }[];
    workgroupSize: number | null;
    /** The engine chunks it includes, each with the SHA-256 of its text (or of its configuration, when injected). */
    chunks: { id: string; hash: string }[];
    /** Generated WGSL before the body (structs, bindings, constants), and after it (the engine's entry points). */
    preamble: string;
    epilogue: string;
    /** The operations that use it, and its places in the program (P4). */
    consumers: string[];
    paths: string[];
    /** SHA-256 of everything above but `node`, `consumers` and `paths`: what the body's code depends on. */
    interfaceHash: string;
}

/** `graph` is the hash of the X derived from: evidence names what it is evidence of (EA3.5's admission). */
export type Derived = { ok: true; graph: string; interfaces: ModuleInterface[] } | { ok: false; graph: string; diagnostics: ResolveDiagnostic[] };

const ENTRY = /^[a-z][A-Za-z0-9_]{0,39}$/;
const GENERATED = /^(b_|ea_|cs_main$|vs_main$|fs_main$|camera$|ecs$|main$)/i;

/** WGSL's built-in functions (the WGSL recommendation, 2024): a module-scope function by one of these names shadows it. */
const WGSL_FUNCTIONS = [
    'bitcast', 'all', 'any', 'select', 'arrayLength', 'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2', 'ceil', 'clamp', 'cos', 'cosh',
    'countLeadingZeros', 'countOneBits', 'countTrailingZeros', 'cross', 'degrees', 'determinant', 'distance', 'dot', 'dot4U8Packed', 'dot4I8Packed',
    'exp', 'exp2', 'extractBits', 'faceForward', 'firstLeadingBit', 'firstTrailingBit', 'floor', 'fma', 'fract', 'frexp', 'insertBits', 'inverseSqrt',
    'ldexp', 'length', 'log', 'log2', 'max', 'min', 'mix', 'modf', 'normalize', 'pow', 'quantizeToF16', 'radians', 'reflect', 'refract', 'reverseBits',
    'round', 'saturate', 'sign', 'sin', 'sinh', 'smoothstep', 'sqrt', 'step', 'tan', 'tanh', 'transpose', 'trunc',
    'dpdx', 'dpdxCoarse', 'dpdxFine', 'dpdy', 'dpdyCoarse', 'dpdyFine', 'fwidth', 'fwidthCoarse', 'fwidthFine',
    'textureDimensions', 'textureGather', 'textureGatherCompare', 'textureLoad', 'textureNumLayers', 'textureNumLevels', 'textureNumSamples', 'textureSample',
    'textureSampleBias', 'textureSampleCompare', 'textureSampleCompareLevel', 'textureSampleGrad', 'textureSampleLevel', 'textureSampleBaseClampToEdge', 'textureStore',
    'atomicLoad', 'atomicStore', 'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin', 'atomicAnd', 'atomicOr', 'atomicXor', 'atomicExchange', 'atomicCompareExchangeWeak',
    'pack4x8snorm', 'pack4x8unorm', 'pack4xI8', 'pack4xU8', 'pack4xI8Clamp', 'pack4xU8Clamp', 'pack2x16snorm', 'pack2x16unorm', 'pack2x16float',
    'unpack4x8snorm', 'unpack4x8unorm', 'unpack4xI8', 'unpack4xU8', 'unpack2x16snorm', 'unpack2x16unorm', 'unpack2x16float',
    'storageBarrier', 'textureBarrier', 'workgroupBarrier', 'workgroupUniformLoad',
    'subgroupAdd', 'subgroupExclusiveAdd', 'subgroupInclusiveAdd', 'subgroupAll', 'subgroupAnd', 'subgroupAny', 'subgroupBallot', 'subgroupBroadcast',
    'subgroupBroadcastFirst', 'subgroupElect', 'subgroupMax', 'subgroupMin', 'subgroupMul', 'subgroupExclusiveMul', 'subgroupInclusiveMul', 'subgroupOr',
    'subgroupShuffle', 'subgroupShuffleDown', 'subgroupShuffleUp', 'subgroupShuffleXor', 'subgroupXor', 'quadBroadcast', 'quadSwapDiagonal', 'quadSwapX', 'quadSwapY',
];
/** Its predeclared types, type generators and aliases, enumerants (address spaces, access modes, texel formats), built-in
 * values, interpolation words and attribute names: any of them shadowed at module scope breaks a declaration that uses it. */
const WGSL_NAMES = [
    'bool', 'f16', 'f32', 'i32', 'u32', 'array', 'atomic', 'ptr', 'sampler', 'sampler_comparison',
    ...['1d', '2d', '2d_array', '3d', 'cube', 'cube_array', 'multisampled_2d', 'depth_2d', 'depth_2d_array', 'depth_cube', 'depth_cube_array',
        'depth_multisampled_2d', 'external', 'storage_1d', 'storage_2d', 'storage_2d_array', 'storage_3d'].map(t => `texture_${t}`),
    ...['2', '3', '4'].flatMap(n => ['', 'i', 'u', 'f', 'h'].map(s => `vec${n}${s}`)),
    ...['2', '3', '4'].flatMap(c => ['2', '3', '4'].flatMap(r => ['', 'f', 'h'].map(s => `mat${c}x${r}${s}`))),
    'function', 'private', 'workgroup', 'uniform', 'storage', 'handle', 'read', 'write', 'read_write',
    'rgba8unorm', 'rgba8snorm', 'rgba8uint', 'rgba8sint', 'rgba16uint', 'rgba16sint', 'rgba16float', 'r32uint', 'r32sint', 'r32float', 'rg32uint', 'rg32sint',
    'rg32float', 'rgba32uint', 'rgba32sint', 'rgba32float', 'bgra8unorm', 'r8unorm', 'r8snorm', 'r8uint', 'r8sint', 'rg8unorm', 'rg8snorm', 'rg8uint',
    'rg8sint', 'r16uint', 'r16sint', 'r16float', 'rg16uint', 'rg16sint', 'rg16float', 'rgb10a2uint', 'rgb10a2unorm', 'rg11b10ufloat',
    'position', 'vertex_index', 'instance_index', 'front_facing', 'frag_depth', 'sample_index', 'sample_mask', 'local_invocation_id', 'local_invocation_index',
    'global_invocation_id', 'workgroup_id', 'num_workgroups', 'clip_distances', 'primitive_index', 'subgroup_invocation_id', 'subgroup_size',
    'perspective', 'linear', 'flat', 'center', 'centroid', 'sample', 'first', 'either',
    'align', 'binding', 'blend_src', 'builtin', 'compute', 'const', 'diagnostic', 'fragment', 'group', 'id', 'interpolate', 'invariant', 'location',
    'must_use', 'size', 'vertex', 'workgroup_size',
];

/**
 * Names an entry may not take (the EA3.4 review). WGSL's keywords and reserved words, its predeclared names above, the
 * names the host generates, and the generated wrappers' own parameters and locals: each is either something the
 * generated code depends on, or something a body would shadow. EA-I4 checks that every identifier the generated code
 * uses is here or is a generated declaration, so a new dependency cannot slip past.
 */
export const ENTRY_EXCLUDED: ReadonlySet<string> = new Set([
    ...RESERVED_WORDS, ...BUILTIN_FUNCTIONS, ...WGSL_FUNCTIONS, ...WGSL_NAMES,
    'camera', 'ecs', 'main', 'cs_main', 'vs_main', 'fs_main', 'Camera', 'VertexOut', 'EaFullscreen',
    'index', 'p', 'out', 'input', 'instance', 'normal', 'uv',
]);
/** A node id as a WGSL identifier: a node id may hold '-', which WGSL does not take. */
const wgslName = (nodeId: string) => nodeId.replace(/-/g, '_');

type Graph = DeepReadonly<ExecutionGraph>;
type Op = DeepReadonly<XOperation>;

/** Every module X asks for, as an interface; or every reason one cannot be, at its program path. */
export async function deriveInterfaces(x: Graph, chunks: Readonly<Record<keyof typeof ENGINE_CHUNKS, string>> = ENGINE_CHUNKS): Promise<Derived> {
    const diagnostics: ResolveDiagnostic[] = [];
    const fail = (path: string, nodeId: string | null, message: string) => { diagnostics.push({ code: 'EA_RESOLVE', path, nodeId, message }); };
    const ops = new Map(x.operations.map(o => [o.id, o]));
    const resources = new Map(x.resources.map(r => [r.id, r]));
    const kinds = new Map(x.nodes.map(n => [n.id, n.adapterId]));
    const chunkHash = new Map(await Promise.all(Object.entries(chunks).map(async ([id, text]) => [id, await sha256Hex(text)] as const)));

    // A module serves one node in Tier 1: two consumers with different bindings could not share one body. The node later
    // in the program is the one that shares, and is named.
    const place = new Map(x.nodes.map((n, i) => [n.id, i]));
    const byModule = new Map<string, Set<string>>();
    for (const m of x.modules) byModule.set(m.module, (byModule.get(m.module) ?? new Set()).add(m.node));
    for (const [module, nodes] of byModule) {
        if (nodes.size > 1) {
            const ordered = [...nodes].sort((a, b) => place.get(a)! - place.get(b)!);
            const at = x.modules.find(m => m.module === module && m.node === ordered[1])!;
            fail(at.path, ordered[1], `module ${module} serves ${ordered.join(' and ')}; a module serves one node in Tier 1, so give ${ordered[1]} its own`);
        }
    }
    for (const m of x.modules) {
        if (!ENTRY.test(m.entry) || ENTRY_EXCLUDED.has(m.entry) || GENERATED.test(m.entry)) {
            fail(m.path, m.node, `${m.entry.slice(0, 40)} cannot be an entry: it must be a WGSL name, not a reserved word, a WGSL built-in or type, or a name the host generates (cs_main, vs_main, fs_main, camera, ecs, b_…, ea_…, the wrappers' parameters)`);
        }
    }
    if (diagnostics.length) return { ok: false, graph: x.hash, diagnostics };

    /** A storage buffer an operation uses, as a binding: its name follows the buffer's node, and its half for a pair. */
    const storage = (a: DeepReadonly<XAccess>, group: number, binding: number): InterfaceBinding => {
        const r = resources.get(a.resource)!;
        const name = `b_${wgslName(r.node)}${a.version === null ? '' : `_${a.version}`}`;
        const access = a.mode === 'read' ? 'read' : 'read_write';
        return { group, binding, name, declaration: `@group(${group}) @binding(${binding}) var<storage, ${access}> ${name}: array<f32>;`, resource: r.id, access, version: a.version, boundBy: 'host' };
    };
    // A stride constant keeps its buffer's case, as the binding does: `aB` and `ab` are two buffers (the EA3.4 review).
    const strides = (bindings: InterfaceBinding[]) => [...new Map(bindings.filter(b => b.boundBy === 'host' && b.access !== 'uniform')
        .map(b => [resources.get(b.resource)!.node, { name: `B_${wgslName(resources.get(b.resource)!.node)}_STRIDE`, value: resources.get(b.resource)!.strideFloats! }])).values()];
    const constants = (list: { name: string; value: number }[]) => list.map(c => `const ${c.name}: u32 = ${c.value}u;`).join('\n');
    const used = (bindings: InterfaceBinding[]) => bindings.map(b => (b.access === 'uniform' ? `    _ = ${b.name}.simTime;` : `    _ = arrayLength(&${b.name});`)).join('\n');

    const interfaces: ModuleInterface[] = [];
    for (const [module, nodes] of byModule) {
        const node = [...nodes][0];
        const requests = x.modules.filter(m => m.module === module);
        const kind = kinds.get(node);
        const create = ops.get(`${node}#create`)!;
        const args = create.args as Record<string, unknown>;
        let entries: InterfaceEntry[];
        let bindings: InterfaceBinding[];
        let consts: { name: string; value: number }[];
        let preamble: string;
        let epilogue: string;
        let usedChunks: (keyof typeof ENGINE_CHUNKS)[];
        let injected: { id: string; hash: string } | null = null;
        let workgroupSize: number | null = null;
        if (kind === 'ng.compute.stage') {
            const dispatch = ops.get(requests[0].operation)!;
            const [request] = requests;
            bindings = dispatch.accesses.map((a, i) => storage(a, 0, i));
            bindings.push({ group: 1, binding: 0, name: 'camera', declaration: '@group(1) @binding(0) var<uniform> camera: Camera;', resource: '@host#camera', access: 'uniform', version: null, boundBy: 'host' });
            workgroupSize = args.workgroupSize as number;
            consts = [...strides(bindings), { name: 'EA_INVOCATIONS', value: args.invocations as number }];
            entries = [{ stage: 'compute', entry: request.entry, signature: `fn ${request.entry}(index: u32)`, engineEntry: 'cs_main', path: request.path }];
            usedChunks = ['CameraStruct'];
            preamble = [chunks.CameraStruct, ...bindings.map(b => b.declaration), constants(consts)].join('\n');
            epilogue = `@compute @workgroup_size(${workgroupSize})\nfn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {\n${used(bindings)}\n    if (id.x >= EA_INVOCATIONS) { return; }\n    ${request.entry}(id.x);\n}`;
        } else if (kind === 'ng.render.custom_batch') {
            const vertex = requests.find(r => r.stage === 'vertex')!;
            const fragment = requests.find(r => r.stage === 'fragment')!;
            const geometry = args.vertexLayout === 'StandardLayout';
            const lit = (args.shader as { lights: boolean }).lights;
            bindings = engineGroup(create);
            consts = [{ name: 'EA_ECS_STRIDE', value: args.strideFloats as number }];
            const signature = geometry
                ? `fn ${vertex.entry}(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, instance: u32) -> VertexOut`
                : `fn ${vertex.entry}(vertex: u32, instance: u32) -> VertexOut`;
            entries = [
                { stage: 'vertex', entry: vertex.entry, signature, engineEntry: 'vs_main', path: vertex.path },
                { stage: 'fragment', entry: fragment.entry, signature: `fn ${fragment.entry}(input: VertexOut) -> vec4<f32>`, engineEntry: 'fs_main', path: fragment.path },
            ];
            usedChunks = ['CameraStruct', 'EngineBindings', 'VertexOut'];
            preamble = [chunks.CameraStruct, chunks.EngineBindings, chunks.VertexOut, lit ? '// LightSystem.getShaderLayout() at group 2: the host injects it here (EA5).' : '', constants(consts)].filter(Boolean).join('\n');
            const inputs = geometry
                ? '@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @builtin(instance_index) instance: u32'
                : '@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32';
            const call = geometry ? `${vertex.entry}(position, normal, uv, instance)` : `${vertex.entry}(vertex, instance)`;
            epilogue = `@vertex\nfn vs_main(${inputs}) -> VertexOut {\n${used(bindings)}\n    return ${call};\n}\n@fragment\nfn fs_main(input: VertexOut) -> @location(0) vec4<f32> {\n    return ${fragment.entry}(input);\n}`;
            // LightSystem's layout depends on its technique and capacity, which X holds; the host injects its text.
            if (lit) {
                const capacity = ops.get(`${args.lights as string}#create`)!.args.capacity;
                injected = { id: 'lights:LightSystem.getShaderLayout', hash: await canonicalHash({ technique: 'standard', capacity }) };
            }
        } else {
            const [fragment] = requests;
            const draw = ops.get(fragment.operation)!;
            const reads = draw.accesses.filter(a => a.mode === 'read' && resources.get(a.resource)?.kind === 'buffer' && a.resource !== `${node}#storage` && a.resource !== '@host#camera');
            bindings = [...engineGroup(create), ...reads.map((a, i) => storage(a, 1, i))];
            consts = [{ name: 'EA_ECS_STRIDE', value: args.strideFloats as number }, ...strides(bindings)];
            entries = [{ stage: 'fragment', entry: fragment.entry, signature: `fn ${fragment.entry}(uv: vec2<f32>) -> vec4<f32>`, engineEntry: 'fs_main', path: fragment.path }];
            usedChunks = ['CameraStruct', 'EngineBindings'];
            preamble = [chunks.CameraStruct, chunks.EngineBindings, 'struct EaFullscreen {\n    @builtin(position) clip: vec4<f32>,\n    @location(0) uv: vec2<f32>,\n}',
                ...bindings.filter(b => b.boundBy === 'host').map(b => b.declaration), constants(consts)].join('\n');
            epilogue = `@vertex\nfn vs_main(@builtin(vertex_index) vertex: u32) -> EaFullscreen {\n${used(bindings)}\n    let p = vec2<f32>(f32((vertex << 1u) & 2u), f32(vertex & 2u));\n    var out: EaFullscreen;\n    out.clip = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);\n    out.uv = vec2<f32>(p.x, 1.0 - p.y);\n    return out;\n}\n@fragment\nfn fs_main(input: EaFullscreen) -> @location(0) vec4<f32> {\n    return ${fragment.entry}(input.uv);\n}`;
        }
        // One module scope: every declaration in it, generated or the body's entries, has its own name (the EA3.4 review).
        // Two entries of one name are named at the later entry; a generated clash at the module. The structs (Camera,
        // VertexOut, EaFullscreen) are left out: they start upper-case, as no binding, constant (B_, EA_) or entry can.
        const generated = [...bindings.map(b => b.name), ...consts.map(c => c.name), ...new Set(entries.map(e => e.engineEntry))];
        const twice = entries.find((e, i) => entries.findIndex(f => f.entry === e.entry) !== i);
        if (twice) fail(twice.path, node, `${module} would define ${twice.entry} twice, as its ${entries.map(e => e.stage).join(' and ')} entries; a module scope takes one function a name, so name them apart`);
        const clash = generated.find((n, i) => generated.indexOf(n) !== i);
        if (clash) fail(requests[0].path, node, `${module} would declare ${clash} twice: two buffer nodes it binds differ only by - and _, or one is named like another's ping-pong half; rename one`);
        const storageCount = bindings.filter(b => b.access !== 'uniform').length;
        if (storageCount > MAX_STORAGE_BUFFERS_PER_STAGE) {
            fail(requests[0].path, node, `${module} binds ${storageCount} storage buffers in one stage, over WebGPU's default ${MAX_STORAGE_BUFFERS_PER_STAGE}; use fewer buffers or fewer ping-pong pairs`);
        }
        const chunksOf = [...usedChunks.map(id => ({ id: `materials:CommonChunks.${id}`, hash: chunkHash.get(id)! })), ...(injected ? [injected] : [])];
        const body = { abi: ABI_VERSION, module, kind: kindName(kind!), entries: entries.map(({ path, ...e }) => e), bindings, constants: consts, workgroupSize, chunks: chunksOf, preamble, epilogue };
        interfaces.push({
            module, node, kind: body.kind, abi: ABI_VERSION, entries, bindings, constants: consts, workgroupSize, chunks: chunksOf, preamble, epilogue,
            consumers: [...new Set(requests.map(r => r.operation))], paths: requests.map(r => r.path), interfaceHash: await canonicalHash(body),
        });
    }
    return diagnostics.length ? { ok: false, graph: x.hash, diagnostics } : { ok: true, graph: x.hash, interfaces: interfaces.sort((a, b) => (a.module < b.module ? -1 : 1)) };
}

/** createBatch's own group 0: the camera at 0 and the batch's instance storage at 1, bound by the engine. */
function engineGroup(create: Op): InterfaceBinding[] {
    return [
        { group: 0, binding: 0, name: 'camera', declaration: '@group(0) @binding(0) var<uniform> camera: Camera;', resource: '@host#camera', access: 'uniform', version: null, boundBy: 'engine' },
        { group: 0, binding: 1, name: 'ecs', declaration: '@group(0) @binding(1) var<storage, read> ecs: array<f32>;', resource: `${create.node}#storage`, access: 'read', version: null, boundBy: 'engine' },
    ];
}

const kindName = (adapterId: string): ModuleInterface['kind'] =>
    (adapterId === 'ng.compute.stage' ? 'compute' : adapterId === 'ng.render.custom_batch' ? 'custom_batch' : 'fullscreen');

/** The modules whose interface changed between two derivations, or which are new: what EA4 must write again. */
export function invalidated(before: readonly ModuleInterface[], after: readonly ModuleInterface[]): string[] {
    const was = new Map(before.map(i => [i.module, i.interfaceHash]));
    return after.filter(i => was.get(i.module) !== i.interfaceHash).map(i => i.module).sort();
}
