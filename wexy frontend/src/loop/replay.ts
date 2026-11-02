// A saved attempt replayed in the studio (11-02; the user: "add it as preset or link so i could verify visually the
// outputs"): the bundle Developer view downloads (`wexy-candidate-bundle.v2`, candidate.ts) or a live-candidate
// fixture, its program and bodies sealed again by this host and each body compiled by L3 on this device. Nothing in
// the file is trusted. The seal resolves, checks and derives from W itself and recomputes every hash; each body must be
// the text its codeHash names, written for the interface this host derives; a bundle's versions must be this build's.
// What follows is the studio's own Run: the developer's press, the gate, eligibility, the probe and the first frame,
// as for any candidate. No model is called and nothing is spent.

import { BODY_CHECKER, checkBody, compileBody, type CompiledBody, type ModuleCompiler } from '../contract/adapters/bodies';
import { ABI_VERSION } from '../contract/adapters/interfaces';
import { resolveProgram } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import { CANDIDATE_BUNDLE } from './candidate';
import { sealCandidate, type SealedCandidate } from './snapshot';

export interface Replay {
    /** The attempt it came from, as the file names it. */
    attempt: string;
    /** The idea it was written for, when the file holds one. */
    prompt: string | null;
    snapshot: DeepReadonly<SealedCandidate>;
}

export type Replayed = { ok: true; replay: Replay } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (v: unknown) => (typeof v === 'string' ? (v.length > 16 ? `${v.slice(0, 12)}…` : v) : String(v));

/** A saved attempt's text, sealed by this host: the sealed candidate, or why not, in a developer's words. */
export async function sealSaved(text: string): Promise<Replayed> {
    let file: unknown;
    try {
        file = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: `the file is not JSON: ${(e as Error).message}` };
    }
    if (!isObject(file)) return { ok: false, reason: 'the file is not a saved attempt' };
    if (file.format !== undefined && file.format !== CANDIDATE_BUNDLE) return { ok: false, reason: `the file is ${String(file.format)}, not ${CANDIDATE_BUNDLE}` };
    const nodes = isObject(file.program) ? file.program.nodes : undefined;
    if (!Array.isArray(nodes)) return { ok: false, reason: 'the file holds no program (program.nodes)' };
    const modules = Array.isArray(file.modules) ? file.modules : [];
    if (!modules.every(m => isObject(m) && typeof m.module === 'string' && typeof m.body === 'string' && typeof m.interfaceHash === 'string')) {
        return { ok: false, reason: 'the file\'s modules are not each {module, interfaceHash, body}' };
    }
    const resolved = await resolveProgram(nodes);
    if (!resolved.ok) {
        const d = resolved.diagnostics[0];
        return { ok: false, reason: `its program does not resolve here${d ? `: ${d.code} ${d.path}: ${d.message}` : ''}` };
    }
    const x = resolved.graph;
    // A downloaded bundle names what it was written against; a replay is of that attempt, so they must be this build's.
    if (isObject(file.versions)) {
        const here: Record<string, string> = { bundle: x.identity.bundleHash, manifest: x.identity.manifestHash, abi: ABI_VERSION, checker: BODY_CHECKER };
        for (const [k, want] of Object.entries(here)) {
            if (file.versions[k] !== want) return { ok: false, reason: `it was written against another ${k} (${short(file.versions[k])}); this build's is ${short(want)}` };
        }
    }
    const sealed = await sealCandidate({
        attempt: typeof file.attempt === 'string' ? file.attempt : 'replay',
        revision: Number.isSafeInteger(file.revision) ? file.revision as number : 0,
        program: nodes,
        graph: x.hash,
        bodies: (modules as Record<string, unknown>[]).map(m => ({
            module: m.module as string, interfaceHash: m.interfaceHash as string, body: m.body as string,
            ...(typeof m.codeHash === 'string' ? { codeHash: m.codeHash } : {}),
        })),
    });
    if (!sealed.ok) return { ok: false, reason: `the host does not seal it: ${sealed.reason}` };
    const request = isObject(file.request) ? file.request : null;
    return {
        ok: true,
        replay: {
            attempt: typeof file.attempt === 'string' ? file.attempt : 'a fixture',
            prompt: request && typeof request.prompt === 'string' ? request.prompt.trim() : null,
            snapshot: sealed.snapshot,
        },
    };
}

/** Each body of a sealed replay compiled by L3 on this device, checked first as the candidate session checks it. */
export async function compileSaved(snapshot: DeepReadonly<SealedCandidate>, compiler: ModuleCompiler): Promise<DeepReadonly<CompiledBody>[]> {
    const out: DeepReadonly<CompiledBody>[] = [];
    for (const b of snapshot.bodies) {
        const iface = snapshot.interfaces.find(i => i.module === b.module)!;
        out.push(await compileBody(iface, await checkBody(iface, b.body), compiler));
    }
    return out;
}
