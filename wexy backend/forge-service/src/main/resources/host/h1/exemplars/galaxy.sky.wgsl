fn sky(dir: vec3f) -> vec3f {
    // Deep space: a faint band of distant light, and sparse stars that hold still.
    let band = exp(-abs(dir.y + 0.15 * sin(dir.x * 3.0)) * 6.0);
    let haze = 0.5 + 0.5 * fbm3(dir * 3.0, 4u);
    var col = vec3f(0.002, 0.003, 0.008) + vec3f(0.03, 0.025, 0.04) * band * haze;
    // About one cell in a thousand holds a star.
    let h = hash31(floor(dir * 900.0));
    if (h > 0.999) {
        col += vec3f(0.8, 0.85, 1.0) * (h - 0.999) * 1000.0;
    }
    return col;
}
