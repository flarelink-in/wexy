// The engine adapters of EA3 (engine-adapters-design.md §5, §16): the nine Tier-1 descriptors, pure data in
// descriptors.json (which the backend will embed byte for byte, Q74), and the check of a program's adapter nodes
// against them (EA3.1). A node names an exact adapter and version, carries its config as bounded JSON text checked
// against that adapter's closed schema, and wires typed ports to other nodes' outputs. Nothing here resolves, allocates
// or touches a device: support is static only (Q75 as decided), so a family H marks `unsupported` refuses and every
// other resolves to data, never to something that runs. A config value the manifest gates as unavailable refuses too,
// from the same data (Q80: `upload`, until Tier 2 brings a content source).

import { checkStrictSubset, pointerToken, schemaIssues } from '../agent';
import { deepFreeze, type DeepReadonly } from '../engine/frozen';
import supportText from '../engine/support.json?raw';
import manifestText from './descriptors.json?raw';

/** `stage` orders, and carries nothing: a compute stage's `done` into another's `after` (Q77). */
export type PortKind = 'storage_buffer' | 'geometry' | 'material' | 'lights' | 'color' | 'stage';
export type BufferLayout = 'instance14' | 'instance24' | 'f32';

export interface InputPort {
    name: string;
    kind: PortKind;
    /** The buffer layouts it accepts; any when absent. */
    layouts?: BufferLayout[];
    /** How many connections it takes. */
    min: number;
    max: number;
}

export interface OutputPort {
    name: string;
    kind: PortKind;
    /** The config key whose value is this output's buffer layout. */
    layoutFrom?: string;
    /** The config key whose value is its element stride in floats; a canonical layout pins it (the manifest's `layouts`). */
    strideFrom?: string;
}

export interface AdapterDescriptor {
    id: string;
    version: number;
    /** H's family. */
    family: string;
    /** The engine exports it wraps, as K names them; empty when it wraps the device, not the engine. */
    symbols: string[];
    summary: string;
    config: { readonly [keyword: string]: unknown };
    inputs: InputPort[];
    outputs: OutputPort[];
}

/** A buffer layout the manifest pins: a label alone never decides compatibility (design §5). */
export interface LayoutDescriptor {
    /** Floats an element; null when the node declares its own (f32). */
    strideFloats: number | null;
    summary: string;
}

/** A descriptor as the registry holds it: frozen, read-only all the way down. */
export type Adapter = DeepReadonly<AdapterDescriptor>;

/**
 * A config value the manifest declares but marks unavailable for now (Q80, decided): the node check refuses it from
 * this data, with its reason. Tier 2 lifts a gate by removing its entry and supplying what the value needs (assets for
 * `upload`): a data change, with no change to the checks, the resolver's shape or the templates.
 */
export interface VariantGate {
    adapter: string;
    /** A JSON pointer into the adapter's config (RFC 6901), naming an enum of its schema. */
    path: string;
    value: string | number | boolean;
    reason: string;
}

export interface AdapterManifest {
    version: string;
    engine: string;
    layouts: Record<BufferLayout, LayoutDescriptor>;
    adapters: AdapterDescriptor[];
    unavailable: VariantGate[];
}

const unescapeToken = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~');

/** The enum a config schema holds at a pointer through its properties, or null. */
function enumAt(schema: { readonly [keyword: string]: unknown }, path: string): readonly unknown[] | null {
    if (!path.startsWith('/')) return null;
    let at: { readonly [keyword: string]: unknown } | undefined = schema;
    for (const token of path.slice(1).split('/').map(unescapeToken)) {
        const props = at?.properties as Readonly<Record<string, { readonly [keyword: string]: unknown }>> | undefined;
        at = props && Object.hasOwn(props, token) ? props[token] : undefined;
    }
    return Array.isArray(at?.enum) ? at.enum as readonly unknown[] : null;
}

/** The value a parsed config holds at a pointer, or undefined. */
function valueAt(config: unknown, path: string): unknown {
    let at = config;
    for (const token of path.slice(1).split('/').map(unescapeToken)) {
        at = at !== null && typeof at === 'object' && !Array.isArray(at) && Object.hasOwn(at, token) ? (at as Record<string, unknown>)[token] : undefined;
    }
    return at;
}

const PORT_KINDS: readonly string[] = ['storage_buffer', 'geometry', 'material', 'lights', 'color', 'stage'];

