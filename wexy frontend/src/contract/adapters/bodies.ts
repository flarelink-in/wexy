// EA4.1 (candidate-loop-design.md §7): a module body the model wrote, checked against the interface it was written for,
// without a device. The host's preamble declares every binding, struct and constant, and its epilogue every entry point
// (Q79, decided): a body holds the interface's entries, its own helper functions and its own constants, nothing else.
//
// L1 lints it: its structure is read from tokens, nested block comments included, never from a regex that assumes one
// function, and a structure it cannot read refuses. L2 rewrites h1's known slips once, over the same tokens, so a
// comment inside a call neither hides the call nor is lost, and the body's own names are left alone. L1 then lints the
// rewritten text, and that verdict decides: the text it judged is the text that is hashed (P9). L3, the compiler, is a
// seam: a scripted fake here, every verdict it yields labelled so, and the device's in EA5, whose messages map back
// through the assembled module's lines. Nothing here compiles, allocates or calls a model.

import { AUTOFIX_RULES, type AutoFix } from '../autofix';
import { deepFreeze, type DeepReadonly } from '../engine/frozen';
import { DIAL, loopRuns } from '../lint';
import { RESERVED_WORDS } from '../reserved';
import { sha256Hex } from './canonical';
import { ENTRY_EXCLUDED, WGSL_FUNCTIONS, WGSL_NAMES, type ModuleInterface } from './interfaces';

/** The checker: a passing verdict is reused only under the same checker (the design §5). */
export const BODY_CHECKER = 'ea4-body.v1';

/** Q79 (decided): h1's dial for loops, nests and arrays, and at most 120 lines a body (up to two entries and helpers). */
export const BODY_DIAL = {
    maxLines: 120,
    maxChars: 12_000,
    maxLoopBound: DIAL.maxLoopBound,
    maxNestedProduct: DIAL.maxNestedProduct,
    maxArray: DIAL.maxArray,
} as const;

type Interface = DeepReadonly<ModuleInterface>;

export interface BodyFinding {
    /** L1, the lint; L3, the compiler. L2, the auto-fix, yields fixes, not findings. */
    rung: 'L1' | 'L3';
    /** 1-based line in the body; null when the finding has no single line of it. */
    line: number | null;
    code: string;
    /** An error keeps the body from passing; a warning is shown and kept. */
    severity: 'error' | 'warning';
    message: string;
}

interface Token {
    kind: 'ident' | 'number' | 'punct';
    text: string;
    /** Its offset in the body. */
    at: number;
    line: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?[iufh]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fh]?|\d+[eE][+-]?\d+[fh]?|\d+[iufh]?/y;
const PUNCT = /->|<<=|>>=|&&|\|\||==|!=|<=|>=|<<|>>|\+\+|--|[-+*/%&|^]=|[{}()[\],;:.=<>+\-*/%&|^~!@]/y;
const CLOSES: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/** Atomics, barriers, textures, samplers and subgroup or quad operations: no module body may use one (the design §7). */
const BANNED: ReadonlySet<string> = new Set([
    ...WGSL_FUNCTIONS.filter(f => /^(atomic|texture|subgroup|quad)/.test(f)),
    'storageBarrier', 'workgroupBarrier', 'workgroupUniformLoad', 'atomic',
    ...WGSL_NAMES.filter(n => /^(texture_|sampler)/.test(n)),
]);
const CALLABLE: ReadonlySet<string> = new Set(WGSL_FUNCTIONS.filter(f => !BANNED.has(f)));
const CONSTRUCTORS: ReadonlySet<string> = new Set(WGSL_NAMES.filter(n => /^(bool|f16|f32|i32|u32|array|vec[234][fhiu]?|mat[234]x[234][fh]?)$/.test(n)));
/** Names a template list may follow (`vec3<f32>(…)`, `bitcast<u32>(…)`); after any other name, `<` compares. */
const TEMPLATED: ReadonlySet<string> = new Set(['array', 'bitcast', 'ptr', 'atomic', ...WGSL_NAMES.filter(n => /^(vec[234]|mat[234]x[234])$/.test(n))]);
/** GLSL's names, which the GLSL rule reports with the WGSL way, rather than as unknown calls. */
const GLSL_NAMES: ReadonlySet<string> = new Set(['mod', 'float', 'int', 'uint', 'double']);
const KNOWN: ReadonlySet<string> = new Set([...RESERVED_WORDS, ...WGSL_NAMES, ...WGSL_FUNCTIONS, ...GLSL_NAMES, 'const_assert', '_']);
/** A host's name: what its preamble declares, and the prefixes its generated names use. */
const HOST_PREFIX = /^(b_|ea_)/i;

/** What a module-scope declaration other than `fn` and `const` would take from the host, and the way out. */
const SCOPE_REFUSED: ReadonlyMap<string, string> = new Map([
    ['var', 'no module-scope `var`: the host\'s preamble owns every binding and module variable; use a local `var` inside a function'],
    ['let', 'no module-scope `let`: write `const` at module scope, `let` inside a function'],
    ['override', 'no `override`: the host\'s constants are in its preamble; write a `const` of your own'],
    ['struct', 'no `struct`: the interface\'s types are in the host\'s preamble; use vectors, or the types it declares'],
    ['alias', 'no `alias`: write the type out'],
    ['enable', 'no `enable` directive: the host owns the module\'s features'],
    ['requires', 'no `requires` directive: the host owns the module\'s features'],
    ['diagnostic', 'no `diagnostic` directive: the host owns the module\'s diagnostics'],
    ['const_assert', 'no `const_assert` in a body'],
]);
/** Declarations that cannot stand inside a function. */
const INNER_REFUSED: ReadonlySet<string> = new Set(['fn', 'struct', 'enable', 'requires', 'override', 'const_assert', 'alias', 'diagnostic']);

interface Param { name: string; type: string; line: number }
interface Header { name: string; params: Param[]; returns: string }
interface Fn { name: string; line: number; header: Header; start: number; open: number; close: number }
/** A module-scope constant: from its `const` (start) to the index after its `;` (end). */
interface Const { name: string; line: number; start: number; end: number }
type Fail = (line: number | null, code: string, message: string, severity?: 'error' | 'warning') => void;

/**
 * Which characters are comments: `//` to the line's end, and block comments, which nest in WGSL. Newlines are never
 * marked, so blanking keeps every line. `unclosed` is the line a block comment opened on and never closed, or null.
 */
