// The engine port (EA5.2; executor-design.md §8): every effect the executor and the agent runtime ask of an engine, and
// nothing else, so the construction and its lowering are tested over a fake (test/engine-executor.test.mjs) and run
// over null-graph through one adapter (null-graph-port.ts). The port takes plain data and the handles it made; it never
// sees X, a program or a body's source other than the assembled modules the executor hands it.

/** A handle the port made: a buffer, a stage, a pass, a batch, a geometry, a material, a light system, a chain. */
export type Handle = object;

/** One entry of a bind group: a buffer by handle, at a binding. */
export interface BindEntry {
    binding: number;
    buffer: Handle;
}

/** The host's camera for a frame: the studio's view, a film's still. */
export interface CameraState {
    target: readonly [number, number, number];
    distance: number;
    azimuth: number;
    polar: number;
    fov: number;
}

/** A batch, as the executor asks for one (X's `<batch>#create` args, its shader resolved). */
export interface BatchRequest {
    label: string;
    /** The assembled module (custom, fullscreen) or the stock material's shader. */
    shaderCode: string;
    strideFloats: number;
    maxInstances: number;
    /** StandardLayout's three inputs, or none (a fullscreen triangle, or a custom batch with no geometry). */
    geometry: Handle | null;
    /** The colour target's format: the post chain's or the canvas's. */
    targetFormat: string;
    depthWrite: boolean;
    depthCompare: GPUCompareFunction;
}

export interface EnginePort {
    /** The canvas's preferred format: a batch's target when there is no post chain. */
    readonly canvasFormat: string;
    readonly width: number;
    readonly height: number;

    createBuffer(label: string, bytes: number, usage: readonly string[]): Handle;
    writeBuffer(buffer: Handle, data: ArrayBuffer): void;
    /** Zero-fills a buffer (a reset to time zero). */
    clearBuffer(buffer: Handle): void;
    destroyBuffer(buffer: Handle): void;
    /** One copy, its own submission, ordered after everything submitted before it. */
    copyBuffer(from: Handle, to: Handle, bytes: number): void;

    /** A compute stage, compiled asynchronously so the world on screen keeps drawing (1.2.0's async stages). */
    createComputeStage(label: string, shaderCode: string, workgroups: readonly [number, number, number], workgroupSize: number): Promise<Handle>;
    /** A bind group of a stage's group, made once; `useComputeGroup` installs it (no allocation per frame). */
    computeGroup(stage: Handle, group: number, entries: readonly BindEntry[]): Handle;
    useComputeGroup(stage: Handle, group: number, bindGroup: Handle): void;
    removeComputeStage(stage: Handle): void;

    /** A primitive of null-graph's Primitives in StandardLayout, uploaded. */
    primitive(factory: string, params: readonly number[]): Handle;
    destroyGeometry(geometry: Handle): void;
    material(className: string, options: Readonly<Record<string, unknown>>): Handle;
    destroyMaterial(material: Handle): void;
    /** A stock material's shader, lit by `lights` when given. */
    stockShader(material: string, lights: Handle | null): string;
    lightSystem(capacity: Readonly<Record<string, number>>): Handle;
    uploadLights(lights: Handle, rig: Readonly<Record<string, unknown>>): void;
    destroyLights(lights: Handle): void;

    /** A post chain of built-in effects, compiled at the engine's size. */
    postChain(effects: readonly { effect: string; intensity: number }[]): Handle;
    /** Its compiled passes, as a sequence spreads them. */
    postPasses(chain: Handle): readonly Handle[];
    postUpload(chain: Handle): void;
    postResize(chain: Handle, width: number, height: number): void;
    destroyPost(chain: Handle): void;

    /** The main pass: the engine's main screen pass, or a pass into `post`'s scene attachments. */
    createPass(label: string, post: Handle | null, clear: { color: readonly number[]; depth: number }): Handle;
    removePass(pass: Handle): void;
    /**
     * Points a world's final output (its post chain's screen pass, or its main pass when it has no chain) at `target`,
     * a private colour texture of the canvas format with its own depth, or back at the screen (null): EA5.3's offscreen
     * first frame draws nothing to the canvas before commit (§9).
     */
    redirectOutput?(pass: Handle | null, chain: Handle | null, target: Handle | null): void;
    /** A private target of the canvas format at this size, colour and depth (EA5.3's offscreen first frame). */
    offscreenTarget?(width: number, height: number): Handle;
    /** Its colour, read back as RGBA8 (red first, whatever the canvas format), row by row with no padding. */
    readTarget?(target: Handle): Promise<Uint8Array>;
    destroyTarget?(target: Handle): void;
    /** A buffer's first `bytes`, read back: the sanity look's f32 samples. */
    readBuffer?(buffer: Handle, bytes: number): Promise<ArrayBuffer>;
    /** Resolves once the queue has run everything submitted so far: the probe's fence. */
    settle?(): Promise<void>;
    /**
     * Runs `work` inside validation and out-of-memory error scopes pushed and popped in one synchronous section, so no
     * other work's error lands in them: the first error's message, or null (§9's explicit error checkpoints).
     */
    checkpoint?(work: () => void): Promise<string | null>;

    /** A batch, its pipeline compiled asynchronously (1.2.1's createBatchAsync); nothing allocated until it exists. */
    createBatch(pass: Handle, request: BatchRequest): Promise<Handle>;
    /** The batch's own instance storage: what an adopted buffer is (Q76(b)). */
    batchStorage(batch: Handle): Handle;
    setInstances(batch: Handle, count: number): void;
    applyMaterial(batch: Handle, material: Handle): void;
    applyLights(batch: Handle, lights: Handle): void;
    batchGroup(batch: Handle, group: number, entries: readonly BindEntry[]): Handle;
    useBatchGroup(batch: Handle, group: number, bindGroup: Handle): void;
    clearBatch(pass: Handle, batch: Handle): void;

    /** The engine's camera uniform, which compute stages read at their group 1. */
    cameraBuffer(): Handle;
    /** The host camera, made once, and written for each frame. */
    camera(): Handle;
    updateCamera(camera: Handle, view: CameraState, seconds: number, aspect: number): void;

    /** One submission of compute stages and passes, in order. */
    render(sequence: readonly Handle[]): void;
}
