// The executor (EA5.2; executor-design.md §8): X's operations on an engine, through the port, under an admission the
// coordinator (loop/executor.ts) checked. Nothing model-written decides an engine call: each operation names its
// allowlisted host call and plain-data arguments, and a call outside this table refuses the construction (EA_CALL). A
// module is assembled from the sealed body alone (I6). Compiles are asynchronous (1.2.0's createComputeStageAsync,
// 1.2.1's createBatchAsync), so the world on screen keeps drawing (P8); what a create made is kept under its id the
// moment it exists, so a stop at any await releases it (EA-D12).
//
// Construction is not submission (I3): `run` allocates, compiles and makes bounded host uploads, and queues init's GPU
// work (its dispatches, copies and swaps, and anything after the first of them, in X's order) without submitting it.
// `prepare` hands the construction to EA5.3's preparation (the bounded probe, then this deferred init, then the
// offscreen first frame); with none, it refuses, and no generated work has run. `commit` is the target's synchronous
// switch: the stage's `viewport.setRuntime`, or a film workload's attachment, so a film never touches the Head (I4).
// `release` runs one dispose operation once, on what that operation's creates made; never made, it does nothing.

import { assembleModule } from '../contract/adapters/bodies';
import type { ExecutionGraph, XOperation, XResource } from '../contract/adapters/graph';
import type { InterfaceBinding, ModuleInterface } from '../contract/adapters/interfaces';
import { cleanupFor } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { Admission, Construction, Executor } from '../loop/executor';
import type { SealedCandidate } from '../loop/snapshot';
import type { BindEntry, EnginePort, Handle } from './engine-port';
import { AgentRuntime, bufferOf, lower, maskOf, runAll, type Built, type Install, type Made } from './world-runtime';

type Graph = DeepReadonly<ExecutionGraph>;
type Op = DeepReadonly<XOperation>;
type Snapshot = DeepReadonly<SealedCandidate>;
type Iface = DeepReadonly<ModuleInterface>;
/** What a construction builds from: X, its interfaces, the sealed bodies (a sealed C, or a probe's projection of one). */
export type BuildSource = Pick<Snapshot, 'x' | 'interfaces' | 'bodies'>;

/**
 * Every call the executor runs, in any phase: the allowlist (§8). The gate refuses an X naming another before anything
 * is allocated (EA5.3); `run`, the lowering and `release` refuse it again where they meet it.
 */
export const EXECUTOR_CALLS: ReadonlySet<string> = new Set([
    // init: creates, made at once
    'device.createBuffer', 'geometry.primitive', 'materials.create', 'lights.LightSystem', 'post.PostChain', 'engine.createPass',
    'engine.createComputeStage', 'engine.createBatch',
    // init: the bounded host upload, and the GPU work deferred until the probe approves it
    'lights.upload', 'sequence.compute', 'encoder.copyBufferToBuffer', 'pingpong.swap',
    // fixedStep and frame
    'queue.writeBuffer', 'engine.updateCamera', 'pass.clear', 'pass.drawBatch', 'post.sequence', 'post.upload',
    // resize
    'post.resize', 'engine.resize',
    // dispose
    'buffer.destroy', 'engine.removeComputeStage', 'geometry.destroy', 'material.destroy', 'lights.destroy', 'engine.clearBatch', 'post.destroy',
    'engine.removePass',
]);

/** The host's fixed step (Q81 (b)): 1/60 s, which divides a frame at 30 and 60 fps. */
export const HOST_DT = 1 / 60;
/** At most this many ping-pong pairs in one bind group: its groups are made for every combination of their halves. */
export const MAX_PAIRS_A_GROUP = 3;

/** What the preparation (EA5.3) is handed: the runtime not yet committed, and init's deferred work to run. */
export interface PreparedWorld {
    readonly runtime: AgentRuntime;
    /** Init's GPU work, by operation id, in X's order: what the probe bounds before any of it runs. */
    readonly deferred: readonly string[];
    /** Runs that work at full size: only once the probe approves (I3). */
    runInit(): void;
}

