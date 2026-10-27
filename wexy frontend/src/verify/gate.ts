// Rungs L1 to L3 of the ladder (core-loop-frontend.md §7): the contract lint and the auto-fix for a Standard
// function (contract/lint.ts, autofix.ts), the host-contract lint for an expert hook (contract/wgsl.ts), and the
// compile gate: every module goes through the browser's own WGSL compiler (Tint in Chrome, Naga in Firefox)
// before any pipeline is built. Diagnostics come back with the module's line numbers, mapped onto the function's
// own lines so the repair turn can quote the line (invariant I2: nothing reaches createShaderModule before L1
// and L2, and this module is the only place that calls it with model-written text).

import { autofix, type AutoFix } from '../contract/autofix';
import { assembleModule, functionLine } from '../contract/host';
import { lintFunction } from '../contract/lint';
import { functionsOf, hooksOf, programText, targetsOf, type FunctionName, type HookName, type ProgramTarget, type SceneSpec } from '../contract/spec';
import { headerLineCount, hookHeader, lintHook, lintUniformNames } from '../contract/wgsl';

export interface GateDiagnostic {
    target: ProgramTarget;
    severity: 'error' | 'warning' | 'info';
    source: 'tint' | 'contract' | 'probe' | 'sanity';
    /** 1-based line in the function or hook; 0 when the problem has no single line. */
    line: number;
    column: number;
    message: string;
    snippet: string;
}

export interface TargetReport {
    target: ProgramTarget;
    /** createShaderModule + getCompilationInfo, wall clock; 0 when the lint refused it first. */
    ms: number;
    lines: number;
    /** The text as compiled: after the auto-fix, for a function. */
    text: string;
    autofixes: AutoFix[];
    diagnostics: GateDiagnostic[];
}

export interface GateReport {
    ok: boolean;
    totalMs: number;
    targets: TargetReport[];
    errors: GateDiagnostic[];
}

const snippetOf = (text: string, line: number) => (line > 0 ? text.split('\n')[line - 1]?.trim() ?? '' : '');

/** The lint of one target, and (for a function) the auto-fixed text the compiler will see. */
export function lintTarget(spec: SceneSpec, target: ProgramTarget): { text: string; autofixes: AutoFix[]; diagnostics: GateDiagnostic[] } {
    const raw = programText(spec, target) ?? '';
    if (spec.program.kind === 'functions') {
        const fn = target as FunctionName;
        const fixed = autofix(raw);
        const diagnostics: GateDiagnostic[] = lintFunction(fn, fixed.body).map(issue => ({
            target, severity: 'error', source: 'contract', line: issue.line, column: issue.line ? 1 : 0, message: issue.message, snippet: snippetOf(fixed.body, issue.line),
        }));
        return { text: fixed.body, autofixes: fixed.fixes, diagnostics };
    }
    const hook = target as HookName;
    const diagnostics: GateDiagnostic[] = lintHook(hook, raw).map(issue => ({
        target, severity: 'error', source: 'contract', line: issue.line, column: issue.line ? 1 : 0, message: issue.message, snippet: snippetOf(raw, issue.line),
    }));
    return { text: raw, autofixes: [], diagnostics };
}

/** The module one target compiles into, and where its own lines start. */
function moduleOf(spec: SceneSpec, target: ProgramTarget, text: string): { code: string; toLine: (moduleLine: number) => number } {
    if (spec.program.kind === 'functions') {
        const assembled = assembleModule(target as FunctionName, text, spec.uniforms);
        return { code: assembled.code, toLine: moduleLine => functionLine(assembled, moduleLine) };
    }
    const header = hookHeader(target as HookName, spec.uniforms);
    const offset = headerLineCount(header);
    return { code: header + text, toLine: moduleLine => Math.max(0, moduleLine - offset) };
}

/** L1, L2 and L3 for one target. A lint error stops before the compiler: the text never reaches the device. */
export async function compileTarget(device: GPUDevice, spec: SceneSpec, target: ProgramTarget): Promise<TargetReport> {
    const { text, autofixes, diagnostics } = lintTarget(spec, target);
    const lines = text ? text.split('\n').length : 0;
    if (diagnostics.length) return { target, ms: 0, lines, text, autofixes, diagnostics };

    const { code, toLine } = moduleOf(spec, target, text);
    // An invalid module also raises a validation error; the scope keeps it off the console, since
    // getCompilationInfo carries the useful part (line, column, message).
    device.pushErrorScope('validation');
    const t0 = performance.now();
    const module = device.createShaderModule({ label: `wexy/${target}`, code });
    const info = await module.getCompilationInfo();
    const ms = performance.now() - t0;
    await device.popErrorScope();

    for (const m of info.messages) {
        const line = toLine(m.lineNum);
        diagnostics.push({ target, severity: m.type, source: 'tint', line, column: line ? m.linePos : 0, message: m.message, snippet: snippetOf(text, line) });
    }
    return { target, ms, lines, text, autofixes, diagnostics };
}

/** Every target of the spec through L1 to L3. `ok` means no error from the lint, the compiler or the controls. */
export async function runGate(device: GPUDevice, spec: SceneSpec): Promise<GateReport> {
    const t0 = performance.now();
    const targets: TargetReport[] = [];
    const wanted: ProgramTarget[] = spec.program.kind === 'functions' ? functionsOf(spec) : hooksOf(spec.program);
    for (const target of wanted) {
        if (programText(spec, target) === undefined) {
            targets.push({ target, ms: 0, lines: 0, text: '', autofixes: [], diagnostics: [{ target, severity: 'error', source: 'contract', line: 0, column: 0, message: `the world has no ${target}`, snippet: '' }] });
            continue;
        }
        targets.push(await compileTarget(device, spec, target));
    }
    const errors = targets.flatMap(t => t.diagnostics.filter(d => d.severity === 'error'));
    for (const problem of lintUniformNames(spec.uniforms)) {
        errors.push({ target: targetsOf(spec)[0], severity: 'error', source: 'contract', line: 0, column: 0, message: problem, snippet: '' });
    }
    return { ok: errors.length === 0, totalMs: performance.now() - t0, targets, errors };
}
