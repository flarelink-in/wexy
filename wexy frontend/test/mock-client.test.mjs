// L-series, headless: the mock ForgeClient (src/forge-client/mock-client.ts) answers with the host's exemplar worlds
// and the playground's examples, labelled mock, with no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H1 } from '../src/contract/h1/index.ts';
import { MockClient } from '../src/forge-client/mock-client.ts';

const signal = () => new AbortController().signal;

test('L14 a galaxy idea gets the recorded galaxy plan, the exemplar functions, and a repair that is the exemplar', async () => {
    const client = new MockClient({ pace: 0, fault: true });
    const plan = await client.plan({ prompt: 'a spiral galaxy, gold at the core', style: 'auto', seconds: 12 }, {}, signal());
    assert.equal(plan.draft.title, 'Spiral Galaxy');
    assert.equal(plan.generation.source, 'mock');
    assert.equal(plan.generation.model, null);
    assert.equal(plan.ready, undefined);
    const evolve = await client.author('evolve', plan.generation.generationId, {}, signal());
    assert.equal(evolve.text, H1.faults['galaxy.evolve'], 'the fault option serves the broken evolve');
    const look = await client.author('look', plan.generation.generationId, {}, signal());
    assert.equal(look.text, H1.exemplars.galaxy.look);
    const repaired = await client.repair('evolve', evolve.generation.generationId, [], {}, signal());
    assert.equal(repaired.text, H1.exemplars.galaxy.evolve);
    assert.notEqual(repaired.generation.generationId, evolve.generation.generationId);
    await assert.rejects(client.author('sky', 'mock-999', {}, signal()), /holds no plan/);
    const storm = await new MockClient({ pace: 0 }).plan({ prompt: 'a thunderstorm', style: 'cinematic', seconds: 6 }, {}, signal());
    assert.equal(storm.draft.title, 'Thunderhead');
    assert.equal(storm.draft.style, 'cinematic');
});

test('L15 a playground idea comes back whole: the draft for the panel and the ready spec with its hooks', async () => {
    const client = new MockClient({ pace: 0 });
    const texts = [];
    const plan = await client.plan({ prompt: 'a kerr black hole with jets', style: 'brutalist', seconds: 12 }, { onText: t => texts.push(t) }, signal());
    assert.equal(plan.draft.title, 'Kerr Black Hole: Relativistic Accretion');
    assert.equal(plan.draft.uniforms[0].name, 'spin');
    assert.ok(plan.ready);
    assert.equal(plan.ready.program.kind, 'hooks');
    assert.equal(plan.ready.style, 'brutalist');
    assert.equal(plan.ready.post.tonemap.curve, 'agx');
    assert.equal(plan.ready.version, '2.0');
    assert.equal(texts.length, 1);
    const direct = await client.direct(plan.ready, 'more glow', signal());
    assert.equal(direct.edit.kind, 'patch');
    await client.report({ generationIds: [], ladder: {}, firstPassOk: true, repairs: 0, autofixes: 0, probeMs: null, predictedMs: null, fps: null, adapter: null, browser: null });
});
