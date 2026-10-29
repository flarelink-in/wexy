// The verify ladder on a device (core-loop-frontend.md §7), as the loop's Verifier: L1 lint and L2 auto-fix
// (gate.ts), L3 compile (gate.ts), then on a small world of the same spec L5 the probe and L7 the sanity look
// (probe.ts), and only then L6 the full build and smoke frame (SceneRuntime.build). L7 runs before L6 so a world
// with a NaN or a black frame never costs a full-size build, and the live canvas never shows a candidate (the
// FE1 design's refinement of §7). The world it hands back is the built runtime, with the spec as compiled (the
// auto-fixed text, which the probe, the full build and later the film all use); L8, the swap, is the studio's.

import type { NullGraph } from 'null-graph';
import { functionsOf, type FunctionName, type SceneSpec } from '../contract/spec';
import type { FailureReason, LadderReport, Rung, RungResult, VerifyResult, Verifier } from '../loop/machine';
import { SceneRuntime } from '../runtime/scene-runtime';
import { compileTarget, lintTarget, type GateDiagnostic } from './gate';
import { destroyProbeWorld, probeWorld, sanityLook } from './probe';

export interface LadderOptions {
    /** The full world's size: the viewport's canvas. */
    width: () => number;
    height: () => number;
    /** The expert setting's probe: the playground examples ran before the probe existed and are measured, not predicted; on by default for them too. */
    probeHooks?: boolean;
}

export function createLadder(engine: NullGraph, options: LadderOptions): Verifier<SceneRuntime> {
    const { device } = engine;
    return {
        async verify(spec: SceneSpec, signal: AbortSignal): Promise<VerifyResult<SceneRuntime>> {
            const t0 = performance.now();
            const rungs: RungResult[] = [];
            const autofixes: LadderReport['autofixes'] = {};
            const report = (probe: LadderReport['probe']): LadderReport => ({ rungs, autofixes, probe, totalMs: performance.now() - t0 });
            const fail = (rung: Rung, reason: FailureReason, target: FunctionName | null, diagnostics: GateDiagnostic[], message: string, probe: LadderReport['probe'] = null): VerifyResult<SceneRuntime> =>
                ({ ok: false, report: report(probe), failure: { rung, reason, target, diagnostics, message } });
            const targets = spec.program.kind === 'functions' ? functionsOf(spec) : (['evolve', 'particles', 'backdrop'] as const).filter(h => h === 'evolve' || h === 'particles' || spec.program.kind === 'hooks' && spec.program.backdrop !== undefined);
            const asFunction = (target: string): FunctionName | null => (spec.program.kind === 'functions' ? (target as FunctionName) : null);

            // L1 and L2: each function (or hook) linted, the auto-fix applied first.
            let t = performance.now();
            for (const target of targets) {
                if ((spec.program as Record<string, string | undefined>)[target] === undefined) {
                    rungs.push({ rung: 'L1', ok: false, ms: performance.now() - t, detail: `no ${target}` });
                    return fail('L1', 'missing', asFunction(target), [], `the world has no ${target}`);
                }
                const lint = lintTarget(spec, target);
                if (lint.autofixes.length && spec.program.kind === 'functions') autofixes[target as FunctionName] = lint.autofixes.map(f => ({ line: f.line, rule: f.rule }));
                if (lint.diagnostics.length) {
                    rungs.push({ rung: 'L1', ok: false, ms: performance.now() - t, detail: `${target}: ${lint.diagnostics[0].message}` });
                    return fail('L1', 'lint', asFunction(target), lint.diagnostics, `${target} line ${lint.diagnostics[0].line}: ${lint.diagnostics[0].message}`);
                }
            }
            rungs.push({ rung: 'L1', ok: true, ms: performance.now() - t });
            rungs.push({ rung: 'L2', ok: true, ms: 0, detail: Object.entries(autofixes).map(([fn, f]) => `${fn}: ${f.length}`).join(', ') || undefined });
            signal.throwIfAborted();

            // L3: the compiler, one module per target; the auto-fixed text is what it sees.
            t = performance.now();
            let compiled = spec;
            for (const target of targets) {
                const r = await compileTarget(device, spec, target);
                if (spec.program.kind === 'functions' && r.text !== (spec.program as Record<string, string | undefined>)[target]) {
                    compiled = { ...compiled, program: { ...compiled.program, [target]: r.text } };
                }
                const errors = r.diagnostics.filter(d => d.severity === 'error');
                if (errors.length) {
                    rungs.push({ rung: 'L3', ok: false, ms: performance.now() - t, detail: `${target} line ${errors[0].line}: ${errors[0].message}` });
                    return fail('L3', 'compile', asFunction(target), errors, `${target}.wgsl line ${errors[0].line}, column ${errors[0].column}: ${errors[0].message}`);
                }
            }
            rungs.push({ rung: 'L3', ok: true, ms: performance.now() - t });
            signal.throwIfAborted();

            // L5 and L7 on the probe's small worlds; a cancel stops the probe's warm-up (F4).
            t = performance.now();
            const probed = await probeWorld(device, compiled, options.width() * options.height(), signal);
            if ('error' in probed) {
                rungs.push({ rung: 'L5', ok: false, ms: performance.now() - t, detail: probed.error });
                return fail('L5', 'smoke', null, [], `the probe's world did not build: ${probed.error}`);
            }
            const probe: LadderReport['probe'] = probed.numbers;
            const draw = probe.frameMs === null ? 'draw not timed' : `draw ${probe.frameMs.toFixed(1)}`;
            rungs.push({ rung: 'L5', ok: !probed.diagnostic, ms: performance.now() - t, detail: `predicted ${Math.round(probe.predictedMs)} ms a frame (step ${probe.stepMs.toFixed(1)}, ${draw}); budget ${probe.budgetMs}` });
            if (probed.diagnostic) {
                return fail('L5', 'probe', asFunction(probed.diagnostic.target), [probed.diagnostic], probed.diagnostic.message, probe);
            }
            try {
                signal.throwIfAborted();
                t = performance.now();
                const sanity = await sanityLook(device, probed.world, compiled);
                rungs.push({ rung: 'L7', ok: sanity.ok, ms: performance.now() - t, detail: `finite ${sanity.numbers.nonFinite === 0 ? 'yes' : 'no'}, moved ${sanity.numbers.moved}, median distance ${sanity.numbers.medianDistance.toFixed(1)}, frame mean ${sanity.numbers.frameMean.toFixed(3)}` });
                if (!sanity.ok) {
                    return fail('L7', 'sanity', asFunction(sanity.diagnostic!.target), [sanity.diagnostic!], sanity.diagnostic!.message, probe);
                }
            } finally {
                destroyProbeWorld(probed.world);
            }
            signal.throwIfAborted();

            // L6: the full world, built inside error scopes with one frame drawn.
            t = performance.now();
            const { runtime, smoke } = await SceneRuntime.build(engine, compiled, options.width(), options.height());
            rungs.push({ rung: 'L6', ok: smoke.ok, ms: smoke.ms, detail: smoke.error });
            if (!runtime) return fail('L6', 'smoke', null, [], smoke.error ?? 'the GPU rejected the world', probe);
            if (signal.aborted) {
                runtime.destroy();
                signal.throwIfAborted();
            }
            return { ok: true, world: runtime, report: report(probe), spec: compiled };
        },
    };
}
