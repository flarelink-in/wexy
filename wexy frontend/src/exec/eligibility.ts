// Recorded coverage (EA5.3; executor-design.md §7; revised 2026-11-02): which configurations have prior measurements.
// A covered node has an entry for its adapter/version, engine bundle, executor profile and device environment,
// whose coverage holds the node's demand: each work dimension at most the maximum EA-G1 exercised,
// each config value one EA-G1 ran. The entries live in eligibility.json, written from EA-G1's results (EA5.4) and never
// by hand from memory. Missing coverage warns in normal Run; the bounded probe still decides full-size work.
// Strict verification harnesses may refuse coverage misses. Malformed records and unknown demand schemas still refuse.
//
// Coverage is the host's schema, not a predicate from JSON: the dimensions and values of each adapter are defined here,
// how a node's demand is read from X is defined here, and an entry that names anything else, or leaves one out, makes
// the whole file refused (nothing admits). One entry covers a node's whole demand or none of it: ranges from two entries
// are never combined into a configuration neither run. The environment is the exact reviewed model (`ea5-env.v2`: vendor,
// architecture, device and description, backend, operating system, browser), never its architecture family (the EA5.3
// review, H2): a browser that hides the model gives no environment, so one fixture cannot promote a family.

import type { ExecutionGraph, XNode, XOperation } from '../contract/adapters/graph';
import type { DeepReadonly } from '../contract/engine/frozen';
import eligibilityText from './eligibility.json?raw';

type Graph = DeepReadonly<ExecutionGraph>;
type Op = DeepReadonly<XOperation>;

/** The executor's profile: its ABI (`ea-abi.v2`), its lowering (EA5.2) and its probe's rules (EA5.3). Eligibility binds it. */
export const EXECUTOR_PROFILE = 'ea5-exec.v1';
export const ELIGIBILITY_FORMAT = 'wexy-eligibility.v1';

/** Each adapter's coverage, as the host reads it from X: its work dimensions (closed ranges from 0) and its config values. */
export const COVERAGE_SCHEMA: Readonly<Record<string, { readonly max: readonly string[]; readonly values: readonly string[] }>> = {
    'ng.buffer.storage': { max: ['bytes'], values: ['layout', 'content', 'pingPong'] },
    'ng.compute.stage': { max: ['invocations', 'workgroups', 'workgroupSize'], values: ['phase'] },
    'ng.geometry.primitive': { max: ['vertices', 'indices'], values: ['factory'] },
    'ng.material.stock': { max: [], values: ['class'] },
    'ng.light.rig': { max: ['lights'], values: [] },
    'ng.render.mesh_batch': { max: ['instances', 'vertexInvocations'], values: ['material', 'lights'] },
    // A module's own draw: with StandardLayout's geometry or none (three vertices an instance), lit or not (custom
    // lighting is gated, so `false` alone runs until it is not).
    'ng.render.custom_batch': { max: ['instances', 'vertexInvocations'], values: ['vertexLayout', 'lights'] },
    'ng.render.fullscreen': { max: ['pixels'], values: [] },
    'ng.post.chain': { max: ['effects', 'pixels'], values: ['effect'] },
};

export interface Coverage {
    max: Readonly<Record<string, number>>;
    values: Readonly<Record<string, readonly string[]>>;
}

export interface Eligibility {
    adapter: string;
    adapterVersion: number;
    engineBundleHash: string;
    executorProfile: string;
    /** The reviewed GPU and browser, as `environmentOf` writes it. */
    environment: string;
    coverage: Coverage;
    /** The EA-G1 run that verified it: its date, GPU, browser and the result's path. */
    evidence: string;
}

/** What one node of X asks for, in its adapter's dimensions and values. */
export interface Demand {
    node: string;
    adapter: string;
    adapterVersion: number;
    max: Record<string, number>;
    values: Record<string, string[]>;
}

export type Parsed = { ok: true; entries: Eligibility[] } | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysExactly = (o: Record<string, unknown>, keys: readonly string[]) => {
    const have = Object.keys(o).sort();
    const want = [...keys].sort();
    return have.length === want.length && have.every((k, i) => k === want[i]);
};
const ENTRY_KEYS = ['adapter', 'adapterVersion', 'engineBundleHash', 'executorProfile', 'environment', 'coverage', 'evidence'] as const;

