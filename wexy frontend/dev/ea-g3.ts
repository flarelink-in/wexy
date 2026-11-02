// EA6.1's EA-G3 on a real GPU (visual-review-design.md §6, §10): the review's capture of a world installed on the
// stage, on the stage's own engine, as the studio makes it (src/shell/studio/main.ts captureReview): the viewport running,
// the world put there by the stage's Run (the gate with its advisory coverage, the probe, the first frame), then
// captureInstalled with the browser's own JPEG encoder. dev/ea-g3.mjs drives it on one GPU and keeps the result.
//   known colours  a world that paints the screen one colour (no post chain): its channels within 2/255, red first, and
//                  its JPEG within the codec's error
//   portrait       the same world on a portrait canvas: fitted between black bars, never stretched
//   moving world   galaxy, stepping on the viewport's clock: its state byte for byte and its step count the same across
//                  a capture, the frames naming that very tick; still moving after it
//   ping-pong      a world whose pair is swapped each step: the same half current, and the same bytes, across a capture
//   temporal post  a world with AutoExposure: withheld since policy v2 (its history would move), nothing drawn, its boxes read
//   cleanup        a draw refused, a readback refused, a validation error inside the section: each said, the reservation
//                  returned, the Head drawing its own frame cleanly after, no uncaptured error
//   the castle     as the agent wrote it: two views, EA_SCALE and EA_FRAME from the boxes read on the device; at unit
//                  sizes, neither; the frames kept as files for a person to look at

import { checkBody, compileBody, type CompiledBody } from '../src/contract/adapters/bodies';
import { deriveInterfaces } from '../src/contract/adapters/interfaces';
import { resolveProgram } from '../src/contract/adapters/resolve';
import type { DeepReadonly } from '../src/contract/engine/frozen';
import { encodeJpeg } from '../src/capture/jpeg';
import { frameWorld } from '../src/exec/bounds';
import { createDeviceCompiler } from '../src/exec/device-compiler';
import { adapterIdentity, environmentOf } from '../src/exec/eligibility';
import type { EnginePort, Handle } from '../src/exec/engine-port';
import { createMemoryLedger, limitsOf, type Reservation } from '../src/exec/gate';
import { createHeadlessPort, createNullGraphPort } from '../src/exec/null-graph-port';
import { captureInstalled, captureSafety, reviewViews, type CaptureOutcome } from '../src/exec/review-capture';
import { hostLook, lookAt } from '../src/exec/review-findings';
import { createStage, retire, type PrepareReport } from '../src/exec/stage';
import type { AgentRuntime } from '../src/exec/world-runtime';
import { sealCandidate, type SealedCandidate } from '../src/loop/snapshot';
import { MAX_LIVE_PIXELS, Viewport } from '../src/runtime/viewport';
import castleText from './replays/castle.json?raw';
import galaxyText from '../test/fixtures/live-candidates/galaxy.json?raw';
import covComputeText from '../test/fixtures/coverage-worlds/cov-compute.json?raw';
import covEffectsText from '../test/fixtures/coverage-worlds/cov-effects-a.json?raw';

type Snapshot = DeepReadonly<SealedCandidate>;
interface Node { id: string; adapterId: string; adapterVersion: number; config: string; inputs: unknown[] }
interface Fixture { program: { nodes: Node[] }; modules: { module: string; body: string }[] }

const logEl = document.getElementById('log')!;
const log = (line: string) => { logEl.textContent += `\n${line}`; console.log(`[g3] ${line}`); };
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok: !!ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const sha = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
const base64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const node = (id: string, adapterId: string, config: unknown, inputs: unknown[] = []): Node => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const bodiesOf = (f: Fixture) => Object.fromEntries(f.modules.map(m => [m.module, m.body]));

