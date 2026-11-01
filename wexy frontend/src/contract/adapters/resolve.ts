// Resolve(W, H, A, P) → X or a refusal (engine-adapters-design.md §2, §6; EA3.2), on the CPU, reading no device.
// The nodes are checked (EA3.1), then each is resolved in construction order (producers first, program order between
// independent nodes) by its adapter's trusted code, the host's own part is added, and every phase is scheduled: a
// stable topological order in which explicit dependencies come first, then each resource's writers in turn before
// its readers, and only then the kind of work and program order. A cycle refuses; nothing is reordered to make a
// graph pass. X is frozen, hashed over its canonical JSON, and always static only (Q75 as decided).

import bundleText from '../engine/bundle.json?raw';
import { deepFreeze, type DeepReadonly } from '../engine/frozen';
import { canonicalHash, sha256Hex } from './canonical';
import {
    HOST, IMPLEMENTATIONS, NO_CONTENT, SizeOverflow, hostPart, xid, type ContentSource, type Contribution, type Frame, type Produced, type Refusal, type Wired,
} from './contribute';
import {
    PHASES, POLICY_V1, type ExecutionGraph, type OperationKind, type Phase, type StaticPolicy, type XEstimate, type XModuleRequest, type XOperation,
    type XOutput, type XResource, type XSource,
} from './graph';
import {
    ADAPTER_MANIFEST_TEXT, ADAPTERS, SHIPPED_GATES, SHIPPED_SUPPORT, checkNodes, pointer, type CheckedNode, type ResolveCode, type ResolveDiagnostic, type VariantGate,
} from './index';

/** X's own contract version. */
export const GRAPH_VERSION = 'ea-x.v1';
/**
 * Bump whenever this file or contribute.ts changes what X says, even if the descriptors' bytes do not (§6). 2: Q80's
 * gates in X's identity and an upload's seed named by its content source; Q81's per-step clock, its buffer and its
 * write before each fixed step, counted in the frame's uploads. 3 (EA5.0): Q76(b)'s adoption, and null-graph 1.2.1's
 * releases (removeComputeStage, removePass, PostChain's destroy releasing its batches and passes) with no retention.
 */
export const RESOLVER_VERSION = 'ea3.2-resolver.3';

/**
 * What a world may be seeded from, and which of the manifest's variant gates hold (Q80). Tier 1 is every gate and no
 * content source; a test that lifts a gate and supplies content stands in for Tier 2, and X's identity says so.
 */
export interface Sources {
    gates: readonly DeepReadonly<VariantGate>[];
    content: ContentSource;
}
export const TIER_1: Sources = Object.freeze({ gates: SHIPPED_GATES, content: NO_CONTENT });

const BUNDLE_HASH = (JSON.parse(bundleText) as { bundleHash: string }).bundleHash;

export type Resolved = { ok: true; graph: DeepReadonly<ExecutionGraph> } | { ok: false; diagnostics: ResolveDiagnostic[] };

/**
 * The order of the kinds of work inside a phase when nothing else orders two operations: construction, host
 * uploads, compute and copies, the main pass's clear, its draws, the post chain (§6: dependencies first, this after).
 */
const STAGE: Readonly<Record<OperationKind, number>> = { create: 0, upload: 1, compute: 2, swap: 2, copy: 2, clear: 3, backdrop: 4, draw: 5, post: 6, resize: 7, destroy: 8 };

/** W as X's hash sees it: each node with its config parsed, so the config text's spacing and key order do not count. */
const programOf = (nodes: CheckedNode[]) => nodes.map(n => ({ id: n.id, adapterId: n.adapter.id, adapterVersion: n.adapter.version, config: n.config, inputs: n.inputs }));

/**
 * W's programHash, whether or not W resolves (candidate-loop-design.md §5, P10: a subject names its program before any X
 * exists). When the nodes pass their check, it is the hash X's identity carries, of the nodes with their configs parsed;
 * when the check refuses them, it is the hash of W as it came, which no X can carry.
 */
