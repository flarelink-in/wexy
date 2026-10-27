// Ported from NullGraph tools/film/scenes/magnetic-star.mjs (MIT): a stylized magnetic accretion
// sculpture, not an astrophysical solver. Changes: host header bindings, live `params`, and
// premultiplied-additive particle fragments.

import type { Archetype } from './types';

const evolveBody = /* wgsl */ `
@compute @workgroup_size(128) fn cs_main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i * 2u >= arrayLength(&particles)) { return; }
    let a = particles[i * 2u];
    let b = particles[i * 2u + 1u];
    let phase = a.w + (0.16 + 1.8 / (b.x * b.x)) * sim.dt * params.orbitSpeed;
    let angle = phase + b.z * 6.2831853;
    var p = vec3f(b.x * cos(angle), b.y * 0.15, b.x * sin(angle));
    if (b.w > 0.77) {
        // Dipole-like closed filaments: azimuth fixed, beads travel along each arch.
        let u = phase * 1.5 + b.y * 6.2831853;
        let shell = floor(b.x * 2.0) / 2.0;
        let r = 1.55 + shell * sin(u) * sin(u);
        let az = floor(b.z * 16.0) / 16.0 * 6.2831853 + b.y * 0.009;
        p = vec3f(r * sin(u) * cos(az), r * cos(u) * 1.12, r * sin(u) * sin(az));
    } else {
        p.y += 0.12 * sin(angle * 7.0 + b.x * 2.5) + 0.22 * sin(angle * 3.0 + b.x * 1.7);
    }
    particles[i * 2u] = vec4f(p, phase);
}
`;

const particlesBody = /* wgsl */ `
struct V {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec3f,
    @location(2) gain: f32,
};

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> V {
    let a = particles[i * 2u];
    let b = particles[i * 2u + 1u];
    let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let uv = corners[v];
    var clip = camera.viewProj * vec4f(a.xyz, 1.0);
    let size = (0.009 + 0.012 * b.w) * camera.proj[1][1];
    clip.x += uv.x * size / camera.aspect;
    clip.y += uv.y * size;

    // Hide particles the star itself occludes.
    let ray = a.xyz - camera.eye;
    let t = clamp(-dot(camera.eye, ray) / dot(ray, ray), 0.0, 1.0);
    if (length(camera.eye + t * ray) < 1.48 && t < 0.999) { clip = vec4f(2.0, 2.0, 2.0, 1.0); }

    var o: V;
    o.pos = clip;
    o.uv = uv;
    let hot = vec3f(3.6, 0.64, 0.055);
    let cold = vec3f(0.025, 1.1, 2.8);
    o.color = mix(hot, cold, smoothstep(0.77, 0.8, b.w));
    if (b.w <= 0.77) { o.color = mix(vec3f(4.0, 2.4, 0.8), hot, smoothstep(1.8, 5.8, b.x)); }
    o.gain = 0.055 + 0.10 * pow(0.5 + 0.5 * sin(a.w * 3.0 + b.z * 44.0), 8.0);
    o.gain *= select(params.diskGlow, params.filamentGlow, b.w > 0.77);
    return o;
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let r = dot(v.uv, v.uv);
    if (r > 1.0) { discard; }
    return vec4f(v.color * exp(-r * 4.5) * v.gain, 0.0);
}
`;

