// The nine Tier-1 adapters' resolve functions (engine-adapters-design.md §5, EA3.2): trusted host code beside the
// descriptor data, never copied as data (Q74). Each turns one checked node, the outputs wired into it and P into a
// contribution: the resources it allocates, with owner and bytes; the operations it adds, with phase, accesses and the
// host call EA5 makes; the outputs it hands on; the modules it needs. Every number is null-graph 1.2.1's as
// installed, and test/resolve.test.mjs pins each against the engine itself through a recording fake device (no GPU):
// Primitives' counts, the materials' uniforms, LightSystem's buffer, PostChain's pool. The host's own part (the main
// pass, the camera, the depth target) is here too, since every draw writes it. Since EA5.0 every release is 1.2.1's
// (Q86 (a)): a compute stage and the main pass are removed from the engine one by one, and PostChain's destroy()
// releases the batches and passes it registered, so a replaced world leaves nothing behind. A batch's instances adopt
// its own storage where eligible (Q76(b), resolve.ts's `adoptions`), and are copied into it otherwise.

import type { BufferLayout, CheckedNode, ResolveCode } from './index';
import type { ObjectKind, OperationKind, Phase, Retention, StaticPolicy, XAccess, XModuleRequest, XObject, XOperation, XResource, XWork } from './graph';

/** What a node's output hands the nodes wired to it. */
export type Produced =
    | { kind: 'storage_buffer'; resource: string; layout: BufferLayout; strideFloats: number; elements: number; pingPong: boolean }
    | { kind: 'geometry'; vertices: string; indices: string; indexCount: number; indexFormat: 'uint16' | 'uint32' }
    | { kind: 'material'; uniform: string; material: string }
    | { kind: 'lights'; buffer: string }
    | { kind: 'color'; resource: string }
    /** A compute stage's work in its phase (its dispatch and swaps), for a stage that names it in `after` (Q77). */
    | { kind: 'stage'; operations: string[]; phase: Phase };

/** One input as resolved: its port, the node it comes from, what that node made, and its pointer in the program. */
export interface Wired {
    port: string;
    nodeId: string;
    from: Produced;
    path: string;
}

/**
 * The main pass every draw writes. With a post chain it renders into the chain's scene color and depth (h1's
 * pattern: `createPass({ isMainScreenPass: false, ...chain.sceneAttachments() })`, src/runtime/scene-runtime.ts);
 * without one it is the engine's main screen pass, with the engine's depth target.
 */
export interface Frame {
    color: string;
    depth: string;
    /** The batches' target format: the chain's rgba16float, or the canvas's preferred format. */
    colorFormat: string;
    post: string | null;
}

/**
 * Where an `upload` buffer's first content comes from (Q80, decided). Tier 1 has none, and the manifest gates `upload`
 * at the node check; Tier 2 lifts the gate and supplies its assets here, with no change to the buffer's adapter code.
 * X names the content by its source, id and hash, never by its bytes.
 */
export interface ContentSource {
    /** The seed for a buffer node, of `bytes` bytes for each of its allocations; or null when this source has none. */
    contentFor(node: string, bytes: number): { source: string; id: string; sha256: string } | null;
}

/** Tier 1's content source: nothing. */
export const NO_CONTENT: ContentSource = Object.freeze({ contentFor: () => null });

export interface Context {
    node: CheckedNode;
    /** The node's JSON pointer in the program. */
    path: string;
    inputs: Wired[];
    frame: Frame;
    policy: StaticPolicy;
    content: ContentSource;
    /** Q76(b): each adopted buffer node, by the batch whose own storage it is (resolve.ts's `adoptions`). */
    adoption: ReadonlyMap<string, string>;
}

export interface Contribution {
    resources: XResource[];
    objects: XObject[];
    operations: XOperation[];
    outputs: Record<string, Produced>;
    modules: XModuleRequest[];
    /** JSON pointers for a contributed id beyond its node's own. */
    sources: Record<string, string[]>;
}

export interface Refusal {
    refused: true;
    code: ResolveCode;
    path: string;
    message: string;
}

export const HOST = '@host';
const NODE = /^[a-z][A-Za-z0-9_-]{0,39}$/;
const LOCAL = /^[a-z][A-Za-z0-9_.]{0,47}$/;

/** An X id, `<node>#<local>`: a node id has no `#` or `@` and a local no `#`, so each id reads back one way (§6). */
export function xid(node: string, local: string): string {
    if (!LOCAL.test(local) || (node !== HOST && !NODE.test(node))) throw new Error(`EA3: "${node}#${local}" is not an X id`);
    return `${node}#${local}`;
}

/** A size that stopped being a safe integer: unknown, so the node refuses (R7). */
export class SizeOverflow extends Error {}

/** The product of `factors`, refusing past the safe integers rather than rounding. */
export function product(...factors: number[]): number {
    let p = 1;
    for (const f of factors) {
        p *= f;
        if (!Number.isSafeInteger(p) || p < 0) throw new SizeOverflow(`${factors.join(' × ')} is not a safe integer`);
    }
    return p;
}

const NO_WORK: XWork = { workgroups: null, invocations: null, vertices: null, instances: null, bytes: null };

function operation(node: string, local: string, phase: Phase, kind: OperationKind, call: string, args: Record<string, unknown>,
    accesses: XAccess[], work: Partial<XWork> = {}, after: string[] = []): XOperation {
    return { id: xid(node, local), node, phase, kind, call, args, accesses, after, ties: [], required: true, work: { ...NO_WORK, ...work } };
}

function object(node: string, local: string, kind: ObjectKind, releasedBy: string | null, retained: Retention | null = null, count = 1): XObject {
    return { id: xid(node, local), node, kind, count, createdBy: xid(node, node === HOST ? 'pass' : 'create'), releasedBy, retained };
}

const read = (resource: string, version: XAccess['version'] = null): XAccess => ({ resource, mode: 'read', version, coverage: null });
const write = (resource: string, coverage: NonNullable<XAccess['coverage']> = 'whole', version: XAccess['version'] = null): XAccess =>
    ({ resource, mode: 'write', version, coverage });

