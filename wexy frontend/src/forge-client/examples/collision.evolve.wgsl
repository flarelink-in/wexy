fn evolve(p: Particle, i: u32) -> Particle {
    // Membership is independent of the arm selector and survives every step and reset.
    let member = select(-1.0, 1.0, hash11(f32(i) + 91.7) > 0.5);
    let r = p.b.x;
    // h1 persists phase, not b: one integrated clock drives both disks and their encounter.
    let phase = p.phase + params.spin * sim.dt;
    let orbit = phase * 0.4 + params.encounter;
    let approach = 0.5 - 0.5 * cos(orbit);
    let separation = mix(4.6, 1.2, approach);
    let center = member * vec3f(separation * cos(orbit * 0.6), 0.0, 1.2 * sin(orbit * 0.6));
    let arm = select(0.0, PI, p.b.z >= 0.5);
    let scatter = (fract(p.b.z * 2.0) - 0.5) * 0.7;
    let angle = phase * (0.22 + 0.12 / (0.5 + r)) + arm + scatter + params.armTwist * log(1.0 + r);
    let outer = smoothstep(1.6, 4.2, r);
    let tide = params.tails * outer * (0.18 + approach * 0.82);
    let stretch = 1.0 + tide * (0.5 + 0.5 * sin(angle - member * orbit));
    let x = r * cos(angle) * stretch;
    let z = r * sin(angle) + member * tide * r * 0.65;
    let y = p.b.y * params.thickness * (0.4 + exp(-r));
    let tilt = member * 0.32;
    var next = p;
    next.pos = center + vec3f(x, y * cos(tilt) - z * sin(tilt), y * sin(tilt) + z * cos(tilt));
    next.phase = phase;
    return next;
}