/** Why one entry is not in the host's schema; null when it is. */
function entryProblem(e: unknown, i: number): string | null {
    const at = `entry ${i}`;
    if (!isObject(e) || !keysExactly(e, ENTRY_KEYS)) return `${at} does not have exactly ${ENTRY_KEYS.join(', ')}`;
    const schema = typeof e.adapter === 'string' ? COVERAGE_SCHEMA[e.adapter] : undefined;
    if (!schema) return `${at} names an adapter with no coverage schema here: ${String(e.adapter)}`;
    if (!Number.isSafeInteger(e.adapterVersion) || (e.adapterVersion as number) < 1) return `${at} has no adapter version`;
    if (typeof e.engineBundleHash !== 'string' || !HEX64.test(e.engineBundleHash)) return `${at} has no engine bundle hash`;
    for (const k of ['executorProfile', 'environment', 'evidence'] as const) {
        if (typeof e[k] !== 'string' || !(e[k] as string).trim()) return `${at} has no ${k}`;
    }
    const c = e.coverage;
    if (!isObject(c) || !keysExactly(c, ['max', 'values']) || !isObject(c.max) || !isObject(c.values)) return `${at}'s coverage is not {max, values}`;
    if (!keysExactly(c.max, schema.max)) return `${at}'s ranges are not exactly ${schema.max.join(', ') || 'none'}`;
    if (!keysExactly(c.values, schema.values)) return `${at}'s values are not exactly ${schema.values.join(', ') || 'none'}`;
    for (const [k, v] of Object.entries(c.max)) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${at}'s range ${k} is not a number from 0`;
    for (const [k, v] of Object.entries(c.values)) {
        if (!Array.isArray(v) || !v.length || !v.every(s => typeof s === 'string' && s.length > 0)) return `${at}'s values ${k} are not a list of names`;
    }
    return null;
}

/** eligibility.json's text, every entry whole and in the host's schema; a file with any other refuses whole. */
export function parseEligibility(text: string): Parsed {
    let file: unknown;
    try {
        file = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: `eligibility is not JSON: ${(e as Error).message}` };
    }
    if (!isObject(file) || file.format !== ELIGIBILITY_FORMAT || !Array.isArray(file.entries)) return { ok: false, reason: `eligibility is not ${ELIGIBILITY_FORMAT}` };
    for (const [i, e] of file.entries.entries()) {
        const problem = entryProblem(e, i);
        if (problem) return { ok: false, reason: `eligibility refused: ${problem}` };
    }
    return { ok: true, entries: structuredClone(file.entries) as Eligibility[] };
}

/** The shipped eligibility: eligibility.json, parsed once. When it does not parse, nothing is eligible, and why is kept. */
export const SHIPPED: Parsed = parseEligibility(eligibilityText);

/** The browser, from its user agent: `chrome/156`, `edge/156`; null for any other, which matches no entry. */
export function browserOf(userAgent: string): string | null {
    const edge = /\bEdg\/(\d+)\./.exec(userAgent);
    if (edge) return `edge/${edge[1]}`;
    const chrome = /\b(?:HeadlessChrome|Chrome)\/(\d+)\./.exec(userAgent);
    return chrome ? `chrome/${chrome[1]}` : null;
}

/** The operating system, from the user agent; null for one this host does not know. Android before Linux: it says both. */
export function osOf(userAgent: string): string | null {
    if (/Windows NT/.test(userAgent)) return 'windows';
    if (/CrOS/.test(userAgent)) return 'chromeos';
    if (/Android/.test(userAgent)) return 'android';
    if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos';
    if (/Linux|X11/.test(userAgent)) return 'linux';
    return null;
}

/** The fingerprint's version: what the key holds, and how it is read (the EA5.3 review, H2). */
export const ENVIRONMENT_VERSION = 'ea5-env.v2';

/** What the environment is read from: the adapter's own info, as the device reports it. */
export interface AdapterIdentity {
    vendor: string;
    architecture: string;
    /** The model: its device identifier and description. Chrome shows them only with its WebGPU developer features. */
    device: string;
    description: string;
    /** The backend (d3d12, vulkan, metal), where the browser says it; empty otherwise. */
    backend: string;
    /** A software adapter qualifies nowhere. */
    isFallbackAdapter: boolean;
}

/** An adapter's identity from its GPUAdapterInfo (a device's `adapterInfo`), read defensively: a missing field is empty. */
export function adapterIdentity(info: unknown): AdapterIdentity {
    const o = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
    const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
    return {
        vendor: text('vendor'), architecture: text('architecture'), device: text('device'), description: text('description'), backend: text('backend'),
        isFallbackAdapter: o.isFallbackAdapter === true,
    };
}

/** This device's environment: its key, or why it has none (and so matches no entry, and stays static-only). */
export type Environment = { key: string } | { unknown: string };

/**
 * This device's environment (§7): the exact reviewed model, not its family (the EA5.3 review, H2). The key holds the
 * fingerprint's version, the vendor, the architecture, the model (its device identifier and description), the backend
 * where the browser says it, the operating system and the browser's major version, e.g.
 * `ea5-env.v2|nvidia|turing|0x1f91|NVIDIA GeForce GTX 1650|d3d12|windows|chrome/156`. Two models of one architecture are
 * two environments. A browser that hides the model (Chrome does, unless its WebGPU developer features are on) gives no
 * environment at all, so eligibility never widens from a model to its family; nor does a software adapter, or an
 * operating system or browser this host does not know. The driver's version is not in the key: every Run is probed.
 */
