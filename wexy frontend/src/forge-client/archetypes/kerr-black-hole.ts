// Ported from NullGraph tools/film/scenes/kerr-black-hole.mjs (MIT). Changes: bindings come from
// the host header, the disk, jets, beaming and photon ring read live `params`, and particle
// fragments return alpha 0 (premultiplied additive) to fit the host's single blend state.

import type { Archetype } from './types';

const evolveBody = /* wgsl */ `
@compute @workgroup_size(128) fn cs_main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i * 2u >= arrayLength(&particles)) { return; }
    var a = particles[i * 2u];
    let b = particles[i * 2u + 1u];
    let dt = sim.dt;

    // Population 1 & 2 (b.w < 0.80): relativistic Keplerian accretion disk with MRI spiral waves.
    if (b.w < 0.80) {
        let r0 = b.x;
        // Kerr prograde angular velocity: rapid inner-ISCO differential rotation.
        let omega = 3.15 / (pow(r0, 1.38) + 0.22);
        let phase = a.w + omega * dt * params.spin;
        let angle = phase + b.z * 6.2831853;

        // Multi-scale logarithmic spiral density waves (m=2 grand design + m=6 MRI filaments).
        let logR = log(max(r0, 1.55));
        let spiral2 = sin(angle * 2.0 - logR * 5.8 + phase * 0.30);
        let spiral6 = cos(angle * 6.0 - logR * 11.5 - phase * 0.25);
        let rMod = r0 * (1.0 + 0.055 * spiral2 + 0.028 * spiral6);

        // Inner plunging region near ISCO (r < 1.95) tightens toward the photon ring.
        let plunge = smoothstep(2.05, 1.56, r0);
        let r = mix(rMod, 1.56 + (r0 - 1.56) * 0.72, plunge);

        // Razor-thin equatorial disk so the front crossing leaves the shadow crisp.
        let flare = 0.022 * pow(max(r - 1.4, 0.08), 1.08);
        let warp = 0.045 * sin(angle - logR * 2.8) * smoothstep(2.4, 7.0, r);
        let y = b.y * flare + warp;

        let p = vec3f(r * cos(angle), y, r * sin(angle));
        particles[i * 2u] = vec4f(p, phase);
        return;
    }

    // Population 3 (0.80 <= b.w < 0.92): braided Blandford-Znajek polar twin jets.
    if (b.w < 0.92) {
        let phase = a.w + (0.72 + 0.32 * abs(b.y)) * dt;
        let s = fract(phase + b.x * 0.17); // normalized distance [0, 1) along the jet
        let signY = select(-1.0, 1.0, b.y >= 0.0);
        // Launch outside the photon sphere (y = 1.56 .. 11.8).
        let zJet = 1.56 + pow(s, 1.12) * 10.4;

        // Four intertwined magnetic flux ropes with paraboloidal collimation and Alfven waves.
        let strandId = floor(b.z * 4.0);
        let strand = strandId * 1.5707963;
        let coreOrSheath = fract(b.z * 4.0);
        let twist = zJet * 1.45 - phase * 9.0 + strand;
        let nozzle = 0.08 + 0.52 * pow(s, 0.58);
        let recollim = 1.0 + 0.28 * cos(zJet * 2.2 - phase * 12.0);
        let ropeOffset = nozzle * recollim * (0.35 + 0.65 * step(0.35, coreOrSheath));
        let ropeSpread = (fract(coreOrSheath * 7.3) - 0.5) * 0.11 * (0.25 + s);
        let finalR = max(0.02, ropeOffset + ropeSpread);
        let p = vec3f(finalR * cos(twist), signY * zJet, finalR * sin(twist));
        particles[i * 2u] = vec4f(p, phase);
        return;
    }

    // Population 4 (b.w >= 0.92): tidal disruption event, an infalling stellar stream.
    let phase = a.w + 0.42 * dt;
    let u = fract(phase * 0.40 + b.z);
    let rTde = mix(9.6, 1.72, pow(u, 0.74));
    let theta = u * 10.8 + b.x * 0.38 + phase * 0.65;
    let incl = (1.0 - smoothstep(0.12, 0.88, u)) * 0.58;
    let ribbonWidth = (0.06 + 0.18 * (1.0 - u)) * b.y;
    let p = vec3f(
        (rTde + ribbonWidth) * cos(theta),
        rTde * sin(theta) * sin(incl) + b.y * 0.05,
        (rTde + ribbonWidth) * sin(theta) * cos(incl)
    );
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

    let p = a.xyz;
    let r3d = max(length(p), 1e-3);

    // Orthonormal black-hole-centred camera frame: fwd points from the camera through (0,0,0).
    let camDist = max(length(camera.eye), 1e-3);
    let fwd = -camera.eye / camDist;
    let worldUp = vec3f(0.0, 1.0, 0.0);
    let up = normalize(worldUp - fwd * dot(worldUp, fwd));
    let right = cross(fwd, up);

    // Particle relative to the hole in the observer's frame; z > 0 is behind the hole.
    let x = dot(p, right);
    let y = dot(p, up);
    let z = dot(p, fwd);

    let rShadow = 1.52;
    var xApp = x;
    var yApp = y;
    var zApp = z;
    var lensMag = 1.0;

    if (b.w < 0.58) {
        // Primary image: the front half crosses the shadow, the back half folds into the upper
        // Einstein arch. yFold = sqrt(y^2 + z^2) keeps x^2 + yFold^2 == r3d^2 at every angle.
        let fold = smoothstep(-0.18, 0.35, z);
        let zBehind = max(z, 0.0);
        let yRot = sqrt(y * y + zBehind * zBehind);
        let yFold = mix(y, yRot, fold);
        let bFlat = sqrt(x * x + yFold * yFold + 1e-5);
        let bRel = max(bFlat, rShadow * 1.004 + 0.94 * max(bFlat - rShadow, 0.0));
        let bLensed = mix(bFlat, bRel, fold);
        let scale = bLensed / bFlat;
        xApp = x * scale;
        yApp = yFold * scale;
        zApp = mix(z, 0.0, fold);
        lensMag = 1.0 + 0.60 * fold * exp(-max(bLensed - rShadow, 0.0) * 1.05);
    } else if (b.w < 0.80) {
        // Secondary image: the lower Einstein arch, light from the disk's underside.
        let yUnder = -sqrt(y * y + z * z * 0.85) - 0.12 * r3d;
        let bUnder = max(sqrt(x * x + yUnder * yUnder), 1e-4);
        let dirX = x / bUnder;
        let dirY = yUnder / bUnder;
        let radialNorm = clamp((r3d - 1.54) / 5.8, 0.0, 1.0);
        let wingBlend = smoothstep(0.62, 0.98, abs(dirX));
        let rCaustic = mix(
            rShadow * 1.006 + 0.65 * pow(radialNorm, 0.72),
            r3d * 0.96,
            wingBlend * 0.50
        );
        xApp = dirX * rCaustic;
        yApp = dirY * rCaustic;
        zApp = 0.0;
        lensMag = 0.95 * (1.0 - 0.30 * radialNorm);
    } else {
        // Jets and the stream: rays passing behind the hole bend into the lens plane.
        if (z > -0.2) {
            let fold = smoothstep(-0.2, 0.8, z);
            let bFlat = max(sqrt(x * x + y * y), 1e-4);
            let bLensed = mix(bFlat, max(bFlat, rShadow * 1.015 + 0.90 * max(bFlat - rShadow, 0.0)), fold);
            let scale = bLensed / bFlat;
            xApp = x * scale;
            yApp = y * scale;
            zApp = mix(z, 0.0, fold);
        }
    }

    let worldPos = right * xApp + up * yApp + fwd * zApp;
    var clip = camera.viewProj * vec4f(worldPos, 1.0);

    let bProjected = sqrt(xApp * xApp + yApp * yApp) * (camDist / max(camDist + zApp, 1.0));
    if (bProjected < rShadow * 0.995 && (zApp >= -0.25 || b.w >= 0.80 || yApp > -0.02)) {
        clip = vec4f(2.0, 2.0, 2.0, 1.0);
    }
    let bScreen = bProjected;

    // Relativistic Doppler factor D = 1 / (gamma * (1 - beta_los)) from prograde rotation.
    let angle = atan2(p.z, p.x);
    let velDir = vec3f(-sin(angle), 0.0, cos(angle));
    let toCam = -fwd;
    let rOrb = max(length(p.xz), 1.52);
    let beta = clamp(0.66 / sqrt(rOrb), 0.15, 0.58);
    let gamma = inverseSqrt(1.0 - beta * beta);
    let betaLos = beta * dot(velDir, toCam);
    let doppler = clamp(1.0 / (gamma * (1.0 - betaLos)), 0.45, 2.35);

    let logR = log(max(rOrb, 1.55));
    let filament = 0.58 + 0.42 * sin(angle * 2.0 - logR * 5.8 + a.w * 0.30) * cos(angle * 6.0 - logR * 11.5);

    var color = vec3f(1.0);
    var gain = 0.022;
    var sizeScale = 1.0;

    if (b.w < 0.80) {
        // Blackbody gradient plus the Doppler frequency shift.
        let radialTemp = smoothstep(7.2, 1.58, b.x);
        let coreHot = vec3f(3.6, 2.75, 1.85);
        let midWarm = vec3f(2.85, 0.92, 0.16);
        let outerRed = vec3f(1.25, 0.14, 0.022);
        var baseCol = mix(outerRed, midWarm, smoothstep(0.0, 0.56, radialTemp));
        baseCol = mix(baseCol, coreHot, smoothstep(0.56, 1.0, radialTemp));

        let blueShift = vec3f(0.65, 1.65, 3.6);
        let redShift = vec3f(1.65, 0.16, 0.018);
        let shiftT = clamp((doppler - 1.0) * 0.88, -1.0, 1.0);
        if (shiftT >= 0.0) {
            color = mix(baseCol, baseCol * 0.58 + blueShift * 1.25, shiftT * 0.74);
        } else {
            color = mix(baseCol, redShift, (-shiftT) * 0.72);
        }

        let beaming = pow(doppler, 2.08 * params.beaming);
        gain = (0.013 + 0.028 * radialTemp) * beaming * filament * lensMag * params.diskGlow;

        // Keep the thin front-crossing band semi-transparent against the shadow.
        if (zApp < 0.0 && bScreen < rShadow * 1.02) {
            gain *= 0.52;
        }
    } else if (b.w < 0.92) {
        // Jets: synchrotron cyan core, violet sheath and shock knots.
        let s = clamp((abs(p.y) - 1.62) / 10.2, 0.0, 1.0);
        let baseFade = smoothstep(0.0, 0.08, s);
        let knot = pow(0.5 + 0.5 * cos(abs(p.y) * 2.1 - a.w * 11.0), 5.0);
        let jetCore = vec3f(1.3, 2.4, 4.2);
        let jetSheath = vec3f(0.42, 0.85, 2.9);
        let jetTip = vec3f(1.45, 0.32, 2.25);
        color = mix(jetCore, jetSheath, smoothstep(0.0, 0.45, s));
        color = mix(color, jetTip, smoothstep(0.55, 1.0, s));
        color += vec3f(2.2, 2.6, 3.8) * knot * (1.0 - 0.45 * s);
        gain = baseFade * (0.020 * (1.0 - 0.65 * s) + 0.032 * knot) * (0.8 + 0.2 * doppler) * params.jetPower;
        sizeScale = 1.12;
    } else {
        // Tidal disruption stream: incandescent gold-cyan shocked debris ribbon.
        let u = fract(a.w * 0.40 + b.z);
        let streamCol = mix(vec3f(0.42, 1.35, 3.0), vec3f(3.2, 1.45, 0.42), smoothstep(0.1, 0.85, u));
        let shock = pow(0.5 + 0.5 * sin(u * 26.0 - a.w * 6.0), 5.0);
        color = streamCol + vec3f(2.0, 1.6, 1.05) * shock;
        gain = 0.018 + 0.024 * shock;
        sizeScale = 1.08;
    }

    let size = (0.0082 + 0.0098 * fract(b.z * 17.3)) * sizeScale * camera.proj[1][1];
    clip.x += uv.x * size / camera.aspect;
    clip.y += uv.y * size;

    var o: V;
    o.pos = clip;
    o.uv = uv;
    o.color = color;
    o.gain = gain;
    return o;
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let r = dot(v.uv, v.uv);
    if (r > 1.0) { discard; }
    // Alpha 0: the host blends premultiplied, so this adds like light.
    return vec4f(v.color * exp(-r * 4.2) * v.gain, 0.0);
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

fn hash3(p: vec3f) -> f32 {
    var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.x + q.y) * q.z);
}

@fragment fn fs_main(v: V) -> @location(0) vec4f {
    let h = camera.invViewProj * vec4f(v.uv, 1.0, 1.0);
    let rd = normalize(h.xyz / h.w - camera.eye);
    let t = -dot(camera.eye, rd);
    let closest = camera.eye + max(t, 0.0) * rd;
    let impact = length(closest);
    let rShadow = 1.52;

    // Deep space with a gravitationally lensed starfield around the Einstein ring.
    var col = vec3f(0.0003, 0.0006, 0.0018);
    let bDir = closest / max(impact, 1e-4);
    let deflection = 2.35 / max(impact * impact, 2.2);
    let lensedDir = normalize(rd - bDir * deflection);

    let starGrid = lensedDir * 195.0;
    let cell = floor(starGrid);
    let f = fract(starGrid) - 0.5;
    let rnd = hash3(cell);
    if (rnd > 0.992 && impact > rShadow * 1.01) {
        let d2 = dot(f, f);
        let starBright = exp(-d2 * 28.0) * smoothstep(rShadow * 1.01, rShadow * 1.25, impact);
        let mag = 1.0 + 1.8 * exp(-(impact - rShadow * 1.08) * 1.5);
        let starTint = mix(vec3f(1.0, 0.82, 0.65), vec3f(0.62, 0.85, 1.35), fract(rnd * 37.0));
        col += starTint * starBright * 0.45 * mag;
    }

    // Faint relativistic nebula outside the shadow.
    let outsideShadow = smoothstep(rShadow * 0.99, rShadow * 1.15, impact);
    let jetAxis = abs(lensedDir.y);
    col += vec3f(0.004, 0.010, 0.028) * exp(-impact * 0.22) * outsideShadow;
    col += vec3f(0.008, 0.020, 0.060) * pow(jetAxis, 7.0) * exp(-impact * 0.18) * outsideShadow;

    // Doppler-asymmetric photon ring at the shadow edge, brighter on the approaching side.
    let spinSide = -dot(bDir, normalize(cross(vec3f(0.0, 1.0, 0.0), rd)));
    let ringDoppler = 1.0 + 0.65 * spinSide;
    let n1Ring = exp(-pow((impact - rShadow) * 34.0, 2.0)) * ringDoppler;
    let n0Corona = exp(-pow((impact - rShadow * 1.04) * 10.5, 2.0)) * (0.75 + 0.35 * spinSide) * outsideShadow;
    let ringColor = mix(vec3f(1.45, 0.44, 0.08), vec3f(1.5, 1.85, 2.45), clamp(0.5 + 0.5 * spinSide, 0.0, 1.0));
    col += ringColor * n1Ring * 1.25 * params.ringGlow;
    col += vec3f(0.85, 0.30, 0.06) * n0Corona * 0.42 * params.ringGlow;

    // Event horizon shadow.
    if (impact < rShadow && t > 0.0) {
        let edge = smoothstep(rShadow * 0.975, rShadow, impact);
        col = mix(vec3f(0.0), col, edge);
    }

    return vec4f(col + particles[0].xyz * 0.0, 1.0);
}
`;

