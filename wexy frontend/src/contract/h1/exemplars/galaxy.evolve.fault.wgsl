fn evolve(p: Particle, i: u32) -> Particle {
    // b.x orbit radius, b.y height (-1..1), b.z which arm and how far from it, b.w kind.
    let r = p.b.x;
    // The disk turns at the Spin speed; inner stars a little faster.
    let omega = params.spin * (0.3 + 0.1 / (0.4 + r));
    // Integrate the angle, so moving the slider changes the speed without a jump.
    let phase = p.phase + omega * sim.dt;
    // Two arms: b.z below 0.5 follows one, above it the other, each scattered around its arm.
    let arm = select(0.0, PI, p.b.z >= 0.5);
    let scatter = (fract(p.b.z * 2.0) - 0.5) * 1.1 / (0.6 + 0.3 * r);
    let jitter = hash11(i) * 0.02;
    let angle = phase + arm + scatter + jitter + params.armTwist * log(1.0 + r);
    // A thin disk that thickens toward the bright core.
    let height = p.b.y * params.thickness * (0.3 + 1.2 * exp(-r * 1.5));
    var next = p;
    next.pos = vec3f(r * cos(angle), height, r * sin(angle));
    next.phase = phase;
    return next;
}