function comments(body: string): { mask: Uint8Array; unclosed: number | null } {
    const mask = new Uint8Array(body.length);
    let depth = 0;
    let line = 1;
    let opened = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        const next = body[i + 1];
        if (c === '\n') { line++; continue; }
        if (depth === 0 && c === '/' && next === '/') {
            while (i < body.length && body[i] !== '\n') mask[i++] = 1;
            i--;
            continue;
        }
        if (c === '/' && next === '*') {
            if (depth++ === 0) opened = line;
            mask[i] = mask[i + 1] = 1;
            i++;
            continue;
        }
        if (depth > 0 && c === '*' && next === '/') {
            depth--;
            mask[i] = mask[i + 1] = 1;
            i++;
            continue;
        }
        if (depth > 0) mask[i] = 1;
    }
    return { mask, unclosed: depth > 0 ? opened : null };
}

/** The body with its comments as spaces: every line and column where it was. */
const blank = (body: string, mask: Uint8Array) => body.replace(/[^\n]/g, (c: string, i: number) => (mask[i] ? ' ' : c));

function lineIndex(text: string): (at: number) => number {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return (at: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= at) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
}

function tokenize(text: string, lineOf: (at: number) => number, fail: Fail): Token[] {
    const tokens: Token[] = [];
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) {
            fail(lineOf(i), 'character', `a character code may not hold (U+${code.toString(16).toUpperCase().padStart(4, '0')}): names and code are ASCII; keep other text in comments`);
            i++;
            continue;
        }
        const re = /[A-Za-z_]/.test(c) ? IDENT : /[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? '')) ? NUMBER : PUNCT;
        re.lastIndex = i;
        const m = re.exec(text);
        if (!m) {
            fail(lineOf(i), 'character', `\`${c}\` is not WGSL: a body has no strings, characters or preprocessor lines`);
            i++;
            continue;
        }
        tokens.push({ kind: re === IDENT ? 'ident' : re === NUMBER ? 'number' : 'punct', text: m[0], at: i, line: lineOf(i) });
        i += m[0].length;
    }
    return tokens;
}

/** Whether every bracket closes the one it should; the first that does not is the finding. */
function balanced(tokens: readonly Token[], fail: Fail): boolean {
    const stack: Token[] = [];
    for (const t of tokens) {
        if (t.kind !== 'punct') continue;
        if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(t);
        else if (Object.hasOwn(CLOSES, t.text)) {
            const open = stack.pop();
            if (!open || open.text !== CLOSES[t.text]) {
                fail(t.line, 'balance', open ? `this \`${t.text}\` closes the \`${open.text}\` of line ${open.line}: the brackets do not balance` : `this \`${t.text}\` closes nothing: the brackets do not balance`);
                return false;
            }
        }
    }
    const open = stack.pop();
    if (open) {
        fail(open.line, 'balance', `this \`${open.text}\` never closes: the brackets do not balance`);
        return false;
    }
    return true;
}

/** Each opening bracket's index mapped to its closing one's; the tokens are balanced. */
function pairs(tokens: readonly Token[]): Map<number, number> {
    const match = new Map<number, number>();
    const stack: number[] = [];
    tokens.forEach((t, i) => {
        if (t.kind !== 'punct') return;
        if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(i);
        else if (Object.hasOwn(CLOSES, t.text)) match.set(stack.pop()!, i);
    });
    return match;
}

/** The index after the template list opened at `open` (a `<`), or `open` when none closes there. */
function afterTemplate(tokens: readonly Token[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        const t = tokens[i].text;
        if (t === '<') depth++;
        else if (t === '>') depth--;
        else if (t === '>>') depth -= 2;
        else if (t === ';' || t === '{' || t === '}') return open;
        if (depth <= 0) return i + 1;
    }
    return open;
}

const ALIAS = /^(vec[234]|mat[234]x[234])([fhiu])$/;
const SCALAR: Readonly<Record<string, string>> = { f: 'f32', h: 'f16', i: 'i32', u: 'u32' };

/** A type as one string, its predeclared aliases spelled out (`vec3f` is `vec3<f32>`), so two spellings compare. */
const typeOf = (tokens: readonly Token[]) => tokens.map(t => {
    const m = ALIAS.exec(t.text);
    return m ? `${m[1]}<${SCALAR[m[2]]}>` : t.text;
}).join('');

/** The header of the `fn` at `at`: its name, parameters and return type, and the index of its body's `{`; or what is wrong. */
function header(tokens: readonly Token[], at: number, match: ReadonlyMap<number, number>): { header: Header; open: number } | string {
    const name = tokens[at + 1];
    if (name?.kind !== 'ident') return 'a function needs a name after `fn`';
    if (tokens[at + 2]?.text !== '(') return `\`fn ${name.text}\` needs its parameters in parentheses`;
    const close = match.get(at + 2)!;
    const params: Param[] = [];
    let part: Token[] = [];
    let depth = 0;
    for (let i = at + 3; i <= close; i++) {
        const t = tokens[i];
        if (i === close || (t.text === ',' && depth === 0)) {
            if (part.length) {
                const named = part[0].kind === 'ident' && part[1]?.text === ':';
                params.push({ name: named ? part[0].text : '', type: typeOf(named ? part.slice(2) : part), line: part[0].line });
            }
            part = [];
            continue;
        }
        if (t.text === '<' || t.text === '(' || t.text === '[') depth++;
        else if (t.text === '>' || t.text === ')' || t.text === ']') depth--;
        else if (t.text === '>>') depth -= 2;
        part.push(t);
    }
    let i = close + 1;
    const returns: Token[] = [];
    if (tokens[i]?.text === '->') {
        i++;
        while (i < tokens.length && tokens[i].text !== '{' && tokens[i].text !== ';') returns.push(tokens[i++]);
    }
    if (tokens[i]?.text !== '{') return `\`fn ${name.text}\` needs its body in braces`;
    return { header: { name: name.text, params, returns: typeOf(returns) }, open: i };
}

const SIGNATURES = new Map<string, Header>();

/** An interface entry's signature, read as a header (`fn advance(index: u32)`). */
function signatureOf(signature: string): Header {
    let known = SIGNATURES.get(signature);
    if (!known) {
        const text = `${signature} {}`;
        const tokens = tokenize(text, () => 1, () => {});
        const read = header(tokens, 0, pairs(tokens));
        if (typeof read === 'string') throw new Error(`bodies: the interface's signature "${signature}" does not read: ${read}`);
        known = read.header;
        SIGNATURES.set(signature, known);
    }
    return known;
}

/** The index after the declaration at `at`: its `;`, or its braces and an optional `;`. */
function skip(tokens: readonly Token[], at: number, match: ReadonlyMap<number, number>): number {
    for (let i = at; i < tokens.length; i++) {
        const t = tokens[i].text;
        if (t === ';') return i + 1;
        if (t === '{') {
            const close = match.get(i)!;
            return tokens[close + 1]?.text === ';' ? close + 2 : close + 1;
        }
        if (t === '(' || t === '[') i = match.get(i)!;
    }
    return tokens.length;
}

