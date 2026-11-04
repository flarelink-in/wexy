// EA-M series, headless (EA4.1; candidate-loop-design.md §7, §10): a module body checked against the interface it was
// written for, without a device. The EA-I world's three interfaces (a compute stage, a custom batch, a fullscreen pass)
// take a minimal body each; then each way a body can break the form Q79 decided is refused at its line; an undeclared
// value only warns; the auto-fix runs once and the final lint decides (P9); comments and the body's own names survive
// it; the text judged is the text hashed; and the compiler's messages land on the body, the host or nowhere. No GPU:
// L3 is a scripted fake, labelled so.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTOFIX_RULES } from '../src/contract/autofix.ts';
import {
    AUTOFIX_SOURCE_NAMES, BODY_CHECKER, BODY_DIAL, assembleModule, checkBody, compileBody, fixBody, lintBody, scriptedCompiler,
} from '../src/contract/adapters/bodies.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';

const node = (id, adapterId, config, inputs = []) => ({ id, adapterId, adapterVersion: 1, config: JSON.stringify(config), inputs });
const from = (port, nodeId, output) => ({ port, nodeId, output });
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The EA-I world: one interface of each kind (motion, water, sky). */
function world() {
    return [
        node('instances', 'ng.buffer.storage', { elements: 64, layout: 'instance14', strideFloats: 14, pingPong: false, init: 'zero' }),
        node('field', 'ng.buffer.storage', { elements: 4096, layout: 'f32', strideFloats: 4, pingPong: true, init: 'zero' }),
        node('move', 'ng.compute.stage', { module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'fixedStep' },
            [from('reads', 'field', 'buffer'), from('writes', 'instances', 'buffer')]),
        node('cube', 'ng.geometry.primitive', { shape: 'cube', size: 1, segments: 3 }),
        node('stone', 'ng.material.stock', { kind: 'lambert', baseColor: [0.6, 0.55, 0.5, 1] }),
        node('sun', 'ng.light.rig', { ambient: [0.1, 0.1, 0.12], directional: { direction: [0.3, -1, 0.2], color: [1, 0.95, 0.85], intensity: 2 }, points: [] }),
        node('blocks', 'ng.render.mesh_batch', { maxInstances: 64 },
            [from('geometry', 'cube', 'geometry'), from('material', 'stone', 'material'), from('instances', 'instances', 'buffer'), from('lights', 'sun', 'lights')]),
        node('water', 'ng.render.custom_batch', { module: 'water', vertexEntry: 'wave', fragmentEntry: 'shade', maxInstances: 1 }, [from('geometry', 'cube', 'geometry')]),
        node('sky', 'ng.render.fullscreen', { module: 'sky', fragmentEntry: 'dusk' }, [from('reads', 'field', 'buffer')]),
        node('look', 'ng.post.chain', { effects: [{ effect: 'Tonemap', intensity: 1 }] }),
    ];
}

const resolved = await resolveProgram(world());
assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
const derived = await deriveInterfaces(resolved.graph);
assert.equal(derived.ok, true, JSON.stringify(derived.diagnostics));
const I = Object.fromEntries(derived.interfaces.map(i => [i.module, i]));
/** The motion stage at frame, not at a fixed step: no clock of its own in ea-abi.v2 (Q81), the camera's time only. */
const FRAME_MOTION = await (async () => {
    const w = world();
    w[2].config = JSON.stringify({ module: 'motion', entry: 'advance', workgroupSize: 64, invocations: 64, phase: 'frame' });
    const r = await resolveProgram(w);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return (await deriveInterfaces(r.graph)).interfaces.find(i => i.module === 'motion');
})();

const MOTION = [
    'fn advance(index: u32) {',
    '    let base = index * B_instances_STRIDE;',
    '    let f = b_field_current[(index % 1024u) * B_field_STRIDE];',
    '    b_instances[base + 1u] = f32(index) * 0.1;',
    '    b_instances[base + 2u] = sin(camera.simTime + f);',
    '}',
].join('\n');

