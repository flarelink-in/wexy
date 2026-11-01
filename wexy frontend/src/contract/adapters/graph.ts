// X, the execution graph of EA3.2 (engine-adapters-design.md §2, §5, §6, §16): immutable, serializable data saying
// what a checked program needs from the engine. Every resource with its owner and bytes, every operation with its
// phase, accesses and order, the module requests, the output, an estimate and a map back to the program; nothing in
// it runs. Static only (Q75 as decided): `executable` is always false, and EA5 instantiates X only after its own
// admission. P, the static policy, is here too: versioned, injected, and in v0 made of labelled fixture limits.

import type { BufferLayout, NodePolicy } from './index';

export type Phase = 'init' | 'fixedStep' | 'frame' | 'resize' | 'dispose';

/**
 * The order the host runs them: init once (construction, then uploads and init work), fixedStep 0 to P's count a
 * presented frame, frame once a presented frame, resize on a host resize, dispose once (§6, §16).
 */
export const PHASES: readonly Phase[] = ['init', 'fixedStep', 'frame', 'resize', 'dispose'];

/** P (§16). Every limit names its unit. */
export interface StaticPolicy extends NodePolicy {
    version: string;
    /** What the numbers are; v0's are fixtures, not measurements. */
    label: string;
    /** One allocation, bytes. */
    maxBufferBytes: number;
    /** Every allocation of a world together, bytes. */
    maxTotalBytes: number;
    /** Workgroups of one dispatch, each dimension. */
    maxWorkgroupsPerDimension: number;
    /** Invocations of one dispatch. */
    maxInvocationsPerDispatch: number;
    /** Invocations of a presented frame, each fixed-step stage counted as often as P's fixed steps allow (v1). */
    maxInvocationsPerFrame: number;
    /** Workgroups of a presented frame, counted the same way (v1). */
    maxWorkgroupsPerFrame: number;
    /** Vertex invocations of a presented frame: each draw's vertices times its instances (v1). */
    maxVertexInvocationsPerFrame: number;
    /** Invocations of init, which runs once, as one submission (v1). */
    maxInvocationsInit: number;
    /** Fixed steps a presented frame, at most, catch-up included. */
    maxFixedSteps: number;
    /** The bounded viewport profile, pixels: every viewport-sized allocation is counted at this size. */
    viewport: { width: number; height: number };
    /** Operations of one X, all phases. */
    maxOperations: number;
}

/**
 * P v1 (10-30): v0's limits and, after EA3.3's review, the aggregate work of a frame and of init, so repeated work is
 * bounded and not only each dispatch. Still fixtures: a frame's limits are P's fixed steps times one dispatch's.
 */
export const POLICY_V1: StaticPolicy = {
    version: 'ea-policy.v1',
    label: 'fixture limits chosen for the tests (engine-adapters-design.md §16, v1 after EA3.3\'s review), not measured GPU numbers',
    maxNodes: 64,
    configChars: 4_096,
    maxBufferBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxWorkgroupsPerDimension: 65_535,
    maxInvocationsPerDispatch: 16_777_216,
    maxInvocationsPerFrame: 4 * 16_777_216,
    maxWorkgroupsPerFrame: 4 * 65_535,
    maxVertexInvocationsPerFrame: 67_108_864,
    maxInvocationsInit: 67_108_864,
    maxFixedSteps: 4,
    viewport: { width: 1920, height: 1080 },
    maxOperations: 256,
};

/**
 * Who releases an allocation. `host`: Wexy's code made it (the device, BufferManager) and destroys it. `engine`: the
 * engine made it for this world (a batch's storage) and `clearBatch` releases it. `extra`: an engine extra (a
 * material, LightSystem, PostChain) owns it and its own destroy() releases it. `shared`: the engine's own (the camera,
 * the depth target), which outlives the world and is counted, never released by it. `canvas`: the page's swapchain,
 * neither counted nor released.
 */
export type Owner = 'host' | 'engine' | 'extra' | 'shared' | 'canvas';

/**
 * What a resource holds before its readers: `zero` (declared zero; WebGPU zero-fills every allocation), `upload` (a
 * host write at init or each frame), `construct` (written by its constructor), `pass` (written whole by a pass each
 * frame before it is read: a render target).
 */
export type Content = 'zero' | 'upload' | 'construct' | 'pass';

export interface XResource {
    /** `<node>#<local>`; the host's are `@host#<local>`. */
    id: string;
    node: string;
    kind: 'buffer' | 'texture';
    owner: Owner;
    /** Logical bytes of one allocation at P's viewport, rounded up; 0 for the canvas. Driver padding is EA5's to measure. */
    bytes: number;
    /** How many allocations of `bytes` each: 2 for a ping-pong pair, one a pass for a post chain's batches, else 1. */
    allocations: number;
    pingPong: boolean;
    usage: string[];
    layout: BufferLayout | null;
    strideFloats: number | null;
    elements: number | null;
    format: string | null;
    /** Texels at P's viewport. */
    size: [number, number] | null;
    /** Reallocated on a host resize. */
    resizes: boolean;
    content: Content;
    /** The operation that allocates it; null for the engine's own and the canvas, which the world finds made. */
    createdBy: string | null;
    /** The dispose operation that releases it; null for the engine's own and the canvas, or when nothing can. */
    releasedBy: string | null;
    /** What still holds it after the world's dispose, and until when; null when its release is complete. */
    retained: Retention | null;
}

/**
 * A hold the world cannot release with the installed engine: disclosed, never left for a reader to find. None on
 * null-graph 1.2.1 (EA5.0); on 1.2.0 a compute stage and the post debug view's batch were kept until engine.destroy().
 */
