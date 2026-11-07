// The starters' files (EA9.4; agent-first-studio-design.md §9, Q122 (a)): worlds Meta's models made earlier, shipped with
// the page in public/worlds/, each sealed again by this build before it is written.
//
//   node --import ./test/register.mjs dev/starters.mjs record
//       Seals each starter's source under this build (loop/replay.ts's sealSaved: its program resolved, its bodies held
//       to the interfaces derived here, every hash recomputed), writes public/worlds/<id>.json with this build's versions,
//       and pins each one's id(C), X hash and file hash in test/fixtures/starters.json, which EA9-U11 holds them to.
//
// A file holds only what the replay reads: the build's versions, the idea it was made for, the program and its bodies.
// No call, charge, model name, evidence or review. No model call, no GPU.
//
// Since KR0 (render-kernels-design.md §9.3) a starter opens on the kernel of its line for good, and recording one again
// is a choice, to show a new line off, never a necessity: a starter EA9-U11 finds moved means its kernel moved, and a
// released line is frozen (Q141 (b)). The files of 11-05 name no line, and ea.v1's `accepts` routes them by their
// manifest; a file recorded from now on names its line beside its versions.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BODY_CHECKER } from '../src/contract/adapters/bodies.ts';
import { ABI_VERSION } from '../src/contract/adapters/interfaces.ts';
import { sealSaved } from '../src/loop/replay.ts';
import { WORLD_LINE } from '../src/platform/lines.ts';
import { STARTER_WORLDS } from '../src/shell/studio/starters.ts';

/** Where each starter was recorded from: the live attempts of 11-01 and 11-02, as the model wrote them. */
const SOURCES = {
    'castle': 'dev/replays/castle.json',
    'voxel-island': 'test/fixtures/live-candidates/block-film.json',
    'spiral-galaxy': 'test/fixtures/live-candidates/galaxy.json',
};

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('public/worlds/', ROOT);
const PINS = new URL('test/fixtures/starters.json', ROOT);
const [command] = process.argv.slice(2);

if (command !== 'record') {
    console.error('usage: node --import ./test/register.mjs dev/starters.mjs record');
    process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const pins = { note: 'Each starter\'s id(C), X hash and file hash, as dev/starters.mjs recorded them under this build. EA9-U11 holds public/worlds/ to them.', starters: {} };
for (const starter of STARTER_WORLDS) {
    const from = SOURCES[starter.id];
    if (!from) throw new Error(`${starter.id}: no source named for it in dev/starters.mjs`);
    const source = JSON.parse(readFileSync(new URL(from, ROOT), 'utf8'));
    const sealed = await sealSaved(JSON.stringify(source));
    if (!sealed.ok) throw new Error(`${starter.id} (${from}): ${sealed.reason}`);
    const s = sealed.replay.snapshot;
    const request = source.request ?? {};
    const file = {
        note: `A starter (EA9.4, Q122 (a)): a world Meta's models made earlier, replayed in the studio with no model call. Recorded by dev/starters.mjs from ${from}.`,
        attempt: `starter-${starter.id}`,
        versions: { line: WORLD_LINE, bundle: s.x.identity.bundleHash, manifest: s.x.identity.manifestHash, abi: ABI_VERSION, checker: BODY_CHECKER },
        request: { prompt: String(request.prompt ?? ''), style: String(request.style ?? 'auto'), seconds: Number(request.seconds ?? 12) },
        program: { nodes: JSON.parse(JSON.stringify(s.program)) },
        modules: s.bodies.map(b => ({ module: b.module, interfaceHash: b.interfaceHash, codeHash: b.codeHash, body: b.body })),
    };
    const text = `${JSON.stringify(file, null, 1)}\n`;
    // The file as written must seal to the same candidate: it is what ships.
    const again = await sealSaved(text);
    if (!again.ok) throw new Error(`${starter.id}: the written file does not seal: ${again.reason}`);
    if (again.replay.snapshot.id !== s.id) throw new Error(`${starter.id}: the written file seals to another id(C)`);
    writeFileSync(new URL(`${starter.id}.json`, OUT), text);
    pins.starters[starter.id] = {
        from, candidate: s.id, x: s.x.hash, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text),
        modules: s.bodies.map(b => b.module),
    };
    console.log(`${starter.id}: id(C) ${s.id.slice(0, 12)}…, X ${s.x.hash.slice(0, 12)}…, ${s.bodies.length} module(s), ${Buffer.byteLength(text)} bytes`);
}
writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
