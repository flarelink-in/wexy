// Wexy host contract h1: the particle pass. The host owns every buffer, binding, loop and draw.
// You write one function. Everything below is already declared: never declare it again.

// The fixed-step clock, the same for every particle.
struct Sim {
    dt: f32,      // seconds per step: 1/60
    time: f32,    // seconds since the world started
    frame: u32,   // steps since the world started: 0 on the very first step
    count: u32,   // how many particles there are
};
var<uniform> sim: Sim;

// The world's controls: one f32 per control the plan named, read as params.<name>. The real
// fields come with your task; this struct only shows the shape.
struct Params { spin: f32, glow: f32 };
var<uniform> params: Params;

// One particle. pos and phase are its state: evolve returns their new values, and the host keeps
// them. b never changes: the host ignores any b that evolve returns.
struct Particle {
    pos: vec3f,   // world position. (0, 0, 0) before the first step, so the first step must place it
    phase: f32,   // free state, often an angle; starts at 0 or at a random angle (the plan's spawn.phase)
    b: vec4f,     // four random numbers drawn once from the plan's spawn ranges; the plan says what each is for
};

// How a particle is drawn this frame: a soft round sprite.
struct Look {
    color: vec3f,   // linear HDR; above 1 blooms. With opacity 0, a million particles add up: keep most near 0.02 to 0.2
    size: f32,      // sprite radius in world units: 0.02 is a pinpoint, 0.1 a soft blob, with the camera 10 to 25 units away
    opacity: f32,   // 0 adds light (glow), 1 covers what is behind, in between blends
};

// Helpers you may call. Signatures only; the host provides the code.
const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;
fn hash11(x: f32) -> f32                       // random in [0, 1); the same x always gives the same number
fn hash31(p: vec3f) -> f32                     // random in [0, 1) from a point
fn noise3(p: vec3f) -> f32                     // smooth noise, about -1..1, with features about 1 unit apart
fn fbm3(p: vec3f, octaves: u32) -> f32         // noise3 in layers, about -1..1; octaves 1 to 6
fn curl3(p: vec3f) -> vec3f                    // a swirling, divergence-free flow, about -3..3 per axis; costly (18 noise3)
fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f  // a + b * cos(TAU * (c * t + d))
fn rot_axis(axis: vec3f, angle: f32) -> vec4f  // a quaternion: turn by angle (radians) about axis
fn qmul(q: vec4f, r: vec4f) -> vec4f           // quaternion product: r first, then q
fn qrot(q: vec4f, v: vec3f) -> vec3f           // v turned by quaternion q
fn smin(a: f32, b: f32, k: f32) -> f32         // smooth minimum, blending over a width of k
fn sd_sphere(p: vec3f, r: f32) -> f32          // signed distance to a sphere of radius r
fn sd_box(p: vec3f, extent: vec3f) -> f32      // signed distance to a box; extent is its half-size per axis
fn sd_torus(p: vec3f, radii: vec2f) -> f32     // signed distance to a ring around the y axis: radii.x the ring, radii.y the tube
fn ease_in(t: f32) -> f32                      // t in 0..1 to 0..1, slow start
fn ease_out(t: f32) -> f32                     // slow end
fn ease_in_out(t: f32) -> f32                  // slow start and end

// The functions of this pass. You write exactly one of them, whole, when asked.
fn evolve(p: Particle, i: u32) -> Particle     // once per particle per step; i is the particle's index, 0 to sim.count - 1
fn look(p: Particle, i: u32) -> Look           // once per particle per frame
