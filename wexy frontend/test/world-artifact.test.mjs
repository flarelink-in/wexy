// PL-FE1 and PL-FE11 (W3; the creations platform companion §5, §8, §11; Q123 to Q125): a saved world's file. Built from
// a sealed candidate as canonical text, read back as untrusted data, sealed again by this host; the lines and the
// tripwire that keep saved worlds opening as they were made. No GPU, no model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalJson } from '../src/contract/adapters/canonical.ts';
import { AGENT_ACTION } from '../src/contract/agent/index.ts';
import { sealSaved } from '../src/loop/replay.ts';
import { OPENS_LINES, parseWorld, pinsOf, savedView, WORLD_FORMAT, WORLD_LINE, WORLD_MAX_BYTES, WORLD_SCHEMA, WORLD_SCHEMA_TEXT, worldArtifact } from '../src/platform/artifact.ts';
import { openWorld } from '../src/platform/reopen.ts';
import { live } from './exec-fakes.mjs';

const DIR = new URL('./fixtures/worlds/', import.meta.url);
const CASTLE = readFileSync(new URL('castle.wexy-world.json', DIR), 'utf8');
const EXPECTED = JSON.parse(readFileSync(new URL('expected.json', DIR), 'utf8'));
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** The castle's file edited as JSON and written canonical again: a well-formed text with one thing changed. */
const edited = edit => { const w = JSON.parse(CASTLE); edit(w); return canonicalJson(w); };
const KEYS = ['candidate', 'design', 'format', 'graph', 'keyframes', 'kind', 'line', 'modules', 'pins', 'program', 'view'];

test('PL-FE1 a corpus world reads back as the exact bytes its hash names, every key the format\'s and nothing else', async () => {
    const parsed = await parseWorld(CASTLE, EXPECTED.worlds.castle.sha256);
    assert.equal(parsed.ok, true, parsed.reason);
    assert.equal(parsed.sha256, sha(CASTLE));
    assert.equal(parsed.bytes, Buffer.byteLength(CASTLE));
    assert.equal(canonicalJson(parsed.world), CASTLE, 'canonical: its value writes exactly its bytes');
    assert.deepEqual(Object.keys(parsed.world).sort(), KEYS);
    assert.deepEqual([parsed.world.format, parsed.world.kind, parsed.world.line], [WORLD_FORMAT, 'agent', WORLD_LINE]);
    assert.ok(Object.isFrozen(parsed.world.modules[0]), 'handed on frozen');
});

test('PL-FE1 a live candidate is written from a whitelist: its program, bodies, design and view, canonical, and read back the same', async () => {
    const r = await sealSaved(JSON.stringify(live('galaxy')));
    assert.equal(r.ok, true, r.reason);
    const design = JSON.parse(CASTLE).design;
    const view = { target: [1.23456, -2, 3.5], distance: 12.3456789, azimuth: 0.5, polar: 1.25, fov: 45.04 };
    const built = await worldArtifact({ snapshot: r.replay.snapshot, design, view });
    assert.equal(built.ok, true, built.reason);
    const { text, sha256, bytes } = built.world;
    assert.equal(sha256, sha(text));
    assert.equal(bytes, Buffer.byteLength(text));
    const back = await parseWorld(text, sha256);
    assert.equal(back.ok, true, back.reason);
    assert.equal(canonicalJson(back.world), text);
    const w = back.world;
    assert.deepEqual(Object.keys(w).sort(), KEYS, 'nothing of the attempt beyond the format: no request, calls, evidence or l3');
    assert.deepEqual(w.pins, pinsOf(r.replay.snapshot));
    assert.deepEqual(w.program.nodes, live('galaxy').program.nodes);
    assert.deepEqual(w.modules.map(m => [m.module, m.codeHash, m.body]), r.replay.snapshot.bodies.map(b => [b.module, b.codeHash, b.body]));
    assert.equal(w.graph, r.replay.snapshot.x.hash);
    assert.equal(w.candidate, r.replay.snapshot.id);
    // Degrees, rounded as a keyframe is: the runtime's radians never reach the file.
    assert.deepEqual(w.view, { target: [1.235, -2, 3.5], distance: 12.346, azimuth: 28.65, polar: 71.62, fov: 45 });
    assert.deepEqual(w.view, savedView(view));
    assert.deepEqual(w.keyframes, []);
    assert.equal(JSON.stringify(w).includes(live('galaxy').request.prompt), false, 'the idea\'s text is not in the file');
});