/** The body's module scope: its functions and constants; anything else is a finding. */
function declarations(tokens: readonly Token[], match: ReadonlyMap<number, number>, fail: Fail): { fns: Fn[]; consts: Const[] } {
    const fns: Fn[] = [];
    const consts: Const[] = [];
    for (let i = 0; i < tokens.length;) {
        const t = tokens[i];
        if (t.text === '@') {
            // The attribute itself is reported once, with every other (lintBody); here it is only passed over.
            i++;
            if (tokens[i]?.kind === 'ident') i++;
            if (tokens[i]?.text === '(') i = match.get(i)! + 1;
            continue;
        }
        if (t.kind === 'ident' && t.text === 'fn') {
            const read = header(tokens, i, match);
            if (typeof read === 'string') {
                fail(t.line, 'scope', read);
                i = skip(tokens, i, match);
                continue;
            }
            const close = match.get(read.open)!;
            fns.push({ name: read.header.name, line: tokens[i + 1].line, header: read.header, start: i, open: read.open, close });
            i = close + 1;
            continue;
        }
        if (t.kind === 'ident' && t.text === 'const') {
            const name = tokens[i + 1];
            const end = skip(tokens, i, match);
            if (name?.kind === 'ident') consts.push({ name: name.text, line: name.line, start: i, end });
            else fail(t.line, 'scope', 'a `const` needs a name');
            i = end;
            continue;
        }
        if (t.text === ';') { i++; continue; }
        const refused = t.kind === 'ident' ? SCOPE_REFUSED.get(t.text) : undefined;
        fail(t.line, 'scope', refused ?? `\`${t.text}\` cannot stand at the body's top level: only functions and \`const\` declarations can`);
        i = skip(tokens, i, match);
    }
    return { fns, consts };
}

