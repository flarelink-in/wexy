// Lifecycle regressions: no browser or GPU work; viewport and dialog collaborators are fakes.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Viewport } from '../src/runtime/viewport.ts';

registerHooks({
    load(url, context, nextLoad) {
        if (url.endsWith('/src/capture/film.ts')) return {
            format: 'module', shortCircuit: true,
            source: 'export const measureFilmOf = (film, device, ...rest) => globalThis.reviewMeasure(device, film, ...rest); export const codecLabel = () => ""; export const holdFilm = () => () => {}; export const recordFilmOf = () => {};',
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
    globalThis.reviewMeasure = async (_device, film) => {
        calls.push(film);
        if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
        return { msPerFrame: film === 'old' ? 90 : 4 };
    };
    const ctx = film => ({ film, viewport: { engine: { device: {} }, pause: () => () => {} }, pathFor: () => () => ({}) });
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
    Object.assign(dialog, { ctx: { film: {}, viewport: { engine: { device: {} },
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

test('UI7 EA5.5: an agent world\'s film refused at a size says so in the studio\'s words, its reason in Developer view', async () => {
    const dialog = Object.create(ExportDialog.prototype);
    const reason = 'EA_FILM 0123456789ab… at 3840x2160: EA_ELIGIBILITY ng.render.fullscreen@1 (node backdrop): pixels 8294400 over 2359296';
    globalThis.reviewMeasure = async () => { throw new Error(reason); };
    Object.assign(dialog, { ctx: { film: 'an agent world', viewport: { engine: { device: {} }, pause: () => () => {} }, pathFor: () => () => ({}) }, el: { open: true },
        settings: { width: 3840, height: 2160, fps: 60, seconds: 6 }, calibrating: false, measureQueued: false, renderSetup() {} });
    await dialog.measure();
    assert.deepEqual(dialog.refusal, { plain: 'This world could not be filmed at this size; it is still on the stage.', detail: reason });
    assert.equal(dialog.msPerFrame, null);
    // The runner's own refusals keep their words.
    globalThis.reviewMeasure = async () => { throw new Error('film: a draw at 3840×2160 took 1,200 ms, over the 1,000 ms per-submission limit'); };
    await dialog.measure();
    assert.equal(dialog.refusal.plain, 'This quality is too heavy for this graphics card. Pick a lower quality.');
});

test('UI5 EA5.0: the stage runs any WorldRuntime by its own dt; a swap that throws before it switches leaves the Head as it was', () => {
    globalThis.requestAnimationFrame = () => 1;
    const vp = viewport();
    const drawn = [];
    Object.assign(vp, {
        ladder: [], accumulator: 0, exporting: false, intervals: [], settleUntil: 0, frameAspect: null, mode: 'orbit', playing: false, simPaused: false,
        fov: 45, orbit: { target: [0, 0, 0], distance: 10, azimuthAngle: 0, polarAngle: 1 }, canvas: { width: 64, height: 36 },
        engine: { render: sequence => drawn.push(sequence) },
    });
    // A world with no spec at all, only the interface: stepped by its own dt, 1/120.
    const steps = [];
    const world = {
        dt: 1 / 120, simTime: 0, qualityFloor: null, quality: 1,
        step() { steps.push(this.simTime); this.simTime += this.dt; }, view() {}, draw: () => ['frame'], resize() {}, destroy() {},
    };
    vp.setRuntime(world);
    assert.equal(vp.runtime, world);
    vp.sizeDirty = false;
    vp.frame(1000);
    vp.frame(1030);
    assert.equal(steps.length, 5, 'the first frame (1/60 s) two 1/120 steps, the next (30 ms) three, by its own dt');
    assert.deepEqual(drawn, [['frame'], ['frame']]);

    // A world whose quality dial throws: the swap stops before it switches, and nothing of the stage changes.
    const head = { ladder: vp.ladder, rung: vp.rung, stats: { ...vp.stats } };
    vp.accumulator = 0.004;
    const refusing = { ...world, qualityFloor: 0.4, get quality() { return 1; }, set quality(q) { throw new Error(`no dial at ${q}`); } };
    assert.throws(() => vp.setRuntime(refusing), /no dial at 1/);
    assert.deepEqual([vp.runtime, vp.ladder, vp.rung, vp.stats, vp.accumulator], [world, head.ladder, head.rung, head.stats, 0.004]);
    // One with a dial: set before the switch, from the ladder its floor makes.
    const dialled = { ...world, qualityFloor: 0.4, quality: 0 };
    vp.setRuntime(dialled);
    assert.deepEqual([vp.runtime, dialled.quality, vp.stats.quality, vp.accumulator], [dialled, 1, 1, 0]);
});

test('UI6 the EA5 review (H1): two worlds on one engine; the old one destroyed, the new one keeps its passes, batches and stage, and draws', async () => {
    const { NullGraph } = await import('null-graph');
    const { SceneRuntime } = await import('../src/runtime/scene-runtime.ts');
    const engine = new NullGraph();
    // CPU only, as EA-X13: no init and no device; the managers stubbed, the engine's own bookkeeping under test.
    const freed = [];
    engine.batchManager = {
        createComputeStage: config => ({ name: config.name }),
        createBatch: (pass, config) => ({ label: config.label, storageBuffer: { label: config.label } }),
        clearBatch: (pass, batch) => { freed.push(batch.label); },
    };
    const rendered = [];
    engine.renderPipeline = { render: sequence => { rendered.push(sequence); } };
    // A world as SceneRuntime holds one: its pass, its batch, its stage, a post chain of one pass and one batch (whose
    // destroy releases both, as null-graph 1.2.1's does), and its two buffers.
    const world = name => {
        const pass = engine.createPass({ name: `${name}/scene`, isMainScreenPass: false });
        const particles = engine.createBatch(pass, { label: `${name}/particles` });
        const chainPass = engine.createPass({ name: `${name}/post`, isMainScreenPass: false });
        const chainBatch = engine.createBatch(chainPass, { label: `${name}/post` });
        const evolve = engine.createComputeStage({ name: `${name}/evolve`, shaderCode: '', dispatchCount: [1, 1, 1] });
        const destroyed = [];
        const rt = Object.assign(Object.create(SceneRuntime.prototype), {
            engine, pass, batches: [particles], evolve, evolveSequence: [evolve], drawSequence: [pass, chainPass], destroyed: false, paramsDirty: false,
            post: { chain: { upload() {}, destroy() { engine.clearBatch(chainPass, chainBatch); engine.removePass(chainPass); } } },
            simBuffer: { destroy: () => destroyed.push('sim') }, paramsBuffer: { destroy: () => destroyed.push('params') },
        });
        return { rt, pass, chainPass, particles, chainBatch, evolve, destroyed };
    };
    const old = world('h1');
    const installed = world('agent');
    // The studio installs the new world, then destroys the old one (main.ts): the old one's own goes, and nothing else.
    old.rt.destroy();
    assert.deepEqual(engine.passes, [installed.pass, installed.chainPass], 'only the old world\'s passes are forgotten');
    assert.deepEqual(engine.batches, [installed.particles, installed.chainBatch], 'only its batches');
    assert.deepEqual(engine.computeStages, [installed.evolve], 'and its stage, which is removed now');
    assert.deepEqual(freed.sort(), ['h1/particles', 'h1/post']);
    assert.deepEqual([old.destroyed, installed.destroyed], [['sim', 'params'], []]);
    // The installed world still draws, by its own sequence and by the engine's list.
    engine.render(installed.rt.draw());
    engine.render();
    assert.deepEqual(rendered, [[installed.pass, installed.chainPass], [installed.pass, installed.chainPass]]);
    // A second destroy does nothing; once the installed world goes too, the engine holds nothing of either.
    old.rt.destroy();
    installed.rt.destroy();
    assert.deepEqual([engine.passes, engine.batches, engine.computeStages], [[], [], []]);
});
