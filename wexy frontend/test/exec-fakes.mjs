// Shared by the executor's tests (EA5.2, EA5.3): candidates sealed from programs and from the live fixtures, a fake
// engine port that keeps every handle it made, a clock the port's submissions advance by a cost model, a fake GPUDevice
// whose every compile passes, WebGPU's default limits, and eligibility written as EA-G1 would write it. No GPU. Not a
// test file itself (the runner takes *.test.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBody, compileBody } from '../src/contract/adapters/bodies.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { COVERAGE_SCHEMA, EXECUTOR_PROFILE, demandsOf } from '../src/exec/eligibility.ts';
import { sealCandidate } from '../src/loop/snapshot.ts';

export const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
export const from = (port, nodeId, output) => ({ port, nodeId, output });
export const live = name => JSON.parse(readFileSync(new URL(`./fixtures/live-candidates/${name}.json`, import.meta.url), 'utf8'));
export const LIVE = ['block-film', 'galaxy', 'foggy-dusk'];

/** A candidate the host sealed: the program resolved, each module's body. */
export async function sealed(nodes, bodies) {
    const r = await resolveProgram(nodes);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph);
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    const s = await sealCandidate({
        attempt: 'attempt-1', revision: 1, program: nodes, graph: r.graph.hash,
        bodies: d.interfaces.map(i => ({ module: i.module, interfaceHash: i.interfaceHash, body: bodies[i.module] })),
    });
    assert.equal(s.ok, true, s.reason);
    return s.snapshot;
}

export const sealedLive = async name => {
    const f = live(name);
    return sealed(f.program.nodes, Object.fromEntries(f.modules.map(m => [m.module, m.body])));
};

/** The host's present: a turn and a device generation a test moves. */
export const present = () => ({ t: 1, d: 1, turn() { return this.t; }, device() { return this.d; } });

/** A clock the fake port's submissions advance: `t` in milliseconds. */
export const clock = () => ({ t: 0 });

/**
 * A cost model for the fake's submissions, in milliseconds: a fixed part a submission; each stage's invocations; each
 * pass's pixels at the port's size and its batches' instances. And what a real GPU adds the first time (the EA5.4
 * review): `coldMs` for each stage or pass the port draws for the first time, and `touchPerPixel` for the first frame
 * after its targets were made (a chain made, or resized).
 */
export const costs = ({ fixed = 0.02, perInvocation = 0, perPixel = 0, perInstance = 0, coldMs = 0, touchPerPixel = 0 } = {}) => (sequence, port) => {
    let ms = fixed;
    for (const h of sequence) {
        if (h.kind === 'stage') ms += h.workgroups.reduce((a, b) => a * b, 1) * h.size * perInvocation;
        else if (h.kind === 'pass') ms += port.width * port.height * perPixel + (h.batches ?? []).reduce((s, b) => s + (b.instances ?? 0), 0) * perInstance;
        if (coldMs && !port.seen.has(h.label)) {
            port.seen.add(h.label);
            ms += coldMs;
        }
    }
    if (touchPerPixel && port.fresh && sequence.some(h => h.kind === 'pass')) {
        port.fresh = false;
        ms += port.width * port.height * touchPerPixel;
    }
    return ms;
};

/**
 * A fake engine port: each handle it makes is live until freed, a second free is an error, and `fail(call)` makes that
 * call throw; `hold(call)` returns a promise the test settles. Every call is logged, with the labels of what it touched.
 * With a `clock` and a `cost`, each submission advances the clock. `state(label, bytes)` answers a buffer's readback,
 * `pixels(target)` a target's; `checkpointError(port)` an error checkpoint's error, from what the port did last.
 */