/** The names the interface's preamble declares, and the engine's: none of them may be declared again. */
function hostNames(iface: Interface): { names: Set<string>; structs: Set<string> } {
    const names = new Set<string>(['camera', 'ecs', 'main', 'cs_main', 'vs_main', 'fs_main']);
    for (const b of iface.bindings) names.add(b.name);
    for (const c of iface.constants) names.add(c.name);
    const structs = new Set<string>();
    // The preamble may hold a comment (a lit batch's note on LightSystem's layout): read it with its comments blanked.
    const preamble = blank(iface.preamble, comments(iface.preamble).mask);
    for (const m of preamble.matchAll(/\b(struct|const|fn|alias|override|var(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)/g)) {
        names.add(m[2]);
        if (m[1] === 'struct') structs.add(m[2]);
    }
    return { names, structs };
}

/**
 * L1: the lint of a body against its interface. Every entry defined once with its signature; only functions and
 * constants at module scope, none named by the host or WGSL; F1's loops and the dial; no atomics, barriers, textures,
 * samplers, subgroup or quad operations; no recursion; every call a function of the body, a WGSL built-in or a type.
 * A value name nothing declares is a warning: the compiler decides it (EA5), and a lint stricter than the compiler would
 * spend repairs on nothing. A structure it cannot read refuses, and nothing past it is judged.
 */
export function lintBody(iface: Interface, answer: string): BodyFinding[] {
    const body = answer.replace(/\r\n?/g, '\n');
    const out: BodyFinding[] = [];
    const fail: Fail = (line, code, message, severity = 'error') => { out.push({ rung: 'L1', line, code, severity, message }); };
    const done = () => finish(out);

    const lines = body.replace(/\n+$/, '').split('\n').length;
    if (body.length > BODY_DIAL.maxChars) fail(null, 'size', `the body is ${body.length} characters; at most ${BODY_DIAL.maxChars}`);
    if (body.length > BODY_DIAL.maxChars * 4) return done();
    if (lines > BODY_DIAL.maxLines) fail(null, 'lines', `the body is ${lines} lines; at most ${BODY_DIAL.maxLines}`);

    const { mask, unclosed } = comments(body);
    if (unclosed !== null) {
        fail(unclosed, 'comment', 'a block comment opened here never closes: close it with `*/`');
        return done();
    }
    const text = blank(body, mask);
    const lineOf = lineIndex(text);
    const tokens = tokenize(text, lineOf, fail);
    if (!balanced(tokens, fail)) return done();
    const match = pairs(tokens);

    for (const [i, t] of tokens.entries()) {
        if (t.text !== '@') continue;
        const name = tokens[i + 1]?.kind === 'ident' ? tokens[i + 1].text : '';
        fail(t.line, 'attribute', `no attributes (\`@${name}\`): the host's preamble and epilogue own @group, @binding and the entry points`);
    }
    for (const [i, t] of tokens.entries()) {
        if (t.kind === 'ident' && BANNED.has(t.text) && tokens[i - 1]?.text !== '.') {
            fail(t.line, 'capability', `\`${t.text}\` is not allowed in a module body: no atomics, barriers, textures, samplers, subgroup or quad operations`);
        }
    }

    const { fns, consts } = declarations(tokens, match, fail);
    const host = hostNames(iface);
    const entries = new Set(iface.entries.map(e => e.entry));
    const fnNames = new Set(fns.map(f => f.name));
    const moduleNames = new Set([...fnNames, ...consts.map(c => c.name)]);

    // The entries: each defined once, with the interface's parameter types and return type (the names are the body's).
    for (const e of iface.entries) {
        const defs = fns.filter(f => f.name === e.entry);
        if (!defs.length) {
            fail(null, 'entry-missing', `the entry \`${e.entry}\` is missing: define \`${e.signature} { … }\``);
            continue;
        }
        if (defs.length > 1) fail(defs[1].line, 'entry-twice', `the entry \`${e.entry}\` is defined twice; define it once`);
        const want = signatureOf(e.signature);
        const got = defs[0].header;
        const params = got.params.length === want.params.length && got.params.every((p, i) => p.type === want.params[i].type);
        if (!params || got.returns !== want.returns) {
            fail(defs[0].line, 'signature', `the entry must be \`${e.signature}\`: its parameters' names are yours, their types and the return type are the interface's`);
        }
    }

    // Module-scope names: once each; never the host's, WGSL's, or a name the host's code depends on.
    const seen = new Map<string, number>();
    const declared = [...fns.map(f => ({ name: f.name, line: f.line, kind: 'function' })), ...consts.map(c => ({ ...c, kind: 'constant' }))]
        .sort((a, b) => a.line - b.line);
    for (const d of declared) {
        const first = seen.get(d.name);
        if (first !== undefined) {
            if (!(entries.has(d.name) && d.kind === 'function')) fail(d.line, 'name', `\`${d.name}\` is declared twice (first on line ${first}); one name, one declaration`);
            continue;
        }
        seen.set(d.name, d.line);
        if (entries.has(d.name)) {
            if (d.kind === 'constant') fail(d.line, 'name', `\`${d.name}\` is an entry of the interface: it must be a function, not a constant`);
            continue;
        }
        if (d.name.startsWith('__')) fail(d.line, 'name', `\`${d.name}\`: names beginning \`__\` are WGSL's; choose another`);
        else if (host.names.has(d.name) || HOST_PREFIX.test(d.name)) {
            fail(d.line, 'name', `\`${d.name}\` is the host's: the names its preamble declares, and names beginning \`b_\` or \`ea_\`, are its own; choose another`);
        } else if (ENTRY_EXCLUDED.has(d.name)) {
            fail(d.line, 'name', `\`${d.name}\` is a WGSL word, built-in or type, or a name the host's code uses: a ${d.kind} by that name would hide it; choose another`);
        }
    }

    // Each function: its loops and its locals.
    const edges = new Map<string, Set<string>>(fns.map(f => [f.name, new Set<string>()]));
    const own = new Set<string>(moduleNames);
    const scopes = new Map<Fn, { names: { name: string; line: number }[]; inScope: Set<string>; calls: Set<string> }>();
    for (const fn of fns) {
        const locals: { name: string; line: number }[] = [];
        const loops: { start: number; end: number; bound: number; line: number }[] = [];
        for (let k = fn.open + 1; k < fn.close; k++) {
            const t = tokens[k];
            if (t.kind !== 'ident' || tokens[k - 1]?.text === '.') continue;
            if (INNER_REFUSED.has(t.text)) {
                fail(t.line, 'declaration', `no \`${t.text}\` inside a function: a body declares functions and constants at module scope, and the host the rest`);
            } else if (t.text === 'loop' || t.text === 'while') {
                fail(t.line, 'loop', `no \`${t.text}\`: only \`for\` loops with a literal bound, such as \`for (var k = 0; k < 8; k++)\``);
            } else if (t.text === 'let' || t.text === 'var' || t.text === 'const') {
                let n = k + 1;
                if (t.text === 'var' && tokens[n]?.text === '<') {
                    const after = afterTemplate(tokens, n);
                    const space = tokens.slice(n + 1, Math.max(n + 1, after - 1)).map(x => x.text).join('');
                    if (space !== 'function') fail(t.line, 'address-space', `no \`var<${space}>\`: the host owns every binding; use \`var\` or \`let\` inside the function`);
                    n = after;
                }
                if (tokens[n]?.kind === 'ident') locals.push({ name: tokens[n].text, line: tokens[n].line });
            } else if (t.text === 'for' && tokens[k + 1]?.text === '(') {
                // F1's form and the dial (h1's loopRuns), on the comment-blanked text.
                const close = match.get(k + 1)!;
                const open = close + 1;
                if (tokens[open]?.text !== '{') {
                    fail(t.line, 'loop-form', 'a `for` loop needs its body in braces');
                    continue;
                }
                const end = match.get(open)!;
                const head = text.slice(tokens[k + 1].at + 1, tokens[close].at).replace(/\s+/g, ' ').trim();
                const bodyAt = tokens[open].at + 1;
                const runs = loopRuns(head, text.slice(bodyAt, tokens[end].at), bodyAt, lineOf);
                for (const problem of runs.problems) fail(t.line, 'loop-form', problem);
                loops.push({ start: t.at, end: tokens[end].at, bound: runs.count ?? BODY_DIAL.maxLoopBound, line: t.line });
            }
        }
        for (const loop of loops) {
            const ancestors = loops.filter(l => l !== loop && l.start < loop.start && l.end > loop.start);
            const product = ancestors.reduce((n, l) => n * l.bound, loop.bound);
            if (ancestors.length && product > BODY_DIAL.maxNestedProduct) {
                fail(loop.line, 'loop-form', `nested loops multiply: ${[...ancestors, loop].map(l => l.bound).join(' × ')} = ${product} steps; at most ${BODY_DIAL.maxNestedProduct}`);
            }
        }

        const names = [...fn.header.params.filter(p => p.name).map(p => ({ name: p.name, line: p.line })), ...locals];
        for (const n of names) own.add(n.name);
        scopes.set(fn, { names, inScope: new Set(names.map(n => n.name)), calls: new Set() });
    }

    // The names every declaration uses, functions and module-scope constants alike, in the body's order: each call
    // resolves, and a value nothing declares is said once, where it is first used. A constant's value is the compiler's
    // to work out, so whether it is a constant expression is EA5's to say; its calls still resolve here (the review of
    // 10-31: a constant's value was not read at all).
    const reportedCall = new Set<string>();
    const reportedName = new Set<string>();
    const unknownCall = (t: Token, inScope: ReadonlySet<string>) => {
        if (CALLABLE.has(t.text) || CONSTRUCTORS.has(t.text) || host.structs.has(t.text) || BANNED.has(t.text) || GLSL_NAMES.has(t.text)
            || inScope.has(t.text) || reportedCall.has(t.text)) return;
        reportedCall.add(t.text);
        fail(t.line, 'call', `calls \`${t.text}\`, which is neither a function of this body, a WGSL built-in nor a type: define it here, or use a built-in`);
    };
    /** The identifiers from `from` to `to` (exclusive): each call handed to `called`, each value checked against what is declared. */
    const uses = (from: number, to: number, inScope: ReadonlySet<string>, called: (t: Token) => void) => {
        for (let k = from; k < to; k++) {
            const t = tokens[k];
            if (t.kind !== 'ident') continue;
            const prev = tokens[k - 1]?.text;
            if (prev === '.' || prev === '@' || RESERVED_WORDS.has(t.text)) continue;
            let next = k + 1;
            if (TEMPLATED.has(t.text) && tokens[next]?.text === '<') next = afterTemplate(tokens, next);
            if (tokens[next]?.text === '(') {
                called(t);
            } else if (!KNOWN.has(t.text) && !host.names.has(t.text) && !moduleNames.has(t.text) && !inScope.has(t.text) && !reportedName.has(t.text)) {
                reportedName.add(t.text);
                fail(t.line, 'unresolved', `uses \`${t.text}\`, which nothing declares here: the compiler will decide (EA5); declare it, or use a name the interface gives`, 'warning');
            }
        }
    };
    const NOTHING: ReadonlySet<string> = new Set();
    const inOrder = [...fns.map(fn => ({ start: fn.start, fn })), ...consts.map(c => ({ start: c.start, c }))].sort((a, b) => a.start - b.start);
    for (const d of inOrder) {
        if ('fn' in d) {
            const { fn } = d;
            const scope = scopes.get(fn)!;
            // From after the function's name: `fn` is a keyword, and the name is the declaration itself.
            uses(fn.start + 2, fn.close + 1, scope.inScope, t => {
                scope.calls.add(t.text);
                if (fnNames.has(t.text)) edges.get(fn.name)!.add(t.text);
                else unknownCall(t, scope.inScope);
            });
        } else {
            uses(d.c.start + 2, d.c.end, NOTHING, t => { if (!fnNames.has(t.text)) unknownCall(t, NOTHING); });
        }
    }

    for (const fn of fns) {
        const { names, calls } = scopes.get(fn)!;
        // A local or parameter: not a reserved word, not the host's, and not a built-in this function then calls.
        for (const n of names) {
            if (RESERVED_WORDS.has(n.name)) fail(n.line, 'name', `\`${n.name}\` is a reserved word in WGSL and cannot name a variable; choose another name`);
            else if (n.name.startsWith('__')) fail(n.line, 'name', `\`${n.name}\`: names beginning \`__\` are WGSL's; choose another`);
            else if (host.names.has(n.name)) fail(n.line, 'name', `\`${n.name}\` is the host's (its preamble declares it): a variable by that name would hide it; choose another`);
            else if (CALLABLE.has(n.name) && calls.has(n.name)) fail(n.line, 'name', `\`${n.name}\` names a variable here, so \`${n.name}(…)\` can no longer be called; rename the variable`);
        }
    }

    // No recursion: WGSL refuses it, and no loop bound could bound it.
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const rings = new Set<string>();
    const visit = (name: string) => {
        state.set(name, 1);
        stack.push(name);
        for (const callee of edges.get(name) ?? []) {
            if (state.get(callee) === 1) {
                const ring = stack.slice(stack.indexOf(callee));
                const key = [...ring].sort().join();
                if (!rings.has(key)) {
                    rings.add(key);
                    const line = fns.find(f => f.name === callee)!.line;
                    fail(line, 'recursion', ring.length === 1
                        ? `\`${callee}\` calls itself: WGSL has no recursion; write it as a bounded loop`
                        : `${[...ring, callee].map(n => `\`${n}\``).join(' calls ')}: WGSL has no recursion; break the cycle`);
                }
            } else if (!state.has(callee)) {
                visit(callee);
            }
        }
        stack.pop();
        state.set(name, 2);
    };
    for (const f of fns) if (!state.has(f.name)) visit(f.name);

    // The dial's arrays, and GLSL that survived the auto-fix: said in WGSL's words, unless the body named it itself.
    arrays(tokens, match, fail);
    for (const m of text.matchAll(/(?<![\w.])mod\s*\(/g)) {
        if (!own.has('mod')) fail(lineOf(m.index!), 'glsl', 'there is no `mod()` in WGSL: write `x - y * floor(x / y)`');
    }
    for (const m of text.matchAll(/(?<![\w.])(float|int|uint|double)\s*\(|\bvec[234]\s*<\s*(float|int|uint)\s*>/g)) {
        // A comment inside it is blank here: say the code alone, its spaces closed up.
        if (!own.has(m[1] ?? m[2])) fail(lineOf(m.index!), 'glsl', `\`${m[0].replace(/\s+/g, ' ').trim()}\` is GLSL: the WGSL scalars are f32, i32 and u32 (\`f32(x)\`, \`vec3f(…)\`)`);
    }
    return done();
}

/**
 * The arguments between `from` and `to` (exclusive), split at their own commas, as index ranges. Brackets and template
 * lists are passed over whole, so a comma inside one is its own; a trailing comma, which WGSL allows, ends no argument.
 */
function argumentsOf(tokens: readonly Token[], from: number, to: number, match: ReadonlyMap<number, number>): [number, number][] {
    const out: [number, number][] = [];
    let start = from;
    for (let i = from; i < to; i++) {
        const t = tokens[i];
        if (t.text === '(' || t.text === '[') {
            i = match.get(i)!;
        } else if (t.kind === 'ident' && TEMPLATED.has(t.text) && tokens[i + 1]?.text === '<') {
            const after = afterTemplate(tokens, i + 1);
            if (after > i + 1) i = after - 1;
        } else if (t.text === ',') {
            out.push([start, i]);
            start = i + 1;
        }
    }
    if (start < to) out.push([start, to]);
    return out;
}

/** The value of a literal whole number as WGSL writes one, decimal or hexadecimal, `i` or `u` or neither; else null. */
function wholeNumber(tokens: readonly Token[], [from, to]: [number, number]): number | null {
    if (to - from !== 1 || tokens[from].kind !== 'number') return null;
    const m = /^(?:0[xX]([0-9a-fA-F]+)|(\d+))[iu]?$/.exec(tokens[from].text);
    return m ? (m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2])) : null;
}

