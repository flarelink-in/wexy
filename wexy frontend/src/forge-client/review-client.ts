// A model's review of the world on the stage over the transport (http.ts; visual-review-design.md §9, §9.1; EA6.4, Q112
// (a) decided 2026-11-03): GET /v1/agent/review, the terms the creator consents to (the gates, the provider, the model,
// the policy), and POST /v1/agent/review, one metered call with the frames, R, S and the host's findings the creator
// kept, answered as one JSON document. The review route spends its App Check token (SINGLE_USE_ROUTES); its terms do not.
//
// Everything that comes back is untrusted (coding principles §2): the terms and the answer are read strictly, field by
// field, and an answer counts only when it echoes the review, its subject and every frame's hash exactly as sent, and
// its verdict keeps review-verdict.v1's rules, which this module reads from the schema itself so the two cannot drift:
// a pass has no issue, a fail at least one, at most 32, each sentence 1 to 400 code points, each module one the request
// named. Anything else is EA_REVIEW_INVALID, never a pass (§9). A request past the terms' limits is EA_REVIEW_SIZE
// before it is sent. A call is never retried once it may have started: a refusal or a failure is the session's to count.

import schemaText from '../contract/agent/review-verdict.v1.json?raw';
import type { SolutionDesign } from '../contract/agent';
import type { ModuleSubject } from './module-stream';
import type { AgentTurnRequest } from './agent-client';
import { ForgeError } from './errors';
import type { Api } from './http';

/** The verdict's contract, the backend's `review-verdict.v1`, embedded byte for byte (EA-VR8a pins it). */
export const REVIEW_VERDICT = 'review-verdict.v1';
export const REVIEW_VERDICT_TEXT: string = schemaText;

/** The review role answers within 45 s (the backend's application.yaml); 15 s more for the identity, the gateway and the answer. */
export const REVIEW_DEADLINE_MS = 60_000;

/** Q62's gates, in the design's order: the first one not met is the one Developer view names. */
export const REVIEW_GATES = ['images', 'transport', 'privacy', 'metering'] as const;
export type ReviewGate = typeof REVIEW_GATES[number];

const SCHEMA = JSON.parse(schemaText) as {
    properties: {
        issues: { maxItems: number; items: { properties: Record<string, { enum?: string[]; maxLength?: number; maxItems?: number; items?: { maxLength: number } }> } };
    };
};
const ISSUE = SCHEMA.properties.issues.items.properties;
/** An issue's kinds, severities and scopes, read from the schema. */
export const ISSUE_KINDS: readonly string[] = Object.freeze([...(ISSUE.kind.enum ?? [])]);
export const ISSUE_SEVERITIES: readonly string[] = Object.freeze([...(ISSUE.severity.enum ?? [])]);
export const ISSUE_SCOPES: readonly string[] = Object.freeze([...(ISSUE.scope.enum ?? [])]);
export const MAX_ISSUES: number = SCHEMA.properties.issues.maxItems;
export const SENTENCE_CHARS: number = ISSUE.sentence.maxLength ?? 400;

export interface ReviewLimits {
    frames: number;
    width: number;
    height: number;
    /** A frame's JPEG at most, and two together, decoded. */
    jpegBytes: number;
    pairBytes: number;
    /** The whole request body at most, base64 and JSON included. */
    requestBytes: number;
    findings: number;
    modules: number;
}

/**
 * The design's limits (§9, §9.1): the terms may say less, never more, and a frame is exactly 768 × 432 (Q108), as the
 * capture fits it. Terms past them are not this contract's: the review stays shut rather than send what was not agreed.
 */
export const REVIEW_LIMITS: Readonly<ReviewLimits> = Object.freeze({
    frames: 2, width: 768, height: 432, jpegBytes: 300_000, pairBytes: 600_000, requestBytes: 1_048_576, findings: 32, modules: 12,
});

