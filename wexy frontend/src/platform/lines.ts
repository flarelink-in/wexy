// A saved world's versions (W3; the creations platform companion §5 and §8; Q125, the user, 2026-11-03: "keep
// versioning proper for now ... its better to go for versioning and proper controlled path"). Kept apart from the
// artifact's code, so a page that only lists worlds (`/creations`) can say which ones this build opens without loading
// the resolver.
//
// The format is the file's layout. The line names a kernel (render-kernels-design.md, Q140 accepted 2026-11-07): every
// byte of code and data between a world's source and its draw, frozen once released (Q141 (b): any change to it starts
// the next line), and shipped in every later build (K4). Nothing migrates. Until KR2's registry (src/kernels/), this
// file is its table: the lines this build ships and how a saved attempt that names none is routed to one (§9.3).

/** The file's layout. */
export const WORLD_FORMAT = 'wexy-world.v1';

/** A line this build ships, as render-kernels §5.1's registry entry will hold it: what routing a saved file reads. */
export interface KernelLine {
    readonly line: string;
    /** `head`: the one line new worlds are written on (K9). */
    readonly status: 'head';
    /** Its kernel's module ABI and body checker: a file whose bodies were written under others is not of this line. */
    readonly moduleAbi: string;
    readonly checker: string;
    /**
     * The adapter manifests of saved attempts written while it was the head, before they named a line (§9.3): a
     * developer bundle or a starter that names no line is routed by these, never by its engine bundle (K7).
     */
    readonly accepts: { readonly manifests: readonly string[] };
}

/** The lines this build ships, each with its kernel. One so far: ea.v1, the head, not yet sealed (Q143). */
export const LINES: readonly KernelLine[] = Object.freeze([
    Object.freeze({
        line: 'ea.v1',
        status: 'head',
        moduleAbi: 'ea-abi.v2',
        checker: 'ea4-body.v1',
        accepts: Object.freeze({
            manifests: Object.freeze([
                // Before Q130's ground and the shapes' facing (cf44937, 2026-11-05), which changed what no earlier program
                // resolves to; the castle replay of 11-02 names it.
                '3c7775588fb816ce8ccd3660e16d8ae6bfa9526f83174ecf666f8c66ab4c4c77',
                // Since: the starters of 11-05 name it.
                '8bdd11e8ef2f0ced4b0cabbbac19ca4b6ff0df03fca2d56082005b05b1497220',
            ]),
        }),
    }),
]);

/** The line this build writes: the head's. */
export const WORLD_LINE = LINES.find(l => l.status === 'head')!.line;

/** The lines this build opens: every line it ships (K4). */
export const OPENS_LINES: readonly string[] = Object.freeze(LINES.map(l => l.line));

/** A line's shape: a lower-case name, then `.v` and a number. Anything else is not a line. */
export const LINE_SHAPE = /^[a-z][a-z0-9-]{0,15}\.v[1-9][0-9]{0,3}$/;

/** Whether this build opens worlds of `line`. */
export const opensLine = (line: string): boolean => OPENS_LINES.includes(line);

/** At most this many UTF-8 bytes of text (the backend's §11). */
export const WORLD_MAX_BYTES = 512 * 1024;

export type Routed =
    | { readonly ok: true; readonly line: string }
    | { readonly ok: false; readonly code: 'KR_UNKNOWN_LINE' | 'KR_LEGACY_ROUTE' | 'KR_IDENTITY'; readonly reason: string };

/** A file's value as a message quotes it: a long string cut, an object or a list named, never spelt out. */
const short = (v: unknown): string => (typeof v === 'string' ? (v.length > 16 ? `${v.slice(0, 12)}…` : v)
    : v === null || typeof v !== 'object' ? String(v) : Array.isArray(v) ? 'a list' : 'an object');

/**
 * The line whose kernel a saved attempt is of (render-kernels §9.3), from its `versions`: the line it names, when it
 * names one (written since KR0), else the one line whose `accepts` lists its manifest and whose ABI and checker are its
 * own. Its engine bundle is provenance, never compared (K7). A line this build does not ship is refused, never routed
 * by its manifest instead; no match, or more than one, refuses: never the newest or the first (KR-U13).
 */
export function routeBundle(versions: Readonly<Record<string, unknown>>, lines: readonly KernelLine[] = LINES): Routed {
    const { abi, checker } = versions;
    if (versions.line !== undefined) {
        const named = lines.find(l => l.line === versions.line);
        if (!named) {
            return { ok: false, code: 'KR_UNKNOWN_LINE', reason: `KR_UNKNOWN_LINE: line ${short(versions.line)} is not in this build's kernels (${lines.map(l => l.line).join(', ')})` };
        }
        if (abi !== named.moduleAbi || checker !== named.checker) {
            return { ok: false, code: 'KR_IDENTITY', reason: `KR_IDENTITY ${named.line}: expected ${named.moduleAbi}/${named.checker}, got ${short(abi)}/${short(checker)}; refused before the seal` };
        }
        return { ok: true, line: named.line };
    }
    const matches = lines.filter(l => l.accepts.manifests.includes(versions.manifest as string) && l.moduleAbi === abi && l.checker === checker);
    if (matches.length !== 1) {
        return { ok: false, code: 'KR_LEGACY_ROUTE', reason: `KR_LEGACY_ROUTE: ${matches.length} matches for ${short(versions.manifest)}/${short(abi)}/${short(checker)}; supply an explicit reviewed line` };
    }
    return { ok: true, line: matches[0].line };
}
