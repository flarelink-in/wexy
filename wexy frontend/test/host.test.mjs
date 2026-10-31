// C-series, headless: host h1 as embedded (src/contract/h1) against the backend's files (Q28), and the modules
// the host assembles around a function (src/contract/host.ts).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assembleModule, functionLine, HOST_START, LOOK_STRUCT, MODEL_START, PARTICLE_STRUCT } from '../src/contract/host.ts';
import { H1, H1_FILES, normalizeHostText } from '../src/contract/h1/index.ts';
import { DIAL } from '../src/contract/lint.ts';

/**
 * SHA-256 over `<name>
<text>
` for every embedded file, sorted by name, each text in the backend's normalized form
 * (LF, no trailing whitespace); the names are the paths under host/h1, and `mock/...` for the recordings. The backend's
 * HostContractTest pins the same value; changing host h1 means a new host version, agreed in both repositories the
 * same day (design guidelines §1).
 */
const H1_HASH = 'be6af5f571b61514a587d1ada0db0bc19f2abc45f37a7d1194c95a76cad24a2c';

const BACKEND = 'D:/orion-realms/wexy/wexy backend/forge-service/src/main/resources';

const hashAll = (files) => {
    const h = createHash('sha256');
    for (const name of Object.keys(files).sort()) h.update(`${name}\n${files[name]}\n`);
    return h.digest('hex');
};

test('C14 the embedded host h1 is the pinned version, byte for byte in the backend\'s normalized form', () => {
    assert.equal(hashAll(H1_FILES), H1_HASH);
    assert.equal(H1.version, 'h1');
});

test('C15 the backend\'s files equal the embedded ones, when the backend repository is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, () => {
    for (const [name, text] of Object.entries(H1_FILES)) {
        const path = join(BACKEND, name.startsWith('mock/') ? name : `host/h1/${name}`);
        assert.equal(text, normalizeHostText(readFileSync(path, 'utf8')), name);
    }
});

test('C16 the views tell the model what the host declares: the structs, every helper with its signature, the limits', () => {
    assert.ok(H1.particles.includes(PARTICLE_STRUCT.replace(' { pos: vec3f, phase: f32, b: vec4f };', ' {')));
    assert.match(H1.particles, /struct Particle \{\s+pos: vec3f,[^}]*phase: f32,[^}]*b: vec4f,[^}]*\}/);
    assert.match(H1.particles, /struct Look \{\s+color: vec3f,[^}]*size: f32,[^}]*opacity: f32,[^}]*\}/);
    assert.ok(LOOK_STRUCT.startsWith('struct Look { color: vec3f, size: f32, opacity: f32 }'));
    assert.ok(H1.particles.includes('struct Sim {') && H1.sky.includes('struct Sim {'));
    const signatures = (wgsl, library) => {
        const found = new Map();
        for (const m of wgsl.matchAll(/^fn ([a-z][a-z0-9_]*)\(([^)]*)\)\s*->\s*([A-Za-z0-9<>]+)/gm)) {
            if (m[1].startsWith('wx_') || (!library && ['evolve', 'look', 'sky'].includes(m[1]))) continue;
            found.set(m[1], `(${m[2]}) -> ${m[3]}`.replace(/\s+/g, ' '));
        }
        return found;
    };
    const library = signatures(H1.helpers, true);
    for (const name of ['hash11', 'hash31', 'noise3', 'fbm3', 'curl3', 'palette', 'rot_axis', 'qmul', 'qrot', 'smin', 'sd_sphere', 'sd_box', 'sd_torus', 'ease_in', 'ease_out', 'ease_in_out']) {
        assert.ok(library.has(name), name);
    }
    assert.deepEqual(signatures(H1.particles, false), library);
    assert.deepEqual(signatures(H1.sky, false), library);
    assert.match(H1.rules, new RegExp(`At most ${DIAL.maxLines} lines`));
    assert.match(H1.rules, new RegExp(`literal bound of at most ${DIAL.maxLoopBound}`));
    assert.match(H1.rules, new RegExp(`product of their bounds is at most ${DIAL.maxNestedProduct}`));
    assert.match(H1.rules, new RegExp(`Arrays of at most ${DIAL.maxArray} elements`));
});

test('C17 every exemplar is exactly what the model must answer: the function alone, from its fn line', () => {
    for (const world of ['galaxy', 'storm']) {
        for (const fn of ['evolve', 'look', 'sky']) {
            const code = H1.exemplars[world][fn];
            assert.ok(code.startsWith(`fn ${fn}(`), `${world}.${fn}`);
            assert.ok(code.endsWith('}'), `${world}.${fn}`);
        }
    }
    const { draft: galaxy } = JSON.parse(H1.plans.galaxy) && { draft: JSON.parse(H1.plans.galaxy) };
    for (const name of galaxy.uniforms.map(u => u.name)) {
        assert.ok(H1.exemplars.galaxy.evolve.includes(`params.${name}`) || H1.exemplars.galaxy.look.includes(`params.${name}`), `galaxy reads params.${name}`);
    }
});

test('C18 a function sits between the markers at firstLine, the host declares what each stage needs, and lines map back', () => {
    const uniforms = { spin: { label: 'Spin', value: 1, min: 0, max: 3 }, glow: { label: 'Glow', value: 1, min: 0, max: 2 } };
    const body = H1.exemplars.galaxy.evolve;
    const m = assembleModule('evolve', body, uniforms);
    const lines = m.code.split('\n');
    assert.equal(lines[m.firstLine - 2], MODEL_START);
    assert.equal(lines[m.firstLine - 1], body.split('\n')[0]);
    assert.equal(lines[m.firstLine - 1 + m.lines], '');
    assert.equal(lines[m.firstLine + m.lines], HOST_START);
    assert.equal(m.lines, body.split('\n').length);
    assert.equal(functionLine(m, m.firstLine), 1);
    assert.equal(functionLine(m, m.firstLine + 10), 11);
    assert.equal(functionLine(m, m.firstLine - 1), 0);
    assert.equal(functionLine(m, m.firstLine + m.lines + 3), 0);
    assert.ok(m.code.includes('struct Params {\n    spin: f32,\n    glow: f32,\n};'));
    assert.ok(m.code.includes('@group(0) @binding(0) var<storage, read_write> particles: array<vec4f>;'));
    assert.ok(m.code.includes('@compute @workgroup_size(128) fn cs_main'));
    assert.ok(m.code.includes(H1.helpers));
    const look = assembleModule('look', H1.exemplars.galaxy.look, uniforms).code;
    assert.ok(look.includes('@group(1) @binding(1) var<uniform> sim: Sim;') && look.includes('@vertex fn vs_main') && look.includes('@fragment fn fs_main'));
    assert.ok(look.includes(PARTICLE_STRUCT) && look.includes(LOOK_STRUCT));
    const sky = assembleModule('sky', H1.exemplars.galaxy.sky, {}).code;
    assert.ok(sky.includes('struct Params {\n    _unused: f32,\n};'));
    assert.ok(sky.includes('camera.invViewProj') && !sky.includes(PARTICLE_STRUCT));
    // The helper library must not be a template literal's victim: no backtick anywhere in h1 (gotchas).
    for (const [name, text] of Object.entries(H1_FILES)) if (!name.endsWith('.md')) assert.ok(!text.includes('`'), name);
});