export function fakePort({ fail = () => false, hold = () => null, clock: time = null, cost = null, state = null, pixels = null, checkpointError = () => null } = {}) {
    let n = 0;
    const log = [];
    const live = new Map();
    const errors = [];
    const make = (kind, label, extra = {}) => { const h = { kind, label, n: ++n, ...extra }; live.set(h, label); return h; };
    const free = (h, how) => {
        if (!live.has(h)) errors.push(`${how} ${h.label}: freed twice, or never made`);
        live.delete(h);
    };
    const call = (entry, fn) => {
        log.push(entry);
        if (fail(entry)) throw new Error(`a device error at ${entry}`);
        return fn();
    };
    const camera = { kind: 'buffer', label: '@engine#camera' };
    const port = {
        log, live, errors, settles: 0, renders: 0, seen: new Set(), fresh: false,
        canvasFormat: 'bgra8unorm', width: 1280, height: 720,
        createBuffer: (label, bytes) => call(`createBuffer ${label} ${bytes}`, () => make('buffer', label, { bytes })),
        writeBuffer: (b, data) => { const f = new Float32Array(data); const u = new Uint32Array(data); log.push(`writeBuffer ${b.label} dt=${f[0].toFixed(5)} time=${f[1].toFixed(5)} step=${u[2]}`); },
        clearBuffer: b => log.push(`clearBuffer ${b.label}`),
        destroyBuffer: b => { log.push(`destroyBuffer ${b.label}`); free(b, 'destroyBuffer'); },
        copyBuffer: (a, b, bytes) => log.push(`copy ${a.label} -> ${b.label} ${bytes}`),
        createComputeStage: (label, code, workgroups, size) => call(`createComputeStage ${label}`, () => {
            const held = hold(`createComputeStage ${label}`);
            const stage = () => make('stage', label, { code, workgroups, size });
            return held ? held.then(stage) : Promise.resolve(stage());
        }),
        computeGroup: (stage, group, entries) => { log.push(`computeGroup ${stage.label} ${group} ${entries.map(e => `${e.binding}:${e.buffer.label}`).join(',')}`); return { kind: 'group', label: `${stage.label}/${group}/${entries.map(e => e.buffer.label).join('+')}` }; },
        useComputeGroup: (stage, group, g) => log.push(`useComputeGroup ${stage.label} ${group} ${g.label}`),
        removeComputeStage: s => { log.push(`removeComputeStage ${s.label}`); free(s, 'removeComputeStage'); },
        primitive: (factory, params) => call(`primitive ${factory} ${params.join(',')}`, () => make('geometry', factory)),
        destroyGeometry: g => { log.push(`destroyGeometry ${g.label}`); free(g, 'destroyGeometry'); },
        material: (cls, options) => call(`material ${cls} ${JSON.stringify(options)}`, () => make('material', cls)),
        destroyMaterial: m => { log.push(`destroyMaterial ${m.label}`); free(m, 'destroyMaterial'); },
        stockShader: (material, lights) => `stock:${material}${lights ? '+lights' : ''}`,
        lightSystem: capacity => call(`lightSystem ${JSON.stringify(capacity)}`, () => make('lights', 'lights')),
        uploadLights: (l, rig) => call(`uploadLights ${rig.points?.length ?? 0} points`, () => {}),
        destroyLights: l => { log.push('destroyLights'); free(l, 'destroyLights'); },
        postChain: effects => call(`postChain ${effects.map(e => `${e.effect}:${e.intensity}`).join(',')}`, () => {
            port.fresh = true;
            return make('chain', 'chain', { passes: [{ kind: 'pass', label: 'post/0' }, { kind: 'pass', label: 'post/1' }] });
        }),
        postPasses: c => c.passes,
        postUpload: () => log.push('postUpload'),
        postResize: (c, w, h) => { log.push(`postResize ${w}x${h}`); c.passes = [{ kind: 'pass', label: `post/${w}` }]; port.fresh = true; },
        destroyPost: c => { log.push('destroyPost'); free(c, 'destroyPost'); },
        createPass: (label, post) => call(`createPass ${label}${post ? ' into the chain' : ''}`, () => make('pass', 'main', { batches: [] })),
        removePass: p => { log.push(`removePass ${p.label}`); free(p, 'removePass'); },
        createBatch: (pass, request) => call(`createBatch ${request.label} ${request.shaderCode.startsWith('stock') ? request.shaderCode : 'module'} ${request.strideFloats}x${request.maxInstances} ${request.targetFormat}`, () => {
            const held = hold(`createBatch ${request.label}`);
            const batch = () => {
                const b = make('batch', request.label, { request, storage: { kind: 'buffer', label: `${request.label}/storage` }, instances: 0 });
                pass.batches?.push(b);
                return b;
            };
            return held ? held.then(batch) : Promise.resolve(batch());
        }),
        batchStorage: b => b.storage,
        setInstances: (b, count) => { b.instances = count; log.push(`setInstances ${b.label} ${count}`); },
        applyMaterial: (b, m) => log.push(`applyMaterial ${b.label} ${m.label}`),
        applyLights: b => log.push(`applyLights ${b.label}`),
        batchGroup: (b, group, entries) => { log.push(`batchGroup ${b.label} ${group} ${entries.map(e => `${e.binding}:${e.buffer.label}`).join(',')}`); return { kind: 'group', label: `${b.label}/${group}/${entries.map(e => e.buffer.label).join('+')}` }; },
        useBatchGroup: (b, group, g) => log.push(`useBatchGroup ${b.label} ${group} ${g.label}`),
        clearBatch: (p, b) => {
            log.push(`clearBatch ${b.label}`);
            if (p.batches) p.batches = p.batches.filter(x => x !== b);
            free(b, 'clearBatch');
        },
        cameraBuffer: () => camera,
        camera: () => ({ kind: 'camera', label: 'camera' }),
        updateCamera: (c, v, seconds, aspect) => log.push(`updateCamera ${v.distance} at ${seconds.toFixed(3)} aspect ${aspect.toFixed(3)}`),
        render: sequence => {
            const entry = `render [${sequence.map(s => s.label).join(', ')}]`;
            log.push(entry);
            if (fail(entry)) throw new Error(`a device error at ${entry}`);
            port.renders++;
            if (time && cost) time.t += cost(sequence, port);
        },
        // EA5.3: the offscreen first frame, the readbacks, the fence, the error checkpoint.
        redirectOutput: (pass, chain, target) => log.push(`redirect ${chain ? 'chain' : pass ? pass.label : 'nothing'} -> ${target ? target.label : 'screen'}`),
        offscreenTarget: (w, h) => { log.push(`offscreenTarget ${w}x${h}`); return make('target', `target ${w}x${h}`, { width: w, height: h }); },
        readTarget: async t => { log.push(`readTarget ${t.label}`); return pixels ? pixels(t) : new Uint8Array(t.width * t.height * 4).fill(96); },
        destroyTarget: t => { log.push(`destroyTarget ${t.label}`); free(t, 'destroyTarget'); },
        readBuffer: async (b, bytes) => { log.push(`readBuffer ${b.label} ${bytes}`); return state ? state(b.label, bytes) : new ArrayBuffer(bytes); },
        settle: async () => { port.settles++; },
        // As the real port's: what the work throws is the checkpoint's error, said, never thrown on.
        checkpoint: async work => {
            try {
                work();
            } catch (e) {
                return e.message;
            }
            return checkpointError(port);
        },
    };
    return port;
}

