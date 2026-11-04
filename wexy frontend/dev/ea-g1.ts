// EA5.4's EA-G1 and part of EA-G2 on a real GPU (executor-design.md §10, §13; Q88, Q90). The live candidates of 11-01,
// and each scaled by 4 and by 16 in its instances and invocations (within P v1, or refused by the seal's checks, said),
// each sealed by the host and compiled by L3 on this device, then run through the stage exactly as the studio's Run runs
// it: the gate, the probe on headless engines, the full init, the offscreen first frame and its look, the commit, on a
// viewport of its own. The gate is pinned to that one candidate (the EA-G1 bootstrap, §7): eligibility is what this run
// writes, so it cannot be what admits it; every other rule holds. Once installed, each world's steady step and frame are
// measured on the device and held, with the full init and the first frame, to the probe's predictions; after it goes, the
// engine's own bookkeeping is held to its baseline (P5). Then EA-G2's ordinary stops: ten replacements back to back, and a
// cancel during the probe; then the coverage worlds of 11-02 (test/fixtures/coverage-worlds: written by hand, so that
// every value Tier 1 allows runs here), each at scale 1 through the same Run, evidence for eligibility and never a
// failure of the gate; and, asked for alone, a device loss during one (it ends the page's device). The result holds
// every run's numbers, the environment, and eligibility entries for this environment written from the clean runs, which
// the developer reviews before they ship in src/exec/eligibility.json. dev/ea-g1.mjs drives it and keeps the result.

import { checkBody, compileBody, type CompiledBody } from '../src/contract/adapters/bodies';
import { deriveInterfaces } from '../src/contract/adapters/interfaces';
import { resolveProgram } from '../src/contract/adapters/resolve';
import type { DeepReadonly } from '../src/contract/engine/frozen';
import { createDeviceCompiler } from '../src/exec/device-compiler';
import { adapterIdentity, demandsOf, eligibilityFrom, environmentOf, type Demand } from '../src/exec/eligibility';
import { createMemoryLedger, limitsOf, type Reservation } from '../src/exec/gate';
import type { EnginePort } from '../src/exec/engine-port';
import { createHeadlessPort, createNullGraphPort } from '../src/exec/null-graph-port';
import { median, type HeadlessPort } from '../src/exec/probe';
import { createStage, envelopeOf, retire, type PrepareReport } from '../src/exec/stage';
import type { AgentRuntime } from '../src/exec/world-runtime';
import { sealCandidate, type SealedCandidate } from '../src/loop/snapshot';
import { MAX_LIVE_PIXELS, Viewport } from '../src/runtime/viewport';
import blockFilm from '../test/fixtures/live-candidates/block-film.json?raw';
import foggyDusk from '../test/fixtures/live-candidates/foggy-dusk.json?raw';
import galaxy from '../test/fixtures/live-candidates/galaxy.json?raw';

type Snapshot = DeepReadonly<SealedCandidate>;
interface Fixture { program: { nodes: { id: string; adapterId: string; config: string }[] }; modules: { module: string; body: string }[] }

const FIXTURES: [string, Fixture][] = [['block-film', JSON.parse(blockFilm)], ['galaxy', JSON.parse(galaxy)], ['foggy-dusk', JSON.parse(foggyDusk)]];
const SCALES = [1, 4, 16];
/** The coverage worlds, each at scale 1, the largest (`-xl`) last: what they leave behind is the least to cost the rest. */
const COVERAGE: [string, Fixture][] = Object.entries(import.meta.glob<string>('../test/fixtures/coverage-worlds/*.json', { query: '?raw', import: 'default', eager: true }))
    .map(([path, text]): [string, Fixture] => [path.replace(/^.*\/|\.json$/g, ''), JSON.parse(text) as Fixture])
    .sort(([a], [b]) => Number(a.endsWith('-xl')) - Number(b.endsWith('-xl')) || (a < b ? -1 : a > b ? 1 : 0));
/** The config fields that hold a node's work, as the probe's projection scales them (probe.ts). */
const WORK: Readonly<Record<string, readonly string[]>> = {
    'ng.buffer.storage': ['elements'], 'ng.compute.stage': ['invocations'], 'ng.render.mesh_batch': ['maxInstances'], 'ng.render.custom_batch': ['maxInstances'],
};

