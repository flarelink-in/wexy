// The scans the engine bundle is built and checked with (EA1; dev/engine-bundle.mjs and test/engine.test.mjs use the
// same code, so the bundle's review list means the same thing in both): which names a document mentions, and which
// names it takes from null-graph that the installed version does not export. Covered: named imports (`import { A,
// B as C }`, `import type`), default imports (null-graph has none), namespace imports and their `ns.Name` uses, an
// import from a subpath that does not exist, and the agent runner's `lib.<family>`, destructured or `lib.x.Name`.
// Not covered, and said so: dynamic `import()`, `require`, re-exports, and names in prose.

/** A name a bundled document takes from null-graph that the installed version does not export where it says. */
export interface StaleMention {
    doc: string;
    /** The family the document names; for an unknown subpath, that subpath's name. */
    family: string;
    /** The missing name; `*` for a whole unknown subpath. */
    name: string;
    how: 'import' | 'default' | 'namespace' | 'subpath' | 'lib';
}

/** The runner's `lib.<key>` families (null-graph's agent guide, "The runner contract"); glMatrix is not null-graph's. */
const LIB_FAMILIES: Readonly<Record<string, string>> = {
    core: 'core', geometry: 'geometry', materials: 'materials', lights: 'lights', cameras: 'cameras', visibility: 'visibility',
    shadows: 'shadows', environment: 'environment', post: 'post', loaders: 'loaders', picking: 'picking', text: 'text',
};

/** The family a `null-graph` import specifier names: `null-graph` is core, `null-graph/post` is post; null for any other package. */
export function familyOfSpecifier(specifier: string): string | null {
    if (specifier === 'null-graph') return 'core';
    const m = /^null-graph\/([A-Za-z0-9_.-]+)$/.exec(specifier);
    return m ? m[1] : null;
}

/** Every identifier a text contains, once. */
export function identifiers(text: string): Set<string> {
    return new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

const NAME = /^[A-Za-z_$][\w$]*$/;

/** Every stale mention in `docs` against `declared` (family to exported names), sorted and once each. */
export function staleMentions(docs: readonly { id: string; text: string }[], declared: Readonly<Record<string, readonly string[]>>): StaleMention[] {
    const found = new Map<string, StaleMention>();
    const note = (m: StaleMention) => found.set(`${m.doc}|${m.family}|${m.name}|${m.how}`, m);
    /** The names `family` must export; false (and a finding) when the subpath does not exist. */
    const exportsOf = (doc: string, family: string): readonly string[] | false => {
        const exported = declared[family];
        if (!exported) {
            note({ doc, family, name: '*', how: 'subpath' });
            return false;
        }
        return exported;
    };
    const check = (doc: string, family: string, name: string, how: StaleMention['how']) => {
        const exported = exportsOf(doc, family);
        if (exported && NAME.test(name) && !exported.includes(name)) note({ doc, family, name, how });
    };
    for (const d of docs) {
        // import { A, B as C } from 'null-graph/x'; import type { … } from …; import D, { … } from …
        for (const m of d.text.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
            const family = familyOfSpecifier(m[3]);
            if (!family) continue;
            if (m[1] && m[1] !== 'type') {
                // A default import is wrong whatever its name: the binding gets the module's default export, which
                // null-graph does not have, even when a named export of the same name exists.
                const exported = exportsOf(d.id, family);
                if (exported && !exported.includes('default')) note({ doc: d.id, family, name: m[1], how: 'default' });
            }
            for (const part of (m[2] ?? '').split(',')) {
                const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
                if (name) check(d.id, family, name, 'import');
            }
        }
        // import * as ns from 'null-graph/x', then every ns.Name in the same document
        for (const m of d.text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
            const family = familyOfSpecifier(m[2]);
            if (!family || !exportsOf(d.id, family)) continue;
            for (const use of d.text.matchAll(new RegExp(`(?<![\\w$.])${m[1].replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) check(d.id, family, use[1], 'namespace');
        }
        // const { A, B } = lib.x;  and  lib.x.Name
        for (const m of d.text.matchAll(/\{([^}]*)\}\s*=\s*lib\.([A-Za-z]+)/g)) {
            const family = LIB_FAMILIES[m[2]];
            if (!family) continue;
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s*:\s*/)[0].trim();
                if (name) check(d.id, family, name, 'lib');
            }
        }
        for (const m of d.text.matchAll(/(?<![\w$.])lib\.([A-Za-z]+)\.([A-Za-z_$][\w$]*)/g)) {
            const family = LIB_FAMILIES[m[1]];
            if (family) check(d.id, family, m[2], 'lib');
        }
    }
    return [...found.values()].sort((a, b) => {
        const ka = `${a.doc}\u0000${a.family}\u0000${a.name}\u0000${a.how}`;
        const kb = `${b.doc}\u0000${b.family}\u0000${b.name}\u0000${b.how}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}
