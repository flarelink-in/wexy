// R, an agent world running (EA5.2; executor-design.md §8): what the construction yields, driven by the viewport as a
// WorldRuntime. Each phase of X is lowered once into ordered steps, each a submission of compute stages and passes or a
// host action between two of them (an upload, a copy, a ping-pong swap), because a NullGraph sequence holds only stages
// and passes and runs as one submission: a host action inside it would land before all of it. Every dependency and the
// draw order survive the lowering. Both halves of every ping-pong pair have their bind groups made at construction, and a
// swap installs the other one, so a step or a frame allocates nothing (coding principles §8). `draw()` runs the frame's
// host actions and earlier submissions and returns its last submission, which the viewport renders.

import type { ComputeStageNode, RenderPassNode } from 'null-graph';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { ExecutionGraph, XOperation } from '../contract/adapters/graph';
import type { CameraView } from '../runtime/camera-path';
import type { WorldRuntime } from '../runtime/world';
import type { MeshBatchState } from './bounds';
import type { EnginePort, Handle } from './engine-port';

type Graph = DeepReadonly<ExecutionGraph>;
type Op = DeepReadonly<XOperation>;

/** What a create operation made, kept under its id for its release. */
export type Made =
    | { kind: 'buffers'; buffers: Handle[] }
    | { kind: 'stage'; stage: Handle }
    | { kind: 'pass'; pass: Handle }
    | { kind: 'batch'; batch: Handle; pass: Handle }
    | { kind: 'geometry'; geometry: Handle }
    | { kind: 'material'; material: Handle }
    | { kind: 'lights'; lights: Handle }
    | { kind: 'chain'; chain: Handle };

/** A group's bind groups, one for each combination of its pairs' halves (a mask), and where it is installed. */
export interface Install {
    target: Handle;
    compute: boolean;
    group: number;
    /** The ping-pong pairs it binds, in mask order: bit i is pair i's half. */
    pairs: string[];
    groups: Handle[];
}

/** The construction's state: what each create made, every resource's buffers, the pairs' halves, the deferred init. */
export interface Built {
    made: Map<string, Made>;
    buffers: Map<string, Handle[]>;
    parity: Map<string, 0 | 1>;
    installs: Install[];
    /** Init's GPU work (dispatches, copies, swaps, and anything after the first of them), in X's order. */
    deferred: string[];
}

/** One lowered step: a submission of stages and passes, or a host action between two. */
export type Lowered = { kind: 'render'; nodes: Handle[] } | { kind: 'host'; label: string; run: () => void };

/** The installed group for the pairs' current halves. */
export function maskOf(built: Built, install: Install): number {
    return install.pairs.reduce((mask, pair, i) => mask | ((built.parity.get(pair) ?? 0) << i), 0);
}

function install(port: EnginePort, built: Built, i: Install): void {
    const group = i.groups[maskOf(built, i)];
    if (i.compute) port.useComputeGroup(i.target, i.group, group);
    else port.useBatchGroup(i.target, i.group, group);
}

/** Flips a pair's half and installs, on every stage and batch that binds it, the group made for the new halves. */
export function swap(port: EnginePort, built: Built, pair: string): void {
    built.parity.set(pair, built.parity.get(pair) === 1 ? 0 : 1);
    for (const i of built.installs) if (i.pairs.includes(pair)) install(port, built, i);
}

/** Every pair back to its first half, and the groups that bind one installed for it: time zero's bindings. */
export function resetParity(port: EnginePort, built: Built): void {
    for (const pair of built.parity.keys()) built.parity.set(pair, 0);
    for (const i of built.installs) if (i.pairs.length) install(port, built, i);
}

/** A resource's buffer, at its current half for a pair. */
export function bufferOf(built: Built, resource: string, version: 'current' | 'next' | null = 'current'): Handle {
    const buffers = built.buffers.get(resource);
    if (!buffers?.length) throw new Error(`EA_CALL ${resource}: no buffer was made for it`);
    if (buffers.length === 1 || version === null) return buffers[0];
    const half = built.parity.get(resource) ?? 0;
    return buffers[version === 'next' ? 1 - half : half];
}