const logEl = document.getElementById('log')!;
const log = (line: string) => { logEl.textContent += `\n${line}`; console.log(`[g1] ${line}`); };
const round = (ms: number | null | undefined) => (ms === null || ms === undefined || Number.isNaN(ms) ? null : Math.round(ms * 1000) / 1000);

/** W with its work counts multiplied by `k`. */
function scaled(nodes: Fixture['program']['nodes'], k: number): Fixture['program']['nodes'] {
    return nodes.map(n => {
        const fields = WORK[n.adapterId];
        if (!fields || k === 1) return n;
        const config = JSON.parse(n.config) as Record<string, number>;
        for (const f of fields) config[f] *= k;
        return { ...n, config: JSON.stringify(config) };
    });
}

/** The fixture at scale `k`, sealed by the host: its interfaces derived from its own X, its bodies as written. */
async function seal(name: string, f: Fixture, k: number): Promise<{ snap: Snapshot } | { reason: string }> {
    const nodes = scaled(f.program.nodes, k);
    const resolved = await resolveProgram(nodes);
    if (!resolved.ok) return { reason: `does not resolve: ${resolved.diagnostics[0]?.code ?? ''} ${resolved.diagnostics[0]?.message ?? ''}` };
    const derived = await deriveInterfaces(resolved.graph);
    if (!derived.ok) return { reason: 'its interfaces cannot be derived' };
    const sealed = await sealCandidate({
        attempt: `ea-g1-${name}-x${k}`, revision: 1, program: nodes, graph: resolved.graph.hash,
        bodies: derived.interfaces.map(i => ({ module: i.module, interfaceHash: i.interfaceHash, body: f.modules.find(m => m.module === i.module)?.body ?? '' })),
    });
    return sealed.ok ? { snap: sealed.snapshot } : { reason: sealed.reason };
}

interface RunRecord {
    world: string;
    scale: number;
    candidate: string | null;
    status: string;
    reason: string | null;
    l3: { module: string; ok: boolean; ms: number }[];
    /** The Run's wall time, from its press to its outcome: the probe, and for a world installed its full init and first frame. */
    runMs: number | null;
    report: PrepareReport | null;
    /**
     * The installed world at the canvas's size, each the median of three batches after a warm-up, each to its fence: a
     * step; a frame drawn into a private target (the world's own work, as the probe draws its variants and the first
     * frame: what predictions are held to); and a frame drawn onto the canvas (its presentation's cost on top, which no
     * probe can time before commit, I4).
     */
    measured: { stepMs: number | null; frameMs: number | null; canvasFrameMs: number | null } | null;
    /** A prediction below what ran: the probe's safe direction broken. */
    underPredicted: string[];
    uncaptured: string[];
    baseline: string | null;
    retireError: string | null;
    demands: Demand[] | null;
}

