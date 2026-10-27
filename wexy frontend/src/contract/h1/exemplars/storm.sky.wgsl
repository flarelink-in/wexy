fn sky(dir: vec3f) -> vec3f {
    // A low, heavy sky: a dull glow at the horizon, dark overhead, slow cloud texture.
    let up = clamp(dir.y, -1.0, 1.0);
    let base = mix(vec3f(0.05, 0.055, 0.065), vec3f(0.006, 0.007, 0.01), smoothstep(-0.05, 0.6, up));
    let clouds = fbm3(dir * 2.5 + vec3f(sim.time * 0.02, 0.0, 0.0), 4u);
    var col = base * (0.8 + 0.4 * clouds);
    // Below the horizon, near-black ground.
    col = mix(col, vec3f(0.003), 1.0 - smoothstep(-0.08, 0.0, up));
    // The same strikes as the cloud's light the whole sky for a moment.
    let tick = floor(sim.time * 9.0);
    let strike = step(1.0 - 0.25 * params.lightning, hash11(tick));
    return col + vec3f(0.05, 0.06, 0.08) * strike * smoothstep(-0.1, 0.4, up);
}