export async function programHash(input: unknown, policy: StaticPolicy = POLICY_V1, support: ReadonlyMap<string, string> = SHIPPED_SUPPORT,
    sources: Sources = TIER_1): Promise<string> {
    const checked = checkNodes(input, policy, support, sources.gates);
    return canonicalHash(checked.ok ? programOf(checked.nodes) : input);
}

/**
 * The program's nodes resolved to X under P and H, or every refusal with its path. `support` is injected so tests can
 * use a labelled synthetic H, and `sources` so they can stand in for Tier 2 (Q80); X's identity hashes whichever it was
 * resolved under.
 */
export async function resolveProgram(input: unknown, policy: StaticPolicy = POLICY_V1, support: ReadonlyMap<string, string> = SHIPPED_SUPPORT,
    sources: Sources = TIER_1): Promise<Resolved> {
    const checked = checkNodes(input, policy, support, sources.gates);
    if (!checked.ok) return checked;
    const built = build(checked.nodes, policy, support, sources.content);
    if (!built.ok) return built;
    const [manifestHash, programHash, policyHash, supportStatusHash, gatesHash] = await Promise.all([
        sha256Hex(ADAPTER_MANIFEST_TEXT), canonicalHash(programOf(checked.nodes)), canonicalHash(policy), canonicalHash(Object.fromEntries(support)),
        canonicalHash(sources.gates),
    ]);
    const body: Omit<ExecutionGraph, 'hash'> = {
        identity: {
            graph: GRAPH_VERSION, resolver: RESOLVER_VERSION, engine: ADAPTERS.engine, bundleHash: BUNDLE_HASH, supportStatusHash,
            manifest: ADAPTERS.version, manifestHash, gatesHash, programHash, policyHash,
        },
        executable: false,
        ...built.draft,
    };
    return { ok: true, graph: deepFreeze({ ...body, hash: await canonicalHash(body) }) };
}

type Draft = Omit<ExecutionGraph, 'identity' | 'executable' | 'hash'>;
type Built = { ok: true; draft: Draft } | { ok: false; diagnostics: ResolveDiagnostic[] };