export const kerrBlackHole: Archetype = {
    id: 'kerr-black-hole',
    name: 'Kerr Black Hole',
    tagline: 'Lensed accretion disk, Doppler beaming and braided polar jets',
    style: 'cosmic',
    keywords: /black ?hole|kerr|accretion|event horizon|singularity|quasar|jets?\b|lensing|gravit|interstellar|wormhole/i,
    examplePrompt: 'A spinning Kerr black hole with a Doppler-beamed accretion disk, a tidal disruption stream and braided polar jets',
    draft: {
        version: '2.0',
        host: 'h1',
        title: 'Kerr Black Hole: Relativistic Accretion',
        summary: 'A spinning black hole lenses its glowing accretion disk; braided jets leave its poles and a torn star streams in.',
        style: 'cosmic',
        particles: {
            count: 1048576,
            dt: 1 / 60,
            warmupSeconds: 0,
            seed: 314159265,
            spawn: {
                phase: 'random-angle',
                x: { dist: 'power', min: 1.58, max: 7.43, power: 1.55 },
                y: { dist: 'triangular', min: -1, max: 1 },
                z: { dist: 'uniform', min: 0, max: 1 },
                w: { dist: 'uniform', min: 0, max: 1 },
            },
        },
        sky: 'function',
        post: {
            bloom: { threshold: 1.05, knee: 0.42, intensity: 0.28, mips: 5 },
            tonemap: { curve: 'aces', exposure: 1.24 },
            vignette: { intensity: 0.2, softness: 0.6 },
        },
        uniforms: {
            spin: { label: 'Disk spin', value: 1, min: 0, max: 3, step: 0.01 },
            diskGlow: { label: 'Disk luminosity', value: 1, min: 0.2, max: 2.5, step: 0.01 },
            beaming: { label: 'Doppler beaming', value: 1, min: 0, max: 2, step: 0.01 },
            jetPower: { label: 'Jet power', value: 1, min: 0, max: 3, step: 0.01 },
            ringGlow: { label: 'Photon ring', value: 1, min: 0, max: 3, step: 0.01 },
        },
        camera: {
            keyframes: [
                { t: 0, target: [0, 0, 0], distance: 19, azimuth: -24, polar: 77, fov: 45 },
                { t: 0.5, target: [0, 0, 0], distance: 15.5, azimuth: 18, polar: 80, fov: 42 },
                { t: 1, target: [0, 0, 0], distance: 17, azimuth: 62, polar: 74, fov: 45 },
            ],
            move: 'orbit',
        },
    },
    hooks: { evolve: evolveBody, particles: particlesBody, backdrop: backdropBody },
    fault: {
        hook: 'evolve',
        find: 'let s = fract(phase + b.x * 0.17);',
        replace: 'let s = mod(phase + b.x * 0.17, 1.0);',
        note: 'GLSL `mod()` does not exist in WGSL; a unit wrap of a positive phase is `fract()`.',
    },
    tweaks: [
        { match: /\b(calm|slow|gentle|quiet|dormant)\b/i, uniform: 'spin', value: 0.55 },
        { match: /\b(fast|violent|furious|rapid|maximal)\b/i, uniform: 'spin', value: 1.8 },
        { match: /\b(no|without) jets?\b/i, uniform: 'jetPower', value: 0 },
        { match: /\b(powerful|bright|intense|blazing) jets?\b/i, uniform: 'jetPower', value: 1.8 },
        { match: /\bdim\b|\bfaint\b/i, uniform: 'diskGlow', value: 0.6 },
    ],
};
