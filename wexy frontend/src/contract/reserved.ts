// Words that cannot name anything in WGSL: its keywords and the reserved words Dawn refused as identifiers on
// 2026-10-27 (the backend's B0.1 results; the gotcha "WGSL reserves words that read like names"). The same set
// as the backend's DraftChecks.RESERVED, plus `quality`, the host's own uniform: a control or a variable with one
// of these names fails to compile, so the draft parser and the lint refuse them first, with a message a repair
// can act on.

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
    'abstract', 'active', 'alias', 'alignas', 'alignof', 'as', 'asm', 'async', 'attribute', 'auto', 'await',
    'become', 'break', 'case', 'cast', 'catch', 'class', 'coherent', 'common', 'compile', 'concept', 'const',
    'constexpr', 'continue', 'continuing', 'crate', 'debugger', 'decltype', 'default', 'delete', 'demote',
    'diagnostic', 'discard', 'do', 'else', 'enable', 'enum', 'explicit', 'export', 'extends', 'extern',
    'external', 'fallthrough', 'false', 'filter', 'final', 'finally', 'fn', 'for', 'friend', 'from', 'fxgroup',
    'get', 'goto', 'groupshared', 'highp', 'if', 'impl', 'implements', 'import', 'inline', 'instanceof',
    'interface', 'layout', 'let', 'loop', 'lowp', 'macro', 'match', 'mediump', 'meta', 'mod', 'module',
    'move', 'mut', 'mutable', 'namespace', 'new', 'nil', 'noinline', 'nointerpolation', 'noperspective', 'null',
    'of', 'operator', 'override', 'package', 'packoffset', 'partition', 'pass', 'patch', 'pixelfragment',
    'precise', 'precision', 'premerge', 'priv', 'protected', 'pub', 'public', 'quality', 'readonly', 'ref',
    'regardless', 'register', 'require', 'requires', 'resource', 'restrict', 'return', 'self', 'set', 'shared',
    'sizeof', 'smooth', 'snorm', 'static', 'std', 'struct', 'subroutine', 'super', 'switch', 'target',
    'template', 'this', 'throw', 'trait', 'true', 'try', 'type', 'typedef', 'typename', 'typeof', 'union',
    'unless', 'unorm', 'unsafe', 'unsized', 'use', 'using', 'var', 'varying', 'virtual', 'volatile', 'wgsl',
    'where', 'while', 'with', 'writeonly', 'yield',
]);

/**
 * Built-in functions a model is likely to call. A local named after one hides it ("cannot use 'let step' as call
 * target"), so the lint reports a variable with one of these names that the same function then calls.
 */
export const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
    'abs', 'acos', 'all', 'any', 'asin', 'atan', 'atan2', 'ceil', 'clamp', 'cos', 'cross', 'degrees', 'distance',
    'dot', 'exp', 'exp2', 'floor', 'fract', 'inverseSqrt', 'length', 'log', 'log2', 'max', 'min', 'mix',
    'normalize', 'pow', 'radians', 'reflect', 'refract', 'round', 'saturate', 'select', 'sign', 'sin', 'smoothstep',
    'sqrt', 'step', 'tan', 'trunc',
]);
