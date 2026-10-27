// Wexy host library h1: the helpers a model's function may call. The browser puts this file after
// Sim, Params and the structs, and before the model's function, in every pass (particles and sky).
// The prompt-facing views (particles.wgsl, sky.wgsl) list every function here whose name does not
// start with wx_, with the same signature; HostContractTest keeps the three in step. Changing a
// helper's behaviour changes what every recorded function draws, so it means a new host version.

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// An integer hash (PCG, after Jarzynski and Olano 2020): the same bits on every GPU.
fn wx_hash_u32(x: u32) -> u32 {
    let s = x * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

// The top 24 bits as a float in [0, 1): exact, and never 1.
fn wx_unit(h: u32) -> f32 {
    return f32(h >> 8u) / 16777216.0;
}

fn hash11(x: f32) -> f32 {
    return wx_unit(wx_hash_u32(bitcast<u32>(x)));
}

fn hash31(p: vec3f) -> f32 {
    return wx_unit(wx_hash_u32(bitcast<u32>(p.x) ^ wx_hash_u32(bitcast<u32>(p.y) ^ wx_hash_u32(bitcast<u32>(p.z)))));
}

// noise3's lattice: a cell's integer corner to one of Perlin's twelve gradients (improved noise, 2002).
fn wx_grad(c: vec3f, d: vec3f) -> f32 {
    let q = vec3i(c);
    let h = wx_hash_u32(bitcast<u32>(q.x) ^ wx_hash_u32(bitcast<u32>(q.y) ^ wx_hash_u32(bitcast<u32>(q.z)))) & 15u;
    let u = select(d.y, d.x, h < 8u);
    let v = select(select(d.z, d.x, h == 12u || h == 14u), d.y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}

fn noise3(p: vec3f) -> f32 {
    let c = floor(p);
    let f = p - c;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let x00 = mix(wx_grad(c, f), wx_grad(c + vec3f(1.0, 0.0, 0.0), f - vec3f(1.0, 0.0, 0.0)), u.x);
    let x10 = mix(wx_grad(c + vec3f(0.0, 1.0, 0.0), f - vec3f(0.0, 1.0, 0.0)), wx_grad(c + vec3f(1.0, 1.0, 0.0), f - vec3f(1.0, 1.0, 0.0)), u.x);
    let x01 = mix(wx_grad(c + vec3f(0.0, 0.0, 1.0), f - vec3f(0.0, 0.0, 1.0)), wx_grad(c + vec3f(1.0, 0.0, 1.0), f - vec3f(1.0, 0.0, 1.0)), u.x);
    let x11 = mix(wx_grad(c + vec3f(0.0, 1.0, 1.0), f - vec3f(0.0, 1.0, 1.0)), wx_grad(c + vec3f(1.0, 1.0, 1.0), f - vec3f(1.0, 1.0, 1.0)), u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Octaves are clamped to 1..6, and the sum is normalized so every count spans about -1..1.
fn fbm3(p: vec3f, octaves: u32) -> f32 {
    let n = clamp(octaves, 1u, 6u);
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    for (var o = 0u; o < 6u; o++) {
        if (o >= n) { break; }
        sum += amp * noise3(q);
        q = q * 2.03 + vec3f(1.7, 9.2, 5.3);
        amp *= 0.5;
    }
    return sum / (1.0 - exp2(-f32(n)));
}

// curl3's vector potential: three decorrelated noise fields.
fn wx_potential(p: vec3f) -> vec3f {
    return vec3f(noise3(p), noise3(p + vec3f(31.4, 7.7, 12.9)), noise3(p + vec3f(-8.3, 23.1, 4.6)));
}

// The curl of a noise potential, by central differences: divergence-free, so a cloud it carries
// neither collapses to a point nor thins out. Eighteen noise3 calls.
fn curl3(p: vec3f) -> vec3f {
    let e = 0.05;
    let x0 = wx_potential(p - vec3f(e, 0.0, 0.0));
    let x1 = wx_potential(p + vec3f(e, 0.0, 0.0));
    let y0 = wx_potential(p - vec3f(0.0, e, 0.0));
    let y1 = wx_potential(p + vec3f(0.0, e, 0.0));
    let z0 = wx_potential(p - vec3f(0.0, 0.0, e));
    let z1 = wx_potential(p + vec3f(0.0, 0.0, e));
    let curl = vec3f((y1.z - y0.z) - (z1.y - z0.y), (z1.x - z0.x) - (x1.z - x0.z), (x1.y - x0.y) - (y1.x - y0.x));
    return curl / (2.0 * e);
}

fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
    return a + b * cos(TAU * (c * t + d));
}

fn rot_axis(axis: vec3f, angle: f32) -> vec4f {
    let len = length(axis);
    let n = select(vec3f(0.0, 1.0, 0.0), axis / max(len, 1e-6), len > 1e-6);
    return vec4f(n * sin(0.5 * angle), cos(0.5 * angle));
}

fn qmul(q: vec4f, r: vec4f) -> vec4f {
    return vec4f(q.w * r.xyz + r.w * q.xyz + cross(q.xyz, r.xyz), q.w * r.w - dot(q.xyz, r.xyz));
}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    let w = max(k, 1e-6);
    let h = clamp(0.5 + 0.5 * (b - a) / w, 0.0, 1.0);
    return mix(b, a, h) - w * h * (1.0 - h);
}

fn sd_sphere(p: vec3f, r: f32) -> f32 {
    return length(p) - r;
}

fn sd_box(p: vec3f, extent: vec3f) -> f32 {
    let q = abs(p) - extent;
    return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sd_torus(p: vec3f, radii: vec2f) -> f32 {
    return length(vec2f(length(p.xz) - radii.x, p.y)) - radii.y;
}

fn ease_in(t: f32) -> f32 {
    let x = clamp(t, 0.0, 1.0);
    return x * x;
}

fn ease_out(t: f32) -> f32 {
    let x = 1.0 - clamp(t, 0.0, 1.0);
    return 1.0 - x * x;
}

fn ease_in_out(t: f32) -> f32 {
    let x = clamp(t, 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}
