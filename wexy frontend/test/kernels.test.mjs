// Render kernels, KR0 (render-kernels-design.md §5.3, §9.3, §10, §13): what a world is no longer moves with what the
// model reads. KR-U3: an edit to a file the model reads (a document, the family index, H, an adapter's summary with the
// wire's pin re-pinned, the action schema and its version, h1's rules), with the engine bundle regenerated as
// dev/engine-bundle.mjs would, moves no corpus world's X, id(C), eligibility key or verdict, and no line; the wire's
// hashes move. KR-U10: a saved attempt or a starter is routed to a kernel by its line, or by the manifests its line
// accepts, never by its bundle. And what ea.v1 is made of stays as it shipped: its manifest's executable half and its
// engine. No GPU, no model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageHash, verifyManifest } from '../dev/engine-lib.mjs';
import { BODY_CHECKER } from '../src/contract/adapters/bodies.ts';
import { canonicalHash } from '../src/contract/adapters/canonical.ts';
import { BUNDLE_HASH, ENGINE as KERNEL_ENGINE, EXECUTABLE_HASH, KERNEL_LINE, MANIFEST_HASH, SUPPORT_STATUS_HASH, SUPPORT_STATUSES } from '../src/contract/adapters/identity.ts';
import { ADAPTER_MANIFEST_TEXT, ADAPTERS, SHIPPED_SUPPORT, executableManifest } from '../src/contract/adapters/index.ts';
import { ABI_VERSION } from '../src/contract/adapters/interfaces.ts';
import { ENGINE } from '../src/contract/engine/index.ts';
import { sealSaved } from '../src/loop/replay.ts';
import { parseWorld } from '../src/platform/artifact.ts';
import { LINES, OPENS_LINES, WORLD_LINE, routeBundle } from '../src/platform/lines.ts';
import { openWorld } from '../src/platform/reopen.ts';

const ROOT = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), 'utf8');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** `text` with `from` replaced by `to`, where `from` occurs exactly once: an edit that misses is a broken test. */
const once = (text, from, to, what) => {
    assert.equal(text.split(from).length, 2, `${what}: the edited text occurs exactly once`);
    return text.replace(from, () => to);
};
/** How dev/engine-bundle.mjs writes each of the bundle's files. */
const generated = value => `${JSON.stringify(value, null, 1)}\n`;
const ENGINE_DIR = 'src/contract/engine/';

/**
 * The engine bundle regenerated over edited K, D or H files, as dev/engine-bundle.mjs writes it: each edited file, and
 * bundle.json with their hashes and its bundleHash recomputed. The generator's own check (verifyManifest) passes it.
 */
function regenerated(edits) {
    const texts = Object.fromEntries(['capabilities.json', 'docs.json', 'support.json', 'bundle.json'].map(n => [n, edits[n] ?? read(`${ENGINE_DIR}${n}`)]));
    const bundle = JSON.parse(texts['bundle.json']);
    bundle.capabilities.hash = sha(texts['capabilities.json']);
    bundle.docs.hash = sha(texts['docs.json']);
    bundle.support.hash = sha(texts['support.json']);
    bundle.bundleHash = sha([bundle.engine.packageHash, bundle.capabilities.hash, bundle.docs.hash, bundle.support.hash].join('\n'));
    texts['bundle.json'] = generated(bundle);
    assert.deepEqual(verifyManifest(texts), [], 'the edited bundle is one the generator could have written');
    assert.notEqual(bundle.bundleHash, JSON.parse(read(`${ENGINE_DIR}bundle.json`)).bundleHash, 'the edit moves the bundle');
    return Object.fromEntries([...Object.keys(edits), 'bundle.json'].map(n => [`${ENGINE_DIR}${n}`, texts[n]]));
}

