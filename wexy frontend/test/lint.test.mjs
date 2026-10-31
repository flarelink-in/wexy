// C-series, headless: rung L1, the contract lint (src/contract/lint.ts), with the mutations of P7: an unbounded,
// a huge and a nested loop are refused; and every rule of h1/rules.md has a case that is seen to fail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H1 } from '../src/contract/h1/index.ts';
import { DIAL, lintFunction } from '../src/contract/lint.ts';

const EVOLVE = (inner) => `fn evolve(p: Particle, i: u32) -> Particle {\n${inner}\n    return p;\n}`;
const refused = (fn, body, pattern) => {
    const issues = lintFunction(fn, body);
    assert.ok(issues.some(i => pattern.test(i.message)), `${pattern} in: ${issues.map(i => `${i.line}: ${i.message}`).join(' | ') || '(clean)'}`);
    return issues;
};

test('C9 every exemplar and the recorded fault pass the lint (the fault is the compiler\'s to find)', () => {
    for (const world of ['galaxy', 'storm']) {
        for (const fn of ['evolve', 'look', 'sky']) assert.deepEqual(lintFunction(fn, H1.exemplars[world][fn]), [], `${world}.${fn}`);
    }
    assert.deepEqual(lintFunction('evolve', H1.faults['galaxy.evolve']), []);
});

test('C10 P7: loops with a literal bound of at most 32, nested to at most 128; no loop or while', () => {
    assert.deepEqual(lintFunction('evolve', EVOLVE('    for (var k = 0; k < 32; k++) { }')), []);
    assert.deepEqual(lintFunction('evolve', EVOLVE('    for (var k = 0u; k < 8u; k++) { for (var m = 0; m <= 15; m++) { } }')), []);
    refused('evolve', EVOLVE('    for (var k = 0; k < n; k++) { }'), /bound must be a literal number/);
    refused('evolve', EVOLVE('    for (var k = 0; k < 33; k++) { }'), /runs 33 times; at most 32/);
    refused('evolve', EVOLVE('    for (var k = 0; k <= 32; k++) { }'), /runs 33 times/);
    refused('evolve', EVOLVE('    for (var k = 0; k < 16; k++) { for (var m = 0; m < 16; m++) { } }'), /nested loops multiply: 16 × 16 = 256 steps; at most 128/);
    refused('evolve', EVOLVE('    for (var k = 0; k < 4; k++) { for (var m = 0; m < 4; m++) { for (var n = 0; n < 9; n++) { } } }'), /4 × 4 × 9 = 144/);
    refused('evolve', EVOLVE('    loop { break; }'), /no `loop`/);
    refused('evolve', EVOLVE('    while (true) { }'), /no `while`/);
    const issue = refused('evolve', EVOLVE('    var x = 0.0;\n    for (var k = 0; k < 64; k++) { x += 1.0; }'), /runs 64 times/);
    assert.equal(issue.find(i => /64 times/.test(i.message)).line, 3);
    assert.equal(DIAL.maxLoopBound, 32);
    assert.equal(DIAL.maxNestedProduct, 128);
});

