// A module call over the transport (http.ts, module-stream.ts; candidate-loop-design.md §5 and §6, EA4.3): POST
// /v1/agent/module with exactly the eleven fields the backend's ModuleRequest takes, then its stream, read to its terminal
// under one absolute deadline. The route spends its App Check token, so each call gets a fresh limited-use one (http.ts,
// SINGLE_USE_ROUTES), the transport's one retry after a 401 included: that 401 comes from the gateway before it
// forwards anything. A call is never retried or replayed once it may have started (the design §8): every other refusal
// or failure is the candidate machine's to route.
//
// The request is built from what the browser holds: R and S as the turn handed them off, the module's node and the
// nodes wired to it (a slice, which the server checks node by node, not the whole program), the interface's whole hashed
// ABI projection, and for a repair the previous body exactly as it was judged, its findings capped as the server caps
// them. An author may carry a program revision's note to its module (EA6.3, the visual-review design §8.2), written
// with it once; a repair's note is one of its findings, so a repair's `note` is null.

import { ADAPTER_MANIFEST_HASH, type AdapterNode } from '../contract/adapters';
import { BODY_CHECKER } from '../contract/adapters/bodies';
import { ABI_VERSION, type InterfaceBinding, type ModuleInterface } from '../contract/adapters/interfaces';
import { AGENT_ACTION_VERSION, type SolutionDesign, type WorldProgram } from '../contract/agent';
import { cutCodePoints } from '../contract/text';
import type { DeepReadonly } from '../contract/engine/frozen';
import { ENGINE_BUNDLE_HASH, type AgentTurnRequest } from './agent-client';
import { ForgeError } from './errors';
import type { Api } from './http';
import { readModuleStream, type ModuleEvent, type ModuleJob, type ModuleOutcome, type ModulePurpose, type ModuleSubject, type ModuleVersions } from './module-stream';

/**
 * The module role answers within 240 s (the backend's application.yaml; 120 s until 2026-11-04, when a body could grow to
 * 800 lines), heartbeats every 15 s; the client allows that and 15 s for the identity, the gateway and the last event, as
 * the turn's deadline does. Fixed when the call starts.
 */
export const MODULE_DEADLINE_MS = 255_000;

/** This build's pins, which the backend holds every module request to (ModuleRequest.pins); EA-W9 pins them equal. */
export const MODULE_VERSIONS: ModuleVersions = Object.freeze({
    bundle: ENGINE_BUNDLE_HASH, actionSchema: AGENT_ACTION_VERSION, manifest: ADAPTER_MANIFEST_HASH, abi: ABI_VERSION, checker: BODY_CHECKER,
});

/**
 * The backend's caps on a repair's previous body (ModuleRequest: MAX_FINDINGS, FINDING_CHARS, MAX_EVIDENCE_IDS, a
 * finding's code and its other strings): a request past one is refused before any charge, so the browser cuts first.
 * A message's cap is in code points, as both sides count it.
 */
export const PREVIOUS_CAPS = Object.freeze({ findings: 32, message: 400, code: 40, text: 64, evidenceIds: 32 });

/** The interface as the wire carries it: everything its hash covers, and its hash (the design §5). */
export interface WireInterface {
    abi: string;
    preamble: string;
    epilogue: string;
    entries: { stage: 'compute' | 'vertex' | 'fragment'; entry: string; signature: string; engineEntry: 'cs_main' | 'vs_main' | 'fs_main' }[];
    bindings: InterfaceBinding[];
    constants: { name: string; value: number }[];
    workgroupSize: number | null;
    chunks: { id: string; hash: string }[];
    interfaceHash: string;
}

/** A finding a repair answers, as the wire carries it. */
export interface WireFinding {
    id: string;
    rung: string;
    code: string;
    path: string | null;
    line: number | null;
    severity: 'error' | 'warning';
    message: string;
}

/** A repair's body exactly as the browser judged it, its hash, and what was found in it. */
export interface ModulePrevious {
    body: string;
    codeHash: string;
    evidenceIds: string[];
    findings: WireFinding[];
}

/** `POST /v1/agent/module`'s body: exactly these eleven fields (the backend's ModuleRequest.FIELDS). */
export interface ModuleCallBody {
    turnId: string;
    jobId: string;
    subject: ModuleSubject;
    versions: ModuleVersions;
    purpose: ModulePurpose;
    request: AgentTurnRequest;
    design: SolutionDesign;
    nodes: AdapterNode[];
    module: { id: string; kind: ModuleInterface['kind']; interface: WireInterface };
    previous: ModulePrevious | null;
    /** An author's note from a program revision (EA6.3), at most NOTE_CHARS code points; null otherwise, and for a repair. */
    note: string | null;
}

/** A note's bound (the backend's ModuleRequest.NOTE_CHARS, the schema's moduleRepairs[].message), in code points. */
export const NOTE_CHARS = 300;

/** The interface's wire projection: every field its hash covers but `module` and `kind` (sent beside it), each entry without its program path. */
export function wireInterface(iface: DeepReadonly<ModuleInterface>): WireInterface {
    return {
        abi: iface.abi,
        preamble: iface.preamble,
        epilogue: iface.epilogue,
        entries: iface.entries.map(e => ({ stage: e.stage, entry: e.entry, signature: e.signature, engineEntry: e.engineEntry })),
        bindings: iface.bindings.map(b => ({ ...b })),
        constants: iface.constants.map(c => ({ ...c })),
        workgroupSize: iface.workgroupSize,
        chunks: iface.chunks.map(c => ({ ...c })),
        interfaceHash: iface.interfaceHash,
    };
}

