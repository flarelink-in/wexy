// The agent turn over the transport (http.ts, agent-stream.ts; the backend's agent-loop design §10 and §15.1, gate B1):
// POST /v1/agent/turn with the creator's sentence, style and length, and nothing else, since the backend refuses any
// other field (EA-U9); then the stream, read to its terminal under one absolute deadline. The route spends its App Check
// token, so each turn gets a fresh limited-use one (http.ts, SINGLE_USE_ROUTES), the transport's one retry after a 401
// included. A turn is never retried or replayed once it may have started: that 401 comes from the gateway before it
// forwards anything, and every other refusal or failure is the caller's to show.

import bundleText from '../contract/engine/bundle.json?raw';
import type { Style } from '../contract/spec';
import { readAgentStream, type AgentEvent, type AgentTurnResult } from './agent-stream';
import { ForgeError } from './errors';
import type { Api } from './http';

/**
 * The server ends a turn at its turn-seconds, 300 s, a call in flight included (gate A), then writes its last event.
 * The client allows that and 15 s for the identity, the gateway and the last event. The deadline is fixed when the
 * turn starts, so a heartbeat never extends it.
 */
export const AGENT_DEADLINE_MS = 315_000;

/** The engine bundle this build embeds (EA1), which a turn's meta must name (I2). */
export const ENGINE_BUNDLE_HASH: string = (() => {
    const hash = (JSON.parse(bundleText) as { bundleHash?: unknown }).bundleHash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('agent: src/contract/engine/bundle.json has no bundleHash.');
    return hash;
})();

/** The turn's request, as `POST /v1/agent/turn` takes it (the agent-loop design §5.1): the planner's three fields. */
export interface AgentTurnRequest {
    prompt: string;
    style: Style | 'auto';
    seconds: number;
}

export interface AgentClient {
    /** One turn: each event once it is checked, then the result; a ForgeError, or a cancel's own AbortError, otherwise. */
    turn(req: AgentTurnRequest, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentTurnResult>;
}

export function createAgentClient(api: Api, options: { deadlineMs?: number; bundleHash?: string; manifestHash?: string } = {}): AgentClient {
    const deadlineMs = options.deadlineMs ?? AGENT_DEADLINE_MS;
    const bundleHash = options.bundleHash ?? ENGINE_BUNDLE_HASH;
    const manifestHash = options.manifestHash;
    return {
        async turn(req, onEvent, signal) {
            const within = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
            try {
                const res = await api.send({
                    method: 'POST', path: '/v1/agent/turn', body: { prompt: req.prompt, style: req.style, seconds: req.seconds },
                    auth: true, accept: 'text/event-stream', signal: within,
                });
                return await readAgentStream(res, onEvent, { bundleHash, manifestHash, signal: within });
            } catch (error) {
                if ((error as Error)?.name === 'TimeoutError') {
                    throw new ForgeError('timeout', 0, `The agent turn had no last event within ${Math.round(deadlineMs / 1000)} s; the connection was dropped.`);
                }
                throw error;
            }
        },
    };
}