/**
 * The dial's arrays (Q79, h1's 64), read from tokens (the review of 10-31: a regex read one decimal size and missed a
 * hexadecimal one, an expression and an outer array): `array<T, N>` with N a literal whole number; `array(…)` holding
 * the values it lists; and an array of arrays holding their product, as nested loops multiply. A size the lint cannot
 * read, a name or an expression, refuses: the dial bounds what one invocation holds, and only a literal shows it. Each
 * array is judged at its own line; an outer array is not judged again on an inner one's account. A value an inferred
 * `array(…)` lists by name counts as one: the lint reads tokens, not types.
 */
function arrays(tokens: readonly Token[], match: ReadonlyMap<number, number>, fail: Fail): void {
    const max = BODY_DIAL.maxArray;
    const example = '`array<f32, 8>`';
    const sizes = new Map<number, number | null>();
    const isArray = (i: number | undefined) => i !== undefined && tokens[i]?.kind === 'ident' && tokens[i].text === 'array' && tokens[i - 1]?.text !== '.';
    /** How many values the array at `at` holds, or null once it is refused (or has no size to judge). */
    const sizeAt = (at: number): number | null => {
        if (sizes.has(at)) return sizes.get(at)!;
        sizes.set(at, null);
        const line = tokens[at].line;
        let count: number | null;
        let element: number | undefined;
        let listed = false;
        if (tokens[at + 1]?.text === '<') {
            const after = afterTemplate(tokens, at + 1);
            if (after === at + 1) {
                fail(line, 'array', `this array's \`<\` never closes: an array takes its type and a literal size, as ${example}`);
                return null;
            }
            const args = argumentsOf(tokens, at + 2, after - 1, match);
            if (args.length !== 2) {
                fail(line, 'array', args.length === 1 ? `an array needs a literal size of at most ${max}: ${example}` : `an array takes its type and a literal size, as ${example}`);
                return null;
            }
            count = wholeNumber(tokens, args[1]);
            if (count === null) {
                const said = tokens.slice(args[1][0], args[1][1]).map(t => t.text).join(' ');
                fail(line, 'array', `an array's size must be a literal whole number of at most ${max}, as ${example}; \`${said}\` is not`);
                return null;
            }
            element = args[0][0];
        } else if (tokens[at + 1]?.text === '(') {
            const args = argumentsOf(tokens, at + 2, match.get(at + 1)!, match);
            count = args.length;
            element = args[0]?.[0];
            listed = true;
        } else {
            return null;
        }
        if (count < 1) {
            fail(line, 'array', `an array holds at least one value: ${example}`);
            return null;
        }
        if (count > max) {
            fail(line, 'array', listed ? `\`array(…)\` holds ${count} values; at most ${max}` : `an array of ${count}; at most ${max} elements`);
            return null;
        }
        const each = isArray(element) ? sizeAt(element!) : 1;
        if (each === null) return null;
        if (count * each > max) {
            fail(line, 'array', `${count} arrays of ${each} values: ${count * each} in all; at most ${max}`);
            return null;
        }
        sizes.set(at, count * each);
        return count * each;
    };
    tokens.forEach((_, i) => { if (isArray(i)) sizeAt(i); });
}