type ResourceFields = Pick<XResource, 'kind' | 'owner' | 'bytes' | 'usage' | 'content'> & Partial<XResource>;

/** A node's allocation is made by its create and released by `releasedBy`; the host's are the engine's own or the canvas. */
function resource(node: string, local: string, r: ResourceFields): XResource {
    return {
        id: xid(node, local), node, allocations: 1, pingPong: false, layout: null, strideFloats: null, elements: null, format: null, size: null,
        resizes: false, createdBy: node === HOST ? null : xid(node, 'create'), releasedBy: null, retained: null, ...r,
    };
}

const refuse = (code: ResolveCode, path: string, message: string): Refusal => ({ refused: true, code, path, message });
const empty = (): Contribution => ({ resources: [], objects: [], operations: [], outputs: {}, modules: [], sources: {} });
const inputsOf = (ctx: Context, port: string) => ctx.inputs.filter(w => w.port === port);
/** A ping-pong buffer is read at its current half; any other at no version. */
const readBuffer = (b: Produced & { kind: 'storage_buffer' }) => read(b.resource, b.pingPong ? 'current' : null);

// ---------------------------------------------------------------------------------------------------------------
// ng.buffer.storage: GPUDevice.createBuffer (no engine export makes a storage buffer), one or a ping-pong pair.

