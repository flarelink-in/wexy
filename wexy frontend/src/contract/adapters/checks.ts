// The checks of EA3.3 (engine-adapters-design.md §7) on X: pure, bounded and deterministic. Each finding is structured
// data a developer and a later repair turn can act on (§11): its check, severity, phase, offender, program path, the
// expected and actual values, and a sentence naming the way out. X is checked under the policy it was resolved under,
// or not at all: an estimate made at another viewport is not compared with another policy's limits. Passing is not
// admission (R6): no shader is compiled and no device measured. Bindings and group ownership arrive with the module
// interfaces (EA3.4), the executor seam with EA3.5.

import type { DeepReadonly } from '../engine/frozen';
import { canonicalHash } from './canonical';
import { HOST } from './contribute';
import type { ExecutionGraph, Phase, StaticPolicy, XOperation } from './graph';

export type CheckName = 'policy' | 'memory' | 'work' | 'init' | 'order' | 'lifecycle' | 'output' | 'layout';

export interface XFinding {
    check: CheckName;
    severity: 'error' | 'warning';
    code: 'EA_RESOLVE';
    phase: Phase | null;
    /** The offender: a resource, object or operation of X, or null for the world as a whole. */
    subject: string | null;
    node: string | null;
    /** A JSON pointer into the program: the offender's first source path, or `/nodes` for the world. */
    path: string;
    expected: number | string | null;
    actual: number | string | null;
    message: string;
}

export interface Checked {
    /** The hash of the X checked: evidence names what it is evidence of (EA3.5's admission). */
    graph: string;
    /** No error among the findings. Warnings stand; nothing here admits X to a device. */
    ok: boolean;
    /** Errors first, then warnings, each in the order found. */
    findings: XFinding[];
    /** More than MAX_FINDINGS were found, and the rest dropped. */
    truncated: boolean;
}

export const MAX_FINDINGS = 64;

/**
 * null-graph's canonical effect order (1.2.0's, unchanged in 1.2.1) (`post:EFFECT_ORDER`, pinned against the engine by EA-X14): Tonemap is the
 * pivot, HDR work before it and display-referred work after it.
 */
export const EFFECT_ORDER: readonly string[] = ['SSAO', 'AutoExposure', 'Bokeh', 'Bloom', 'Halation', 'GodRays', 'LensFlare', 'ColorGrade', 'Tonemap',
    'CelShade', 'Kuwahara', 'Outline', 'FXAA', 'ChromaticAberration', 'Vignette', 'FilmGrain'];

