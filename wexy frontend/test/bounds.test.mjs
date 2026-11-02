// A world's extent once init has run (11-02, the castle's render; bounds.ts): each mesh batch's box from its geometry's
// own box and its instances as the stock vertex shader moves them (scaled, rotated, moved), read back in samples; the
// batch that dwarfs the rest and the camera inside a box, said; the orbit framed on the world. The castle's own numbers
// come from null-graph's own primitives, built on the CPU here. No GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Primitives, StandardLayout } from 'null-graph/geometry';
import { primitive } from '../src/contract/adapters/contribute.ts';
import { BOUNDS_SAMPLE, frameWorld, instanceBox, vertexBox, worldBounds } from '../src/exec/bounds.ts';
import { eyeOf } from '../src/runtime/camera-path.ts';

/** A primitive's own box, as null-graph builds it for {shape, size, segments}. */
const geometryBox = (shape, size, segments) => {
    const call = primitive(shape, size, segments);
    const g = Primitives[call.factory](StandardLayout, ...call.params);
    return vertexBox(g.vertices, g.layout.strideFloats);
};
/** An instance14 record: position, rotation (x, y, z, w), scale. */
const record = (p, s, q = [0, 0, 0, 1]) => [0, ...p, ...q, ...s, 0.5, 0.5, 0.5];
const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-3, `${what}: ${a} against ${b}`));
const size = box => box.max.map((v, i) => v - box.min[i]);

test('a geometry\'s own box comes from its vertices; an instance\'s box is that box scaled, rotated and moved, as the stock shader moves each vertex', () => {
    assert.deepEqual(vertexBox([1, 2, 3, 9, 9, 9, 9, 9, -1, 0, 5, 9, 9, 9, 9, 9], 8), { min: [-1, 0, 3], max: [1, 2, 5] });
    const local = { min: [-2, -1, -0.5], max: [2, 1, 0.5] };
    near(instanceBox(local, record([10, 0, 0], [1, 1, 1]), 0).min, [8, -1, -0.5], 'moved');
    near(instanceBox(local, record([0, 0, 0], [3, 2, 1]), 0).max, [6, 2, 0.5], 'scaled');
    // A quarter turn about y: the box's x and z extents trade places.
    const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    near(instanceBox(local, record([0, 0, 0], [1, 1, 1], quarter), 0).max, [0.5, 1, 2], 'turned');
    // The zero quaternion is no turn at all in the shader's formula; a scale of nothing, or a NaN, draws nothing.
    near(instanceBox(local, record([0, 0, 0], [1, 1, 1], [0, 0, 0, 0]), 0).max, [2, 1, 0.5], 'the zero quaternion');
    assert.equal(instanceBox(local, record([1, 1, 1], [0, 0, 0]), 0), null);
    assert.equal(instanceBox(local, record([NaN, 0, 0], [1, 1, 1]), 0), null);
});

test('the castle as the agent wrote it: its hill a 468 × 104 × 468 shell around it, its towers 16.8 tall, its roofs inside them; at size 1, as designed', () => {
    const tower = { center: [-6, 5.5, -6], radius: 1.6, height: 7, cone: 3 };
    const castle = sized => {
        const hill = instanceBox(geometryBox('sphere', sized ? 1 : 26, 32), record([0, -2, 0], [18, 4, 18]), 0);
        const t = instanceBox(geometryBox('cylinder', sized ? 1 : 2.4, 16), record(tower.center, [tower.radius, tower.height, tower.radius]), 0);
        const top = tower.center[1] + tower.height / 2;
        const roof = instanceBox(geometryBox('cone', sized ? 1 : 2.8, 16), record([tower.center[0], top + tower.cone / 2, tower.center[2]], [tower.radius + 0.5, tower.cone, tower.radius + 0.5]), 0);
        return { hill, tower: t, roof, top };
    };
    const written = castle(false);
    near(size(written.hill), [468, 104, 468], 'the hill as written');
    assert.ok(Math.abs(written.hill.max[1] - 50) < 1e-3, 'its top 50 units up: the castle is inside it');
    assert.ok(Math.abs(size(written.tower)[1] - 16.8) < 1e-3, 'a tower 2.4 times its height');
    assert.ok(written.roof.min[1] < written.tower.max[1] - 5, 'the roof sits inside its tower, not on it');
    const designed = castle(true);
    near(size(designed.hill), [18, 4, 18], 'the hill at size 1');
    assert.ok(Math.abs(size(designed.tower)[1] - 7) < 1e-3);
    assert.ok(Math.abs(designed.roof.min[1] - designed.top) < 1e-3, 'the roof on the tower\'s top');
});

