// Rung L1: the contract lint for a model-written function (core-loop-frontend.md §7; the rules the model was
// given are host/h1/rules.md). What the compiler cannot check, or says badly: that the answer is one whole function
// with the contract's signature, within the Standard setting of the freedom dial (lines, loop bounds, arrays), with
// no bindings, barriers or textures, and no name the compiler will refuse. Each issue names a line and says what to
// do, in words the repair template shows the model as they are. The loop bound is what keeps the probe safe (R4).

import { BUILTIN_FUNCTIONS, RESERVED_WORDS } from './reserved';
import type { FunctionName } from './spec';

/** The Standard setting of the freedom dial (h1/rules.md); the Day-2 gate tunes it. */
export const DIAL = {
    maxLines: 40,
    maxLoopBound: 32,
    maxNestedProduct: 128,
    maxArray: 64,
} as const;

/** The contract's signatures: parameter types and the return type; parameter names are the model's. */
export const SIGNATURES: Record<FunctionName, { text: string; params: string[]; returns: string }> = {
    evolve: { text: 'fn evolve(p: Particle, i: u32) -> Particle', params: ['Particle', 'u32'], returns: 'Particle' },
    look: { text: 'fn look(p: Particle, i: u32) -> Look', params: ['Particle', 'u32'], returns: 'Look' },
    sky: { text: 'fn sky(dir: vec3f) -> vec3f', params: ['vec3f'], returns: 'vec3f' },
};

export interface LintIssue {
    /** 1-based line in the function; 0 when the issue has no single line. */
    line: number;
    message: string;
}

/** Comments blanked (their characters replaced by spaces) so every line keeps its number and its columns. */
export function blankComments(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/.*$/gm, m => ' '.repeat(m.length));
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** The index of the bracket closing the one at `open`, or -1. */
function matching(text: string, open: number): number {
    const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
    const close = pairs[text[open]];
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === text[open]) depth++;
        else if (text[i] === close && --depth === 0) return i;
    }
    return -1;
}

/** A loop's literals stay far from where a 32-bit counter wraps, so counting up by a positive step always ends. */
const LOOP_LITERAL_MAX = 65536;

/**
 * A `for` loop's header and body against the one form rung L1 accepts (F1; the outside review of 10-28, finding 1):
 * `for (var k = <int>; k < or <= <int>; k++, k += <int> or k = k + <int>)`, a step of at least 1, and a body that
 * never writes `k`, takes its address or declares another `k`. Such a loop ends after ceil((bound − start) / step)
 * runs whatever its body does, which is the bound the probe relies on (R4). `count` is that number, or null when the
 * header is not of the form; `bodyAt` and `lineOf` place a match in the body on the function's lines.
 */