export function environmentOf(gpu: AdapterIdentity, userAgent: string): Environment {
    const vendor = gpu.vendor.trim().toLowerCase();
    const architecture = gpu.architecture.trim().toLowerCase();
    const device = gpu.device.trim().toLowerCase();
    const description = gpu.description.trim();
    const backend = gpu.backend.trim().toLowerCase();
    const os = osOf(userAgent);
    const browser = browserOf(userAgent);
    if (gpu.isFallbackAdapter) return { unknown: 'a software (fallback) adapter qualifies nowhere' };
    if (!vendor || !architecture) return { unknown: 'the adapter does not say its vendor and architecture' };
    if (!device && !description) {
        return { unknown: 'this browser hides the GPU\'s model (its device and description), and eligibility is per model: Chrome shows them with chrome://flags/#enable-webgpu-developer-features' };
    }
    if (!os) return { unknown: 'the operating system is not one this host knows' };
    if (!browser) return { unknown: 'the browser is not one this host knows' };
    return { key: [ENVIRONMENT_VERSION, vendor, architecture, device || '-', description || '-', backend || '-', os, browser].join('|') };
}

const product = (xs: readonly number[]) => xs.reduce((a, b) => a * b, 1);

/** One node's demand, read from X as the host defines it; a sentence when X does not say what the schema needs. */
function demandOf(x: Graph, n: DeepReadonly<XNode>, pixels: number, ops: ReadonlyMap<string, Op>): Demand | string {
    const op = (local: string) => ops.get(`${n.id}#${local}`);
    const need = (local: string): Op | string => op(local) ?? `X has no ${n.id}#${local} for ${n.adapterId}`;
    const base = { node: n.id, adapter: n.adapterId, adapterVersion: n.adapterVersion };
    switch (n.adapterId) {
        case 'ng.buffer.storage': {
            const r = x.resources.find(res => res.node === n.id && res.kind === 'buffer');
            if (!r) return `X has no buffer for ${n.id}`;
            return { ...base, max: { bytes: r.bytes * r.allocations }, values: { layout: [r.layout ?? 'none'], content: [r.content], pingPong: [String(r.pingPong)] } };
        }
        case 'ng.compute.stage': {
            const create = need('create');
            const dispatch = need('dispatch');
            if (typeof create === 'string') return create;
            if (typeof dispatch === 'string') return dispatch;
            const groups = dispatch.work.workgroups ?? [0, 0, 0];
            return {
                ...base, max: { invocations: dispatch.work.invocations ?? 0, workgroups: product(groups), workgroupSize: (create.args as { workgroupSize: number }).workgroupSize },
                values: { phase: [dispatch.phase] },
            };
        }
        case 'ng.geometry.primitive': {
            const create = need('create');
            if (typeof create === 'string') return create;
            const a = create.args as { factory: string; vertices: number; indices: number };
            return { ...base, max: { vertices: a.vertices, indices: a.indices }, values: { factory: [a.factory] } };
        }
        case 'ng.material.stock': {
            const create = need('create');
            if (typeof create === 'string') return create;
            return { ...base, max: {}, values: { class: [(create.args as { class: string }).class] } };
        }
        case 'ng.light.rig': {
            const create = need('create');
            if (typeof create === 'string') return create;
            const capacity = (create.args as { capacity: Record<string, number> }).capacity;
            return { ...base, max: { lights: Object.values(capacity).reduce((a, b) => a + b, 0) }, values: {} };
        }
        case 'ng.render.mesh_batch':
        case 'ng.render.custom_batch': {
            const create = need('create');
            const draw = need('draw');
            if (typeof create === 'string') return create;
            if (typeof draw === 'string') return draw;
            const a = create.args as { maxInstances: number; vertexLayout?: string | null; shader: { material?: string; lights?: boolean } };
            const lights = [String(!!a.shader.lights)];
            return {
                ...base, max: { instances: a.maxInstances, vertexInvocations: (draw.work.vertices ?? 0) * (draw.work.instances ?? 0) },
                values: n.adapterId === 'ng.render.mesh_batch' ? { material: [a.shader.material ?? 'none'], lights } : { vertexLayout: [a.vertexLayout ?? 'none'], lights },
            };
        }
        case 'ng.render.fullscreen': return { ...base, max: { pixels }, values: {} };
        case 'ng.post.chain': {
            const create = need('create');
            if (typeof create === 'string') return create;
            const effects = (create.args as { effects: { effect: string }[] }).effects;
            return { ...base, max: { effects: effects.length, pixels }, values: { effect: effects.map(e => e.effect) } };
        }
        default: return `${n.adapterId} has no coverage schema here`;
    }
}

