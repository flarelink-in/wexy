// EA9.6: h1 can replay examples, but no shipped page can dispatch its retired model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { selectCreationPath } from '../src/shell/studio/creation-path.ts';
import { loadExample } from '../src/forge-client/example.ts';
import { lintTarget } from '../src/verify/gate.ts';

const root = new URL('../', import.meta.url);
const sentences = { unavailable: 'No gateway', invalid: 'Unknown selector' };

test('EA9.6: retained examples are complete specs, independently loaded without a model client', () => {
    for (const prompt of ['A spiral galaxy', 'A thunderstorm', 'Two galaxies colliding', 'A black hole']) {
        const spec = loadExample(prompt, 'auto');
        const targets = spec.program.kind === 'functions'
            ? ['evolve', 'look', ...(spec.sky === 'function' ? ['sky'] : [])]
            : ['evolve', 'particles', ...(spec.program.backdrop ? ['backdrop'] : [])];
        for (const target of targets) assert.deepEqual(lintTarget(spec, target).diagnostics, [], prompt + ': ' + target);
        const title = spec.title;
        spec.title = 'Changed locally';
        assert.equal(loadExample(prompt, 'auto').title, title);
    }
});

test('EA9.6: legacy URLs cannot select h1 or autorun a retired path', () => {
    const path = selectCreationPath(new URLSearchParams('legacy=1&autorun'), { switched: true, gateway: true }, sentences);
    assert.equal(path.create, 'agent');
    assert.equal(path.autorun, false);
    assert.equal(path.invalid, sentences.invalid);
});

test('EA9.6: the live h1 client is deleted, and the studio uses a no-model example loader', () => {
    assert.equal(existsSync(new URL('src/forge-client/live-client.ts', root)), false);
    const studio = readFileSync(new URL('src/shell/studio/main.ts', root), 'utf8');
    assert.doesNotMatch(studio, /runLoop|createLiveClient|MockClient|completeOutcome/);
    assert.match(studio, /loadExample/);
});

test('EA9.6: no h1 POST route remains in the service or gateway', () => {
    const backend = new URL('../wexy backend/', root);
    for (const relative of [
        'forge-service/src/main/java/ai/wexy/forge/loop/LoopRouter.java',
        'forge-gateway/src/main/java/ai/wexy/gateway/routes/ForgeRoutes.java',
    ]) {
        const text = readFileSync(new URL(relative, backend), 'utf8');
        assert.doesNotMatch(text, /\.POST\("\/v1\/forge\/(?:plan|author|repair|direct|outcomes)"|\.route\("forge-(?:plan|author|repair|direct|outcomes)"/);
    }
});