/** The edits of KR-U3: each a file (or files) the model reads, and the wire's hash it must move. */
const EDITS = [
    {
        what: 'a document of D (docs.json), the bundle regenerated', wire: 'bundle',
        files: () => {
            const docs = JSON.parse(read(`${ENGINE_DIR}docs.json`));
            const guide = docs.docs.find(d => d.id === 'agent/guide');
            guide.text = once(guide.text, 'NullGraph is a direct-to-GPU', 'NullGraph is a direct-to-the-GPU', 'agent/guide');
            Object.assign(guide, { bytes: Buffer.byteLength(guide.text, 'utf8'), lines: guide.text.split('\n').length, sha256: sha(guide.text) });
            return regenerated({ 'docs.json': generated(docs) });
        },
    },
    {
        what: 'a family\'s prose in families.json, the family index and the bundle regenerated', wire: 'bundle',
        files: () => {
            const families = JSON.parse(read(`${ENGINE_DIR}families.json`));
            const lights = families.families.find(f => f.id === 'lights');
            const was = lights.summary;
            lights.summary = once(was, 'Lights are 16-float slices', 'Each light is a 16-float slice', 'families.json lights');
            const caps = JSON.parse(read(`${ENGINE_DIR}capabilities.json`));
            caps.families.find(f => f.id === 'lights').summary = lights.summary;
            caps.familyIndex = once(caps.familyIndex, was, lights.summary, 'the family index');
            return { ...regenerated({ 'capabilities.json': generated(caps) }), [`${ENGINE_DIR}families.json`]: generated(families) };
        },
    },
    {
        what: 'a reason of H (support.json), the bundle regenerated', wire: 'bundle',
        files: () => {
            const support = JSON.parse(read(`${ENGINE_DIR}support.json`));
            const loaders = support.entries.find(e => e.family === 'loaders');
            loaders.reason = once(loaders.reason, 'Needs GLB asset files', 'Needs glTF asset files', 'H loaders');
            return regenerated({ 'support.json': generated(support) });
        },
    },
    {
        // What a later head's manifest might tell the model (a family dropped): the worlds of ea.v1 keep its own map.
        what: 'a family\'s status in the model\'s H (support.json: post unsupported), the bundle regenerated', wire: 'bundle',
        files: () => {
            const support = JSON.parse(read(`${ENGINE_DIR}support.json`));
            const post = support.entries.find(e => e.family === 'post');
            assert.equal(post.status, 'unverified');
            post.status = 'unsupported';
            return regenerated({ 'support.json': generated(support) });
        },
    },
    {
        // As it lands: EA-A1 makes the wire's pin follow the text, and that pin is defined inside the kernel's closure, so
        // X reading it instead of ea.v1's constant would move every world here (KR0's independent review).
        what: 'an adapter\'s summary (descriptors.json), the wire\'s pin re-pinned as EA-A1 makes one', wire: ['manifestText', 'manifestPin'],
        files: () => {
            const text = once(read('src/contract/adapters/descriptors.json'), 'four point lights, bound at group 2.', 'four point lights, bound at group two.', 'ng.light.rig\'s summary');
            const index = read('src/contract/adapters/index.ts');
            const pinned = /export const ADAPTER_MANIFEST_HASH = '[0-9a-f]{64}';/.exec(index);
            assert.ok(pinned, 'index.ts pins ADAPTER_MANIFEST_HASH');
            return {
                'src/contract/adapters/descriptors.json': text,
                'src/contract/adapters/index.ts': once(index, pinned[0], `export const ADAPTER_MANIFEST_HASH = '${sha(text.replace(/\r\n/g, '\n'))}';`, 'the wire\'s pin'),
            };
        },
    },
    {
        what: 'a description of the action schema (agent-action.v3.json)', wire: 'actionSchemaText',
        files: () => ({ 'src/contract/agent/agent-action.v3.json': once(read('src/contract/agent/agent-action.v3.json'), 'what is there, and how it moves.', 'what is there, and how it all moves.', 'the design\'s idea') }),
    },
    {
        // A new contract with the model: what a turn and a revision's base name moves; no world does (K7).
        what: 'the action schema\'s version (agent-action.v3 to v9)', wire: 'actionSchema',
        files: () => ({ 'src/contract/agent/index.ts': once(read('src/contract/agent/index.ts'), 'export const AGENT_ACTION_VERSION = \'agent-action.v3\';', 'export const AGENT_ACTION_VERSION = \'agent-action.v9\';', 'the action schema\'s version') }),
    },
    {
        // The studio holds no agent prompt (forge's templates never reach the browser); h1's rules are the one it keeps.
        what: 'h1\'s rules (rules.md), the one prompt the studio holds', wire: 'h1Rules',
        files: () => ({ 'src/contract/h1/rules.md': once(read('src/contract/h1/rules.md'), 'Rules for the function you write', 'The rules for the function you write', 'h1\'s rules') }),
    },
];

