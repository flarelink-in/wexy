// The authority's gate (EA5.3; executor-design.md §7): what decides, on this device, that a sealed candidate with its
// compile evidence and the developer's GPU go may be built. In order, each refusal in a developer's words:
//   - provenance (EA_EVIDENCE): the compile verdicts are this device compiler's own, for exactly C's bodies, in the
//     device's current generation (the device compiler's `provenance`, EA5.1): a copy, a fake's, another device's or an
//     older generation's proves nothing;
//   - the GPU go (EA_EVIDENCE): pressed in Developer view for this id(C), in this turn, on this device generation, and
//     spent by this attempt. A repair or reseal (another id(C)), a new turn or a device loss leaves none standing (P7);
//   - the allowlist (EA_CALL): every operation of X names a call the executor runs;
//   - the device's limits (EA_ADMIT): allocations, bound ranges, bindings a stage, workgroups, dispatches, textures,
//     formats and usages against this device's own limits. A requirement the gate does not know refuses;
//   - coverage (2026-11-02): a missing prior measurement warns by default, permitting bounded validation, not full-size
//     execution. Malformed coverage/demands still refuse. Strict coverage remains available to verification harnesses;
//   - memory (EA_ADMIT): the peak overlap reserved atomically before anything is allocated (I7): every holder in the
//     ledger (the Head among them), this candidate at the admitted target, its probe and its readback, within the 1 GiB
//     device budget (Q90). P v1's 256 MiB stays the resolver's, at P's profile, and is not applied again here.
// The reservation goes to the caller (`claim`), which releases it on every path that does not install and, on install,
// shrinks it to the candidate's own share, which the Head then holds. Admission permits bounded construction only: the
// probe still decides any full-size work (§9).
//
// The EA-G1 bootstrap (§7): a developer harness may pin up to three fixtures by id(C) and run them without production
// eligibility, under every other rule here. Only code that constructs a gate with `bootstrap` can; no URL, model,
// imported candidate or the studio's Run control reaches that option.

import { POLICY_V1, type ExecutionGraph, type XResource } from '../contract/adapters/graph';
import type { CompiledBody } from '../contract/adapters/bodies';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { Gate, Present } from '../loop/executor';
import type { SealedCandidate } from '../loop/snapshot';
import { EXECUTOR_CALLS } from './engine-executor';
import { EXECUTOR_PROFILE, SHIPPED, demandsOf, eligibilityOf, type Environment, type Parsed } from './eligibility';

type Graph = DeepReadonly<ExecutionGraph>;
type Snapshot = DeepReadonly<SealedCandidate>;

/** The device reservation's host budget (Q90): a policy budget, not a VRAM measurement. */
export const DEVICE_BUDGET = 1024 ** 3;
/** The probe's frames and its state sample (§9): what its variants and the readback hold, counted before any of it exists. */
export const PROBE_FRAME = { width: 1280, height: 720 } as const;
export const SAMPLE_INSTANCES = 1024;
/** At most this many fixtures a bootstrap pins (EA-G1's three worlds). */
export const MAX_PINNED = 3;

export interface Target {
    width: number;
    height: number;
}

/** The device limits the gate reads: the GPUSupportedLimits of the adapter's device. */
export interface DeviceLimits {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxUniformBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
    maxUniformBuffersPerShaderStage: number;
    maxBindGroups: number;
    maxBindingsPerBindGroup: number;
    maxComputeWorkgroupSizeX: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxComputeWorkgroupsPerDimension: number;
    maxTextureDimension2D: number;
    maxVertexBuffers: number;
    maxVertexAttributes: number;
    maxColorAttachments: number;
}

const LIMIT_NAMES: readonly (keyof DeviceLimits)[] = [
    'maxBufferSize', 'maxStorageBufferBindingSize', 'maxUniformBufferBindingSize', 'maxStorageBuffersPerShaderStage', 'maxUniformBuffersPerShaderStage',
    'maxBindGroups', 'maxBindingsPerBindGroup', 'maxComputeWorkgroupSizeX', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension',
    'maxTextureDimension2D', 'maxVertexBuffers', 'maxVertexAttributes', 'maxColorAttachments',
];