/** Effect names in the engine's order, stably, an unknown one last: what `post:orderChain` does to the effects. */
export function orderEffects(effects: readonly string[]): string[] {
    const rank = (e: string) => (EFFECT_ORDER.includes(e) ? EFFECT_ORDER.indexOf(e) : EFFECT_ORDER.length);
    return effects.map((e, i) => [e, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
}

type Graph = DeepReadonly<ExecutionGraph>;
type Op = DeepReadonly<XOperation>;

/** X's findings under `policy`, which must be the policy X was resolved under. */
export async function checkGraph(x: Graph, policy: StaticPolicy): Promise<Checked> {
    const findings: XFinding[] = [];
    const where = new Map(x.sourceMap.map(s => [s.id, s]));
    const add = (check: CheckName, severity: XFinding['severity'], phase: Phase | null, subject: string | null,
        expected: XFinding['expected'], actual: XFinding['actual'], message: string) => {
        const source = subject === null ? undefined : where.get(subject);
        const node = source && source.node !== HOST ? source.node : null;
        findings.push({ check, severity, code: 'EA_RESOLVE', phase, subject, node, path: source?.paths[0] ?? '/nodes', expected, actual, message });
    };
    const finish = (): Checked => {
        const ordered = [...findings.filter(f => f.severity === 'error'), ...findings.filter(f => f.severity === 'warning')];
        return { graph: x.hash, ok: !ordered.some(f => f.severity === 'error'), findings: ordered.slice(0, MAX_FINDINGS), truncated: ordered.length > MAX_FINDINGS };
    };

    const policyHash = await canonicalHash(policy);
    if (policyHash !== x.identity.policyHash) {
        add('policy', 'error', null, null, x.identity.policyHash, policyHash, 'X was resolved under another policy; resolve it again under this one before checking it');
        return finish();
    }
    const ops = new Map(x.operations.map(o => [o.id, o]));
    const resources = new Map(x.resources.map(r => [r.id, r]));
    const writes = (o: Op) => new Set(o.accesses.filter(a => a.mode !== 'read').map(a => a.resource));

    // Memory: one buffer, and everything together, at P's viewport (§7 "Memory and ownership").
    for (const r of x.resources) {
        if (r.kind === 'buffer' && r.bytes > policy.maxBufferBytes) {
            add('memory', 'error', null, r.id, policy.maxBufferBytes, r.bytes, `${r.id} is ${r.bytes} bytes, over P's ${policy.maxBufferBytes} for one buffer; use fewer elements or a smaller stride`);
        }
    }
    const largest = [...x.resources].sort((a, b) => b.bytes * b.allocations - a.bytes * a.allocations).slice(0, 3).map(r => r.id).join(', ');
    const viewport = `${policy.viewport.width}×${policy.viewport.height}`;
    if (x.estimate.bytes > policy.maxTotalBytes) {
        add('memory', 'error', null, null, policy.maxTotalBytes, x.estimate.bytes, `the world holds ${x.estimate.bytes} bytes at P's ${viewport} viewport, over P's ${policy.maxTotalBytes}; the largest are ${largest}`);
    }
    if (x.estimate.resizePeakBytes > policy.maxTotalBytes && x.estimate.resizePeakBytes !== x.estimate.bytes) {
        add('memory', 'error', 'resize', null, policy.maxTotalBytes, x.estimate.resizePeakBytes, `a resize holds ${x.estimate.resizePeakBytes} bytes at its peak, over P's ${policy.maxTotalBytes}`);
    }

    // Work: each dispatch's workgroups and invocations (§7 "Work bounds"). Tier 1 has no indirect dispatch to bound.
    for (const o of x.operations) {
        if (o.kind !== 'compute' || o.work.workgroups === null || o.work.invocations === null) continue;
        o.work.workgroups.forEach((n, axis) => {
            if (n > policy.maxWorkgroupsPerDimension) {
                add('work', 'error', o.phase, o.id, policy.maxWorkgroupsPerDimension, n,
                    `${o.id} dispatches ${n} workgroups in ${'xyz'[axis]}, over P's ${policy.maxWorkgroupsPerDimension}; raise workgroupSize or lower invocations`);
            }
        });
        if (o.work.invocations > policy.maxInvocationsPerDispatch) {
            add('work', 'error', o.phase, o.id, policy.maxInvocationsPerDispatch, o.work.invocations,
                `${o.id} runs ${o.work.invocations} invocations, over P's ${policy.maxInvocationsPerDispatch} for one dispatch; lower invocations`);
        }
    }
    // And the work repeated: a frame at P's fixed-step maximum, every draw's vertices, init's one submission (EA3.3's
    // review: each dispatch could fit while their sum did not).
    const steps = `each fixed-step stage counted ${policy.maxFixedSteps} times`;
    const aggregates: [number, number, string, Phase][] = [
        [x.estimate.invocationsPerFrame, policy.maxInvocationsPerFrame, `invocations a presented frame (${steps})`, 'frame'],
        [x.estimate.workgroupsPerFrame, policy.maxWorkgroupsPerFrame, `workgroups a presented frame (${steps})`, 'frame'],
        [x.estimate.vertexInvocationsPerFrame, policy.maxVertexInvocationsPerFrame, 'vertex invocations a frame (each draw\'s vertices times its instances)', 'frame'],
        [x.estimate.invocationsInit, policy.maxInvocationsInit, 'invocations in init, one submission', 'init'],
    ];
    for (const [actual, limit, what, phase] of aggregates) {
        if (actual > limit) add('work', 'error', phase, null, limit, actual, `the world runs ${actual} ${what}, over P's ${limit}; lower the counts, or move work out of the steps it repeats in`);
    }

    // Initialization (§7 "Initialization and hazards"): every read follows something that gives the whole resource its
    // content, through init, then a frame with no fixed step and one after a fixed step, since 0 to N may run. Declared
    // zero and constructed content count from the start; an allocation's zero-fill does not count for a resource whose
    // content comes from an upload or a pass; a partial write initializes nothing.
    const reported = new Set<string>();
    const walk = (sequence: readonly string[], state: Set<string>, when: string) => {
        for (const id of sequence) {
            const o = ops.get(id)!;
            for (const a of o.accesses) {
                const reads = a.mode === 'read' || (a.mode === 'readwrite' && o.kind !== 'swap' && !(o.kind === 'post' && a.coverage === 'whole'));
                if (!reads || state.has(a.resource) || reported.has(`${o.id}|${a.resource}`)) continue;
                reported.add(`${o.id}|${a.resource}`);
                add('init', 'error', o.phase, o.id, 'initialized', 'not yet', `${o.id} reads ${a.resource} in ${o.phase} before anything gives it content${when}; write it whole first`);
            }
            for (const a of o.accesses) {
                if (a.mode === 'read' || a.coverage !== 'whole') continue;
                const content = resources.get(a.resource)?.content;
                if (o.kind !== 'create' || content === 'zero' || content === 'construct') state.add(a.resource);
            }
        }
    };
    const initial = new Set(x.resources.filter(r => r.content === 'zero' || r.content === 'construct').map(r => r.id));
    walk(x.schedule.init, initial, '');
    walk(x.schedule.frame, new Set(initial), ' (a frame with no fixed step)');
    const stepped = new Set(initial);
    walk(x.schedule.fixedStep, stepped, ' (the first fixed step)');
    walk(x.schedule.frame, stepped, ' (a frame after a fixed step)');

    // Order: two writers of one resource that only the program's order puts in turn (X's `ties`) are unordered conflicting
    // writes (§7), refused: the schedule is deterministic, but the listing would decide which write wins (EA3.3's review).
    for (const o of x.operations) {
        for (const t of o.ties) {
            const shared = [...writes(o)].filter(r => writes(ops.get(t)!).has(r));
            add('order', 'error', o.phase, o.id, 'a dependency', 'the program\'s listing',
                `${t} and ${o.id} both write ${shared.join(', ')} in ${o.phase} with nothing ordering them but the program's listing, which would decide which write wins; merge them into one stage, or have one read a buffer the other writes`);
        }
    }

    // Lifecycle (§7 "Resize and teardown"): each allocation and engine object of the world released, or its holder named;
    // and released before whatever it was made from.
    const disposal = new Map(x.schedule.dispose.map((id, i) => [id, i]));
    const held = new Map<string, { by: string; until: string; ids: string[] }>();
    for (const r of [...x.resources, ...x.objects]) {
        if ('owner' in r && (r.owner === 'shared' || r.owner === 'canvas')) continue;
        if (r.releasedBy === null && r.retained === null) {
            add('lifecycle', 'error', 'dispose', r.id, 'a release', null, `nothing releases ${r.id} and nothing says what keeps it; a world replaced would leak it`);
        } else if (r.releasedBy !== null && !disposal.has(r.releasedBy)) {
            add('lifecycle', 'error', 'dispose', r.id, r.releasedBy, null, `${r.id} is released by ${r.releasedBy}, which the dispose schedule does not run`);
        }
        if (r.retained !== null) {
            const key = `${r.retained.by}\n${r.retained.until}`;
            held.set(key, { ...r.retained, ids: [...(held.get(key)?.ids ?? []), r.id] });
        }
    }
    // A retention is disclosed, once a holder: the world cannot release it with the installed engine, and is not refused
    // for it. On null-graph 1.2.1 the adapters leave none (EA5.0); 1.2.0 kept a compute stage and the post debug view.
    for (const { by, until, ids } of held.values()) {
        add('lifecycle', 'warning', 'dispose', ids[0], null, null,
            `${by} keeps ${ids.join(', ')} after the world's dispose, until ${until}: the engine has no call that releases ${ids.length > 1 ? 'them' : 'it'}`);
    }
    const releasesOf = (node: string) => x.schedule.dispose.filter(id => ops.get(id)!.node === node).map(id => disposal.get(id)!);
    for (const made of x.operations.filter(o => o.kind === 'create' && o.node !== HOST)) {
        for (const before of made.after) {
            const producer = ops.get(before)!.node;
            if (producer === HOST || producer === made.node) continue;
            const mine = releasesOf(made.node);
            const theirs = releasesOf(producer);
            if (mine.length && theirs.length && Math.max(...mine) > Math.min(...theirs)) {
                add('lifecycle', 'error', 'dispose', made.id, `${made.node} released before ${producer}`, `${producer} released first`,
                    `dispose releases ${producer} before ${made.node}, which was made after it; undo construction backwards`);
            }
        }
    }

    // Output (§7 "Output and controls"): something is drawn; HDR reaches the 8-bit screen converted; effects in the
    // engine's order.
    if (!x.operations.some(o => o.phase === 'frame' && (o.kind === 'draw' || o.kind === 'backdrop'))) {
        add('output', 'error', 'frame', null, 'a draw', null, 'the world draws nothing: no batch or backdrop writes the main pass, so only its clear reaches the screen; add a batch or a backdrop');
    }
    const post = x.nodes.find(n => n.adapterId === 'ng.post.chain');
    if (post) {
        const create = ops.get(`${post.id}#create`)!;
        const effects = (create.args.effects as readonly { effect: string }[]).map(e => e.effect);
        if (x.output.conversion === 'none') {
            add('output', 'warning', 'frame', create.id, 'Tonemap', null,
                `${post.id} has no Tonemap: the scene's linear HDR (rgba16float) reaches the 8-bit screen unconverted, clipped above 1; add Tonemap`);
        }
        const canonical = orderEffects(effects);
        if (canonical.join() !== effects.join()) {
            add('output', 'warning', 'frame', create.id, canonical.join(', '), effects.join(', '),
                `${post.id} runs ${effects.join(', ')}; the engine's order is ${canonical.join(', ')} (Tonemap the pivot: HDR work before it, display-referred after)`);
        }
    }
    // A rig wired to an unlit stock material's batch (contribute.ts's LIT_MATERIALS): the batch draws unlit, as null-graph
    // draws that material, and the rig lights nothing of it.
    for (const o of x.operations) {
        if (o.call !== 'engine.createBatch') continue;
        const shader = o.args.shader as { kind: string; material?: string; lights?: boolean };
        if (shader.kind !== 'stock' || shader.lights || typeof o.args.lights !== 'string') continue;
        add('output', 'warning', 'frame', o.id, 'lambert, toon or pbr', shader.material ?? null,
            `${o.node}'s ${shader.material} material takes no lights, so ${o.args.lights} lights nothing of it: it draws unlit, as the engine draws ${shader.material}; unwire ${o.args.lights} from it, or light it with lambert, toon or pbr`);
    }

    // Layout: what a copy moves fits where it lands, element for element (an adapter's slip, if it ever fires).
    for (const o of x.operations) {
        if (o.kind !== 'copy') continue;
        const [from, to] = [resources.get(o.accesses[0].resource)!, resources.get(o.accesses[1].resource)!];
        if (from.strideFloats !== to.strideFloats || (o.work.bytes ?? 0) > to.bytes) {
            add('layout', 'error', o.phase, o.id, `${to.strideFloats} floats, at most ${to.bytes} bytes`, `${from.strideFloats} floats, ${o.work.bytes} bytes`,
                `${o.id} copies ${from.id} into ${to.id}, which does not hold it element for element`);
        }
    }
    return finish();
}