/** Headless fake ports for a probe's variants, sharing `time`; every one made is kept, to check it was destroyed. */
export function fakeHeadless(time, cost, options = {}) {
    const made = [];
    const headless = async (w, h) => {
        const port = fakePort({ clock: time, cost, ...options });
        port.width = w;
        port.height = h;
        const entry = { port, created: [w, h], destroyed: false, resize: (w2, h2) => { port.width = w2; port.height = h2; }, destroy: () => { entry.destroyed = true; } };
        made.push(entry);
        return entry;
    };
    return { headless, made };
}

/** A fake GPUDevice for L3 whose every module compiles clean, and whose loss a test triggers. */
export function cleanDevice() {
    let lose;
    const lost = new Promise(resolve => { lose = resolve; });
    const device = {
        lost,
        pushErrorScope() {},
        popErrorScope: () => Promise.resolve(null),
        createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    };
    return { device, lose: (message = 'the GPU process went away') => lose({ reason: 'unknown', message }) };
}

/** Each sealed body compiled through compileBody with `compiler`, in the snapshot's order: the verdicts it made. */
export async function compileAll(snap, compiler) {
    const out = [];
    for (const b of snap.bodies) {
        const iface = snap.interfaces.find(i => i.module === b.module);
        out.push(await compileBody(iface, await checkBody(iface, b.body), compiler));
    }
    return out;
}

/** WebGPU's default limits (the spec's): what a device without raised limits has. */
export const DEFAULT_LIMITS = Object.freeze({
    maxBufferSize: 268_435_456, maxStorageBufferBindingSize: 134_217_728, maxUniformBufferBindingSize: 65_536, maxStorageBuffersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12, maxBindGroups: 4, maxBindingsPerBindGroup: 1000, maxComputeWorkgroupSizeX: 256, maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupsPerDimension: 65_535, maxTextureDimension2D: 8192, maxVertexBuffers: 8, maxVertexAttributes: 16, maxColorAttachments: 8,
});

/** This laptop's AMD iGPU as ea5-env.v2 keys it (eligibility.ts's environmentOf), and that as the gate takes it. */
export const ENVIRONMENT = 'ea5-env.v2|amd|gcn-5|0x15d8|AMD Radeon(TM) Vega 8 Graphics|d3d12|windows|chrome/156';
export const ENV = Object.freeze({ key: ENVIRONMENT });

/**
 * Eligibility as EA-G1 would write it from runs of `snapshots` at `pixels`: one entry an adapter, each dimension's
 * largest demand scaled by `scale`, each value seen, for `environment`; `edit(entries)` changes it for a test.
 */
export function eligibilityFor(snapshots, { environment = ENVIRONMENT, pixels = 2_300_000, scale = 1, edit = e => e } = {}) {
    const by = new Map();
    for (const snap of snapshots) {
        const demands = demandsOf(snap.x, pixels);
        assert.notEqual(typeof demands, 'string', demands);
        for (const d of demands) {
            const key = `${d.adapter}@${d.adapterVersion}`;
            const e = by.get(key) ?? {
                adapter: d.adapter, adapterVersion: d.adapterVersion, engineBundleHash: snap.x.identity.bundleHash, executorProfile: EXECUTOR_PROFILE, environment,
                coverage: { max: Object.fromEntries(COVERAGE_SCHEMA[d.adapter].max.map(k => [k, 0])), values: Object.fromEntries(COVERAGE_SCHEMA[d.adapter].values.map(k => [k, []])) },
                evidence: 'a test\'s stand-in for an EA-G1 run',
            };
            for (const [k, v] of Object.entries(d.max)) e.coverage.max[k] = Math.max(e.coverage.max[k], v * scale);
            for (const [k, vs] of Object.entries(d.values)) for (const v of vs) if (!e.coverage.values[k].includes(v)) e.coverage.values[k].push(v);
            by.set(key, e);
        }
    }
    // An adapter with no value seen for a key still names one, as the schema needs a non-empty list.
    for (const e of by.values()) for (const k of Object.keys(e.coverage.values)) if (!e.coverage.values[k].length) e.coverage.values[k].push('none');
    return { ok: true, entries: edit([...by.values()]) };
}