export interface ExecutorTarget {
    port: EnginePort;
    /** The switch, synchronous: the stage's `viewport.setRuntime`, or a film workload's attachment (§8, §9a). */
    onCommit(runtime: AgentRuntime): void;
    /** EA5.3's preparation. Absent, `prepare` refuses: nothing generated runs before a probe approves it (I3). */
    prepare?(world: PreparedWorld): Promise<void>;
    /** The fixed step, seconds; the host's by default. */
    dt?: number;
    /** R's approved envelope, pixels (EA5.3): a resize past it pauses the world. Absent: none. */
    maxPixels?: number;
    /** Where R says it paused past its envelope (EA_RESIZE). */
    onRefusal?(message: string): void;
}

/** The executor over `target`: one construction an admission, acquiring nothing until its first `run`. */
export function createEngineExecutor(target: ExecutorTarget): Executor {
    return {
        instantiate(snapshot: Snapshot, admission: Admission, signal: AbortSignal): Construction {
            if (admission.graph !== snapshot.x.hash || admission.candidate !== snapshot.id) throw new Error('EA_CALL: this admission is for another candidate');
            return new EngineConstruction(snapshot, target, signal);
        },
    };
}

/** A probe variant built (EA5.3): its runtime and deferred init, never committed, and its release. */
export interface Variant {
    readonly world: PreparedWorld;
    /** Releases everything the variant made, each once; the failures, said, never thrown. */
    release(): string[];
}

/**
 * A probe variant (EA5.3; executor-design.md §9 step 1): a host projection of an admitted candidate, built by this same
 * allowlist on a port of its own (a headless engine adopting the device), never committed, and never admitted: the
 * candidate it projects was. Init runs in X's order and its GPU work stays deferred, as in a construction; a failure
 * releases what was attempted (cleanupFor), each once, and rethrows.
 */
export async function buildVariant(source: BuildSource, port: EnginePort, signal: AbortSignal): Promise<Variant> {
    let prepared: PreparedWorld | null = null;
    const construction = new EngineConstruction(source, { port, onCommit: () => {}, prepare: async world => { prepared = world; } }, signal);
    const creates = new Set(source.x.operations.filter(o => o.kind === 'create').map(o => o.id));
    const attempted = new Set<string>();
    try {
        for (const op of source.x.schedule.init) {
            signal.throwIfAborted();
            if (creates.has(op)) attempted.add(op);
            await construction.run(op);
        }
        signal.throwIfAborted();
        await construction.prepare();
    } catch (e) {
        for (const op of cleanupFor(source.x, attempted)) {
            try { await construction.release(op); } catch { /* every release is attempted; the build's own error is the one said */ }
        }
        throw e;
    }
    const world = prepared as PreparedWorld | null;
    if (!world) throw new Error('EA_CALL: the variant was prepared with no world');
    return {
        world,
        release: () => {
            try {
                world.runtime.destroy();
                return [];
            } catch (e) {
                return [e instanceof Error ? e.message : String(e)];
            }
        },
    };
}

/** The calls whose work init defers until the probe approves it (I3). */
const DEFERRED: ReadonlySet<string> = new Set(['sequence.compute', 'encoder.copyBufferToBuffer', 'pingpong.swap']);

/**
 * How init runs an operation, by its kind and call alone (the EA5.2 review): a create, made at once; a bounded host
 * upload; or GPU work, deferred until the probe approves it. Anything else refuses, an upload's seed in Tier 2's words.
 */
function initRole(op: Op): 'create' | 'upload' | 'work' {
    if (op.kind === 'create') return 'create';
    if (op.call === 'lights.upload') return 'upload';
    if (DEFERRED.has(op.call)) return 'work';
    if (op.call === 'queue.writeBuffer') throw new Error(`EA_CALL ${op.id}: an upload's content is Tier 2's; this build runs Tier 1`);
    throw new Error(`EA_CALL ${op.id}: ${op.call} is not one the executor runs in init`);
}

class EngineConstruction implements Construction {
    private readonly snapshot: BuildSource;
    private readonly target: ExecutorTarget;
    private readonly signal: AbortSignal;
    private readonly x: Graph;
    private readonly ops: Map<string, Op>;
    private readonly resources: Map<string, DeepReadonly<XResource>>;
    private readonly port: EnginePort;
    private readonly built: Built = { made: new Map(), buffers: new Map(), parity: new Map(), installs: [], deferred: [] };
    private readonly released = new Set<string>();
    private runtime: AgentRuntime | null = null;