function loopRuns(header: string, body: string, bodyAt: number, lineOf: (index: number) => number): { count: number | null; problems: string[] } {
    const example = '`for (var k = 0; k < 8; k++)`';
    const parts = header.split(';').map(p => p.trim());
    if (parts.length !== 3) return { count: null, problems: [`a loop must have the form ${example}; "${header}" is not`] };
    const [init, cond, update] = parts;
    const start = /^var ([A-Za-z_]\w*) ?(?:: ?[iu]32 ?)?= ?(-?\d+)[iu]?$/.exec(init);
    if (!start) return { count: null, problems: [`the loop's counter must start from a whole number, as in ${example}; "${init}" is not`] };
    const k = start[1];
    const bounded = /^([A-Za-z_]\w*) ?(<=?) ?(\d+)[iu]?$/.exec(cond);
    if (!bounded) return { count: null, problems: [`the loop's bound must be a literal number at most ${DIAL.maxLoopBound}, such as \`${k} < 8\`; "${cond}" is not`] };
    if (bounded[1] !== k) return { count: null, problems: [`the loop's condition must test its own counter \`${k}\`, as in \`${k} < 8\`; "${cond}" does not`] };
    const stepped = new RegExp(`^(?:${k} ?\\+\\+|${k} ?\\+= ?(\\d+)[iu]?|${k} ?= ?${k} ?\\+ ?(\\d+)[iu]?)$`).exec(update);
    const step = stepped ? Number(stepped[1] ?? stepped[2] ?? 1) : 0;
    if (step < 1) return { count: null, problems: [`the loop must count up by a whole number: \`${k}++\` or \`${k} += 2\`; "${update || '(nothing)'}" is not`] };

    const problems: string[] = [];
    const from = Number(start[2]);
    const bound = Number(bounded[3]);
    if (Math.abs(from) > LOOP_LITERAL_MAX || bound > LOOP_LITERAL_MAX || step > LOOP_LITERAL_MAX) {
        problems.push(`the loop's numbers must be at most ${LOOP_LITERAL_MAX}`);
    }
    const count = Math.max(0, Math.ceil((bound + (bounded[2] === '<=' ? 1 : 0) - from) / step));
    if (count > DIAL.maxLoopBound) problems.push(`the loop runs ${count} times; at most ${DIAL.maxLoopBound}`);

    // The body: another `k` declared, `k` written (=, a compound assignment, ++ or --), or `&k` (a pointer can write it).
    const line = (index: number) => lineOf(bodyAt + index);
    const declared = [...body.matchAll(new RegExp(`(?<![\\w.])(?:var|let|const)\\s+(${k})\\b`, 'g'))].map(d => d.index + d[0].length - k.length);
    if (declared.length) problems.push(`a variable inside the loop is named \`${k}\`, like its counter (line ${line(declared[0])}); give it another name`);
    const written = [...body.matchAll(new RegExp(`(?<![\\w.])${k}\\s*(?:(?:[-+*/%&|^]|<<|>>)?=(?!=)|\\+\\+|--)`, 'g'))].find(w => !declared.includes(w.index));
    if (written) problems.push(`the loop's counter \`${k}\` is changed inside the loop (line ${line(written.index)}); only its \`for (…)\` line may change it: copy it into another variable to change that`);
    const pointed = [...body.matchAll(new RegExp(`&\\s*${k}(?!\\w)`, 'g'))].find(a =>
        body[a.index - 1] !== '&' && !/[\w)\]]/.test(body.slice(0, a.index).trimEnd().slice(-1)));
    if (pointed) problems.push(`the loop's counter \`${k}\` has its address taken inside the loop (line ${line(pointed.index)}); only its \`for (…)\` line may change it`);
    return { count, problems };
}

