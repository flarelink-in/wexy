// The saved-world corpus (W3; the creations platform companion §8, "The controlled path"; Q125): worlds saved as
// wexy-world.v1 texts under the build of their day, which every later build of their line must still open.
//
//   node --import ./test/register.mjs dev/world-corpus.mjs add <name> <bundle.json>
//       Adds a world to test/fixtures/worlds/: a candidate bundle (Developer view's download, or dev/replays/*.json)
//       sealed by this build and written as a saved world, once. A corpus world is never written again: it stands for
//       a world saved on its day.
//   node --import ./test/register.mjs dev/world-corpus.mjs record
//       After a deliberate decision only: records this build's pins, and the X hash and id(C) each corpus world seals
//       to, in expected.json. Since KR0 (render-kernels-design.md §5.3, §7) nothing the model reads moves them, so a
//       failing tripwire means a change reached ea.v1's kernel, which is released and frozen (Q141 (b)): record over a
//       released line only as a patch the user decided (K8), a new corpus world, or a new action schema's pin.
//   node --import ./test/register.mjs dev/world-corpus.mjs numbers
//       Writes numbers.json: doubles as Node writes them in JSON, for the backend's canonical check (W3.1).
//
// No model call, no GPU.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { worldArtifact, parseWorld, pinsOf } from '../src/platform/artifact.ts';
import { openWorld } from '../src/platform/reopen.ts';
import { sealSaved } from '../src/loop/replay.ts';

const DIR = new URL('../test/fixtures/worlds/', import.meta.url);
const EXPECTED = new URL('expected.json', DIR);
const [command, ...args] = process.argv.slice(2);

const corpus = () => readdirSync(DIR).filter(f => f.endsWith('.wexy-world.json')).sort();
const readExpected = () => (existsSync(EXPECTED) ? JSON.parse(readFileSync(EXPECTED, 'utf8')) : { pins: null, worlds: {} });
const writeExpected = e => writeFileSync(EXPECTED, `${JSON.stringify(e, null, 2)}\n`);

async function sealed(name) {
    const text = readFileSync(new URL(`${name}.wexy-world.json`, DIR), 'utf8');
    const parsed = await parseWorld(text, null);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`);
    const opened = await openWorld(parsed.world, `corpus:${name}`);
    if (!opened.ok) throw new Error(`${name}: ${opened.reason}`);
    return { sha256: parsed.sha256, snapshot: opened.snapshot };
}

if (command === 'add') {
    const [name, bundlePath] = args;
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name ?? '') || !bundlePath) throw new Error('usage: add <name> <bundle.json>');
    mkdirSync(DIR, { recursive: true });
    const target = new URL(`${name}.wexy-world.json`, DIR);
    if (existsSync(target)) throw new Error(`${name} is in the corpus already: a corpus world is never written again`);
    const bundleText = readFileSync(bundlePath, 'utf8');
    const replayed = await sealSaved(bundleText);
    if (!replayed.ok) throw new Error(`${bundlePath}: ${replayed.reason}`);
    const design = JSON.parse(bundleText).design;
    const built = await worldArtifact({ snapshot: replayed.replay.snapshot, design, view: null });
    if (!built.ok) throw new Error(`${name}: ${built.reason}`);
    // Exactly the canonical text, no line end: the file's bytes are its hash's.
    writeFileSync(target, built.world.text);
    const e = readExpected();
    const s = replayed.replay.snapshot;
    e.pins ??= pinsOf(s);
    e.worlds[name] = { sha256: built.world.sha256, bytes: built.world.bytes, x: s.x.hash, candidate: s.id };
    writeExpected(e);
    console.log(`${name}: ${built.world.bytes} bytes, sha256 ${built.world.sha256.slice(0, 12)}…, ${s.bodies.length} modules`);
} else if (command === 'record') {
    const e = { pins: null, worlds: {} };
    for (const file of corpus()) {
        const name = file.replace(/\.wexy-world\.json$/, '');
        const { sha256, snapshot } = await sealed(name);
        e.pins ??= pinsOf(snapshot);
        e.worlds[name] = { sha256, bytes: Buffer.byteLength(readFileSync(new URL(file, DIR))), x: snapshot.x.hash, candidate: snapshot.id };
        console.log(`${name}: X ${snapshot.x.hash.slice(0, 12)}…, id(C) ${snapshot.id.slice(0, 12)}…`);
    }
    writeExpected(e);
} else if (command === 'numbers') {
    // Edge cases first, then doubles spread over every exponent from a fixed xorshift, so the file is the same each run.
    const edges = [0, -0, 1, -1, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 1e-7, 1e-6, 9.999999e-7, 1e20, 1e21, 1e22, 123456789012345680000,
        5e-324, -5e-324, 1e-323, 2.2250738585072014e-308, 2.225073858507201e-308, 1.7976931348623157e308, 9007199254740991,
        -9007199254740991, 4503599627370496.5, 0.000001, 0.0000001, 1.25, 12, 45, 179, 0.35, 1e300, 1.5e-300, 100, 1e2,
        123e-20, 4.35, 0.1 + 0.2, 1e16, 1e17, 2 ** 52, 2 ** 53 - 1, 1.0000000000000002, 0.9999999999999999];
    const view = new DataView(new ArrayBuffer(8));
    let s = 0x9e3779b97f4a7c15n;
    const next = () => { s ^= s << 13n; s &= (1n << 64n) - 1n; s ^= s >> 7n; s ^= s << 17n; s &= (1n << 64n) - 1n; return s; };
    const numbers = [];
    const push = n => {
        if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) return;
        view.setFloat64(0, n);
        numbers.push([view.getBigUint64(0).toString(16).padStart(16, '0'), JSON.stringify(n)]);
    };
    edges.forEach(push);
    while (numbers.length < 4000) {
        view.setBigUint64(0, next());
        push(view.getFloat64(0));
    }
    writeFileSync(new URL('numbers.json', DIR), `${JSON.stringify({ about: 'IEEE 754 bits (hex) and JSON.stringify of the double, from Node: the backend formats each the same', numbers })}\n`);
    console.log(`numbers.json: ${numbers.length} doubles`);
} else {
    throw new Error('usage: add <name> <bundle.json> | record | numbers');
}