    // Fields assigned by hand: Node's type stripping runs no TS parameter properties (gotchas). The admission was checked
    // by the executor's instantiate; a probe variant has none of its own (buildVariant).
    constructor(snapshot: BuildSource, target: ExecutorTarget, signal: AbortSignal) {
        this.snapshot = snapshot;
        this.target = target;
        this.signal = signal;
        this.x = snapshot.x;
        this.ops = new Map(this.x.operations.map(o => [o.id, o]));
        this.resources = new Map(this.x.resources.map(r => [r.id, r]));
        this.port = target.port;
    }

    async run(id: string): Promise<void> {
        const op = this.ops.get(id);
        if (!op || op.phase !== 'init') throw new Error(`EA_CALL ${id}: not an init operation of this X`);
        this.signal.throwIfAborted();
        switch (initRole(op)) {
            case 'create':
                // Made at once; one after init's GPU work began would run before that work, against X's order (I3).
                if (this.built.deferred.length) throw new Error(`EA_CALL ${id}: a create after init's GPU work (${this.built.deferred[0]}); X puts every create first`);
                await this.create(op);
                return;
            case 'upload':
                // Now while nothing waits before it; behind init's GPU work otherwise, so X's order survives (§8). One
                // path either way: the lowering's.
                if (this.built.deferred.length) this.built.deferred.push(id);
                else runAll(this.port, lower(this.port, this.x, this.built, [id], null));
                return;
            case 'work':
                this.built.deferred.push(id);
                return;
        }
    }

    async release(id: string): Promise<void> {
        this.releaseNow(id);
    }

    /** One dispose operation, once: on what its creates made (X's createdBy of everything it releases), if anything. */
    private releaseNow(id: string): void {
        if (this.released.has(id)) return;
        const op = this.ops.get(id);
        if (!op || op.phase !== 'dispose') throw new Error(`EA_CALL ${id}: not a dispose operation of this X`);
        this.released.add(id);
        const creates = new Set([...this.x.resources, ...this.x.objects].filter(r => r.releasedBy === id && r.createdBy !== null).map(r => r.createdBy!));
        const products = [...creates].map(c => this.built.made.get(c)).filter((m): m is Made => m !== undefined);
        for (const m of products) this.free(op, m);
    }

    async prepare(): Promise<void> {
        if (!this.target.prepare) throw new Error('EA_PROBE_UNVERIFIED: this build has no probe yet (EA5.3); no generated work was submitted');
        const runtime = this.runtime ?? (this.runtime = new AgentRuntime(this.port, this.x, this.built, {
            dt: this.target.dt ?? HOST_DT, width: this.port.width, height: this.port.height, dispose: () => this.disposeAll(),
            maxPixels: this.target.maxPixels, onRefusal: this.target.onRefusal,
        }));
        await this.target.prepare({ runtime, deferred: [...this.built.deferred], runInit: () => runtime.runInit() });
    }

    commit(): void {
        if (!this.runtime) throw new Error('EA_CALL commit: nothing was prepared');
        this.target.onCommit(this.runtime);
    }