/** What each node of X demands; `pixels` is the admitted target's. A sentence when one cannot be read. */
export function demandsOf(x: Graph, pixels: number): Demand[] | string {
    const ops = new Map(x.operations.map(o => [o.id, o]));
    const out: Demand[] = [];
    for (const n of x.nodes) {
        const d = demandOf(x, n, pixels, ops);
        if (typeof d === 'string') return d;
        out.push(d);
    }
    return out;
}

/** The first dimension or value of `d` that `c` does not cover; null when it covers all of them. */
function uncovered(d: Demand, c: Coverage): string | null {
    for (const [k, v] of Object.entries(d.max)) {
        const max = c.max[k];
        if (max === undefined || v > max) return `${k} ${v}${max === undefined ? ' (no range)' : ` over ${max}`}`;
    }
    for (const [k, vs] of Object.entries(d.values)) {
        const allowed = c.values[k] ?? [];
        const out = vs.find(v => !allowed.includes(v));
        if (out !== undefined) return `${k} ${out}`;
    }
    return null;
}

/**
 * Eligibility as EA-G1 writes it (§7, Q90): for one environment, an entry for each adapter the clean runs used, each
 * dimension the largest demand they exercised and each value they ran, never widened past what ran. The runs' demands
 * are read by `demandsOf` at the target they ran at. A schema dimension no run demanded stays at 0.
 */
export function eligibilityFrom(demands: readonly Demand[], context: { environment: string; engineBundleHash: string; evidence: string; profile?: string }): Eligibility[] {
    const by = new Map<string, Eligibility & { coverage: { max: Record<string, number>; values: Record<string, string[]> } }>();
    for (const d of demands) {
        const schema = COVERAGE_SCHEMA[d.adapter];
        if (!schema) throw new Error(`${d.adapter} has no coverage schema here: nothing is written for it`);
        const key = `${d.adapter}@${d.adapterVersion}`;
        const e = by.get(key) ?? {
            adapter: d.adapter, adapterVersion: d.adapterVersion, engineBundleHash: context.engineBundleHash, executorProfile: context.profile ?? EXECUTOR_PROFILE,
            environment: context.environment, evidence: context.evidence,
            coverage: { max: Object.fromEntries(schema.max.map(k => [k, 0])), values: Object.fromEntries(schema.values.map(k => [k, [] as string[]])) },
        };
        for (const [k, v] of Object.entries(d.max)) e.coverage.max[k] = Math.max(e.coverage.max[k] ?? 0, v);
        for (const [k, vs] of Object.entries(d.values)) for (const v of vs) if (!e.coverage.values[k].includes(v)) e.coverage.values[k].push(v);
        by.set(key, e);
    }
    return [...by.values()].map(e => ({ ...e, coverage: { max: { ...e.coverage.max }, values: Object.fromEntries(Object.entries(e.coverage.values).map(([k, v]) => [k, [...v].sort()])) } }));
}

export interface EligibilityContext {
    /** This device's environment; an unknown one matches nothing. */
    environment: Environment;
    engineBundleHash: string;
    profile: string;
    /** The admitted target's pixels: what a screen-sized node demands. */
    pixels: number;
}

/**
 * Why X may not execute here: the first node no single entry covers, in a developer's words (EA_ELIGIBILITY); null when
 * every node is covered.
 */
export function eligibilityOf(x: Graph, entries: readonly Eligibility[], context: EligibilityContext): string | null {
    const env = context.environment;
    const key = 'key' in env ? env.key : null;
    const where = `${key ?? `an unknown environment (${'unknown' in env ? env.unknown : 'no reason'})`} (${context.profile})`;
    const demands = demandsOf(x, context.pixels);
    if (typeof demands === 'string') return `EA_ELIGIBILITY ${demands}; static only`;
    for (const d of demands) {
        const label = `${d.adapter}@${d.adapterVersion}`;
        // An unknown environment matches nothing: no entry's environment is null (parseEligibility).
        const mine = entries.filter(e => e.adapter === d.adapter && e.adapterVersion === d.adapterVersion
            && e.engineBundleHash === context.engineBundleHash && e.executorProfile === context.profile && e.environment === key);
        if (!mine.length) return `EA_ELIGIBILITY ${label} (node ${d.node}) has no coverage for ${where}; static only`;
        const misses = mine.map(e => uncovered(d, e.coverage));
        if (misses.every(m => m !== null)) return `EA_ELIGIBILITY ${label} (node ${d.node}): ${misses[0]} has no coverage for ${where}; static only`;
    }
    return null;
}
