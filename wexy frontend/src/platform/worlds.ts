// The platform's world calls (W3; the creations platform companion §10's W3 note; the backend's §10): a world's save
// and its revisions, its rename, its reads, its deletion, the account's usage and an operation's state. Each answer is
// held here to its closed DTO; one that is not is "unavailable", never a world. A world's id is checked to be a ULID
// before it is put in a path. Which world is whose is the server's to say (F4): another account's is the same 404 as
// none. Every call has a deadline, past which it is unavailable and a save may be sent again with the same key.

import { ForgeError, type ErrorCode } from '../forge-client/errors';
import type { Api } from '../forge-client/http';
import { LINE_SHAPE } from './lines';

/** A call's bound, the token and App Check included: the platform's own is 20 s (the backend's §11). */
export const WORLD_DEADLINE_MS = 30_000;

export interface WorldHead {
    readonly revisionId: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly format: string;
    readonly line: string;
    readonly createdAt: string;
}

/** A world as its owner sees it. */
export interface WorldView {
    readonly worldId: string;
    readonly title: string;
    readonly rowVersion: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly head: WorldHead;
}

export interface WorldPage {
    readonly worlds: readonly WorldView[];
    readonly next: string | null;
}

export interface WorldUsage {
    readonly usedBytes: number;
    readonly reservedBytes: number;
    readonly worlds: number;
    readonly limits: { readonly bytes: number; readonly worlds: number };
}

/** A retained revision and its exact text, unparsed: artifact.ts reads it. */
export interface SavedRevision {
    readonly worldId: string;
    readonly revisionId: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly format: string;
    readonly line: string;
    readonly createdAt: string;
    readonly artifact: string;
}

export type OperationState = 'PENDING' | 'DONE' | 'FAILED';

export interface OperationView {
    readonly operationId: string;
    readonly state: OperationState;
    /** The route's own status once it has an answer; null while it runs. */
    readonly status: number | null;
    readonly result: unknown;
}

/** What a save came to: the world at its head, still under way, or the reason it was not. */
export type SaveAnswer =
    | { readonly kind: 'saved'; readonly world: WorldView }
    | { readonly kind: 'pending'; readonly operationId: string }
    /** The head or the version moved (another tab), or the key was used for another body. */
    | { readonly kind: 'conflict' }
    /** The account's worlds or bytes are at their cap: deleting a world frees room; waiting does not. */
    | { readonly kind: 'storage-full' }
    /** Refused for what it is (400, 413, 403, 404): sending it again changes nothing. */
    | { readonly kind: 'refused'; readonly code: ErrorCode; readonly message: string }
    /** No answer, a 503, a 429 or the deadline: the same request may be sent again with the same key. */
    | { readonly kind: 'unavailable'; readonly status: number };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const STATES: readonly OperationState[] = ['PENDING', 'DONE', 'FAILED'];

const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value, k));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max;

function head(v: unknown): WorldHead | null {
    if (!exactly(v, ['revisionId', 'sha256', 'bytes', 'format', 'line', 'createdAt'])) return null;
    const { revisionId, sha256, bytes, format, line, createdAt } = v;
    if (typeof revisionId !== 'string' || !ULID.test(revisionId) || typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
    if (!count(bytes) || bytes < 1 || !text(format, 40) || typeof line !== 'string' || !LINE_SHAPE.test(line)) return null;
    if (typeof createdAt !== 'string' || !TIME.test(createdAt)) return null;
    return { revisionId, sha256, bytes, format, line, createdAt };
}

/** The world DTO, exactly, or null. */
export function parseWorldView(v: unknown): WorldView | null {
    if (!exactly(v, ['worldId', 'title', 'rowVersion', 'createdAt', 'updatedAt', 'head'])) return null;
    const { worldId, title, rowVersion, createdAt, updatedAt } = v;
    const h = head(v.head);
    if (typeof worldId !== 'string' || !ULID.test(worldId) || !text(title, 120) || title.trim() === '' || !count(rowVersion) || !h) return null;
    if (typeof createdAt !== 'string' || !TIME.test(createdAt) || typeof updatedAt !== 'string' || !TIME.test(updatedAt)) return null;
    return { worldId, title, rowVersion, createdAt, updatedAt, head: h };
}

function parsePage(v: unknown): WorldPage | null {
    if (!exactly(v, ['worlds', 'next']) || !Array.isArray(v.worlds) || v.worlds.length > 50) return null;
    const worlds = v.worlds.map(parseWorldView);
    if (worlds.some(w => w === null)) return null;
    if (v.next !== null && (typeof v.next !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v.next))) return null;
    return { worlds: worlds as WorldView[], next: v.next };
}

function parseUsage(v: unknown): WorldUsage | null {
    if (!exactly(v, ['usedBytes', 'reservedBytes', 'worlds', 'limits']) || !exactly(v.limits, ['bytes', 'worlds'])) return null;
    const { usedBytes, reservedBytes, worlds } = v;
    if (!count(usedBytes) || !count(reservedBytes) || !count(worlds) || !count(v.limits.bytes) || !count(v.limits.worlds)) return null;
    return { usedBytes, reservedBytes, worlds, limits: { bytes: v.limits.bytes, worlds: v.limits.worlds } };
}

