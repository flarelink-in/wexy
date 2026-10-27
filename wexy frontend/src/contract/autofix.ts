// Rung L2: known slips with one meaning, rewritten before the compiler sees them (core-loop-frontend.md §7).
// Every rule works on one line and keeps the line count, because a repair names lines and the server shows the
// model the text as it recorded it (forge-loop design §5.1); test/autofix.test.mjs pins each rule and that
// invariant. A slip with more than one meaning is left for the compiler and the repair turn.

export interface AutoFix {
    /** 1-based line in the function. */
    line: number;
    rule: string;
    before: string;
    after: string;
}

export interface AutoFixRule {
    name: string;
    /** The line rewritten, or unchanged. */
    apply(line: string): string;
}

/** `name(args)` rewritten by `rewrite` wherever the call closes on this line; null leaves a call as it is. */
function replaceCall(line: string, name: string, rewrite: (args: string[]) => string | null): string {
    const open = new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g');
    let out = line;
    for (let guard = 0; guard < 8; guard++) {
        let changed = false;
        open.lastIndex = 0;
        for (let m = open.exec(out); m; m = open.exec(out)) {
            const start = m.index + m[0].length;
            const args: string[] = [];
            let depth = 0;
            let from = start;
            let end = -1;
            for (let i = start; i < out.length; i++) {
                const c = out[i];
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') {
                    if (depth === 0) { end = i; break; }
                    depth--;
                } else if (c === ',' && depth === 0) {
                    args.push(out.slice(from, i).trim());
                    from = i + 1;
                }
            }
            if (end < 0) break;
            args.push(out.slice(from, end).trim());
            const replacement = rewrite(args);
            if (replacement === null) continue;
            out = out.slice(0, m.index) + replacement + out.slice(end + 1);
            changed = true;
            break;
        }
        if (!changed) break;
    }
    return out;
}

/** An argument wrapped in parentheses unless it is a plain name or number, so operator precedence survives. */
const wrap = (s: string) => (/^[\w.]+$/.test(s) ? s : `(${s})`);

export const AUTOFIX_RULES: readonly AutoFixRule[] = [
    { name: 'float() is f32()', apply: l => l.replace(/\bfloat\s*\(/g, 'f32(') },
    { name: 'int() is i32()', apply: l => l.replace(/\bint\s*\(/g, 'i32(') },
    { name: 'uint() is u32()', apply: l => l.replace(/\buint\s*\(/g, 'u32(') },
    { name: 'vecN<float> is vecNf', apply: l => l.replace(/\b(vec[234])\s*<\s*float\s*>/g, '$1f') },
    { name: 'vecN<int> is vecNi', apply: l => l.replace(/\b(vec[234])\s*<\s*int\s*>/g, '$1i') },
    { name: 'vecN<uint> is vecNu', apply: l => l.replace(/\b(vec[234])\s*<\s*uint\s*>/g, '$1u') },
    { name: 'inversesqrt() is inverseSqrt()', apply: l => l.replace(/\binversesqrt\s*\(/g, 'inverseSqrt(') },
    { name: 'atan(y, x) is atan2(y, x)', apply: l => replaceCall(l, 'atan', a => (a.length === 2 ? `atan2(${a[0]}, ${a[1]})` : null)) },
    {
        name: 'mod(x, y) is x - y * floor(x / y)',
        apply: l => replaceCall(l, 'mod', a => (a.length === 2 ? `(${wrap(a[0])} - ${wrap(a[1])} * floor(${wrap(a[0])} / ${wrap(a[1])}))` : null)),
    },
];

/** The body with every rule applied line by line, and what changed. The line count never changes. */
export function autofix(body: string): { body: string; fixes: AutoFix[] } {
    const fixes: AutoFix[] = [];
    const lines = body.split('\n').map((line, i) => {
        // Comments are left alone: a rule must never rewrite what a model wrote about its code.
        const at = line.indexOf('//');
        const code = at < 0 ? line : line.slice(0, at);
        const comment = at < 0 ? '' : line.slice(at);
        let out = code;
        for (const rule of AUTOFIX_RULES) {
            const next = rule.apply(out);
            if (next !== out) {
                fixes.push({ line: i + 1, rule: rule.name, before: out.trim(), after: next.trim() });
                out = next;
            }
        }
        return out + comment;
    });
    return { body: lines.join('\n'), fixes };
}