/** What the backend says about a model's review: whether it may run, and what the creator would consent to. */
export interface ReviewTerms {
    available: boolean;
    /** The first gate not verified, or null when every one is. */
    gate: ReviewGate | null;
    gates: Record<ReviewGate, 'verified' | 'unverified'>;
    provider: string | null;
    model: string;
    /** Meta's Standard mode, whose content does not train its models, or its contributor mode, whose does. */
    mode: 'standard' | 'contributor';
    policyVersion: string | null;
    limits: ReviewLimits;
}

export interface ReviewFrameBody {
    id: string;
    view: 'framed' | 'side';
    tick: number;
    seconds: number;
    width: number;
    height: number;
    sha256: string;
    /** The JPEG, standard padded base64: never a URL. */
    jpeg: string;
}

/** What the creator consented to: exactly the terms' provider, model and policy version. */
export interface ReviewConsent {
    provider: string;
    model: string;
    policyVersion: string;
}

/** `POST /v1/agent/review`'s body: exactly these nine fields (the backend's ReviewRequest.FIELDS). */
export interface ReviewCallBody {
    reviewId: string;
    turnId: string;
    subject: ModuleSubject;
    request: AgentTurnRequest;
    design: SolutionDesign;
    modules: string[];
    frames: ReviewFrameBody[];
    hostFindings: { code: string; message: string }[];
    consent: ReviewConsent;
}

export interface ModelIssue {
    /** 1, 2, …: the issue's place in the verdict. */
    n: number;
    kind: string;
    severity: 'error' | 'warning';
    sentence: string;
    /** The smallest change the model suggests: advice, never authority (§8.2). */
    scope: 'program' | 'modules' | 'design';
    modules: string[];
}

export interface ModelVerdict {
    verdict: 'pass' | 'fail';
    issues: ModelIssue[];
}

export interface ReviewUsage {
    in: number;
    out: number;
    reasoning: number | null;
    cached: number | null;
    costMicroUsd: number;
}

/** The backend's answer, checked: the review it answers, the verdict, the call's identity and its usage. */
export interface ReviewAnswer {
    reviewId: string;
    generationId: string;
    model: string;
    source: 'live';
    role: 'review';
    promptVersion: string;
    subject: ModuleSubject;
    frames: { id: string; sha256: string }[];
    verdict: ModelVerdict;
    usage: ReviewUsage;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const codePoints = (s: string) => [...s].length;
/** Blank as both sides count it: every character white space, the BOM and non-breaking spaces included (the backend's `blank`). */
const blank = (s: string) => s.replace(/[\s   ﻿]/gu, '') === '';
const SUBJECT_KEYS = ['attempt', 'revision', 'programHash', 'graph', 'candidate', 'module', 'interfaceHash', 'codeHash'] as const;

function exactly(v: Record<string, unknown>, keys: readonly string[], what: string, fail: (why: string) => never): void {
    const extra = Object.keys(v).filter(k => !keys.includes(k));
    const missing = keys.filter(k => !(k in v));
    if (extra.length || missing.length) fail(`${what} takes exactly ${keys.join(', ')}${extra.length ? `; not ${extra.slice(0, 5).join(', ')}` : ''}${missing.length ? `; ${missing.join(', ')} missing` : ''}`);
}

/** The terms, read strictly; an Error saying what is wrong otherwise. */
export function parseTerms(value: unknown): ReviewTerms {
    const fail = (why: string): never => {
        throw new Error(`EA_REVIEW_INVALID terms: ${why}`);
    };
    if (!isObject(value)) fail('not an object');
    const t = value as Record<string, unknown>;
    exactly(t, ['available', 'gate', 'gates', 'provider', 'model', 'mode', 'policyVersion', 'limits'], 'the terms', fail);
    if (typeof t.available !== 'boolean') fail('available is a boolean');
    if (!isObject(t.gates)) fail('gates is an object');
    const gates = t.gates as Record<string, unknown>;
    exactly(gates, REVIEW_GATES, 'gates', fail);
    for (const g of REVIEW_GATES) if (gates[g] !== 'verified' && gates[g] !== 'unverified') fail(`gates.${g} is verified or unverified`);
    const first = REVIEW_GATES.find(g => gates[g] === 'unverified') ?? null;
    if (t.gate !== first) fail(`gate is the first gate not verified (${first ?? 'none'}), not ${String(t.gate)}`);
    if (t.available !== (first === null)) fail('available is true exactly when every gate is verified');
    const name = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9._:+-]{1,128}$/.test(v);
    if (t.provider !== null && !name(t.provider)) fail('provider is a name or null');
    if (t.policyVersion !== null && !name(t.policyVersion)) fail('policyVersion is a name or null');
    if (!name(t.model)) fail('model is a model id');
    if (t.mode !== 'standard' && t.mode !== 'contributor') fail('mode is standard or contributor');
    if (!isObject(t.limits)) fail('limits is an object');
    const l = t.limits as Record<string, unknown>;
    const LIMITS = ['frames', 'width', 'height', 'jpegBytes', 'pairBytes', 'requestBytes', 'findings', 'modules'] as const;
    exactly(l, LIMITS, 'limits', fail);
    for (const k of LIMITS) if (!isCount(l[k]) || (l[k] as number) < 1) fail(`limits.${k} is a whole number of 1 or more`);
    for (const k of ['width', 'height'] as const) if (l[k] !== REVIEW_LIMITS[k]) fail(`limits.${k} is ${REVIEW_LIMITS[k]}, as a captured frame is`);
    for (const k of LIMITS) if ((l[k] as number) > REVIEW_LIMITS[k]) fail(`limits.${k} is at most ${REVIEW_LIMITS[k]}, the design's`);
    return {
        available: t.available as boolean, gate: first, gates: Object.fromEntries(REVIEW_GATES.map(g => [g, gates[g]])) as ReviewTerms['gates'],
        provider: t.provider as string | null, model: t.model as string, mode: t.mode as ReviewTerms['mode'], policyVersion: t.policyVersion as string | null,
        limits: Object.fromEntries(LIMITS.map(k => [k, l[k]])) as unknown as ReviewLimits,
    };
}