function build(nodes: CheckedNode[], policy: StaticPolicy, support: ReadonlyMap<string, string>, content: ContentSource): Built {
    const diagnostics: ResolveDiagnostic[] = [];
    const fail = (code: ResolveCode, path: string, nodeId: string | null, message: string) => { diagnostics.push({ code, path, nodeId, message }); };
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const pathOf = (id: string) => pointer('nodes', index.get(id)!);

    // One main pass, so at most one post chain over it (Tier 1).
    const posts = nodes.filter(n => n.adapter.id === 'ng.post.chain');
    for (const extra of posts.slice(1)) fail('EA_RESOLVE', pathOf(extra.id), extra.id, `a world has one post chain in Tier 1, and ${posts[0].id} is it`);
    if (diagnostics.length) return { ok: false, diagnostics };
    const post = posts[0] ?? null;
    const frame: Frame = post
        ? { color: xid(post.id, 'sceneColor'), depth: xid(post.id, 'sceneDepth'), colorFormat: 'rgba16float', post: post.id }
        : { color: xid(HOST, 'screen'), depth: xid(HOST, 'depth'), colorFormat: 'canvas', post: null };

    // A cycle is reported at its member earliest in the program, and read from there.
    const fromFirst = (ring: string[], nodeOf: (id: string) => string) => {
        const members = ring.filter(id => nodeOf(id) !== HOST);
        const first = members.reduce((a, b) => (index.get(nodeOf(b))! < index.get(nodeOf(a))! ? b : a), members[0] ?? ring[0]);
        const at = ring.indexOf(first);
        return [...ring.slice(at), ...ring.slice(0, at)];
    };
    const order = constructionOrder(nodes);
    if (!order.ok) {
        const ring = fromFirst(order.cycle, id => id);
        fail('EA_RESOLVE', `${pathOf(ring[0])}/inputs`, ring[0], `a dependency cycle: ${[...ring, ring[0]].join(' → ')}`);
        return { ok: false, diagnostics };
    }

    // Each node by its adapter's code, after everything it is wired to. A node whose producer refused is skipped, not
    // refused again: one cause, one diagnostic.
    const adoption = adoptions(nodes);
    const produced = new Map<string, Record<string, Produced>>();
    const parts: Contribution[] = [];
    const refused = new Set<string>();
    for (const node of order.nodes) {
        if (node.inputs.some(w => refused.has(w.nodeId))) { refused.add(node.id); continue; }
        const inputs: Wired[] = node.inputs.map((w, j) => {
            const from = produced.get(w.nodeId)?.[w.output];
            if (!from) throw new Error(`EA3: ${w.nodeId} resolved without its output ${w.output}`);
            return { port: w.port, nodeId: w.nodeId, from, path: `${pathOf(node.id)}/inputs/${j}` };
        });
        const impl = IMPLEMENTATIONS[node.adapter.id];
        let part: Contribution | Refusal;
        try {
            part = impl
                ? impl({ node, path: pathOf(node.id), inputs, frame, policy, content, adoption })
                : { refused: true, code: 'EA_CAPABILITY_UNSUPPORTED', path: `${pathOf(node.id)}/adapterId`, message: `${node.adapter.id} has a descriptor but no implementation` };
        } catch (e) {
            if (!(e instanceof SizeOverflow)) throw e;
            part = { refused: true, code: 'EA_RESOLVE', path: pathOf(node.id), message: `${node.id}: ${e.message}, so its size cannot be bounded` };
        }
        if ('refused' in part) { fail(part.code, part.path, node.id, part.message); refused.add(node.id); continue; }
        produced.set(node.id, part.outputs);
        parts.push(part);
    }
    if (diagnostics.length) return { ok: false, diagnostics };

    const fixedStep = nodes.some(n => n.adapter.id === 'ng.compute.stage' && n.config.phase === 'fixedStep');
    const all = [hostPart(frame, policy, nodes.some(n => n.adapter.id === 'ng.material.stock'), fixedStep), ...parts];
    const resources = all.flatMap(p => p.resources);
    const objects = all.flatMap(p => p.objects);
    const operations = all.flatMap(p => p.operations);
    const sources: Record<string, string[]> = Object.assign({}, ...all.map(p => p.sources));
    const ids = new Set<string>();
    for (const x of [...resources, ...objects, ...operations]) {
        if (ids.has(x.id)) throw new Error(`EA3: ${x.id} was contributed twice`);
        ids.add(x.id);
    }
    if (operations.length > policy.maxOperations) {
        fail('EA_RESOLVE', '/nodes', null, `the program expands to ${operations.length} operations, over P's ${policy.maxOperations}; use fewer nodes`);
        return { ok: false, diagnostics };
    }
    // Construction follows the wiring, explicitly: a node is made after everything it is wired to, and EA5's cleanup of
    // a partial init reads these edges backwards (§7, §9). An adopted buffer is made by its batch's create (Q76(b)): its
    // batch has nothing to wait for, and every other node wired to it waits for that create, so a stage that binds the
    // batch's storage is made after it and, disposal undoing construction, dropped before its clear.
    const creates = new Map(operations.filter(o => o.kind === 'create').map(o => [o.node, o]));
    for (const n of nodes) {
        const made = creates.get(n.id);
        if (!made) {
            if (adoption.has(n.id)) continue;
            throw new Error(`EA3: ${n.adapter.id} contributed no create`);
        }
        for (const w of n.inputs) {
            const maker = adoption.get(w.nodeId) ?? w.nodeId;
            if (maker !== n.id && !made.after.includes(xid(maker, 'create'))) made.after.push(xid(maker, 'create'));
        }
    }
    // NullGraph draws a pass's batches in the order they were created (RenderPass.addBatch): backdrops first, then program
    // order. That order is a dependency, of the creates and of the draws both, after the pass's clear.
    const draws = operations.filter(o => o.kind === 'draw' || o.kind === 'backdrop')
        .sort((a, b) => compareKeys([STAGE[a.kind], index.get(a.node)!], [STAGE[b.kind], index.get(b.node)!]));
    draws.forEach((d, i) => {
        if (i > 0) creates.get(d.node)!.after.push(xid(draws[i - 1].node, 'create'));
        d.after.push(i === 0 ? xid(HOST, 'clear') : draws[i - 1].id);
    });
    // Nothing in init touches an allocation before the create that makes it: a create is the first kind of work that
    // writes it (schedulePhase), and a reader follows every writer. And nothing of a node's runs before the node exists.
    for (const o of operations) {
        const made = creates.get(o.node);
        if (o.phase === 'init' && o.kind !== 'create' && made && !o.after.includes(made.id)) o.after.push(made.id);
    }

    // A copy into a batch's storage runs each frame only when something writes its source after init.
    const written = new Set(operations.filter(o => o.phase === 'fixedStep' || o.phase === 'frame').flatMap(o => o.accesses.filter(a => a.mode !== 'read').map(a => a.resource)));
    for (const o of operations) if (o.kind === 'copy' && o.phase === 'frame' && !written.has(o.accesses[0].resource)) o.phase = 'init';

    // A ping-pong pair has one writer, so its parity after zero, one or several fixed steps is the host's to track (§6).
    const pairs = new Set(resources.filter(r => r.pingPong).map(r => r.id));
    const writers = new Map<string, XOperation[]>();
    for (const o of operations) for (const a of o.accesses) if (pairs.has(a.resource) && a.version === 'next') writers.set(a.resource, [...(writers.get(a.resource) ?? []), o]);
    for (const [r, ws] of writers) {
        for (const extra of ws.slice(1)) fail('EA_RESOLVE', pathOf(extra.node), extra.node, `${r} is a ping-pong pair with one writer in Tier 1; ${ws[0].node} writes it, so ${extra.node} cannot`);
    }
    if (diagnostics.length) return { ok: false, diagnostics };

    const rank = new Map(order.nodes.map((n, i) => [n.id, i]));
    const local = new Map(operations.map((o, i) => [o.id, i]));
    // Disposal undoes construction: each node's teardown in the reverse of the order init made it, and the host's, which
    // forget what the engine lists for every world at once, last.
    const madeAt = new Map<string, number>();
    const key = (o: XOperation): number[] => {
        if (o.phase === 'dispose') return o.node === HOST ? [1, local.get(o.id)!] : [0, -(madeAt.get(o.node) ?? -1), local.get(o.id)!];
        const r = o.node === HOST ? -1 : rank.get(o.node)!;
        return [STAGE[o.kind], o.kind === 'create' ? r : o.node === HOST ? -1 : index.get(o.node)!, local.get(o.id)!];
    };
    const schedule = {} as Record<Phase, string[]>;
    for (const phase of PHASES) {
        const s = schedulePhase(operations.filter(o => o.phase === phase), key, o => STAGE[o.kind]);
        if (!s.ok) {
            const ring = fromFirst(s.cycle, id => id.slice(0, id.indexOf('#')));
            const node = ring[0].slice(0, ring[0].indexOf('#'));
            fail('EA_RESOLVE', node === HOST ? '/nodes' : pathOf(node), node === HOST ? null : node, `a dependency cycle in ${phase}: ${[...ring, ring[0]].join(' → ')}`);
            continue;
        }
        schedule[phase] = s.order;
        if (phase === 'init') s.order.forEach((id, i) => { if (creates.get(id.slice(0, id.indexOf('#')))?.id === id) madeAt.set(id.slice(0, id.indexOf('#')), i); });
    }
    if (diagnostics.length) return { ok: false, diagnostics };

    let estimate: XEstimate;
    try {
        estimate = estimateOf(resources, operations, policy);
    } catch (e) {
        if (!(e instanceof SizeOverflow)) throw e;
        fail('EA_RESOLVE', '/nodes', null, `the world's totals are not safe integers (${e.message})`);
        return { ok: false, diagnostics };
    }
    const opById = new Map(operations.map(o => [o.id, o]));
    const screen = xid(HOST, 'screen');
    const producer = [...schedule.frame].reverse().find(id => opById.get(id)!.accesses.some(a => a.resource === screen && a.mode !== 'read'))!;
    const output: XOutput = {
        color: screen, producer, format: 'canvas', colorSpace: 'srgb',
        conversion: post && (post.config.effects as { effect: string }[]).some(e => e.effect === 'Tonemap') ? 'tonemap' : 'none', depth: frame.depth,
    };
    const adapterOf = new Map(nodes.map(n => [n.id, n.adapter.id]));
    const sourceMap: XSource[] = [...resources, ...objects, ...operations].map(x => ({
        id: x.id, node: x.node, adapter: x.node === HOST ? 'host' : adapterOf.get(x.node)!, paths: x.node === HOST ? [] : [pathOf(x.node), ...(sources[x.id] ?? [])],
    }));
    const modules: XModuleRequest[] = all.flatMap(p => p.modules);
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
        ok: true,
        draft: {
            nodes: nodes.map((n, i) => ({ id: n.id, adapterId: n.adapter.id, adapterVersion: n.adapter.version, family: n.adapter.family, status: support.get(n.adapter.family)!, path: pointer('nodes', i) })),
            resources: resources.sort(byId),
            objects: objects.sort(byId),
            operations: operations.sort(byId),
            schedule,
            fixedSteps: { min: 0, max: policy.maxFixedSteps },
            modules: modules.sort((a, b) => compareKeys([a.module, a.stage, a.node, a.entry], [b.module, b.stage, b.node, b.entry])),
            output,
            estimate,
            sourceMap: sourceMap.sort(byId),
        },
    };
}

