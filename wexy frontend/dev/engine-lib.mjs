// What dev/engine-bundle.mjs builds the engine bundle with and test/engine.test.mjs checks it with (EA1), so the two
// cannot drift: the installed package's identity and surface as the TypeScript compiler reads its declarations, the
// manifest's hashes recomputed from the bundle's own files, and the bundle's symbols compared field by field with the
// installed ones. Node only (it needs node:crypto and the typescript package); nothing here ships.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

export const lf = s => s.replace(/\r\n/g, '\n');
export const sha256 = s => createHash('sha256').update(s).digest('hex');
const read = p => lf(readFileSync(p, 'utf8'));
const posix = p => p.split(sep).join('/');
export const familyOf = sub => (sub === '.' ? 'core' : sub.slice(2));
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The installed package's identity: package.json and every declaration file, by path, LF line ends. */
export function packageHash(pkgDir) {
    const files = [];
    const walk = dir => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.d.ts')) files.push(posix(relative(pkgDir, p))); } };
    walk(join(pkgDir, 'dist'));
    const h = createHash('sha256').update(read(join(pkgDir, 'package.json')));
    for (const f of files.sort()) h.update(`\n${f}\n`).update(read(join(pkgDir, f)));
    return h.digest('hex');
}

/**
 * Every export of every subpath of the package in `pkgDir`, as the TypeScript compiler (from `toolRoot`'s
 * node_modules) reads the declarations: id, family, name, kind, whether it is WGSL, the first paragraph of its doc
 * comment, its declaration as written (doc comment kept, private members and their comments dropped), its file.
 * Sorted by the package's subpath order, then name. Throws when a name is exported twice.
 */