const made = (built: Built, id: string): Made => {
    const m = built.made.get(id);
    if (!m) throw new Error(`EA_CALL ${id}: it made nothing, so nothing can use it`);
    return m;
};
const stageOf = (built: Built, node: string) => {
    const m = made(built, `${node}#create`);
    if (m.kind !== 'stage') throw new Error(`EA_CALL ${node}: not a compute stage`);
    return m.stage;
};
const chainOf = (built: Built, node: string) => {
    const m = made(built, `${node}#create`);
    if (m.kind !== 'chain') throw new Error(`EA_CALL ${node}: not a post chain`);
    return m.chain;
};

/** The ops of a phase, lowered in X's order: each host action closes the submission before it. */
export function lower(port: EnginePort, x: Graph, built: Built, ids: readonly string[], sim: { write(): void } | null): Lowered[] {
    const ops = new Map(x.operations.map(o => [o.id, o]));
    const out: Lowered[] = [];
    let segment: Handle[] = [];
    const flush = () => {
        if (segment.length) out.push({ kind: 'render', nodes: segment });
        segment = [];
    };
    const host = (label: string, run: () => void) => {
        flush();
        out.push({ kind: 'host', label, run });
    };
    const pass = () => {
        const m = made(built, '@host#pass');
        if (m.kind === 'pass' && !segment.includes(m.pass)) segment.push(m.pass);
    };
    for (const id of ids) {
        const op: Op = ops.get(id)!;
        const a = op.args as Readonly<Record<string, unknown>>;
        switch (op.call) {
            case 'sequence.compute': segment.push(stageOf(built, op.node)); break;
            case 'pingpong.swap': {
                const pair = a.buffer as string;
                host(id, () => swap(port, built, pair));
                break;
            }
            case 'encoder.copyBufferToBuffer': {
                const [from, to, bytes] = [a.from as string, a.to as string, a.bytes as number];
                host(id, () => port.copyBuffer(bufferOf(built, from), bufferOf(built, to), bytes));
                break;
            }
            case 'queue.writeBuffer':
                // The host's per-step clock (Q81): written whole before each step's dispatches.
                if (op.node !== '@host' || !sim) throw new Error(`EA_CALL ${id}: an upload's content is Tier 2's; this build writes only the host's clock`);
                host(id, () => sim.write());
                break;
            case 'lights.upload': {
                const m = made(built, `${op.node}#create`);
                if (m.kind !== 'lights') throw new Error(`EA_CALL ${id}: not a light rig`);
                host(id, () => port.uploadLights(m.lights, a));
                break;
            }
            case 'post.upload': {
                const chain = chainOf(built, op.node);
                host(id, () => port.postUpload(chain));
                break;
            }
            case 'engine.updateCamera': break; // the camera is view()'s, before every frame
            case 'pass.clear':
            case 'pass.drawBatch': pass(); break; // the pass clears on load and draws its batches in creation order
            case 'post.sequence': segment.push(...port.postPasses(chainOf(built, op.node))); break;
            default: throw new Error(`EA_CALL ${id}: ${op.call} is not one the executor runs in ${op.phase}`);
        }
    }
    flush();
    return out;
}

/** Runs lowered steps, every submission included. */
export function runAll(port: EnginePort, steps: readonly Lowered[]): void {
    for (const s of steps) {
        if (s.kind === 'render') port.render(s.nodes);
        else s.run();
    }
}

export interface AgentRuntimeOptions {
    /** The fixed step, seconds: the host's (Q81), dividing 1/60. */
    dt: number;
    width: number;
    height: number;
    /** Releases the whole dispose schedule, each release once (the construction's). */
    dispose: () => void;
    /**
     * The approved envelope (EA5.3; executor-design.md §9, "Resize and recovery"): at most this many pixels. A resize
     * past it pauses the world (no step, nothing drawn) and says so once through `onRefusal`; back within it, the world
     * runs again. Absent: no envelope (a probe variant's own engine).
     */
    maxPixels?: number;
    onRefusal?: (message: string) => void;
}

/** A buffer of f32 state the sanity look samples (§9 step 4): its resource, its current buffer, floats an element. */
export interface StateBuffer {
    resource: string;
    buffer: Handle;
    elements: number;
    strideFloats: number;
}

/** What a destroyed world draws: nothing (the EA5.2 review: no call after destroy() touches what it released). */
const NOTHING: (ComputeStageNode | RenderPassNode)[] = [];

