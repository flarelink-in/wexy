// Places the 64 blocks once, at init: an 8 by 8 grid of cubes, each lifted and warmed by a gentle wave.
fn placeBlocks(index: u32) {
    let base = index * B_blocks_STRIDE;
    let x = f32(index % 8u) - 3.5;
    let z = f32(index / 8u) - 3.5;
    let h = 0.5 + 0.5 * sin(x * 0.9) * cos(z * 0.7);
    b_blocks[base + 0u] = 0.0;
    b_blocks[base + 1u] = x * 1.1;
    b_blocks[base + 2u] = h;
    b_blocks[base + 3u] = z * 1.1;
    b_blocks[base + 4u] = 0.0;
    b_blocks[base + 5u] = 0.0;
    b_blocks[base + 6u] = 0.0;
    b_blocks[base + 7u] = 1.0;
    b_blocks[base + 8u] = 1.0;
    b_blocks[base + 9u] = 0.5 + h;
    b_blocks[base + 10u] = 1.0;
    b_blocks[base + 11u] = 0.62 + 0.2 * h;
    b_blocks[base + 12u] = 0.5;
    b_blocks[base + 13u] = 0.36;
}
