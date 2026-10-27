fn look(p: Particle, i: u32) -> Look {
    // Height shades the cloud: dark at the base, lighter on top. b.w sets the size.
    let shade = 0.35 + 0.65 * smoothstep(0.0, 4.5, p.pos.y);
    // Lightning: a strike lights the cloud around a random point, a few times a second at most.
    let tick = floor(sim.time * 9.0);
    let strike = step(1.0 - 0.25 * params.lightning, hash11(tick));
    let at = vec3f(hash11(tick + 0.1) * 6.0 - 3.0, 1.5 + hash11(tick + 0.2) * 2.0, hash11(tick + 0.3) * 6.0 - 3.0);
    let near = exp(-length(p.pos - at) * 0.6);
    var o: Look;
    o.color = vec3f(0.5, 0.55, 0.65) * shade * 0.05 + vec3f(0.7, 0.8, 1.0) * strike * near * 0.6;
    o.size = 0.05 + 0.07 * p.b.w;
    o.opacity = 0.25;
    return o;
}