    /** The whole dispose schedule, each release once and every one attempted, failures said together: R's destroy(). */
    private disposeAll(): void {
        const errors: string[] = [];
        for (const id of this.x.schedule.dispose) {
            try {
                this.releaseNow(id);
            } catch (e) {
                errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (errors.length) throw new Error(`EA_RELEASE ${errors.join('; ')}`);
    }

    private free(op: Op, m: Made): void {
        const p = this.port;
        switch (op.call) {
            case 'buffer.destroy': if (m.kind === 'buffers') for (const b of m.buffers) p.destroyBuffer(b); return;
            case 'engine.removeComputeStage': if (m.kind === 'stage') p.removeComputeStage(m.stage); return;
            case 'geometry.destroy': if (m.kind === 'geometry') p.destroyGeometry(m.geometry); return;
            case 'material.destroy': if (m.kind === 'material') p.destroyMaterial(m.material); return;
            case 'lights.destroy': if (m.kind === 'lights') p.destroyLights(m.lights); return;
            // clearBatch frees the buffers the engine made for the batch: its own storage, or the buffer it adopted.
            case 'engine.clearBatch': if (m.kind === 'batch') p.clearBatch(m.pass, m.batch); return;
            case 'post.destroy': if (m.kind === 'chain') p.destroyPost(m.chain); return;
            case 'engine.removePass': if (m.kind === 'pass') p.removePass(m.pass); return;
            default: throw new Error(`EA_CALL ${op.id}: ${op.call} is not one the executor releases with`);
        }
    }

    private iface(op: Op, module: string): { iface: Iface; shaderCode: string } {
        const iface = this.snapshot.interfaces.find(i => i.module === module && i.node === op.node);
        const body = this.snapshot.bodies.find(b => b.module === module);
        if (!iface || !body) throw new Error(`EA_CALL ${op.id}: module ${module} is not one this candidate sealed`);
        return { iface, shaderCode: assembleModule(iface, body.body).source };
    }

    private madeBy(id: string): Made {
        const m = this.built.made.get(id);
        if (!m) throw new Error(`EA_CALL ${id}: it made nothing, so nothing can use it`);
        return m;
    }

    /** A binding's buffer for one combination of its group's pairs' halves. */
    private bound(b: DeepReadonly<InterfaceBinding>, pairs: readonly string[], mask: number): Handle {
        if (b.resource === '@host#camera') return this.port.cameraBuffer();
        const i = pairs.indexOf(b.resource);
        if (i < 0) return bufferOf(this.built, b.resource, null);
        const half = (mask >> i) & 1;
        const buffers = this.built.buffers.get(b.resource)!;
        return buffers[b.version === 'next' ? 1 - half : half];
    }

    /** The host's groups of a stage or batch, each made for every combination of its pairs' halves, and installed. */
    private groups(target: Handle, compute: boolean, bindings: readonly DeepReadonly<InterfaceBinding>[], label: string): void {
        // A group binds what exists: every bound resource's create has run (the host's clock among them). X's order
        // makes it so (the host's creates first, each node after what it is wired to); this says so, rather than
        // relying on it (the EA5.2 review).
        for (const b of bindings) {
            const r = this.resources.get(b.resource);
            if (r?.createdBy && !this.built.made.has(r.createdBy)) {
                throw new Error(`EA_CALL ${label}: binds ${b.resource}, which ${r.createdBy} makes and has not made yet; X must order that create first`);
            }
        }
        const byGroup = new Map<number, DeepReadonly<InterfaceBinding>[]>();
        for (const b of bindings) byGroup.set(b.group, [...(byGroup.get(b.group) ?? []), b]);
        for (const [group, list] of byGroup) {
            const pairs = [...new Set(list.filter(b => b.version !== null).map(b => b.resource))];
            if (pairs.length > MAX_PAIRS_A_GROUP) throw new Error(`EA_CALL ${label}: group ${group} binds ${pairs.length} ping-pong pairs, over ${MAX_PAIRS_A_GROUP}`);
            const made: Handle[] = [];
            for (let mask = 0; mask < 1 << pairs.length; mask++) {
                const entries: BindEntry[] = list.map(b => ({ binding: b.binding, buffer: this.bound(b, pairs, mask) }));
                made.push(compute ? this.port.computeGroup(target, group, entries) : this.port.batchGroup(target, group, entries));
            }
            const install: Install = { target, compute, group, pairs, groups: made };
            this.built.installs.push(install);
            const current = made[maskOf(this.built, install)];
            if (compute) this.port.useComputeGroup(target, group, current);
            else this.port.useBatchGroup(target, group, current);
        }
    }

    /** One create: what it makes is kept under its id at once, so a stop after any await releases it. */
    private async create(op: Op): Promise<void> {
        const a = op.args as Readonly<Record<string, unknown>>;
        const p = this.port;
        const keep = (m: Made) => { this.built.made.set(op.id, m); };
        switch (op.call) {
            case 'device.createBuffer': {
                const buffers: Handle[] = [];
                keep({ kind: 'buffers', buffers });
                const resource = op.accesses[0].resource;
                for (let i = 0; i < (a.allocations as number); i++) buffers.push(p.createBuffer(`${op.id}/${i}`, a.bytes as number, a.usage as string[]));
                this.built.buffers.set(resource, buffers);
                if (buffers.length === 2) this.built.parity.set(resource, 0);
                return;
            }
            case 'geometry.primitive': keep({ kind: 'geometry', geometry: p.primitive(a.factory as string, a.params as number[]) }); return;
            case 'materials.create': keep({ kind: 'material', material: p.material(a.class as string, a.options as Record<string, unknown>) }); return;
            case 'lights.LightSystem': keep({ kind: 'lights', lights: p.lightSystem(a.capacity as Record<string, number>) }); return;
            case 'post.PostChain': keep({ kind: 'chain', chain: p.postChain(a.effects as { effect: string; intensity: number }[]) }); return;
            case 'engine.createPass': {
                const post = this.x.nodes.find(n => n.adapterId === 'ng.post.chain');
                const chain = a.attachments === 'post.sceneAttachments' && post ? this.madeBy(`${post.id}#create`) : null;
                const clear = this.ops.get('@host#clear')?.args as { color: number[]; depth: number } | undefined;
                keep({ kind: 'pass', pass: p.createPass(op.id, chain?.kind === 'chain' ? chain.chain : null, clear ?? { color: [0, 0, 0, 1], depth: 1 }) });
                return;
            }
            case 'engine.createComputeStage': {
                const { iface, shaderCode } = this.iface(op, a.module as string);
                const stage = await p.createComputeStage(op.id, shaderCode, a.dispatch as [number, number, number], a.workgroupSize as number);
                keep({ kind: 'stage', stage });
                this.groups(stage, true, iface.bindings, op.id);
                return;
            }
            case 'engine.createBatch': {
                await this.batch(op, a, keep);
                return;
            }
            default:
                throw new Error(`EA_CALL ${op.id}: ${op.call} is not one the executor runs`);
        }
    }

    private async batch(op: Op, a: Readonly<Record<string, unknown>>, keep: (m: Made) => void): Promise<void> {
        const p = this.port;
        const passMade = this.madeBy(a.pass as string);
        if (passMade.kind !== 'pass') throw new Error(`EA_CALL ${op.id}: ${String(a.pass)} is not a pass`);
        const shader = a.shader as { kind: 'stock' | 'module' | 'fullscreen'; material?: string; module?: string; lights?: boolean };
        const geometry = typeof a.geometry === 'string' ? this.madeBy(`${a.geometry}#create`) : null;
        const material = typeof a.material === 'string' ? this.madeBy(`${a.material}#create`) : null;
        const lights = typeof a.lights === 'string' ? this.madeBy(`${a.lights}#create`) : null;
        // Custom lighting stays gated (the candidate-loop design §6): the seal refuses it, and so does the executor, since
        // a module's interface declares no group 2 for LightSystem to bind (the EA5.2 review).
        if (lights && shader.kind !== 'stock') throw new Error(`EA_CALL ${op.id}: custom lighting is gated; a ${shader.kind} batch takes no lights`);
        let shaderCode: string;
        let iface: Iface | null = null;
        if (shader.kind === 'stock') {
            shaderCode = p.stockShader(shader.material!, lights?.kind === 'lights' ? lights.lights : null);
        } else {
            ({ iface, shaderCode } = this.iface(op, shader.module!));
        }
        const depth = a.depth as { write: boolean; compare: GPUCompareFunction };
        const target = a.target === 'canvas' ? p.canvasFormat : a.target as string;
        const batch = await p.createBatch(passMade.pass, {
            label: op.id, shaderCode, strideFloats: a.strideFloats as number, maxInstances: a.maxInstances as number,
            geometry: geometry?.kind === 'geometry' ? geometry.geometry : null, targetFormat: target, depthWrite: depth.write, depthCompare: depth.compare,
        });
        keep({ kind: 'batch', batch, pass: passMade.pass });
        // Its storage is what its create writes: its own, or the buffer it adopted (Q76(b)), bound by the stages after it.
        this.built.buffers.set(op.accesses[0].resource, [p.batchStorage(batch)]);
        if (material?.kind === 'material') p.applyMaterial(batch, material.material);
        if (lights?.kind === 'lights') p.applyLights(batch, lights.lights);
        const draw = this.ops.get(`${op.node}#draw`);
        p.setInstances(batch, (draw?.args as { instances?: number } | undefined)?.instances ?? 0);
        // The host's own groups (a fullscreen's reads at group 1); group 0 is the engine's.
        if (iface) {
            const hostBound = iface.bindings.filter(b => b.boundBy === 'host');
            if (hostBound.length) this.groups(batch, false, hostBound, op.id);
        }
    }
}