/** Each finding once, in line order, errors before warnings on a line. */
function finish(found: readonly BodyFinding[]): BodyFinding[] {
    const seen = new Set<string>();
    return found
        .filter(f => {
            const key = `${f.code}|${f.line}|${f.message}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** What L2 reads: the body, which of its characters are comments, its tokens and their brackets' pairs. */
interface Scan { body: string; mask: Uint8Array; tokens: Token[]; match: Map<number, number> }
/** One rewrite: [from, to) of the body becomes `text`. Never across a line's end, so the line count never changes. */
interface Edit { from: number; to: number; text: string; line: number }
/** Says why one place was left as it was. */
type Note = (line: number, because: string) => void;

/** The body read for L2, or why it cannot be: a comment that never closes, brackets that do not balance. */
function scanOf(body: string): Scan | string {
    const { mask, unclosed } = comments(body);
    if (unclosed !== null) return 'a block comment never closes, so code and comment cannot be told apart';
    const text = blank(body, mask);
    const tokens = tokenize(text, lineIndex(text), () => {});
    if (!balanced(tokens, () => {})) return 'its brackets do not balance, so where a call ends cannot be read';
    return { body, mask, tokens, match: pairs(tokens) };
}

const holdsComment = (s: Scan, from: number, to: number) => s.mask.subarray(from, to).includes(1);

/** The comments between `from` and `to`, each as written. */
function commentsIn(s: Scan, from: number, to: number): string[] {
    const out: string[] = [];
    for (let p = from; p < to; p++) {
        if (!s.mask[p]) continue;
        let q = p;
        while (q < to && s.mask[q]) q++;
        out.push(s.body.slice(p, q));
        p = q;
    }
    return out;
}

/** Each call of `name`: the identifier, not a member, whose next token is its `(`; a comment or a line end may lie between. */
const callsTo = (s: Scan, name: string) => s.tokens.flatMap((t, i) =>
    (t.kind === 'ident' && t.text === name && s.tokens[i - 1]?.text !== '.' && s.tokens[i + 1]?.text === '(' ? [i] : []));

/** The called name alone renamed: whatever lies between it and its `(`, a comment or a line end, stays where it was. */
const renamed = (s: Scan, name: string, to: string, arity?: number): Edit[] => callsTo(s, name)
    .filter(i => arity === undefined || argumentsOf(s.tokens, i + 2, s.match.get(i + 1)!, s.match).length === arity)
    .map(i => ({ from: s.tokens[i].at, to: s.tokens[i].at + name.length, text: to, line: s.tokens[i].line }));

/** `vecN<float>` as h1 writes it, `vecNf`; with a comment or a line end inside, only the scalar is renamed (`vecN<f32>`). */
function vectors(s: Scan, scalar: string, to: string, suffix: string): Edit[] {
    const edits: Edit[] = [];
    s.tokens.forEach((t, i) => {
        const [open, inner, close] = [s.tokens[i + 1], s.tokens[i + 2], s.tokens[i + 3]];
        if (t.kind !== 'ident' || !/^vec[234]$/.test(t.text) || s.tokens[i - 1]?.text === '.' || open?.text !== '<' || inner?.text !== scalar
            || (close?.text !== '>' && close?.text !== '>>')) return;
        // `>>` closes an outer list too: only its first `>` is this vector's.
        const end = close.at + 1;
        if (holdsComment(s, t.at, end) || s.body.slice(t.at, end).includes('\n')) edits.push({ from: inner.at, to: inner.at + scalar.length, text: to, line: inner.line });
        else edits.push({ from: t.at, to: end, text: `${t.text}${suffix}`, line: t.line });
    });
    return edits;
}

/** h1's `wrap`: an argument in parentheses unless it is a plain name or number, so the rewrite keeps its precedence. */
const wrap = (text: string) => (/^[\w.]+$/.test(text) ? text : `(${text})`);

/**
 * `mod(x, y)` as `(x - y * floor(x / y))`, h1's rewrite, for a call of two arguments on one line. The rewrite writes x
 * and y twice, so a comment inside the call is kept once, after the rewritten expression. A call across lines is left
 * as written, and said so: its rewrite could not keep the line count.
 */
function modulo(s: Scan, note: Note): Edit[] {
    return callsTo(s, 'mod').flatMap(i => {
        const name = s.tokens[i];
        const closeAt = s.match.get(i + 1)!;
        const close = s.tokens[closeAt];
        if (close.line !== name.line) {
            note(name.line, 'the call spans lines, so it is left as written for the lint and the repair');
            return [];
        }
        const args = argumentsOf(s.tokens, i + 2, closeAt, s.match);
        if (args.length !== 2 || args.some(([a, b]) => a === b)) return [];
        const [x, y] = args.map(([a, b]) => {
            const from = s.tokens[a].at;
            const to = s.tokens[b - 1].at + s.tokens[b - 1].text.length;
            const text = s.body.slice(from, to);
            return wrap(holdsComment(s, from, to) ? blank(text, s.mask.subarray(from, to)).replace(/\s+/g, ' ').trim() : text);
        });
        const kept = commentsIn(s, name.at, close.at + 1);
        return [{ from: name.at, to: close.at + 1, text: `(${x} - ${y} * floor(${x} / ${y}))${kept.length ? ` ${kept.join(' ')}` : ''}`, line: name.line }];
    });
}

/**
 * h1's rules (`AUTOFIX_RULES`, by name), each over the body's tokens, with the name it rewrites. A body that declares
 * that name keeps its own calls: rewriting `float(x)` to `f32(x)` would bypass a helper the body named `float` (the
 * design §7). A rule h1 adds with no entry here is not applied to a module body at all, and said so.
 */
const REWRITES: Readonly<Record<string, { source: string; edits: (s: Scan, note: Note) => Edit[] }>> = {
    'float() is f32()': { source: 'float', edits: s => renamed(s, 'float', 'f32') },
    'int() is i32()': { source: 'int', edits: s => renamed(s, 'int', 'i32') },
    'uint() is u32()': { source: 'uint', edits: s => renamed(s, 'uint', 'u32') },
    'vecN<float> is vecNf': { source: 'float', edits: s => vectors(s, 'float', 'f32', 'f') },
    'vecN<int> is vecNi': { source: 'int', edits: s => vectors(s, 'int', 'i32', 'i') },
    'vecN<uint> is vecNu': { source: 'uint', edits: s => vectors(s, 'uint', 'u32', 'u') },
    'inversesqrt() is inverseSqrt()': { source: 'inversesqrt', edits: s => renamed(s, 'inversesqrt', 'inverseSqrt') },
    'atan(y, x) is atan2(y, x)': { source: 'atan', edits: s => renamed(s, 'atan', 'atan2', 2) },
    'mod(x, y) is x - y * floor(x / y)': { source: 'mod', edits: modulo },
};

/** Each of h1's rules with a module-aware form, by the name it rewrites. */
export const AUTOFIX_SOURCE_NAMES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(REWRITES).map(([rule, r]) => [rule, r.source])));

/**
 * A rule rewrites nested calls outside in, a pass at a time, as h1's does (8 a line); this bounds the passes, and the
 * body's own size bounds the text, since a nested `mod` rewrite writes its arguments twice.
 */
const MAX_PASSES = 8;

export interface FixedBody {
    body: string;
    fixes: AutoFix[];
    /** The rules left out for this body, and the places a rule left as they were, each with why. */
    skipped: { rule: string; because: string }[];
}

/** The names a body declares: its functions, constants, locals and parameters. Over-reading only skips a fix. */
function declaredNames(text: string): Set<string> {
    const names = new Set<string>();
    for (const m of text.matchAll(/\b(?:fn|let|var|const)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/[(,]\s*([A-Za-z_]\w*)\s*:/g)) names.add(m[1]);
    return names;
}

/** The edits that do not overlap, leftmost first: an outer call before the calls inside it, which a later pass reaches. */
function disjoint(edits: readonly Edit[]): Edit[] {
    const out: Edit[] = [];
    let end = -1;
    for (const e of [...edits].sort((a, b) => a.from - b.from)) {
        if (e.from >= end) {
            out.push(e);
            end = e.to;
        }
    }
    return out;
}

/**
 * L2: h1's rules, once each, over a module body's tokens (the review of 10-31: rules run on the code between comments
 * missed a call a comment sat inside). Comments are never rewritten, block comments included: a rename touches only
 * the name, and a `mod` rewrite keeps each comment it held, after the rewritten expression. A rule whose name the body
 * declares itself is skipped; the line count never changes. A body whose comments or brackets cannot be read is
 * returned as it is, and its lint refuses it.
 */
export function fixBody(answer: string): FixedBody {
    const body = answer.replace(/\r\n?/g, '\n');
    const first = scanOf(body);
    if (typeof first === 'string') return { body, fixes: [], skipped: AUTOFIX_RULES.map(r => ({ rule: r.name, because: first })) };
    let scan: Scan = first;
    const own = declaredNames(blank(body, scan.mask));
    const fixes: AutoFix[] = [];
    const skipped: FixedBody['skipped'] = [];
    for (const rule of AUTOFIX_RULES) {
        const rewrite = Object.hasOwn(REWRITES, rule.name) ? REWRITES[rule.name] : undefined;
        if (rewrite === undefined) {
            skipped.push({ rule: rule.name, because: 'it has no module-aware form, so it is not applied to a module body' });
            continue;
        }
        if (own.has(rewrite.source)) {
            skipped.push({ rule: rule.name, because: `the body declares \`${rewrite.source}\` itself, so its calls are its own` });
            continue;
        }
        const said = new Set<string>();
        const note: Note = (line, because) => {
            const text = `line ${line}: ${because}`;
            if (!said.has(text)) {
                said.add(text);
                skipped.push({ rule: rule.name, because: text });
            }
        };
        const byLine = new Map<number, AutoFix>();
        for (let pass = 0; ; pass++) {
            const edits = disjoint(rewrite.edits(scan, note));
            if (!edits.length) break;
            if (pass === MAX_PASSES) {
                note(edits[0].line, `stopped after ${MAX_PASSES} passes of nested calls; the rest is left for the lint and the repair`);
                break;
            }
            let next = scan.body;
            for (const e of [...edits].sort((a, b) => b.from - a.from)) next = next.slice(0, e.from) + e.text + next.slice(e.to);
            // A rewrite never grows a body past its limit: the repair would be told of a size the model never wrote.
            const read = next.length > Math.max(BODY_DIAL.maxChars, scan.body.length)
                ? `the rewrite would make the body longer than its ${BODY_DIAL.maxChars} characters` : scanOf(next);
            if (typeof read === 'string') {
                note(edits[0].line, `${read}; the rest is left for the lint and the repair`);
                break;
            }
            const before = scan.body.split('\n');
            const after = next.split('\n');
            for (const line of new Set(edits.map(e => e.line))) {
                const known = byLine.get(line);
                if (known) known.after = after[line - 1].trim();
                else byLine.set(line, { line, rule: rule.name, before: before[line - 1].trim(), after: after[line - 1].trim() });
            }
            scan = read;
        }
        fixes.push(...byLine.values());
    }
    // In line order, as h1's auto-fix gives them; on one line, in the rules' order.
    return { body: scan.body, fixes: fixes.sort((a, b) => a.line - b.line), skipped };
}

