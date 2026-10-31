// Lifecycle regressions: no browser or GPU work; viewport and dialog collaborators are fakes.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Viewport } from '../src/runtime/viewport.ts';

registerHooks({
    load(url, context, nextLoad) {
        if (url.endsWith('/src/capture/film.ts')) return {
            format: 'module', shortCircuit: true,
            source: 'export const measureExport = (...args) => globalThis.reviewMeasure(...args); export const codecLabel = () => ""; export const holdFilm = () => () => {}; export const recordExport = () => {};',
        };
        return nextLoad(url, context);
    },
});
const { ExportDialog } = await import('../src/shell/studio/export-dialog.ts');

function viewport() {
    const vp = Object.create(Viewport.prototype);
    Object.assign(vp, { raf: 0, pauses: 0, lastNow: 0, rung: 0, failedRung: -1,
        window: [], stats: {}, sizeDirty: false, pinnedRung: null });
    return vp;
}

test('UI1 a pause preserves stopped state and nested releases restart only once', () => {
    let scheduled = 0;
    globalThis.requestAnimationFrame = () => ++scheduled;
    globalThis.cancelAnimationFrame = () => {};
    const vp = viewport();
    vp.pause()();
    assert.equal(scheduled, 0, 'a stopped viewport must stay stopped');
    vp.start();
    const first = vp.pause(), second = vp.pause();
    vp.start();
    assert.equal(scheduled, 1, 'start must not bypass an active pause');
    first();
    assert.equal(scheduled, 1);
    second(); second();
    assert.equal(scheduled, 2);
    const release = vp.pause();
    vp.stop();
    release();
    assert.equal(scheduled, 2, 'explicit stop during pause must win');
});

test('UI2 preview presets retain their resolution on worlds without a quality uniform', () => {
    const vp = viewport();
    vp.ladder = [1, 0.85, 0.7, 0.6, 0.5].map(scale => ({ scale, quality: 1 }));
    vp.pin(3);
    assert.equal(vp.stats.scale, 0.85, 'Balanced means 85%, not 60%');
    vp.pin(6);
    assert.equal(vp.stats.scale, 0.5);
    vp.pin(0);
    assert.equal(vp.stats.scale, 1);
    vp.pin(null);
    assert.equal(vp.pinnedRung, null);
});

test('UI3 a reopened export measures the new world and ignores the old result', async () => {
    const dialog = Object.create(ExportDialog.prototype);
    const calls = [];
    let finish;
    globalThis.reviewMeasure = async (_device, spec) => {
        calls.push(spec);
        if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
        return { msPerFrame: spec === 'old' ? 90 : 4 };
    };
    const ctx = spec => ({ spec, runtime: {}, viewport: { engine: { device: {} }, pause: () => () => {} }, pathFor: () => () => ({}) });
    Object.assign(dialog, { ctx: ctx('old'), el: { open: true }, settings: { width: 1280, height: 720, fps: 60, seconds: 6 },
        calibrating: false, measureQueued: false, renderSetup() {} });
    const pending = dialog.measure();
    dialog.ctx = ctx('new');
    await dialog.measure();
    finish();
    await pending;
    assert.deepEqual(calls, ['old', 'new']);
    assert.equal(dialog.msPerFrame, 4);
});

test('UI4 closing export while measuring discards late results without rebuilding the dialog', async () => {
    const dialog = Object.create(ExportDialog.prototype);
    let finish, resumes = 0, renders = 0;
    globalThis.reviewMeasure = () => new Promise(resolve => { finish = resolve; });
    Object.assign(dialog, { ctx: { spec: {}, runtime: {}, viewport: { engine: { device: {} },
        pause: () => () => { resumes++; } }, pathFor: () => () => ({}) },
        el: { open: true }, settings: { width: 1280, height: 720, fps: 60, seconds: 6 },
        calibrating: false, measureQueued: false, renderSetup() { renders++; } });
    const pending = dialog.measure();
    dialog.el.open = false;
    dialog.ctx = null;
    dialog.measureQueued = false;
    finish({ msPerFrame: 99 });
    await pending;
    assert.equal(dialog.msPerFrame, null);
    assert.equal(renders, 1);
    assert.equal(resumes, 1);
    assert.equal(dialog.calibrating, false);
});