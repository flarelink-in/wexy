// EA-series, headless: the engine bundle of EA1 (engine-aware design §5.1, §5.2): the capability index K, the
// documentation bundle D and the support manifest H, checked against the installed null-graph itself. The bundle's
// symbols are compared field by field with the installed declarations (dev/engine-lib.mjs, the generator's own
// extraction), and the export lists are cross-checked against what each subpath exports when Node loads it. The
// manifest's hashes are recomputed from the files on disk. Each check also has a permanent negative case.
// (Review of 2026-10-29: hashes, declarations, scanner coverage, compatibility, read ranges, immutability.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareExports, compareSymbols, extractSymbols, packageHash, verifyManifest } from '../dev/engine-lib.mjs';
import { ENGINE, inspectSymbol } from '../src/contract/engine/index.ts';
import { DOCS, readDoc, staleMentions } from '../src/contract/engine/docs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = join(ROOT, 'node_modules', 'null-graph');
const DIR = join(ROOT, 'src', 'contract', 'engine');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const FILES = ['capabilities.json', 'docs.json', 'support.json', 'bundle.json'];
const texts = () => Object.fromEntries(FILES.map(f => [f, readFileSync(join(DIR, f), 'utf8')]));
const compat = JSON.parse(readFileSync(join(DIR, 'compat.json'), 'utf8'));
let extracted = null;
const installed = () => (extracted ??= extractSymbols(PKG, ROOT));

test('EA-U1 K is the installed null-graph, field by field: every export, its kind, summary and declaration; nothing more', async () => {
    assert.deepEqual(compareSymbols(ENGINE.capabilities.symbols, installed().symbols), []);
    assert.equal(ENGINE.capabilities.symbols.length, installed().symbols.length);

    // What Node actually loads, independently of the compiler: every runtime export is indexed under its family.
    let loaded = 0;
    for (const sub of Object.keys(pkg.exports)) {
        let mod;
        try { mod = await import(sub === '.' ? 'null-graph' : `null-graph/${sub.slice(2)}`); } catch { continue; }
        loaded++;
        const family = sub === '.' ? 'core' : sub.slice(2);
        for (const name of Object.keys(mod)) assert.ok(installed().declared[family].includes(name), `${sub}: ${name} loads but is not declared`);
    }
    assert.ok(loaded >= 1, 'at least one subpath loads in Node');

    // One family per subpath, in the package's order; its key symbols are its own; its documents are in D.
    const families = ENGINE.capabilities.families;
    assert.deepEqual(families.map(f => f.id), Object.keys(pkg.exports).map(s => (s === '.' ? 'core' : s.slice(2))));
    const docIds = new Set(DOCS.docs.map(d => d.id));
    for (const f of families) {
        assert.ok(f.summary.length > 40, `${f.id}: a summary`);
        for (const k of f.keySymbols) assert.ok(installed().declared[f.id].includes(k), `${f.id}: key symbol ${k} is not exported there`);
        for (const d of [...f.docs, ...f.examples]) assert.ok(docIds.has(d), `${f.id}: document ${d} is not in the bundle`);
        if (f.use !== 'world') assert.ok(f.reason && f.reason.length > 10, `${f.id}: ${f.use} needs a reason`);
    }
    const index = ENGINE.capabilities.familyIndex;
    assert.ok(Buffer.byteLength(index, 'utf8') <= 12 * 1024, `${Buffer.byteLength(index, 'utf8')} bytes`);
    for (const f of families) assert.ok(index.includes(`## ${f.id} `), f.id);
});

test('EA-U1n the declaration check refuses an altered signature, a missing export and an invented one', () => {
    const symbols = structuredClone(ENGINE.capabilities.symbols);
    const ng = symbols.find(s => s.id === 'core:NullGraph');
    ng.declaration = 'export declare class NullGraph {}';
    symbols.splice(symbols.findIndex(s => s.id === 'materials:LambertMaterial'), 1);
    symbols.push({ ...symbols.find(s => s.family === 'materials'), id: 'materials:Materials', name: 'Materials' });
    const problems = compareSymbols(symbols, installed().symbols).join(' | ');
    assert.match(problems, /core:NullGraph: declaration differs from the installed declarations/);
    assert.match(problems, /materials:LambertMaterial: exported but not indexed/);
    assert.match(problems, /materials:Materials: not exported by the installed package/);
});

