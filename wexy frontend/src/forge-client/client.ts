// The seam between the studio and the models: the ForgeClient of core-loop-frontend.md §10, the only way to a
// model (coding principles §9). Its sources are `live` (the backend's forge endpoints, live-client.ts), `archive`
// (the backend replaying a recorded generation: the stream says so in its meta, and FE6 adds the archive's own
// endpoints) and `mock` (the playground's hand-written worlds and the host's exemplars, mock-client.ts, which
// calls nothing). The source travels with every result, so no world is ever shown as made live when it was not.

import type { Draft } from '../contract/draft';
import type { EditPlan } from '../contract/edit-plan';
import type { FunctionName, SceneSpec, Style } from '../contract/spec';
import type { StreamUsage } from './sse';

export type Source = 'live' | 'archive' | 'mock';

/**
 * One model call, as the backend recorded it: the stream's meta and usage, and the client's own clocks. A mock
 * call makes no request, so it has no model or usage; unknown is null, never zero (coding principles §5).
 */
export interface GenerationInfo {
    generationId: string;
    source: Source;
    model: string | null;
    role: string | null;
    fn: FunctionName | null;
    promptVersion: string | null;
    usage: StreamUsage | null;
    /** Wall clock from the request to its last event. */
    ms: number;
    /** Wall clock to the first visible text, or null when none came. */
    ttftMs: number | null;
}

export interface PlanRequest {
    prompt: string;
    style: Style | 'auto';
    seconds: number;
    /**
     * The plan this one replaces after the model failed it, its generation id (the W1 bug hunt, 2026-11-02): the loop's
     * own retry, which then runs inside that plan's prompt instead of asking for a second one. Absent on a first plan.
     */
    retryOf?: string;
}

export interface PlanResult {
    draft: Draft;
    /** The answer's text, as streamed, for the provenance sheet. */
    text: string;
    generation: GenerationInfo;
    /** What rung L0 clamped into range. */
    clamped: string[];
    /** A source that already holds the world's code (a playground example, an archive hit) hands the whole spec over: no author step. */
    ready?: SceneSpec;
}

export interface FunctionResult {
    fn: FunctionName;
    /** The function alone: the fence rule applied (contract/unfence.ts), nothing else changed. */
    text: string;
    generation: GenerationInfo;
}

export interface DirectResult {
    edit: EditPlan;
    generation: GenerationInfo;
}

/** A finding of the browser's checks, as `POST /v1/forge/repair` carries it (forge-loop design §5.1). */
export interface RepairDiagnostic {
    source: 'tint' | 'contract' | 'probe' | 'sanity';
    /** Counted from the function's first line; 0 when the finding has no place. */
    line: number;
    column: number;
    message: string;
    snippet: string;
}

/** The backend's caps on a repair request (LoopProperties.Caps); over one is 413, so the client keeps under them. */
export const REPAIR_CAPS = { diagnostics: 20, messageChars: 300, snippetChars: 200 } as const;

/** Findings capped as the backend requires, errors first. */
export function toRepairDiagnostics(found: readonly { source: RepairDiagnostic['source']; line: number; column: number; message: string; snippet: string }[]): RepairDiagnostic[] {
    return found.slice(0, REPAIR_CAPS.diagnostics).map(d => ({
        source: d.source,
        line: Math.max(0, Math.floor(d.line)),
        column: Math.max(0, Math.floor(d.column)),
        message: d.message.slice(0, REPAIR_CAPS.messageChars),
        snippet: d.snippet.slice(0, REPAIR_CAPS.snippetChars),
    }));
}

/** The browser's report on a world it verified and ran (`POST /v1/forge/outcomes`; core-loop-frontend.md §11). */
export interface OutcomeReport {
    /** The plan, its functions and their repairs: at most 16. */
    generationIds: string[];
    /** The ladder's results and timings, at most 4 KB as compact JSON. */
    ladder: Record<string, unknown>;
    firstPassOk: boolean;
    repairs: number;
    autofixes: number;
    probeMs: number | null;
    predictedMs: number | null;
    fps: number | null;
    /** The GPU's vendor and architecture as WebGPU names them, at most 64 characters. */
    adapter: string | null;
    browser: string | null;
}

export const OUTCOME_CAPS = { ids: 16, ladderBytes: 4096, labelChars: 64, count: 255 } as const;

export interface StreamProgress {
    /** The visible text so far, as it streams. */
    onText?(soFar: string): void;
    /** The stream's first event: which generation, model and source answer. */
    onMeta?(generation: Pick<GenerationInfo, 'generationId' | 'source' | 'model' | 'role' | 'fn' | 'promptVersion'>): void;
}

export interface ForgeClient {
    readonly source: Source;
    /** The planner: an idea becomes a draft (rung L0 applied), streamed. */
    plan(req: PlanRequest, progress: StreamProgress, signal: AbortSignal): Promise<PlanResult>;
    /** The author: one function of a plan the backend holds, streamed. */
    author(fn: FunctionName, planId: string, progress: StreamProgress, signal: AbortSignal): Promise<FunctionResult>;
    /** A repair: the generation that wrote the function, and what the browser's checks found. */
    repair(fn: FunctionName, generationId: string, diagnostics: RepairDiagnostic[], progress: StreamProgress, signal: AbortSignal): Promise<FunctionResult>;
    /**
     * The director: the running world and one instruction, answered as an edit plan (applied by FE2). `planId`, the plan
     * whose world it edits (its generation id), keeps the turn inside that plan's prompt (W1, 2026-11-02; the creations
     * platform designs §10); a turn without one, on a starter world say, spends a prompt of its own.
     */
    direct(spec: SceneSpec, turn: string, signal: AbortSignal, planId?: string): Promise<DirectResult>;
    /** What the browser found; the caller does not wait for it. */
    report(outcome: OutcomeReport): Promise<void>;
}