/**
 * The backend's answer to `sent`, read strictly and held to it: the review, its subject and each frame's id and hash
 * exactly as sent, and a verdict within review-verdict.v1 and its rules. EA_REVIEW_INVALID otherwise.
 */
export function parseAnswer(value: unknown, sent: ReviewCallBody): ReviewAnswer {
    const fail = (why: string): never => {
        throw new Error(`EA_REVIEW_INVALID ${why}; review ${sent.reviewId}`);
    };
    if (!isObject(value)) fail('answer: not an object');
    const a = value as Record<string, unknown>;
    exactly(a, ['reviewId', 'generationId', 'model', 'source', 'role', 'promptVersion', 'subject', 'frames', 'verdict', 'usage'], 'the answer', fail);
    if (a.reviewId !== sent.reviewId) fail(`reviewId: it answers ${String(a.reviewId).slice(0, 64)}, not this review`);
    if (typeof a.generationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.generationId)) fail('generationId: not a generation id');
    if (typeof a.model !== 'string' || !a.model || a.model.length > 64) fail('model: not a model id');
    if (a.source !== 'live') fail('source: not live');
    if (a.role !== 'review') fail('role: not review');
    if (typeof a.promptVersion !== 'string' || !/^[a-z.]+\.v[1-9][0-9]*$/.test(a.promptVersion)) fail('promptVersion: not a template id');
    if (!isObject(a.subject)) fail('subject: not an object');
    const s = a.subject as Record<string, unknown>;
    exactly(s, SUBJECT_KEYS, 'subject', fail);
    for (const k of SUBJECT_KEYS) if (s[k] !== sent.subject[k]) fail(`subject.${k}: not the subject sent`);
    if (!Array.isArray(a.frames) || a.frames.length !== sent.frames.length) fail('frames: not one echo a frame sent');
    const frames = (a.frames as unknown[]).map((f, i) => {
        if (!isObject(f)) fail(`frames[${i}]: not an object`);
        exactly(f as Record<string, unknown>, ['id', 'sha256'], `frames[${i}]`, fail);
        const echo = f as { id: unknown; sha256: unknown };
        if (echo.id !== sent.frames[i].id || echo.sha256 !== sent.frames[i].sha256) fail(`frames[${i}]: not the frame sent (id and hash)`);
        return { id: echo.id as string, sha256: echo.sha256 as string };
    });
    const verdict = parseVerdict(a.verdict, sent.modules, fail);
    if (!isObject(a.usage)) fail('usage: not an object');
    const u = a.usage as Record<string, unknown>;
    exactly(u, ['in', 'out', 'reasoning', 'cached', 'costMicroUsd'], 'usage', fail);
    for (const k of ['in', 'out', 'costMicroUsd']) if (!isCount(u[k])) fail(`usage.${k}: not a count`);
    for (const k of ['reasoning', 'cached']) if (u[k] !== null && !isCount(u[k])) fail(`usage.${k}: not a count or null`);
    return {
        reviewId: sent.reviewId, generationId: a.generationId as string, model: a.model as string, source: 'live', role: 'review',
        promptVersion: a.promptVersion as string, subject: { ...sent.subject }, frames, verdict,
        usage: { in: u.in as number, out: u.out as number, reasoning: u.reasoning as number | null, cached: u.cached as number | null, costMicroUsd: u.costMicroUsd as number },
    };
}

