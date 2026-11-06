// The backend's closed set of error codes, as both services return them in the body {"code", "message"}
// (backend core-loop-backend.md §12; ai.wexy.common.ErrorCode). A code is a contract: one added there is
// added here on the same day (design guidelines §1), and test/errors.test.mjs pins the table. W1 (2026-11-02; the
// creations platform designs, §10): `content-refused`, an idea content safety refused before any model call, and
// `quota`, early access's world of the day already made, with Retry-After to the reset. A spent anonymous allowance
// is the existing `account-required`. W2 (2026-11-03) brings `conflict` (409) forward from W3: a profile write based on
// a version that has moved on, or a handle another account holds; the studio reads again and says which. W3 (2026-11-03
// evening) brings `storage-full` (403): the account's saved worlds or bytes at their cap, never with a wait, because
// deleting a world frees space and waiting does not. EA9.4 (2026-11-04) brings `world-refused` (422): a revision whose
// world, its design or its program, content safety refused before any call; not the creator's words (`content-refused`),
// so saying the change another way cannot help, and the studio offers a new idea instead.

export type ErrorCode =
    | 'bad-request' | 'auth' | 'appcheck' | 'account-required' | 'forbidden' | 'storage-full' | 'not-found' | 'conflict'
    | 'too-large' | 'content-refused' | 'world-refused' | 'rate' | 'quota' | 'internal' | 'upstream' | 'budget' | 'paused'
    | 'unavailable' | 'timeout';

/** The HTTP status each code travels with. Several share one, because the studio answers them differently. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
    'bad-request': 400,
    'auth': 401,
    'appcheck': 403,
    'account-required': 403,
    'forbidden': 403,
    'storage-full': 403,
    'not-found': 404,
    'conflict': 409,
    'too-large': 413,
    'content-refused': 422,
    'world-refused': 422,
    'rate': 429,
    'quota': 429,
    'internal': 500,
    'upstream': 502,
    'budget': 503,
    'paused': 503,
    'unavailable': 503,
    'timeout': 504,
};

export function isErrorCode(value: unknown): value is ErrorCode {
    return typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);
}

/**
 * The code for a status that arrived with none of ours (a proxy's 502, a framework 404): the backend's
 * ErrorCode.forStatus, which picks the code that promises least where a status has several.
 */
export function codeForStatus(status: number): ErrorCode {
    switch (status) {
        case 401: return 'auth';
        case 403: return 'forbidden';
        case 404: return 'not-found';
        case 409: return 'conflict';
        case 413: return 'too-large';
        case 429: return 'rate';
        case 502: return 'upstream';
        case 503: return 'unavailable';
        case 504: return 'timeout';
        default: return status >= 500 ? 'internal' : 'bad-request';
    }
}

/** A refusal from the backend, or no answer from it at all (status 0: the network). Never shown to creators as is. */
export class ForgeError extends Error {
    readonly code: ErrorCode;
    /** The HTTP status, or 0 when no response arrived. */
    readonly status: number;
    /** From `Retry-After` on a `rate` or a `quota`, in seconds; null otherwise, and when the header was absent. */
    readonly retryAfterSeconds: number | null;
    /**
     * The code is the status's alone: no envelope of ours came with it (an edge's or a proxy's page), so it is no service's
     * word. A bare 403 is never read as the account's standing (2026-11-04).
     */
    readonly bare: boolean;
    /**
     * The backend ended a stream with it, as its own last event (an agent turn's `error`): the service's word that the
     * turn is over there. False for anything the client decided or could not see (its own caps, a dropped connection, a
     * deadline), whose end on the server's side is unknown (Q120 (b): only a terminal failure is retried by itself).
     */
    readonly terminal: boolean;

    constructor(code: ErrorCode, status: number, message: string, retryAfterSeconds: number | null = null, bare = false, terminal = false) {
        super(message);
        this.name = 'ForgeError';
        this.code = code;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
        this.bare = bare;
        this.terminal = terminal;
    }
}

/**
 * A request bound to a caller (http.ts's `Caller`) who is no longer the one signed in, or whose account epoch has moved:
 * it was not sent (W3's review, its high: a save's retry went out under the account signed in meanwhile). Never a
 * ForgeError: the backend said nothing, so there is no code of its to give.
 */
export class StaleCaller extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StaleCaller';
    }
}

/**
 * The error a non-2xx response stands for. The body is read as the envelope when it is one; an unknown code,
 * or a body that is not ours (an HTML error page from a proxy), falls back to the status's code.
 */
export async function errorFromResponse(res: Response): Promise<ForgeError> {
    let code = codeForStatus(res.status);
    let message = `HTTP ${res.status}`;
    let bare = true;
    const body: unknown = await res.json().catch(() => null);
    if (body && typeof body === 'object') {
        const { code: c, message: m } = body as { code?: unknown; message?: unknown };
        if (isErrorCode(c)) {
            code = c;
            bare = false;
        }
        if (typeof m === 'string' && m) message = m.slice(0, 300);
    }
    // Absent is unknown, not zero; an HTTP-date form is not a number of seconds, so it is unknown too. Only a wait
    // that ends is kept: a rate bucket's, and the daily allowance's reset (W1). Nothing else gets a countdown.
    const header = res.headers.get('Retry-After')?.trim() ?? '';
    const retry = /^\d+$/.test(header) ? Number(header) : null;
    return new ForgeError(code, res.status, message, code === 'rate' || code === 'quota' ? retry : null, bare);
}