function storageBuffer(ctx: Context): Contribution | Refusal {
    const c = ctx.node.config as { elements: number; layout: BufferLayout; strideFloats: number; pingPong: boolean; init: 'zero' | 'upload' };
    const id = ctx.node.id;
    const bytes = product(c.elements, c.strideFloats, 4);
    const out = empty();
    out.outputs.buffer = { kind: 'storage_buffer', resource: xid(id, 'buffer'), layout: c.layout, strideFloats: c.strideFloats, elements: c.elements, pingPong: c.pingPong };
    const adopter = ctx.adoption.get(id);
    if (adopter !== undefined) {
        // Q76(b): realized as its batch's own storage. createBatch allocates it, zero-filled as this buffer is declared,
        // its stages bind it as h1 binds `particles.storageBuffer`, and clearBatch alone releases it: no create and no
        // destroy of its own, one allocation and no copy.
        out.resources.push(resource(id, 'buffer', {
            kind: 'buffer', owner: 'engine', bytes, usage: ['storage', 'copy_dst', 'copy_src'], layout: c.layout, strideFloats: c.strideFloats, elements: c.elements,
            content: 'zero', createdBy: xid(adopter, 'create'), releasedBy: xid(adopter, 'clear'),
        }));
        return out;
    }
    const allocations = c.pingPong ? 2 : 1;
    // Q80: `upload` reaches here only once a gate is lifted, and refuses still without content. Tier 1 has neither.
    const seed = c.init === 'upload' ? ctx.content.contentFor(id, bytes) : null;
    if (c.init === 'upload' && !seed) {
        return refuse('EA_CAPABILITY_UNSUPPORTED', `${ctx.path}/config/init`, `${id}: no content source holds a seed for this buffer, so an upload has nothing to write; seed it with an init-phase compute stage`);
    }
    const buffer = resource(id, 'buffer', {
        kind: 'buffer', owner: 'host', bytes, allocations, pingPong: c.pingPong, usage: ['storage', 'copy_src', 'copy_dst'],
        layout: c.layout, strideFloats: c.strideFloats, elements: c.elements, content: c.init === 'upload' ? 'upload' : 'zero', releasedBy: xid(id, 'destroy'),
    });
    out.resources.push(buffer);
    out.operations.push(operation(id, 'create', 'init', 'create', 'device.createBuffer', { bytes, allocations, usage: buffer.usage }, [write(buffer.id)]));
    if (seed) {
        // The seed is the content source's, named, never copied into X. Both halves of a pair get it, so a read is safe
        // after zero, one or two fixed steps (§6).
        out.operations.push(operation(id, 'upload', 'init', 'upload', 'queue.writeBuffer', { bytes, allocations, data: seed }, [write(buffer.id)],
            { bytes: product(bytes, allocations) }));
        out.sources[xid(id, 'upload')] = [`${ctx.path}/config/init`];
    }
    out.operations.push(operation(id, 'destroy', 'dispose', 'destroy', 'buffer.destroy', {}, []));
    out.sources[buffer.id] = [`${ctx.path}/config`];
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ng.compute.stage: NullGraph.createComputeStage, a fixed 1-D dispatch. The engine's entry point is always cs_main
// (createComputeStage, dist/index.js), so the module's named entry is wrapped by the generated interface (EA3.4).

function computeStage(ctx: Context): Contribution | Refusal {
    const c = ctx.node.config as { module: string; entry: string; workgroupSize: number; invocations: number; phase: 'init' | 'fixedStep' | 'frame' };
    const id = ctx.node.id;
    const reads = inputsOf(ctx, 'reads');
    const writes = inputsOf(ctx, 'writes');
    for (const list of [reads, writes]) {
        const seen = new Set<string>();
        for (const w of list) {
            if (seen.has(w.nodeId)) return refuse('EA_RESOLVE', w.path, `${id} lists ${w.nodeId} twice in ${w.port}; a stage binds each buffer once`);
            seen.add(w.nodeId);
        }
    }
    const groups = Math.ceil(c.invocations / c.workgroupSize);
    const dispatch: [number, number, number] = [groups, 1, 1];
    const written = new Set(writes.map(w => w.nodeId));
    const accesses: XAccess[] = [];
    for (const w of reads) {
        const b = w.from as Produced & { kind: 'storage_buffer' };
        // An in-place buffer read and written is one read-write binding (WebGPU forbids aliasing a writable storage
        // binding); a ping-pong pair reads its current half and writes the next.
        if (written.has(w.nodeId) && !b.pingPong) continue;
        accesses.push(readBuffer(b));
    }
    for (const w of writes) {
        const b = w.from as Produced & { kind: 'storage_buffer' };
        if (b.pingPong) accesses.push(write(b.resource, 'unknown', 'next'));
        else accesses.push({ resource: b.resource, mode: reads.some(r => r.nodeId === w.nodeId) ? 'readwrite' : 'write', version: null, coverage: 'unknown' });
    }
    // Q81: a fixed-step stage reads the host's clock, written before each step; so the schedule writes it first.
    if (c.phase === 'fixedStep') accesses.push(read(xid(HOST, 'sim')));
    const out = empty();
    out.operations.push(operation(id, 'create', 'init', 'create', 'engine.createComputeStage',
        { module: c.module, entry: c.entry, engineEntry: 'cs_main', workgroupSize: c.workgroupSize, invocations: c.invocations, dispatch }, []));
    const run = operation(id, 'dispatch', c.phase, 'compute', 'sequence.compute', { dispatch }, accesses,
        { workgroups: dispatch, invocations: product(groups, c.workgroupSize) });
    out.operations.push(run);
    out.sources[xid(id, 'dispatch')] = [`${ctx.path}/config/invocations`, `${ctx.path}/config/workgroupSize`, `${ctx.path}/config/phase`];
    // Q77: `after` names the stages this one follows, in its own phase. An explicit dependency, so two writers of one
    // buffer are ordered by the program's word, not its listing (EA3.3's review made an unordered pair refuse).
    for (const w of inputsOf(ctx, 'after')) {
        const before = w.from as Produced & { kind: 'stage' };
        if (before.phase !== c.phase) return refuse('EA_RESOLVE', w.path, `${id} runs in ${c.phase} and ${w.nodeId} in ${before.phase}; after orders stages within one phase`);
        run.after.push(...before.operations);
    }
    // The swap follows the one write of each pair: a reader after it sees the half just written (§6).
    writes.filter(w => (w.from as { pingPong?: boolean }).pingPong).forEach((w, k) => {
        const b = w.from as Produced & { kind: 'storage_buffer' };
        out.operations.push(operation(id, `swap${k}`, c.phase, 'swap', 'pingpong.swap', { buffer: b.resource },
            [{ resource: b.resource, mode: 'readwrite', version: null, coverage: 'whole' }], {}, [xid(id, 'dispatch')]));
        out.sources[xid(id, `swap${k}`)] = [w.path];
    });
    // NullGraph.createComputeStage lists the stage in its computeStages; 1.2.1's removeComputeStage takes it out, so its
    // pipeline and bind groups go with the world (1.2.0 kept them until engine.destroy(), disclosed then).
    out.operations.push(operation(id, 'drop', 'dispose', 'destroy', 'engine.removeComputeStage', {}, []));
    out.objects.push(object(id, 'stage', 'computeStage', xid(id, 'drop')));
    // A stage that follows this one waits for its whole work: the dispatch and each swap after it.
    out.outputs.done = { kind: 'stage', operations: out.operations.filter(o => o.phase === c.phase).map(o => o.id), phase: c.phase };
    out.modules.push({ module: c.module, stage: 'compute', entry: c.entry, node: id, operation: xid(id, 'dispatch'), path: `${ctx.path}/config/module` });
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ng.geometry.primitive: one of Primitives' thirteen shapes in StandardLayout (position, normal, uv: 8 floats, 32
// bytes a vertex), uploaded by Geometry.upload through BufferManager: the vertex buffer its exact bytes, the index
// buffer rounded up to 4 (createIndexBuffer). Caller-supplied geometry is the host's to destroy (NullGraph.destroy).

/** A Primitives call under this adapter's mapping of {shape, size, segments}, and its exact counts. */
export interface PrimitiveCall {
    factory: string;
    params: number[];
    vertices: number;
    indices: number;
    indexBytes: 2 | 4;
}

/**
 * `size` is the shape's extent; `segments` its radial count, the other counts derived from it. The counts are
 * Primitives' own, pinned for every shape and every segments from 3 to 128 against the engine (EA-X3).
 */
export function primitive(shape: string, size: number, segments: number): PrimitiveCall {
    const s = segments;
    const half = Math.max(2, Math.ceil(s / 2));
    switch (shape) {
        case 'cube': return { factory: 'createCube', params: [size, size, size], vertices: 24, indices: 36, indexBytes: 2 };
        case 'octahedron': return { factory: 'createOctahedron', params: [size, size, size], vertices: 24, indices: 24, indexBytes: 2 };
        case 'plane': return { factory: 'createPlane', params: [size, size], vertices: 8, indices: 12, indexBytes: 2 };
        case 'pyramid': return { factory: 'createPyramid', params: [size, size, size], vertices: 16, indices: 18, indexBytes: 2 };
        case 'icosahedron': return { factory: 'createIcosahedron', params: [size / 2], vertices: 60, indices: 60, indexBytes: 2 };
        case 'dodecahedron': return { factory: 'createDodecahedron', params: [size / 2], vertices: 108, indices: 108, indexBytes: 2 };
        case 'tetrahedron': return { factory: 'createTetrahedron', params: [size / 2], vertices: 12, indices: 12, indexBytes: 2 };
        case 'sphere': return { factory: 'createSphere', params: [size / 2, s, half], vertices: (s + 1) * (half + 1), indices: 6 * s * (half - 1), indexBytes: 2 };
        case 'torus': {
            const tube = Math.max(3, half);
            return { factory: 'createTorus', params: [size * 0.375, size * 0.125, tube, s], vertices: (tube + 1) * (s + 1), indices: 6 * tube * s, indexBytes: 4 };
        }
        case 'cylinder': return { factory: 'createCylinder', params: [size / 2, size / 2, size, s, 1], vertices: 4 * s + 6, indices: 12 * s, indexBytes: 4 };
        case 'cone': return { factory: 'createCone', params: [size / 2, size, s, 1], vertices: 3 * s + 4, indices: 6 * s, indexBytes: 4 };
        case 'capsule': {
            const cap = Math.max(2, Math.ceil(s / 4));
            return { factory: 'createCapsule', params: [size / 4, size / 2, cap, s], vertices: (s + 1) * (2 * cap + 2), indices: 12 * s * cap, indexBytes: 4 };
        }
        case 'ring': return { factory: 'createRing', params: [size / 4, size / 2, s], vertices: 4 * s + 4, indices: 12 * s, indexBytes: 4 };
        default: throw new Error(`EA3: no primitive ${shape}`);
    }
}

/** StandardLayout's stride (geometry:VertexLayout, StandardLayout.strideBytes). */
export const VERTEX_BYTES = 32;

function geometryPrimitive(ctx: Context): Contribution {
    const c = ctx.node.config as { shape: string; size: number; segments: number };
    const id = ctx.node.id;
    const p = primitive(c.shape, c.size, c.segments);
    const vertexBytes = product(p.vertices, VERTEX_BYTES);
    const indexBytes = product(Math.ceil(product(p.indices, p.indexBytes) / 4), 4);
    const destroy = xid(id, 'destroy');
    const vertices = resource(id, 'vertices', { kind: 'buffer', owner: 'host', bytes: vertexBytes, usage: ['vertex', 'copy_dst'], elements: p.vertices, content: 'construct', releasedBy: destroy });
    const indices = resource(id, 'indices', { kind: 'buffer', owner: 'host', bytes: indexBytes, usage: ['index', 'copy_dst'], elements: p.indices, content: 'construct', releasedBy: destroy });
    const out = empty();
    out.resources.push(vertices, indices);
    out.objects.push(object(id, 'geometry', 'geometry', destroy));
    out.operations.push(operation(id, 'create', 'init', 'create', 'geometry.primitive',
        { factory: p.factory, params: p.params, layout: 'StandardLayout', vertices: p.vertices, indices: p.indices, indexFormat: p.indexBytes === 2 ? 'uint16' : 'uint32' },
        [write(vertices.id), write(indices.id)], { bytes: vertexBytes + indexBytes }));
    out.operations.push(operation(id, 'destroy', 'dispose', 'destroy', 'geometry.destroy', {}, []));
    out.outputs.geometry = { kind: 'geometry', vertices: vertices.id, indices: indices.id, indexCount: p.indices, indexFormat: p.indexBytes === 2 ? 'uint16' : 'uint32' };
    out.sources[vertices.id] = out.sources[indices.id] = [`${ctx.path}/config/shape`, `${ctx.path}/config/segments`];
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ng.material.stock: a stock material, bound at group 1 by applyToBatch; its uniform buffer is the one allocation
// (UNIFORM | COPY_DST, written in its constructor). Its textures are the engine's shared 1×1 fallbacks.

/** Each stock material's uniform buffer, bytes, as its constructor allocates it (materials.js; EA-X4 pins them). */
export const MATERIAL_UNIFORM_BYTES: Readonly<Record<string, number>> = { basic: 32, lambert: 32, emissive: 48, toon: 84, pbr: 32 };
const MATERIAL_CLASS: Readonly<Record<string, string>> = {
    basic: 'BasicMaterial', lambert: 'LambertMaterial', emissive: 'EmissiveMaterial', toon: 'ToonMaterial', pbr: 'StandardPBRMaterial',
};

function stockMaterial(ctx: Context): Contribution | Refusal {
    const c = ctx.node.config as { kind: string; baseColor: number[] };
    const id = ctx.node.id;
    if (c.kind === 'matcap') {
        return refuse('EA_CAPABILITY_UNSUPPORTED', `${ctx.path}/config/kind`,
            'materials:MatcapMaterial needs a matcap texture (matcapMap), and no Tier-1 adapter makes one; use basic, lambert, emissive, toon or pbr');
    }
    const bytes = MATERIAL_UNIFORM_BYTES[c.kind];
    const uniform = resource(id, 'uniform', { kind: 'buffer', owner: 'extra', bytes, usage: ['uniform', 'copy_dst'], content: 'construct', releasedBy: xid(id, 'destroy') });
    const out = empty();
    out.resources.push(uniform);
    // Its bind groups (applyToBatch, one a batch) are each batch's, released with it.
    out.objects.push(object(id, 'material', 'material', xid(id, 'destroy')));
    out.operations.push(operation(id, 'create', 'init', 'create', 'materials.create', { class: MATERIAL_CLASS[c.kind], options: { baseColor: c.baseColor } },
        [write(uniform.id)], { bytes }));
    out.operations.push(operation(id, 'destroy', 'dispose', 'destroy', 'material.destroy', {}, []));
    out.outputs.material = { kind: 'material', uniform: uniform.id, material: c.kind };
    out.sources[uniform.id] = [`${ctx.path}/config/kind`];
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ng.light.rig: a LightSystem of the 'standard' technique (no clustering compute: requiresCompute is false), sized to
// exactly the lights configured; one storage buffer of 16 floats a light (LightSystem.FLOATS_PER_LIGHT), bound at
// group 2 by applyToBatch.

/** LightSystem.FLOATS_PER_LIGHT × 4. */
export const LIGHT_BYTES = 64;

function lightRig(ctx: Context): Contribution {
    const c = ctx.node.config as { ambient: number[]; directional: unknown; points: unknown[] };
    const id = ctx.node.id;
    const capacity = { point: c.points.length, directional: c.directional === null ? 0 : 1, spot: 0, ambient: 1 };
    const bytes = product(capacity.point + capacity.directional + capacity.ambient, LIGHT_BYTES);
    const lights = resource(id, 'lights', {
        kind: 'buffer', owner: 'extra', bytes, usage: ['storage', 'copy_dst'], elements: bytes / LIGHT_BYTES, content: 'upload', releasedBy: xid(id, 'destroy'),
    });
    const out = empty();
    out.resources.push(lights);
    out.objects.push(object(id, 'lightSystem', 'lightSystem', xid(id, 'destroy')));
    out.operations.push(operation(id, 'create', 'init', 'create', 'lights.LightSystem', { technique: 'standard', capacity }, [write(lights.id)]));
    out.operations.push(operation(id, 'upload', 'init', 'upload', 'lights.upload', { ambient: c.ambient, directional: c.directional, points: c.points },
        [write(lights.id)], { bytes }));
    out.operations.push(operation(id, 'destroy', 'dispose', 'destroy', 'lights.destroy', {}, []));
    out.outputs.lights = { kind: 'lights', buffer: lights.id };
    out.sources[lights.id] = [`${ctx.path}/config/directional`, `${ctx.path}/config/points`];
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The batches. NullGraph.createBatch always allocates the batch's own instance storage, maxInstances × strideFloats
// × 4 bytes (STORAGE | COPY_DST | COPY_SRC), and binds it at group 0 binding 1 beside the camera; clearBatch releases
// it. A buffer wired to `instances` is that storage when the resolver adopts it (Q76(b): `args.adopts` names it, and
// the buffer has no allocation of its own); otherwise it is copied into it, each frame when anything writes it after
// init, else once at init (the resolver settles which).

function instanceCopy(ctx: Context, storage: string, from: Produced & { kind: 'storage_buffer' }, maxInstances: number): XOperation {
    const bytes = product(from.elements, from.strideFloats, 4);
    return operation(ctx.node.id, 'copy', 'frame', 'copy', 'encoder.copyBufferToBuffer', { from: from.resource, to: storage, bytes },
        [readBuffer(from), write(storage, from.elements === maxInstances ? 'whole' : 'prefix')], { bytes });
}

/** The batch's create, which allocates its storage: its own `<batch>#storage`, or the buffer it adopts. */
function batchCreate(ctx: Context, args: Record<string, unknown>, storage: string): XOperation {
    return operation(ctx.node.id, 'create', 'init', 'create', 'engine.createBatch', { pass: xid(HOST, 'pass'), ...args }, [write(storage)], {},
        [xid(HOST, 'pass')]);
}

/** Its instance buffer, when this batch adopts it as its own storage (Q76(b)); null when it copies, or has none wired. */
function adoptedBy(ctx: Context, instances: Wired | undefined): (Produced & { kind: 'storage_buffer' }) | null {
    return instances && ctx.adoption.get(instances.nodeId) === ctx.node.id ? instances.from as Produced & { kind: 'storage_buffer' } : null;
}

function meshBatch(ctx: Context): Contribution | Refusal {
    const c = ctx.node.config as { maxInstances: number };
    const id = ctx.node.id;
    const [geometry] = inputsOf(ctx, 'geometry');
    const [material] = inputsOf(ctx, 'material');
    const [instances] = inputsOf(ctx, 'instances');
    const [lights] = inputsOf(ctx, 'lights');
    const buffer = instances.from as Produced & { kind: 'storage_buffer' };
    if (buffer.elements > c.maxInstances) {
        return refuse('EA_RESOLVE', instances.path, `${instances.nodeId} holds ${buffer.elements} instances, over ${id}'s maxInstances ${c.maxInstances}`);
    }
    const g = geometry.from as Produced & { kind: 'geometry' };
    const m = material.from as Produced & { kind: 'material' };
    const l = lights ? (lights.from as Produced & { kind: 'lights' }) : null;
    const adopted = adoptedBy(ctx, instances);
    const out = empty();
    let storage: string;
    if (adopted) {
        storage = adopted.resource;
        out.sources[storage] = [`${ctx.path}/config/maxInstances`, instances.path];
    } else {
        const own = resource(id, 'storage', {
            kind: 'buffer', owner: 'engine', bytes: product(c.maxInstances, 14, 4), usage: ['storage', 'copy_dst', 'copy_src'],
            layout: 'instance14', strideFloats: 14, elements: c.maxInstances, content: 'zero', releasedBy: xid(id, 'clear'),
        });
        out.resources.push(own);
        storage = own.id;
        out.sources[storage] = [`${ctx.path}/config/maxInstances`];
    }
    out.objects.push(object(id, 'batch', 'batch', xid(id, 'clear')));
    out.operations.push(batchCreate(ctx, {
        strideFloats: 14, maxInstances: c.maxInstances, shader: { kind: 'stock', material: m.material, lights: l !== null },
        vertexLayout: 'StandardLayout', target: ctx.frame.colorFormat, depth: { write: true, compare: 'less' },
        material: material.nodeId, geometry: geometry.nodeId, lights: lights?.nodeId ?? null, ...(adopted ? { adopts: storage } : {}),
    }, storage));
    if (!adopted) {
        out.operations.push(instanceCopy(ctx, storage, buffer, c.maxInstances));
        out.sources[xid(id, 'copy')] = [instances.path];
    }
    out.operations.push(operation(id, 'draw', 'frame', 'draw', 'pass.drawBatch', { indexed: true, indexCount: g.indexCount, indexFormat: g.indexFormat, instances: buffer.elements },
        [read(storage), read(g.vertices), read(g.indices), read(m.uniform), ...(l ? [read(l.buffer)] : []), read(xid(HOST, 'camera')),
            write(ctx.frame.color, 'unknown'), write(ctx.frame.depth, 'unknown')],
        { vertices: g.indexCount, instances: buffer.elements }));
    out.operations.push(operation(id, 'clear', 'dispose', 'destroy', 'engine.clearBatch', {}, []));
    return out;
}

function customBatch(ctx: Context): Contribution | Refusal {
    const c = ctx.node.config as { module: string; vertexEntry: string; fragmentEntry: string; maxInstances: number };
    const id = ctx.node.id;
    const [geometry] = inputsOf(ctx, 'geometry');
    const [instances] = inputsOf(ctx, 'instances');
    const [lights] = inputsOf(ctx, 'lights');
    const buffer = instances ? (instances.from as Produced & { kind: 'storage_buffer' }) : null;
    if (buffer && buffer.elements > c.maxInstances) {
        return refuse('EA_RESOLVE', instances.path, `${instances.nodeId} holds ${buffer.elements} instances, over ${id}'s maxInstances ${c.maxInstances}`);
    }
    // With no instances wired, the storage createBatch binds anyway is one vec4 an instance, left zero.
    const stride = buffer ? buffer.strideFloats : 4;
    const g = geometry ? (geometry.from as Produced & { kind: 'geometry' }) : null;
    const l = lights ? (lights.from as Produced & { kind: 'lights' }) : null;
    const adopted = adoptedBy(ctx, instances);
    const drawn = buffer ? buffer.elements : c.maxInstances;
    const out = empty();
    let storage: string;
    if (adopted) {
        storage = adopted.resource;
        out.sources[storage] = [`${ctx.path}/config/maxInstances`, instances.path];
    } else {
        const own = resource(id, 'storage', {
            kind: 'buffer', owner: 'engine', bytes: product(c.maxInstances, stride, 4), usage: ['storage', 'copy_dst', 'copy_src'],
            layout: buffer ? buffer.layout : 'f32', strideFloats: stride, elements: c.maxInstances, content: 'zero', releasedBy: xid(id, 'clear'),
        });
        out.resources.push(own);
        storage = own.id;
        out.sources[storage] = [`${ctx.path}/config/maxInstances`];
    }
    out.objects.push(object(id, 'batch', 'batch', xid(id, 'clear')));
    out.operations.push(batchCreate(ctx, {
        strideFloats: stride, maxInstances: c.maxInstances,
        shader: { kind: 'module', module: c.module, vertexEntry: c.vertexEntry, fragmentEntry: c.fragmentEntry, engineEntries: ['vs_main', 'fs_main'], lights: l !== null },
        vertexLayout: g ? 'StandardLayout' : null, target: ctx.frame.colorFormat, depth: { write: true, compare: 'less' },
        geometry: geometry?.nodeId ?? null, lights: lights?.nodeId ?? null, ...(adopted ? { adopts: storage } : {}),
    }, storage));
    if (buffer && !adopted) {
        out.operations.push(instanceCopy(ctx, storage, buffer, c.maxInstances));
        out.sources[xid(id, 'copy')] = [instances.path];
    }
    // No geometry: RenderPipeline's draw(3, instances) path, a vertex stage that makes its own positions.
    const vertices = g ? g.indexCount : 3;
    out.operations.push(operation(id, 'draw', 'frame', 'draw', 'pass.drawBatch',
        g ? { indexed: true, indexCount: g.indexCount, indexFormat: g.indexFormat, instances: drawn } : { indexed: false, vertexCount: 3, instances: drawn },
        [read(storage), ...(g ? [read(g.vertices), read(g.indices)] : []), ...(l ? [read(l.buffer)] : []), read(xid(HOST, 'camera')),
            write(ctx.frame.color, 'unknown'), write(ctx.frame.depth, 'unknown')],
        { vertices, instances: drawn }));
    out.operations.push(operation(id, 'clear', 'dispose', 'destroy', 'engine.clearBatch', {}, []));
    out.modules.push({ module: c.module, stage: 'vertex', entry: c.vertexEntry, node: id, operation: xid(id, 'draw'), path: `${ctx.path}/config/vertexEntry` });
    out.modules.push({ module: c.module, stage: 'fragment', entry: c.fragmentEntry, node: id, operation: xid(id, 'draw'), path: `${ctx.path}/config/fragmentEntry` });
    return out;
}

function fullscreen(ctx: Context): Contribution {
    const c = ctx.node.config as { module: string; fragmentEntry: string };
    const id = ctx.node.id;
    const reads = inputsOf(ctx, 'reads');
    // h1's backdrop: one instance, no geometry, depth compare always and no depth write, so it never hides a mesh.
    const storage = resource(id, 'storage', {
        kind: 'buffer', owner: 'engine', bytes: product(1, 4, 4), usage: ['storage', 'copy_dst', 'copy_src'], layout: 'f32', strideFloats: 4, elements: 1, content: 'zero', releasedBy: xid(id, 'clear'),
    });
    const out = empty();
    out.resources.push(storage);
    out.objects.push(object(id, 'batch', 'batch', xid(id, 'clear')));
    out.operations.push(batchCreate(ctx, {
        strideFloats: 4, maxInstances: 1,
        shader: { kind: 'fullscreen', module: c.module, fragmentEntry: c.fragmentEntry, engineEntries: ['vs_main', 'fs_main'], vertex: 'host' },
        vertexLayout: null, target: ctx.frame.colorFormat, depth: { write: false, compare: 'always' }, reads: reads.map(w => w.nodeId),
    }, storage.id));
    // A backdrop: drawn before the pass's other draws, since it compares depth `always` and would cover them after.
    out.operations.push(operation(id, 'draw', 'frame', 'backdrop', 'pass.drawBatch', { indexed: false, vertexCount: 3, instances: 1 },
        [read(storage.id), read(xid(HOST, 'camera')), ...reads.map(w => readBuffer(w.from as Produced & { kind: 'storage_buffer' })), write(ctx.frame.color, 'unknown')],
        { vertices: 3, instances: 1 }));
    out.operations.push(operation(id, 'clear', 'dispose', 'destroy', 'engine.clearBatch', {}, []));
    out.modules.push({ module: c.module, stage: 'fragment', entry: c.fragmentEntry, node: id, operation: xid(id, 'draw'), path: `${ctx.path}/config/fragmentEntry` });
    if (reads.length) out.sources[xid(id, 'draw')] = reads.map(w => w.path);
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ng.post.chain: a PostChain over the main pass, declared with a depth24plus scene depth so the batches it follows
// keep their depth test (h1 declares it whenever depth matters; src/runtime/post.ts). Its pool holds the scene color
// and depth, each effect's own targets and one full-size target between effects; it aliases them physically, so
// counting each logical target (TransientPool.report's bytesWithoutAliasing) is the safe direction. The parameter
// arena is 256 bytes an effect. Resize frees the pool before reallocating it.

/** Bytes a texel of each format the pool uses (TransientPool's table). */
const TEXEL_BYTES: Readonly<Record<string, number>> = { rgba16float: 8, rg16float: 4, r16float: 2, r8unorm: 1, depth24plus: 4 };

interface PoolTarget {
    name: string;
    scale: number;
    format: string;
    history: boolean;
}

/** Bloom's mip count at a chain size: its default 6, fewer when the size is small (Bloom.declare). */
const bloomMips = (width: number, height: number) => Math.min(6, Math.max(1, Math.floor(Math.log2(Math.min(width, height) / 8))));

/** An effect's own pool targets, as its `declare` makes them (post.js); Bloom's count follows the chain's size. */
export function effectTargets(effect: string, width: number, height: number): PoolTarget[] {
    const t = (name: string, scale: number, format = 'rgba16float', history = false): PoolTarget => ({ name, scale, format, history });
    switch (effect) {
        case 'AutoExposure': return [t('aeLuma', 1 / 8, 'r16float'), t('aeReduce1', 1 / 32, 'r16float'), t('aeReduce2', 1 / 128, 'r16float'), t('aeState', 1e-6, 'rg16float', true)];
        case 'Bloom': {
            const mips = bloomMips(width, height);
            return [...Array.from({ length: mips }, (_, n) => t(`bloomB${n}`, 0.5 ** (n + 1))), ...Array.from({ length: mips - 1 }, (_, n) => t(`bloomU${n}`, 0.5 ** (n + 1)))];
        }
        case 'Bokeh': return [t('bokehPrepared', 0.5), t('bokehGathered', 0.5)];
        case 'Halation': return [t('halationHalf', 0.5), t('halationA', 0.25), t('halationB', 0.25), t('halationC', 0.25)];
        case 'LensFlare': return [t('flareExtract', 0.5), t('flareA', 0.25), t('flareB', 0.25), t('flareC', 0.25)];
        case 'SSAO': return [t('aoRaw', 0.5, 'r8unorm'), t('ao', 0.5, 'r8unorm')];
        default: return [];
    }
}

/**
 * The passes PostChain compiles for an effect: Bloom's prefilter, downsamples, upsamples and composite, two a mip;
 * the other multi-pass effects their own; every other effect one (EA-X5 pins them against the engine).
 */
export function effectPasses(effect: string, width: number, height: number): number {
    switch (effect) {
        case 'Bloom': return 2 * bloomMips(width, height);
        case 'AutoExposure': case 'Halation': case 'LensFlare': return 5;
        case 'Bokeh': case 'SSAO': return 3;
        default: return 1;
    }
}

/** The pool's size for a target: TransientPool.alloc's max(1, floor(base × scale)). */
const scaled = (base: number, scale: number) => Math.max(1, Math.floor(base * scale));
/** ParamArena's slice an effect: every built-in's parameters fit one 256-byte slice (EA-X5 pins it). */
export const PARAM_SLICE_BYTES = 256;
/** The batch PostChain makes for each pass it compiles, and for its debug view: one instance of 8 floats. */
export const POST_BATCH_BYTES = 32;

function postChain(ctx: Context): Contribution {
    const c = ctx.node.config as { effects: { effect: string; intensity: number }[] };
    const id = ctx.node.id;
    const { width, height } = ctx.policy.viewport;
    const destroy = xid(id, 'destroy');
    const out = empty();
    const target = (local: string, w: number, h: number, format: string, allocations = 1) => resource(id, local, {
        kind: 'texture', owner: 'extra', bytes: product(w, h, TEXEL_BYTES[format]), allocations, usage: ['render_attachment', 'texture_binding'],
        format, size: [w, h], resizes: true, content: 'pass', releasedBy: destroy,
    });
    out.resources.push(target('sceneColor', width, height, 'rgba16float'), target('sceneDepth', width, height, 'depth24plus'));
    c.effects.forEach((e, i) => {
        for (const p of effectTargets(e.effect, width, height)) {
            const r = target(`e${i}.${p.name}`, scaled(width, p.scale), scaled(height, p.scale), p.format, p.history ? 2 : 1);
            out.resources.push(r);
            out.sources[r.id] = [`${ctx.path}/config/effects/${i}`];
        }
        // Each effect but the last writes a full-size target the next reads; the last writes the screen.
        if (i < c.effects.length - 1) {
            const r = target(`chain${i + 1}`, width, height, 'rgba16float');
            out.resources.push(r);
            out.sources[r.id] = [`${ctx.path}/config/effects/${i}`];
        }
    });
    const pool = out.resources.map(r => r.id);
    const internal = pool.filter(r => r !== xid(id, 'sceneColor') && r !== xid(id, 'sceneDepth'));
    const arenaBytes = product(c.effects.length, PARAM_SLICE_BYTES);
    const params = resource(id, 'params', { kind: 'buffer', owner: 'extra', bytes: arenaBytes, usage: ['uniform', 'copy_dst'], content: 'upload', releasedBy: destroy });
    // PostChain registers a pass and a batch with the engine for each pass it compiles, and one more of each for its debug
    // view. Since 1.2.1 its destroy() releases them all (releaseEngineNodes: each batch through clearBatch, each pass
    // through removePass, the debug view's included) with its pool and arena; 1.2.0 kept them (the EA3.2 review's finding).
    const passes = c.effects.reduce((n, e) => n + effectPasses(e.effect, width, height), 0);
    const batch = { kind: 'buffer' as const, owner: 'engine' as const, bytes: POST_BATCH_BYTES, usage: ['storage', 'copy_dst', 'copy_src'], layout: 'f32' as const, strideFloats: 8, elements: 1, content: 'zero' as const };
    const batches = resource(id, 'batchStorage', { ...batch, allocations: passes, releasedBy: destroy });
    const debug = resource(id, 'debugStorage', { ...batch, releasedBy: destroy });
    out.resources.push(params, batches, debug);
    out.objects.push(object(id, 'chain', 'postChain', destroy), object(id, 'postPasses', 'postPasses', destroy, null, passes),
        object(id, 'postBatches', 'postBatches', destroy, null, passes), object(id, 'debugView', 'postDebugView', destroy));
    out.operations.push(operation(id, 'create', 'init', 'create', 'post.PostChain',
        { format: 'rgba16float', gbuffer: { depth: 'depth24plus' }, outputToScreen: true, effects: c.effects.map(e => ({ effect: e.effect, intensity: e.intensity })), passes },
        out.resources.map(r => write(r.id))));
    // h1 uploads the arena every frame (SceneRuntime.draw: chain.upload()).
    out.operations.push(operation(id, 'upload', 'frame', 'upload', 'post.upload', { bytes: arenaBytes }, [write(params.id)], { bytes: arenaBytes }));
    out.operations.push(operation(id, 'passes', 'frame', 'post', 'post.sequence', { effects: c.effects.map(e => e.effect), passes },
        [read(xid(id, 'sceneColor')), read(xid(id, 'sceneDepth')), read(params.id), ...internal.map(r => ({ resource: r, mode: 'readwrite' as const, version: null, coverage: 'whole' as const })),
            write(xid(HOST, 'screen'))]));
    out.operations.push(operation(id, 'resize', 'resize', 'resize', 'post.resize', {}, pool.map(r => write(r)), {}, [xid(HOST, 'resize')]));
    out.operations.push(operation(id, 'destroy', 'dispose', 'destroy', 'post.destroy', { passes }, []));
    out.outputs.color = { kind: 'color', resource: xid(HOST, 'screen') };
    out.sources[params.id] = [`${ctx.path}/config/effects`];
    out.sources[batches.id] = [`${ctx.path}/config/effects`];
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The host's part: what every world has and no node asked for. The camera uniform (432 bytes, WebGPUContext.init)
// and the depth target (depth24plus at the canvas size, setupDepthTexture) are the engine's own, counted but never
// released by the world; the screen is the canvas's. The main pass is created after the post chain (it takes the
// chain's scene attachments) and before every batch (createBatch takes the pass). A world with a fixed-step stage has
// the host's per-step clock too (Q81): its own buffer, made and released with the world.

export const CAMERA_BYTES = 432;
/** At most four 1×1 rgba8unorm solid textures (TextureManager.getSolidTexture) the stock materials bind by default. */
export const FALLBACK_BYTES = 16;
/**
 * The per-step clock, ea-abi.v2's `EaSim {dt, time, step, _pad}` (Q81 (b)): h1's `Sim` layout in four 32-bit words
 * (contract/wgsl.ts, SIM_BYTES; EA-I5 pins the two equal), without its particle count, which a stage here takes from
 * its buffers' constants.
 */
export const SIM_BYTES = 16;

export function hostPart(frame: Frame, policy: StaticPolicy, stockMaterials: boolean, fixedStep: boolean): Contribution {
    const { width, height } = policy.viewport;
    const out = empty();
    const camera = resource(HOST, 'camera', { kind: 'buffer', owner: 'shared', bytes: CAMERA_BYTES, usage: ['uniform', 'copy_dst'], content: 'upload' });
    const depth = resource(HOST, 'depth', {
        kind: 'texture', owner: 'shared', bytes: product(width, height, 4), usage: ['render_attachment'], format: 'depth24plus', size: [width, height], resizes: true, content: 'pass',
    });
    const screen = resource(HOST, 'screen', { kind: 'texture', owner: 'canvas', bytes: 0, usage: ['render_attachment'], format: 'canvas', size: [width, height], resizes: true, content: 'pass' });
    out.resources.push(camera, depth, screen);
    if (stockMaterials) out.resources.push(resource(HOST, 'fallbacks', { kind: 'texture', owner: 'shared', bytes: FALLBACK_BYTES, usage: ['texture_binding'], format: 'rgba8unorm', size: [1, 1], content: 'construct' }));
    out.operations.push(operation(HOST, 'pass', 'init', 'create', 'engine.createPass',
        { name: 'main', isMainScreenPass: frame.post === null, attachments: frame.post === null ? 'engine' : 'post.sceneAttachments' }, [],
        {}, frame.post === null ? [] : [xid(frame.post, 'create')]));
    out.operations.push(operation(HOST, 'updateCamera', 'frame', 'upload', 'engine.updateCamera', { bytes: CAMERA_BYTES }, [write(camera.id)], { bytes: CAMERA_BYTES }));
    out.operations.push(operation(HOST, 'clear', 'frame', 'clear', 'pass.clear', { color: [0, 0, 0, 1], depth: 1 }, [write(frame.color), write(frame.depth)]));
    out.operations.push(operation(HOST, 'resize', 'resize', 'resize', 'engine.resize', {}, [write(depth.id)]));
    if (fixedStep) {
        // h1's pattern (SceneRuntime.step): written whole before every fixed step, each step its own submit, so each step
        // reads its own time and number. dt is the host's, snapped as h1 snaps it, so a film holds whole steps.
        const sim = resource(HOST, 'sim', {
            kind: 'buffer', owner: 'host', bytes: SIM_BYTES, usage: ['uniform', 'copy_dst'], content: 'upload',
            createdBy: xid(HOST, 'createSim'), releasedBy: xid(HOST, 'destroySim'),
        });
        out.resources.push(sim);
        out.operations.push(operation(HOST, 'createSim', 'init', 'create', 'device.createBuffer', { bytes: SIM_BYTES, allocations: 1, usage: sim.usage }, [write(sim.id)]));
        out.operations.push(operation(HOST, 'updateSim', 'fixedStep', 'upload', 'queue.writeBuffer', { bytes: SIM_BYTES, fields: ['dt', 'time', 'step'] },
            [write(sim.id)], { bytes: SIM_BYTES }));
        out.operations.push(operation(HOST, 'destroySim', 'dispose', 'destroy', 'buffer.destroy', {}, []));
    }
    // The engine lists every pass it makes (createPass); 1.2.1's removePass forgets this world's main pass alone, after
    // its batches are cleared (they are each node's own dispose, which runs before the host's), so no other world's pass
    // is touched (1.2.0 had only clearPasses, which forgets every pass). A partial init runs it too.
    out.operations.push(operation(HOST, 'removePass', 'dispose', 'destroy', 'engine.removePass', { pass: xid(HOST, 'pass') }, []));
    out.objects.push(object(HOST, 'mainPass', 'pass', xid(HOST, 'removePass')));
    return out;
}

/** The trusted resolve of each Tier-1 adapter, by id; an id with none here has no implementation and refuses. */
export const IMPLEMENTATIONS: Readonly<Record<string, (ctx: Context) => Contribution | Refusal>> = {
    'ng.buffer.storage': storageBuffer,
    'ng.compute.stage': computeStage,
    'ng.geometry.primitive': geometryPrimitive,
    'ng.material.stock': stockMaterial,
    'ng.light.rig': lightRig,
    'ng.render.mesh_batch': meshBatch,
    'ng.render.custom_batch': customBatch,
    'ng.render.fullscreen': fullscreen,
    'ng.post.chain': postChain,
};
