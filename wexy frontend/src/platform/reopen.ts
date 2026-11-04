// A saved world opened again (W3; the creations platform companion §8's step 3; F3, P6): a parsed wexy-world.v1 world
// (artifact.ts) sealed by this host, as a saved attempt is (loop/replay.ts). Nothing in the file is authority: the seal
// resolves W under this build's policy and manifest, derives every interface, holds each body to the interface derived
// here and to the host's lint, and recomputes every hash. The file's `graph` and `candidate` are provenance only: the
// resolver can move X with no pin moving (11-02's lighting fix moved the castle's), so a difference proves nothing,
// and the corpus test is what catches one. Then the body's compile on this device (L3, `compileSaved`), the creator's
// "Show it" and the stage's Run, as for any candidate. No model is called (F5).

import { resolveProgram } from '../contract/adapters/resolve';
import type { DeepReadonly } from '../contract/engine/frozen';
import { sealCandidate, type SealedCandidate } from '../loop/snapshot';
import type { WorldArtifactV1 } from './artifact';

export type Reopened =
    | {
          readonly ok: true;
          readonly snapshot: DeepReadonly<SealedCandidate>;
          /** What the file said when saved, beside what this build sealed: equal under the build that saved it. */
          readonly provenance: { readonly graph: string; readonly candidate: string; readonly same: boolean };
      }
    | { readonly ok: false; readonly reason: string };

/** `world` sealed by this host, under the attempt name `attempt` (the saved world's id, for its evidence). */
export async function openWorld(world: DeepReadonly<WorldArtifactV1>, attempt: string): Promise<Reopened> {
    const nodes = world.program.nodes;
    const resolved = await resolveProgram(nodes);
    if (!resolved.ok) {
        const d = resolved.diagnostics[0];
        return { ok: false, reason: `its program does not resolve here${d ? `: ${d.code} ${d.path}: ${d.message}` : ''}` };
    }
    const sealed = await sealCandidate({
        attempt,
        revision: 0,
        program: nodes,
        graph: resolved.graph.hash,
        bodies: world.modules.map(m => ({ module: m.module, interfaceHash: m.interfaceHash, body: m.body, codeHash: m.codeHash })),
    });
    if (!sealed.ok) return { ok: false, reason: `the host does not seal it: ${sealed.reason}` };
    const s = sealed.snapshot;
    return { ok: true, snapshot: s, provenance: { graph: world.graph, candidate: world.candidate, same: s.x.hash === world.graph && s.id === world.candidate } };
}