async function run(options: { lose?: boolean } = {}) {
    const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;
    const vp = await Viewport.create(canvas);
    const device = vp.engine.device;
    const identity = adapterIdentity(device.adapterInfo);
    const environment = environmentOf(identity, navigator.userAgent);
    let generation = 0;
    let lost: string | null = null;
    void device.lost.then(i => { lost = i.message || i.reason; generation++; });
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message.slice(0, 300)));
    const compiler = createDeviceCompiler(device, { generation: () => generation, gpu: vp.gpuLabel });
    const ledger = createMemoryLedger();
    const present = { turn: () => 1, device: () => generation };
    const size = () => ({ width: vp.canvas.width, height: vp.canvas.height });
    const envelope = envelopeOf(size(), MAX_LIVE_PIXELS);
    /**
     * The pixels a run covers (2026-11-04). The canvas's, unless the live cap holds it: since EA9.3's review the viewport
     * caps even its first canvas (liveSize), so a box over 2.3 MP draws a canvas a little under every envelope the stage
     * computes at that cap (2022×1137 against 2023×1138 here), where on 11-02 it drew 2048×1152, a little over. Then the
     * envelope this run was admitted and probed at, which every canvas the cap allows is under.
     */
    const box = vp.canvas.clientWidth * vp.canvas.clientHeight * Math.min(window.devicePixelRatio || 1, 1.5) ** 2;
    const coveredPixels = box > MAX_LIVE_PIXELS ? envelope.width * envelope.height : size().width * size().height;
    const engine = vp.engine as unknown as { passes: unknown[]; computeStages: unknown[]; batches: unknown[] };
    const count = () => ({ passes: engine.passes.length, stages: engine.computeStages.length, batches: engine.batches.length });
    const baseline = count();
    log(`adapter: ${vp.gpuLabel} · ${JSON.stringify(identity)}`);
    log(`environment: ${'key' in environment ? environment.key : `unknown (${environment.unknown})`}`);
    log(`canvas ${size().width}×${size().height}; the envelope ${envelope.width}×${envelope.height}; coverage recorded at ${coveredPixels} pixels`);

    /** One Run as the studio's: a stage pinned to this candidate alone, its go pressed, everything recorded. */
    const stageFor = (snap: Snapshot, headless: (w: number, h: number) => Promise<HeadlessPort> = (w, h) => createHeadlessPort(device, w, h),
        portWrap: (port: EnginePort) => EnginePort = port => port) => createStage({
        port: portWrap(createNullGraphPort(vp.engine)), headless, limits: limitsOf(device), compiler: () => compiler, present, environment, gpu: vp.gpuLabel,
        size, maxPixels: MAX_LIVE_PIXELS, view: () => vp.currentView(), restoreHeadCamera: () => vp.writeCamera(), commit: runtime => vp.setRuntime(runtime),
        now: () => performance.now(), ledger, bootstrap: { harness: 'EA-G1', candidates: new Set([snap.id]) },
    });
    const l3 = async (snap: Snapshot) => {
        const verdicts: DeepReadonly<CompiledBody>[] = [];
        const rows: { module: string; ok: boolean; ms: number }[] = [];
        for (const b of snap.bodies) {
            const iface = snap.interfaces.find(i => i.module === b.module)!;
            const t0 = performance.now();
            const v = await compileBody(iface, await checkBody(iface, b.body), compiler);
            verdicts.push(v);
            rows.push({ module: b.module, ok: v.ok, ms: round(performance.now() - t0)! });
        }
        return { verdicts, rows };
    };
    const fence = () => device.queue.onSubmittedWorkDone();
    const measure = async (R: AgentRuntime, steps: boolean) => {
        const time = async (n: number, work: () => void) => {
            const t0 = performance.now();
            for (let i = 0; i < n; i++) work();
            await fence();
            return (performance.now() - t0) / n;
        };
        /** Warmed (so a GPU at rest has clocked up), then the median of three batches of six. */
        const steady = async (work: () => void) => {
            for (let i = 0; i < 12; i++) work();
            await fence();
            const batches: number[] = [];
            for (let j = 0; j < 3; j++) batches.push(await time(6, work));
            return median(batches);
        };
        const stepMs = steps ? await steady(() => R.step()) : null;
        const frame = () => { vp.writeCamera(); vp.engine.render(R.draw()); };
        const canvasFrameMs = await steady(frame);
        // The same frame into a private target of the canvas's size and format, as the first frame was drawn.
        const port = createNullGraphPort(vp.engine);
        const target = port.offscreenTarget!(vp.canvas.width, vp.canvas.height);
        let frameMs: number;
        try {
            R.redirectOutput(target);
            frameMs = await steady(frame);
        } finally {
            R.redirectOutput(null);
            port.destroyTarget!(target);
        }
        return { stepMs: round(stepMs), frameMs: round(frameMs), canvasFrameMs: round(canvasFrameMs) };
    };
    const head: { runtime: AgentRuntime | null; held: Reservation | null } = { runtime: null, held: null };
    let bundleHash: string | null = null;
    const baselineProblem = () => {
        const now = count();
        return now.passes === baseline.passes && now.stages === baseline.stages && now.batches === baseline.batches ? null
            : `the engine holds ${JSON.stringify(now)} after the world went, against ${JSON.stringify(baseline)}`;
    };

    /** One world at one scale, installed and measured, then retired (or kept as the head, for the replacements). */
    const one = async (world: string, k: number, snapOrReason: { snap: Snapshot } | { reason: string }, opts: {
        keep?: boolean; signal?: AbortSignal; headless?: (w: number, h: number) => Promise<HeadlessPort>; portWrap?: (port: EnginePort) => EnginePort;
    } = {}): Promise<RunRecord> => {
        const { keep = false, signal, headless, portWrap } = opts;
        const record: RunRecord = {
            world, scale: k, candidate: null, status: 'not sealed', reason: null, l3: [], runMs: null, report: null, measured: null, underPredicted: [], uncaptured: [],
            baseline: null, retireError: null, demands: null,
        };
        if ('reason' in snapOrReason) {
            record.reason = snapOrReason.reason;
            log(`${world} ×${k}: not sealed: ${snapOrReason.reason}`);
            return record;
        }
        const snap = snapOrReason.snap;
        record.candidate = snap.id;
        bundleHash ??= snap.x.identity.bundleHash;
        const errorsBefore = uncaptured.length;
        const { verdicts, rows } = await l3(snap);
        record.l3 = rows;
        const stage = stageFor(snap, headless, portWrap);
        stage.press(snap);
        const t0 = performance.now();
        const r = await stage.run(snap, verdicts, signal);
        record.runMs = round(performance.now() - t0);
        record.status = r.status;
        record.report = r.report;
        if (r.status !== 'installed') {
            record.reason = r.reason;
        } else {
            const p = r.report?.probe;
            record.measured = await measure(r.runtime, p?.phases?.step?.rule !== 'empty');
            const a = r.report?.actual;
            if (p && a) {
                if (a.initMs !== null && p.initMs !== undefined && p.initMs < a.initMs) record.underPredicted.push(`init: ${round(p.initMs)} predicted, ${round(a.initMs)} ran`);
                if (record.measured.stepMs !== null && p.computeMsPerFrame !== undefined && p.computeMsPerFrame < record.measured.stepMs) {
                    record.underPredicted.push(`step: ${round(p.computeMsPerFrame)} predicted, ${record.measured.stepMs} ran`);
                }
                if (record.measured.frameMs !== null && p.drawMsPerFrame !== undefined && p.drawMsPerFrame < record.measured.frameMs) {
                    record.underPredicted.push(`frame: ${round(p.drawMsPerFrame)} predicted, ${record.measured.frameMs} ran`);
                }
                // The first full-size frame runs cold (pipelines' first use, targets' first touch): its own prediction.
                if (a.firstFrameMs !== null && (p.firstFrameMs === undefined || p.firstFrameMs < a.firstFrameMs)) {
                    record.underPredicted.push(`first frame: ${round(p.firstFrameMs)} predicted, ${round(a.firstFrameMs)} ran`);
                }
            }
            // What it covers: the canvas it rendered, or the envelope the live cap holds that canvas to (`coveredPixels`).
            record.demands = (() => { const d = demandsOf(snap.x, coveredPixels); return typeof d === 'string' ? null : d; })();
            // The old head goes after the switch, as the studio's does; this one goes too unless it is kept.
            record.retireError = retire(head.runtime, head.held);
            head.runtime = r.runtime;
            head.held = r.held;
            if (!keep) {
                record.retireError = retire(head.runtime, head.held) ?? record.retireError;
                vp.setRuntime(null);
                head.runtime = null;
                head.held = null;
            }
        }
        if (!keep || r.status !== 'installed') record.baseline = head.runtime ? null : baselineProblem();
        record.uncaptured = uncaptured.slice(errorsBefore);
        const p = r.report?.probe;
        log(`${world} ×${k}: ${r.status}${r.status === 'installed' ? '' : `: ${r.reason}`}; L3 ${rows.map(m => `${m.module} ${m.ok ? 'ok' : 'REFUSED'} ${m.ms} ms`).join(', ')}`
            + (p ? `; predicted init ${round(p.initMs)} step ${round(p.computeMsPerFrame)} frame ${round(p.drawMsPerFrame)} first frame ${round(p.firstFrameMs)} ms` : '')
            + (r.report?.actual?.initMs != null ? `; ran init ${round(r.report.actual.initMs)} first frame ${round(r.report.actual.firstFrameMs)} ms` : '')
            + (record.measured ? `; steady step ${record.measured.stepMs} frame ${record.measured.frameMs} ms` : '')
            + (record.underPredicted.length ? `; UNDER-PREDICTED ${record.underPredicted.join(', ')}` : '')
            + (record.uncaptured.length ? `; ${record.uncaptured.length} uncaptured error(s)` : '')
            + (record.baseline ? `; ${record.baseline}` : ''));
        return record;
    };

    // EA-G1: each world at each scale.
    const runs: RunRecord[] = [];
    for (const [name, f] of FIXTURES) {
        for (const k of SCALES) runs.push(await one(name, k, await seal(name, f, k)));
    }

    // EA-G2's ordinary stops. Ten replacements back to back, each retiring the one before after its switch; the engine
    // back to its baseline once the last has gone (P5).
    const galaxyFixture = FIXTURES.find(([n]) => n === 'galaxy')![1];
    const replacements: RunRecord[] = [];
    for (let i = 0; i < 10; i++) replacements.push(await one('galaxy (replacement)', 1, await seal('galaxy', galaxyFixture, 1), { keep: true }));
    const lastRetire = retire(head.runtime, head.held);
    vp.setRuntime(null);
    head.runtime = null;
    head.held = null;
    const afterReplacements = { baseline: baselineProblem(), held: ledger.held(), retireError: lastRetire };
    log(`ten replacements: ${replacements.filter(r => r.status === 'installed').length}/10 installed; then ${afterReplacements.baseline ?? 'the engine at its baseline'}; ledger holds ${afterReplacements.held}`);

    // A cancel while the probe builds its variants: stopped, nothing installed, nothing left.
    const ac = new AbortController();
    const cancelled = await one('galaxy (cancelled)', 1, await seal('galaxy', galaxyFixture, 1), { signal: ac.signal, headless: async (w, h) => {
        const made = await createHeadlessPort(device, w, h);
        ac.abort();
        return made;
    } });
    const afterCancel = { baseline: baselineProblem(), held: ledger.held() };
    log(`a cancel during the probe: ${cancelled.status} (${cancelled.reason}); ${afterCancel.baseline ?? 'the engine at its baseline'}; ledger holds ${afterCancel.held}`);

    const foggyFixture = FIXTURES.find(([n]) => n === 'foggy-dusk')![1];
    const filmFixture = FIXTURES.find(([n]) => n === 'block-film')![1];
    /** A Head on the stage: galaxy, kept. What a candidate's stop must leave as it was. */
    const putHead = async () => {
        const r = await one('galaxy (the Head)', 1, await seal('galaxy', galaxyFixture, 1), { keep: true });
        return { record: r, runtime: head.runtime, held: head.held, counts: count(), bytes: ledger.held() };
    };
    /** Whether the Head still draws a frame on the canvas, with no error (inside a checkpoint). */
    const headDraws = async (runtime: AgentRuntime | null) => {
        if (!runtime) return 'no Head';
        const port = createNullGraphPort(vp.engine);
        const error = await port.checkpoint!(() => { vp.writeCamera(); vp.engine.render(runtime.draw()); });
        await fence();
        return error;
    };
    const takeHead = () => {
        const error = retire(head.runtime, head.held);
        vp.setRuntime(null);
        head.runtime = null;
        head.held = null;
        return error;
    };

    // EA-G2: a cancel during the stage's own compiles (createComputeStageAsync, createBatchAsync), with a Head on the
    // stage: stopped, the Head still the Head and still drawing, nothing of the candidate left (the review: "not during
    // compiles").
    const compileHead = await putHead();
    const compileAc = new AbortController();
    let compiles = 0;
    const duringCompiles = await one('foggy-dusk (cancelled during its compiles)', 1, await seal('foggy-dusk', foggyFixture, 1), {
        signal: compileAc.signal,
        portWrap: port => Object.assign(Object.create(port) as EnginePort, {
            createComputeStage: (...args: Parameters<EnginePort['createComputeStage']>) => { compiles++; const made = port.createComputeStage(...args); compileAc.abort(); return made; },
            createBatch: (...args: Parameters<EnginePort['createBatch']>) => { compiles++; const made = port.createBatch(...args); compileAc.abort(); return made; },
        }),
    });
    const cancelDuringCompiles = {
        record: duringCompiles, compiles, headKept: vp.runtime === compileHead.runtime, headDraws: await headDraws(compileHead.runtime),
        countsKept: JSON.stringify(count()) === JSON.stringify(compileHead.counts), heldKept: ledger.held() === compileHead.bytes, retireError: takeHead(),
        baseline: null as string | null, held: 0,
    };
    cancelDuringCompiles.baseline = baselineProblem();
    cancelDuringCompiles.held = ledger.held();
    log(`a cancel during the compiles, a Head on the stage: ${duringCompiles.status} (${duringCompiles.reason}) after ${compiles} compile(s) began; the Head ${cancelDuringCompiles.headKept ? 'kept' : 'LOST'}, `
        + `drawing ${cancelDuringCompiles.headDraws === null ? 'clean' : cancelDuringCompiles.headDraws}; then ${cancelDuringCompiles.baseline ?? 'the engine at its baseline'}`);

    // EA-G2: a probe over budget on the device. Foggy-dusk's fog layer 2,048 times (49,152 planes, every count within P v1),
    // with a drift body of the harness's own: the model's places each row of planes further off, so its extra planes fell
    // past the far plane and cost nothing (the first rerun, 11-01: ×512 ran as fast as ×1). This one stacks every plane
    // across the screen, each nearer than the one before, so the depth test hides none: about 29 G fragments a frame at
    // 2048×1152, past the cap on any laptop GPU. It must be refused by the probe, at a first run, before any full-size work.
    const fogNodes = new Set(['fog', 'placefog', 'driftfog', 'fogbatch']);
    const OVER = 2048;
    const stackedDrift = [
        'fn driftFog(index: u32) {',
        '    let base = index * B_fog_STRIDE;',
        '    let fi = f32(index);',
        '    b_fog[base + 0u] = 0.0;',
        '    b_fog[base + 1u] = 0.0;',
        '    b_fog[base + 2u] = 3.0;',
        '    b_fog[base + 3u] = -60.0 + fi * 0.001;',
        '    b_fog[base + 4u] = 0.0;',
        '    b_fog[base + 5u] = 0.0;',
        '    b_fog[base + 6u] = 0.0;',
        '    b_fog[base + 7u] = 1.0;',
        '    b_fog[base + 8u] = 100.0;',
        '    b_fog[base + 9u] = 100.0;',
        '    b_fog[base + 10u] = 1.0;',
        '    b_fog[base + 11u] = 0.76;',
        '    b_fog[base + 12u] = 0.7;',
        '    b_fog[base + 13u] = 0.82;',
        '}',
    ].join('\n');
    const overBudgetWorld: Fixture = {
        program: { nodes: foggyFixture.program.nodes.map(n => (fogNodes.has(n.id) ? scaled([n], OVER)[0] : n)) },
        modules: foggyFixture.modules.map(m => (m.module === 'fog_drift' ? { ...m, body: stackedDrift } : m)),
    };
    const overHead = await putHead();
    const overBudget = await one(`foggy-dusk (its fog ×${OVER}, stacked)`, OVER, await seal('foggy-dusk-stacked', overBudgetWorld, 1));
    const overBudgetResult = {
        // Either of the probe's refusals, both before any full-size work: over the cap, or measurements it cannot trust.
        record: overBudget, refused: overBudget.status === 'failed' && /^EA_PROBE(_UNVERIFIED)? /.test(overBudget.reason ?? ''), headKept: overBudget.status !== 'installed' ? vp.runtime === overHead.runtime : null,
        headDraws: overBudget.status !== 'installed' ? await headDraws(overHead.runtime) : null, retireError: takeHead(), baseline: null as string | null, held: 0,
    };
    overBudgetResult.baseline = baselineProblem();
    overBudgetResult.held = ledger.held();
    log(`over budget on this device: ${overBudget.status}${overBudget.reason ? ` (${overBudget.reason})` : ''}; ${overBudgetResult.baseline ?? 'the engine at its baseline'}`);

    // The coverage worlds (11-02, option B): every value Tier 1 allows, each through the same Run at scale 1. Evidence for
    // eligibility alone: one that is not clean adds nothing to it, and is reported, never a failure of the gate.
    const coverage: RunRecord[] = [];
    for (const [name, f] of COVERAGE) {
        try {
            coverage.push(await one(name, 1, await seal(name, f, 1)));
        } catch (e) {
            // Kept as what it is, so the worlds after it, and the result, still come back.
            const reason = String((e as Error)?.message ?? e).slice(0, 300);
            log(`${name} ×1: THREW: ${reason}`);
            coverage.push({
                world: name, scale: 1, candidate: null, status: 'threw', reason, l3: [], runMs: null, report: null, measured: null, underPredicted: [], uncaptured: [],
                baseline: null, retireError: null, demands: null,
            });
        }
    }
    log(`coverage worlds: ${coverage.filter(r => r.status === 'installed').length}/${coverage.length} installed`);

    // A device loss during the probe, with a Head on the stage, asked for alone: it ends this page's device. The candidate
    // stops as device-lost and installs nothing; the stage leaves the Head where it is (a shared device stops both: the
    // studio's own recovery, a reload to h1, is EA-E's); the ledger keeps the Head's share alone; every compile verdict is
    // void, so the same candidate's next Run is refused on its evidence, never replayed.
    let loss: { record: RunRecord; headKept: boolean; installed: boolean; heldIsHead: boolean; compilerLost: boolean; replay: string | null } | null = null;
    if (options.lose) {
        const lossHead = await putHead();
        const lossSnap = await seal('block-film', filmFixture, 1);
        const record = await one('block-film (device lost)', 1, lossSnap, { headless: async (w, h) => {
            const made = await createHeadlessPort(device, w, h);
            device.destroy();
            return made;
        } });
        let replay: string | null = null;
        if ('snap' in lossSnap) {
            const again = stageFor(lossSnap.snap);
            again.press(lossSnap.snap);
            const { verdicts } = await l3(lossSnap.snap);
            const r = await again.run(lossSnap.snap, verdicts);
            replay = r.status === 'installed' ? 'INSTALLED' : r.reason;
        }
        loss = {
            record, headKept: vp.runtime === lossHead.runtime, installed: !!vp.runtime && vp.runtime !== lossHead.runtime,
            heldIsHead: ledger.held() === lossHead.bytes, compilerLost: compiler.lost, replay,
        };
        log(`a device loss during the probe, a Head on the stage: ${record.status} (${record.reason}); the Head ${loss.headKept ? 'kept' : 'LOST'}; `
            + `installed ${loss.installed ? 'SOMETHING' : 'nothing'}; the next Run: ${replay}`);
    }

    // Eligibility for this environment, from the clean runs alone, the live worlds' and the coverage worlds': installed,
    // no uncaptured error, no prediction under what ran, the engine at its baseline after it.
    const clean = [...runs, ...coverage].filter(r => r.status === 'installed' && !r.uncaptured.length && !r.underPredicted.length && !r.baseline && !r.retireError && r.demands);
    const stamp = new Date().toISOString();
    const eligibility = 'key' in environment && clean.length && bundleHash
        ? eligibilityFrom(clean.flatMap(r => r.demands!), {
            environment: environment.key, engineBundleHash: bundleHash,
            evidence: `EA-G1 ${stamp.slice(0, 10)} on ${vp.gpuLabel}, ${navigator.userAgent.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0] ?? 'a browser'}: ${clean.map(r => `${r.world}×${r.scale}`).join(', ')}`,
        })
        : [];
    return {
        stamp, gpu: vp.gpuLabel, identity, environment, browser: navigator.userAgent, canvas: size(), envelope, limits: limitsOf(device), baseline,
        runs, replacements: { installed: replacements.filter(r => r.status === 'installed').length, records: replacements, after: afterReplacements },
        cancelled: { record: cancelled, after: afterCancel }, cancelDuringCompiles, overBudget: overBudgetResult, coverage, loss, uncaptured, lost, eligibility,
    };
}

const harness = {
    ready: true,
    result: null as unknown,
    run(options: { lose?: boolean; small?: boolean } = {}) {
        if (options.small) document.body.classList.add('small');
        run(options).then(r => { harness.result = r; }, e => { harness.result = { error: String((e as Error)?.stack ?? e) }; });
    },
};
(window as unknown as { __G1__: typeof harness }).__G1__ = harness;
