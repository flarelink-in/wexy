// The program revision over the agent turn (EA4.4; candidate-loop-design.md §8; Q82 (a), decided 2026-11-01): the
// candidate machine's Reviser seam, as a turn with a base. R goes as it was handed off, S as the base's design, W as its
// program, and the findings the revision answers as its findings; the pins are this build's, and the backend holds the
// base to them, to its schema and to its program check before any charge (AgentBase). The turn's own reader holds the
// stream to the contract (meta's bundle, action contract and manifest; one terminal), so a revision is a turn like any
// other:
//   handed-off  the new design and program, its notes to the modules whose code must change (EA6.3, `repairs`, held
//               to the schema by the reader and to the program by the machine), the revision's turn id, and the calls
//               the turn made (the ledger reconciles its reserved six to them);
//   asked, declined, exhausted  their reason and their calls: no replacement;
//   anything else  rejects (a refusal, an error event, a broken stream, another contract), and its calls are unknown,
//               never zero (the design §8).
// Whether a hand-off changed S is the machine's to judge, since a program revision may not; the backend keeps S too.
// Each event goes to the machine as it comes: the candidate keeps the revision's turn, its model, template and every
// call with its charge, for Developer view and the bundle (the EA4.5 review).

import { TURN_VERSIONS, type AgentClient } from '../forge-client/agent-client';
import type { RevisionResult, Reviser } from './candidate';

/** A Reviser over `client`: one turn with a base, each of its events handed to the machine's `onEvent`. */
export function createReviser(client: AgentClient): Reviser {
    return async (request, signal, onEvent = () => {}): Promise<RevisionResult> => {
        const result = await client.turn({
            prompt: request.request.prompt, style: request.request.style, seconds: request.request.seconds,
            base: { versions: TURN_VERSIONS, design: request.design, program: request.program, findings: request.findings },
        }, onEvent, signal);
        const calls = result.calls.length;
        if (result.status === 'handed-off') {
            return { status: 'handed-off', turnId: result.meta.turnId, design: result.design, program: result.program, repairs: result.repairs, calls };
        }
        if (result.status === 'asked') return { status: 'asked', reason: result.question, calls };
        return { status: result.status, reason: result.reason, calls };
    };
}