/**
 * Throws unless the manifest is one this check can enforce whole: every config in the validator's strict subset, every
 * port of a known kind and count, and every layout key backed by an enum of pinned layouts. A manifest that grew an
 * inconsistency must not be half-checked in silence.
 */
export function checkManifest(m: DeepReadonly<AdapterManifest>): void {
    const bad = (what: string) => { throw new Error(`${m.version}: ${what}`); };
    const layouts = Object.keys(m.layouts);
    for (const [name, l] of Object.entries(m.layouts)) {
        if (l.strideFloats !== null && !(Number.isSafeInteger(l.strideFloats) && l.strideFloats > 0)) bad(`layout ${name}'s stride is not a positive integer`);
    }
    const ids = new Set<string>();
    for (const a of m.adapters) {
        if (ids.has(a.id)) bad(`${a.id} is listed twice`);
        ids.add(a.id);
        checkStrictSubset(a.config as { readonly [keyword: string]: unknown }, `/${a.id}/config`);
        const props = (a.config.properties ?? {}) as Record<string, { type?: unknown; enum?: readonly unknown[] }>;
        const required = (a.config.required ?? []) as readonly string[];
        for (const p of a.inputs) {
            if (!PORT_KINDS.includes(p.kind)) bad(`${a.id}'s input ${p.name} has kind ${p.kind}`);
            if (!Number.isSafeInteger(p.min) || !Number.isSafeInteger(p.max) || p.min < 0 || p.min > p.max) bad(`${a.id}'s input ${p.name} takes ${p.min} to ${p.max}`);
            for (const l of p.layouts ?? []) if (!layouts.includes(l)) bad(`${a.id}'s input ${p.name} accepts layout ${l}, which is not pinned`);
        }
        for (const o of a.outputs) {
            if (!PORT_KINDS.includes(o.kind)) bad(`${a.id}'s output ${o.name} has kind ${o.kind}`);
            if (o.strideFrom && !o.layoutFrom) bad(`${a.id}'s output ${o.name} has a stride but no layout`);
            if (o.layoutFrom) {
                const values = props[o.layoutFrom]?.enum;
                if (!required.includes(o.layoutFrom) || !values || !values.every(v => layouts.includes(v as string))) bad(`${a.id}'s ${o.layoutFrom} is not a required enum of pinned layouts`);
            }
            if (o.strideFrom && (!required.includes(o.strideFrom) || props[o.strideFrom]?.type !== 'integer')) bad(`${a.id}'s ${o.strideFrom} is not a required integer`);
        }
    }
    // The variant gates (Q80): each names an adapter, an enum of its config by pointer, a value that enum holds, and its
    // way out; and leaves that enum a value a node can still take.
    if (!Array.isArray(m.unavailable)) bad('unavailable is not a list');
    const gated = new Map<string, Set<unknown>>();
    for (const g of m.unavailable) {
        const where = `unavailable ${JSON.stringify(g?.adapter)} ${JSON.stringify(g?.path)}`;
        if (!g || typeof g !== 'object' || Object.keys(g).sort().join() !== 'adapter,path,reason,value') bad(`${where}: a gate is exactly {adapter, path, value, reason}`);
        const a = m.adapters.find(x => x.id === g.adapter);
        const values = a && typeof g.path === 'string' ? enumAt(a.config, g.path) : null;
        if (!a) bad(`${where}: there is no such adapter`);
        if (!values || !values.includes(g.value)) bad(`${where}: not an enum of its config that holds ${JSON.stringify(g.value)}`);
        if (typeof g.reason !== 'string' || !g.reason.trim() || g.reason.length > 200) bad(`${where}: its reason is 1 to 200 characters`);
        const key = `${g.adapter} ${g.path}`;
        const set = gated.get(key) ?? new Set<unknown>();
        if (set.has(g.value)) bad(`${where}: ${JSON.stringify(g.value)} is gated twice`);
        set.add(g.value);
        gated.set(key, set);
        if (values!.every(v => set.has(v))) bad(`${where}: every value of the enum is gated, so no node could take one`);
    }
}

/** The manifest's text as embedded, LF line ends, for the hash the tests pin. */
export const ADAPTER_MANIFEST_TEXT = manifestText.replace(/\r\n/g, '\n');
/**
 * sha256 of ADAPTER_MANIFEST_TEXT, pinned as the backend's AdapterManifest.HASH pins it, so a turn's meta is held to it
 * with no hashing at run time (EA3.6). EA-A1 recomputes it: a manifest changed without its pin fails there.
 */
