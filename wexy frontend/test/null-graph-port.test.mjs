// EA-D1b, D1c and D14b, headless (EA5.2, EA5.3): what of the null-graph port runs on the CPU. Every post effect the adapter offers is one the
// port makes, and its `intensity` multiplies the effect's own default strength, read back through null-graph's own
// accessors (never the raw value: ChromaticAberration's default strength is 0.006, Bloom's intensity 0.7). The rest of
// the port is null-graph on a device, checked on the GPU (EA5.4's EA-G1). This file sets WebGPU's usage globals for the
// engine's code before loading it, as test/resolve-engine.test.mjs does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
const post = await import('null-graph/post');
const { EFFECT_STRENGTH, createNullGraphPort, makeEffect } = await import('../src/exec/null-graph-port.ts');
const { Geometry, StandardLayout } = await import('null-graph/geometry');
const { GROUND_FACTORY, groundGeometry } = await import('../src/contract/adapters/ground.ts');

test('EA-D1b every effect the adapter offers is one the port makes; its intensity multiplies the effect\'s own default strength', () => {
    const manifest = JSON.parse(readFileSync(new URL('../src/contract/adapters/descriptors.json', import.meta.url), 'utf8'));
    const offered = manifest.adapters.find(a => a.id === 'ng.post.chain').config.properties.effects.items.properties.effect.enum;
    assert.deepEqual(Object.keys(EFFECT_STRENGTH).sort(), [...offered].sort(), 'one entry for each effect the adapter offers');
    for (const name of offered) {
        const knob = EFFECT_STRENGTH[name];
        const tuned = makeEffect(name, 2);
        assert.ok(tuned instanceof post[name], name);
        if (!knob) continue;
        const plain = new post[name]();
        assert.equal(typeof plain[knob], 'number', `${name}.${knob} is a number null-graph reads back`);
        assert.equal(tuned[knob], plain[knob] * 2, `${name}: twice its default ${knob}`);
        assert.equal(makeEffect(name, 0)[knob], 0, `${name}: off at 0`);
        assert.equal(makeEffect(name, 9)[knob], plain[knob] * 4, `${name}: the adapter's ceiling, 4`);
    }
    assert.throws(() => makeEffect('Sharpen', 1), /no post effect Sharpen/);
});

test('EA-D1c the main pass clears as X says through a chain, colour and depth (the EA5.2 review); a camera re-projects only when it moves', () => {
    const passes = [];
    const cameras = [];
    const engine = {
        device: {}, width: 640, height: 360, ctx: { format: 'bgra8unorm', cameraUniformBuffer: {} },
        createPass: config => { passes.push(config); return config; },
        updateCamera: camera => cameras.push(camera),
    };
    const port = createNullGraphPort(engine);
    const asked = [];
    const chain = { sceneAttachments: opts => { asked.push(opts); return { colorAttachments: ['scene'] }; } };
    port.createPass('@host#pass', chain, { color: [0, 0, 0, 1], depth: 1 });
    assert.deepEqual(asked, [{ clearValue: { r: 0, g: 0, b: 0, a: 1 }, depthClearValue: 1 }]);
    assert.deepEqual(passes[0], { name: '@host#pass', isMainScreenPass: false, colorAttachments: ['scene'] });
    // With no chain, null-graph's main screen pass, whose clear its RenderPipeline fixes (a request in plan §5).
    port.createPass('@host#pass', null, { color: [0, 0, 0, 1], depth: 1 });
    assert.deepEqual(passes[1], { name: '@host#pass', isMainScreenPass: true });
    // The camera: projected on the first frame, again only when the fov or the aspect moves.
    const camera = port.camera();
    let projections = 0;
    const project = camera.updateProjection.bind(camera);
    camera.updateProjection = aspect => { projections++; project(aspect); };
    const view = { target: [0, 0, 0], distance: 10, azimuth: 0.3, polar: 1.1, fov: 45 };
    port.updateCamera(camera, view, 0, 16 / 9);
    port.updateCamera(camera, view, 1 / 60, 16 / 9);
    port.updateCamera(camera, view, 2 / 60, 16 / 9);
    assert.equal(projections, 1, 'one projection for three frames of one fov and aspect');
    port.updateCamera(camera, { ...view, fov: 30 }, 3 / 60, 16 / 9);
    port.updateCamera(camera, { ...view, fov: 30 }, 4 / 60, 4 / 3);
    assert.deepEqual([projections, camera.fovDegrees, cameras.length], [3, 30, 5], 'and again when each moved; every frame written');
});

test('EA-D1d the ground (Q130) is the host\'s arrays as a null-graph Geometry, uploaded as a Primitives shape is; its box lies flat', () => {
    const uploaded = [];
    const engine = {
        device: {}, width: 640, height: 360, ctx: { format: 'bgra8unorm', cameraUniformBuffer: {} },
        bufferManager: { createVertexBuffer: v => { uploaded.push(['vertex', v]); return { destroy() {} }; }, createIndexBuffer: i => { uploaded.push(['index', i]); return { destroy() {} }; } },
    };
    const port = createNullGraphPort(engine);
    const ground = port.primitive(GROUND_FACTORY, [4, 8]);
    const want = groundGeometry(4, 8);
    assert.ok(ground instanceof Geometry);
    assert.equal(ground.layout, StandardLayout);
    assert.deepEqual([[...ground.vertices], [...ground.indices], ground.indexFormat], [[...want.vertices], [...want.indices], 'uint16']);
    assert.deepEqual(uploaded.map(([kind, data]) => [kind, data]), [['vertex', ground.vertices], ['index', ground.indices]], 'uploaded once, its own arrays');
    assert.deepEqual(port.geometryBox(ground), { min: [-2, 0, -2], max: [2, 0, 2] }, 'flat on XZ, 4 across');
    // A Primitives shape is made as before, and a factory neither knows refuses.
    const plane = port.primitive('createPlane', [4, 4]);
    assert.deepEqual(port.geometryBox(plane), { min: [-2, -2, 0], max: [2, 2, 0] }, 'the plane stands upright in XY');
    assert.throws(() => port.primitive('createTeapot', [1]), /EA_CALL: no primitive createTeapot/);
});