export interface CheckedBody {
    /** The final lint found no error: the verdict EA4 keeps (static only; a compiler judges in L3). */
    ok: boolean;
    module: string;
    interfaceHash: string;
    checker: string;
    /** The model's answer as it came: kept for the evidence, never compiled. */
    original: string;
    /** The text judged and hashed: line ends LF, after the auto-fix. Nothing rewrites it after this. */
    body: string;
    /** SHA-256 of `body`, over UTF-8. */
    codeHash: string;
    /** The first lint's findings: diagnostics; an auto-fixable error here costs no repair. */
    initial: BodyFinding[];
    fixes: AutoFix[];
    skipped: FixedBody['skipped'];
    /** The final lint's findings, over `body`: these decide. */
    findings: BodyFinding[];
}

/** L1, L2 once, L1 again: the body's static verdict against its interface, and the hash of the text that was judged. */
export async function checkBody(iface: Interface, answer: string): Promise<DeepReadonly<CheckedBody>> {
    // Both rungs end lines with LF themselves; with no fix, the final text is the one the first lint read.
    const initial = lintBody(iface, answer);
    const fixed = fixBody(answer);
    const findings = fixed.fixes.length ? lintBody(iface, fixed.body) : initial;
    return deepFreeze({
        ok: !findings.some(f => f.severity === 'error'),
        module: iface.module,
        interfaceHash: iface.interfaceHash,
        checker: BODY_CHECKER,
        original: answer,
        body: fixed.body,
        codeHash: await sha256Hex(fixed.body),
        initial,
        fixes: fixed.fixes,
        skipped: fixed.skipped,
        findings,
    });
}