function parseVerdict(value: unknown, modules: readonly string[], fail: (why: string) => never): ModelVerdict {
    if (!isObject(value)) fail('verdict: not an object');
    const v = value as Record<string, unknown>;
    exactly(v, ['verdict', 'issues'], 'verdict', fail);
    if (v.verdict !== 'pass' && v.verdict !== 'fail') fail('verdict.verdict: pass or fail');
    if (!Array.isArray(v.issues) || v.issues.length > MAX_ISSUES) fail(`verdict.issues: at most ${MAX_ISSUES}`);
    const list = v.issues as unknown[];
    if (v.verdict === 'pass' && list.length) fail(`verdict: a pass with ${list.length} issues`);
    if (v.verdict === 'fail' && !list.length) fail('verdict: a fail with no issue');
    const issues = list.map((x, i) => {
        const at = `verdict.issues[${i}]`;
        if (!isObject(x)) fail(`${at}: not an object`);
        const o = x as Record<string, unknown>;
        exactly(o, ['n', 'kind', 'severity', 'sentence', 'scope', 'modules'], at, fail);
        if (o.n !== i + 1) fail(`${at}.n: issues are numbered 1, 2, … in order`);
        if (typeof o.kind !== 'string' || !ISSUE_KINDS.includes(o.kind)) fail(`${at}.kind: one of ${ISSUE_KINDS.join(', ')}`);
        if (typeof o.severity !== 'string' || !ISSUE_SEVERITIES.includes(o.severity)) fail(`${at}.severity: error or warning`);
        if (typeof o.scope !== 'string' || !ISSUE_SCOPES.includes(o.scope)) fail(`${at}.scope: one of ${ISSUE_SCOPES.join(', ')}`);
        if (typeof o.sentence !== 'string' || blank(o.sentence) || codePoints(o.sentence) > SENTENCE_CHARS) fail(`${at}.sentence: 1 to ${SENTENCE_CHARS} characters`);
        if (!Array.isArray(o.modules) || o.modules.length > modules.length) fail(`${at}.modules: modules the request named`);
        const named = o.modules as unknown[];
        if (named.some(m => typeof m !== 'string' || !modules.includes(m)) || new Set(named).size !== named.length) fail(`${at}.modules: modules the request named, each once`);
        return { n: i + 1, kind: o.kind as string, severity: o.severity as ModelIssue['severity'], sentence: o.sentence as string, scope: o.scope as ModelIssue['scope'], modules: [...named] as string[] };
    });
    return { verdict: v.verdict as ModelVerdict['verdict'], issues };
}

/** Bytes as standard padded base64, in chunks a call's arguments can hold. */
export function toBase64(bytes: Uint8Array): string {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
}

