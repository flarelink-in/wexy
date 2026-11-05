// The engine bundle of EA1 (engine-aware design §5.1, §5.2; src/contract/engine/): K, every export of the installed
// null-graph with its declaration, doc comment and the documents that mention it, with the hand-reviewed family map
// (families.json) and its prompt index; D, null-graph's agent guide, API pages, migration notes, package README and
// runnable starters, each with its source, size and hash; H, the support manifest (a family resolves only through the
// adapters src/contract/adapters/descriptors.json names, and one no adapter runs is unsupported); and the manifest
// pinning all of it to the installed package. Deterministic: the same inputs write the same
// bytes. The documents come from the checkout's commit (git show), never its working tree, so the bundle is exactly
// one commit's. It refuses rather than guesses: a checkout of another version, or one whose exports map, sources'
// export names (subpath by subpath) or tracked dist/index.js are not the installed package's; a package and documents
// no reviewed record in compat.json pairs; a stale mention no reviewed exception accepts; a family that names a symbol
// its subpath does not export; an index over its 12 KiB budget. The extraction, the comparisons and the hashes are
// dev/engine-lib.mjs, shared with test/engine.test.mjs.
//   node --import ./test/register.mjs dev/engine-bundle.mjs [--repo D:/orion-realms/null-graph] [--worktree] [--check]
// --worktree reads the checkout's working tree instead, for a release built but not yet committed there; the bundle
// then names its source `<commit>+worktree` and lists the uncommitted bundled files. --check writes nothing, and
// exits 1 when the bundle on disk is not what the inputs give.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifiers, staleMentions } from '../src/contract/engine/scan.ts';
import { compareExports, extractSymbols, lf, packageHash, sha256, sourceExports } from './engine-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const REPO = resolve(opt('repo', 'D:/orion-realms/null-graph'));
const CHECK = argv.includes('--check');
const WORKTREE = argv.includes('--worktree');
const PKG = join(ROOT, 'node_modules', 'null-graph');
const OUT = join(ROOT, 'src', 'contract', 'engine');
const INDEX_BUDGET = 12 * 1024;

const read = p => lf(readFileSync(p, 'utf8'));
const fail = message => { console.error(`engine-bundle: ${message}`); process.exit(2); };

