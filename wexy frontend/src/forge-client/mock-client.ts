// The mock ForgeClient: no network, no key, no model. Two kinds of hand-written world, replayed with scripted
// pacing: the playground's three examples (whole hooks, the expert setting) and host h1's two exemplar worlds
// (galaxy and storm: the backend's recorded plans and the exemplar functions, the same bytes its mock upstream
// serves), which drive the Standard path end to end. Every byte the studio compiles and renders is real; the
// authorship is not, so a mock call reports no model, tokens or cost, and the studio labels the world a
// playground example (design guidelines §3). The pacing is fiction too (red team R3): never tune on it.

import { parseDraft, type Draft } from '../contract/draft';
import { H1, EXEMPLAR_WORLDS, type ExemplarWorld } from '../contract/h1';
import { type FunctionName, type SceneSpec, type Style, programText, withProgramText } from '../contract/spec';
import { ARCHETYPES, archetypeDraft, archetypeSpec, routePrompt, type Archetype } from './archetypes';
import type { DirectResult, ForgeClient, FunctionResult, GenerationInfo, OutcomeReport, PlanRequest, PlanResult, RepairDiagnostic, StreamProgress } from './client';

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** Reveal `text` over roughly `ms` in 40 ms chunks (a token stream's cadence), with everything so far; `pace` 0 reveals it at once. */
async function stream(text: string, ms: number, onText: ((soFar: string) => void) | undefined, signal: AbortSignal, pace: number): Promise<void> {
    if (pace <= 0) {
        signal.throwIfAborted();
        onText?.(text);
        return;
    }
    const ticks = Math.max(1, Math.round((ms * pace) / 40));
    const per = Math.max(1, Math.ceil(text.length / ticks));
    for (let i = per; i < text.length + per; i += per) {
        await sleep(40, signal);
        onText?.(text.slice(0, i));
    }
}

const jitter = (base: number) => base * (0.85 + Math.random() * 0.3);

/** Which exemplar world an idea asks for, if any; the playground examples are routed by their own keywords. */
const EXEMPLAR_WORDS: Record<ExemplarWorld, RegExp> = {
    galaxy: /galax|spiral|milky|nebula|\bstars?\b|andromeda/i,
    storm: /storm|thunder|cloud|lightning|cumul|rain/i,
};

export interface MockOptions {
    /** Serve the galaxy's evolve with one real WGSL mistake, so the repair path runs (the backend's `fault` scenario). */
    fault?: boolean;
    /** The pacing's multiplier: 1 is the scripted cadence, 0 answers at once (tests). */
    pace?: number;
}

let counter = 0;

export class MockClient implements ForgeClient {
    readonly source = 'mock' as const;
    private readonly options: MockOptions;
    /** The worlds this client planned, by generation id, so author and repair know what they are writing. */
    private readonly planned = new Map<string, { world: ExemplarWorld; draft: Draft }>();
    private readonly written = new Map<string, { world: ExemplarWorld; fn: FunctionName; text: string }>();

    private readonly pace: number;

    constructor(options: MockOptions = {}) {
        this.options = options;
        this.pace = options.pace ?? 1;
    }

    private wait(ms: number, signal: AbortSignal): Promise<void> {
        return this.pace <= 0 ? Promise.resolve(signal.throwIfAborted()) : sleep(jitter(ms) * this.pace, signal);
    }

    private generation(partial: Partial<GenerationInfo>, t0: number, ttft: number | null): GenerationInfo {
        return {
            generationId: `mock-${++counter}`, source: 'mock', model: null, role: null, fn: null, promptVersion: null, usage: null,
            ms: performance.now() - t0, ttftMs: ttft === null ? null : ttft - t0, ...partial,
        };
    }

    async plan(req: PlanRequest, progress: StreamProgress, signal: AbortSignal): Promise<PlanResult> {
        const t0 = performance.now();
        const world = EXEMPLAR_WORLDS.find(w => EXEMPLAR_WORDS[w].test(req.prompt));
        const playground = world ? null : routePrompt(req.prompt, req.style).archetype;
        const text = world ? H1.plans[world] : JSON.stringify(archetypeDraft(playground!), null, 2);
        await this.wait(420, signal);
        const ttft = performance.now();
        await stream(text, jitter(1500), progress.onText, signal, this.pace);
        const parsed = parseDraft(text);
        if (!parsed.draft) throw new Error(`The mock's plan is not a valid draft: ${parsed.problems.join('; ')}`);
        const draft = parsed.draft;
        if (req.style !== 'auto') draft.style = req.style;
        const generation = this.generation({ role: 'planner' }, t0, ttft);
        if (world) {
            this.planned.set(generation.generationId, { world, draft });
            return { draft, text, generation, clamped: parsed.clamped };
        }
        return { draft, text, generation, clamped: parsed.clamped, ready: personalise(playground!, req) };
    }

    async author(fn: FunctionName, planId: string, progress: StreamProgress, signal: AbortSignal): Promise<FunctionResult> {
        const t0 = performance.now();
        const plan = this.planned.get(planId);
        if (!plan) throw new Error(`The mock holds no plan ${planId}.`);
        const faulted = this.options.fault && fn === 'evolve' && plan.world === 'galaxy';
        const text = faulted ? H1.faults['galaxy.evolve'] : H1.exemplars[plan.world][fn];
        await this.wait(520, signal);
        const ttft = performance.now();
        await stream(text, jitter(900 + text.length / 2), progress.onText, signal, this.pace);
        const generation = this.generation({ role: 'author', fn }, t0, ttft);
        this.written.set(generation.generationId, { world: plan.world, fn, text });
        return { fn, text, generation };
    }

    async repair(fn: FunctionName, generationId: string, _diagnostics: RepairDiagnostic[], progress: StreamProgress, signal: AbortSignal): Promise<FunctionResult> {
        const t0 = performance.now();
        const wrote = this.written.get(generationId);
        if (!wrote || wrote.fn !== fn) throw new Error(`The mock holds no ${fn} generation ${generationId}.`);
        // The mock can only replay the fix it has: the exemplar the fault was made from.
        const text = H1.exemplars[wrote.world][fn];
        await this.wait(780, signal);
        const ttft = performance.now();
        await stream(text, jitter(900), progress.onText, signal, this.pace);
        const generation = this.generation({ role: 'repairer', fn }, t0, ttft);
        this.written.set(generation.generationId, { world: wrote.world, fn, text });
        return { fn, text, generation };
    }

    async direct(_spec: SceneSpec, _turn: string, signal: AbortSignal): Promise<DirectResult> {
        const t0 = performance.now();
        await this.wait(500, signal);
        return { edit: { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.9 }], summary: 'The glow is stronger.' }, generation: this.generation({ role: 'director' }, t0, null) };
    }

    async report(_outcome: OutcomeReport): Promise<void> {
        // No backend hears a playground example.
    }
}