export interface AssembledModule {
    /** The preamble, the body and the epilogue, one module. */
    source: string;
    /** The module's line where the body's first line is. */
    bodyFirstLine: number;
    bodyLines: number;
}

/** The module a compiler sees: the host's preamble, the body, the host's epilogue; and where the body sits in it. */
export function assembleModule(iface: Interface, body: string): AssembledModule {
    return {
        source: `${iface.preamble}\n${body}\n${iface.epilogue}`,
        bodyFirstLine: iface.preamble.split('\n').length + 1,
        bodyLines: body.split('\n').length,
    };
}

/** A compiler's message, as WebGPU's compilation info gives one: a line of the module (0 when it has none). */
export interface CompileMessage {
    line: number;
    message: string;
    type: 'error' | 'warning' | 'info';
}

/** A verdict's fields as compileBody places them; the compiler that makes the verdict adds whose it is. */
export type VerdictFields = Omit<CompiledBody, 'producedBy'>;

/** One compile and the one verdict it may make (EA5.1's provenance, the EA5.1 review). */
export interface BoundCompile {
    messages: readonly CompileMessage[];
    /**
     * Makes this compile's verdict, once: the object the compiler itself returns, frozen, which its admission accepts only
     * when the fields say what the device said about exactly this compile's source. A second call throws.
     */
    verdict(fields: DeepReadonly<VerdictFields>): DeepReadonly<CompiledBody>;
}

/** L3's seam: a scripted fake in the tests, the device's own compiler in EA5.1 (src/exec/device-compiler.ts). */
export interface ModuleCompiler {
    /** Whose verdict it is: a fake's proves nothing about a device (I6). */
    readonly producedBy: 'fake' | 'device';
    /** The GPU that compiles, as the studio names it; a fake has none. */
    readonly gpu?: string;
    compile(source: string, label: string): Promise<readonly CompileMessage[]>;
    /**
     * The same compile, whose verdict the compiler makes itself (`verdict`, once), so that an admission can tell its own
     * verdict object from a copy or from one made in another generation (executor-design.md §6). A device compiler has
     * it; a fake need not, and its verdicts prove nothing either way. There is no way to register a verdict made elsewhere.
     */
    compileBound?(source: string, label: string): Promise<BoundCompile>;
}

export interface CompiledBody {
    /** No error anywhere in the module. */
    ok: boolean;
    producedBy: 'fake' | 'device';
    module: string;
    interfaceHash: string;
    codeHash: string;
    /** On the body's lines: a repair of this module can address them. */
    body: BodyFinding[];
    /** On the preamble's or the epilogue's lines: the host's code, never sent to a body repair (the design §8). */
    host: BodyFinding[];
    /** With no line: no module is accused (the design §8). */
    unplaced: BodyFinding[];
}

/**
 * L3: a checked body compiled in its assembled module, each message placed: on the body's lines, the host's, or none.
 * Only a body that passed its checks, for this interface, whose text is still the one its hash names, is compiled.
 */
export async function compileBody(iface: Interface, checked: DeepReadonly<CheckedBody>, compiler: ModuleCompiler): Promise<DeepReadonly<CompiledBody>> {
    if (!checked.ok) throw new Error(`compileBody: ${checked.module}'s body did not pass its checks; only a checked body is compiled`);
    if (checked.module !== iface.module || checked.interfaceHash !== iface.interfaceHash) {
        throw new Error(`compileBody: the body was checked against another interface than ${iface.module}'s (${iface.interfaceHash.slice(0, 12)})`);
    }
    if (await sha256Hex(checked.body) !== checked.codeHash) throw new Error(`compileBody: ${checked.module}'s body is not the text its codeHash names`);
    const assembled = assembleModule(iface, checked.body);
    const label = `${iface.module}#${checked.codeHash.slice(0, 12)}`;
    const bound = compiler.compileBound ? await compiler.compileBound(assembled.source, label) : null;
    const messages = bound ? bound.messages : await compiler.compile(assembled.source, label);
    const placed: Pick<CompiledBody, 'body' | 'host' | 'unplaced'> = { body: [], host: [], unplaced: [] };
    for (const m of messages) {
        if (m.type === 'info') continue;
        const severity = m.type === 'error' ? 'error' : 'warning';
        const message = String(m.message).slice(0, 400);
        const line = Number.isSafeInteger(m.line) ? m.line : 0;
        if (line < 1) {
            placed.unplaced.push({ rung: 'L3', line: null, code: 'compile', severity, message });
        } else if (line >= assembled.bodyFirstLine && line < assembled.bodyFirstLine + assembled.bodyLines) {
            placed.body.push({ rung: 'L3', line: line - assembled.bodyFirstLine + 1, code: 'compile', severity, message });
        } else {
            const where = line < assembled.bodyFirstLine ? 'preamble' : 'epilogue';
            placed.host.push({ rung: 'L3', line: null, code: 'host-source', severity, message: `${message} (the host's ${where}, line ${line} of the module)` });
        }
    }
    const fields: VerdictFields = {
        ok: ![...placed.body, ...placed.host, ...placed.unplaced].some(f => f.severity === 'error'),
        module: iface.module,
        interfaceHash: iface.interfaceHash,
        codeHash: checked.codeHash,
        ...placed,
    };
    if (bound) {
        // The compiler makes the verdict object itself, from the compile it reports. One it fails to make is made here,
        // unregistered, so an admission refuses it (the safe direction), never a body's fault.
        try {
            return bound.verdict(fields);
        } catch { /* falls through to an unregistered verdict */ }
    }
    return deepFreeze({ ...fields, producedBy: compiler.producedBy });
}

/**
 * EA4's L3: a scripted fake, for the tests and EA-E1. Each call answers the next entry of the script, the last one
 * repeating; every verdict it yields is labelled `fake`, which proves nothing about a device (I6).
 */
export function scriptedCompiler(script: readonly (readonly CompileMessage[])[]): ModuleCompiler & { readonly calls: readonly { label: string; source: string }[] } {
    const calls: { label: string; source: string }[] = [];
    return {
        producedBy: 'fake',
        calls,
        async compile(source: string, label: string) {
            calls.push({ label, source });
            return script.length ? script[Math.min(calls.length, script.length) - 1] : [];
        },
    };
}
