// The agent turn over the transport (http.ts, agent-stream.ts; the backend's agent-loop design §10 and §15.1, gate B1):
// POST /v1/agent/turn with the creator's sentence, style and length, and nothing else, since the backend refuses any
// other field (EA-U9); then the stream, read to its terminal under one absolute deadline. The route spends its App Check
// token, so each turn gets a fresh limited-use one (http.ts, SINGLE_USE_ROUTES), the transport's one retry after a 401
// included. A turn is never retried or replayed once it may have started: that 401 comes from the gateway before it
// forwards anything, and every other refusal or failure is the caller's to show.
//
// A program revision (candidate-loop-design.md §8; Q82 (a), decided 2026-11-01; EA4.4) is a turn with a base beside the
// three fields: this build's pins, the design and program a turn handed off, and the browser's findings, cut to the
// backend's caps (AgentBase), which holds the base to its own schema and program check before any charge.

import { ADAPTER_MANIFEST_HASH } from '../contract/adapters';
import { AGENT_ACTION_VERSION, type SolutionDesign, type WorldProgram } from '../contract/agent';
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

/** The pins a revision's base names (the backend's AgentBase.pins): the contract its program was made and checked under. */
export interface TurnVersions {
    actionSchema: string;
    bundle: string;
    manifest: string;
}

/** This build's pins: the backend refuses a base made under any other, before any charge. */
export const TURN_VERSIONS: TurnVersions = Object.freeze({ actionSchema: AGENT_ACTION_VERSION, bundle: ENGINE_BUNDLE_HASH, manifest: ADAPTER_MANIFEST_HASH });

/** A finding a revision answers, as the base carries it: its evidence id, its code, its JSON pointer or none, its message. */
export interface BaseFinding {
    id: string;
    code: string;
    path: string | null;
    message: string;
}

/** A program revision's base: the design (fixed for the revision) and the program a turn handed off, and what the browser found. */
export interface AgentTurnBase {
    versions: TurnVersions;
    design: SolutionDesign;
    program: WorldProgram;
    findings: BaseFinding[];
}

/**
 * The backend's caps on a base (AgentBase): its findings, each string, and the whole base, at most 64 KiB as JSON in
 * UTF-8. A request past one is refused before any charge, so the browser cuts first. The server leaves every hand-off
 * room for the pins and a finding (its `base-size`), so cutting findings always makes a base fit; `margin` absorbs the
 * few bytes the server's own serialization may differ by.
 */
export const BASE_CAPS = Object.freeze({ findings: 32, id: 64, code: 40, path: 200, message: 400, bytes: 65_536, margin: 64 });

const utf8 = new TextEncoder();
/** A value's size as the backend measures a base: UTF-8 bytes of its JSON. */
const jsonBytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

/**
 * The turn's request, as `POST /v1/agent/turn` takes it (the agent-loop design §5.1): the planner's three fields, and a
 * program revision's base, which a first turn leaves out.
 */
export interface AgentTurnRequest {
    prompt: string;
    style: Style | 'auto';
    seconds: number;
    base?: AgentTurnBase;
}

/**
 * The base as the wire carries it: its own fields only, the findings cut to the backend's caps, and the whole within its
 * bound (the EA4.4 review: a world the server handed off could be too large to revise). The findings give way, the last
 * first, down to one, whose message then shortens; S and W never change, since they are the base.
 */
function wireBase(base: AgentTurnBase): AgentTurnBase {
    const findings = base.findings.slice(0, BASE_CAPS.findings).map(f => ({
        id: f.id.slice(0, BASE_CAPS.id), code: f.code.slice(0, BASE_CAPS.code), path: f.path === null ? null : f.path.slice(0, BASE_CAPS.path),
        message: f.message.slice(0, BASE_CAPS.message),
    }));
    const wire: AgentTurnBase = {
        versions: { actionSchema: base.versions.actionSchema, bundle: base.versions.bundle, manifest: base.versions.manifest },
        design: base.design,
        program: base.program,
        findings,
    };
    const bound = BASE_CAPS.bytes - BASE_CAPS.margin;
    while (findings.length > 1 && jsonBytes(wire) > bound) findings.pop();
    while (findings.length === 1 && findings[0].message.length > 1 && jsonBytes(wire) > bound) {
        findings[0] = { ...findings[0], message: findings[0].message.slice(0, Math.ceil(findings[0].message.length / 2)) };
    }
    return wire;
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
                const fields = { prompt: req.prompt, style: req.style, seconds: req.seconds };
                const res = await api.send({
                    method: 'POST', path: '/v1/agent/turn', body: req.base ? { ...fields, base: wireBase(req.base) } : fields,
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
