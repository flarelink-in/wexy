// One verified SceneSpec running on NullGraph. The shape mirrors the film tool's scene contract
// (tools/film/SCENE-AUTHORING.md): step() advances the simulation by one fixed dt, view() places
// the camera at a film time, draw() returns the render sequence. Live preview and lockstep export
// drive the same three calls, which is what makes the export deterministic. A world's program is either
// h1's functions, wrapped in the host's modules (contract/host.ts), or whole hooks against the host header
// (contract/wgsl.ts); the runtime is the same either way.

import { Camera } from 'null-graph';
import type { ComputeStageNode, NullGraph, RenderBatch, RenderPassNode } from 'null-graph';
import { assembleModule } from '../contract/host';
import { QUALITY_UNIFORM, type SceneSpec } from '../contract/spec';
import { eyeOf, firstView, type CameraView } from './camera-path';
import { buildPostChain, type PostHandles } from './post';
import { clampParticleCount, PARTICLE_STRIDE, seedParticles } from './spawn';
import { bindingUse, hookHeader, paramsBytes, SIM_BYTES, stripComments } from '../contract/wgsl';
import type { WorldRuntime } from './world';

type SequenceNode = ComputeStageNode | RenderPassNode;

export interface SmokeResult {
    ok: boolean;
    /** Build + seed + warm-up + one frame, until the GPU reports the work done. */
    ms: number;
    error?: string;
}

/** The three modules a world compiles, whichever setting wrote them. */
export interface SceneModules {
    evolve: string;
    particles: string;
    backdrop?: string;
    /** An expert backdrop may write exact depth so particles sort against its surfaces. */
    backdropWritesDepth: boolean;
}

/** The modules of a spec, assembled (functions) or headed (hooks). A missing function is an error, said here. */
export function modulesOf(spec: SceneSpec): SceneModules {
    const { program, uniforms } = spec;
    switch (program.kind) {
        case 'functions': {
            for (const fn of ['evolve', 'look'] as const) {
                if (!program[fn]) throw new Error(`The world has no ${fn} function.`);
            }
            if (spec.sky === 'function' && !program.sky) throw new Error('The world has a painted sky but no sky function.');
            return {
                evolve: assembleModule('evolve', program.evolve!, uniforms).code,
                particles: assembleModule('look', program.look!, uniforms).code,
                backdrop: spec.sky === 'function' ? assembleModule('sky', program.sky!, uniforms).code : undefined,
                backdropWritesDepth: false,
            };
        }
        case 'hooks':
            return {
                evolve: hookHeader('evolve', uniforms) + program.evolve,
                particles: hookHeader('particles', uniforms) + program.particles,
                backdrop: program.backdrop === undefined ? undefined : hookHeader('backdrop', uniforms) + program.backdrop,
                backdropWritesDepth: Boolean(program.backdrop && /frag_depth/.test(stripComments(program.backdrop))),
            };
    }
}