/** The limits of `device`, as it reports them (the requested ones: null-graph asks for the adapter's largest buffers). */
export function limitsOf(device: { limits: GPUSupportedLimits }): DeviceLimits {
    return Object.fromEntries(LIMIT_NAMES.map(n => [n, Number(device.limits[n])])) as unknown as DeviceLimits;
}

// ------------------------------------------------------------------ the GPU go

/** The developer's GPU go (Q89): one press, for one id(C), in one turn, on one device generation, spent by one attempt. */
export interface GoLedger {
    press(candidate: string, turn: number, generation: number): void;
    /** Whether a go stands for exactly this. */
    holds(candidate: string, turn: number, generation: number): boolean;
    /** Spends the go: true when one stood for exactly this. None stands after, either way. */
    take(candidate: string, turn: number, generation: number): boolean;
    /** None stands: a device loss, or a page that resets. */
    clear(): void;
}

export function createGoLedger(): GoLedger {
    let go: { candidate: string; turn: number; generation: number } | null = null;
    const matches = (candidate: string, turn: number, generation: number) =>
        go !== null && go.candidate === candidate && go.turn === turn && go.generation === generation;
    return {
        press(candidate, turn, generation) { go = { candidate, turn, generation }; },
        holds: matches,
        take(candidate, turn, generation) {
            const ok = matches(candidate, turn, generation);
            go = null;
            return ok;
        },
        clear() { go = null; },
    };
}

// ------------------------------------------------------------------ the device reservation

/** Bytes held on the device by one holder: a Head, a construction, a film's (I7). */
export interface Reservation {
    readonly label: string;
    readonly bytes: number;
    readonly released: boolean;
    /** Keeps at most `bytes` of it: what a construction returns once its probe and readback are gone. */
    shrink(bytes: number): void;
    /** Returns it; a second release does nothing. */
    release(): void;
}

export interface MemoryLedger {
    readonly budget: number;
    /** What every holder holds now. */
    held(): number;
    /** `bytes` reserved at once, or why not: every holder and these, over the budget. */
    reserve(label: string, bytes: number): Reservation | string;
    /** What a world built without admission already holds (h1's Head): counted, never refused. */
    record(label: string, bytes: number): Reservation;
    /** Each holder, for Developer view. */
    holders(): { label: string; bytes: number }[];
}

export function createMemoryLedger(budget: number = DEVICE_BUDGET): MemoryLedger {
    const live = new Set<{ label: string; bytes: number }>();
    const held = () => [...live].reduce((sum, h) => sum + h.bytes, 0);
    const hold = (label: string, bytes: number): Reservation => {
        const entry = { label, bytes: Math.max(0, Math.ceil(bytes)) };
        live.add(entry);
        let released = false;
        return {
            label,
            get bytes() { return released ? 0 : entry.bytes; },
            get released() { return released; },
            shrink(to) { if (!released) entry.bytes = Math.min(entry.bytes, Math.max(0, Math.ceil(to))); },
            // A second release does nothing: the entry has left the set already.
            release() {
                released = true;
                live.delete(entry);
            },
        };
    };
    return {
        budget,
        held,
        reserve(label, bytes) {
            const now = held();
            const need = Math.max(0, Math.ceil(bytes));
            if (now + need > budget) return `${now + need} bytes over the ${budget} budget (held ${now}, this ${need})`;
            return hold(label, need);
        },
        record: hold,
        holders: () => [...live].map(h => ({ label: h.label, bytes: h.bytes })),
    };
}

const align4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);
const short = (hash: string) => `${hash.slice(0, 12)}…`;

/** A resource's texels at `target`: X sizes it at P's viewport, and a resizing one follows the target. */
function sizeAt(r: DeepReadonly<XResource>, target: Target, viewport: Target): [number, number] {
    const [w, h] = r.size ?? [1, 1];
    if (!r.resizes) return [w, h];
    return [Math.max(1, Math.ceil(w * target.width / viewport.width)), Math.max(1, Math.ceil(h * target.height / viewport.height))];
}

/** One allocation's bytes at `target`. */
function bytesAt(r: DeepReadonly<XResource>, target: Target, viewport: Target): number {
    if (!r.resizes) return r.bytes;
    return Math.ceil(r.bytes * (target.width * target.height) / (viewport.width * viewport.height));
}

