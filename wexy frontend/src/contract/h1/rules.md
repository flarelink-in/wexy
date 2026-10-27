Rules for the function you write (host h1, the Standard setting). The browser checks every rule
before your code reaches the graphics card, and a function that breaks one comes back to you with
the error.

- Write exactly one function, whole, starting with its `fn` line, with the signature the contract
  gives. Nothing outside it: no structs, constants, bindings or other functions. Inside it, use
  `let`, `var` and `const` freely.
- At most 40 lines.
- Loops: only `for` loops with a literal bound of at most 32, such as
  `for (var k = 0; k < 8; k++)`. Nested loops multiply: the product of their bounds is at most 128.
  No `loop`, no `while`.
- Arrays of at most 64 elements. No atomics, barriers, textures, `@group`, `@binding`, `enable`,
  or `var<storage>`, `var<workgroup>` or `var<private>`.
- Every result stays finite. Never divide by something that can be 0, and never take `sqrt`, `log`
  or `pow` of something that can be negative: clamp or add a small number first. A NaN or an
  infinity makes a particle vanish, and the world fails its check.
- Plain WGSL, not GLSL: `vec3f`, `f32(x)`, `u32(x)`, `select(ifFalse, ifTrue, condition)`,
  `fract`, `clamp`, `mix`, `smoothstep(low, high, x)` with low below high. There is no `mod`: write
  `x - y * floor(x / y)`. Integers and floats never mix without a conversion: `f32(i)`, not `i`.
- These words are reserved and cannot name anything: active, as, auto, cast, class, common,
  default, do, enum, filter, final, from, get, inline, layout, match, meta, mod, module, move, new,
  null, of, pass, patch, precise, ref, resource, self, set, shared, smooth, static, target, this,
  type, union, use, where, with.
- Never name a variable after a built-in function you call (`step`, `mix`, `length`, `distance`,
  `min`, `max`, `clamp`): the name then means the variable, and the call fails.
- Use every control: read `params.<name>` for each one the plan lists, so each slider visibly
  changes the world.
- To let a control change a speed smoothly, integrate: `phase + speed * sim.dt`. Multiplying
  `sim.time` by a control makes everything jump when the slider moves.
- Deterministic: the same inputs always give the same result. For randomness use `hash11` and
  `hash31` on something stable, such as `f32(i)` or a cell's coordinates.
- Cheap: `evolve` and `look` run for every particle (up to two million), `sky` for every pixel.
  One `curl3` per particle is fine; `curl3` in a loop, or in `sky`, is not.