// One blend state for every particle sprite: premultiplied color, where alpha 0 adds (glow) and
// alpha 1 covers (petals, lanterns). The look picks per fragment; the host never has to ask.
const PREMULTIPLIED: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class SceneRuntime implements WorldRuntime {
    readonly spec: SceneSpec;
    readonly count: number;
    readonly post: PostHandles;
    readonly params: Float32Array<ArrayBuffer>;
    /** Seconds of simulated time since the last reset, and evolve steps taken. */
    simTime = 0;
    frame = 0;

    private readonly engine: NullGraph;
    private readonly device: GPUDevice;
    private readonly camera: Camera;
    private readonly pass: RenderPassNode;
    private readonly batches: RenderBatch[] = [];
    private readonly particles: RenderBatch;
    /** The world's one compute stage: removed from the engine with the world. */
    private readonly evolve: ComputeStageNode;
    private readonly evolveSequence: SequenceNode[];
    private readonly simBuffer: GPUBuffer;
    private readonly paramsBuffer: GPUBuffer;
    private readonly seed: Float32Array;
    private readonly simWords = new ArrayBuffer(SIM_BYTES);
    private readonly simF32 = new Float32Array(this.simWords);
    private readonly simU32 = new Uint32Array(this.simWords);
    private readonly paramIndex = new Map<string, number>();
    private drawSequence: SequenceNode[] = [];
    private aspect: number;
    /** Its canvas's pixels now (width × height): what its post chain's targets are sized at. */
    private pixels: number;
    private paramsDirty = true;
    private destroyed = false;

    /**
     * Build the scene inside validation and out-of-memory scopes, then run the smoke step: seed,
     * warm up and render one frame. Anything the gate could not see (bind-group layouts, blend
     * targets, memory) fails here instead of as an uncaptured error mid-preview. The probe (rung L5) builds
     * smaller worlds of the same spec (`count`) and only places them (`warmUp: false`): it times a step before
     * any warm-up runs, and warms up the worlds it keeps in batches of its own (F4).
     */
    static async build(engine: NullGraph, spec: SceneSpec, width: number, height: number, options: { count?: number; warmUp?: boolean } = {}): Promise<{ runtime?: SceneRuntime; smoke: SmokeResult }> {
        const { device } = engine;
        const t0 = performance.now();
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
        let runtime: SceneRuntime | undefined;
        let thrown: unknown;
        try {
            runtime = new SceneRuntime(engine, spec, width, height, options.count);
            if (options.warmUp === false) runtime.place();
            else runtime.reset();
            runtime.view(firstView(spec.camera.keyframes), 0);
            engine.render(runtime.draw());
        } catch (error) {
            thrown = error;
        }
        const validation = await device.popErrorScope();
        const oom = await device.popErrorScope();
        await device.queue.onSubmittedWorkDone();
        const ms = performance.now() - t0;
        const error = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : validation?.message ?? oom?.message;
        if (error) {
            runtime?.destroy();
            return { smoke: { ok: false, ms, error } };
        }
        return { runtime, smoke: { ok: true, ms } };
    }

    private constructor(engine: NullGraph, spec: SceneSpec, width: number, height: number, countOverride?: number) {
        this.engine = engine;
        this.device = engine.device;
        this.spec = spec;
        this.count = clampParticleCount(countOverride ?? spec.particles.count, this.device);
        this.aspect = width / height;
        this.pixels = width * height;
        const { uniforms } = spec;
        const modules = modulesOf(spec);

        // The chain first: the scene pass renders into the HDR (and depth) targets it owns. A
        // backdrop that writes frag_depth is a validation error in a pass without depth.
        this.post = buildPostChain(engine, spec.post, modules.backdropWritesDepth);
        this.post.chain.resize(width, height);
        this.pass = engine.createPass({
            name: `wexy/${spec.title}`,
            isMainScreenPass: false,
            ...this.post.chain.sceneAttachments({ clearValue: { r: 0, g: 0, b: 0, a: 1 } }),
        });

        Object.entries(uniforms).forEach(([name], i) => this.paramIndex.set(name, i));
        this.params = new Float32Array(paramsBytes(uniforms) / 4);
        Object.values(uniforms).forEach((u, i) => { this.params[i] = u.value; });
        this.paramsBuffer = this.device.createBuffer({
            label: 'wexy/params', size: paramsBytes(uniforms), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.simBuffer = this.device.createBuffer({
            label: 'wexy/sim', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // Group 1 of a render stage: params at 0, sim at 1, each bound only where the module reads it.
        const renderGroup = (code: string): GPUBindGroupEntry[] => {
            const use = bindingUse(code);
            const entries: GPUBindGroupEntry[] = [];
            if (use.params) entries.push({ binding: 0, resource: { buffer: this.paramsBuffer } });
            if (use.sim) entries.push({ binding: 1, resource: { buffer: this.simBuffer } });
            return entries;
        };

        if (modules.backdrop !== undefined) {
            const backdrop = engine.createBatch(this.pass, {
                label: 'wexy/backdrop',
                shaderCode: modules.backdrop,
                strideFloats: PARTICLE_STRIDE,
                maxInstances: 1,
                targetFormat: 'rgba16float',
                depthWriteEnabled: this.post.depth && modules.backdropWritesDepth,
                depthCompare: 'always',
            });
            engine.updateBatchData(backdrop, new Float32Array(PARTICLE_STRIDE), 1);
            const group = renderGroup(modules.backdrop);
            if (group.length) engine.setRenderPassBindGroup(backdrop, group, 1);
            this.batches.push(backdrop);
        }

        this.particles = engine.createBatch(this.pass, {
            label: 'wexy/particles',
            shaderCode: modules.particles,
            strideFloats: PARTICLE_STRIDE,
            maxInstances: this.count,
            targetFormat: 'rgba16float',
            depthWriteEnabled: false,
            depthCompare: 'less',
            blend: PREMULTIPLIED,
        });
        const particleGroup = renderGroup(modules.particles);
        if (particleGroup.length) engine.setRenderPassBindGroup(this.particles, particleGroup, 1);
        this.batches.push(this.particles);

        this.seed = seedParticles(spec.particles, this.count);

        const evolve = engine.createComputeStage({
            name: 'wexy/evolve',
            shaderCode: modules.evolve,
            dispatchCount: [Math.ceil(this.count / 128), 1, 1],
        });
        // Bind exactly what the module reads: the auto layout has no slot for an unused binding.
        const use = bindingUse(modules.evolve);
        const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: this.particles.storageBuffer } }];
        if (use.sim) entries.push({ binding: 1, resource: { buffer: this.simBuffer } });
        if (use.params) entries.push({ binding: 2, resource: { buffer: this.paramsBuffer } });
        engine.setComputePassBindGroup(evolve, entries);
        this.evolve = evolve;
        this.evolveSequence = [evolve];

        this.camera = new Camera(firstView(spec.camera.keyframes).fov, this.aspect, 0.1, 200);
        this.drawSequence = [this.pass, ...this.post.chain.getPassSequence()];
    }

    get uniformNames(): string[] {
        return [...this.paramIndex.keys()];
    }

    /** The particles' storage buffer: count × 32 bytes, (pos, phase, b) per particle. Read by the sanity rung. */
    get particleBuffer(): GPUBuffer {
        return this.particles.storageBuffer;
    }

    /**
     * What this world holds on the device, for the stage's ledger beside an agent world's Run (EA5.3, I7): its particles,
     * its uniforms, and its post chain's targets as null-graph's pool reports them. From the sizes, not a VRAM measurement.
     */
    get deviceBytes(): number {
        return this.count * PARTICLE_STRIDE * 4 + this.paramsBuffer.size + this.simBuffer.size + this.post.chain.memoryReport().bytes;
    }

    /**
     * What it would hold with its canvas at `pixels` (width × height), and never less than it holds now: its post chain's
     * targets are sized as fractions of the canvas, so they scale with its pixels; the rest does not. Rounded up. The
     * stage's ledger counts a Head at the largest canvas the viewport can give it, so a resize does not outgrow its
     * reservation (EA9.3's review).
     */
    deviceBytesAt(pixels: number): number {
        const post = this.post.chain.memoryReport().bytes;
        const scaled = Math.ceil(post * Math.max(0, pixels) / Math.max(1, this.pixels));
        return this.deviceBytes - post + Math.max(post, scaled);
    }

    /** The spec's fixed step (WorldRuntime): snapped to 1/60/k by rung L0, so a film holds whole steps. */
    get dt(): number {
        return this.spec.particles.dt;
    }

    /** The lowest preview quality the hook allows, or null when it has no quality knob. */
    get qualityFloor(): number | null {
        const u = this.spec.uniforms[QUALITY_UNIFORM];
        return u ? u.min : null;
    }

    get quality(): number {
        return this.paramIndex.has(QUALITY_UNIFORM) ? this.getParam(QUALITY_UNIFORM) : 1;
    }

    set quality(q: number) {
        this.setParam(QUALITY_UNIFORM, q);
    }

    getParam(name: string): number {
        return this.params[this.paramIndex.get(name) ?? -1] ?? 0;
    }

    setParam(name: string, value: number): void {
        const i = this.paramIndex.get(name);
        if (i === undefined) return;
        this.params[i] = value;
        this.paramsDirty = true;
    }

    /** The steps of the spec's warm-up. */
    get warmupSteps(): number {
        return Math.round(this.spec.particles.warmupSeconds / this.spec.particles.dt);
    }

    /** Re-seed, place the particles and run the warm-up: the state every export starts from. */
    reset(): void {
        this.place();
        for (let i = 0; i < this.warmupSteps; i++) this.step();
        this.restartClock();
    }

    /**
     * Re-seed and place the particles, without the warm-up: a film's runner owns that (film.ts). Step zero
     * places every particle (a.xyz are seeded as zero), as the film scenes do.
     */
    place(): void {
        this.engine.updateBatchData(this.particles, this.seed, this.count);
        this.restartClock();
        this.step();
    }

    /** Start the clock again at zero, as reset() does once its warm-up is done. */
    restartClock(): void {
        this.simTime = 0;
        this.frame = 0;
    }

    /**
     * Take another runtime's state: its particles (a copy on the GPU: both live on one device), its clock and
     * its parameters. Both must be built from one spec. A photo of what the preview shows now (film.ts).
     */
    copyStateFrom(other: SceneRuntime): void {
        if (other.count !== this.count || other.spec.particles.seed !== this.spec.particles.seed) {
            throw new Error('copyStateFrom: the runtimes were built from different scenes.');
        }
        const encoder = this.device.createCommandEncoder({ label: 'wexy/copy state' });
        encoder.copyBufferToBuffer(other.particles.storageBuffer, 0, this.particles.storageBuffer, 0, this.count * PARTICLE_STRIDE * 4);
        this.device.queue.submit([encoder.finish()]);
        this.simTime = other.simTime;
        this.frame = other.frame;
        for (const name of other.uniformNames) this.setParam(name, other.getParam(name));
    }

    /** Advance one fixed dt. Each step is its own submit, so `sim` is current for every dispatch. */
    step(): void {
        this.flushParams();
        this.simF32[0] = this.spec.particles.dt;
        this.simF32[1] = this.simTime;
        this.simU32[2] = this.frame;
        this.simU32[3] = this.count;
        this.device.queue.writeBuffer(this.simBuffer, 0, this.simWords);
        this.engine.render(this.evolveSequence);
        this.simTime += this.spec.particles.dt;
        this.frame++;
    }

    view(v: CameraView, seconds: number): void {
        if (v.fov !== this.camera.fovDegrees) {
            this.camera.fovDegrees = v.fov;
            this.camera.updateProjection(this.aspect);
        }
        this.camera.updateView(eyeOf(v), v.target);
        this.camera.updateTime(seconds);
        this.engine.updateCamera(this.camera);
    }

    draw(): SequenceNode[] {
        this.flushParams();
        this.post.chain.upload();
        return this.drawSequence;
    }

    /** Call after engine.resize(): the post targets and the projection follow the canvas. */
    resize(width: number, height: number): void {
        this.aspect = width / height;
        this.pixels = width * height;
        this.post.chain.resize(width, height);
        this.camera.updateProjection(this.aspect);
        this.drawSequence = [this.pass, ...this.post.chain.getPassSequence()];
    }

    /**
     * Free what this world made, and only that: a studio rebuilds worlds on every prompt, and since EA5 the world just
     * installed (an agent world among them) shares the engine while this one goes (the EA5 review's H1). clearBatch()
     * frees each batch's storage and drops it from the engine's list; the post chain's destroy() releases its own batches
     * and passes (null-graph 1.2.1); this world's pass and evolve stage are removed by name. clearPasses() and
     * clearBatches() would forget every world's, and the stage was never removed before 1.2.1.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const batch of this.batches) this.engine.clearBatch(this.pass, batch);
        this.post.chain.destroy();
        this.engine.removePass(this.pass);
        this.engine.removeComputeStage(this.evolve);
        this.simBuffer.destroy();
        this.paramsBuffer.destroy();
    }

    private flushParams(): void {
        if (!this.paramsDirty) return;
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
        this.paramsDirty = false;
    }
}