/** R: an agent world as the viewport drives it. */
export class AgentRuntime implements WorldRuntime {
    readonly dt: number;
    simTime = 0;
    quality = 1;
    readonly qualityFloor = null;
    /** Fixed steps taken since time zero: the clock's `step`. */
    steps = 0;
    private readonly port: EnginePort;
    private readonly x: Graph;
    private readonly built: Built;
    private readonly fixed: Lowered[];
    private readonly init: Lowered[];
    private frame: Lowered[] = [];
    private suffix: Handle[] = [];
    private readonly camera: Handle;
    private width: number;
    private height: number;
    private aspect: number;
    private readonly dispose: () => void;
    private readonly simWords = new ArrayBuffer(16);
    private readonly simF32 = new Float32Array(this.simWords);
    private readonly simU32 = new Uint32Array(this.simWords);
    private destroyed = false;
    private readonly maxPixels: number;
    private readonly onRefusal: (message: string) => void;
    /** Resized past its envelope: it neither steps nor draws until it fits again. */
    private paused = false;

    constructor(port: EnginePort, x: Graph, built: Built, options: AgentRuntimeOptions) {
        this.port = port;
        this.x = x;
        this.built = built;
        this.dt = options.dt;
        this.width = options.width;
        this.height = options.height;
        this.aspect = options.width / options.height;
        this.dispose = options.dispose;
        this.maxPixels = options.maxPixels ?? Infinity;
        this.onRefusal = options.onRefusal ?? (() => {});
        const simBuffer = built.buffers.get('@host#sim')?.[0] ?? null;
        const sim = simBuffer ? { write: () => this.writeSim(simBuffer) } : null;
        this.fixed = lower(port, x, built, x.schedule.fixedStep, sim);
        this.init = lower(port, x, built, built.deferred, sim);
        this.camera = port.camera();
        this.lowerFrame();
    }

    /** Init's deferred GPU work, in X's order: what EA5.3's probe approves, and what reset() runs again. */
    runInit(): void {
        if (this.destroyed) return;
        runAll(this.port, this.init);
    }

    /** One fixed step: X's fixedStep schedule, the host's clock written first. */
    step(): void {
        if (this.destroyed || this.paused) return;
        runAll(this.port, this.fixed);
        this.simTime += this.dt;
        this.steps++;
    }

    /** The camera for a frame at `seconds` of simulated time, as the caller gives them (a film's frame time, too). */
    view(v: CameraView, seconds: number): void {
        if (this.destroyed) return;
        this.port.updateCamera(this.camera, v, seconds, this.aspect);
    }