/** The contract lint of one function. Empty means the compiler is next. */
export function lintFunction(fn: FunctionName, body: string): LintIssue[] {
    const issues: LintIssue[] = [];
    const code = blankComments(body);
    const signature = SIGNATURES[fn];

    const head = /^[ \t]*fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w<>, ]+?))?\s*\{/m.exec(code);
    if (!head) {
        issues.push({ line: 0, message: `the answer must be one whole function, beginning with \`${signature.text} {\` and ending with its closing brace` });
        return issues;
    }
    const fnLine = lineAt(code, head.index);
    if (head[1] !== fn) {
        issues.push({ line: fnLine, message: `the function is named ${head[1]}; it must be ${fn}: \`${signature.text}\`` });
    }
    const params = head[2].split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[1]?.trim() ?? '');
    const returns = (head[3] ?? '').replace(/\s+/g, '');
    if (params.join(',') !== signature.params.join(',') || returns !== signature.returns) {
        issues.push({ line: fnLine, message: `the signature must be \`${signature.text}\`` });
    }

    // One function and nothing else: the text before its fn line and after its closing brace must be blank.
    const before = code.slice(0, head.index);
    if (before.trim()) {
        issues.push({ line: lineAt(code, before.search(/\S/)), message: 'nothing may come before the function: no structs, constants, bindings or other functions' });
    }
    const openBrace = head.index + head[0].length - 1;
    const closeBrace = matching(code, openBrace);
    if (closeBrace < 0) {
        issues.push({ line: fnLine, message: 'the function\'s braces do not balance: it never closes' });
        return issues;
    }
    const after = code.slice(closeBrace + 1);
    if (after.trim()) {
        issues.push({ line: lineAt(code, closeBrace + 1 + after.search(/\S/)), message: 'nothing may come after the function\'s closing brace' });
    }
    const inner = code.slice(openBrace + 1, closeBrace);
    const innerStart = openBrace + 1;
    const lines = lineAt(code, closeBrace) - fnLine + 1;
    if (lines > DIAL.maxLines) {
        issues.push({ line: 0, message: `the function is ${lines} lines; at most ${DIAL.maxLines}` });
    }

    const at = (index: number) => lineAt(code, innerStart + index);
    const each = (re: RegExp, report: (m: RegExpExecArray) => void) => {
        re.lastIndex = 0;
        for (let m = re.exec(inner); m; m = re.exec(inner)) report(m);
    };

    each(/\b(loop|while)\b/g, m => issues.push({ line: at(m.index), message: `no \`${m[1]}\`: only \`for\` loops with a literal bound, such as \`for (var k = 0; k < 8; k++)\`` }));

    // for loops: one form (F1), at most 32 runs, and nested loops multiplying to at most 128 runs.
    const loops: { start: number; end: number; bound: number; line: number }[] = [];
    each(/\bfor\s*\(/g, m => {
        const open = m.index + m[0].length - 1;
        const close = matching(inner, open);
        const line = at(m.index);
        if (close < 0) return;
        const body = inner.indexOf('{', close);
        const bodyEnd = body < 0 ? -1 : matching(inner, body);
        const header = inner.slice(open + 1, close).replace(/\s+/g, ' ').trim();
        const runs = loopRuns(header, bodyEnd < 0 ? '' : inner.slice(body + 1, bodyEnd), body + 1, (index: number) => at(index));
        for (const message of runs.problems) issues.push({ line, message });
        loops.push({ start: m.index, end: bodyEnd, bound: runs.count ?? DIAL.maxLoopBound, line });
    });
    for (const loop of loops) {
        const ancestors = loops.filter(l => l !== loop && l.start < loop.start && l.end > loop.start);
        const product = ancestors.reduce((n, l) => n * l.bound, loop.bound);
        if (ancestors.length && product > DIAL.maxNestedProduct) {
            issues.push({ line: loop.line, message: `nested loops multiply: ${[...ancestors, loop].map(l => l.bound).join(' × ')} = ${product} steps; at most ${DIAL.maxNestedProduct}` });
        }
    }

    each(/\barray\s*<\s*[\w<>]+\s*(?:,\s*(\d+)\s*)?>/g, m => {
        if (m[1] === undefined) issues.push({ line: at(m.index), message: `an array needs a literal size of at most ${DIAL.maxArray}: \`array<f32, 8>\`` });
        else if (Number(m[1]) > DIAL.maxArray) issues.push({ line: at(m.index), message: `an array of ${m[1]}; at most ${DIAL.maxArray} elements` });
    });

    each(/\b(atomic\w*|workgroupBarrier|storageBarrier|textureBarrier|texture\w*|sampler\w*)\b/g, m =>
        issues.push({ line: at(m.index), message: `\`${m[1]}\` is not allowed in a function: no atomics, barriers, textures or samplers` }));
    each(/@\w+/g, m => issues.push({ line: at(m.index), message: `no attributes (\`${m[0]}\`): the host owns @group, @binding and the entry points` }));
    each(/\bvar\s*<\s*(storage|workgroup|private|uniform)\b/g, m =>
        issues.push({ line: at(m.index), message: `no \`var<${m[1]}>\`: the host owns every binding; use \`var\` or \`let\` inside the function` }));
    each(/\b(struct|enable|requires|override|const_assert)\b/g, m =>
        issues.push({ line: at(m.index), message: `no \`${m[1]}\` inside the function: the host declares the structs and bindings` }));

    // Names the compiler will refuse, and locals that hide a built-in the function then calls.
    const declared = new Map<string, number>();
    each(/\b(?:let|var|const)\s+(\w+)/g, m => {
        const name = m[1];
        if (RESERVED_WORDS.has(name)) issues.push({ line: at(m.index), message: `\`${name}\` is a reserved word in WGSL and cannot name a variable; choose another name` });
        if (BUILTIN_FUNCTIONS.has(name) && !declared.has(name)) declared.set(name, at(m.index));
    });
    for (const [name, line] of declared) {
        if (new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(inner)) {
            issues.push({ line, message: `\`${name}\` names a variable here, so \`${name}(…)\` can no longer be called; rename the variable` });
        }
    }

    // GLSL that survived the auto-fix (three arguments, a call split across lines): say what WGSL wants.
    each(/(?<![\w.])mod\s*\(/g, m => issues.push({ line: at(m.index), message: 'there is no `mod()` in WGSL: write `x - y * floor(x / y)`' }));
    each(/\b(float|int|uint|double)\s*\(|\bvec[234]\s*<\s*(float|int|uint)\s*>/g, m =>
        issues.push({ line: at(m.index), message: `\`${m[0].trim()}\` is GLSL: the WGSL scalars are f32, i32 and u32 (\`f32(x)\`, \`vec3f(…)\`)` }));

    return issues.sort((a, b) => a.line - b.line);
}