/** A playground example's spec for this request: the style the creator chose moves the grading it can carry. */
function personalise(archetype: Archetype, req: PlanRequest): SceneSpec {
    const spec = archetypeSpec(archetype);
    for (const t of archetype.tweaks) {
        if (t.match.test(req.prompt) && spec.uniforms[t.uniform]) spec.uniforms[t.uniform].value = t.value;
    }
    const style: Style = req.style === 'auto' ? archetype.style : req.style;
    spec.style = style;
    const post = spec.post;
    // Style only moves grading the archetype can carry; it never swaps the scene's own look.
    if (style !== archetype.style) {
        if (style === 'brutalist') {
            post.tonemap = { curve: 'agx', exposure: (post.tonemap?.exposure ?? 1) * 1.05 };
            post.vignette = { intensity: 0.42, softness: 0.5 };
            if (post.bloom) post.bloom.intensity *= 0.7;
        } else if (style === 'cinematic' || style === 'anime-cel') {
            post.halation ??= { threshold: 1.0, intensity: 0.3, radius: 1.6, tint: [1, 0.38, 0.18] };
            post.vignette = { intensity: 0.28, softness: 0.6 };
            if (style === 'anime-cel') post.fxaa = true;
        } else if (style === 'cosmic' && post.bloom) {
            post.bloom.intensity *= 1.2;
        }
    }
    return spec;
}

/** The scripted fault of a playground example applied to its spec (?fault=1), for the hook path's repair display. */
export function withArchetypeFault(spec: SceneSpec, archetype: Archetype): SceneSpec {
    const text = programText(spec, archetype.fault.hook) ?? '';
    return withProgramText(spec, archetype.fault.hook, text.replace(archetype.fault.find, archetype.fault.replace));
}

export { ARCHETYPES };