function compareKeys(a: (string | number)[], b: (string | number)[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === undefined) return -1;
        if (b[i] === undefined) return 1;
        return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

const BATCHES: ReadonlySet<string> = new Set(['ng.render.mesh_batch', 'ng.render.custom_batch']);

/**
 * Q76(b), decided 2026-11-01: the buffers realized as a batch's own storage, each by its batch. Adopted: an ordinary
 * buffer (declared zero, not a ping-pong pair) wired to exactly one batch's `instances`, holding exactly that batch's
 * `maxInstances` elements at its storage's stride, and otherwise wired only to compute stages, which bind the batch's
 * storage as h1 binds its particles'. Anything else keeps the copy, so the program sees the same buffer either way: a
 * second batch, a pair, an upload seed, fewer elements (`arrayLength` would grow), another stride, or a fullscreen that
 * reads it (a backdrop is made before the batches it draws under, so it could not bind storage made after it).
 */
export function adoptions(nodes: readonly CheckedNode[]): Map<string, string> {
    const adopted = new Map<string, string>();
    for (const b of nodes) {
        if (b.adapter.id !== 'ng.buffer.storage') continue;
        const c = b.config as { elements: number; strideFloats: number; pingPong: boolean; init: string };
        if (c.pingPong || c.init !== 'zero') continue;
        const wired = nodes.flatMap(n => n.inputs.filter(w => w.nodeId === b.id).map(w => ({ node: n, port: w.port })));
        // One batch's instances, and every other consumer a compute stage: a second batch or a fullscreen keeps the copy.
        const instances = wired.find(w => w.port === 'instances' && BATCHES.has(w.node.adapter.id));
        if (!instances || wired.some(w => w !== instances && w.node.adapter.id !== 'ng.compute.stage')) continue;
        const batch = instances.node;
        const stride = batch.adapter.id === 'ng.render.mesh_batch' ? 14 : c.strideFloats;
        if (c.elements !== (batch.config as { maxInstances: number }).maxInstances || c.strideFloats !== stride) continue;
        adopted.set(b.id, batch.id);
    }
    return adopted;
}

/** Producers before consumers (Kahn), the earliest in the program first among nodes free to go; or a cycle. */
function constructionOrder(nodes: CheckedNode[]): { ok: true; nodes: CheckedNode[] } | { ok: false; cycle: string[] } {
    const waiting = new Map(nodes.map(n => [n.id, new Set(n.inputs.map(w => w.nodeId))]));
    const done: CheckedNode[] = [];
    const placed = new Set<string>();
    while (done.length < nodes.length) {
        const next = nodes.find(n => !placed.has(n.id) && [...waiting.get(n.id)!].every(p => placed.has(p)));
        if (!next) {
            // Walk back along unplaced producers until one repeats: that loop is the cycle.
            const trail: string[] = [];
            let at = nodes.find(n => !placed.has(n.id))!.id;
            while (!trail.includes(at)) {
                trail.push(at);
                at = [...waiting.get(at)!].find(p => !placed.has(p))!;
            }
            return { ok: false, cycle: trail.slice(trail.indexOf(at)).reverse() };
        }
        placed.add(next.id);
        done.push(next);
    }
    return { ok: true, nodes: done };
}

/**
 * One phase in order. Only dependencies constrain it: the explicit ones; each reader after every writer of what it
 * reads; and a resource's writers by the kind of their work (an upload before a compute on it, the clear before the
 * draws). Then `key`, the kind of work and program order, decides among operations free to go. Last, each resource's
 * writers are chained in the order found, never against it, and a link no dependency implies is a tie: only the
 * program's order put it there (the EA3.2 review: program order had been a constraint, and could invent a cycle). Each
 * operation's `after` and `ties` are in schedule order. A cycle names its operations.
 */
function schedulePhase(ops: XOperation[], key: (o: XOperation) => number[], stage: (o: XOperation) => number):
    { ok: true; order: string[] } | { ok: false; cycle: string[] } {
    const byKey = (a: XOperation, b: XOperation) => compareKeys(key(a), key(b));
    const inPhase = new Set(ops.map(o => o.id));
    const preds = new Map(ops.map(o => [o.id, new Set(o.after.filter(a => inPhase.has(a)))]));
    const touching = new Map<string, { writers: XOperation[]; readers: XOperation[] }>();
    for (const o of ops) {
        for (const a of o.accesses) {
            const t = touching.get(a.resource) ?? { writers: [], readers: [] };
            (a.mode === 'read' ? t.readers : t.writers).push(o);
            touching.set(a.resource, t);
        }
    }
    for (const { writers, readers } of touching.values()) {
        const ws = [...new Set(writers)];
        for (const r of new Set(readers)) if (!ws.includes(r)) for (const w of ws) preds.get(r.id)!.add(w.id);
        for (const a of ws) for (const b of ws) if (stage(a) < stage(b)) preds.get(b.id)!.add(a.id);
    }
    const dependencies = new Map([...preds].map(([id, p]) => [id, new Set(p)]));
    /** Whether `later` depends on `earlier` through dependencies alone. */
    const dependsOn = (later: string, earlier: string): boolean => {
        const seen = new Set<string>();
        const stack = [...dependencies.get(later)!];
        while (stack.length) {
            const at = stack.pop()!;
            if (at === earlier) return true;
            if (seen.has(at)) continue;
            seen.add(at);
            stack.push(...dependencies.get(at)!);
        }
        return false;
    };
    const order: XOperation[] = [];
    const placed = new Set<string>();
    while (order.length < ops.length) {
        const free = ops.filter(o => !placed.has(o.id) && [...preds.get(o.id)!].every(p => placed.has(p)));
        if (!free.length) {
            const trail: string[] = [];
            let at = ops.find(o => !placed.has(o.id))!.id;
            while (!trail.includes(at)) {
                trail.push(at);
                at = [...preds.get(at)!].find(p => !placed.has(p))!;
            }
            return { ok: false, cycle: trail.slice(trail.indexOf(at)).reverse() };
        }
        const next = free.sort(byKey)[0];
        placed.add(next.id);
        order.push(next);
    }
    const position = new Map(order.map((o, i) => [o.id, i]));
    const ties = new Map(ops.map(o => [o.id, [] as string[]]));
    for (const { writers } of touching.values()) {
        const ws = [...new Set(writers)].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
        for (let i = 1; i < ws.length; i++) {
            const [earlier, later] = [ws[i - 1].id, ws[i].id];
            preds.get(later)!.add(earlier);
            if (!dependsOn(later, earlier) && !ties.get(later)!.includes(earlier)) ties.get(later)!.push(earlier);
        }
    }
    const inOrder = (a: string, b: string) => position.get(a)! - position.get(b)!;
    for (const o of ops) {
        o.after = [...preds.get(o.id)!].sort(inOrder);
        o.ties = ties.get(o.id)!.sort(inOrder);
    }
    return { ok: true, order: order.map(o => o.id) };
}

/**
 * The dispose operations to run after a partial init, in dispose order: those that release what the `attempted` create
 * operations made. A create that failed half way counts as attempted; every release here is idempotent (§9).
 */
export function cleanupFor(graph: DeepReadonly<ExecutionGraph>, attempted: ReadonlySet<string>): string[] {
    const needed = new Set<string>();
    for (const r of [...graph.resources, ...graph.objects]) if (r.createdBy !== null && attempted.has(r.createdBy) && r.releasedBy !== null) needed.add(r.releasedBy);
    return graph.schedule.dispose.filter(id => needed.has(id));
}

/** A sum that stays a safe integer. */
function total(values: number[]): number {
    let s = 0;
    for (const v of values) {
        s += v;
        if (!Number.isSafeInteger(s)) throw new SizeOverflow(`a total passes ${Number.MAX_SAFE_INTEGER}`);
    }
    return s;
}

function estimateOf(resources: XResource[], operations: XOperation[], policy: StaticPolicy): XEstimate {
    const counted = resources.filter(r => r.owner !== 'canvas');
    const each = (phase: Phase, kind: OperationKind) => operations.filter(o => o.phase === phase && o.kind === kind);
    const groups = (o: XOperation) => o.work.workgroups!.reduce((a, b) => a * b, 1);
    const steps = policy.maxFixedSteps;
    const bytes = total(counted.map(r => r.bytes * r.allocations));
    return {
        bytes,
        maxAllocationBytes: Math.max(0, ...counted.map(r => r.bytes)),
        viewportBytes: total(counted.filter(r => r.resizes).map(r => r.bytes * r.allocations)),
        resizePeakBytes: bytes,
        invocationsPerFrame: total([...each('frame', 'compute').map(o => o.work.invocations!), ...each('fixedStep', 'compute').map(o => o.work.invocations! * steps)]),
        workgroupsPerFrame: total([...each('frame', 'compute').map(groups), ...each('fixedStep', 'compute').map(o => groups(o) * steps)]),
        vertexInvocationsPerFrame: total([...each('frame', 'backdrop'), ...each('frame', 'draw')].map(o => o.work.vertices! * o.work.instances!)),
        invocationsInit: total(each('init', 'compute').map(o => o.work.invocations!)),
        copyBytesPerFrame: total(each('frame', 'copy').map(o => o.work.bytes!)),
        uploadBytesPerFrame: total([...each('frame', 'upload').map(o => o.work.bytes!), ...each('fixedStep', 'upload').map(o => o.work.bytes! * steps)]),
        uploadBytesInit: total(operations.filter(o => o.phase === 'init' && o.work.bytes !== null).map(o => o.work.bytes!)),
        operations: operations.length,
    };
}