test('worldBounds reads every instance of a small batch and evenly spaced runs of a large one; an instance never written draws nothing', async () => {
    const reads = [];
    const small = { label: 'small', records: [record([0, 0, 0], [1, 1, 1]), record([4, 0, 0], [1, 1, 1]), record([99, 99, 99], [0, 0, 0])] };
    const large = { label: 'large', count: 10000 };
    const port = {
        geometryBox: g => g.box,
        readBuffer: async (buffer, bytes, offset = 0) => {
            reads.push([buffer.label, bytes, offset]);
            const first = offset / 56;
            const n = bytes / 56;
            const out = new Float32Array(n * 14);
            for (let i = 0; i < n; i++) out.set(buffer.records ? buffer.records[first + i] : record([first + i, 0, 0], [1, 1, 1]), i * 14);
            return out.buffer;
        },
    };
    const unit = { box: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } };
    const bounds = await worldBounds([
        { node: 'small', buffer: small, instances: 3, geometry: unit }, { node: 'large', buffer: large, instances: 10000, geometry: unit },
    ], port);
    assert.deepEqual(bounds.batches.map(b => [b.node, b.box, b.instances, b.sampled]), [
        ['small', { min: [-0.5, -0.5, -0.5], max: [4.5, 0.5, 0.5] }, 3, 2],
        ['large', { min: [-0.5, -0.5, -0.5], max: [9999.5, 0.5, 0.5] }, 10000, BOUNDS_SAMPLE],
    ], 'the unwritten instance at (99, 99, 99) left out; the large batch\'s last run reaches its last instance');
    assert.deepEqual(reads[0], ['small', 3 * 56, 0]);
    assert.equal(reads.length, 1 + 16, 'one read of the small batch, 16 runs of the large');
    assert.deepEqual(reads.slice(1).map(r => r[1]), Array(16).fill(256 * 56));
    assert.deepEqual([reads[1][2], reads[16][2]], [0, (10000 - 256) * 56]);
    assert.equal(await worldBounds([], {}), null, 'an engine that cannot read gives no bounds');
});

test('the camera framed on the world: a batch that dwarfs the rest is said and left out of the shot, and so is a camera inside it; the shot holds the rest whole', () => {
    const box = (min, max) => ({ min, max });
    const castle = hill => ({
        batches: [
            { node: 'batchhill', box: hill, instances: 1, sampled: 1 },
            { node: 'batchtower', box: box([-7.9, -2.9, -7.9], [7.9, 13.9, 7.9]), instances: 6, sampled: 6 },
            { node: 'batchstone', box: box([-6.3, 2, -6.3], [6.3, 6, 10]), instances: 80, sampled: 80 },
            { node: 'batchroof', box: box([-8, 6.3, -8], [8, 14.7, 8]), instances: 6, sampled: 6 },
            { node: 'batchflag', box: box([-6.5, 12, -6.5], [6.5, 16, 6.5]), instances: 6, sampled: 6 },
        ],
    });
    const written = frameWorld(castle(box([-234, -54, -234], [234, 50, 234])), 45, 16 / 9);
    assert.equal(written.notes.length, 2, written.notes.join(' | '));
    assert.match(written.notes[0], /^EA_SCALE batchhill spans 468 × 104 × 468 units, 29 times the rest of the world \(16 across\): a primitive's size and its instances' scale multiply, so one of them is likely meant as 1$/);
    assert.match(written.notes[1], /^EA_FRAME the camera starts inside batchhill's box \(468 × 104 × 468 units\): its inside faces fill the view$/);
    near(written.subject.min, [-8, -2.9, -8], 'the shot is of the castle, not the hill');
    near(written.subject.max, [8, 16, 10], 'the shot is of the castle, not the hill');
    near(written.view.target, [0, 6.55, 1], 'aimed at the middle of the castle');
    const radius = Math.hypot(...size(written.subject)) / 2;
    assert.ok(written.view.distance >= radius / Math.sin((45 * Math.PI / 180) / 2) && written.view.distance <= 80, `the castle whole in view: ${written.view.distance}`);
    assert.deepEqual([written.view.azimuth, written.view.polar, written.view.fov], [0.6, 1.15, 45], 'three-quarter, a little above, its fov kept');
    // At size 1 the hill is part of the world, not a shell around it: nothing to say, and the shot holds it too.
    const designed = frameWorld(castle(box([-9, -4, -9], [9, 0, 9])), 45, 16 / 9);
    assert.deepEqual(designed.notes, []);
    assert.equal(designed.subject.min[1], -4);
    const eye = eyeOf(designed.view);
    assert.ok(!(eye[0] > -9 && eye[0] < 9 && eye[1] > -4 && eye[1] < 0 && eye[2] > -9 && eye[2] < 9), 'the camera outside every box');
});

test('a world past what the orbit reaches is framed on its middle, and said; with no box there is no framing', () => {
    const wide = frameWorld({ batches: [{ node: 'plain', box: { min: [-300, -1, -300], max: [300, 1, 300] }, instances: 1, sampled: 1 }] }, 45, 16 / 9);
    assert.equal(wide.view.distance, 80, 'as far back as the orbit goes');
    assert.equal(wide.notes[0], 'EA_FRAME the world is 849 units across, too large to see whole within the orbit\'s 80 units and the camera\'s reach of 200: framed on its middle');
    // Within the far plane but past the orbit: as far as the orbit goes, said the same way.
    const far = frameWorld({ batches: [{ node: 'ring', box: { min: [-60, -1, -60], max: [60, 1, 60] }, instances: 1, sampled: 1 }] }, 45, 16 / 9);
    assert.equal(far.view.distance, 80);
    assert.match(far.notes[0], /^EA_FRAME the world is 170 units across/);
    assert.equal(frameWorld(null, 45, 1), null);
    assert.equal(frameWorld({ batches: [] }, 45, 1), null, 'custom batches and fullscreen passes alone');
});