const WATER = [
    'fn wave(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, instance: u32) -> VertexOut {',
    '    var out: VertexOut;',
    '    let lifted = position + vec3f(0.0, sin(position.x * 4.0 + camera.simTime) * 0.1, 0.0);',
    '    out.clipPos = camera.viewProj * vec4<f32>(lifted, 1.0);',
    '    out.worldPos = lifted;',
    '    out.worldNormal = normal;',
    '    out.uv = uv;',
    '    out.ecsColor = vec3f(0.2, 0.4, 0.8) + vec3f(f32(instance) * 0.0);',
    '    return out;',
    '}',
    '',
    'fn shade(input: VertexOut) -> vec4<f32> {',
    '    return vec4<f32>(input.ecsColor * (0.5 + 0.5 * input.worldNormal.y), 1.0);',
    '}',
].join('\n');

const SKY = [
    '/* a dusk gradient /* with a nested comment */ still inside the outer one */',
    'const HORIZON: vec3<f32> = vec3<f32>(0.9, 0.6, 0.4);',
    '',
    'fn glow(y: f32) -> f32 {',
    '    return clamp(1.0 - y, 0.0, 1.0); // a line comment',
    '}',
    '',
    'fn dusk(uv: vec2<f32>) -> vec4<f32> {',
    '    var color = vec3<f32>(0.1, 0.1, 0.25);',
    '    for (var k = 0; k < 4; k++) {',
    '        color = mix(color, HORIZON, glow(uv.y) * 0.2);',
    '    }',
    '    let f = b_field_current[0] * 0.0;',
    '    return vec4<f32>(color + f, 1.0);',
    '}',
].join('\n');

const errors = (findings) => findings.filter(f => f.severity === 'error');
/** The lint refuses `body` with a `code` finding on `line` (null: no single line). */
function refuses(iface, body, code, line, pattern) {
    const found = lintBody(iface, body);
    assert.ok(found.some(f => f.severity === 'error' && f.code === code && f.line === line && (!pattern || pattern.test(f.message))),
        `wanted ${code} at ${line}${pattern ? ` matching ${pattern}` : ''}; got ${JSON.stringify(found)}`);
    return found;
}
/** MOTION with `lines` inserted after its first line: they are lines 2 onwards. */
const inMotion = (...lines) => [MOTION.split('\n')[0], ...lines, ...MOTION.split('\n').slice(1)].join('\n');

test('EA-M1 a minimal body of each kind passes its interface: the compute stage, the custom batch, the fullscreen pass', async () => {
    assert.deepEqual(Object.keys(I).sort(), ['motion', 'sky', 'water']);
    for (const [module, body] of [['motion', MOTION], ['water', WATER], ['sky', SKY]]) {
        assert.deepEqual(lintBody(I[module], body), [], module);
        const checked = await checkBody(I[module], body);
        assert.equal(checked.ok, true, module);
        assert.equal(checked.codeHash, sha(body), `${module}: the hash is the text's`);
        assert.equal(checked.interfaceHash, I[module].interfaceHash);
        assert.equal(checked.checker, BODY_CHECKER);
    }
    // A fixed step reads its own clock (Q81): its dt, its time and its number are the host's names.
    assert.deepEqual(lintBody(I.motion, inMotion('    let t = sim.time + sim.dt * f32(sim.step);', '    b_instances[index] = t;')), []);
    // vec3f and vec3<f32> are one type: an entry may spell its signature either way.
    assert.deepEqual(errors(lintBody(I.sky, SKY.replace('fn dusk(uv: vec2<f32>) -> vec4<f32>', 'fn dusk(uv: vec2f) -> vec4f'))), []);
});