export const ADAPTER_MANIFEST_HASH = '3c7775588fb816ce8ccd3660e16d8ae6bfa9526f83174ecf666f8c66ab4c4c77';
export const ADAPTERS = deepFreeze(JSON.parse(ADAPTER_MANIFEST_TEXT) as AdapterManifest);
checkManifest(ADAPTERS);
/** The manifest's own gates: what the node check holds a program to unless a test lifts one, as Tier 2 will (Q80). */
export const SHIPPED_GATES: readonly DeepReadonly<VariantGate>[] = ADAPTERS.unavailable;

const BY_ID = new Map(ADAPTERS.adapters.map(a => [a.id, a]));
/** H's family statuses as shipped (src/contract/engine/support.json). */
export const SHIPPED_SUPPORT: ReadonlyMap<string, string> = new Map(
    (JSON.parse(supportText) as { entries: { family: string; status: string }[] }).entries.map(e => [e.family, e.status]));

/**
 * The H statuses a family may have and still resolve, statically: X never runs in EA3 (Q75 as decided), so this is
 * not execution support. `unsupported`, and any status this list does not name, refuses.
 */
const STATIC_STATUSES: ReadonlySet<string> = new Set(['unverified', 'supported', 'device-blocked']);

/** A program's node as EA3.0 froze it (the v2 wire form, §16): its config still JSON text. */
export interface AdapterNode {
    id: string;
    adapterId: string;
    adapterVersion: number;
    /** JSON text, at most NodePolicy.configChars UTF-16 code units (String.length here, Java's length() there). */
    config: string;
    inputs: { port: string; nodeId: string; output: string }[];
}

/** A node that passed: its config parsed into data its adapter's schema accepts. */
export interface CheckedNode {
    id: string;
    adapter: Adapter;
    config: Record<string, unknown>;
    inputs: { port: string; nodeId: string; output: string }[];
}

export type ResolveCode = 'EA_CONTRACT_V1' | 'EA_CAPABILITY_UNSUPPORTED' | 'EA_RESOLVE';

export interface ResolveDiagnostic {
    code: ResolveCode;
    /** A JSON pointer into the program (RFC 6901). */
    path: string;
    nodeId: string | null;
    message: string;
}

/** Limits the node check needs; the rest of P comes with the resolver (EA3.2). */
export interface NodePolicy {
    maxNodes: number;
    configChars: number;
}

export const NODE_POLICY: NodePolicy = { maxNodes: 64, configChars: 4_096 };

const NODE_KEYS = ['id', 'adapterId', 'adapterVersion', 'config', 'inputs'];
const NODE_ID = /^[a-z][A-Za-z0-9_-]{0,39}$/;
/** A port's or an output's name, as the manifest writes them. */
const PORT_NAME = /^[a-z][A-Za-z0-9_]{0,39}$/;
export const pointer = (...parts: (string | number)[]) => parts.map(p => `/${pointerToken(p)}`).join('');
/** A model's value, short enough to quote in a diagnostic. */
const shown = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : typeof v === 'number' ? String(v) : v === null ? 'null' : typeof v);

/**
 * The program's nodes checked against the registry and H: each, or every diagnostic with its path. `support` is H's
 * family statuses, injected so tests can use a labelled synthetic manifest; the shipped H by default. `gates` are the
 * manifest's variant gates (Q80), injected so a test can lift one as Tier 2 will; the shipped ones by default.
 */