// ---- the inputs: the installed package and a checkout of the same version for its documents
if (!existsSync(join(REPO, '.git'))) fail(`no null-graph checkout at ${REPO}; pass --repo`);
const git = args => lf(execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const commit = git(['rev-parse', '--short', 'HEAD']).trim();
/** A file as the commit has it (the working tree may hold someone's edit in progress), or as the tree has it with --worktree. */
const show = path => (WORKTREE ? read(join(REPO, path)) : git(['show', `${commit}:${path}`]));
const SOURCE = WORKTREE ? `null-graph@${commit}+worktree` : `null-graph@${commit}`;
const BUNDLED_PATHS = ['package.json', 'docs/agent/guide.md', 'docs/api', 'docs/deprecated-api.md', 'test/gpu/scenes/quick-start.mjs', 'test/gpu/scenes/instancing.mjs', 'test/gpu/scenes/culling.mjs'];
// Only the trailing newline goes: a status line starts with a space (" M path"), and trimming it would cut the path.
const dirty = git(['status', '--porcelain', '--', ...BUNDLED_PATHS]).replace(/\n+$/, '');
const uncommitted = WORKTREE ? dirty.split('\n').filter(Boolean).map(l => l.slice(3).trim()).sort() : [];

// ---- K: every export of every subpath, as the TypeScript compiler reads the installed declarations
let surface;
try { surface = extractSymbols(PKG, ROOT); } catch (e) { fail(e.message); }
const { pkg, subpaths, declared } = surface;
const symbols = surface.symbols.map(s => ({ ...s, docIds: [] }));
const PACKAGE_HASH = packageHash(PKG);

// ---- the checkout against the installed package: the same version, exports map, export names and core bundle (review 3)
const repoPkg = JSON.parse(show('package.json'));
if (repoPkg.version !== pkg.version) {
    fail(`${SOURCE} is null-graph ${repoPkg.version} and the installed package ${pkg.version}: commit the release in the checkout, or pass --worktree if its working tree is ${pkg.version}`);
}
if (JSON.stringify(repoPkg.exports) !== JSON.stringify(pkg.exports)) fail(`${SOURCE}'s exports map is not the installed package's: its documents describe another surface`);
/** `fn` of a directory holding the commit's src/, written for the compiler and removed after; the checkout itself with --worktree. */
const withSources = fn => {
    if (WORKTREE) return fn(REPO);
    const dir = mkdtempSync(join(tmpdir(), 'engine-bundle-'));
    try {
        const paths = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', 'src']).split('\0').filter(Boolean);
        const blobs = execFileSync('git', ['-C', REPO, 'cat-file', '--batch'], { input: paths.map(p => `${commit}:${p}\n`).join(''), maxBuffer: 256 * 1024 * 1024 });
        let at = 0;
        for (const p of paths) {
            const eol = blobs.indexOf(10, at);
            const [, type, size] = blobs.toString('latin1', at, eol).split(' ');
            if (type !== 'blob') throw new Error(`${commit}:${p} is not a file`);
            mkdirSync(dirname(join(dir, p)), { recursive: true });
            writeFileSync(join(dir, p), blobs.subarray(eol + 1, eol + 1 + Number(size)));
            at = eol + 1 + Number(size) + 1;
        }
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
let sourceProblems;
try { sourceProblems = withSources(dir => compareExports(sourceExports(dir, repoPkg, ROOT), declared)); } catch (e) { fail(e.message); }
if (sourceProblems.length) {
    fail(`${SOURCE}'s sources do not export what the installed package declares: ${sourceProblems.slice(0, 8).join('; ')}${sourceProblems.length > 8 ? ` and ${sourceProblems.length - 8} more` : ''}`);
}
const distTracked = WORKTREE || git(['ls-files', '--', 'dist/index.js']).trim() === 'dist/index.js';
const distSame = distTracked ? show('dist/index.js') === read(join(PKG, 'dist/index.js')) : null;
if (distSame === false) fail(`${SOURCE}'s dist/index.js is not the installed package's: the checkout is not the release that is installed`);
const compatibility = `the exports map is the installed package's; ${WORKTREE ? 'the working tree\'s' : `commit ${commit}'s`} sources export the installed `
    + `package's ${symbols.length} names, subpath by subpath; dist/index.js (the core bundle, the one built file the checkout tracks) `
    + `${distSame === null ? 'is not tracked there, so not compared' : 'is byte-identical to the installed package\'s'}`;

// ---- a reviewed record must pair this package with these documents (compat.json, written by a reviewer)
const compat = JSON.parse(read(join(OUT, 'compat.json')));
const record = compat.records.find(r => r.packageHash === PACKAGE_HASH && r.docs === SOURCE);
if (!record) {
    fail(`no reviewed record pairs the installed null-graph ${pkg.version} (package hash ${PACKAGE_HASH}) with ${SOURCE}. `
        + `Automatic checks: ${compatibility}. Review the documents against the declarations, then add `
        + `{ "packageHash": "${PACKAGE_HASH}", "docs": "${SOURCE}", "reviewed": "<date>", "evidence": "<what was checked>" } to compat.json's records.`);
}

// ---- D: the documents, from the checkout's commit and the package
const titleOf = (text, id) => (/^# (.+)$/m.exec(text)?.[1] ?? /^\/\/\s*(.+)$/m.exec(text)?.[1] ?? id).trim();
const docs = [];
const add = (id, text, source) => {
    docs.push({ id, title: titleOf(text, id), source, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length, sha256: sha256(text), text });
};
const fromCommit = (id, path) => add(id, show(path), `${SOURCE}:${path}`);
fromCommit('agent/guide', 'docs/agent/guide.md');
const apiPages = WORKTREE
    ? readdirSync(join(REPO, 'docs/api')).filter(f => f.endsWith('.md')).map(f => `docs/api/${f}`)
    : git(['ls-tree', '--name-only', commit, 'docs/api/']).trim().split('\n').filter(p => p.endsWith('.md'));
for (const path of apiPages.sort()) fromCommit(`api/${path.slice('docs/api/'.length, -3)}`, path);
fromCommit('api/deprecated', 'docs/deprecated-api.md');
add('npm/readme', read(join(PKG, 'README.md')), `npm:null-graph@${pkg.version}/README.md`);
for (const s of ['quick-start', 'instancing', 'culling']) fromCommit(`example/${s}`, `test/gpu/scenes/${s}.mjs`);
docs.sort((a, b) => (a.id < b.id ? -1 : 1));
const docIds = new Set(docs.map(d => d.id));
const tokens = new Map(docs.map(d => [d.id, identifiers(d.text)]));
for (const s of symbols) s.docIds = docs.filter(d => tokens.get(d.id).has(s.name)).map(d => d.id);

// ---- stale mentions: each must be a reviewed exception with a reason (review 2)
const reviewedStale = new Map(compat.reviewedStale.map(r => [`${r.doc}|${r.family}|${r.name}|${r.how}`, r.reason]));
const stale = staleMentions(docs, declared).map(s => ({ ...s, reason: reviewedStale.get(`${s.doc}|${s.family}|${s.name}|${s.how}`) ?? null }));
const unreviewed = stale.filter(s => !s.reason);
if (unreviewed.length) {
    fail(`documents name what ${pkg.version} does not export, with no reviewed exception: ${unreviewed.map(s => `${s.doc} ${s.how} ${s.family}.${s.name}`).join('; ')}. `
        + 'Fix the documents in null-graph, or add each to compat.json\'s reviewedStale with a reason.');
}

// ---- the family map, checked against what is real
const map = JSON.parse(read(join(OUT, 'families.json')));
if (map.engine !== `null-graph@${pkg.version}`) fail(`families.json describes ${map.engine}, the package is ${pkg.version}: review it for this version`);
const familyIds = Object.keys(declared);
if (map.families.map(f => f.id).join() !== familyIds.join()) fail(`families.json must map every subpath once, in the package's order: ${familyIds.join(', ')}`);
const families = map.families.map((f, i) => {
    if (f.subpath !== (subpaths[i] === '.' ? 'null-graph' : `null-graph/${subpaths[i].slice(2)}`)) fail(`${f.id}: subpath ${f.subpath}`);
    for (const k of f.keySymbols) if (!declared[f.id].includes(k)) fail(`${f.id}: key symbol ${k} is not exported by ${f.subpath}`);
    for (const d of [...f.docs, ...f.examples]) if (!docIds.has(d)) fail(`${f.id}: document ${d} is not in the bundle`);
    if (!['world', 'host', 'external'].includes(f.use)) fail(`${f.id}: use ${f.use}`);
    if (f.use !== 'world' && !f.reason) fail(`${f.id}: a ${f.use} family needs a reason`);
    return { ...f, symbolCount: declared[f.id].length };
});

// ---- which families Wexy runs: those its adapter manifest names, and no other (the Tier 1 audit of 11-05: the index
// said every world family "may" be used, shadows and fog among them, while no adapter ran any of them)
const adapterManifest = JSON.parse(read(join(ROOT, 'src', 'contract', 'adapters', 'descriptors.json')));
const adaptersOf = id => adapterManifest.adapters.filter(a => a.family === id).map(a => a.id);
for (const a of adapterManifest.adapters) {
    if (!families.some(f => f.id === a.family && f.use === 'world')) fail(`adapter ${a.id}: family ${a.family} is not a world family of families.json`);
}
for (const f of families.filter(x => x.use === 'world')) {
    if (adaptersOf(f.id).length && !f.reason) fail(`${f.id}: Wexy runs it through ${adaptersOf(f.id).join(', ')}; its reason must say what they take`);
    if (!adaptersOf(f.id).length && f.reason) fail(`${f.id}: no adapter runs it, so its reason must be null (the index says so itself)`);
}

// ---- the prompt's family index: every family, or nothing (design §5.1)
const statusOf = f => {
    if (f.use === 'host') return `host only: ${f.reason}`;
    if (f.use === 'external') return `unavailable: ${f.reason}`;
    const ids = adaptersOf(f.id);
    return ids.length ? `Wexy runs it only through ${ids.join(', ')}. ${f.reason}` : 'no Wexy adapter: never plan with it.';
};
const familyIndex = [
    `# null-graph ${pkg.version}: every family, and what Wexy can run`,
    'Names are exact: use only these. A program names Wexy\'s adapters, never null-graph\'s classes. Read a family\'s documents before planning with it.',
    '',
    ...families.flatMap(f => [
        `## ${f.id} · ${f.subpath} · ${f.title}`,
        `Status: ${statusOf(f)}`,
        f.summary,
        `Key: ${f.keySymbols.join(', ')} (${f.symbolCount} export${f.symbolCount === 1 ? '' : 's'}).`,
        // A family no adapter runs keeps its summary for discovery, not the notes on using it.
        ...(f.use === 'world' && !adaptersOf(f.id).length ? [] : f.notes).map(n => `- ${n}`),
        `Docs: ${[...f.docs, ...f.examples].join(', ')}.`,
        '',
    ]),
].join('\n');
const indexBytes = Buffer.byteLength(familyIndex, 'utf8');
if (indexBytes > INDEX_BUDGET) fail(`the family index is ${indexBytes} bytes, over its ${INDEX_BUDGET}: shorten families.json, never drop a family`);

// ---- H: a family resolves only through the adapters the manifest names. Their device verification is eligibility's
// (src/exec/eligibility.json), per adapter, so a family stays unverified; one no adapter runs is unsupported (Tier 2).
const support = {
    version: 'ea-h2',
    engine: `null-graph@${pkg.version}`,
    entries: families.map(f => {
        if (f.use !== 'world') return { family: f.id, status: 'unsupported', adapter: null, reason: f.reason };
        const ids = adaptersOf(f.id);
        return ids.length
            ? { family: f.id, status: 'unverified', adapter: ids.join(', '), reason: `Tier 1, through these adapters alone. ${f.reason}` }
            : { family: f.id, status: 'unsupported', adapter: null, reason: 'No Wexy adapter (the engine-aware design\'s Tier 2): a program cannot name it.' };
    }),
};

// ---- write (or compare), then the manifest of hashes
const json = v => `${JSON.stringify(v, null, 1)}\n`;
const files = {
    'capabilities.json': json({ version: 'ea-k1', engine: `null-graph@${pkg.version}`, families, familyIndex, symbols }),
    'docs.json': json({ version: 'ea-d1', source: SOURCE, uncommitted, docs, review: { stale } }),
    'support.json': json(support),
};
const hashes = Object.fromEntries(Object.entries(files).map(([n, t]) => [n, sha256(t)]));
files['bundle.json'] = json({
    version: 'ea-b1',
    engine: { name: 'null-graph', version: pkg.version, packageHash: PACKAGE_HASH },
    docs: { source: SOURCE, count: docs.length, hash: hashes['docs.json'] },
    capabilities: { families: families.length, symbols: symbols.length, hash: hashes['capabilities.json'] },
    support: { hash: hashes['support.json'] },
    bundleHash: sha256([PACKAGE_HASH, hashes['capabilities.json'], hashes['docs.json'], hashes['support.json']].join('\n')),
});
const changed = Object.entries(files).filter(([n, t]) => !existsSync(join(OUT, n)) || read(join(OUT, n)) !== t).map(([n]) => n);
if (!CHECK) for (const n of changed) writeFileSync(join(OUT, n), files[n]);

// ---- the coverage report
const documented = symbols.filter(s => s.summary).length;
const mentioned = symbols.filter(s => s.docIds.length).length;
console.log(`null-graph ${pkg.version} (documents from ${SOURCE}${uncommitted.length ? `, uncommitted: ${uncommitted.join(', ')}` : ''}; reviewed ${record.reviewed}): ${families.length} families, ${symbols.length} exports, ${documented} with a doc comment, ${mentioned} named by a bundled document; ${docs.length} documents, ${Math.round(docs.reduce((n, d) => n + d.bytes, 0) / 1024)} KB; family index ${indexBytes} of ${INDEX_BUDGET} bytes`);
console.log(`compatibility: ${compatibility}`);
for (const f of families) {
    const own = symbols.filter(s => s.family === f.id);
    const bare = own.filter(s => !s.summary && !s.docIds.length).map(s => s.name);
    console.log(`  ${f.id.padEnd(12)} ${String(own.length).padStart(4)} exports  ${String(own.filter(s => s.summary).length).padStart(4)} commented  ${String(own.filter(s => s.docIds.length).length).padStart(4)} in docs  ${f.use.padEnd(8)} ${bare.length ? `neither: ${bare.slice(0, 6).join(', ')}${bare.length > 6 ? ` and ${bare.length - 6} more` : ''}` : ''}`);
}
if (dirty && !WORKTREE) console.log(`note: the checkout has uncommitted changes in bundled paths; the bundle uses commit ${commit}'s text:\n${dirty}`);
console.log(stale.length ? `stale mentions, each a reviewed exception: ${stale.map(s => `${s.doc} ${s.how} ${s.family}.${s.name} (${s.reason})`).join('; ')}` : 'stale mentions: none');
if (CHECK) {
    console.log(changed.length ? `stale bundle: ${changed.join(', ')} would change` : 'the bundle is current');
    process.exit(changed.length ? 1 : 0);
}
console.log(changed.length ? `wrote ${changed.join(', ')}` : 'nothing to write: the bundle is current');