function parseRevision(v: unknown): SavedRevision | null {
    if (!exactly(v, ['worldId', 'revisionId', 'sha256', 'bytes', 'format', 'line', 'createdAt', 'artifact'])) return null;
    const h = head({ revisionId: v.revisionId, sha256: v.sha256, bytes: v.bytes, format: v.format, line: v.line, createdAt: v.createdAt });
    if (!h || typeof v.worldId !== 'string' || !ULID.test(v.worldId) || typeof v.artifact !== 'string') return null;
    return { worldId: v.worldId, ...h, artifact: v.artifact };
}

function parseAccepted(v: unknown): { operationId: string; state: OperationState } | null {
    if (!exactly(v, ['operationId', 'state']) || typeof v.operationId !== 'string' || !ULID.test(v.operationId)) return null;
    return STATES.includes(v.state as OperationState) ? { operationId: v.operationId, state: v.state as OperationState } : null;
}

/** An operation's DTO, exactly, or null. */
export function parseOperation(v: unknown): OperationView | null {
    if (!exactly(v, ['operationId', 'state', 'status', 'result']) || typeof v.operationId !== 'string' || !ULID.test(v.operationId)) return null;
    if (!STATES.includes(v.state as OperationState)) return null;
    if (v.status !== null && (!count(v.status) || v.status < 100 || v.status > 599)) return null;
    return { operationId: v.operationId, state: v.state as OperationState, status: v.status as number | null, result: v.result };
}

/** `signal`, and the call's deadline. */
const bounded = (signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(WORLD_DEADLINE_MS)]) : AbortSignal.timeout(WORLD_DEADLINE_MS);

/** A cancel of the caller's own rejects with its AbortError; the deadline is the call's, so it is an answer. */
function rethrowCancel(error: unknown, signal?: AbortSignal): void {
    if (signal?.aborted || ((error as Error)?.name === 'AbortError' && !(error instanceof ForgeError))) throw error;
}

const body = async (res: Response): Promise<unknown> => res.json().catch(() => null);

function saveFailure(error: unknown, signal?: AbortSignal): SaveAnswer {
    rethrowCancel(error, signal);
    if (!(error instanceof ForgeError)) return { kind: 'unavailable', status: 0 };
    switch (error.code) {
        case 'conflict': return { kind: 'conflict' };
        case 'storage-full': return { kind: 'storage-full' };
        case 'bad-request': case 'too-large': case 'forbidden': case 'account-required': case 'not-found': case 'auth': case 'appcheck':
            return { kind: 'refused', code: error.code, message: error.message };
        default: return { kind: 'unavailable', status: error.status };
    }
}

async function saveAnswer(res: Response): Promise<SaveAnswer> {
    const b = await body(res);
    if (res.status === 202) {
        const a = parseAccepted(b);
        return a ? { kind: 'pending', operationId: a.operationId } : { kind: 'unavailable', status: 202 };
    }
    const world = parseWorldView(b);
    return world ? { kind: 'saved', world } : { kind: 'unavailable', status: res.status };
}

/** The text to save, its hash and the key every try of this one request goes with. */
export interface SaveRequest {
    readonly key: string;
    readonly text: string;
    readonly sha256: string;
}

/** `POST /v1/worlds`: a new world named `title`, its first revision `request.text`. */
export async function createWorld(api: Api, title: string, request: SaveRequest, signal?: AbortSignal): Promise<SaveAnswer> {
    try {
        const res = await api.send({ method: 'POST', path: '/v1/worlds', auth: true, idempotencyKey: request.key, signal: bounded(signal),
            body: { title, artifact: request.text, sha256: request.sha256 } });
        return await saveAnswer(res);
    } catch (error) {
        return saveFailure(error, signal);
    }
}

/** `POST /v1/worlds/{id}/revisions`: the world's next head, on the head and version it was read at. */
export async function reviseWorld(api: Api, world: { worldId: string; revisionId: string; rowVersion: number }, request: SaveRequest,
    signal?: AbortSignal): Promise<SaveAnswer> {
    if (!ULID.test(world.worldId) || !ULID.test(world.revisionId)) return { kind: 'refused', code: 'bad-request', message: 'not a world' };
    try {
        const res = await api.send({ method: 'POST', path: `/v1/worlds/${world.worldId}/revisions`, auth: true, idempotencyKey: request.key,
            signal: bounded(signal),
            body: { baseRevisionId: world.revisionId, expectedVersion: world.rowVersion, artifact: request.text, sha256: request.sha256 } });
        return await saveAnswer(res);
    } catch (error) {
        return saveFailure(error, signal);
    }
}

export type EditAnswer =
    | { readonly kind: 'done'; readonly world: WorldView }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'missing' }
    | { readonly kind: 'refused'; readonly message: string }
    | { readonly kind: 'unavailable' };