/** What C holds on the device at `target`, and what its probe and readback add while it is prepared (I7). */
export interface ReservationNeed {
    candidate: number;
    probe: number;
    readback: number;
    total: number;
}

/**
 * The bytes C needs at `target`: its own allocations there (a borrowed alias, Q76(b)'s adopted buffer, is one resource
 * of X and so counted once; the engine's shared ones are counted too); its two probe variants, each at most C's fixed
 * bytes and its screen-sized bytes at the probe's large frame, with each headless engine's screen and depth; and the
 * first frame's private colour, depth and staging, with the state sample.
 */
export function reservationFor(x: Graph, target: Target, viewport: Target = POLICY_V1.viewport): ReservationNeed {
    const counted = x.resources.filter(r => r.owner !== 'canvas');
    const at = (t: Target) => counted.reduce((sum, r) => sum + bytesAt(r, t, viewport) * r.allocations, 0);
    const candidate = at(target);
    // A variant holds at most C's bytes at the probe's frame (its counts are smaller); its engine adds a screen and a depth.
    const probe = 2 * (at(PROBE_FRAME) + PROBE_FRAME.width * PROBE_FRAME.height * (4 + 4));
    const pixels = target.width * target.height;
    const staging = Math.ceil(target.width * 4 / 256) * 256 * target.height;
    const samples = counted.filter(r => r.kind === 'buffer' && (r.layout === 'instance14' || r.layout === 'f32'))
        .reduce((sum, r) => sum + Math.min(r.elements ?? 0, SAMPLE_INSTANCES) * (r.strideFloats ?? 0) * 4, 0);
    const readback = pixels * 4 + pixels * 4 + staging + samples;
    return { candidate, probe, readback, total: candidate + probe + readback };
}

// ------------------------------------------------------------------ the device's limits

const BUFFER_USAGES: ReadonlySet<string> = new Set(['storage', 'copy_src', 'copy_dst', 'uniform', 'vertex', 'index']);
const TEXTURE_USAGES: ReadonlySet<string> = new Set(['render_attachment', 'texture_binding']);
/** The formats X names (contribute.ts's post targets, the engine's depth and fallbacks, the canvas's). */
const TEXTURE_FORMATS: ReadonlySet<string> = new Set(['canvas', 'rgba16float', 'rg16float', 'r16float', 'r8unorm', 'rgba8unorm', 'depth24plus']);
/** Features a Tier-1 world requires: none (the lint refuses f16, subgroups and the rest). */
export const REQUIRED_FEATURES: readonly string[] = [];

