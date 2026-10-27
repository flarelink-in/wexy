fn look(p: Particle, i: u32) -> Look {
    // b.x orbit radius, b.w kind: a few young stars, some dust, and the old glow of the rest.
    let r = p.b.x;
    let core = exp(-r * 1.8) * params.coreGlow;
    var o: Look;
    o.color = mix(vec3f(1.0, 0.72, 0.38), vec3f(0.45, 0.62, 1.0), smoothstep(0.6, 3.5, r)) * (0.035 + 0.12 * core);
    o.size = 0.018;
    o.opacity = 0.0;
    if (p.b.w > 0.985) {
        // Young stars: bigger, bluer, each twinkling at its own moment.
        let twinkle = 0.75 + 0.25 * sin(sim.time * 2.0 + hash11(f32(i)) * TAU);
        o.color = vec3f(0.6, 0.75, 1.0) * 0.9 * twinkle;
        o.size = 0.035;
    } else if (p.b.w < 0.1) {
        // Dust: dark and partly covering, so the lanes block the glow behind them.
        o.color = vec3f(0.02, 0.015, 0.012);
        o.size = 0.03;
        o.opacity = 0.35;
    }
    return o;
}
