// The browser's report on a world (core-loop-frontend.md §11; the backend's OutcomeRequest and its caps): built
// from the loop's generations and the ladder's report, within the backend's sizes, with what only the live world
// can add (fps after settling, the adapter, the browser) filled in by the studio before it is sent.

import { OUTCOME_CAPS, type GenerationInfo, type OutcomeReport } from '../forge-client/client';
import type { LadderReport } from './machine';

const label = (s: string | null | undefined): string | null => (s ? s.slice(0, OUTCOME_CAPS.labelChars) : null);
const count = (n: number) => Math.min(OUTCOME_CAPS.count, Math.max(0, Math.round(n)));

/** The ladder as the backend keeps it: each rung's result and time, the probe's numbers, within 4 KB. */
export function compactLadder(report: LadderReport): Record<string, unknown> {
    const full: Record<string, unknown> = {};
    for (const r of report.rungs) full[r.rung] = r.detail ? { ok: r.ok, ms: round(r.ms), detail: r.detail.slice(0, 120) } : { ok: r.ok, ms: round(r.ms) };
    if (report.probe) {
        const { stepMs, frameMs, predictedMs, budgetMs } = report.probe;
        full.probe = { step: round(stepMs), frame: frameMs === null ? null : round(frameMs), predicted: round(predictedMs), budget: budgetMs };
    }
    full.totalMs = round(report.totalMs);
    if (JSON.stringify(full).length <= OUTCOME_CAPS.ladderBytes) return full;
    // Over the cap: drop the details, which are the only free text.
    for (const r of report.rungs) full[r.rung] = { ok: r.ok, ms: round(r.ms) };
    return full;
}

function round(ms: number): number {
    return Math.round(ms * 10) / 10;
}

export function buildOutcome(generations: GenerationInfo[], report: LadderReport, stats: { repairs: number; autofixes: number; firstPassOk: boolean }): OutcomeReport {
    return {
        generationIds: generations.map(g => g.generationId).filter(Boolean).slice(0, OUTCOME_CAPS.ids),
        ladder: compactLadder(report),
        firstPassOk: stats.firstPassOk,
        repairs: count(stats.repairs),
        autofixes: count(stats.autofixes),
        probeMs: report.probe && report.probe.measuredFrameMs !== null ? round(report.probe.measuredStepMs + report.probe.measuredFrameMs) : null,
        predictedMs: report.probe ? round(report.probe.predictedMs) : null,
        fps: null,
        adapter: null,
        browser: null,
    };
}

/** The report with what the live world measured; nothing is invented (unknown stays null). */
export function completeOutcome(outcome: OutcomeReport, live: { fps: number | null; adapter: string | null; browser: string | null }): OutcomeReport {
    return {
        ...outcome,
        fps: live.fps === null || !Number.isFinite(live.fps) ? null : round(Math.max(0, live.fps)),
        adapter: label(live.adapter),
        browser: label(live.browser),
    };
}