/** One colour on the whole screen, no post chain: what reaches the target is the fragment's own output. */
const PAINT = [1.0, 0.25, 0.0];
const paint: Fixture = {
    program: { nodes: [node('paint', 'ng.render.fullscreen', { module: 'paint', fragmentEntry: 'solid' })] },
    modules: [{ module: 'paint', body: `fn solid(uv: vec2<f32>) -> vec4<f32> {\n    return vec4<f32>(${PAINT.map(v => v.toFixed(2)).join(', ')}, 1.0);\n}` }],
};
const castle = JSON.parse(castleText) as Fixture;
/** The castle at unit sizes: the three sizes the agent doubled with its instances' scale, set to 1 (11-02's analysis). */
const castleUnit: Fixture = {
    ...castle, program: { nodes: castle.program.nodes.map(n => (['geohill', 'geocyl', 'geocone'].includes(n.id) ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), size: 1 }) } : n)) },
};
const galaxy = JSON.parse(galaxyText) as Fixture;
const covCompute = JSON.parse(covComputeText) as Fixture;
/** cov-compute with its frame stage moved to the fixed step: its ping-pong pair swapped each step, nothing written in a frame. */
const pingPong: Fixture = { ...covCompute, program: { nodes: covCompute.program.nodes.map(n => (n.id === 'driftswarm' ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), phase: 'fixedStep' }) } : n)) } };
const covEffects = JSON.parse(covEffectsText) as Fixture;

