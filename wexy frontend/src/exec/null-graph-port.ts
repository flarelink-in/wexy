// The engine port over null-graph 1.2.1 (EA5.2; executor-design.md §8): each effect the executor asks for, as h1 and
// null-graph's own examples make it. Compiles are asynchronous (createComputeStageAsync, createBatchAsync), so the world
// on screen keeps drawing; a stage's and a batch's host groups are made once against their pipeline's layout and
// installed through null-graph's own `customBindGroups`, so a swap allocates nothing. The stock materials take the
// engine's 1×1 fallback textures where a map is needed. The tests drive the executor over a fake port; this one is
// checked on the GPU (EA5.4's EA-G1).
//
// A post effect's `intensity` (the adapter's one knob, 0 to 4, no unit) multiplies the effect's own default strength,
// where it has one: 1 is the effect as null-graph tunes it, 0 is off, 4 four times. The defaults differ by orders of
// magnitude (ChromaticAberration's strength is 0.006, Bloom's intensity 0.7), so the knob is never the raw value. The
// strengths: Bloom's, FilmGrain's, Halation's, LensFlare's, SSAO's and Vignette's `intensity`, ChromaticAberration's and
// Outline's `strength`, GodRays' and Tonemap's `exposure`. The others (AutoExposure, Bokeh, CelShade, ColorGrade, FXAA,
// Kuwahara) run at their defaults.

import { Camera, NullGraph, RenderPassNode, type ComputeStageNode, type RenderBatch } from 'null-graph';
import { Primitives, StandardLayout, type Geometry } from 'null-graph/geometry';
import { AmbientLightProxy, DirectionalLightProxy, LightSystem, PointLightProxy } from 'null-graph/lights';
import {
    BasicMaterial, EmissiveMaterial, LambertMaterial, StandardPBRMaterial, ToonMaterial, buildBasicShader, buildEmissiveShader, buildLambertShader, buildPBRShader,
    buildToonShader,
} from 'null-graph/materials';
import * as post from 'null-graph/post';
import { eyeOf, type CameraView } from '../runtime/camera-path';
import type { BatchRequest, BindEntry, CameraState, EnginePort, Handle } from './engine-port';

const USAGE: Readonly<Record<string, number>> = {
    storage: GPUBufferUsage.STORAGE, copy_src: GPUBufferUsage.COPY_SRC, copy_dst: GPUBufferUsage.COPY_DST,
    uniform: GPUBufferUsage.UNIFORM, vertex: GPUBufferUsage.VERTEX, index: GPUBufferUsage.INDEX,
};

/** Which option of an effect the adapter's `intensity` sets; null: the effect runs at its defaults. */
export const EFFECT_STRENGTH: Readonly<Record<string, 'intensity' | 'strength' | 'exposure' | null>> = {
    AutoExposure: null, Bloom: 'intensity', Bokeh: null, CelShade: null, ChromaticAberration: 'strength', ColorGrade: null, FXAA: null,
    FilmGrain: 'intensity', GodRays: 'exposure', Halation: 'intensity', Kuwahara: null, LensFlare: 'intensity', Outline: 'strength', SSAO: 'intensity',
    Tonemap: 'exposure', Vignette: 'intensity',
};

type EffectClass = new (options?: Record<string, unknown>) => post.Effect;
const EFFECTS: Readonly<Record<string, EffectClass>> = {
    AutoExposure: post.AutoExposure, Bloom: post.Bloom, Bokeh: post.Bokeh, CelShade: post.CelShade, ChromaticAberration: post.ChromaticAberration,
    ColorGrade: post.ColorGrade, FXAA: post.FXAA, FilmGrain: post.FilmGrain, GodRays: post.GodRays, Halation: post.Halation, Kuwahara: post.Kuwahara,
    LensFlare: post.LensFlare, Outline: post.Outline, SSAO: post.SSAO, Tonemap: post.Tonemap, Vignette: post.Vignette,
} as unknown as Record<string, EffectClass>;

