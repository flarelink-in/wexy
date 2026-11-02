// The live ForgeClient: the backend's forge endpoints over the transport (http.ts, sse.ts), as the forge-loop
// design §5.1 and §10 define them. Each call has a deadline of its own, the server's role timeout plus a margin
// (FE1 design Q39): the server ends a slow call with `error timeout` first, and the client's deadline only catches
// a connection that stopped answering. Policy (a retry, a re-plan) lives in the loop, not here.

import { parseDraft } from '../contract/draft';
import { parseEditPlan } from '../contract/edit-plan';
import type { FunctionName, SceneSpec } from '../contract/spec';
import { unfence } from '../contract/unfence';
import type { DirectResult, ForgeClient, FunctionResult, GenerationInfo, OutcomeReport, PlanResult, RepairDiagnostic, StreamProgress } from './client';
import { ForgeError } from './errors';
import type { Api } from './http';
import { readForgeStream, type StreamMeta, type StreamUsage } from './sse';

/** The server's deadlines (wexy.roles.*.timeout: planner 30 s, author 60 s, repairer 45 s, escalator 60 s, director 20 s), plus five. */
export const DEADLINES = { planMs: 35_000, authorMs: 65_000, repairMs: 65_000, directMs: 25_000, reportMs: 15_000 } as const;

export type Deadlines = typeof DEADLINES;

const FUNCTION_NAMES = new Set<string>(['evolve', 'look', 'sky']);

/** `signal` and a deadline together; a deadline that fires rejects the fetch with a TimeoutError. */
function within(signal: AbortSignal, ms: number): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function timedOut(error: unknown, what: string, ms: number): never {
    if ((error as Error)?.name === 'TimeoutError') {
        throw new ForgeError('timeout', 0, `The ${what} gave no answer within ${Math.round(ms / 1000)} s; the connection was dropped.`);
    }
    throw error;
}

function info(meta: StreamMeta | null, usage: StreamUsage | null, t0: number, ttft: number | null): GenerationInfo {
    return {
        generationId: meta?.generationId ?? '',
        source: meta?.source ?? 'live',
        model: meta?.model ?? null,
        role: meta?.role ?? null,
        fn: meta?.fn && FUNCTION_NAMES.has(meta.fn) ? (meta.fn as FunctionName) : null,
        promptVersion: meta?.promptVersion ?? null,
        usage,
        ms: performance.now() - t0,
        ttftMs: ttft === null ? null : ttft - t0,
    };
}

export function createLiveClient(api: Api, deadlines: Deadlines = DEADLINES): ForgeClient {
    /** One streamed call: the request, the stream to its end, the text and its generation. */
    async function stream(path: string, body: unknown, what: string, ms: number, progress: StreamProgress, signal: AbortSignal) {
        const t0 = performance.now();
        let ttft: number | null = null;
        try {
            const res = await api.send({ method: 'POST', path, body, auth: true, accept: 'text/event-stream', signal: within(signal, ms) });
            const result = await readForgeStream(res, {
                onMeta: m => {
                    progress.onMeta?.({
                        generationId: m.generationId, source: m.source, model: m.model, role: m.role ?? null,
                        fn: m.fn && FUNCTION_NAMES.has(m.fn) ? (m.fn as FunctionName) : null, promptVersion: m.promptVersion ?? null,
                    });
                },
                onDelta: (_piece, soFar) => {
                    ttft ??= performance.now();
                    progress.onText?.(soFar);
                },
            });
            return { text: result.text, generation: info(result.meta, result.usage, t0, ttft) };
        } catch (error) {
            return timedOut(error, what, ms);
        }
    }

    return {
        source: 'live',

        async plan(req, progress, signal): Promise<PlanResult> {
            const body = { prompt: req.prompt, style: req.style, seconds: req.seconds, ...(req.retryOf ? { retryOf: req.retryOf } : {}) };
            const { text, generation } = await stream('/v1/forge/plan', body, 'planner', deadlines.planMs, progress, signal);
            const parsed = parseDraft(text);
            if (!parsed.draft) {
                // The server validated the same text; a refusal here is a drift between the two schemas, said plainly.
                throw new ForgeError('upstream', 200, `The plan didn't come through: ${parsed.problems.slice(0, 3).join('; ')}.`);
            }
            return { draft: parsed.draft, text, generation, clamped: parsed.clamped };
        },

        async author(fn, planId, progress, signal): Promise<FunctionResult> {
            const { text, generation } = await stream('/v1/forge/author', { planId, fn }, `author of ${fn}`, deadlines.authorMs, progress, signal);
            return { fn, text: unfence(text), generation };
        },

        async repair(fn, generationId, diagnostics: RepairDiagnostic[], progress, signal): Promise<FunctionResult> {
            const { text, generation } = await stream('/v1/forge/repair', { generationId, diagnostics }, `repair of ${fn}`, deadlines.repairMs, progress, signal);
            return { fn, text: unfence(text), generation };
        },

        async direct(spec: SceneSpec, turn: string, signal, planId?: string): Promise<DirectResult> {
            const t0 = performance.now();
            try {
                const body = planId ? { spec, turn, planId } : { spec, turn };
                const res = await api.send({ method: 'POST', path: '/v1/forge/direct', body, auth: true, signal: within(signal, deadlines.directMs) });
                const doc = await res.json() as Record<string, unknown>;
                const usage = doc.usage && typeof doc.usage === 'object' ? (doc.usage as StreamUsage) : null;
                const generation: GenerationInfo = {
                    generationId: String(doc.generationId ?? ''),
                    source: doc.source === 'archive' ? 'archive' : 'live',
                    model: typeof doc.model === 'string' ? doc.model : null,
                    role: typeof doc.role === 'string' ? doc.role : null,
                    fn: null,
                    promptVersion: typeof doc.promptVersion === 'string' ? doc.promptVersion : null,
                    usage,
                    ms: performance.now() - t0,
                    ttftMs: null,
                };
                try {
                    return { edit: parseEditPlan(doc), generation };
                } catch (error) {
                    throw new ForgeError('internal', res.status, (error as Error).message);
                }
            } catch (error) {
                return timedOut(error, 'director', deadlines.directMs);
            }
        },

        async report(outcome: OutcomeReport): Promise<void> {
            const res = await api.send({ method: 'POST', path: '/v1/forge/outcomes', body: outcome, auth: true, signal: AbortSignal.timeout(deadlines.reportMs) });
            await res.body?.cancel();
        },
    };
}
