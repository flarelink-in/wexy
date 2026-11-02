// EA-F1b, headless (EA5.5): the export dialog films a source (capture/film.ts FilmSource), and h1's stays exactly what
// it was. null-graph/film is replaced by a recorder of the options each call is given; no GPU, no film made.
//   - h1's film and its measurement hand null-graph/film the options they always did: the spec's warm-up, the film's
//     shape and the provenance for the film; one frame, no file and no warm-up for the measurement;
//   - an agent world's source films from time zero (no warm-up), its workload made at the film's frame rate and view;
//   - a photo of any source is made opaque.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
    load(url, context, nextLoad) {
        if (url.endsWith('/null-graph/dist/film.js')) return {
            format: 'module', shortCircuit: true,
            source: [
                'export const recordFilm = async o => { globalThis.filmCalls.push(["recordFilm", o]); o.onReport?.({ guard: { calibration: { msPerFrame: 3.5 } } }); return { status: "completed" }; };',
                'export const snapshot = async o => { globalThis.filmCalls.push(["snapshot", o]); const rgba = new Uint8Array(o.width * o.height * 4).fill(255); rgba[3] = 128; rgba[7] = 0; return { rgba, png: new Uint8Array(0), width: o.width, height: o.height, limitations: [] }; };',
                'export const encodePNG = async () => new Uint8Array([137, 80, 78, 71]);',
                'export const fitAspect = v => v;',
                'export const cleanupFilms = async () => ({ removed: [] });',
                'export const listFilms = async () => [];',
                'export const removeFilm = async () => {};',
            ].join('\n'),
        };
        return nextLoad(url, context);
    },
});
globalThis.filmCalls = [];
const { measureExport, measureFilmOf, recordExport, recordFilmOf, sceneFilm, snapshotOf } = await import('../src/capture/film.ts');

const VIEW = { target: [0, 0, 0], distance: 12, azimuth: 0.6, polar: 1.2, fov: 45 };
const SPEC = { title: 'Spiral Galaxy', particles: { dt: 1 / 60, warmupSeconds: 2, seed: 7 }, camera: { keyframes: [{}, {}, {}] } };
const last = () => globalThis.filmCalls.at(-1);

test('EA-F1b h1\'s film and measurement hand null-graph/film what they always did; an agent world films from time zero; a photo is opaque', async () => {
    const device = {};
    const path = () => VIEW;
    const signal = new AbortController().signal;
    const onProgress = () => {};
    const onReport = () => {};
    const request = { device, settings: { width: 1280, height: 720, fps: 30, seconds: 6 }, path, still: VIEW, name: 'galaxy.mp4', signal, onProgress, onReport };

    // h1's film: its spec built again (filmWorkload), the spec's warm-up, the film's shape, the provenance.
    await recordExport({ ...request, spec: SPEC, live: null });
    let [call, o] = last();
    assert.equal(call, 'recordFilm');
    assert.deepEqual(Object.keys(o).sort(), ['camera', 'createWorkload', 'device', 'film', 'onProgress', 'onReport', 'output', 'partial', 'provenance', 'signal']);
    assert.equal(o.device, device);
    assert.equal(typeof o.createWorkload, 'function');
    assert.deepEqual(o.film, { width: 1280, height: 720, fps: 30, seconds: 6, warmupSeconds: 2 });
    assert.equal(o.camera, path);
    assert.deepEqual(o.output, { container: 'mp4', target: 'auto', name: 'galaxy.mp4' });
    assert.equal(o.partial, 'keep-if-finalizable');
    assert.deepEqual([o.signal, o.onProgress, o.onReport], [signal, onProgress, onReport]);
    assert.deepEqual(o.provenance, { scene: 'Spiral Galaxy', seed: 7, keyframes: 3 });

    // h1's measurement: one frame, no file, no warm-up, the view held.
    const measured = await measureExport(device, SPEC, null, { width: 1920, height: 1080, fps: 60 }, VIEW);
    [call, o] = last();
    assert.deepEqual(measured.msPerFrame, 3.5);
    assert.deepEqual(Object.keys(o).sort(), ['camera', 'createWorkload', 'device', 'film', 'onReport', 'output', 'signal']);
    assert.deepEqual(o.film, { width: 1920, height: 1080, fps: 60, seconds: 1 / 60 });
    assert.equal(o.output, false);
    assert.equal(o.camera(3), VIEW);

    // An agent world's source: its workload made at the film's rate and view, from time zero, its own provenance.
    const made = [];
    const workload = async () => ({});
    const agent = { workload: (fps, still) => { made.push([fps, still]); return workload; }, warmupSeconds: 0, provenance: { candidate: 'c0ffee', graph: 'x1' } };
    await recordFilmOf(agent, request);
    [, o] = last();
    assert.equal(o.createWorkload, workload);
    assert.deepEqual(made, [[30, VIEW]]);
    assert.deepEqual(o.film, { width: 1280, height: 720, fps: 30, seconds: 6, warmupSeconds: 0 });
    assert.deepEqual(o.provenance, { candidate: 'c0ffee', graph: 'x1' });
    await measureFilmOf(agent, device, { width: 1280, height: 720, fps: 60 }, VIEW);
    assert.deepEqual(made.at(-1), [60, VIEW], 'its measurement at the dialog\'s rate and view');
    assert.deepEqual(sceneFilm(SPEC, null).provenance, { scene: 'Spiral Galaxy', seed: 7, keyframes: 3 });

    // A photo of any source, made opaque; the snapshot at the time asked (an agent world's: zero).
    const shot = await snapshotOf(device, workload, 4, 2, VIEW);
    [call, o] = last();
    assert.equal(call, 'snapshot');
    assert.deepEqual({ ...o, createWorkload: o.createWorkload === workload }, { device, width: 4, height: 2, seconds: 0, view: VIEW, createWorkload: true });
    assert.equal(shot.translucent, 2);
    assert.ok(shot.rgba.every((v, i) => i % 4 !== 3 || v === 255), 'every alpha 255');
    assert.equal(shot.png.type, 'image/png');
});