export function extractSymbols(pkgDir, toolRoot) {
    const ts = createRequire(join(toolRoot, 'package.json'))('typescript');
    const pkg = JSON.parse(read(join(pkgDir, 'package.json')));
    const kindOf = s => {
        const f = s.flags;
        if (f & ts.SymbolFlags.Class) return 'class';
        if (f & ts.SymbolFlags.Function) return 'function';
        if (f & ts.SymbolFlags.Enum) return 'enum';
        if (f & ts.SymbolFlags.Interface) return 'interface';
        if (f & ts.SymbolFlags.TypeAlias) return 'type';
        if (f & ts.SymbolFlags.Variable) return 'const';
        return 'other';
    };
    const summaryOf = doc => {
        const first = (doc.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
        if (first.length <= 280) return first;
        const cut = first.slice(0, 280);
        return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
    };
    const declarationText = d => {
        const sf = d.getSourceFile();
        const node = ts.isVariableDeclaration(d) ? d.parent.parent : d;
        const lines = [...(node.jsDoc ?? []).map(j => j.getText(sf)), node.getText(sf)].join('\n').split('\n');
        const kept = [];
        for (const line of lines) {
            if (/^\s*(private\b|#private;)/.test(line)) {
                // Drop the doc comment that belonged to the private member, if one sits right above it.
                if (kept.length && /\*\/\s*$/.test(kept[kept.length - 1])) {
                    while (kept.length && !/^\s*\/\*\*/.test(kept[kept.length - 1])) kept.pop();
                    kept.pop();
                }
                continue;
            }
            kept.push(line);
        }
        return lf(kept.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
    };

    const subpaths = Object.keys(pkg.exports);
    const entryFile = sub => join(pkgDir, pkg.exports[sub].types ?? pkg.exports[sub].import?.types);
    // One program for every entry point: the declarations are read and checked once.
    const program = ts.createProgram(subpaths.map(entryFile), { noEmit: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const symbols = [];
    const seen = new Set();
    for (const sub of subpaths) {
        for (const s of checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entryFile(sub))))) {
            if (seen.has(s.name)) throw new Error(`${s.name} is exported twice (by ${sub} and another subpath); ids would collide`);
            seen.add(s.name);
            const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
            const decls = target.declarations ?? [];
            symbols.push({
                id: `${familyOf(sub)}:${s.name}`,
                family: familyOf(sub),
                name: s.name,
                kind: kindOf(target),
                wgsl: /WGSL/.test(s.name) || /^build\w*(Shader|WGSL)$/.test(s.name),
                summary: summaryOf(ts.displayPartsToString(target.getDocumentationComment(checker)).trim()),
                declaration: decls.map(declarationText).join('\n\n'),
                file: decls[0] ? posix(relative(pkgDir, decls[0].getSourceFile().fileName)) : '',
            });
        }
    }
    const order = new Map(subpaths.map((sub, i) => [familyOf(sub), i]));
    symbols.sort((a, b) => order.get(a.family) - order.get(b.family) || byName(a.name, b.name));
    const declared = {};
    for (const sub of subpaths) declared[familyOf(sub)] = [];
    for (const s of symbols) declared[s.family].push(s.name);
    return { pkg, subpaths, symbols, declared };
}

/**
 * The names each subpath of `pkg` exports, as the TypeScript compiler reads the sources under `srcRoot` instead of
 * the built declarations: the subpath whose declarations are `./dist/<dir>/index.d.ts` is `src/<dir>/index.ts`
 * (null-graph's tsc layout). Against extractSymbols' `declared`, it tells whether a checkout is the code the installed
 * package was built from, for every subpath, where its tracked build output covers only the core.
 */
export function sourceExports(srcRoot, pkg, toolRoot) {
    const ts = createRequire(join(toolRoot, 'package.json'))('typescript');
    const subpaths = Object.keys(pkg.exports);
    const entryOf = sub => {
        const types = pkg.exports[sub].types ?? pkg.exports[sub].import?.types ?? '';
        const m = /^\.\/dist\/(.+)\/index\.d\.ts$/.exec(types);
        if (!m) throw new Error(`${sub}: its declarations ${types} have no source entry`);
        return join(srcRoot, 'src', m[1], 'index.ts');
    };
    const options = { noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10 };
    const program = ts.createProgram(subpaths.map(entryOf), options);
    const checker = program.getTypeChecker();
    const declared = {};
    for (const sub of subpaths) {
        const source = program.getSourceFile(entryOf(sub));
        if (!source) throw new Error(`${sub}: no source at ${entryOf(sub)}`);
        declared[familyOf(sub)] = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).map(s => s.name).sort(byName);
    }
    return declared;
}

/** Two family-to-names maps, as problems: a subpath only one has, a name only one exports. */
export function compareExports(fromSources, installed) {
    const problems = [];
    for (const family of new Set([...Object.keys(installed), ...Object.keys(fromSources)])) {
        const src = fromSources[family];
        const inst = installed[family];
        if (!src || !inst) { problems.push(`${family}: a subpath the ${src ? 'installed package does' : 'sources do'} not have`); continue; }
        for (const n of inst) if (!src.includes(n)) problems.push(`${family}:${n}: installed, not exported by the sources`);
        for (const n of src) if (!inst.includes(n)) problems.push(`${family}:${n}: exported by the sources, not installed`);
    }
    return problems;
}

/** The fields a bundled symbol must share with the installed declarations; docIds depend on the documents instead. */
const SYMBOL_FIELDS = ['family', 'name', 'kind', 'wgsl', 'summary', 'declaration', 'file'];

/** The bundle's symbols against the installed package's, field by field: what differs, is missing or is invented. */
export function compareSymbols(bundled, installed) {
    const problems = [];
    const byId = new Map(installed.map(s => [s.id, s]));
    const indexed = new Set();
    for (const s of bundled) {
        indexed.add(s.id);
        const real = byId.get(s.id);
        if (!real) { problems.push(`${s.id}: not exported by the installed package`); continue; }
        for (const field of SYMBOL_FIELDS) if (s[field] !== real[field]) problems.push(`${s.id}: ${field} differs from the installed declarations`);
    }
    for (const real of installed) if (!indexed.has(real.id)) problems.push(`${real.id}: exported but not indexed`);
    return problems;
}

/**
 * The manifest recomputed from the bundle's files (their text, LF line ends): each file's hash, the bundle hash over
 * the package hash and the three, the counts and the documents' source, and each document's own hash. `texts` maps
 * capabilities.json, docs.json, support.json and bundle.json to their contents.
 */
export function verifyManifest(texts) {
    const problems = [];
    const hash = name => sha256(lf(texts[name]));
    const bundle = JSON.parse(texts['bundle.json']);
    const files = { 'capabilities.json': bundle.capabilities?.hash, 'docs.json': bundle.docs?.hash, 'support.json': bundle.support?.hash };
    for (const [name, recorded] of Object.entries(files)) if (recorded !== hash(name)) problems.push(`${name}: its hash is not the manifest's`);
    const expected = sha256([bundle.engine?.packageHash, hash('capabilities.json'), hash('docs.json'), hash('support.json')].join('\n'));
    if (bundle.bundleHash !== expected) problems.push('bundleHash: not the hash of the package and the three files');
    const capabilities = JSON.parse(texts['capabilities.json']);
    const docs = JSON.parse(texts['docs.json']);
    if (bundle.capabilities?.symbols !== capabilities.symbols.length) problems.push('the manifest\'s symbol count is not the index\'s');
    if (bundle.capabilities?.families !== capabilities.families.length) problems.push('the manifest\'s family count is not the index\'s');
    if (bundle.docs?.count !== docs.docs.length) problems.push('the manifest\'s document count is not the bundle\'s');
    if (bundle.docs?.source !== docs.source) problems.push('the manifest\'s document source is not the bundle\'s');
    for (const d of docs.docs) if (sha256(d.text) !== d.sha256) problems.push(`${d.id}: its text is not its hash`);
    return problems;
}