/** Why this device cannot hold or run C at `target`; null when it can. */
export function limitsProblem(snapshot: Snapshot, l: DeviceLimits, target: Target, gpu: string, viewport: Target = POLICY_V1.viewport): string | null {
    const over = (what: string, n: number, limit: number) => `EA_ADMIT ${what}: ${n} over ${limit} on ${gpu}`;
    const unknown = (what: string) => `EA_ADMIT ${what} is not one this gate knows, on ${gpu}`;
    const x = snapshot.x;
    const resources = new Map(x.resources.map(r => [r.id, r]));
    for (const r of x.resources) {
        if (r.owner === 'canvas') continue;
        if (r.kind === 'buffer') {
            const usage = r.usage.find(u => !BUFFER_USAGES.has(u));
            if (usage !== undefined) return unknown(`${r.id}'s buffer usage ${usage}`);
            if (align4(r.bytes) > l.maxBufferSize) return over(`${r.id} allocation bytes`, align4(r.bytes), l.maxBufferSize);
        } else if (r.kind === 'texture') {
            const usage = r.usage.find(u => !TEXTURE_USAGES.has(u));
            if (usage !== undefined) return unknown(`${r.id}'s texture usage ${usage}`);
            if (r.format === null || !TEXTURE_FORMATS.has(r.format)) return unknown(`${r.id}'s texture format ${String(r.format)}`);
            const side = Math.max(...sizeAt(r, target, viewport));
            if (side > l.maxTextureDimension2D) return over(`${r.id} texture side`, side, l.maxTextureDimension2D);
        } else {
            return unknown(`${r.id}'s kind ${String(r.kind)}`);
        }
    }
    for (const iface of snapshot.interfaces) {
        const storage = iface.bindings.filter(b => b.access !== 'uniform').length;
        const uniform = iface.bindings.filter(b => b.access === 'uniform').length;
        if (storage > l.maxStorageBuffersPerShaderStage) return over(`${iface.module} storage buffers a stage`, storage, l.maxStorageBuffersPerShaderStage);
        if (uniform > l.maxUniformBuffersPerShaderStage) return over(`${iface.module} uniform buffers a stage`, uniform, l.maxUniformBuffersPerShaderStage);
        const groups = Math.max(-1, ...iface.bindings.map(b => b.group)) + 1;
        if (groups > l.maxBindGroups) return over(`${iface.module} bind groups`, groups, l.maxBindGroups);
        const bindings = Math.max(-1, ...iface.bindings.map(b => b.binding)) + 1;
        if (bindings > l.maxBindingsPerBindGroup) return over(`${iface.module} bindings a group`, bindings, l.maxBindingsPerBindGroup);
        for (const b of iface.bindings) {
            const r = resources.get(b.resource);
            if (!r) return unknown(`${iface.module}'s binding of ${b.resource}`);
            const range = align4(r.bytes);
            const limit = b.access === 'uniform' ? l.maxUniformBufferBindingSize : l.maxStorageBufferBindingSize;
            if (range > limit) return over(`${iface.module} binding ${b.name} bytes`, range, limit);
        }
    }
    for (const op of x.operations) {
        if (op.call === 'engine.createComputeStage') {
            const a = op.args as { workgroupSize: number; dispatch: readonly number[] };
            if (a.workgroupSize > l.maxComputeWorkgroupSizeX) return over(`${op.id} workgroup size`, a.workgroupSize, l.maxComputeWorkgroupSizeX);
            if (a.workgroupSize > l.maxComputeInvocationsPerWorkgroup) return over(`${op.id} invocations a workgroup`, a.workgroupSize, l.maxComputeInvocationsPerWorkgroup);
            const most = Math.max(...a.dispatch);
            if (most > l.maxComputeWorkgroupsPerDimension) return over(`${op.id} workgroups a dimension`, most, l.maxComputeWorkgroupsPerDimension);
        } else if (op.call === 'engine.createBatch') {
            const a = op.args as { vertexLayout: string | null; shader: { kind: string; lights?: boolean } };
            if (a.vertexLayout === 'StandardLayout') {
                // One vertex buffer of three attributes: position, normal, uv.
                if (l.maxVertexBuffers < 1) return over(`${op.id} vertex buffers`, 1, l.maxVertexBuffers);
                if (l.maxVertexAttributes < 3) return over(`${op.id} vertex attributes`, 3, l.maxVertexAttributes);
            } else if (a.vertexLayout !== null) {
                return unknown(`${op.id}'s vertex layout ${String(a.vertexLayout)}`);
            }
            // A stock material binds the engine's group 0 and its material's group 1, and, lit, LightSystem's group 2.
            const groups = a.shader.kind === 'stock' ? (a.shader.lights ? 3 : 2) : 0;
            if (groups > l.maxBindGroups) return over(`${op.id} bind groups`, groups, l.maxBindGroups);
        }
    }
    if (l.maxColorAttachments < 1) return over('colour attachments a pass', 1, l.maxColorAttachments);
    return null;
}

// ------------------------------------------------------------------ the gate

/** EA-G1's harness, and the fixtures it pinned (§7). */
export interface Bootstrap {
    harness: 'EA-G1';
    candidates: ReadonlySet<string>;
}

export interface GateOptions {
    limits: DeviceLimits;
    /** The device compiler whose verdicts admit: asked at each admission; null (no WebGPU yet) admits nothing. */
    compiler: () => { provenance(snapshot: Snapshot, compiled: readonly DeepReadonly<CompiledBody>[]): string | null } | null;
    goes: GoLedger;
    present: Present;
    ledger: MemoryLedger;
    /** The admitted envelope: the stage's live shape at its pixel cap, or a film's size. */
    target: () => Target;
    /** This device's environment (eligibility.ts's environmentOf); an unknown one matches no entry. */
    environment: Environment;
    /** The GPU's name, as messages say it. */
    gpu: string;
    /** The eligibility in force: the shipped file by default. */
    eligibility?: Parsed;
    /** Prior measurements are advisory by default; strict is for coverage verification, not normal studio Run. */
    coveragePolicy?: 'advisory' | 'strict';
    profile?: string;
    /** EA-G1's harness only (§7): never the studio's. */
    bootstrap?: Bootstrap;
    /** P's viewport, at which X sizes its screen-sized resources. */
    viewport?: Target;
}

