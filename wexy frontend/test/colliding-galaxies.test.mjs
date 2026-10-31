// The collision starter is separate from the byte-pinned backend h1 exemplars.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockClient } from '../src/forge-client/mock-client.ts';
import { lintTarget } from '../src/verify/gate.ts';
import { collidingGalaxies } from '../src/forge-client/examples/colliding-galaxies.ts';
import { parseDraft } from '../src/contract/draft.ts';

test('G1 collision prompts select two galaxies; ordinary galaxies keep the shared exemplar', async () => {
    const client = new MockClient({ pace: 0 });
    const signal = new AbortController().signal;
    for (const prompt of ['Two galaxies colliding', 'An Andromeda galaxy merger', 'Colliding galaxies']) {
        const plan = await client.plan({ prompt, style: 'auto', seconds: 12 }, {}, signal);
        assert.equal(plan.draft.title, 'Colliding Galaxies');
        assert.equal(plan.generation.source, 'mock');
        assert.equal(plan.ready.program.kind, 'functions');
        for (const target of ['evolve', 'look', 'sky']) {
            assert.deepEqual(lintTarget(plan.ready, target).diagnostics, [], target);
        }
        assert.ok(plan.ready.uniforms.encounter);
        assert.ok(plan.ready.particles.count <= 524288);
    }
    const spiral = await client.plan({ prompt: 'A spiral galaxy', style: 'auto', seconds: 12 }, {}, signal);
    assert.equal(spiral.draft.title, 'Spiral Galaxy');
    assert.equal(spiral.ready, undefined);
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