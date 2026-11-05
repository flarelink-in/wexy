// The host's ground (2026-11-05): `ng.geometry.primitive`'s fourteenth shape, a flat square on the XZ plane facing up
// (+Y), cut into segments by segments cells, in null-graph's StandardLayout (position, normal, uv: 8 floats, 32 bytes a
// vertex). null-graph's Primitives have no flat shape with cells: createPlane stands upright in XY, facing +Z, and is
// one quad whatever its segments, so a model's floor written as a plane at scale (w, 1, d) drew a strip 1 unit tall
// (the plane analysis of 2026-11-05). The ground is createPlane laid flat by a -90 degree turn about X, its uv included,
// with cells: a stock material draws it as a floor, and a custom batch can move each vertex (hills, waves).
//
// Pure CPU math, as Primitives are. contribute.ts names it in X by GROUND_FACTORY with its counts from groundCounts, and
// the null-graph port uploads groundGeometry's arrays as a Geometry, as it uploads a Primitives shape.

/** The factory X names for the ground: the host's own, never null-graph's (which has no createGround). */
export const GROUND_FACTORY = 'createGround';

/** StandardLayout's floats a vertex: position 3, normal 3, uv 2. */
const FLOATS = 8;

/** A ground's vertices and indices for `segments` cells a side: (segments + 1)² and 6 · segments², always 16-bit. */
export function groundCounts(segments: number): { vertices: number; indices: number; indexBytes: 2 } {
    const row = segments + 1;
    return { vertices: row * row, indices: 6 * segments * segments, indexBytes: 2 };
}

/**
 * A ground `size` across, centred on the origin at y = 0, of `segments` cells a side (an integer from 1 to 254, so every
 * index fits 16 bits; the adapter takes 3 to 128). Every normal is +Y; every triangle turns counter-clockwise seen from
 * above, as the engine's own faces do from their front. uv (0, 0) is the corner at (-x, -z) and (1, 1) the one at (+x, +z).
 */
export function groundGeometry(size: number, segments: number): { vertices: Float32Array; indices: Uint16Array } {
    if (!Number.isSafeInteger(segments) || segments < 1 || segments > 254) throw new Error(`ground: ${segments} is not 1 to 254 cells a side`);
    if (!(Number.isFinite(size) && size > 0)) throw new Error(`ground: ${size} is not a positive size`);
    const row = segments + 1;
    const vertices = new Float32Array(row * row * FLOATS);
    for (let j = 0; j <= segments; j++) {
        for (let i = 0; i <= segments; i++) {
            const u = i / segments;
            const v = j / segments;
            vertices.set([(u - 0.5) * size, 0, (v - 0.5) * size, 0, 1, 0, u, v], (j * row + i) * FLOATS);
        }
    }
    const indices = new Uint16Array(6 * segments * segments);
    let k = 0;
    for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
            // a (x0, z0), b (x1, z0), c (x0, z1), d (x1, z1): a c b and b c d turn counter-clockwise seen from +Y.
            const a = j * row + i;
            const b = a + 1;
            const c = a + row;
            const d = c + 1;
            indices.set([a, c, b, b, c, d], k);
            k += 6;
        }
    }
    return { vertices, indices };
}