export interface CandidateGate {
    readonly gate: Gate;
    /** Prior coverage is not a runtime verdict; retained for this exact snapshot, never written to eligibility.json. */
    coverageWarning(snapshot: Snapshot): string | null;
    /** The reservation an admission of `snapshot` made, handed over once: its holder releases or keeps it. */
    claim(snapshot: Snapshot): Reservation | null;
}

export function createGate(options: GateOptions): CandidateGate {
    const eligibility = options.eligibility ?? SHIPPED;
    const profile = options.profile ?? EXECUTOR_PROFILE;
    const viewport = options.viewport ?? POLICY_V1.viewport;
    const bootstrap = options.bootstrap;
    if (bootstrap && (bootstrap.harness !== 'EA-G1' || bootstrap.candidates.size > MAX_PINNED)) {
        throw new Error(`a bootstrap is EA-G1's harness's alone, for at most ${MAX_PINNED} pinned fixtures`);
    }
    const claims = new Map<Snapshot, Reservation[]>();
    const warnings = new WeakMap<Snapshot, string>();

    const gate: Gate = (snapshot, evidence) => {
        warnings.delete(snapshot);
        const id = short(snapshot.id);
        const compiler = options.compiler();
        if (!compiler) return `EA_EVIDENCE ${id}: no device compiler here, so no verdict says this device compiles it`;
        const provenance = compiler.provenance(snapshot, evidence.compiled);
        if (provenance !== null) return `EA_EVIDENCE ${id}: ${provenance}`;
        const turn = options.present.turn();
        const generation = options.present.device();
        if (!options.goes.take(snapshot.id, turn, generation)) {
            return `EA_EVIDENCE ${id}: no GPU go for this candidate in turn ${turn} on device generation ${generation}: press Run on this GPU for it`;
        }
        const call = snapshot.x.operations.find(o => !EXECUTOR_CALLS.has(o.call));
        if (call) return `EA_CALL ${call.id}: ${call.call} is not one the executor runs`;
        const target = options.target();
        const limit = limitsProblem(snapshot, options.limits, target, options.gpu, viewport);
        if (limit !== null) return limit;
        if (!bootstrap?.candidates.has(snapshot.id)) {
            if (!eligibility.ok) return `EA_ELIGIBILITY ${eligibility.reason}; static only`;
            const demands = demandsOf(snapshot.x, target.width * target.height);
            if (typeof demands === 'string') return `EA_ELIGIBILITY ${demands}; static only`;
            const why = eligibilityOf(snapshot.x, eligibility.entries, {
                environment: options.environment, engineBundleHash: snapshot.x.identity.bundleHash, profile, pixels: target.width * target.height,
            });
            if (why !== null) {
                if (options.coveragePolicy === 'strict') return why;
                warnings.set(snapshot, `EA_COVERAGE_UNVERIFIED ${why.replace(/^EA_ELIGIBILITY /, '').replace(/; static only$/, '')}; attempting bounded validation on this device, not previously verified coverage`);
            }
        }
        const need = reservationFor(snapshot.x, target, viewport);
        const reservation = options.ledger.reserve(`candidate ${id}`, need.total);
        if (typeof reservation === 'string') return `EA_ADMIT memory: ${reservation} on ${options.gpu}`;
        claims.set(snapshot, [...(claims.get(snapshot) ?? []), reservation]);
        return null;
    };

    return {
        gate,
        coverageWarning: snapshot => warnings.get(snapshot) ?? null,
        claim(snapshot) {
            const list = claims.get(snapshot);
            const first = list?.shift() ?? null;
            if (list && !list.length) claims.delete(snapshot);
            return first;
        },
    };
}