/** One effect of a chain: its defaults, its strength (if it has one) times the adapter's intensity. */
export function makeEffect(name: string, intensity: number): post.Effect {
    const Effect = EFFECTS[name];
    if (!Effect) throw new Error(`EA_CALL: no post effect ${name}`);
    const effect = new Effect();
    const knob = EFFECT_STRENGTH[name];
    if (knob) {
        const tuned = effect as unknown as Record<string, number>;
        tuned[knob] = tuned[knob] * Math.min(4, Math.max(0, intensity));
    }
    return effect;
}

const align4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);

/** A private target for the offscreen first frame (EA5.3): colour of the canvas format, and its own depth. */
interface Offscreen {
    color: GPUTexture;
    depth: GPUTexture;
    colorView: GPUTextureView;
    depthView: GPUTextureView;
    width: number;
    height: number;
    format: GPUTextureFormat;
}

/**
 * A headless engine adopting `device`, at `width`×`height`, and its port: a probe variant's own engine (EA5.3), so its
 * screen, depth and camera are its own. Destroying it leaves the device, which it never owned.
 */
export async function createHeadlessPort(device: GPUDevice, width: number, height: number): Promise<{ port: EnginePort; resize(w: number, h: number): void; destroy(): void }> {
    const engine = new NullGraph();
    const init = await engine.init(null, { device, width, height });
    if (!init.success) {
        engine.destroy();
        throw new Error(init.error ?? 'the probe\'s engine did not start');
    }
    return { port: createNullGraphPort(engine), resize: (w, h) => engine.resize(w, h), destroy: () => engine.destroy() };
}
const usage = (names: readonly string[]) => names.reduce((flags, n) => {
    const f = USAGE[n];
    if (f === undefined) throw new Error(`EA_CALL: no buffer usage ${n}`);
    return flags | f;
}, 0);