test('PL-FE1 a file is never trusted: each way it can be wrong is refused, said by its kind', async () => {
    const refused = async (text, expected, code, pattern, what) => {
        const r = await parseWorld(text, expected);
        assert.equal(r.ok, false, what);
        assert.equal(r.code, code, `${what}: ${r.reason}`);
        assert.match(r.reason, pattern, what);
    };
    await refused(CASTLE, 'e'.repeat(64), 'corrupt', /^the text is not the bytes its hash names/, 'another hash');
    await refused(CASTLE.replace('"kind":"agent"', '"kind": "agent"'), null, 'unreadable', /not canonical JSON/, 'a space: not canonical');
    await refused(JSON.stringify(JSON.parse(CASTLE), null, 2), null, 'unreadable', /not canonical JSON/, 'pretty-printed');
    await refused(CASTLE.slice(0, -1), null, 'unreadable', /^the text is not JSON/, 'cut short');
    await refused('[]', null, 'unreadable', /^the text is not a saved world$/, 'not an object');
    await refused(edited(w => { w.format = 'wexy-world.v2'; }), null, 'incompatible', /^the file is wexy-world\.v2, not wexy-world\.v1$/, 'another format');
    await refused(edited(w => { w.kind = 'h1'; }), null, 'incompatible', /an h1 world: the studio never saves these \(Q123\)/, 'an h1 world');
    await refused(edited(w => { w.line = 'ea.v2'; }), null, 'incompatible', /^line ea\.v2 is not one this build opens \(ea\.v1\)$/, 'a line this build does not open');
    await refused(edited(w => { w.line = 'EA 1'; }), null, 'unreadable', /\/line: "EA 1" is not a line/, 'not a line at all');
    // The developer bundle's private parts have no place in the file (F6).
    for (const key of ['request', 'calls', 'evidence', 'l3', 'reviews', 'attempt']) {
        await refused(edited(w => { w[key] = key === 'request' ? { prompt: 'a castle' } : []; }), null, 'unreadable', new RegExp(`/${key}: is not in the schema`), `a ${key} field`);
    }
    await refused(edited(w => { w.modules[0].originalBody = 'x'; }), null, 'unreadable', /\/modules\/0\/originalBody: is not in the schema/, 'an original body');
    await refused(edited(w => { w.modules[0].evidence = ['producedBy: device']; }), null, 'unreadable', /\/modules\/0\/evidence: is not in the schema/, 'forged device evidence');
    await refused(edited(w => { w.graph = 'G'.repeat(64); }), null, 'unreadable', /\/graph: is not 64 lowercase hex digits/, 'a hash of the wrong shape');
    await refused(edited(w => { w.pins.bundle = 'x'; }), null, 'unreadable', /\/pins\/bundle: is not 64 lowercase hex digits/, 'a pin of the wrong shape');
    await refused(edited(w => { w.view = { target: [0, 0, 0], distance: 1, azimuth: 0, polar: 200, fov: 45 }; }), null, 'unreadable', /\/view\/polar: 200 is over 180/, 'a view out of bounds');
    // A world at the format's bounds (32 bodies of 12,000 characters, every config near 4,096) stays under the cap:
    // 496,175 bytes measured. So past the cap is a text no parse is spent on: the size is checked first.
    const bounded = edited(w => { w.modules = Array.from({ length: 32 }, (_, i) => ({ ...w.modules[0], module: `m${i}`, body: 'y'.repeat(12000) })); w.program.nodes = w.program.nodes.map(n => ({ ...n, config: JSON.stringify({ pad: 'z'.repeat(3900) }) })); });
    assert.ok(Buffer.byteLength(bounded) <= WORLD_MAX_BYTES, `a world at the bounds is ${Buffer.byteLength(bounded)} bytes`);
    await refused(CASTLE + ' '.repeat(WORLD_MAX_BYTES), null, 'too-large', /^the text is \d+ bytes; at most 524288$/, 'past the cap');
    await refused('é'.repeat(WORLD_MAX_BYTES / 2 + 1), null, 'too-large', /^the text is 524290 bytes/, 'counted in UTF-8 bytes, not characters');
});