test('EA-D14b the offscreen first frame on null-graph: a world\'s screen pass pointed at a private target and back, as null-graph\'s own pipeline draws it, read back as RGBA8 rows', async () => {
    const { RenderPassNode, RenderPipeline } = await import('null-graph');
    const made = [];
    // The staging buffer a 2×2 readback copies into: rows of 256 bytes, the canvas's BGRA, padding after each row.
    const staged = new Uint8Array(512).fill(7);
    staged.set([10, 20, 30, 255, 40, 50, 60, 255], 0);
    staged.set([70, 80, 90, 255, 100, 110, 120, 255], 256);
    const scopes = [];
    let scopeError = null;
    const device = {
        createTexture: d => { const t = { ...d, destroyed: false, createView: () => ({ of: d.label }), destroy() { t.destroyed = true; } }; made.push(t); return t; },
        createBuffer: d => { const b = { ...d, destroyed: false, mapAsync: async () => {}, getMappedRange: () => staged.buffer, destroy() { b.destroyed = true; } }; made.push(b); return b; },
        createCommandEncoder: () => ({ copyTextureToBuffer: () => {}, copyBufferToBuffer: () => {}, finish: () => ({}) }),
        queue: { submit: () => {}, onSubmittedWorkDone: async () => 'settled' },
        pushErrorScope: filter => scopes.push(`push ${filter}`),
        popErrorScope: async () => { scopes.push('pop'); return scopeError; },
    };
    const engine = { device, width: 2, height: 2, ctx: { format: 'bgra8unorm', cameraUniformBuffer: {} } };
    const port = createNullGraphPort(engine);
    // A chain: a pass into its pool, and its last pass, to the screen.
    const inner = new RenderPassNode({ name: 'Post/a', isMainScreenPass: false, colorAttachments: [{ view: 'pool' }] });
    const last = new RenderPassNode({ name: 'Post/b', isMainScreenPass: true });
    const chain = { getPassSequence: () => [inner, last] };
    const target = port.offscreenTarget(2, 2);
    assert.deepEqual(made.map(t => [t.label, t.format, t.size]), [['wexy/first frame', 'bgra8unorm', [2, 2]], ['wexy/first frame depth', 'depth24plus', [2, 2]]], 'the canvas\'s format, its own depth');
    port.redirectOutput({ isMainScreenPass: false }, chain, target);
    assert.equal(last.isMainScreenPass, false);
    assert.deepEqual(last.colorAttachments, [{ view: target.colorView, clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1 }, loadOp: 'clear', storeOp: 'store' }], 'as the screen would clear');
    assert.equal(last.depthStencilAttachment.view, target.depthView);
    assert.deepEqual(inner.colorAttachments, [{ view: 'pool' }], 'a pass into the pool untouched');
    // null-graph's own RenderPipeline begins the redirected pass on the private target, never the screen.
    const begun = [];
    const ctx = {
        device: { createCommandEncoder: () => ({ beginRenderPass: d => { begun.push(d); return { end() {} }; }, finish: () => ({}) }), queue: { submit() {} } },
        getScreenView: () => 'THE SCREEN', depthTexture: { createView: () => 'THE SCREEN\'S DEPTH' }, width: 2, height: 2,
    };
    new RenderPipeline(ctx).render([last]);
    assert.equal(begun[0].colorAttachments[0].view, target.colorView);
    assert.equal(begun[0].depthStencilAttachment.view, target.depthView);
    port.redirectOutput(null, chain, null);
    assert.deepEqual([last.isMainScreenPass, last.colorAttachments, last.depthStencilAttachment], [true, [], undefined]);
    new RenderPipeline(ctx).render([last]);
    assert.equal(begun[1].colorAttachments[0].view, 'THE SCREEN', 'pointed back, the screen again');
    // With no chain, the main pass itself.
    const main = new RenderPassNode({ name: '@host#pass', isMainScreenPass: true });
    port.redirectOutput(main, null, target);
    assert.equal(main.isMainScreenPass, false);
    port.redirectOutput(main, null, null);
    assert.equal(main.isMainScreenPass, true);
    assert.throws(() => port.redirectOutput(null, { getPassSequence: () => [inner] }, target), /draws nothing to the screen/);
    // The readback: each row without its padding, blue and red swapped from the canvas's BGRA.
    assert.deepEqual([...await port.readTarget(target)], [30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255]);
    assert.ok(made.find(b => b.label === 'wexy/first frame read').destroyed, 'the staging buffer destroyed');
    port.destroyTarget(target);
    assert.ok(made.filter(t => t.label.startsWith('wexy/first frame')).every(t => t.destroyed));
    // The fence, and an error checkpoint pushed and popped around its work alone.
    assert.equal(await port.settle(), 'settled');
    assert.equal(await port.checkpoint(() => scopes.push('work')), null);
    assert.deepEqual(scopes, ['push out-of-memory', 'push validation', 'work', 'pop', 'pop']);
    scopeError = { message: 'a validation error' };
    assert.equal(await port.checkpoint(() => {}), 'a validation error');
    assert.equal(await port.checkpoint(() => { throw new Error('it threw'); }), 'it threw');
});