test('EA-M2 each way a body breaks its form is refused at its line, in words a repair can act on', () => {
    refuses(I.motion, 'fn helper(x: f32) -> f32 {\n    return x;\n}', 'entry-missing', null, /define `fn advance\(index: u32\) \{ … \}`/);
    refuses(I.motion, `${MOTION}\n${MOTION}`, 'entry-twice', 7);
    refuses(I.motion, MOTION.replace('index: u32', 'index: i32'), 'signature', 1, /must be `fn advance\(index: u32\)`/);
    refuses(I.sky, SKY.replace('-> vec4<f32> {', '-> vec3<f32> {'), 'signature', 8);
    refuses(I.motion, `@compute ${MOTION}`, 'attribute', 1, /@compute/);
    refuses(I.motion, `var<private> state: f32;\n${MOTION}`, 'scope', 1, /module-scope `var`/);
    refuses(I.motion, `override speed: f32 = 1.0;\n${MOTION}`, 'scope', 1, /no `override`/);
    refuses(I.motion, `struct Extra { a: f32 }\n${MOTION}`, 'scope', 1, /no `struct`/);
    refuses(I.motion, `enable f16;\n${MOTION}`, 'scope', 1, /directive/);
    refuses(I.motion, `fn step(x: f32) -> f32 {\n    return x;\n}\n${MOTION}`, 'name', 1, /WGSL word, built-in or type/);
    refuses(I.motion, `const B_extra: u32 = 1u;\n${MOTION}`, 'name', 1, /the host's/);
    refuses(I.motion, `fn cs_main() {\n}\n${MOTION}`, 'name', 1, /the names its preamble declares/);
    refuses(I.motion, `const B_instances_STRIDE: u32 = 3u;\n${MOTION}`, 'name', 1, /the host's/);
    refuses(I.motion, inMotion('    for (var k = 0u; k < arrayLength(&b_instances); k++) {', '    }'), 'loop-form', 2, /literal number/);
    refuses(I.motion, inMotion('    while (true) {', '        break;', '    }'), 'loop', 2);
    refuses(I.motion, inMotion('    for (var k = 0; k < 8; k++) {', '        for (var j = 0; j < 17; j++) {', '        }', '    }'), 'loop-form', 3, /8 × 17 = 136/);
    refuses(I.motion, `${MOTION}\n${'// pad\n'.repeat(BODY_DIAL.maxLines)}`, 'lines', null, new RegExp(`lines; at most ${BODY_DIAL.maxLines}$`));
    // 2026-11-04 (the user: repairs were spent cutting working code to 120 lines): a body of 800 lines, 141 of them the
    // castle's own size, is no finding at all; one past it is, and past the characters too.
    assert.equal(BODY_DIAL.maxLines, 800);
    assert.equal(BODY_DIAL.maxChars, 48_000);
    const padded = (lines) => `${MOTION}\n${'// pad\n'.repeat(lines - MOTION.split('\n').length)}`;
    assert.deepEqual(lintBody(I.motion, padded(141)).filter(f => f.code === 'lines' || f.code === 'size'), [], 'the castle\'s 141 lines');
    assert.deepEqual(lintBody(I.motion, padded(BODY_DIAL.maxLines)).filter(f => f.code === 'lines' || f.code === 'size'), [], 'exactly at the bound');
    refuses(I.motion, `${MOTION}\n${'//'.repeat(BODY_DIAL.maxChars / 2)}`, 'size', null, new RegExp(`characters; at most ${BODY_DIAL.maxChars}$`));
    refuses(I.motion, inMotion('    var a = 0u;', '    atomicAdd(&a, 1u);'), 'capability', 3, /no atomics/);
    refuses(I.motion, inMotion('    workgroupBarrier();'), 'capability', 2);
    refuses(I.sky, SKY.replace('let f = b_field_current[0] * 0.0;', 'let f = textureSample(t, s, uv).r;'), 'capability', 13);
    refuses(I.motion, inMotion('    var<workgroup> shared_sum: f32;'), 'address-space', 2);
    refuses(I.motion, inMotion('    let a: array<f32, 100> = array<f32, 100>();'), 'array', 2, /at most 64/);
    // An array's size is read from tokens (the review of 10-31): one the dial cannot read refuses, a hexadecimal size
    // counts as its value, every dimension is judged, and nested arrays multiply, as nested loops do.
    refuses(I.motion, inMotion('    var data: array<f32, 0x100000>;'), 'array', 2, /an array of 1048576; at most 64/);
    refuses(I.motion, inMotion('    var data: array<f32, 64 + 1>;'), 'array', 2, /literal whole number.*`64 \+ 1` is not/);
    refuses(I.motion, inMotion('    var data: array<array<f32, 64>, 1000000>;'), 'array', 2, /an array of 1000000/);
    refuses(I.motion, inMotion('    var data: array<array<f32, 16>, 8>;'), 'array', 2, /8 arrays of 16 values: 128 in all; at most 64/);
    refuses(I.motion, `const N = 100000u;\n${inMotion('    var data: array<f32, N>;')}`, 'array', 3, /`N` is not/);
    refuses(I.motion, inMotion('    var data: array<f32>;'), 'array', 2, /literal size of at most 64/);
    refuses(I.motion, inMotion(`    let table = array(${Array(65).fill('0.0').join(', ')});`), 'array', 2, /holds 65 values; at most 64/);
    refuses(I.motion, `const TABLE = array<u32, 256>();\n${MOTION}`, 'array', 1, /an array of 256/);
    assert.deepEqual(errors(lintBody(I.motion, inMotion('    var a: array<f32, 0x40u>;', '    var b = array<array<f32, 8>, 8>();',
        '    let c = array(1.0, 2.0, 3.0,);', '    let d = array<vec4<f32>, 4>();', '    b_instances[index] = a[0] + b[0][0] + c[0] + d[0].x;'))), [],
        'sizes within the dial pass, a hexadecimal one and a trailing comma included');
    refuses(I.motion, inMotion('    let move = 1.0;'), 'name', 2, /reserved word/);
    refuses(I.motion, inMotion('    let camera = 1.0;'), 'name', 2, /the host's/);
    // A local named after a built-in the same function calls hides it (h1's rule, kept).
    refuses(I.motion, inMotion('    let step = 0.5;', '    let s = step(0.1, f32(index));'), 'name', 2, /can no longer be called/);
    // The host's names come from the interface itself, prefix or none: Q81's clock is an unprefixed `sim` (ea-abi.v2),
    // which only a fixed-step stage's interface declares. At module scope it is the host's everywhere, as `ecs` is
    // (ENTRY_EXCLUDED: a name generated code uses); a local hides it only where the interface declares it.
    refuses(I.motion, `const sim: f32 = 1.0;\n${MOTION}`, 'name', 1, /the names its preamble declares/);
    refuses(I.motion, `const EaSim: f32 = 1.0;\n${MOTION}`, 'name', 1, /the names its preamble declares/);
    refuses(FRAME_MOTION, `const sim: f32 = 1.0;\n${MOTION}`, 'name', 1, /a name the host's code uses/);
    refuses(I.motion, inMotion('    let sim = 1.0;'), 'name', 2, /the host's/);
    assert.deepEqual(errors(lintBody(FRAME_MOTION, inMotion('    let sim = 1.0;', '    b_instances[index] = sim;'))), [], 'a local, only where the interface declares it');
});

test('EA-M3 a value nothing declares is a warning, not a refusal: the compiler decides it, and no repair is spent', async () => {
    const body = inMotion('    b_instances[index] = speed;');
    const found = lintBody(I.motion, body);
    assert.deepEqual(found.map(f => [f.code, f.line, f.severity]), [['unresolved', 2, 'warning']]);
    assert.match(found[0].message, /`speed`/);
    assert.equal((await checkBody(I.motion, body)).ok, true);
    // At a frame stage there is no clock: `sim` is a name nothing declares there, so it warns (Q81).
    assert.deepEqual(lintBody(FRAME_MOTION, inMotion('    b_instances[index] = sim.dt;')).map(f => [f.code, f.line, f.severity]), [['unresolved', 2, 'warning']]);
    // A module-scope constant's type and value are read as a function's are (the review of 10-31).
    assert.deepEqual(lintBody(I.motion, `const C = missingValue;\n${MOTION}`).map(f => [f.code, f.line, f.severity]), [['unresolved', 1, 'warning']]);
    assert.deepEqual(lintBody(I.motion, `const C: Mystery = 1.0;\n${MOTION}`).map(f => [f.code, f.line, f.severity]), [['unresolved', 1, 'warning']]);
    // Said once, where it is first used, whether that is a constant or a function.
    assert.deepEqual(lintBody(I.motion, `const C = speed * 2.0;\n${inMotion('    b_instances[index] = speed;')}`).map(f => [f.code, f.line]), [['unresolved', 1]]);
});

test('EA-M4 the auto-fix runs once; the checked text is the one hashed, LF only; the model\'s answer is kept beside it', async () => {
    const answer = inMotion('    b_instances[index] = float(index);').replace(/\n/g, '\r\n');
    const checked = await checkBody(I.motion, answer);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.initial.map(f => [f.code, f.line]), [['glsl', 2]], 'the first lint saw it');
    assert.deepEqual(checked.findings, [], 'the final lint decides');
    assert.deepEqual(checked.fixes.map(f => [f.line, f.rule, f.after]), [[2, 'float() is f32()', 'b_instances[index] = f32(index);']]);
    assert.equal(checked.original, answer, 'the answer as it came');
    assert.ok(!checked.body.includes('\r') && checked.body.includes('f32(index);'));
    assert.equal(checked.codeHash, sha(checked.body));
    assert.notEqual(checked.codeHash, sha(answer));
    assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.fixes));
    // A lone CR ends a line too, so a finding names the line a reader sees.
    assert.deepEqual(lintBody(I.motion, inMotion('    workgroupBarrier();').replace(/\n/g, '\r')).map(f => [f.code, f.line]), [['capability', 2]]);
});

test('EA-M5 structure is read from tokens: locals and F1 loops pass; recursion, unknown calls, broken brackets and comments refuse', () => {
    // Locals, an F1 loop, a nested pair within the dial (8 × 16 = 128), a helper called twice.
    const fine = inMotion('    var total = 0.0;', '    for (var k = 0; k < 8; k++) {', '        for (var j = 0; j < 16; j++) {',
        '            total = total + f32(k * j);', '        }', '    }', '    b_instances[index] = total;');
    assert.deepEqual(errors(lintBody(I.motion, fine)), []);
    refuses(I.motion, `fn again(x: f32) -> f32 {\n    return again(x);\n}\n${MOTION}`, 'recursion', 1, /`again` calls itself/);
    const mutual = lintBody(I.motion, `fn ping(x: f32) -> f32 {\n    return pong(x);\n}\nfn pong(x: f32) -> f32 {\n    return ping(x);\n}\n${MOTION}`);
    assert.equal(mutual.filter(f => f.code === 'recursion').length, 1, 'one cycle, said once');
    assert.match(mutual.find(f => f.code === 'recursion').message, /`ping` calls `pong` calls `ping`/);
    refuses(I.motion, inMotion('    b_instances[index] = noise3(vec3f(0.0));'), 'call', 2, /`noise3`/);
    // A module-scope constant's calls must resolve too (the review of 10-31); whether its value is a constant
    // expression is the compiler's (EA5), so a constant calling WGSL's built-ins, its types or a helper is not refused.
    refuses(I.motion, `const C = mystery(1);\n${MOTION}`, 'call', 1, /`mystery`/);
    assert.deepEqual(errors(lintBody(I.motion, `const C = vec3<f32>(sin(1.0), 0.0, 0.0);\nconst D = f32(EA_INVOCATIONS) * C.x;\n${MOTION}`)), []);
    // A structure that cannot be read refuses, and nothing past it is judged: not even the stray brace's place.
    assert.deepEqual(lintBody(I.motion, MOTION.slice(0, -1)).map(f => f.code), ['balance']);
    assert.deepEqual(lintBody(I.motion, `${MOTION}\n}`).map(f => [f.code, f.line]), [['balance', 7]]);
    assert.deepEqual(lintBody(I.motion, `/* never closed\n${MOTION}`).map(f => [f.code, f.line]), [['comment', 1]]);
    // A nested block comment hides a whole second entry: it is a comment, not a definition.
    assert.deepEqual(lintBody(I.motion, `/* outer /* inner */ fn advance(index: u32) {} */\n${MOTION}`), []);
    refuses(I.motion, `#define SPEED 1.0\n${MOTION}`, 'character', 1, /`#` is not WGSL/);
    refuses(I.motion, inMotion('    let café = 1.0;'), 'character', 2, /ASCII/);
    refuses(I.motion, inMotion('    fn inner() {', '    }'), 'declaration', 2, /no `fn` inside a function/);
});

test('EA-M6 the final lint decides; comments are never rewritten; a body\'s own names keep their calls; every rule is mapped', async () => {
    // P9: the fix rewrites atan(y, x) to atan2(y, x), which a local named atan2 now hides. The first lint passed it.
    const shadow = inMotion('    let atan2 = 0.5;', '    let a = atan(f32(index), atan2);', '    b_instances[index] = a;');
    const checked = await checkBody(I.motion, shadow);
    assert.deepEqual(errors(checked.initial), [], 'no pre-fix pass certifies the post-fix text');
    assert.equal(checked.ok, false);
    assert.deepEqual(errors(checked.findings).map(f => [f.code, f.line]), [['name', 2]]);
    // Comments, line and block, nested included, are left as written; the code beside them is fixed.
    const commented = inMotion('    // float(x) stays as written', '    /* mod(a, b) and /* float(c) */ stay too */', '    b_instances[index] = float(index); // float(y)');
    const fixed = fixBody(commented);
    const lines = fixed.body.split('\n');
    assert.equal(lines[1], '    // float(x) stays as written');
    assert.equal(lines[2], '    /* mod(a, b) and /* float(c) */ stay too */');
    assert.equal(lines[3], '    b_instances[index] = f32(index); // float(y)');
    assert.equal(lines.length, commented.split('\n').length, 'the line count never changes');
    // A helper the body named `float` keeps its calls: rewriting them would bypass it.
    const own = `fn float(x: f32) -> f32 {\n    return x * 2.0;\n}\n${inMotion('    b_instances[index] = float(1.0);')}`;
    const kept = fixBody(own);
    assert.equal(kept.body, own);
    assert.ok(kept.skipped.some(s => s.rule === 'float() is f32()' && /declares `float`/.test(s.because)), JSON.stringify(kept.skipped));
    assert.equal((await checkBody(I.motion, own)).ok, true);
    // Every rule of h1's auto-fix has its name here, or it would not be applied to a module body at all.
    assert.deepEqual(Object.keys(AUTOFIX_SOURCE_NAMES).sort(), AUTOFIX_RULES.map(r => r.name).sort());
    // A comment inside a call no longer hides it from its fix (the review of 10-31). A rename touches only the name,
    // so the comment stays where it was; a mod rewrite keeps each comment it held, after the rewritten expression.
    const inside = inMotion('    let x = float /* keep */ (index);', '    let y = mod(f32(index) /* keep */, 2.0);',
        '    let z = atan(f32(index) /* y */, 1.0) + vec3</* t */float>(1.0).x;', '    b_instances[index] = x + y + z;');
    const insideChecked = await checkBody(I.motion, inside);
    assert.equal(insideChecked.ok, true, JSON.stringify(insideChecked.findings));
    // The first lint's diagnostic says the code alone: the comment it blanked is not a run of spaces in its words.
    assert.match(insideChecked.initial.find(f => f.code === 'glsl' && f.line === 2).message, /^`float \(` is GLSL/);
    assert.deepEqual(insideChecked.body.split('\n').slice(1, 4), [
        '    let x = f32 /* keep */ (index);',
        '    let y = ((f32(index)) - 2.0 * floor((f32(index)) / 2.0)) /* keep */;',
        '    let z = atan2(f32(index) /* y */, 1.0) + vec3</* t */f32>(1.0).x;',
    ]);
    assert.deepEqual(insideChecked.fixes.map(f => [f.line, f.rule]),
        [[2, 'float() is f32()'], [3, 'mod(x, y) is x - y * floor(x / y)'], [4, 'vecN<float> is vecNf'], [4, 'atan(y, x) is atan2(y, x)']]);
    // Without a comment inside, the fix is h1's own text; a nested mod is rewritten outside in, as h1's is; an atan of
    // one argument is WGSL's own, and stays.
    assert.equal(fixBody(inMotion('    let v = vec3<float>(1.0);')).body.split('\n')[1], '    let v = vec3f(1.0);');
    assert.equal(fixBody(inMotion('    let t = atan(1.0);')).body.split('\n')[1], '    let t = atan(1.0);');
    assert.equal(fixBody(inMotion('    let w = mod(mod(a, 3.0), 2.0);')).body.split('\n')[1],
        '    let w = (((a - 3.0 * floor(a / 3.0))) - 2.0 * floor(((a - 3.0 * floor(a / 3.0))) / 2.0));');
    // A rewrite never grows a body past its limit (a nested mod writes its arguments twice): the repair is told of the
    // mod the model wrote, not of a size it never wrote.
    const grown = await checkBody(I.motion, inMotion(`    let w = ${'mod('.repeat(30)}f32(index)${', 2.0)'.repeat(30)};`, '    b_instances[index] = w;'));
    assert.ok(grown.body.length <= BODY_DIAL.maxChars, `${grown.body.length} characters`);
    assert.ok(grown.skipped.some(s => s.because === `line 2: the rewrite would make the body longer than its ${BODY_DIAL.maxChars} characters; the rest is left for the lint and the repair`),
        JSON.stringify(grown.skipped));
    assert.deepEqual(errors(grown.findings).map(f => [f.code, f.line]), [['glsl', 2]]);
    // A mod call split across lines is left as written, and said so: no rewrite may change the line count.
    const split = fixBody(inMotion('    let s = mod(f32(index),', '        2.0);'));
    assert.equal(split.body, inMotion('    let s = mod(f32(index),', '        2.0);'));
    assert.ok(split.skipped.some(s => s.rule === 'mod(x, y) is x - y * floor(x / y)' && /line 2: the call spans lines/.test(s.because)), JSON.stringify(split.skipped));
});

test('EA-M7 L3: the assembled module places the body; a compiler\'s messages land on the body, the host or nowhere, labelled fake', async () => {
    const checked = await checkBody(I.motion, MOTION);
    const assembled = assembleModule(I.motion, checked.body);
    const lines = assembled.source.split('\n');
    assert.equal(lines[assembled.bodyFirstLine - 1], MOTION.split('\n')[0]);
    assert.ok(assembled.source.startsWith(I.motion.preamble) && assembled.source.endsWith(I.motion.epilogue));
    const epilogueLine = assembled.bodyFirstLine + assembled.bodyLines + 1;
    const compiler = scriptedCompiler([
        [
            { line: assembled.bodyFirstLine + 2, message: 'unresolved value', type: 'error' },
            { line: 2, message: 'in the preamble', type: 'warning' },
            { line: epilogueLine, message: 'in the epilogue', type: 'error' },
            { line: 0, message: 'nowhere', type: 'error' },
            { line: assembled.bodyFirstLine, message: 'a note', type: 'info' },
        ],
        [],
    ]);
    const failed = await compileBody(I.motion, checked, compiler);
    assert.equal(failed.ok, false);
    assert.equal(failed.producedBy, 'fake');
    assert.deepEqual(failed.body.map(f => [f.rung, f.line, f.severity]), [['L3', 3, 'error']]);
    assert.deepEqual(failed.host.map(f => [f.code, f.severity]), [['host-source', 'warning'], ['host-source', 'error']]);
    assert.match(failed.host[0].message, /the host's preamble, line 2/);
    assert.match(failed.host[1].message, /the host's epilogue/);
    assert.deepEqual(failed.unplaced.map(f => [f.line, f.severity]), [[null, 'error']]);
    const passed = await compileBody(I.motion, checked, compiler);
    assert.equal(passed.ok, true);
    assert.deepEqual(compiler.calls.map(c => c.label), [`motion#${checked.codeHash.slice(0, 12)}`, `motion#${checked.codeHash.slice(0, 12)}`]);
    assert.equal(compiler.calls[0].source, assembled.source);
    // Only a checked body, for its own interface, whose text is still the one hashed, is compiled.
    const refusedBody = await checkBody(I.motion, inMotion('    workgroupBarrier();'));
    await assert.rejects(compileBody(I.motion, refusedBody, compiler), /did not pass its checks/);
    await assert.rejects(compileBody(I.sky, checked, compiler), /another interface/);
    await assert.rejects(compileBody(I.motion, { ...checked, body: `${checked.body}\n` }, compiler), /not the text its codeHash names/);
    assert.equal(compiler.calls.length, 2, 'a refused compile calls no compiler');
});