/**
 * The nodes a module call carries: the node that names the module and the nodes wired to it, in program order (the
 * design §5). The server checks each on its own, so the slice's other inputs are not dangling.
 */
export function moduleNodes(program: DeepReadonly<WorldProgram>, owner: string): AdapterNode[] {
    const own = program.nodes.find(n => n.id === owner);
    if (!own) throw new Error(`module call: no node ${owner} in the program`);
    const wired = new Set(own.inputs.map(i => i.nodeId));
    return program.nodes.filter(n => n.id === owner || wired.has(n.id))
        .map(n => ({ id: n.id, adapterId: n.adapterId, adapterVersion: n.adapterVersion, config: n.config, inputs: n.inputs.map(i => ({ ...i })) }));
}

/** The finding that says a repair's list was cut to the backend's bound: the host's own, never a check's. */
export const OMITTED_CODE = 'EA_FINDINGS_OMITTED';

/**
 * A previous body within the backend's caps, each string cut to its bound. Its findings keep a program revision's note
 * (rung `note`, EA6.3) first whatever else was found, then the rest in the order given; past the cap, the last kept
 * place says how many were left out (`EA_FINDINGS_OMITTED`), so a repair never takes a cut list for the whole and never
 * loses the change it was asked to make (the outside review of 11-02 night).
 */
export function cappedPrevious(previous: DeepReadonly<ModulePrevious>): ModulePrevious {
    const cut = (s: string | null, max: number) => (s === null ? null : s.slice(0, max));
    const ordered = [...previous.findings.filter(f => f.rung === 'note'), ...previous.findings.filter(f => f.rung !== 'note')];
    const kept: DeepReadonly<WireFinding>[] = ordered.length <= PREVIOUS_CAPS.findings ? ordered : ordered.slice(0, PREVIOUS_CAPS.findings - 1);
    const omitted = ordered.length - kept.length;
    // A message's bound is in code points, as the backend counts it (the independent review of EA6.3): a note of emoji
    // keeps every one, and a cut never splits one.
    const findings = kept.map(f => ({
        id: f.id.slice(0, PREVIOUS_CAPS.text), rung: f.rung.slice(0, PREVIOUS_CAPS.text), code: f.code.slice(0, PREVIOUS_CAPS.code),
        path: cut(f.path, PREVIOUS_CAPS.text), line: f.line, severity: f.severity, message: cutCodePoints(f.message, PREVIOUS_CAPS.message),
    }));
    // At least two are cut whenever any is: this line takes the last place.
    if (omitted > 0) {
        findings.push({
            id: 'omitted', rung: 'host', code: OMITTED_CODE, path: null, line: null, severity: 'warning',
            message: `${omitted} more of what the checks found are not listed: a request carries at most ${PREVIOUS_CAPS.findings}. `
                + 'Answer what is listed; the whole body is checked again after.',
        });
    }
    return {
        body: previous.body,
        codeHash: previous.codeHash,
        evidenceIds: previous.evidenceIds.slice(0, PREVIOUS_CAPS.evidenceIds),
        findings,
    };
}

export interface ModuleClient {
    /** One call: each event once it is checked, then the outcome; a ForgeError, a ModuleStreamError or a cancel's own AbortError otherwise. */
    call(body: ModuleCallBody, onEvent: (event: ModuleEvent) => void, signal: AbortSignal): Promise<ModuleOutcome>;
}

export function createModuleClient(api: Api, options: { deadlineMs?: number } = {}): ModuleClient {
    const deadlineMs = options.deadlineMs ?? MODULE_DEADLINE_MS;
    return {
        async call(body, onEvent, signal) {
            // Exactly the eleven fields, rebuilt here: a caller's object never sends a field of its own (the server refuses one).
            const sent: ModuleCallBody = {
                turnId: body.turnId, jobId: body.jobId, subject: body.subject, versions: body.versions, purpose: body.purpose,
                request: { prompt: body.request.prompt, style: body.request.style, seconds: body.request.seconds },
                design: body.design, nodes: body.nodes,
                module: { id: body.module.id, kind: body.module.kind, interface: body.module.interface },
                previous: body.previous === null ? null : cappedPrevious(body.previous),
                // A repair's note is one of its findings: the server refuses one beside them, so none is sent.
                note: body.purpose === 'author' ? body.note ?? null : null,
            };
            const job: ModuleJob = {
                turnId: sent.turnId, jobId: sent.jobId, purpose: sent.purpose, subject: sent.subject, versions: sent.versions,
                module: sent.module.id, interfaceHash: sent.module.interface.interfaceHash,
            };
            const within = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
            try {
                const res = await api.send({ method: 'POST', path: '/v1/agent/module', body: sent, auth: true, accept: 'text/event-stream', signal: within });
                return await readModuleStream(res, job, onEvent, { signal: within });
            } catch (error) {
                if ((error as Error)?.name === 'TimeoutError') {
                    throw new ForgeError('timeout', 0, `The module call ${sent.jobId} had no last event within ${Math.round(deadlineMs / 1000)} s; the connection was dropped.`);
                }
                throw error;
            }
        },
    };
}