const run = promisify(execFile);
/** test/kernel-probe.mjs in a child process, its `?raw` files overridden by `files` (paths from the root, texts). */
async function probe(files = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'kr-u3-'));
    try {
        const overrides = {};
        Object.entries(files).forEach(([path, text], i) => {
            const stand = join(dir, `${i}-${path.split('/').pop()}`);
            writeFileSync(stand, text);
            overrides[fileURLToPath(new URL(path, ROOT))] = stand;
        });
        const { stdout } = await run(process.execPath, ['--import', './test/register.mjs', 'test/kernel-probe.mjs'], {
            cwd: fileURLToPath(ROOT), env: { ...process.env, WEXY_RAW_OVERRIDES: JSON.stringify(overrides) }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
        });
        return JSON.parse(stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('KR-U3 what the model reads is provenance: no edit to it moves a corpus world\'s X, id(C), eligibility or line; the wire\'s hashes move', { timeout: 180_000 }, async () => {
    const base = await probe();
    const worlds = Object.entries(base.worlds);
    assert.ok(worlds.length >= 19, `the corpus and the replays: ${worlds.length}`);
    for (const [name, w] of worlds) {
        assert.equal(w.refused, null, `${name} opens as checked out: ${w.refused}`);
        assert.equal(w.eligibility, null, `${name} is covered by the shipped eligibility as checked out: ${w.eligibility}`);
    }
    // Three at a time: each child seals every world once.
    const results = [];
    for (let i = 0; i < EDITS.length; i += 3) results.push(...await Promise.all(EDITS.slice(i, i + 3).map(async e => ({ e, got: await probe(e.files()) }))));
    // Every edit's outcome before any assertion, so a failure names each edit that moved something, and what.
    const moved = [];
    for (const { e, got } of results) {
        for (const k of [e.wire].flat()) assert.notEqual(got.wire[k], base.wire[k], `${e.what}: the child read the edit (the wire's ${k} moved)`);
        const worldsMoved = worlds.filter(([name, w]) => JSON.stringify(got.worlds[name]) !== JSON.stringify(w))
            .map(([name, w]) => `${name} (${['x', 'candidate', 'eligibilityKey', 'eligibility', 'refused'].filter(k => got.worlds[name]?.[k] !== w[k]).join(', ')})`);
        if (worldsMoved.length) moved.push(`${e.what}: ${worldsMoved.length} of ${worlds.length} worlds moved, e.g. ${worldsMoved.slice(0, 3).join('; ')}`);
        if (JSON.stringify(got.lines) !== JSON.stringify(base.lines)) moved.push(`${e.what}: the lines moved`);
    }
    assert.deepEqual(moved, [], 'what the model reads moved what a world is (K7)');
});

/** The castle replay with its `versions` edited as JSON: the rest of the file as it is. */
const CASTLE = read('dev/replays/castle.json');
const withVersions = edit => { const f = JSON.parse(CASTLE); edit(f.versions); return JSON.stringify(f, null, 2); };

test('KR-U10 a replay or a starter is routed by its line, or by the manifests its line accepts, never by its bundle', async () => {
    const today = await sealSaved(CASTLE);
    assert.equal(today.ok, true, today.reason);
    const same = (r, what) => {
        assert.equal(r.ok, true, `${what}: ${r.reason}`);
        assert.deepEqual([r.replay.snapshot.x.hash, r.replay.snapshot.id], [today.replay.snapshot.x.hash, today.replay.snapshot.id], `${what}: the castle under ea.v1`);
    };
    // The castle replay as committed before cf44937 (Q130's ground moved the manifest, f7f0a0b the bundle; nothing else
    // in the file changed since): manifest 3c777558, bundle d923cc21, byte for byte the committed blob.
    let before = once(CASTLE, '"bundle": "aa60280bae32e3aa780d34352ac42ef9c323d39f201b72cd5dc6c07a562f6824"',
        '"bundle": "d923cc218830b0f90d9ae8ddc20c1f340ed5f58558e07935649ea458e989d646"', 'the replay\'s bundle');
    before = once(before, '"manifest": "8bdd11e8ef2f0ced4b0cabbbac19ca4b6ff0df03fca2d56082005b05b1497220"',
        '"manifest": "3c7775588fb816ce8ccd3660e16d8ae6bfa9526f83174ecf666f8c66ab4c4c77"', 'the replay\'s manifest');
    assert.equal(sha(before), 'e1751a673c97c80cd8ec260b6addf067c6883e87ad47a7a2e4b9a984e9101ed1', 'git show cf44937^:dev/replays/castle.json');
    same(await sealSaved(before), 'the castle replay of 11-02 to 11-05');
    // The starters name no line (recorded 11-05); ea.v1 accepts their manifest.
    for (const id of ['castle', 'voxel-island', 'spiral-galaxy']) {
        const s = await sealSaved(read(`public/worlds/${id}.json`));
        assert.equal(s.ok, true, `starter ${id}: ${s.reason}`);
    }
    // A bundle written after a docs edit names the wire's bundle, which the edit moved: with no line, its manifest routes
    // it; with its line (written since KR0), the line does, and its bundle and manifest are provenance.
    same(await sealSaved(withVersions(v => { v.bundle = 'd'.repeat(64); })), 'another bundle, no line');
    same(await sealSaved(withVersions(v => { v.line = 'ea.v1'; v.bundle = 'd'.repeat(64); v.manifest = 'e'.repeat(64); })), 'another bundle and manifest, its line');
    const refused = async (text, pattern, what) => {
        const r = await sealSaved(text);
        assert.equal(r.ok, false, what);
        assert.match(r.reason, pattern, what);
    };
    // A file whose ABI or checker is not its kernel's is refused, whichever way it is routed.
    await refused(withVersions(v => { v.abi = 'ea-abi.v1'; }), /^KR_LEGACY_ROUTE: 0 matches for 8bdd11e8ef2f…\/ea-abi\.v1\/ea4-body\.v1; supply an explicit reviewed line$/, 'another ABI, no line');
    await refused(withVersions(v => { v.line = 'ea.v1'; v.checker = 'ea4-body.v0'; }), /^KR_IDENTITY ea\.v1: expected ea-abi\.v2\/ea4-body\.v1, got ea-abi\.v2\/ea4-body\.v0; refused before the seal$/, 'another checker, its line');
    // A manifest no line accepts, with no line: refused, never given the newest line.
    await refused(withVersions(v => { v.manifest = '0'.repeat(64); }), /^KR_LEGACY_ROUTE: 0 matches for 000000000000…\/ea-abi\.v2\/ea4-body\.v1; /, 'a manifest no line accepts');
    // A line this build does not ship: refused before anything resolves, never routed by its manifest instead.
    await refused(withVersions(v => { v.line = 'ea.v2'; }), /^KR_UNKNOWN_LINE: line ea\.v2 is not in this build's kernels \(ea\.v1\)$/, 'a line not shipped');
    await refused(withVersions(v => { v.line = 7; }), /^KR_UNKNOWN_LINE: line 7 is not in this build's kernels \(ea\.v1\)$/, 'a line that is not a name');
    // Versions that are there but not an object, or a bundle's format with none, route nowhere: only a fixture, a file
    // with neither a format nor versions, is the head's without naming it (KR0's outside review).
    for (const [what, edit, pattern] of [
        ['null', f => { f.versions = null; }, /^the file's versions are null, not an object naming its kernel \(its line, or its manifest, abi and checker\)$/],
        ['a list', f => { f.versions = []; }, /^the file's versions are a list, not an object naming its kernel/],
        ['a line as text', f => { f.versions = 'ea.v999'; }, /^the file's versions are a string, not an object naming its kernel/],
        ['a number', f => { f.versions = 7; }, /^the file's versions are a number, not an object naming its kernel/],
        ['missing from a bundle', f => { delete f.versions; }, /^the file is wexy-candidate-bundle\.v2 and names no versions: a bundle names the kernel it was written under$/],
        ['null, with no format', f => { delete f.format; f.versions = null; }, /^the file's versions are null, /],
    ]) {
        const f = JSON.parse(CASTLE);
        edit(f);
        await refused(JSON.stringify(f), pattern, `versions ${what}`);
    }
    const fixture = JSON.parse(CASTLE);
    delete fixture.format;
    delete fixture.versions;
    same(await sealSaved(JSON.stringify(fixture)), 'a fixture: neither a format nor versions');
});

test('KR-U13 (KR0\'s half) a legacy route is unique or refused, and a line named is never routed otherwise', () => {
    const v1 = LINES[0];
    const legacy = { manifest: v1.accepts.manifests[0], abi: v1.moduleAbi, checker: v1.checker, bundle: 'd'.repeat(64) };
    assert.deepEqual(routeBundle(legacy), { ok: true, line: 'ea.v1' });
    // A test registry: a second line that accepts the same manifest under the same ABI and checker. Neither is guessed.
    const twin = Object.freeze({ ...v1, line: 'ea.v9', status: 'head' });
    const two = routeBundle(legacy, [v1, twin]);
    assert.deepEqual([two.ok, two.code], [false, 'KR_LEGACY_ROUTE']);
    assert.match(two.reason, /^KR_LEGACY_ROUTE: 2 matches for 3c7775588fb8…\/ea-abi\.v2\/ea4-body\.v1; supply an explicit reviewed line$/);
    // A file that names its line goes there, ambiguity or not; a line not shipped refuses, whatever its manifest.
    assert.deepEqual(routeBundle({ ...legacy, line: 'ea.v9' }, [v1, twin]), { ok: true, line: 'ea.v9' });
    const unknown = routeBundle({ ...legacy, line: 'ea.v2' });
    assert.deepEqual([unknown.ok, unknown.code], [false, 'KR_UNKNOWN_LINE']);
    // The table itself: one head, unique lines, each a line's shape, and the head's kernel is the one that ships.
    assert.deepEqual(LINES.filter(l => l.status === 'head').map(l => l.line), [WORLD_LINE]);
    assert.equal(new Set(OPENS_LINES).size, LINES.length);
    assert.ok(Object.isFrozen(LINES) && Object.isFrozen(LINES[0].accepts.manifests));
});

test('KR0 ea.v1\'s identity: X names its own constants, its H is its own, and the head\'s table names its kernel', async () => {
    // The corpus castle (saved 11-04, under bundle d923cc21 and manifest 3c777558) opens to the X recorded, which names
    // ea.v1's constants: the values the pins and the shipped eligibility already hold (no fixture recorded again).
    const expected = JSON.parse(read('test/fixtures/worlds/expected.json'));
    const castle = await openWorld((await parseWorld(read('test/fixtures/worlds/castle.wexy-world.json'), null)).world, 'kr0');
    assert.equal(castle.ok, true, castle.reason);
    const id = castle.snapshot.x.identity;
    assert.deepEqual([id.bundleHash, id.manifestHash, id.supportStatusHash], [BUNDLE_HASH, MANIFEST_HASH, SUPPORT_STATUS_HASH]);
    assert.deepEqual([expected.pins.bundle, expected.pins.manifest], [BUNDLE_HASH, MANIFEST_HASH]);
    assert.equal(castle.snapshot.x.hash, expected.worlds.castle.x);
    const shipped = JSON.parse(read('src/exec/eligibility.json'));
    assert.deepEqual([...new Set(shipped.entries.map(e => e.engineBundleHash))], [BUNDLE_HASH], 'eligibility is keyed by ea.v1\'s constant');
    // ea.v1's H: the map the node check reads, hashed as X names it.
    assert.deepEqual(Object.fromEntries(SHIPPED_SUPPORT), { ...SUPPORT_STATUSES });
    assert.equal(await canonicalHash({ ...SUPPORT_STATUSES }), SUPPORT_STATUS_HASH);
    assert.ok(Object.isFrozen(SUPPORT_STATUSES));
    // What the model reads is what runs (EA-H's rule): the model's H never offers a family the head's kernel refuses.
    const statically = new Set(['unverified', 'supported', 'device-blocked']);
    for (const e of ENGINE.support.entries) {
        if (statically.has(e.status)) assert.ok(statically.has(SUPPORT_STATUSES[e.family]), `the model's H offers ${e.family}, which ea.v1 refuses`);
    }
    // The head's entry in the table is this kernel.
    const head = LINES.find(l => l.line === WORLD_LINE);
    assert.deepEqual([head.line, head.moduleAbi, head.checker], [KERNEL_LINE, ABI_VERSION, BODY_CHECKER]);
    assert.ok(head.accepts.manifests.includes(MANIFEST_HASH), 'the head accepts what it names');
});

test('KR0 what runs of the manifest is ea.v1\'s: its executable half is pinned; a summary moves only the wire', () => {
    const half = text => sha(executableManifest(text));
    assert.equal(half(ADAPTER_MANIFEST_TEXT), EXECUTABLE_HASH,
        'KR_SEALED_CHANGED ea.v1: descriptors.json\'s executable half (every id, version, schema, port, layout and gate) is not the one ea.v1 shipped. '
        + 'ea.v1 is released and frozen (render-kernels Q141 (b), K3): undo the change, or build it as the next line once ea.v1 is sealed (§8.1). '
        + 'Only a summary, which the model reads, may change here, and it moves only the wire (EA-A1)');
    const edited = change => { const m = JSON.parse(ADAPTER_MANIFEST_TEXT); change(m); return JSON.stringify(m, null, 2); };
    const rig = m => m.adapters.find(a => a.id === 'ng.light.rig');
    // Prose: an adapter's summary and a layout's.
    assert.equal(half(edited(m => { rig(m).summary += ' Edited for the model.'; })), EXECUTABLE_HASH, 'an adapter\'s summary');
    assert.equal(half(edited(m => { m.layouts.f32.summary = 'Plain floats.'; })), EXECUTABLE_HASH, 'a layout\'s summary');
    // What runs: each of these moves it.
    for (const [what, change] of [
        ['a port\'s count', m => { rig(m).outputs.push({ name: 'more', kind: 'lights' }); }],
        ['an adapter\'s version', m => { rig(m).version = 2; }],
        ['a config schema', m => { m.adapters.find(a => a.id === 'ng.post.chain').config.properties.effects.maxItems = 7; }],
        ['a gate\'s reason, which X\'s gatesHash hashes', m => { m.unavailable[0].reason = 'not yet'; }],
        ['a layout\'s stride', m => { m.layouts.instance24.strideFloats = 25; }],
        ['the engine it wraps', m => { m.engine = 'null-graph@1.3.0'; }],
    ]) assert.notEqual(half(edited(change)), EXECUTABLE_HASH, what);
});

test('KR0 the engine ea.v1 draws with is its own: null-graph and gl-matrix exactly as locked; a new engine is a new line', () => {
    // Until KR0 the bundle's hash carried the package's into X, so an upgrade moved every world; X now names a constant,
    // and this holds what is installed instead (KR0's independent review).
    const k3 = what => `KR_SEALED_CHANGED ea.v1: ${what}. ea.v1 draws with ${KERNEL_ENGINE.name} ${KERNEL_ENGINE.version} and is released and frozen `
        + '(render-kernels Q141 (b), K3; §9.1: a new null-graph is a new line, always): undo it, or build it as the next line once ea.v1 is sealed (§8.1)';
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(pkg.dependencies[KERNEL_ENGINE.name], KERNEL_ENGINE.version, k3(`package.json asks for ${KERNEL_ENGINE.name} ${pkg.dependencies[KERNEL_ENGINE.name]}`));
    const locked = lock.packages[`node_modules/${KERNEL_ENGINE.name}`];
    assert.deepEqual([locked?.version, locked?.integrity], [KERNEL_ENGINE.version, KERNEL_ENGINE.integrity], k3(`the lockfile resolves another ${KERNEL_ENGINE.name}`));
    assert.deepEqual(Object.keys(locked.dependencies ?? {}).sort(), Object.keys(KERNEL_ENGINE.dependencies).sort(), k3(`${KERNEL_ENGINE.name} depends on other packages`));
    for (const [name, want] of Object.entries(KERNEL_ENGINE.dependencies)) {
        // Where npm put it: under the engine when it is not hoisted, else beside it.
        const where = [`node_modules/${KERNEL_ENGINE.name}/node_modules/${name}`, `node_modules/${name}`].find(k => lock.packages[k]);
        const got = where ? lock.packages[where] : undefined;
        assert.deepEqual([got?.version, got?.integrity], [want.version, want.integrity], k3(`the lockfile resolves another ${name}`));
        assert.equal(JSON.parse(read(`${where}/package.json`)).version, want.version, k3(`${name} ${want.version} is not what is installed`));
    }
    assert.equal(JSON.parse(read(`node_modules/${KERNEL_ENGINE.name}/package.json`)).version, KERNEL_ENGINE.version, k3('another version is installed'));
    assert.equal(packageHash(fileURLToPath(new URL(`node_modules/${KERNEL_ENGINE.name}`, ROOT))), KERNEL_ENGINE.packageHash, k3('the installed declarations are not the ones ea.v1 shipped with'));
    assert.equal(ADAPTERS.engine, `${KERNEL_ENGINE.name}@${KERNEL_ENGINE.version}`, 'X names the engine it draws with');
    assert.ok(Object.isFrozen(KERNEL_ENGINE) && Object.isFrozen(KERNEL_ENGINE.dependencies['gl-matrix']));
});

const ts = createRequire(import.meta.url)('typescript');

/**
 * The module specifiers a TypeScript source names, read by TypeScript's own parser, so a quote style, a comment or a
 * string never decides what is found (KR0's outside review: a pattern for single quotes missed `"…"`): every import and
 * export (type-only ones too), a side effect's, an `import()` call's and an `import('…')` type's. And every `import()`
 * whose argument is not a literal, which no walk can follow.
 */
function specifiersOf(file, source) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const literal = [];
    const nonLiteral = [];
    const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            literal.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [arg] = node.arguments;
            if (arg && ts.isStringLiteralLike(arg)) literal.push(arg.text);
            else nonLiteral.push(node.getText(sf));
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            literal.push(node.argument.literal.text);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
            literal.push(node.moduleReference.expression.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { literal, nonLiteral };
}

test('KR-U3 (its static half) the import walker reads every way a source names a module, and nothing else', () => {
    const fixture = [
        "import a from '../engine/bundle.json?raw';",
        'import b from "../engine/support.json?raw";',
        "import type { C } from './c';",
        'import {',
        '    d,',
        '    type E,',
        '} from "./d";',
        "export * from './f';",
        'export { g } from "./g";',
        "import './h';",
        'import "./h2";',
        "const i = await import('./i');",
        'const j = await import("./j");',
        "type K = import('./k').K;",
        "// import l from './l';",
        "/* import m from './m'; */",
        "const n = `import o from './o';`;",
        "const p = 'import q from \"./q\"';",
        "const name = './r';",
        'const s = await import(name);',
    ].join('\n');
    const { literal, nonLiteral } = specifiersOf('fixture.ts', fixture);
    assert.deepEqual(literal, ['../engine/bundle.json?raw', '../engine/support.json?raw', './c', './d', './f', './g', './h', './h2', './i', './j', './k']);
    assert.deepEqual(nonLiteral, ['import(name)'], 'an import no walk can follow is named, never skipped');
});

/**
 * Every file the given sources reach through their imports, static and dynamic, type-only ones too (the safe
 * direction: what a sealed copy would need), as paths from the frontend's root; bare names as they are written.
 */
function closure(roots) {
    const ROOT_DIR = fileURLToPath(ROOT);
    const seen = new Set();
    const visit = file => {
        if (seen.has(file)) return;
        seen.add(file);
        if (!file.endsWith('.ts')) return;
        const { literal, nonLiteral } = specifiersOf(file, readFileSync(join(ROOT_DIR, file), 'utf8'));
        assert.deepEqual(nonLiteral, [], `${file} imports by an expression, which no walk can follow (render-kernels §5.1)`);
        for (const spec of literal) {
            if (!spec.startsWith('.')) { seen.add(spec); continue; }
            const base = join(dirname(file), spec.replace(/\?raw$/, '')).replace(/\\/g, '/');
            const found = [base, `${base}.ts`, `${base}/index.ts`].find(p => existsSync(join(ROOT_DIR, p)) && statSync(join(ROOT_DIR, p)).isFile());
            assert.ok(found, `${file} imports ${spec}, which is not on disk`);
            visit(found);
        }
    };
    for (const r of roots) visit(r);
    return [...seen];
}

test('KR-U3 (its static half) the rendering path reads none of what the model reads: no engine bundle file, H or engine index', () => {
    // render-kernels §6's entry files: the resolver and X's checks, the interfaces and bodies, the executor and its
    // engine port, bounds, the camera path, and the seal.
    const reached = closure([
        'src/contract/adapters/resolve.ts', 'src/contract/adapters/checks.ts', 'src/contract/adapters/interfaces.ts', 'src/contract/adapters/bodies.ts',
        'src/exec/engine-executor.ts', 'src/exec/world-runtime.ts', 'src/exec/null-graph-port.ts', 'src/exec/bounds.ts', 'src/runtime/camera-path.ts',
        'src/loop/snapshot.ts',
    ]);
    assert.ok(reached.includes('src/contract/adapters/identity.ts') && reached.includes('src/contract/adapters/descriptors.json'), 'the walk follows imports');
    assert.ok(reached.includes('null-graph'), 'and names the engine package');
    const modelReads = /^src\/contract\/engine\/(?!frozen\.ts$)|^src\/contract\/h1\/|^src\/forge-client\//;
    assert.deepEqual(reached.filter(p => modelReads.test(p)), [],
        'X\'s identity, the node check, the interfaces and the executor reach the engine bundle, H, h1 or the wire: what the model reads would move what a world is (K7)');
});
