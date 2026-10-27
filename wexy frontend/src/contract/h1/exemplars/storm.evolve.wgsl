fn evolve(p: Particle, i: u32) -> Particle {
    // b.xyz: where the particle starts inside the cloud; b.w: its size and brightness.
    let start = vec3f(p.b.x * 4.0, 1.0 + p.b.y * 2.5, p.b.z * 4.0);
    var next = p;
    // Every position starts at zero: the first step places the particle.
    if (sim.frame == 0u) {
        next.pos = start;
        return next;
    }
    // Churn: drift along a swirling flow that slowly changes over time.
    let flow = curl3(p.pos * 0.45 + vec3f(0.0, sim.time * 0.05, 0.0));
    // Swirl: turn around the vertical axis, fastest near the middle.
    let around = vec3f(-p.pos.z, 0.0, p.pos.x) * params.swirl / (1.0 + dot(p.pos.xz, p.pos.xz) * 0.15);
    next.pos = p.pos + (flow * params.churn * 0.35 + around * 0.6) * sim.dt;
    // Keep the cloud together: a particle that drifts too far starts again where it began.
    let away = length(next.pos.xz) > 6.0 || next.pos.y < -0.5 || next.pos.y > 5.0;
    next.pos = select(next.pos, start, away);
    return next;
}
