// EA-X3c (2026-11-05, the plane analysis): the host's ground, `ng.geometry.primitive`'s fourteenth shape, built by
// ground.ts. Flat on XZ at y = 0, facing up, every triangle counter-clockwise seen from above, its uv the engine's
// createPlane laid flat by a -90 degree turn about X: pinned against null-graph's own createPlane. No GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Primitives, StandardLayout } from 'null-graph/geometry';
import { groundCounts, groundGeometry } from '../src/contract/adapters/ground.ts';

const F = StandardLayout.strideFloats;
const vertex = (g, i) => ({ p: [...g.vertices.subarray(i * F, i * F + 3)], n: [...g.vertices.subarray(i * F + 3, i * F + 6)], uv: [...g.vertices.subarray(i * F + 6, i * F + 8)] });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('EA-X3c the ground lies flat on XZ at y = 0, size across, every normal up, every triangle counter-clockwise from above, its uv across it', () => {
    assert.equal(F, 8, 'StandardLayout: position, normal, uv');
    for (const [size, segments] of [[1, 3], [2.5, 16], [40, 128]]) {
        const g = groundGeometry(size, segments);
        const count = g.vertices.length / F;
        assert.deepEqual({ vertices: count, indices: g.indices.length, indexBytes: g.indices.BYTES_PER_ELEMENT }, groundCounts(segments), `${size} ${segments}: counts`);
        const half = size / 2;
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < count; i++) {
            const { p, n, uv } = vertex(g, i);
            assert.equal(p[1], 0, 'on y = 0');
            assert.deepEqual(n, [0, 1, 0], 'facing up');
            assert.ok(Math.abs(uv[0] - (p[0] + half) / size) < 1e-6 && Math.abs(uv[1] - (p[2] + half) / size) < 1e-6, 'uv runs from (-x, -z) to (+x, +z)');
            min = min.map((m, k) => Math.min(m, p[k]));
            max = max.map((m, k) => Math.max(m, p[k]));
        }
        assert.deepEqual([min, max].map(v => v.map(x => Math.round(x * 1e6) / 1e6)), [[-half, 0, -half], [half, 0, half]], `${size} ${segments}: size across, centred`);
        const used = new Set();
        for (let t = 0; t < g.indices.length; t += 3) {
            const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]].map(i => { assert.ok(i < count); used.add(i); return vertex(g, i).p; });
            const normal = cross(sub(b, a), sub(c, a));
            assert.ok(normal[1] > 0 && normal[0] === 0 && normal[2] === 0, `triangle ${t / 3}: counter-clockwise seen from +Y`);
        }
        assert.equal(used.size, count, 'every vertex drawn');
    }
});

test('EA-X3c one cell of ground is the engine\'s createPlane turned -90 degrees about X: its corners, its uv and its front normal', () => {
    // createPlane stands upright in XY facing +Z, a front face and a back face (null-graph 1.2.1); its front face turned
    // (x, y, z) -> (x, z, -y) is the ground the model meant by a floor.
    const plane = Primitives.createPlane(StandardLayout, 3, 3);
    const front = [0, 1, 2, 3].map(i => vertex(plane, i));
    assert.ok(front.every(v => v.n[2] === 1), 'the front face of createPlane faces +Z');
    const turned = front.map(v => ({ p: [v.p[0], v.p[2], -v.p[1]], n: [v.n[0], v.n[2], -v.n[1]], uv: v.uv }));
    const key = v => JSON.stringify([v.p.map(x => x + 0), v.n.map(x => x + 0), v.uv]);
    const ground = groundGeometry(3, 1);
    assert.deepEqual([0, 1, 2, 3].map(i => key(vertex(ground, i))).sort(), turned.map(key).sort());
});

test('EA-X3c the ground refuses a size or cells it cannot build, rather than building something else', () => {
    for (const segments of [0, -1, 2.5, 255, Number.NaN]) assert.throws(() => groundGeometry(1, segments), /cells a side/, String(segments));
    for (const size of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) assert.throws(() => groundGeometry(size, 3), /positive size/, String(size));
    assert.equal(groundGeometry(1, 254).indices.BYTES_PER_ELEMENT, 2, 'the most cells a side whose indices fit 16 bits');
});
