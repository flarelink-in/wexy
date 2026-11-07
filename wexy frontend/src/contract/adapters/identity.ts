// ea.v1's identity (render-kernels-design.md §5.3, KR0; Q140 accepted and Q141 (b) decided, 2026-11-07): the
// constants every X this kernel resolves names, fixed at their values when ea.v1 was released (`dev` `d8c5c26`), and
// ea.v1's own H. X used to read them from the shell's files, so a sentence written for the model (one of null-graph's
// documents, the family index, a reason of H, an adapter's summary) moved X, id(C), every pin and eligibility's key,
// and voided the device evidence: `f7f0a0b` changed no draw and cost both GPUs' EA-G1 and a dozen re-pinned fixtures.
// Now nothing the model reads enters them (K7). The engine bundle, `support.json` and the manifest's prose are the
// shell's, and the wire still names them (the turn's meta, a revision's base, a module job).
//
// ea.v1 is released, so it is strictly frozen (K3): a change to what this kernel computes starts the next line (§8.1),
// never an edit here. Nothing in this file is read from anywhere else, and nothing here reads the shell.

/** The line this kernel is: what a world saved under it names (render-kernels §2). */
export const KERNEL_LINE = 'ea.v1';

/**
 * The engine bundle's hash every ea.v1 X names (`identity.bundleHash`): the bundle of `f7f0a0b` (2026-11-05), when
 * ea.v1 was released. Provenance since KR0: a bundle regenerated for the model moves the wire's (agent-client.ts's
 * ENGINE_BUNDLE_HASH), never this. Eligibility's shipped entries are keyed by it (§5.6).
 */
export const BUNDLE_HASH = 'aa60280bae32e3aa780d34352ac42ef9c323d39f201b72cd5dc6c07a562f6824';

/**
 * The adapter manifest's hash every ea.v1 X names (`identity.manifestHash`): descriptors.json as of `cf44937` (Q130's
 * ground). Since KR0 an adapter's summary, which the model reads, moves only the wire's pin (ADAPTER_MANIFEST_HASH);
 * what runs of the manifest is held to EXECUTABLE_HASH instead.
 */
export const MANIFEST_HASH = '8bdd11e8ef2f0ced4b0cabbbac19ca4b6ff0df03fca2d56082005b05b1497220';

/**
 * The manifest's executable half as ea.v1 shipped it: the SHA-256 of `executableManifest(ADAPTER_MANIFEST_TEXT)`
 * (index.ts), the manifest's canonical JSON without its prose (each adapter's and each layout's `summary`). Every id,
 * version, family, symbol, config schema, port, layout and variant gate is in it, a gate's reason too (X's gatesHash
 * hashes it). A test holds descriptors.json to it: an edit that moves it changes what ea.v1 runs (§9.2).
 */
export const EXECUTABLE_HASH = '3496ac2c34d477997306d4d2916d9ff9b0a5a87779990b82017ea6e270565ae0';

/**
 * ea.v1's H: each family's status as this kernel resolves it, frozen from src/contract/engine/support.json at `d8c5c26`
 * (render-kernels §6, the cut of `index.ts → ../engine/support.json`). The shell's support.json is the model's H and may
 * change with a later head; a world of ea.v1 still resolves under this one.
 */
export const SUPPORT_STATUSES: Readonly<Record<string, string>> = Object.freeze({
    'core': 'unverified',
    'geometry': 'unverified',
    'loaders': 'unsupported',
    'materials': 'unverified',
    'profiler': 'unsupported',
    'debug-ui': 'unsupported',
    'cameras': 'unsupported',
    'lights': 'unverified',
    'post': 'unverified',
    'visibility': 'unsupported',
    'shadows': 'unsupported',
    'environment': 'unsupported',
    'picking': 'unsupported',
    'text': 'unsupported',
    'agents': 'unsupported',
    'inference': 'unsupported',
    'physics': 'unsupported',
    'film': 'unsupported',
});

/** The canonical hash of SUPPORT_STATUSES: what every ea.v1 X names as `identity.supportStatusHash`. */
export const SUPPORT_STATUS_HASH = '32307cbb13986bcde6afa91d2e5374e563e746831b45e7b2a06ded6c564e79bb';

/**
 * The engine ea.v1 draws with (render-kernels §5.1's `engine`; §9.1: a new null-graph is a new line, always). Until KR0
 * the bundle's hash carried the package's into X; now X names a constant, so a test holds what is installed to this
 * record (KR0's independent review): null-graph exactly as package.json asks and the lockfile resolves it, the tarball's
 * integrity, its declarations' hash as the bundle names it (dev/engine-lib.mjs's packageHash), and gl-matrix, its one
 * dependency, whose matrices every camera and transform is made of.
 */
export const ENGINE = Object.freeze({
    name: 'null-graph',
    version: '1.2.1',
    packageHash: '6e3513632017a286e01340869daa5f76c6729616777831ab587ede042812e41f',
    integrity: 'sha512-/oGyhAe7FyTGnUslDqFcio/T8wL9Gvz554PI152GKgTs12WSFFMtmJlFTGNlBxwZqI5nrhA7zdBix1O+TvUXVA==',
    dependencies: Object.freeze({
        'gl-matrix': Object.freeze({
            version: '3.4.4',
            integrity: 'sha512-latSnyDNt/8zYUB6VIJ6PCh2jBjJX6gnDsoCZ7LyW7GkqrD51EWwa9qCoGixj8YqBtETQK/xY7OmpTF8xz1DdQ==',
        }),
    }),
});
