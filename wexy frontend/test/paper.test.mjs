// EA paper test, headless: the checks dev/paper-check.mjs runs on the backend's paper report (the engine-aware
// design §13). A plan with real names passes; each way a plan can name what null-graph lacks, or break a layout
// it states, is caught; the report is read from its JSON or from the host's log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAnswer, declaresMember, moduleNames, nameCount, parseAction, readReport, REPORT_BEGIN, REPORT_END } from '../dev/paper-lib.mjs';
import { inspectSymbol } from '../src/contract/engine/index.ts';

/** A small plan that names only what null-graph 1.2.1 exports. */
const plan = () => ({
    kind: 'propose_design_and_program', context: null, modules: null, revision: null, question: null, finish: null,
    design: {
        intent: 'Blocks under a sepia film.', interpretation: null, assumptions: [], visualElements: [{ name: 'terrain', description: 'cubes' }],
        motion: 'a slow pan', resourceFlow: [], cameraAndTiming: 'a slow orbit', controls: [], successCriteria: ['blocks stay readable'], unresolved: [],
        techniques: [{ purpose: 'draw the blocks', symbols: ['core:NullGraph', 'materials:LambertMaterial', 'geometry:Primitives'], docIds: ['api/core'] },
            { purpose: 'age the film', symbols: ['post:PostChain', 'post:FilmGrain', 'post:Vignette'], docIds: ['api/post'] }],
    },
    program: {
        objects: [
            { id: 'pass', symbol: 'core:NullGraph', member: 'createPass', purpose: 'the scene pass', config: '{}', inputs: [] },
            { id: 'material', symbol: 'materials:LambertMaterial', member: null, purpose: 'lit blocks', config: '{}', inputs: [] },
            { id: 'batch', symbol: 'core:NullGraph', member: 'createBatch', purpose: 'the blocks', config: '{}', inputs: ['pass', 'material', 'instances'] },
            { id: 'film', symbol: 'post:PostChain', member: null, purpose: 'the aged look', config: '{}', inputs: ['pass'] },
        ],
        resources: [{ id: 'instances', kind: 'storage_buffer', purpose: 'blocks', layout: '14 floats', strideFloats: 14, count: 4096 }],
        modules: [{ id: 'scratch', stage: 'post_effect', usedBy: 'film', entry: 'effect', signature: 'fn effect(uv: vec2f) -> vec4f', bindings: [], purpose: 'scratches' }],
        schedule: [{ id: 'draw', kind: 'render', objectId: 'pass', when: 'frame', required: true, reads: ['instances'], writes: [] }],
        lifecycle: { init: [], fixedStep: [], frame: [], resize: [], dispose: [] }, output: { color: 'film', colorSpace: 'srgb', depth: true }, controls: [],
    },
});
const codes = findings => findings.map(f => `${f.level} ${f.code}`);

test('EA-P1 a plan that names only real exports, members and layouts passes, with no warning', () => {
    assert.deepEqual(checkAnswer(plan()), []);
    assert.deepEqual(nameCount(plan()), { total: 10, distinct: 6 });
    assert.ok(declaresMember(inspectSymbol('core:NullGraph'), 'createComputeStage'));
    assert.ok(!declaresMember(inspectSymbol('core:NullGraph'), 'createMeshBatch'));
});

test('EA-P2 an invented name, a name in the wrong family, a bare name and a missing member each fail, with the reason', () => {
    const p = plan();
    p.design.techniques[0].symbols.push('materials:Materials', 'core:PostChain', 'LambertMaterial', 'shapes:Cube');
    p.program.objects.push({ id: 'mesh', symbol: 'core:NullGraph', member: 'createMeshBatch', purpose: 'x', config: '{}', inputs: [] });
    const messages = checkAnswer(p).map(f => f.message).join(' | ');
    assert.match(messages, /materials:Materials is not an export of null-graph 1\.2\.1/);
    assert.match(messages, /core:PostChain is not an export .*\(PostChain is in post, not core\)/);
    assert.match(messages, /LambertMaterial is not an export .*\(write it as materials:LambertMaterial\)/);
    assert.match(messages, /shapes:Cube is not an export .*\(null-graph has no family shapes\)/);
    assert.match(messages, /core:NullGraph declares no member createMeshBatch/);
    assert.deepEqual(codes(checkAnswer(p)).filter(c => c.startsWith('fail')), ['fail name', 'fail name', 'fail name', 'fail name', 'fail member']);
});

