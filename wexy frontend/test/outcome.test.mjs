// C-series, headless: the outcome report within the backend's caps (src/loop/outcome.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOutcome, compactLadder, completeOutcome } from '../src/loop/outcome.ts';

const gen = (id) => ({ generationId: id, source: 'live', model: 'm', role: null, fn: null, promptVersion: null, usage: null, ms: 1, ttftMs: null });
const report = (n = 7, detail = 'x'.repeat(100)) => ({
    rungs: Array.from({ length: n }, (_, i) => ({ rung: `L${i}`, ok: true, ms: 1.234, detail })),
    autofixes: {},
    probe: { stepMs: 1.5, frameMs: 2.5, predictedMs: 4, budgetMs: 100, measuredStepMs: 0.1, measuredFrameMs: 0.2 },
    totalMs: 12.345,
});

test('C21 the report carries the ids (at most 16), the ladder (at most 4 KB), the counts (at most 255) and the probe', () => {
    const generations = Array.from({ length: 20 }, (_, i) => gen(`g${i}`));
    const o = buildOutcome(generations, report(), { repairs: 300, autofixes: 2, firstPassOk: false });
    assert.equal(o.generationIds.length, 16);
    assert.equal(o.repairs, 255);
    assert.equal(o.autofixes, 2);
    assert.equal(o.firstPassOk, false);
    assert.deepEqual(o.ladder.probe, { step: 1.5, frame: 2.5, predicted: 4, budget: 100 });
    assert.equal(o.probeMs, 0.3);
    assert.equal(o.predictedMs, 4);
    assert.equal(o.fps, null);
    assert.ok(JSON.stringify(o.ladder).length <= 4096);
    // Details are the first thing dropped when the ladder would pass the cap.
    const big = compactLadder(report(40, 'y'.repeat(120)));
    assert.ok(JSON.stringify(big).length <= 4096);
    assert.equal(big.L0.detail, undefined);
    assert.equal(compactLadder(report(3)).L0.detail, 'x'.repeat(100));
});

test('C22 what the live world adds: fps rounded, labels capped at 64, unknown left null', () => {
    const o = completeOutcome(buildOutcome([gen('a')], report(), { repairs: 0, autofixes: 0, firstPassOk: true }), {
        fps: 59.94, adapter: 'nvidia turing ' + 'x'.repeat(80), browser: null,
    });
    assert.equal(o.fps, 59.9);
    assert.equal(o.adapter.length, 64);
    assert.equal(o.browser, null);
    assert.equal(completeOutcome(o, { fps: NaN, adapter: '', browser: 'Chrome 155' }).fps, null);
    assert.equal(completeOutcome(o, { fps: NaN, adapter: '', browser: 'Chrome 155' }).adapter, null);
});