    /** The frame's host actions and earlier submissions; its last submission, which the caller renders. */
    draw(): (ComputeStageNode | RenderPassNode)[] {
        if (this.destroyed || this.paused) return NOTHING;
        const steps = this.frame;
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (s.kind === 'render') {
                if (i === steps.length - 1) return s.nodes as unknown as (ComputeStageNode | RenderPassNode)[];
                this.port.render(s.nodes);
            } else s.run();
        }
        return this.suffix as unknown as (ComputeStageNode | RenderPassNode)[];
    }

    /** X's resize schedule: the post chain at the new size, the frame lowered again (its passes may have changed). */
    resize(width: number, height: number): void {
        if (this.destroyed) return;
        // Past the envelope the probe approved, no submission of this world runs at that size (P10): it waits, paused.
        if (width * height > this.maxPixels) {
            if (!this.paused) this.onRefusal(`EA_RESIZE ${width}x${height} exceeds the approved ${this.maxPixels} pixels; paused until it fits, or re-probe to grow`);
            this.paused = true;
            return;
        }
        this.paused = false;
        this.width = width;
        this.height = height;
        this.aspect = width / height;
        this.resizePost();
    }

    /**
     * Time zero (a film's calibration, EA5.5): every buffer declared zero cleared, both halves of a pair included, every
     * pair back to its first half, the clock at zero, init's deferred work run again; and the post chain re-resolved at
     * its size (the EA5.2 review), so its history targets (AutoExposure's adapted exposure) start from zero again, as at
     * construction (null-graph's pool remakes them zero-cleared). Nothing else a world holds changes after init: its
     * geometry, materials and lights are built once, its camera, clock and parameters are written whole each frame or step.
     */
    reset(): void {
        if (this.destroyed) return;
        this.rewind();
        this.resizePost();
        this.runInit();
    }

    /**
     * Time zero's state before init's work runs: every zero-declared buffer cleared, every pair at its first half, the
     * clock at zero. The probe times init again on a variant after it (EA5.3); reset() runs init after it.
     */
    rewind(): void {
        if (this.destroyed) return;
        for (const r of this.x.resources) {
            if (r.content !== 'zero') continue;
            for (const b of this.built.buffers.get(r.id) ?? []) this.port.clearBuffer(b);
        }
        resetParity(this.port, this.built);
        this.simTime = 0;
        this.steps = 0;
    }

    /**
     * Points the world's final output at a private target, or back at the screen (null): the offscreen first frame
     * (EA5.3; §9 step 3) draws nothing to the canvas before commit. The output is the post chain's last pass when the
     * world has a chain, else its main pass.
     */
    redirectOutput(target: Handle | null): void {
        if (this.destroyed) return;
        if (!this.port.redirectOutput) throw new Error('EA_CALL: this engine cannot draw a world offscreen, so no first frame is checked before commit');
        const pass = this.built.made.get('@host#pass');
        const post = this.x.nodes.find(n => n.adapterId === 'ng.post.chain');
        const chain = post ? this.built.made.get(`${post.id}#create`) : undefined;
        this.port.redirectOutput(pass?.kind === 'pass' ? pass.pass : null, chain?.kind === 'chain' ? chain.chain : null, target);
    }

    /** The f32 state the sanity look samples: each storage buffer of instances or floats, at its current half (§9 step 4). */
    stateBuffers(): StateBuffer[] {
        const out: StateBuffer[] = [];
        for (const r of this.x.resources) {
            if (r.kind !== 'buffer' || (r.layout !== 'instance14' && r.layout !== 'f32') || !r.usage.includes('copy_src')) continue;
            if (r.owner !== 'host' && r.owner !== 'engine') continue;
            if (!this.built.buffers.get(r.id)?.length || r.elements === null || r.strideFloats === null) continue;
            out.push({ resource: r.id, buffer: bufferOf(this.built, r.id), elements: r.elements, strideFloats: r.strideFloats });
        }
        return out;
    }

    /** Its mesh batches (stock materials): each one's instance buffer, the instances it draws and its geometry (bounds.ts). */
    meshBatches(): MeshBatchState[] {
        const out: MeshBatchState[] = [];
        for (const op of this.x.operations) {
            if (op.call !== 'engine.createBatch' || (op.args.shader as { kind: string }).kind !== 'stock') continue;
            const geometry = this.built.made.get(`${String(op.args.geometry)}#create`);
            const storage = op.accesses[0].resource;
            if (geometry?.kind !== 'geometry' || !this.built.buffers.get(storage)?.length) continue;
            const draw = this.x.operations.find(o => o.id === `${op.node}#draw`);
            out.push({ node: op.node, buffer: bufferOf(this.built, storage), instances: (draw?.args as { instances?: number } | undefined)?.instances ?? 0, geometry: geometry.geometry });
        }
        return out;
    }

    /** Resized past its envelope and waiting (EA5.3). */
    get isPaused(): boolean {
        return this.paused;
    }

    /** X's resize schedule at the world's size: the post chain re-resolved, the frame lowered again. */
    private resizePost(): void {
        for (const id of this.x.schedule.resize) {
            const op = this.x.operations.find(o => o.id === id)!;
            if (op.call === 'post.resize') this.port.postResize(chainOf(this.built, op.node), this.width, this.height);
            // engine.resize is the host's, made before it resizes the world (Viewport.resizeTo).
            else if (op.call !== 'engine.resize') throw new Error(`EA_CALL ${id}: ${op.call} is not one the executor runs in resize`);
        }
        this.lowerFrame();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.dispose();
    }

    private lowerFrame(): void {
        this.frame = lower(this.port, this.x, this.built, this.x.schedule.frame, null);
        this.suffix = [];
    }

    private writeSim(buffer: Handle): void {
        this.simF32[0] = this.dt;
        this.simF32[1] = this.simTime;
        this.simU32[2] = this.steps;
        this.simU32[3] = 0;
        this.port.writeBuffer(buffer, this.simWords);
    }
}