/** A base64 string's decoded length. */
export const decodedLength = (b64: string) => Math.floor(b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/**
 * Why `body` cannot be sent under `limits` (§11's `EA_REVIEW_SIZE <field>: <actual> exceeds <limit> bytes`, and the
 * other bounds), or null: refused here before any identity, App Check token or byte is spent.
 */
export function requestProblem(body: ReviewCallBody, limits: ReviewLimits): string | null {
    if (!body.frames.length || body.frames.length > limits.frames) return `EA_REVIEW_SIZE frames: ${body.frames.length} frames; a review sends 1 to ${limits.frames}`;
    let total = 0;
    for (const [i, f] of body.frames.entries()) {
        if (f.width !== limits.width || f.height !== limits.height) return `EA_REVIEW_SIZE frames[${i}]: ${f.width}×${f.height}; a review frame is ${limits.width}×${limits.height}`;
        const n = decodedLength(f.jpeg);
        if (n > limits.jpegBytes) return `EA_REVIEW_SIZE frames[${i}].jpeg: ${n} exceeds ${limits.jpegBytes} bytes`;
        total += n;
    }
    if (total > limits.pairBytes) return `EA_REVIEW_SIZE frames: ${total} exceeds ${limits.pairBytes} bytes`;
    if (body.hostFindings.length > limits.findings) return `EA_REVIEW_SIZE hostFindings: ${body.hostFindings.length} exceeds ${limits.findings}`;
    if (body.modules.length > limits.modules) return `EA_REVIEW_SIZE modules: ${body.modules.length} exceeds ${limits.modules}`;
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    if (bytes > limits.requestBytes) return `EA_REVIEW_SIZE request: ${bytes} exceeds ${limits.requestBytes} bytes`;
    return null;
}

export interface ReviewClient {
    /** The terms; an Error (EA_REVIEW_INVALID) or a ForgeError otherwise. */
    terms(signal?: AbortSignal): Promise<ReviewTerms>;
    /** One review under `limits`: the checked answer, or a ForgeError, an EA_REVIEW_INVALID or EA_REVIEW_SIZE Error, or a cancel's AbortError. */
    review(body: ReviewCallBody, limits: ReviewLimits, signal: AbortSignal): Promise<ReviewAnswer>;
}

export function createReviewClient(api: Api, options: { deadlineMs?: number } = {}): ReviewClient {
    const deadlineMs = options.deadlineMs ?? REVIEW_DEADLINE_MS;
    return {
        async terms(signal) {
            const res = await api.send({ method: 'GET', path: '/v1/agent/review', auth: true, signal });
            return parseTerms(await res.json());
        },
        async review(body, limits, signal) {
            // Exactly the nine fields, rebuilt here: a caller's object never sends a field of its own (the server refuses one).
            const sent: ReviewCallBody = {
                reviewId: body.reviewId, turnId: body.turnId, subject: { ...body.subject },
                request: { prompt: body.request.prompt, style: body.request.style, seconds: body.request.seconds },
                design: body.design, modules: [...body.modules],
                frames: body.frames.map(f => ({ id: f.id, view: f.view, tick: f.tick, seconds: f.seconds, width: f.width, height: f.height, sha256: f.sha256, jpeg: f.jpeg })),
                hostFindings: body.hostFindings.map(f => ({ code: f.code, message: f.message })),
                consent: { provider: body.consent.provider, model: body.consent.model, policyVersion: body.consent.policyVersion },
            };
            const problem = requestProblem(sent, limits);
            if (problem) throw new Error(problem);
            const within = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
            try {
                const res = await api.send({ method: 'POST', path: '/v1/agent/review', body: sent, auth: true, signal: within });
                let parsed: unknown;
                try {
                    parsed = await res.json();
                } catch (error) {
                    // The deadline or a cancel while the answer was read is that, not an answer that is no JSON (§11).
                    if ((error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError') throw error;
                    throw new Error(`EA_REVIEW_INVALID answer: not JSON; review ${sent.reviewId}`);
                }
                return parseAnswer(parsed, sent);
            } catch (error) {
                if ((error as Error)?.name === 'TimeoutError') {
                    throw new ForgeError('timeout', 0, `The review ${sent.reviewId} had no answer within ${Math.round(deadlineMs / 1000)} s; the connection was dropped.`);
                }
                throw error;
            }
        },
    };
}