export interface Retention {
    by: string;
    until: string;
}

export type ObjectKind = 'pass' | 'computeStage' | 'batch' | 'geometry' | 'material' | 'lightSystem' | 'postChain' | 'postPasses' | 'postBatches' | 'postDebugView';

/**
 * An engine object a world creates that X counts no bytes for (its storage, if any, is a resource), but that something
 * must let go of: a pass the engine lists, a compute stage, a batch, an extra. Each has a release or a retention.
 */
export interface XObject {
    id: string;
    node: string;
    kind: ObjectKind;
    /** How many the engine makes: a post chain's passes and batches, one a pass. */
    count: number;
    createdBy: string;
    releasedBy: string | null;
    retained: Retention | null;
}

/** `backdrop` is a fullscreen draw: it draws before the main pass's other draws, wherever the program lists it. */
export type OperationKind = 'create' | 'upload' | 'compute' | 'swap' | 'copy' | 'clear' | 'backdrop' | 'draw' | 'post' | 'resize' | 'destroy';

export interface XAccess {
    resource: string;
    mode: 'read' | 'write' | 'readwrite';
    /** A ping-pong pair's half: `current` before this step's swap, `next` the one being written; null otherwise. */
    version: 'current' | 'next' | null;
    /** How much a write covers: all of it, the drawn prefix, or what an authored module chooses; null for a read. */
    coverage: 'whole' | 'prefix' | 'unknown' | null;
}

export interface XWork {
    workgroups: [number, number, number] | null;
    /** Invocations a dispatch runs: workgroups × workgroup size, which rounds what was asked up. */
    invocations: number | null;
    /** A draw's vertices an instance. */
    vertices: number | null;
    instances: number | null;
    /** An upload's or a copy's bytes. */
    bytes: number | null;
}

export interface XOperation {
    /** `<node>#<local>`; the host's are `@host#<local>`. */
    id: string;
    node: string;
    phase: Phase;
    kind: OperationKind;
    /** The allowlisted host operation EA5 runs for it. */
    call: string;
    /** Its concrete arguments: plain data, never JS. */
    args: Record<string, unknown>;
    accesses: XAccess[];
    /** The operations of its phase it must follow (its direct predecessors), in schedule order. */
    after: string[];
    /**
     * The part of `after` that only the program's order decides: an earlier writer of a resource it writes, with no
     * dependency between the two. Their result depends on the listing (EA3.3 reports it).
     */
    ties: string[];
    required: boolean;
    work: XWork;
}

export interface XNode {
    id: string;
    adapterId: string;
    adapterVersion: number;
    family: string;
    /** H's status for the family when X was made: static resolution only, whatever it says. */
    status: string;
    /** Its JSON pointer in the retained program. */
    path: string;
}

/** A module a node needs, by name; EA3.4 derives its interface and EA4 writes its body. */
export interface XModuleRequest {
    module: string;
    stage: 'compute' | 'vertex' | 'fragment';
    entry: string;
    node: string;
    operation: string;
    path: string;
}

export interface XOutput {
    /** The resource the world presents. */
    color: string;
    /** The operation that writes it last in a frame. */
    producer: string;
    format: string;
    colorSpace: 'srgb';
    /** HDR to the 8-bit screen: a Tonemap effect converts; `none` leaves it to whatever wrote the screen. */
    conversion: 'tonemap' | 'none';
    /** The main pass's depth target. */
    depth: string;
}

/** Static estimates at P (§7): upper bounds where exactness is not known, never measurements. */
export interface XEstimate {
    /** Every counted allocation, bytes; a ping-pong pair twice, the canvas not at all. */
    bytes: number;
    maxAllocationBytes: number;
    /** The part reallocated on resize. */
    viewportBytes: number;
    /**
     * Bytes held while a resize runs: the engine frees its depth target and PostChain its pool before reallocating
     * (setupDepthTexture, TransientPool.resize), so at P's viewport this is `bytes`.
     */
    resizePeakBytes: number;
    /** A presented frame at P's fixed-step maximum. */
    invocationsPerFrame: number;
    workgroupsPerFrame: number;
    vertexInvocationsPerFrame: number;
    /** Init's compute, which runs once. */
    invocationsInit: number;
    copyBytesPerFrame: number;
    uploadBytesPerFrame: number;
    uploadBytesInit: number;
    operations: number;
}

export interface XSource {
    id: string;
    node: string;
    /** The adapter that made it, or `host`. */
    adapter: string;
    /** JSON pointers into the retained program; empty for the host's own, which no program wrote. */
    paths: string[];
}

export interface XIdentity {
    graph: string;
    /** Bumped whenever resolver or adapter code changes what X says, even with the descriptors' bytes unchanged. */
    resolver: string;
    engine: string;
    bundleHash: string;
    /** SHA-256 of the canonical family-to-status map this X was resolved under (the shipped H's, or a test's). */
    supportStatusHash: string;
    manifest: string;
    manifestHash: string;
    /** SHA-256 of the canonical variant gates this X was resolved under (the manifest's, or a test's that lifts one: Q80). */
    gatesHash: string;
    programHash: string;
    policyHash: string;
}

export interface ExecutionGraph {
    identity: XIdentity;
    /** Static only (Q75 as decided). */
    executable: false;
    nodes: XNode[];
    resources: XResource[];
    objects: XObject[];
    operations: XOperation[];
    schedule: Record<Phase, string[]>;
    fixedSteps: { min: 0; max: number };
    modules: XModuleRequest[];
    output: XOutput;
    estimate: XEstimate;
    sourceMap: XSource[];
    /** SHA-256 of X's canonical JSON without this field. */
    hash: string;
}