test('EA-P3 a host family warns, a family Wexy cannot run fails', () => {
    const p = plan();
    p.program.objects.push({ id: 'fly', symbol: 'cameras:FlyCameraState', member: null, purpose: 'x', config: '{}', inputs: [] });
    p.program.objects.push({ id: 'anim', symbol: 'loaders:Animator', member: null, purpose: 'x', config: '{}', inputs: [] });
    assert.deepEqual(codes(checkAnswer(p)), ['warn host', 'fail external']);
});

test('EA-P4 a WGSL reserved word as an entry or a parameter fails; the syntax and the types do not', () => {
    assert.deepEqual(moduleNames('main', '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u)'), ['main', 'gid']);
    const p = plan();
    p.program.modules.push({ id: 'drift', stage: 'compute', usedBy: 'batch', entry: 'move', signature: 'fn move(target: vec3f) -> vec3f', bindings: [{ group: 0, binding: 0, resource: 'instances' }], purpose: 'x' });
    const reserved = checkAnswer(p).filter(f => f.code === 'reserved').map(f => f.message);
    assert.deepEqual(reserved, ['module drift: move is a reserved word in WGSL', 'module drift: target is a reserved word in WGSL']);
});

test('EA-P5 bind groups: past the fourth fails; a compute stage off group 0, or a batch binding in an engine group, warns', () => {
    const p = plan();
    p.program.modules.push({ id: 'k', stage: 'compute', usedBy: 'batch', entry: 'step', signature: 'fn step()', bindings: [{ group: 1, binding: 0, resource: 'state' }], purpose: 'x' });
    p.program.modules.push({ id: 'f', stage: 'fragment', usedBy: 'batch', entry: 'shade', signature: 'fn shade()', bindings: [{ group: 2, binding: 0, resource: 'noise' }, { group: 2, binding: 1, resource: 'lights' }, { group: 5, binding: 0, resource: 'x' }], purpose: 'x' });
    assert.deepEqual(codes(checkAnswer(p)), ['warn group', 'warn group', 'fail group']);
});

test('EA-P6 an instance buffer feeding a stock material: 24 floats fails, none given warns, 14 passes', () => {
    const p = plan();
    p.program.resources[0].strideFloats = 24;
    assert.match(checkAnswer(p).map(f => f.message).join(), /is 24 floats a stride; the stock materials read 14 \(24 is the visibility family's layout\)/);
    p.program.resources[0].strideFloats = null;
    assert.deepEqual(codes(checkAnswer(p)), ['warn stride']);
});

test('EA-P7 ids that point nowhere, an unknown document and another kind warn', () => {
    const p = plan();
    p.kind = 'need_context';
    p.program.objects[2].inputs.push('ghost');
    p.design.techniques[0].docIds.push('api/nope');
    assert.deepEqual(codes(checkAnswer(p)), ['warn kind', 'warn doc', 'warn id']);
});

test('EA-P8 the report is read from its JSON or from the host log between its markers; a cut log is refused; fenced JSON parses', () => {
    const report = { bundle: { bundleHash: 'x' }, answers: [] };
    assert.deepEqual(readReport(JSON.stringify(report)), report);
    assert.deepEqual(readReport(`INFO starting\n${REPORT_BEGIN}\n${JSON.stringify(report, null, 2)}\n${REPORT_END}\nINFO stopped\n`), report);
    assert.throws(() => readReport(`${REPORT_BEGIN}\n{"bundle":`), /cut short/);
    assert.deepEqual(parseAction('```json\n{"kind":"ask"}\n```'), { kind: 'ask' });
    assert.equal(parseAction('Here is the plan: {}'), null);
});