function editFailure(error: unknown, signal?: AbortSignal): EditAnswer {
    rethrowCancel(error, signal);
    if (!(error instanceof ForgeError)) return { kind: 'unavailable' };
    if (error.code === 'conflict') return { kind: 'conflict' };
    if (error.code === 'not-found') return { kind: 'missing' };
    if (error.code === 'bad-request' || error.code === 'forbidden') return { kind: 'refused', message: error.message };
    return { kind: 'unavailable' };
}

/** `PATCH /v1/worlds/{id}`: a new title, at the version `world` was read at. */
export async function renameWorld(api: Api, world: WorldView, title: string, signal?: AbortSignal): Promise<EditAnswer> {
    if (!ULID.test(world.worldId)) return { kind: 'missing' };
    try {
        const res = await api.send({ method: 'PATCH', path: `/v1/worlds/${world.worldId}`, auth: true, signal: bounded(signal),
            body: { expectedVersion: world.rowVersion, title } });
        const w = parseWorldView(await body(res));
        return w ? { kind: 'done', world: w } : { kind: 'unavailable' };
    } catch (error) {
        return editFailure(error, signal);
    }
}

export type DeleteAnswer =
    | { readonly kind: 'deleting'; readonly operationId: string }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unavailable' };

/** `DELETE /v1/worlds/{id}?expectedVersion=`: hidden at once; its bytes are erased after. */
export async function deleteWorld(api: Api, world: WorldView, key: string, signal?: AbortSignal): Promise<DeleteAnswer> {
    if (!ULID.test(world.worldId)) return { kind: 'missing' };
    try {
        const res = await api.send({ method: 'DELETE', path: `/v1/worlds/${world.worldId}?expectedVersion=${world.rowVersion}`, auth: true,
            idempotencyKey: key, signal: bounded(signal) });
        const a = parseAccepted(await body(res));
        return a ? { kind: 'deleting', operationId: a.operationId } : { kind: 'unavailable' };
    } catch (error) {
        const e = editFailure(error, signal);
        return e.kind === 'conflict' || e.kind === 'missing' ? e : { kind: 'unavailable' };
    }
}

/** `GET /v1/me/worlds`: a page of the history, the newest made first; null when unavailable. */
export async function listWorlds(api: Api, page: { cursor?: string | null; limit?: number } = {}, signal?: AbortSignal): Promise<WorldPage | null> {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    if (page.cursor) query.set('cursor', page.cursor);
    const q = query.toString();
    try {
        const res = await api.send({ method: 'GET', path: `/v1/me/worlds${q ? `?${q}` : ''}`, auth: true, signal: bounded(signal) });
        return parsePage(await body(res));
    } catch (error) {
        rethrowCancel(error, signal);
        return null;
    }
}

/** `GET /v1/worlds/{id}`: the world, `missing` (gone, or another's), or unavailable. */
export async function readWorld(api: Api, worldId: string, signal?: AbortSignal): Promise<WorldView | 'missing' | 'unavailable'> {
    if (!ULID.test(worldId)) return 'missing';
    try {
        const res = await api.send({ method: 'GET', path: `/v1/worlds/${worldId}`, auth: true, signal: bounded(signal) });
        return parseWorldView(await body(res)) ?? 'unavailable';
    } catch (error) {
        rethrowCancel(error, signal);
        return error instanceof ForgeError && error.code === 'not-found' ? 'missing' : 'unavailable';
    }
}

/** `GET /v1/worlds/{id}/revisions/{revisionId}`: a retained revision's exact text; its checks are artifact.ts'. */
export async function readRevision(api: Api, worldId: string, revisionId: string, signal?: AbortSignal): Promise<SavedRevision | 'missing' | 'unavailable'> {
    if (!ULID.test(worldId) || !ULID.test(revisionId)) return 'missing';
    try {
        const res = await api.send({ method: 'GET', path: `/v1/worlds/${worldId}/revisions/${revisionId}`, auth: true, signal: bounded(signal) });
        return parseRevision(await body(res)) ?? 'unavailable';
    } catch (error) {
        rethrowCancel(error, signal);
        return error instanceof ForgeError && error.code === 'not-found' ? 'missing' : 'unavailable';
    }
}

/** `GET /v1/me/usage`: the caller's own; null when unavailable. */
export async function readUsage(api: Api, signal?: AbortSignal): Promise<WorldUsage | null> {
    try {
        return parseUsage(await body(await api.send({ method: 'GET', path: '/v1/me/usage', auth: true, signal: bounded(signal) })));
    } catch (error) {
        rethrowCancel(error, signal);
        return null;
    }
}

/** `GET /v1/me/operations/{id}`: the operation's state; null when unavailable or not the caller's. */
export async function readOperation(api: Api, operationId: string, signal?: AbortSignal): Promise<OperationView | null> {
    if (!ULID.test(operationId)) return null;
    try {
        return parseOperation(await body(await api.send({ method: 'GET', path: `/v1/me/operations/${operationId}`, auth: true, signal: bounded(signal) })));
    } catch (error) {
        rethrowCancel(error, signal);
        return null;
    }
}
