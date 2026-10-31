// C-series, headless: SceneSpec 2.0 and rung L0, the draft parser (src/contract/draft.ts, spec.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAFT_LIMITS, parseDraft, specFromDraft } from '../src/contract/draft.ts';
import { H1 } from '../src/contract/h1/index.ts';
import { functionsOf, targetsOf, withProgramText } from '../src/contract/spec.ts';

const galaxy = () => JSON.parse(H1.plans.galaxy);

test('C1 the two recorded plans parse as drafts with nothing clamped, and become specs with the controls in order', () => {
    for (const world of ['galaxy', 'storm']) {
        const { draft, problems, clamped } = parseDraft(H1.plans[world]);
        assert.deepEqual(problems, [], world);
        assert.deepEqual(clamped, [], world);
        assert.ok(draft);
        const spec = specFromDraft(draft, { kind: 'functions', evolve: 'e', look: 'l', sky: 's' });
        assert.equal(spec.version, '2.0');
        assert.equal(spec.host, 'h1');
        assert.deepEqual(Object.keys(spec.uniforms), draft.uniforms.map(u => u.name));
        assert.equal(spec.camera.move, draft.camera.move);
        assert.equal(spec.post.halation === undefined, draft.post.halation === null);
        assert.equal(spec.post.fxaa, true);
        assert.equal(spec.particles.spawn.x.use, draft.particles.spawn.x.use);
    }
    const { draft } = parseDraft(galaxy());
    assert.equal(draft.title, 'Spiral Galaxy');
    assert.equal(draft.uniforms[0].name, 'spin');
});

test('C2 ranges are clamped and listed; the draft still parses', () => {
    const d = galaxy();
    d.particles.count = 1000;
    d.particles.dt = 1;
    d.uniforms[0].value = 99;
    d.uniforms[1].step = 0;
    d.camera.keyframes[0].polar = 0;
    d.post.bloom.intensity = 9;
    const { draft, problems, clamped } = parseDraft(d);
    assert.deepEqual(problems, []);
    assert.ok(draft);
    assert.equal(draft.particles.count, DRAFT_LIMITS.count[0]);
    assert.equal(draft.particles.dt, 1 / 60); // 1 clamped to 0.05, then snapped to one step a frame (C23)
    assert.equal(draft.uniforms[0].value, draft.uniforms[0].max);
    assert.equal(draft.uniforms[1].step, (draft.uniforms[1].max - draft.uniforms[1].min) / 100);
    assert.equal(draft.camera.keyframes[0].polar, 1);
    assert.equal(draft.post.bloom.intensity, 3);
    assert.equal(clamped.length, 7);
    assert.match(clamped[0], /^\$\.particles\.count: 1000 clamped to 65536/);
    assert.match(clamped[2], /^\$\.particles\.dt: 0\.05 snapped to 0\.0166667/);
});

test('C3 what cannot be clamped is refused, with its path: names, ranges, shapes, nulls, counts', () => {
    const refuse = (mutate, pattern) => {
        const d = galaxy();
        mutate(d);
        const { draft, problems } = parseDraft(d);
        assert.equal(draft, null, pattern);
        assert.ok(problems.some(p => pattern.test(p)), `${pattern} in ${problems.join(' | ')}`);
    };
    refuse(d => { d.uniforms[0].name = 'type'; }, /\$\.uniforms\[0\]\.name: "type" is reserved/);
    refuse(d => { d.uniforms[0].name = 'quality'; }, /is reserved/);
    refuse(d => { d.uniforms[0].name = 'Spin'; }, /not a camelCase WGSL field name/);
    refuse(d => { d.uniforms[1].name = 'spin'; }, /"spin" is used twice/);
    refuse(d => { d.uniforms[0].min = 3; d.uniforms[0].max = 0; }, /min 3 is not below max 0/);
    refuse(d => { delete d.post.fxaa; }, /\$\.post\.fxaa: expected true or false/);
    refuse(d => { d.arrangement = {}; }, /\$\.arrangement: must be null in v1/);
    refuse(d => { d.camera.keyframes = []; }, /\$\.camera\.keyframes: 0 items; expected 1 to 6/);
    refuse(d => { d.uniforms = Array(9).fill(d.uniforms[0]).map((u, i) => ({ ...u, name: `u${i}` })); }, /9 items; expected 1 to 8/);
    refuse(d => { d.style = 'noir'; }, /\$\.style: expected one of/);
    refuse(d => { d.particles.spawn.w.dist = 'gaussian'; }, /spawn\.w\.dist/);
    refuse(d => { d.title = ''; }, /\$\.title: expected a non-empty string/);
    refuse(d => { delete d.post.halation; }, /\$\.post\.halation: missing/);
    assert.equal(parseDraft('{not json').draft, null);
    assert.match(parseDraft('{not json').problems[0], /^not JSON/);
    assert.equal(parseDraft([1, 2]).draft, null);
});

test('C4 the spec helpers: which functions a world needs, its targets, and copies that leave the original alone', () => {
    const { draft } = parseDraft(galaxy());
    const black = specFromDraft({ ...draft, sky: 'black' }, { kind: 'functions', evolve: 'e', look: 'l' });
    assert.deepEqual(functionsOf(black), ['evolve', 'look']);
    assert.deepEqual(targetsOf(black), ['evolve', 'look']);
    const painted = specFromDraft(draft, { kind: 'functions', evolve: 'e', look: 'l', sky: 's' });
    assert.deepEqual(targetsOf(painted), ['evolve', 'look', 'sky']);
    const changed = withProgramText(painted, 'look', 'L2');
    assert.equal(changed.program.look, 'L2');
    assert.equal(painted.program.look, 'l');
    assert.notEqual(changed.program, painted.program);
    const hooks = { ...painted, program: { kind: 'hooks', evolve: 'a', particles: 'b', backdrop: 'c' } };
    assert.deepEqual(targetsOf(hooks), ['evolve', 'backdrop', 'particles']);
    assert.deepEqual(targetsOf({ ...hooks, program: { kind: 'hooks', evolve: 'a', particles: 'b' } }), ['evolve', 'particles']);
});

test('C23 dt is snapped to a whole number of steps a frame at 60 fps, or the film would refuse the world at Record', () => {
    const at = dt => { const d = galaxy(); d.particles.dt = dt; return parseDraft(d); };
    // The planner writes 0.0166667, which is not 1/60 (null-graph/film: "not a whole number of steps"): snapped silently.
    const planner = at(0.0166667);
    assert.equal(planner.draft.particles.dt, 1 / 60);
    assert.deepEqual(planner.clamped, []);
    assert.equal(1 * planner.draft.particles.dt - 1 / 60, 0);
    // A step coarser than a frame cannot be filmed: one step a frame, and listed.
    const coarse = at(0.02);
    assert.equal(coarse.draft.particles.dt, 1 / 60);
    assert.match(coarse.clamped[0], /^\$\.particles\.dt: 0\.02 snapped to 0\.0166667 \(1 step a frame at 60 fps\)/);
    // Finer steps snap to 2, 3 or 4 a frame, each dividing the frame exactly in double arithmetic.
    assert.equal(at(0.0083).draft.particles.dt, 1 / 120);
    assert.equal(at(0.0056).draft.particles.dt, 1 / 180);
    assert.equal(at(0.004).draft.particles.dt, 1 / 240);
    assert.match(at(0.004).clamped[0], /4 steps a frame/);
    for (const k of [1, 2, 3, 4]) assert.equal(k * ((1 / 60) / k) - 1 / 60, 0, `${k} steps a frame are exact`);
});