test('EA-U2 the manifest is recomputed from the files: the package, each file, the bundle; a changed file or hash is refused', () => {
    const t = texts();
    assert.equal(ENGINE.bundle.engine.version, pkg.version);
    assert.equal(ENGINE.bundle.engine.packageHash, packageHash(PKG), 'the bundle was generated from this installed package');
    assert.deepEqual(verifyManifest(t), []);
    // The reviewer's two probes, kept: a zeroed bundle hash, and a declaration changed with no hash updated.
    const zeroed = JSON.parse(t['bundle.json']);
    zeroed.bundleHash = '0'.repeat(64);
    assert.match(verifyManifest({ ...t, 'bundle.json': JSON.stringify(zeroed) }).join(' | '), /bundleHash: not the hash of the package and the three files/);
    const altered = t['capabilities.json'].replace(/export declare class NullGraph \{/, 'export declare class NullGraph { altered;');
    assert.notEqual(altered, t['capabilities.json']);
    assert.match(verifyManifest({ ...t, 'capabilities.json': altered }).join(' | '), /capabilities\.json: its hash is not the manifest's/);
    for (const d of DOCS.docs) assert.equal(d.lines, d.text.split('\n').length, d.id);
    assert.match(verifyManifest({ ...t, 'docs.json': t['docs.json'].replace('NullGraph is a direct-to-GPU', 'NuliGraph is a direct-to-GPU') }).join(' | '), /docs\.json: its hash is not the manifest's|agent\/guide: its text is not its hash/);
});

test('EA-U2r a read is exact, or says where it stopped: the range, the end, the total, truncated; bad ranges refused', () => {
    const guide = DOCS.docs.find(d => d.id === 'agent/guide');
    const read = readDoc('agent/guide', 9, 3);
    assert.deepEqual(read.lines, guide.text.split('\n').slice(8, 11));
    assert.deepEqual({ start: read.start, end: read.end, total: read.total, truncated: read.truncated }, { start: 9, end: 11, total: guide.lines, truncated: false });
    assert.equal(read.sha256, guide.sha256);
    const tail = readDoc('agent/guide', guide.lines - 1, 160);
    assert.deepEqual({ end: tail.end, truncated: tail.truncated, count: tail.lines.length }, { end: guide.lines, truncated: true, count: 2 });
    assert.throws(() => readDoc('agent/nope', 1, 1), /no document agent\/nope/);
    assert.throws(() => readDoc('agent/guide', 0, 1), /lines 1 to/);
    assert.throws(() => readDoc('agent/guide', guide.lines + 1, 1), /lines 1 to/);
    assert.throws(() => readDoc('agent/guide', 1, 161), /at most 160 lines/);
    const lambert = inspectSymbol('materials:LambertMaterial');
    assert.match(lambert.declaration, /applyToBatch\(batch: RenderBatch/);
    assert.ok(lambert.docIds.includes('api/materials'));
    assert.doesNotMatch(lambert.declaration, /\bprivate\b/, 'private members are not the API');
    assert.throws(() => inspectSymbol('materials:Materials'), /no symbol materials:Materials/);
});

test('EA-U2f the bundle is immutable once loaded: a symbol, a document, the support list and the manifest refuse writes', () => {
    const s = inspectSymbol('core:NullGraph');
    assert.throws(() => { s.declaration = ''; }, TypeError);
    assert.throws(() => { s.docIds.push('x'); }, TypeError);
    assert.throws(() => { DOCS.docs[0].text = ''; }, TypeError);
    assert.throws(() => { ENGINE.support.entries[0].status = 'supported'; }, TypeError);
    assert.throws(() => { ENGINE.bundle.bundleHash = ''; }, TypeError);
});

test('EA-U2b every stale mention in the bundled documents is a reviewed exception with a reason, and the bundle records exactly those', () => {
    const found = staleMentions(DOCS.docs, installed().declared);
    const reviewed = new Map(compat.reviewedStale.map(r => [`${r.doc}|${r.family}|${r.name}|${r.how}`, r.reason]));
    for (const s of found) {
        const reason = reviewed.get(`${s.doc}|${s.family}|${s.name}|${s.how}`);
        assert.ok(reason && reason.length > 10, `unreviewed stale mention: ${s.doc} ${s.how} ${s.family}.${s.name}`);
    }
    assert.deepEqual(DOCS.review.stale.map(({ doc, family, name, how }) => ({ doc, family, name, how })), found);
});

test('EA-U2c the scanner finds each way a document can name what does not exist, and passes what does', () => {
    const declared = { core: ['NullGraph', 'Camera'], post: ['PostChain', 'Bloom'], geometry: ['Primitives'] };
    const doc = text => [{ id: 'fixture', text }];
    const one = text => staleMentions(doc(text), declared).map(s => `${s.how} ${s.family}.${s.name}`);
    assert.deepEqual(one("import { NullGraph, Camera as Cam } from 'null-graph';\nimport type { Bloom } from 'null-graph/post';"), []);
    assert.deepEqual(one("import { Scene } from 'null-graph';"), ['import core.Scene']);
    assert.deepEqual(one("import { Imaginary } from 'null-graph/not-real';"), ['subpath not-real.*']);
    assert.deepEqual(one("import * as post from 'null-graph/post';\npost.PostChain;\npost.Imaginary();"), ['namespace post.Imaginary']);
    assert.deepEqual(one("import * as x from 'null-graph/nowhere';"), ['subpath nowhere.*']);
    assert.deepEqual(one('const { Primitives, MeshBatch } = lib.geometry;'), ['lib geometry.MeshBatch']);
    assert.deepEqual(one('const c = new lib.core.Camera();\nlib.core.Scene.create();'), ['lib core.Scene']);
    assert.deepEqual(one("import NullGraph from 'null-graph';"), ['default core.NullGraph']);
    assert.deepEqual(one("import { x } from 'gl-matrix';\nconst { mat4 } = lib.glMatrix;"), [], 'not null-graph: not checked');
});

test('EA-U3 the package and the documents are a reviewed pair: the compatibility record names both, with its evidence', () => {
    const pair = compat.records.find(r => r.packageHash === ENGINE.bundle.engine.packageHash && r.docs === ENGINE.bundle.docs.source);
    assert.ok(pair, `no reviewed record for ${ENGINE.bundle.engine.packageHash.slice(0, 12)} with ${ENGINE.bundle.docs.source}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(pair.reviewed) && pair.by && pair.evidence.length > 40, 'a record says when, by whom and on what evidence');
});

test('EA-U3n the source check refuses a checkout that exports other names than the installed package, subpath by subpath', () => {
    const installedNames = { core: ['Camera', 'NullGraph'], post: ['Bloom'] };
    assert.deepEqual(compareExports({ core: ['Camera', 'NullGraph'], post: ['Bloom'] }, installedNames), []);
    assert.deepEqual(compareExports({ core: ['Camera', 'NullGraph', 'Scene'], post: [] }, installedNames), [
        'core:Scene: exported by the sources, not installed',
        'post:Bloom: installed, not exported by the sources',
    ]);
    assert.deepEqual(compareExports({ core: ['Camera', 'NullGraph'] }, installedNames), ['post: a subpath the sources do not have']);
    assert.deepEqual(compareExports({ ...installedNames, film: ['Film'] }, installedNames), ['film: a subpath the installed package does not have']);
});

// The Tier 1 audit of 11-05: H and the index said every world family "may" be used, shadows and fog among them, while
// no adapter ran any of them. Both now follow the adapter manifest, and the index says what H says.
test('EA-H the support manifest is honest: a family names the adapters that run it, one no adapter runs is unsupported, and every family says why', () => {
    const families = new Set(ENGINE.capabilities.families.map(f => f.id));
    assert.deepEqual(new Set(ENGINE.support.entries.map(e => e.family)), families);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'src/contract/adapters/descriptors.json'), 'utf8'));
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const e of ENGINE.support.entries) {
        const family = ENGINE.capabilities.families.find(f => f.id === e.family);
        const ids = manifest.adapters.filter(a => a.family === e.family).map(a => a.id);
        // Device verification is eligibility's, per adapter: a family Wexy runs stays unverified.
        if (ids.length) assert.deepEqual([e.status, e.adapter], ['unverified', ids.join(', ')], `${e.family}: runs through its adapters alone`);
        else assert.deepEqual([e.status, e.adapter], ['unsupported', null], `${e.family}: no adapter runs it`);
        assert.ok(e.reason.length > 10, e.family);
        const status = ids.length ? `Wexy runs it only through ${escape(ids.join(', '))}\\. `
            : family.use === 'world' ? 'no Wexy adapter: never plan with it\\.' : family.use === 'host' ? 'host only: ' : 'unavailable: ';
        assert.match(ENGINE.capabilities.familyIndex, new RegExp(`## ${escape(e.family)} · [^\\n]*\\nStatus: ${status}`), `${e.family}: the index says what H says`);
    }
    assert.doesNotMatch(ENGINE.capabilities.familyIndex, /a world may use it/, 'no family is offered without an adapter');
    assert.doesNotMatch(ENGINE.capabilities.familyIndex, /a program gives keyframes/, 'no program moves the camera');
});