test('T1 F1: one loop form; the outside review\'s five loops that never end are refused on the loop\'s line', () => {
    const loopLine = body => lintFunction('evolve', EVOLVE(`    var x = 0.0;\n${body}`));
    const refusedOnLoop = (body, pattern) => {
        const issues = loopLine(body);
        const hit = issues.find(i => pattern.test(i.message));
        assert.ok(hit, `${pattern} in: ${issues.map(i => `${i.line}: ${i.message}`).join(' | ') || '(clean)'}`);
        assert.equal(hit.line, 3, `on the loop's line: ${hit.message}`);
    };
    // The review's five (FE1 design Results, finding 1): each passed with no diagnostic before F1.
    refusedOnLoop('    for (var k = 0u; k < 8u;) { x += 1.0; }', /count up by a whole number/);
    refusedOnLoop('    for (var k = 0u; k < 8u; k++) {\n        x += 1.0;\n        k = 0u;\n    }', /counter `k` is changed inside the loop \(line 5/);
    refusedOnLoop('    for (var k = 0; k < 8; k--) { x += 1.0; }', /count up by a whole number/);
    refusedOnLoop('    for (var k = 0.0; k < 8.0; k += 0.0) { x += 1.0; }', /start from a whole number/);
    refusedOnLoop('    for (var k = 0u; k < 8u; k++) { *(&k) = 0u; }', /counter `k` has its address taken/);
    // Their neighbours: a step of zero, a float step, a body that counts down or adds, a shadowing counter, a
    // condition on another variable, a nested header that moves the outer counter.
    refusedOnLoop('    for (var k = 0; k < 8; k += 0) { }', /count up by a whole number/);
    refusedOnLoop('    for (var k = 0; k < 8; k += 0.5) { }', /count up by a whole number/);
    refusedOnLoop('    for (var k = 0; k < 8; k++) { k -= 1; }', /counter `k` is changed/);
    refusedOnLoop('    for (var k = 0; k < 8; k++) { k++; }', /counter `k` is changed/);
    refusedOnLoop('    for (var k = 0; k < 8; k++) { var k = 2; }', /named `k`, like its counter/);
    refusedOnLoop('    for (var k = 0; m < 8; k++) { }', /test its own counter `k`/);
    refusedOnLoop('    for (var k = 0; k < 8; k++) { for (var m = 0; m < 4; k++) { } }', /counter `k` is changed/);
    refusedOnLoop('    for (var k = 0u; k < 70000u; k += 65537u) { }', /at most 65536/);
    // Counted from the start to the bound by the step: 16, 32 and 32 runs pass; 33 is refused.
    assert.deepEqual(loopLine('    for (var k = 0; k < 32; k += 2) { x += f32(k); }'), []);
    assert.deepEqual(loopLine('    for (var k = 4; k < 36; k++) { x += f32(k); }'), []);
    assert.deepEqual(loopLine('    for (var k: i32 = -16; k < 16; k = k + 1) { x += f32(k); }'), []);
    refusedOnLoop('    for (var k = 4; k <= 36; k++) { }', /runs 33 times; at most 32/);
    refusedOnLoop('    for (var k = 0; k < 64; k += 1) { }', /runs 64 times/);
    // Nested loops multiply their counted runs: 16 × 16 at a step of 2 is 64.
    assert.deepEqual(loopLine('    for (var k = 0; k < 32; k += 2) { for (var m = 0u; m < 16u; m += 2u) { x += f32(k) * f32(m); } }'), []);
    // The counter may be read anywhere, compared, masked and used as an index; another variable may be written.
    assert.deepEqual(loopLine('    var a = array<f32, 8>();\n    for (var k = 0; k < 8; k++) { a[k] = f32(5 & k); if (k == 3 || k >= 5 && k != 7 || k <= 1) { x += a[k & 1]; } }'), []);
});

test('C11 one whole function with the contract\'s signature, and nothing else', () => {
    refused('evolve', 'let x = 1.0;', /one whole function, beginning with `fn evolve/);
    refused('evolve', 'fn evolve2(p: Particle, i: u32) -> Particle { return p; }', /named evolve2; it must be evolve/);
    refused('evolve', 'fn evolve(p: Particle) -> Particle { return p; }', /signature must be `fn evolve\(p: Particle, i: u32\) -> Particle`/);
    refused('look', 'fn look(p: Particle, i: u32) -> vec3f { return vec3f(0.0); }', /signature must be `fn look/);
    refused('sky', 'fn sky(d: vec3f) -> vec3f { return d; }\nfn helper() -> f32 { return 1.0; }', /nothing may come after/);
    refused('sky', 'struct Extra { a: f32 };\nfn sky(dir: vec3f) -> vec3f { return dir; }', /nothing may come before/);
    refused('sky', 'fn sky(dir: vec3f) -> vec3f { return dir;', /braces do not balance/);
    // Parameter names are the model's; the types and the return are the contract's.
    assert.deepEqual(lintFunction('sky', 'fn sky(direction: vec3f) -> vec3f {\n    return direction;\n}'), []);
    assert.deepEqual(lintFunction('evolve', 'fn evolve(particle:Particle,index:u32)->Particle{\n    return particle;\n}'), []);
});

test('C12 the Standard setting: 40 lines, arrays of 64, no bindings, attributes, barriers, textures or structs inside', () => {
    const lines = Array.from({ length: 40 }, (_, k) => `    var v${k} = ${k}.0;`).join('\n');
    refused('evolve', EVOLVE(lines), /is 43 lines; at most 40/);
    assert.deepEqual(lintFunction('evolve', EVOLVE(Array.from({ length: 36 }, (_, k) => `    var v${k} = ${k}.0;`).join('\n'))), []);
    refused('evolve', EVOLVE('    var a: array<f32, 65>;'), /array of 65; at most 64/);
    refused('evolve', EVOLVE('    var a: array<f32>;'), /needs a literal size/);
    assert.deepEqual(lintFunction('evolve', EVOLVE('    var a = array<vec2f, 3>(vec2f(0.0), vec2f(1.0), vec2f(2.0));')), []);
    refused('evolve', EVOLVE('    @group(1) @binding(0) var<uniform> x: f32;'), /no attributes/);
    refused('evolve', EVOLVE('    var<workgroup> shared_: array<f32, 8>;'), /no `var<workgroup>`/);
    refused('evolve', EVOLVE('    workgroupBarrier();'), /`workgroupBarrier` is not allowed/);
    refused('evolve', EVOLVE('    let t = textureSample(tex, s, uv);'), /`textureSample` is not allowed/);
    refused('evolve', EVOLVE('    atomicAdd(&counter, 1u);'), /`atomicAdd` is not allowed/);
    refused('evolve', EVOLVE('    struct Local { a: f32 };'), /no `struct` inside/);
});

test('C13 names the compiler refuses, a built-in hidden by a local, and GLSL the auto-fix could not rewrite', () => {
    refused('evolve', EVOLVE('    let type = 1.0;'), /`type` is a reserved word/);
    refused('evolve', EVOLVE('    var filter = p.pos;'), /`filter` is a reserved word/);
    refused('evolve', EVOLVE('    for (var pass = 0; pass < 4; pass++) { }'), /`pass` is a reserved word/);
    refused('evolve', EVOLVE('    let step = 0.1;\n    let s = step(0.0, p.pos.x);'), /`step` names a variable here, so `step\(…\)` can no longer be called/);
    assert.deepEqual(lintFunction('evolve', EVOLVE('    let steps = 0.1;\n    let s = step(0.0, p.pos.x);')), []);
    assert.deepEqual(lintFunction('evolve', EVOLVE('    let mixed = mix(0.0, 1.0, 0.5);')), []);
    refused('evolve', EVOLVE('    let m = mod(a, b, c);'), /there is no `mod\(\)` in WGSL/);
    refused('evolve', EVOLVE('    let m = double(a);'), /`double\(` is GLSL/);
    // Comments never count: a reserved word or a loop in a comment is fine.
    assert.deepEqual(lintFunction('evolve', EVOLVE('    // while (type) { loop }\n    /* @group(0) */')), []);
});