test('PL-FE1 the schema is in the strict subset, its design the action schema\'s own, and the backend keeps the same text', () => {
    const v3design = AGENT_ACTION.properties.design.anyOf.find(b => b.type === 'object');
    assert.deepEqual(WORLD_SCHEMA.properties.design, v3design, 'the design part is agent-action.v3\'s, exactly');
    const v3program = AGENT_ACTION.properties.program.anyOf.find(b => b.type === 'object');
    const loose = structuredClone(v3program);
    loose.properties.nodes.items.properties.adapterId = WORLD_SCHEMA.properties.program.properties.nodes.items.properties.adapterId;
    assert.deepEqual(WORLD_SCHEMA.properties.program, loose, 'the program part is v3\'s, but for the adapter id, which the resolver holds');
    // The backend's copy (platform-service), read from this checkout's own backend (gotchas: never the main checkout's).
    const backend = new URL('../../wexy backend/platform-service/src/main/resources/world/wexy-world.v1.json', import.meta.url);
    assert.ok(existsSync(backend), 'the backend keeps a copy');
    assert.equal(readFileSync(backend, 'utf8').replace(/\r\n/g, '\n'), WORLD_SCHEMA_TEXT, 'the two schemas are one text');
    // Its canonical check is tested on these very files (CanonicalTextTest, WorldCheckTest): the corpus and Node's numbers.
    for (const name of ['castle.wexy-world.json', 'numbers.json']) {
        const copy = new URL(`../../wexy backend/platform-service/src/test/resources/world/${name}`, import.meta.url);
        assert.ok(existsSync(copy), `the backend's tests hold ${name}`);
        assert.equal(readFileSync(copy, 'utf8'), readFileSync(new URL(name, DIR), 'utf8'), `${name}: the backend tests the studio's bytes`);
    }
});

test('PL-FE11 the corpus: every saved world opens under this build, to the X and id(C) recorded for it', async () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.wexy-world.json'));
    assert.ok(files.length >= 1);
    assert.deepEqual(files.map(f => f.replace(/\.wexy-world\.json$/, '')).sort(), Object.keys(EXPECTED.worlds).sort(), 'expected.json names every corpus world');
    for (const file of files) {
        const name = file.replace(/\.wexy-world\.json$/, '');
        const text = readFileSync(new URL(file, DIR), 'utf8');
        const parsed = await parseWorld(text, EXPECTED.worlds[name].sha256);
        assert.equal(parsed.ok, true, `${name}: ${parsed.reason}`);
        const opened = await openWorld(parsed.world, `corpus:${name}`);
        assert.equal(opened.ok, true, `${name}: ${opened.reason}`);
        const moved = `${name} seals to another X or id(C) than recorded. A change moved it: if every corpus world still opens and runs as made, `
            + 'record it (node --import ./test/register.mjs dev/world-corpus.mjs record); if not, start a new line (the companion §8)';
        assert.equal(opened.snapshot.x.hash, EXPECTED.worlds[name].x, moved);
        assert.equal(opened.snapshot.id, EXPECTED.worlds[name].candidate, moved);
    }
});

test('PL-FE11 the tripwire: this build\'s pins are the pinned set, and the line it writes is one it opens', async () => {
    const parsed = await parseWorld(CASTLE, null);
    const opened = await openWorld(parsed.world, 'corpus:castle');
    assert.equal(opened.ok, true, opened.reason);
    assert.deepEqual(pinsOf(opened.snapshot), EXPECTED.pins,
        'A pin moved. Decide before you record it: does every saved world still open and run as made? Yes: record (dev/world-corpus.mjs record). No: start a new line (lines.ts) and say which older lines OPENS_LINES keeps');
    assert.ok(OPENS_LINES.includes(WORLD_LINE));
});

test('PL-FE11 sealed again, trusting nothing: another build\'s provenance is kept beside the seal\'s own; a body for another interface is refused', async () => {
    // Another build on the same line: its pins and the X it named differ from this build's. The seal's own stand.
    const other = await parseWorld(edited(w => { w.pins.bundle = 'a'.repeat(64); w.graph = 'b'.repeat(64); w.candidate = 'c'.repeat(64); }), null);
    assert.equal(other.ok, true, other.reason);
    const opened = await openWorld(other.world, 'other-build');
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(opened.snapshot.x.hash, EXPECTED.worlds.castle.x, 'this build\'s X');
    assert.deepEqual(opened.provenance, { graph: 'b'.repeat(64), candidate: 'c'.repeat(64), same: false });
    const own = await openWorld((await parseWorld(CASTLE, null)).world, 'own');
    assert.equal(own.provenance.same, true, 'saved and opened by this build: the same X and id(C)');
    const refused = async (text, pattern, what) => {
        const p = await parseWorld(text, null);
        assert.equal(p.ok, true, `${what}: ${p.reason}`);
        const r = await openWorld(p.world, 'x');
        assert.equal(r.ok, false, what);
        assert.match(r.reason, pattern, what);
    };
    await refused(edited(w => { w.modules[0].interfaceHash = 'f'.repeat(64); }), /written for another interface/, 'another interface');
    await refused(edited(w => { w.modules[0].body = `${w.modules[0].body}\n`; }), /is not the text its codeHash names/, 'a body edited, its hash not');
    await refused(edited(w => { w.modules.pop(); }), /has no body$/, 'a module missing');
    await refused(edited(w => { w.program.nodes[0].adapterId = 'ng.render.odd'; }), /^its program does not resolve here: EA_/, 'an adapter this build does not have');
});