const backdropBody = /* wgsl */ `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs_main(@builtin(vertex_index) i: u32) -> V {
    let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: V;
    o.pos = vec4f(p[i], 0.999, 1.0);
    o.uv = p[i];
    return o;
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let h = camera.invViewProj * vec4f(v.uv, 1.0, 1.0);
    let rd = normalize(h.xyz / h.w - camera.eye);
    let t = -dot(camera.eye, rd);
    let impact = length(camera.eye + t * rd);
    var col = vec3f(0.0006, 0.001, 0.004);
    let halo = exp(-pow((impact - 1.55) * 5.0, 2.0));
    col += vec3f(1.3, 0.32, 0.04) * halo * params.haloGlow;
    col += vec3f(0.004, 0.012, 0.025) * exp(-impact * 0.25);
    if (impact < 1.48 && t > 0.0) { col = vec3f(0.0001, 0.0002, 0.0005); }
    // Sparse, stable screen-space star dust; no temporal flicker.
    let cell = floor(v.pos.xy / 2.0);
    let noise = fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453);
    if (noise > 0.9995 && impact > 2.0) { col += vec3f(0.12, 0.18, 0.3); }
    return vec4f(col + particles[0].xyz * 0.0, 1.0);
}
`;

export const magneticStar: Archetype = {
    id: 'magnetic-star',
    name: 'Magnetic Star',
    tagline: 'Plasma disk and closed dipole filaments around a collapsed star',
    style: 'cosmic',
    keywords: /magnet|pulsar|magnetar|neutron|plasma|filament|dipole|\bstar\b|solar|corona|stellar/i,
    examplePrompt: 'A magnetar wrapped in a molten plasma disk, with glowing dipole filaments arching between its poles',
    draft: {
        version: '2.0',
        host: 'h1',
        title: 'Magnetic Star: Dipole Plasma',
        summary: 'A collapsed star wrapped in a molten plasma disk, with glowing filaments arching between its magnetic poles.',
        style: 'cosmic',
        particles: {
            count: 1048576,
            dt: 1 / 60,
            warmupSeconds: 0,
            seed: 271828,
            spawn: {
                phase: 'random-angle',
                x: { dist: 'power', min: 1.65, max: 6.95, power: 1.5 },
                y: { dist: 'uniform', min: -1, max: 1 },
                z: { dist: 'uniform', min: 0, max: 1 },
                w: { dist: 'uniform', min: 0, max: 1 },
            },
        },
        sky: 'function',
        post: {
            bloom: { threshold: 0.7, knee: 0.5, intensity: 0.6, mips: 6 },
            tonemap: { curve: 'aces', exposure: 1.25 },
            vignette: { intensity: 0.22, softness: 0.6 },
        },
        uniforms: {
            orbitSpeed: { label: 'Orbit speed', value: 1, min: 0, max: 3, step: 0.01 },
            diskGlow: { label: 'Disk glow', value: 1, min: 0, max: 3, step: 0.01 },
            filamentGlow: { label: 'Filament glow', value: 1, min: 0, max: 3, step: 0.01 },
            haloGlow: { label: 'Corona halo', value: 1, min: 0, max: 3, step: 0.01 },
        },
        camera: {
            keyframes: [
                { t: 0, target: [0, 0, 0], distance: 22, azimuth: -14.3, polar: 65.9, fov: 47 },
                { t: 0.5, target: [0, 0, 0], distance: 19, azimuth: 22.9, polar: 57.3, fov: 47 },
                { t: 1, target: [0, 0, 0], distance: 22, azimuth: -14.3, polar: 65.9, fov: 47 },
            ],
            move: 'orbit',
        },
    },
    hooks: { evolve: evolveBody, particles: particlesBody, backdrop: backdropBody },
    fault: {
        hook: 'evolve',
        find: 'var p = vec3f(b.x * cos(angle), b.y * 0.15, b.x * sin(angle));',
        replace: 'var p = vec3<float>(b.x * cos(angle), b.y * 0.15, b.x * sin(angle));',
        note: '`float` is GLSL; the WGSL scalar is `f32`, so the vector is `vec3f`.',
    },
    tweaks: [
        { match: /\b(calm|slow|gentle|quiet)\b/i, uniform: 'orbitSpeed', value: 0.5 },
        { match: /\b(fast|violent|furious|rapid)\b/i, uniform: 'orbitSpeed', value: 1.9 },
        { match: /\b(bright|glowing|blazing|intense) filaments?\b/i, uniform: 'filamentGlow', value: 1.8 },
    ],
};
