// EA5.1's exit on a real GPU (executor-design.md §13; EA-D4 on the device): candidates from their downloaded bundles,
// each sealed again by the host from its program and bodies (the same id(C), or it says so), each body compiled in its
// assembled module by this device's compiler (L3), and the verdicts held to the compiler's own provenance. Nothing is
// built, dispatched or drawn: L3 makes shader modules, and making one runs nothing on the GPU. dev/l3-device.mjs hands
// the bundles in and keeps window.__L3__.result.

import { checkBody, compileBody, type BodyFinding, type CompiledBody } from '../src/contract/adapters/bodies';
import { resolveProgram } from '../src/contract/adapters/resolve';
import type { DeepReadonly } from '../src/contract/engine/frozen';
import { createDeviceCompiler } from '../src/exec/device-compiler';
import { sealCandidate } from '../src/loop/snapshot';

/** What this check reads of a candidate bundle (`wexy-candidate-bundle.v2`). */
interface Bundle {
    attempt: string;
    revision: number;
    candidate: string | null;
    graph: string;
    program: { nodes: unknown[] };
    modules: { module: string; interfaceHash: string; codeHash: string; body: string }[];
}

const logEl = document.getElementById('log')!;
const log = (line: string) => { logEl.textContent += `\n${line}`; console.log(`[l3] ${line}`); };

async function run(bundles: { name: string; bundle: Bundle }[]) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter in this browser');
    const device = await adapter.requestDevice();
    const info = adapter.info;
    const gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ');
    const uncaptured: string[] = [];
    device.addEventListener('uncapturederror', e => uncaptured.push((e as GPUUncapturedErrorEvent).error.message.slice(0, 300)));
    let lost: string | null = null;
    void device.lost.then(i => { lost = i.message || i.reason; });
    const compiler = createDeviceCompiler(device, { gpu });
    log(`adapter: ${gpu}`);
    const worlds = [];
    for (const { name, bundle } of bundles) {
        // Sealed under this build's X: a bundle made before a resolver change (EA5.0's adoption and releases) names an
        // older X, so its id(C) moves too, while each body is still judged against the interface it was written for.
        const resolved = await resolveProgram(bundle.program.nodes);
        if (!resolved.ok) {
            log(`${name}: does not resolve: ${resolved.diagnostics[0]?.message ?? ''}`);
            worlds.push({ name, sealed: false, reason: `does not resolve: ${resolved.diagnostics[0]?.code ?? ''}` });
            continue;
        }
        const sealed = await sealCandidate({
            attempt: bundle.attempt, revision: bundle.revision, program: bundle.program.nodes, graph: resolved.graph.hash,
            bodies: bundle.modules.map(m => ({ module: m.module, interfaceHash: m.interfaceHash, body: m.body, codeHash: m.codeHash })),
        });
        if (!sealed.ok) {
            log(`${name}: not sealed: ${sealed.reason}`);
            worlds.push({ name, sealed: false, reason: sealed.reason });
            continue;
        }
        const snap = sealed.snapshot;
        const verdicts: DeepReadonly<CompiledBody>[] = [];
        const modules = [];
        for (const b of snap.bodies) {
            const iface = snap.interfaces.find(i => i.module === b.module)!;
            const checked = await checkBody(iface, b.body);
            const started = performance.now();
            const v = await compileBody(iface, checked, compiler);
            const ms = Math.round((performance.now() - started) * 10) / 10;
            verdicts.push(v);
            const findings = [...v.body, ...v.host, ...v.unplaced].map((f: DeepReadonly<BodyFinding>) => ({ ...f }));
            modules.push({ module: b.module, kind: iface.kind, lines: b.body.split('\n').length, codeHash: b.codeHash, ok: v.ok, producedBy: v.producedBy, ms, findings });
            log(`${name}/${b.module} (${iface.kind}, ${b.body.split('\n').length} lines): ${v.ok ? 'compiles' : 'REFUSED'} on the device in ${ms} ms${findings.length ? `, ${findings.length} message(s)` : ''}`);
        }
        const provenance = compiler.provenance(snap, verdicts);
        const sameX = snap.x.hash === bundle.graph;
        log(`${name}: X ${sameX ? 'as the bundle\'s' : `moved since the bundle (${bundle.graph.slice(0, 12)}… → ${snap.x.hash.slice(0, 12)}…)`}; `
            + `id(C) ${snap.id.slice(0, 12)}… ${snap.id === bundle.candidate ? 'as the bundle' : 'another'}; every interface as the bundle's; provenance ${provenance ?? 'holds'}`);
        worlds.push({ name, sealed: true, candidate: snap.id, sameX, sameId: snap.id === bundle.candidate, graph: snap.x.hash, bundleGraph: bundle.graph, modules, provenance });
    }
    return { gpu, adapter: { vendor: info.vendor, architecture: info.architecture, description: info.description }, uncaptured, lost, browser: navigator.userAgent, worlds };
}

const harness = {
    ready: true,
    result: null as unknown,
    run(bundles: { name: string; bundle: Bundle }[]) {
        run(bundles).then(r => { harness.result = r; }, e => { harness.result = { error: String((e as Error)?.stack ?? e) }; });
    },
};
(window as unknown as { __L3__: typeof harness }).__L3__ = harness;