/** The port over `engine`, an initialized NullGraph: the stage's, or a film's. */
export function createNullGraphPort(engine: NullGraph): EnginePort {
    const device = engine.device;
    const submit = (encode: (e: GPUCommandEncoder) => void) => {
        const encoder = device.createCommandEncoder();
        encode(encoder);
        device.queue.submit([encoder.finish()]);
    };
    const fallbacks = () => ({ albedoMap: engine.textureManager.fallbackWhite, normalMap: engine.textureManager.fallbackNormal });
    /** Each camera's last projection: recomputed only when the fov or the aspect moves. */
    const projected = new WeakMap<Camera, { fov: number; aspect: number }>();
    /** The screen passes each world's output was pointed away from (EA5.3), by its chain or its main pass. */
    const redirected = new WeakMap<object, RenderPassNode[]>();

    return {
        get canvasFormat() { return engine.ctx.format; },
        get width() { return engine.width; },
        get height() { return engine.height; },

        createBuffer: (label, bytes, names) => device.createBuffer({ label, size: align4(bytes), usage: usage(names) }),
        writeBuffer: (buffer, data) => device.queue.writeBuffer(buffer as GPUBuffer, 0, data),
        clearBuffer: buffer => submit(e => e.clearBuffer(buffer as GPUBuffer)),
        destroyBuffer: buffer => (buffer as GPUBuffer).destroy(),
        copyBuffer: (from, to, bytes) => submit(e => e.copyBufferToBuffer(from as GPUBuffer, 0, to as GPUBuffer, 0, align4(bytes))),

        createComputeStage: (label, shaderCode, workgroups) =>
            engine.createComputeStageAsync({ name: label, shaderCode, dispatchCount: [workgroups[0], workgroups[1], workgroups[2]] }),
        computeGroup: (stage, group, entries) => device.createBindGroup({
            label: `${(stage as ComputeStageNode).name}/group${group}`,
            layout: (stage as ComputeStageNode).computePipeline.getBindGroupLayout(group),
            entries: entries.map((e: BindEntry) => ({ binding: e.binding, resource: { buffer: e.buffer as GPUBuffer } })),
        }),
        useComputeGroup: (stage, group, bindGroup) => { (stage as ComputeStageNode).customBindGroups[group] = bindGroup as GPUBindGroup; },
        removeComputeStage: stage => { engine.removeComputeStage(stage as ComputeStageNode); },

        primitive: (factory, params) => {
            const make = (Primitives as unknown as Record<string, (layout: typeof StandardLayout, ...p: number[]) => Geometry>)[factory];
            if (typeof make !== 'function') throw new Error(`EA_CALL: no primitive ${factory}`);
            const geometry = make(StandardLayout, ...params);
            geometry.upload(engine);
            return geometry;
        },
        destroyGeometry: geometry => (geometry as Geometry).destroy(),
        material: (className, options) => {
            const baseColor = options.baseColor as [number, number, number, number];
            switch (className) {
                case 'BasicMaterial': return new BasicMaterial(engine, { baseColor });
                case 'LambertMaterial': return new LambertMaterial(engine, { baseColor });
                case 'EmissiveMaterial': return new EmissiveMaterial(engine, { baseColor });
                case 'ToonMaterial': return new ToonMaterial(engine, { ...fallbacks(), baseColor });
                case 'StandardPBRMaterial': return new StandardPBRMaterial(engine, { ...fallbacks(), packedMap: engine.textureManager.fallbackWhite, packedMapFormat: 'ARM', baseColor });
                default: throw new Error(`EA_CALL: no stock material ${className}`);
            }
        },
        destroyMaterial: material => (material as { destroy(): void }).destroy(),
        stockShader: (kind, lights) => {
            const config = { useSkinning: false, lighting: lights ? (lights as LightSystem).getShaderLayout() : undefined };
            switch (kind) {
                case 'basic': return buildBasicShader(config);
                case 'lambert': return buildLambertShader(config);
                case 'emissive': return buildEmissiveShader(config);
                case 'toon': return buildToonShader(config);
                case 'pbr': return buildPBRShader(config);
                default: throw new Error(`EA_CALL: no stock material ${kind}`);
            }
        },
        lightSystem: capacity => new LightSystem(engine, { technique: 'standard', capacity: { point: capacity.point ?? 0, directional: capacity.directional ?? 0, spot: capacity.spot ?? 0, ambient: capacity.ambient ?? 0 } }),
        uploadLights: (lights, rig) => {
            // Points first, then the sun, then the ambient: indices are the host's to assign (null-graph lights §1).
            const points = (rig.points ?? []) as { position: number[]; color: number[]; intensity: number; range: number }[];
            const sun = rig.directional as { direction: number[]; color: number[]; intensity: number } | null;
            const total = points.length + (sun ? 1 : 0) + 1;
            const data = new Float32Array(total * LightSystem.FLOATS_PER_LIGHT);
            const point = new PointLightProxy();
            point.wrap(data);
            points.forEach((p, i) => {
                point.seek(i);
                point.position = p.position as [number, number, number];
                point.color = p.color as [number, number, number];
                point.intensity = p.intensity;
                point.radius = p.range;
            });
            if (sun) {
                const d = new DirectionalLightProxy();
                d.wrap(data);
                d.seek(points.length);
                d.direction = sun.direction as [number, number, number];
                d.color = sun.color as [number, number, number];
                d.intensity = sun.intensity;
            }
            const ambient = new AmbientLightProxy();
            ambient.wrap(data);
            ambient.seek(total - 1);
            ambient.color = rig.ambient as [number, number, number];
            ambient.intensity = 1;
            (lights as LightSystem).setRawData(data);
            (lights as LightSystem).upload();
        },
        destroyLights: lights => (lights as LightSystem).destroy(),

        postChain: effects => {
            const chain = new post.PostChain(engine, { gbuffer: { depth: 'depth24plus' } });
            chain.setChain(effects.map(e => makeEffect(e.effect, e.intensity)));
            chain.resize(engine.width, engine.height);
            return chain;
        },
        postPasses: chain => (chain as post.PostChain).getPassSequence(),
        postUpload: chain => (chain as post.PostChain).upload(),
        postResize: (chain, width, height) => (chain as post.PostChain).resize(width, height),
        destroyPost: chain => (chain as post.PostChain).destroy(),

        createPass: (label, chain, clear) => {
            // With no post chain the pass is null-graph's main screen pass, whose clear its RenderPipeline fixes (colour
            // 0.05 grey, depth 1) with no option to change it: X's clear colour holds only through a chain (a null-graph
            // request in plan §5; the EA5.2 review).
            if (!chain) return engine.createPass({ name: label, isMainScreenPass: true });
            const [r, g, b, a] = clear.color;
            return engine.createPass({
                name: label, isMainScreenPass: false, ...(chain as post.PostChain).sceneAttachments({ clearValue: { r, g, b, a }, depthClearValue: clear.depth }),
            });
        },
        removePass: pass => { engine.removePass(pass as RenderPassNode); },
        redirectOutput: (pass, chain, target) => {
            const key = (chain ?? pass) as object | null;
            if (!key) throw new Error('EA_CALL: a world with no main pass has no output to point anywhere');
            if (target === null) {
                // Back at the screen: null-graph's RenderPipeline gives a main screen pass the canvas and its depth again.
                for (const node of redirected.get(key) ?? []) {
                    node.isMainScreenPass = true;
                    node.colorAttachments = [];
                    node.depthStencilAttachment = undefined;
                }
                redirected.delete(key);
                return;
            }
            // The screen passes: a chain's last pass (outputToScreen), or the main pass itself when there is no chain.
            const nodes = chain
                ? (chain as post.PostChain).getPassSequence().filter((n): n is RenderPassNode => n instanceof RenderPassNode && n.isMainScreenPass)
                : [pass as RenderPassNode].filter(n => n.isMainScreenPass);
            if (!nodes.length) throw new Error('EA_CALL: this world draws nothing to the screen, so there is no output to redirect');
            const t = target as Offscreen;
            for (const node of nodes) {
                // The clear and depth null-graph's main screen pass uses, so the private frame is what the screen would show.
                node.isMainScreenPass = false;
                node.colorAttachments = [{ view: t.colorView, clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1 }, loadOp: 'clear', storeOp: 'store' }];
                node.depthStencilAttachment = { view: t.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' };
            }
            redirected.set(key, nodes);
        },
        offscreenTarget: (width, height) => {
            const format = engine.ctx.format;
            const color = device.createTexture({ label: 'wexy/first frame', size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
            const depth = device.createTexture({ label: 'wexy/first frame depth', size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
            const t: Offscreen = { color, depth, colorView: color.createView(), depthView: depth.createView(), width, height, format };
            return t;
        },
        readTarget: async target => {
            const t = target as Offscreen;
            const bytesPerRow = Math.ceil(t.width * 4 / 256) * 256;
            const staging = device.createBuffer({ label: 'wexy/first frame read', size: bytesPerRow * t.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            try {
                submit(e => e.copyTextureToBuffer({ texture: t.color }, { buffer: staging, bytesPerRow }, [t.width, t.height]));
                await staging.mapAsync(GPUMapMode.READ);
                const src = new Uint8Array(staging.getMappedRange());
                const out = new Uint8Array(t.width * t.height * 4);
                for (let y = 0; y < t.height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + t.width * 4), y * t.width * 4);
                if (t.format.startsWith('bgra')) {
                    for (let i = 0; i < out.length; i += 4) {
                        const blue = out[i];
                        out[i] = out[i + 2];
                        out[i + 2] = blue;
                    }
                }
                return out;
            } finally {
                staging.destroy();
            }
        },
        destroyTarget: target => {
            const t = target as Offscreen;
            t.color.destroy();
            t.depth.destroy();
        },
        readBuffer: async (buffer, bytes) => {
            const size = align4(bytes);
            const staging = device.createBuffer({ label: 'wexy/state read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            try {
                submit(e => e.copyBufferToBuffer(buffer as GPUBuffer, 0, staging, 0, size));
                await staging.mapAsync(GPUMapMode.READ);
                return staging.getMappedRange(0, size).slice(0);
            } finally {
                staging.destroy();
            }
        },
        settle: () => device.queue.onSubmittedWorkDone(),
        checkpoint: async work => {
            // Pushed and popped in one synchronous section: no other work's error lands in them (§6, §9).
            device.pushErrorScope('out-of-memory');
            device.pushErrorScope('validation');
            let thrown: unknown = null;
            try {
                work();
            } catch (e) {
                thrown = e;
            }
            const validation = device.popErrorScope();
            const memory = device.popErrorScope();
            const [v, m] = await Promise.all([validation.catch((e: unknown) => ({ message: String(e) })), memory.catch((e: unknown) => ({ message: String(e) }))]);
            if (thrown !== null) return thrown instanceof Error ? thrown.message : String(thrown);
            return v?.message ?? m?.message ?? null;
        },

        createBatch: async (pass, request: BatchRequest) => {
            const geometry = request.geometry as Geometry | null;
            const batch = await engine.createBatchAsync(pass as RenderPassNode, {
                label: request.label, shaderCode: request.shaderCode, strideFloats: request.strideFloats, maxInstances: request.maxInstances,
                vertexLayouts: geometry ? geometry.layout.getWebGPUDescriptor() : [], targetFormat: request.targetFormat as GPUTextureFormat,
                depthWriteEnabled: request.depthWrite, depthCompare: request.depthCompare,
            });
            if (geometry) engine.setBatchGeometry(batch, geometry.vertexBuffer!, geometry.indexBuffer!, geometry.indices.length, geometry.indexFormat);
            return batch;
        },
        batchStorage: batch => (batch as RenderBatch).storageBuffer,
        setInstances: (batch, count) => { (batch as RenderBatch).currentInstanceCount = count; },
        applyMaterial: (batch, material) => { (material as { applyToBatch(b: RenderBatch, group?: number): unknown }).applyToBatch(batch as RenderBatch, 1); },
        applyLights: (batch, lights) => (lights as LightSystem).applyToBatch(batch as RenderBatch, 2),
        batchGroup: (batch, group, entries) => device.createBindGroup({
            label: `batch/group${group}`,
            layout: (batch as RenderBatch).pipeline.getBindGroupLayout(group),
            entries: entries.map((e: BindEntry) => ({ binding: e.binding, resource: { buffer: e.buffer as GPUBuffer } })),
        }),
        useBatchGroup: (batch, group, bindGroup) => { (batch as RenderBatch).customBindGroups[group] = bindGroup as GPUBindGroup; },
        clearBatch: (pass, batch) => engine.clearBatch(pass as RenderPassNode, batch as RenderBatch),

        cameraBuffer: () => engine.ctx.cameraUniformBuffer,
        camera: () => new Camera(45, Math.max(1e-3, engine.width / Math.max(1, engine.height)), 0.1, 200),
        updateCamera: (handle: Handle, v: CameraState, seconds: number, aspect: number) => {
            const camera = handle as Camera;
            // The projection only when its fov or aspect moved, as SceneRuntime does (the EA5.2 review).
            const last = projected.get(camera);
            if (!last || last.fov !== v.fov || last.aspect !== aspect) {
                camera.fovDegrees = v.fov;
                camera.updateProjection(aspect);
                projected.set(camera, { fov: v.fov, aspect });
            }
            camera.updateView(eyeOf(v as unknown as CameraView), v.target as unknown as [number, number, number]);
            camera.updateTime(seconds);
            engine.updateCamera(camera);
        },

        render: sequence => engine.render(sequence as (ComputeStageNode | RenderPassNode)[]),
    };
}
