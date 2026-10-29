fn look(p: Particle, i: u32) -> Look {
    let r = p.b.x;
    let member = hash11(f32(i) + 91.7);
    let kind = hash11(f32(i) + 317.1);
    let core = exp(-r * 1.5) * params.coreGlow;
    let armColor = select(vec3f(0.28, 0.5, 1.0), vec3f(1.0, 0.3, 0.56), member > 0.5);
    var o: Look;
    o.color = mix(vec3f(1.0, 0.65, 0.3), armColor, smoothstep(0.3, 2.5, r)) * (0.055 + 0.17 * core);
    o.size = 0.022;
    o.opacity = 0.0;
    if (kind > 0.991) {
        o.color = mix(armColor, vec3f(1.0), 0.55) * (0.7 + 0.15 * sin(sim.time * 1.3 + kind * 300.0));
        o.size = 0.038;
    }
    return o;
}