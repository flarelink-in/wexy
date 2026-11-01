// The candidate, sealed (candidate-loop-design.md §5's id(C) and §9, "The admission binds the candidate"; P8): what an
// admission is issued on, made only here, by the host. A snapshot holds X, its passing checks, its interfaces and the
// exact checked text of every module's body. Sealing trusts nothing a caller brings (the EA4.3 review): it takes W and
// resolves it itself, under the host's P and H, refusing when W resolves to another X than the one the caller's evidence
// names; it checks that X and derives its interfaces, each interfaceHash over its whole projection, so the module set is
// X's own; custom lighting stays gated, as the machine gates it (§6). It re-lints each body's text against its own
// interface (L1, the host's verdict on exactly that text), recomputes every codeHash, and holds the module set exactly:
// one body for each of X's modules, no missing, extra or duplicate one. id(C) is computed from the recomputed hashes,
// and the snapshot is frozen and remembered, so a look-alike or a copy, or a candidate whose bodies changed after its
// checks, is never one the host sealed. EA5's authority admits a sealed snapshot only, and only with device evidence
// for it.

import { BODY_CHECKER, lintBody } from '../contract/adapters/bodies';
import { canonicalHash, sha256Hex } from '../contract/adapters/canonical';
import { checkGraph, type Checked } from '../contract/adapters/checks';
import { POLICY_V1, type ExecutionGraph, type StaticPolicy } from '../contract/adapters/graph';
import { deriveInterfaces, notAuthorable, type ModuleInterface } from '../contract/adapters/interfaces';
import { resolveProgram, type Sources } from '../contract/adapters/resolve';
import { deepFreeze, type DeepReadonly } from '../contract/engine/frozen';

type Graph = DeepReadonly<ExecutionGraph>;

/** One module's body, as sealed: the text judged, its hashes, and the host's evidence that judged it. */
export interface SealedBody {
    module: string;
    interfaceHash: string;
    codeHash: string;
    checker: string;
    body: string;
    /** The lint record (and compile record, when L3 ran) that judged this text: what the completion references. */
    evidence: string[];
}

export interface SealedCandidate {
    attempt: string;
    revision: number;
    /** id(C): SHA-256 of canonical `{graph, modules: [[m, interfaceHash, codeHash], …]}`, sorted by m. */
    id: string;
    x: Graph;
    checked: Checked;
    interfaces: ModuleInterface[];
    bodies: SealedBody[];
}

export type Sealed = { ok: true; snapshot: DeepReadonly<SealedCandidate> } | { ok: false; reason: string };

/**
 * What the caller brings: W, the X its evidence names, and each module's checked text, a claimed hash optional. No X,
 * checks or interfaces: the seal makes its own from W.
 */
export interface SealInput {
    attempt: string;
    revision: number;
    /** W's nodes, as the candidate was resolved from them. */
    program: unknown;
    /** The hash of the X the caller's evidence is about: W resolving to any other X is refused. */
    graph: string;
    bodies: readonly { module: string; interfaceHash: string; body: string; codeHash?: string; evidence?: readonly string[] }[];
}

/**
 * The P, H and sources W is resolved under: the host's own (as the candidate machine resolves) unless a test stands in
 * another, as `resolveProgram` lets it. X's identity names whichever it was.
 */
export interface SealContext {
    policy?: StaticPolicy;
    support?: ReadonlyMap<string, string>;
    sources?: Sources;
}

const SEALED = new WeakSet<object>();

/** Whether the host sealed this very object (not a copy, not a look-alike). */
export const isSealed = (snapshot: unknown): boolean => typeof snapshot === 'object' && snapshot !== null && SEALED.has(snapshot);

/** id(C) (the design §2, §5): over X's hash and each module's hashes, the modules in code-unit order, not locale. */
export function candidateId(graph: string, modules: readonly (readonly [string, string, string])[]): Promise<string> {
    const sorted = [...modules].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(m => [...m]);
    return canonicalHash({ graph, modules: sorted });
}

/** Seals a candidate, or says why not. X, its checks and its interfaces are made here; every hash is recomputed. */
export async function sealCandidate(input: SealInput, context: SealContext = {}): Promise<Sealed> {
    const policy = context.policy ?? POLICY_V1;
    const resolved = await resolveProgram(input.program, policy, context.support, context.sources);
    if (!resolved.ok) {
        const first = resolved.diagnostics[0];
        return { ok: false, reason: `W does not resolve${first ? `: ${first.code} ${first.path}` : ''}` };
    }
    const x = resolved.graph;
    if (x.hash !== input.graph) return { ok: false, reason: 'W resolves to another X than the one its evidence is for' };
    const checked = await checkGraph(x, policy);
    if (!checked.ok) return { ok: false, reason: 'X does not pass its checks' };
    const derived = await deriveInterfaces(x);
    if (!derived.ok) return { ok: false, reason: 'X\'s module interfaces cannot be derived' };
    const interfaces = derived.interfaces;
    for (const iface of interfaces) {
        const why = notAuthorable(iface);
        if (why) return { ok: false, reason: `module ${iface.module} cannot be authored yet: ${why}` };
    }
    const byModule = new Map<string, typeof input.bodies[number]>();
    for (const b of input.bodies) {
        if (byModule.has(b.module)) return { ok: false, reason: `module ${b.module} has two bodies` };
        byModule.set(b.module, b);
    }
    for (const m of byModule.keys()) {
        if (!interfaces.some(i => i.module === m)) return { ok: false, reason: `module ${m} is not one of X's` };
    }
    const bodies: SealedBody[] = [];
    for (const iface of interfaces) {
        const b = byModule.get(iface.module);
        if (!b) return { ok: false, reason: `module ${iface.module} has no body` };
        if (b.interfaceHash !== iface.interfaceHash) return { ok: false, reason: `module ${iface.module}'s body was written for another interface` };
        if (typeof b.body !== 'string') return { ok: false, reason: `module ${iface.module}'s body is not text` };
        // The hash is the host's, of the text in hand: a claimed one that differs is refused, never trusted.
        const codeHash = await sha256Hex(b.body);
        if (b.codeHash !== undefined && b.codeHash !== codeHash) return { ok: false, reason: `module ${iface.module}'s body is not the text its codeHash names` };
        if (lintBody(iface, b.body).some(f => f.severity === 'error')) return { ok: false, reason: `module ${iface.module}'s body does not pass the host's lint` };
        bodies.push({ module: iface.module, interfaceHash: iface.interfaceHash, codeHash, checker: BODY_CHECKER, body: b.body, evidence: [...(b.evidence ?? [])] });
    }
    const id = await candidateId(x.hash, bodies.map(b => [b.module, b.interfaceHash, b.codeHash] as const));
    const snapshot = deepFreeze(structuredClone({
        attempt: input.attempt, revision: input.revision, id, x, checked, interfaces, bodies,
    }) as SealedCandidate);
    SEALED.add(snapshot);
    return { ok: true, snapshot };
}