export function checkNodes(input: unknown, policy: NodePolicy = NODE_POLICY, support: ReadonlyMap<string, string> = SHIPPED_SUPPORT,
    gates: readonly DeepReadonly<VariantGate>[] = SHIPPED_GATES): { ok: true; nodes: CheckedNode[] } | { ok: false; diagnostics: ResolveDiagnostic[] } {
    const out: ResolveDiagnostic[] = [];
    const fail = (code: ResolveCode, path: string, nodeId: string | null, message: string) => out.push({ code, path, nodeId, message });
    if (!Array.isArray(input)) {
        fail('EA_RESOLVE', '/nodes', null, 'the program\'s nodes are not a list');
        return { ok: false, diagnostics: out };
    }
    if (input.length === 0 || input.length > policy.maxNodes) {
        fail('EA_RESOLVE', '/nodes', null, `a program has 1 to ${policy.maxNodes} nodes, not ${input.length}`);
        return { ok: false, diagnostics: out };
    }
    const seen = new Set<string>();
    const nodes: CheckedNode[] = [];
    for (const [i, raw] of input.entries()) {
        const at = pointer('nodes', i);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { fail('EA_RESOLVE', at, null, 'a node is not an object'); continue; }
        const n = raw as Record<string, unknown>;
        // A v1 object names engine calls; it is refused here, never coerced into a node (§16).
        if ('symbol' in n || 'member' in n || 'args' in n) {
            fail('EA_CONTRACT_V1', at, typeof n.id === 'string' && NODE_ID.test(n.id) ? n.id : null, 'an agent-action.v1 object (symbol, member, args) is not an adapter node; it needs agent-action.v2');
            continue;
        }
        const extra = Object.keys(n).filter(k => !NODE_KEYS.includes(k));
        const missing = NODE_KEYS.filter(k => !Object.hasOwn(n, k));
        if (extra.length || missing.length) {
            fail('EA_RESOLVE', at, null, `a node has exactly ${NODE_KEYS.join(', ')}${extra.length ? `; not ${extra.slice(0, 5).map(shown).join(', ')}` : ''}${missing.length ? `; ${missing.join(', ')} missing` : ''}`);
            continue;
        }
        if (typeof n.id !== 'string' || !NODE_ID.test(n.id)) { fail('EA_RESOLVE', `${at}/id`, null, 'a node id is 1 to 40 letters, digits, - or _, starting lower-case'); continue; }
        const id = n.id;
        if (seen.has(id)) { fail('EA_RESOLVE', `${at}/id`, id, `node id ${id} is used twice`); continue; }
        seen.add(id);
        const adapter = typeof n.adapterId === 'string' ? BY_ID.get(n.adapterId) : undefined;
        if (!adapter) { fail('EA_CAPABILITY_UNSUPPORTED', `${at}/adapterId`, id, `no adapter ${shown(n.adapterId)}; the adapters are ${[...BY_ID.keys()].join(', ')}`); continue; }
        if (n.adapterVersion !== adapter.version) { fail('EA_CAPABILITY_UNSUPPORTED', `${at}/adapterVersion`, id, `${adapter.id} is version ${adapter.version}, not ${shown(n.adapterVersion)}; no other version is taken`); continue; }
        const status = support.get(adapter.family);
        if (status === undefined || !STATIC_STATUSES.has(status)) {
            fail('EA_CAPABILITY_UNSUPPORTED', `${at}/adapterId`, id, `${adapter.id}'s family ${adapter.family} is ${status === undefined ? 'not in H' : shown(status)}; only ${[...STATIC_STATUSES].join(', ')} resolve, and statically`);
            continue;
        }
        if (typeof n.config !== 'string' || n.config.length > policy.configChars) { fail('EA_RESOLVE', `${at}/config`, id, `config is JSON text of at most ${policy.configChars} characters`); continue; }
        let config: unknown;
        try { config = JSON.parse(n.config); } catch { fail('EA_RESOLVE', `${at}/config`, id, `config is not JSON: ${shown(n.config)}`); continue; }
        // Each issue carries its own escaped pointer: a key with a / ~ or : in it stays one property (the EA3.1 review).
        const issues = schemaIssues(adapter.config, config, '');
        if (issues.length) {
            for (const p of issues.slice(0, 5)) fail('EA_RESOLVE', `${at}/config${p.path}`, id, `${adapter.id} config ${p.path || '/'}: ${p.message}`);
            continue;
        }
        const parsed = config as Record<string, unknown>;
        // A canonical layout pins its stride: a buffer cannot claim instance14 and hold 24 floats an element (the review).
        const strides = adapter.outputs.filter(o => o.layoutFrom && o.strideFrom).flatMap(o => {
            const layout = parsed[o.layoutFrom!] as BufferLayout;
            const want = ADAPTERS.layouts[layout].strideFloats;
            return want === null || parsed[o.strideFrom!] === want ? [] : [{ key: o.strideFrom!, layout, want }];
        });
        if (strides.length) {
            for (const s of strides) fail('EA_RESOLVE', `${at}/config/${pointerToken(s.key)}`, id, `layout ${s.layout} is ${s.want} floats an element, not ${shown(parsed[s.key])}; only f32 takes the stride it declares`);
            continue;
        }
        // A value the manifest declares and gates (Q80): refused from the same data, with its way out.
        const gated = gates.filter(g => g.adapter === adapter.id && valueAt(parsed, g.path) === g.value);
        if (gated.length) {
            for (const g of gated) fail('EA_CAPABILITY_UNSUPPORTED', `${at}/config${g.path}`, id, `${adapter.id} config ${g.path}: ${shown(g.value)} is not available yet: ${g.reason}`);
            continue;
        }
        if (!Array.isArray(n.inputs) || n.inputs.length > 16) { fail('EA_RESOLVE', `${at}/inputs`, id, 'inputs is a list of at most 16'); continue; }
        const inputs: CheckedNode['inputs'] = [];
        let wired = true;
        for (const [j, w] of n.inputs.entries()) {
            const o = w as Record<string, unknown>;
            if (!o || typeof o !== 'object' || Object.keys(o).sort().join() !== 'nodeId,output,port' || ![o.port, o.nodeId, o.output].every(v => typeof v === 'string')
                || !PORT_NAME.test(o.port as string) || !NODE_ID.test(o.nodeId as string) || !PORT_NAME.test(o.output as string)) {
                fail('EA_RESOLVE', `${at}/inputs/${j}`, id, 'an input is exactly {port, nodeId, output}: a port name, a node id and an output name, each 1 to 40 characters');
                wired = false;
                continue;
            }
            inputs.push({ port: o.port as string, nodeId: o.nodeId as string, output: o.output as string });
        }
        if (wired) nodes.push({ id, adapter, config: parsed, inputs });
    }
    if (out.length) return { ok: false, diagnostics: out };
    wire(nodes, input as unknown[], fail);
    return out.length ? { ok: false, diagnostics: out } : { ok: true, nodes };
}

