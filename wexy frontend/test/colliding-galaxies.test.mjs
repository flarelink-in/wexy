// The collision starter is separate from the byte-pinned backend h1 exemplars.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadExample } from '../src/forge-client/example.ts';
import { lintTarget } from '../src/verify/gate.ts';
import { collidingGalaxies } from '../src/forge-client/examples/colliding-galaxies.ts';
import { parseDraft } from '../src/contract/draft.ts';

test('G1 collision prompts select two galaxies; ordinary galaxies keep the shared exemplar', async () => {
    for (const prompt of ['Two galaxies colliding', 'An Andromeda galaxy merger', 'Colliding galaxies']) {
        const spec = loadExample(prompt, 'auto');
        assert.equal(spec.title, 'Colliding Galaxies');
        assert.equal(spec.program.kind, 'functions');
        for (const target of ['evolve', 'look', 'sky']) {
            assert.deepEqual(lintTarget(spec, target).diagnostics, [], target);
        }
        assert.ok(spec.uniforms.encounter);
        assert.ok(spec.particles.count <= 524288);
    }
    const spiral = loadExample('A spiral galaxy', 'auto');
    assert.equal(spiral.title, 'Spiral Galaxy');
    assert.equal(spiral.program.kind, 'functions');
});

test('G2 collision plans round-trip, respect style and never mutate the pinned galaxy', () => {
    const a = collidingGalaxies('cinematic');
    const parsed = parseDraft(JSON.stringify(a.draft));
    assert.ok(parsed.draft);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.clamped, []);
    assert.equal(a.spec.style, 'cinematic');
    a.draft.uniforms[0].value = 99;
    assert.equal(collidingGalaxies().draft.uniforms[0].value, 0.65);
    const evolve = a.spec.program.evolve;
    assert.match(evolve, /next\.phase = phase/);
    assert.doesNotMatch(evolve, /next\.b\s*[.=]/, 'h1 ignores returned b; motion must not rely on it');
    assert.doesNotMatch(evolve, /sim\.time\s*\*\s*params\./, 'speed changes must not teleport the encounter');
});