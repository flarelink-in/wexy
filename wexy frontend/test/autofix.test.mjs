// C-series, headless: rung L2, the auto-fix table (src/contract/autofix.ts). Every rule is pinned, and the one
// invariant the backend relies on: the line count never changes (a repair names lines in the recorded text).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autofix, AUTOFIX_RULES } from '../src/contract/autofix.ts';
import { H1 } from '../src/contract/h1/index.ts';

const one = (line) => autofix(line);

test('C6 each rule rewrites its slip and nothing else', () => {
    const cases = [
        ['let a = float(i) * 2.0;', 'let a = f32(i) * 2.0;', 'float() is f32()'],
        ['let k = int(x) + uint(y);', 'let k = i32(x) + u32(y);', 'int() is i32()'],
        ['var p = vec3<float>(1.0, 2.0, 3.0);', 'var p = vec3f(1.0, 2.0, 3.0);', 'vecN<float> is vecNf'],
        ['let q = vec2<int>(1, 2); let r = vec4<uint>(1u);', 'let q = vec2i(1, 2); let r = vec4u(1u);', 'vecN<int> is vecNi'],
        ['let n = inversesqrt(d);', 'let n = inverseSqrt(d);', 'inversesqrt() is inverseSqrt()'],
        ['let a = atan(p.z, p.x);', 'let a = atan2(p.z, p.x);', 'atan(y, x) is atan2(y, x)'],
        ['let s = mod(phase + b.x * 0.17, 1.0);', 'let s = ((phase + b.x * 0.17) - 1.0 * floor((phase + b.x * 0.17) / 1.0));', 'mod(x, y) is x - y * floor(x / y)'],
        ['let s = mod(x, y);', 'let s = (x - y * floor(x / y));', 'mod(x, y) is x - y * floor(x / y)'],
        ['let s = mod(length(p.xz), max(r, 1.0)) * mod(a, b);', 'let s = ((length(p.xz)) - (max(r, 1.0)) * floor((length(p.xz)) / (max(r, 1.0)))) * (a - b * floor(a / b));', 'mod(x, y) is x - y * floor(x / y)'],
    ];
    for (const [before, after, rule] of cases) {
        const r = one(before);
        assert.equal(r.body, after, before);
        assert.ok(r.fixes.some(f => f.rule === rule), `${rule} recorded for ${before}`);
        assert.equal(r.fixes[0].line, 1);
    }
});

test('C7 what is not a slip stays: one-argument atan, three-argument mod, names that contain a rule\'s word, comments', () => {
    for (const line of ['let a = atan(x);', 'let m = mod(a, b, c);', 'let myfloat(x) = 1;', 'let v = p.mod(1.0);', 'let f = fract(x);', '// use mod(a, b) here', 'let a = x; // float(y)']) {
        const r = one(line);
        assert.equal(r.body, line, line);
        assert.deepEqual(r.fixes, [], line);
    }
});

test('C8 the line count never changes, the exemplars need no fix, and the table is what the design lists', () => {
    const body = 'fn evolve(p: Particle, i: u32) -> Particle {\n    let s = mod(p.phase, 1.0); // keep\n    var n = p;\n    n.pos = vec3<float>(float(i), 0.0, 0.0);\n    return n;\n}';
    const r = autofix(body);
    assert.equal(r.body.split('\n').length, body.split('\n').length);
    assert.deepEqual(r.fixes.map(f => f.line), [2, 4, 4]);
    assert.equal(r.body.split('\n')[1], '    let s = (p.phase - 1.0 * floor(p.phase / 1.0)); // keep');
    for (const world of ['galaxy', 'storm']) {
        for (const fn of ['evolve', 'look', 'sky']) {
            const text = H1.exemplars[world][fn];
            assert.equal(autofix(text).body, text, `${world}.${fn}`);
        }
    }
    assert.deepEqual(AUTOFIX_RULES.map(r => r.name), [
        'float() is f32()', 'int() is i32()', 'uint() is u32()', 'vecN<float> is vecNf', 'vecN<int> is vecNi', 'vecN<uint> is vecNu',
        'inversesqrt() is inverseSqrt()', 'atan(y, x) is atan2(y, x)', 'mod(x, y) is x - y * floor(x / y)',
    ]);
});