/** Every input names a real port, a real node and output of the port's kind and layout; every port's count is in range. */
function wire(nodes: CheckedNode[], raw: unknown[], fail: (code: ResolveCode, path: string, nodeId: string | null, message: string) => void): void {
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) {
        const at = pointer('nodes', raw.findIndex(r => (r as { id?: unknown }).id === n.id));
        const counts = new Map<string, number>();
        for (const [j, w] of n.inputs.entries()) {
            const port = n.adapter.inputs.find(p => p.name === w.port);
            if (!port) { fail('EA_RESOLVE', `${at}/inputs/${j}/port`, n.id, `${n.adapter.id} has no input ${w.port}; its inputs are ${n.adapter.inputs.map(p => p.name).join(', ') || 'none'}`); continue; }
            counts.set(port.name, (counts.get(port.name) ?? 0) + 1);
            const from = byId.get(w.nodeId);
            if (!from) { fail('EA_RESOLVE', `${at}/inputs/${j}/nodeId`, n.id, `no node ${w.nodeId}`); continue; }
            if (from === n) { fail('EA_RESOLVE', `${at}/inputs/${j}/nodeId`, n.id, 'a node cannot take its own output'); continue; }
            const output = from.adapter.outputs.find(o => o.name === w.output);
            if (!output) { fail('EA_RESOLVE', `${at}/inputs/${j}/output`, n.id, `${w.nodeId} (${from.adapter.id}) has no output ${w.output}`); continue; }
            if (output.kind !== port.kind) { fail('EA_RESOLVE', `${at}/inputs/${j}`, n.id, `${port.name} takes ${port.kind}, but ${w.nodeId}.${w.output} is ${output.kind}`); continue; }
            const layout = output.layoutFrom ? from.config[output.layoutFrom] as BufferLayout : null;
            if (port.layouts && (!layout || !port.layouts.includes(layout))) {
                fail('EA_RESOLVE', `${at}/inputs/${j}`, n.id, `${port.name} takes ${port.layouts.join(' or ')} buffers, but ${w.nodeId} is ${layout ?? 'of no layout'}; no bridge is in Tier 1`);
            }
        }
        for (const port of n.adapter.inputs) {
            const c = counts.get(port.name) ?? 0;
            if (c < port.min || c > port.max) fail('EA_RESOLVE', `${at}/inputs`, n.id, `${n.adapter.id}'s ${port.name} takes ${port.min} to ${port.max} connections, not ${c}`);
        }
    }
}

export function adapter(id: string): Adapter | undefined {
    return BY_ID.get(id);
}