async function run() {
    const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;
    const vp = await Viewport.create(canvas);
    // Full size always: the guard's rungs would shrink the canvas under a slow frame, and every check here names its size.
    vp.pin(0);
    vp.start();
    const device = vp.engine.device;
    let generation = 0;
    let lost: string | null = null;
    void device.lost.then(i => { lost = i.message || i.reason; generation++; });
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message.slice(0, 300)));
    const compiler = createDeviceCompiler(device, { generation: () => generation, gpu: vp.gpuLabel });
    const ledger = createMemoryLedger();
    const environment = environmentOf(adapterIdentity(device.adapterInfo), navigator.userAgent);
    const port = createNullGraphPort(vp.engine);
    const size = () => ({ width: vp.canvas.width, height: vp.canvas.height });
    const engine = vp.engine as unknown as { passes: unknown[]; computeStages: unknown[]; batches: unknown[] };
    const count = () => ({ passes: engine.passes.length, stages: engine.computeStages.length, batches: engine.batches.length });
    const baseline = count();
    log(`adapter: ${vp.gpuLabel}; environment ${'key' in environment ? environment.key : `unknown (${environment.unknown})`}; canvas ${size().width}×${size().height}`);

    const head: { runtime: AgentRuntime | null; held: Reservation | null; snap: Snapshot | null; report: PrepareReport | null } = { runtime: null, held: null, snap: null, report: null };
    const frames = (n: number) => new Promise<void>(resolve => {
        let k = 0;
        vp.onFrame = () => { if (++k >= n) { vp.onFrame = undefined; resolve(); } };
    });

    /** A world sealed by the host, compiled by L3 here, and put on the stage by its Run, as the studio's. */
    const install = async (name: string, f: Fixture) => {
        const nodes = f.program.nodes;
        const resolved = await resolveProgram(nodes);
        if (!resolved.ok) throw new Error(`${name} does not resolve: ${resolved.diagnostics[0]?.message}`);
        const derived = await deriveInterfaces(resolved.graph);
        if (!derived.ok) throw new Error(`${name}: no interfaces`);
        const bodies = bodiesOf(f);
        const sealed = await sealCandidate({
            attempt: `ea-g3-${name}`, revision: 1, program: nodes, graph: resolved.graph.hash,
            bodies: derived.interfaces.map(i => ({ module: i.module, interfaceHash: i.interfaceHash, body: bodies[i.module] ?? '' })),
        });
        if (!sealed.ok) throw new Error(`${name} does not seal: ${sealed.reason}`);
        const snap = sealed.snapshot;
        const verdicts: DeepReadonly<CompiledBody>[] = [];
        for (const b of snap.bodies) {
            const iface = snap.interfaces.find(i => i.module === b.module)!;
            verdicts.push(await compileBody(iface, await checkBody(iface, b.body), compiler));
        }
        const stage = createStage({
            port, headless: (w, h) => createHeadlessPort(device, w, h), limits: limitsOf(device), compiler: () => compiler, present: { turn: () => 1, device: () => generation },
            environment, gpu: vp.gpuLabel, size, maxPixels: MAX_LIVE_PIXELS, view: () => vp.currentView(), restoreHeadCamera: () => vp.writeCamera(), quiet: () => vp.pause(),
            commit: r => vp.setRuntime(r), now: () => performance.now(), ledger,
        });
        stage.press(snap);
        const r = await stage.run(snap, verdicts);
        if (r.status !== 'installed') throw new Error(`${name} was not installed: ${r.status}: ${r.reason}`);
        const error = retire(head.runtime, head.held);
        if (error) throw new Error(error);
        Object.assign(head, { runtime: r.runtime, held: r.held, snap, report: r.report });
        // The orbit framed on what it built, as the studio's installAgent frames it.
        const framing = frameWorld(r.report?.bounds ?? null, vp.currentView().fov, size().width / size().height);
        vp.setView(framing?.view ?? { target: [0, 0, 0], distance: 12, azimuth: 0, polar: 1.25, fov: 45 });
        await frames(10);
        log(`${name}: installed (${snap.id.slice(0, 12)}…)${r.report?.coverageWarning ? ` · ${r.report.coverageWarning.slice(0, 120)}` : ''}`);
        return { snap, runtime: r.runtime, report: r.report, framing };
    };

    /** How long the capture held the stage still: the quiet section, from the hold to its release. */
    const holds: number[] = [];
    const capture = (over: Partial<Parameters<typeof captureInstalled>[0]> = {}) => {
        const aspect = size().width / size().height;
        const framing = frameWorld(head.report?.bounds ?? null, vp.currentView().fov, aspect);
        const { views, missing } = reviewViews(framing, vp.currentView());
        return captureInstalled({
            port, runtime: head.runtime!, x: head.snap!.x, views, restoreHeadCamera: () => vp.writeCamera(),
            hold: () => { const t0 = performance.now(); const release = vp.pause(); return () => { holds.push(round(performance.now() - t0)); release(); }; },
            stale: () => (lost ? `the device was lost: ${lost}` : null), ledger, encode: encodeJpeg, ...over,
        }).then(o => ({ o, missing, framing, aspect }));
    };
    const ok = (o: CaptureOutcome): o is Extract<CaptureOutcome, { ok: true }> => o.ok;
    /** The Head's own frame on the canvas, inside an error checkpoint: null when it drew cleanly. */
    const headDraws = async () => {
        const error = await port.checkpoint!(() => { vp.writeCamera(); vp.engine.render(head.runtime!.draw()); });
        await device.queue.onSubmittedWorkDone();
        return error;
    };
    const decode = async (jpeg: Uint8Array) => {
        const bmp = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        return { width: bmp.width, height: bmp.height, rgba: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
    };
    const at = (rgba: ArrayLike<number>, width: number, x: number, y: number) => [rgba[(y * width + x) * 4], rgba[(y * width + x) * 4 + 1], rgba[(y * width + x) * 4 + 2]];
    const off = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const saved: { name: string; base64: string }[] = [];
    const keep = (name: string, o: Extract<CaptureOutcome, { ok: true }>) => { for (const f of o.frames) saved.push({ name: `${name}-${f.view}.jpg`, base64: base64(f.jpeg) }); };
    /** Every state buffer's hash (the first MiB of each), and the buffer each resource's current half is. */
    const state = async (rt: AgentRuntime) => {
        const out: Record<string, { sha: string; buffer: Handle }> = {};
        for (const s of rt.stateBuffers()) {
            const bytes = Math.min(s.elements * s.strideFloats * 4, 1 << 20);
            out[s.resource] = { sha: await sha(new Uint8Array(await port.readBuffer!(s.buffer, bytes))), buffer: s.buffer };
        }
        return out;
    };

    // ---- known colours, then portrait ---------------------------------------------------------------------------------
    await install('paint', paint);
    const expected = PAINT.map(v => Math.round(v * 255));
    const solid = await capture();
    if (ok(solid.o)) {
        const f = solid.o.frames[0];
        const raw = [at(f.rgba, 768, 384, 216), at(f.rgba, 768, 0, 0), at(f.rgba, 768, 767, 431)];
        const jpeg = await decode(f.jpeg);
        const coded = at(jpeg.rgba, jpeg.width, 384, 216);
        keep('paint', solid.o);
        check('known colours: the fitted frame\'s channels within 2/255 of the fragment\'s own, red first, everywhere; its JPEG within the codec\'s error',
            solid.o.frames.length === 1 && raw.every(p => off(p, expected) <= 2) && jpeg.width === 768 && jpeg.height === 432 && off(coded, expected) <= 8
            && solid.o.missing.length === 0 && solid.missing.length === 1 && solid.missing[0].name === 'side',
            { expected, raw, coded, jpegBytes: f.jpeg.length, quality: f.quality, missing: solid.missing });
    } else check('known colours: captured', false, solid.o);
    // Portrait: the canvas turned on its side; the viewport resizes the engine and the world at its next frame.
    canvas.style.width = '720px';
    canvas.style.height = '1280px';
    for (let i = 0; i < 100 && !(vp.canvas.width === 720 && vp.canvas.height === 1280); i++) await frames(1);
    await frames(5);
    const tall = await capture();
    if (ok(tall.o)) {
        const f = tall.o.frames[0];
        const jpeg = await decode(f.jpeg);
        keep('paint-portrait', tall.o);
        check('portrait: a 720×1280 world fitted between black bars, never stretched; the bars excluded from what is judged',
            f.sourceWidth === 720 && f.sourceHeight === 1280 && JSON.stringify(f.content) === JSON.stringify({ x: 262, y: 0, width: 243, height: 432 })
            && off(at(f.rgba, 768, 10, 216), [0, 0, 0]) === 0 && off(at(f.rgba, 768, 384, 216), expected) <= 2 && off(at(jpeg.rgba, 768, 10, 216), [0, 0, 0]) <= 8
            && off(at(jpeg.rgba, 768, 384, 216), expected) <= 8 && lookAt('framed', f.rgba, 768, f.content).pixels === 243 * 432,
            { size: [f.sourceWidth, f.sourceHeight], content: f.content, bar: at(f.rgba, 768, 10, 216), middle: at(f.rgba, 768, 384, 216), coded: [at(jpeg.rgba, 768, 10, 216), at(jpeg.rgba, 768, 384, 216)] });
    } else check('portrait: captured', false, tall.o);
    canvas.style.width = '1280px';
    canvas.style.height = '720px';
    for (let i = 0; i < 100 && !(vp.canvas.width === 1280 && vp.canvas.height === 720); i++) await frames(1);

    // ---- a moving world: nothing of it changes across a capture ------------------------------------------------------
    await install('galaxy', galaxy);
    await frames(30);
    let release = vp.pause();
    const steps = head.runtime!.steps;
    const before = await state(head.runtime!);
    const moving = await capture();
    const after = await state(head.runtime!);
    const same = Object.keys(before).every(k => before[k].sha === after[k].sha && before[k].buffer === after[k].buffer);
    if (ok(moving.o)) {
        keep('galaxy', moving.o);
        const hashes = await Promise.all(moving.o.frames.map(f => sha(f.jpeg)));
        check('a moving world: its state byte for byte, its current halves and its step count the same across a capture; each frame named by that tick, its hash its bytes\'',
            steps > 0 && same && head.runtime!.steps === steps && moving.o.tick === steps && moving.o.frames.length === 2
            && moving.o.frames.every((f, i) => f.sha256 === hashes[i]) && moving.o.frames.map(f => f.view).join() === 'framed,side',
            { steps, after: head.runtime!.steps, tick: moving.o.tick, buffers: Object.keys(before), same, jpegBytes: moving.o.frames.map(f => f.jpeg.length) });
    } else check('a moving world: captured', false, moving.o);
    release();
    await frames(20);
    const later = await state(head.runtime!);
    check('the moving world moves on after its capture', head.runtime!.steps > steps && Object.keys(before).some(k => later[k].sha !== before[k].sha),
        { steps: head.runtime!.steps, was: steps });

    // ---- a ping-pong pair: the same half current, the same bytes --------------------------------------------------------
    const pingPongX = await resolveProgram(pingPong.program.nodes);
    check('the ping-pong world passes the capture gate: nothing written in its frame', pingPongX.ok && captureSafety(pingPongX.graph).unsafe === null);
    await install('ping-pong', pingPong);
    await frames(10);
    release = vp.pause();
    const pairBefore = await state(head.runtime!);
    const pair = await capture();
    const pairAfter = await state(head.runtime!);
    const field = 'field#buffer';
    head.runtime!.step();
    const stepped = await state(head.runtime!);
    release();
    check('ping-pong parity: the same half current and the same bytes across a capture; one step later the other half is current',
        ok(pair.o) && !!pairBefore[field] && pairBefore[field].buffer === pairAfter[field].buffer && pairBefore[field].sha === pairAfter[field].sha
        && Object.keys(pairBefore).every(k => pairBefore[k].sha === pairAfter[k].sha) && stepped[field].buffer !== pairAfter[field].buffer,
        { captured: pair.o.ok, resources: Object.keys(pairBefore), flippedByStep: stepped[field]?.buffer !== pairAfter[field]?.buffer });

    // ---- a temporal post effect: withheld (policy v2, the outside review of 11-02 night), its boxes still read ----------
    await install('cov-effects-a', covEffects);
    await frames(30);
    let drawn = 0;
    const counting = Object.assign(Object.create(port) as EnginePort, { render: (seq: readonly Handle[]) => { drawn++; port.render(seq); }, offscreenTarget: (w: number, h: number) => { drawn++; return port.offscreenTarget!(w, h); } });
    const temporal = await capture({ port: counting });
    check('a temporal post effect: AutoExposure withholds the capture, nothing drawn for it, both views said unavailable with the reason, its boxes still read',
        ok(temporal.o) && temporal.o.frames.length === 0 && drawn === 0 && temporal.o.temporal.join() === 'AutoExposure' && temporal.o.missing.length === 2
        && temporal.o.missing.every(m => /^EA_CAPTURE_UNAVAILABLE state: look keeps the history of AutoExposure/.test(m.why)) && (temporal.o.bounds?.batches.length ?? 0) > 0,
        { drawn, outcome: ok(temporal.o) ? { missing: temporal.o.missing, temporal: temporal.o.temporal, boxes: temporal.o.bounds?.batches.length ?? 0 } : temporal.o });

    // ---- cleanup when the capture fails ----------------------------------------------------------------------------------
    await install('galaxy (cleanup)', galaxy);
    const share = ledger.held();
    const errorsBefore = uncaptured.length;
    const failures: { name: string; message: string; held: number; draws: string | null }[] = [];
    const fail = async (name: string, wrapped: EnginePort) => {
        const c = await capture({ port: wrapped });
        failures.push({ name, message: c.o.ok ? 'CAPTURED' : c.o.message, held: ledger.held(), draws: await headDraws() });
    };
    let n = 0;
    await fail('a draw refused', Object.assign(Object.create(port) as EnginePort, { render: (seq: readonly Handle[]) => { if (++n === 2) throw new Error('a refused draw'); port.render(seq); } }));
    await fail('a readback refused', Object.assign(Object.create(port) as EnginePort, { readTarget: () => Promise.reject(new Error('mapAsync refused')) }));
    // A target destroyed before it is drawn into: the device's own validation error, caught in the section's checkpoint.
    await fail('a validation error', Object.assign(Object.create(port) as EnginePort, {
        offscreenTarget: (w: number, h: number) => { const t = port.offscreenTarget!(w, h) as { color: GPUTexture }; t.color.destroy(); return t; },
    }));
    await frames(10);
    const after3 = await capture();
    check('cleanup: a refused draw, a refused readback and a validation error are each said; the reservation returned, the Head drawing its own frame cleanly, no uncaptured error',
        failures.every(f => f.message.startsWith('EA_CAPTURE ') && f.held === share && f.draws === null) && /^EA_CAPTURE draw side: a refused draw$/.test(failures[0].message)
        && /^EA_CAPTURE read: mapAsync refused$/.test(failures[1].message) && failures[2].message.startsWith('EA_CAPTURE draws: ') && uncaptured.length === errorsBefore && after3.o.ok,
        { failures, uncaptured: uncaptured.slice(errorsBefore), then: after3.o.ok ? 'captured' : after3.o });

    // ---- the castle, as written and at unit sizes ------------------------------------------------------------------------
    const findingsOf = async (name: string, f: Fixture) => {
        const w = await install(name, f);
        const c = await capture();
        if (!ok(c.o)) return { name, captured: c.o, codes: [] as string[], views: 0 };
        keep(name, c.o);
        const look = hostLook({
            looks: c.o.frames.map(fr => lookAt(fr.view, fr.rgba, 768, fr.content)), missing: [...c.missing, ...c.o.missing], bounds: c.o.bounds ?? w.report?.bounds ?? null,
            boundsAt: c.o.bounds ? { when: 'capture', tick: c.o.tick, error: null } : { when: 'preparation', tick: null, error: c.o.boundsError }, framed: c.o.frames[0]?.camera ?? null,
            aspect: c.aspect, unboxed: [], probe: null,
        });
        return { name, captured: 'ok', codes: look.findings.map(x => x.code), messages: look.findings.map(x => x.message), gaps: look.gaps, views: c.o.frames.length, boxes: c.o.bounds?.batches.length ?? 0 };
    };
    const written = await findingsOf('castle', castle);
    const unit = await findingsOf('castle-unit', castleUnit);
    check('the castle as written: two views, EA_SCALE and EA_FRAME from the boxes read on this device', written.views === 2 && written.codes.includes('EA_SCALE') && written.codes.includes('EA_FRAME'), written);
    check('the castle at unit sizes: neither', unit.views === 2 && !unit.codes.includes('EA_SCALE') && !unit.codes.includes('EA_FRAME'), unit);

    // ---- the end: the stage empty, the engine at its baseline, nothing held, nothing uncaptured ---------------------------
    const retired = retire(head.runtime, head.held);
    vp.setRuntime(null);
    await device.queue.onSubmittedWorkDone();
    await sleep(100);
    const now = count();
    check('the end: the engine back at its baseline, the ledger empty, no uncaptured error, no device lost',
        !retired && JSON.stringify(now) === JSON.stringify(baseline) && ledger.held() === 0 && uncaptured.length === 0 && !lost,
        { retired, now, baseline, held: ledger.held(), uncaptured, lost });
    return { gpu: vp.gpuLabel, browser: navigator.userAgent, environment, checks, holds, saved, stamp: new Date().toISOString() };
}

const harness = {
    ready: true,
    result: null as unknown,
    run() {
        run().then(r => { harness.result = r; }, e => { harness.result = { error: String((e as Error)?.stack ?? e), checks }; });
    },
};
(window as unknown as { __G3__: typeof harness }).__G3__ = harness;
