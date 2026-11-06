// The one way to the backend (core-loop-frontend.md §3 and §10): every request goes to the configured gateway
// origin and nowhere else, with the caller's identity attached (identity.ts), and every refusal comes back as a
// ForgeError carrying one of the backend's codes (errors.ts). The tokens are bearer credentials, so a request
// can name a gateway path only, never a URL: no other host can receive them.

import type { PublicConfig } from './config';
import { errorFromResponse, ForgeError, StaleCaller } from './errors';
import type { Identity } from './identity';

/**
 * Who a request may go out as (W3's review, its high; the creations platform companion F4): the uid its account epoch
 * was signed in as, and whether that epoch still holds. A request bound to one is sent only under that uid's own ID
 * token (the identity never signs anyone in for it), and `still()` is asked once its credentials are in hand, just
 * before each fetch, the retry after a 401 included. Otherwise it is not sent: {@link StaleCaller}.
 */
export interface Caller {
    readonly uid: string;
    still(): boolean;
}

/**
 * The routes where the gateway spends the App Check token, so each request needs a limited-use token of its
 * own: a cached one would pass once and be refused as a replay after. The gateway's ForgeRoutesTest pins the
 * same routes there (the agent turn's since EA2.4, a module call's since EA4.2, a model's review since EA6.4);
 * test/http.test.mjs pins them here. Since W2 (the creations platform design §10) the platform's: an account's
 * bootstrap and deletion, a submission to the showcase and the waitlist; a world's save (POST /v1/worlds) left the set
 * and takes the cached token. A `{id}` stands for one path segment.
 */
export const SINGLE_USE_ROUTES: readonly string[] = ['POST /v1/agent/turn', 'POST /v1/agent/module',
    'POST /v1/agent/review', 'POST /v1/me', 'DELETE /v1/me', 'POST /v1/worlds/{id}/submissions', 'POST /v1/waitlist'];

/** Each route of {@link SINGLE_USE_ROUTES} as its method and a whole-path pattern, `{id}` one segment. */
const SINGLE_USE_PATTERNS = SINGLE_USE_ROUTES.map(route => {
    const [method, path] = route.split(' ');
    const pattern = path.split('/').map(part => (part === '{id}' ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return { method, path: new RegExp(`^${pattern}$`) };
});

export function needsSingleUseAppCheck(method: string, path: string): boolean {
    const pathname = decodeURIComponent(new URL(path, 'https://gateway.invalid').pathname);
    const verb = method.toUpperCase();
    return SINGLE_USE_PATTERNS.some(route => route.method === verb && route.path.test(pathname));
}

/**
 * An `Idempotency-Key` (W3; the creations platform designs §10): 16 to 64 letters, digits and hyphens, such as a
 * `crypto.randomUUID()`. The platform answers a retry with the same key and body as it answered the first.
 */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

export interface ApiRequest {
    /** PATCH and DELETE since W2: the platform's profile and world edits and deletions. */
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    /** A gateway path, starting /v1/. */
    path: string;
    /** Sent as JSON. */
    body?: unknown;
    /** Sent as `Idempotency-Key` (W3): a world's saves and its deletion. The same key on every try of one request. */
    idempotencyKey?: string;
    /**
     * Whether the route signs the caller in. The forge and publishing routes do, and they are also the ones that
     * check App Check; the public reads do neither, so they get no tokens at all (backend §11).
     */
    auth: boolean;
    accept?: 'application/json' | 'text/event-stream';
    signal?: AbortSignal;
    /** The caller it may go out as, and no other ({@link Caller}): a world's saves, reads and edits (W3). */
    caller?: Caller;
}

export interface Api {
    /**
     * The response when its status is 2xx; a ForgeError otherwise. A cancel rejects with the AbortError itself; a request
     * whose caller no longer holds rejects with {@link StaleCaller}, unsent.
     */
    send(req: ApiRequest): Promise<Response>;
}

/** `api` with every request bound to `caller`: sent as that caller or not at all. */
export function boundTo(api: Api, caller: Caller): Api {
    return { send: req => api.send({ ...req, caller }) };
}

export function createApi(config: PublicConfig, identity: Identity, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Api {
    return {
        async send(req) {
            req.signal?.throwIfAborted();
            const url = gatewayUrl(config.apiOrigin, req.path);
            const body = req.body === undefined ? undefined : JSON.stringify(req.body);
            if (req.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(req.idempotencyKey)) {
                throw new Error(`api: "${String(req.idempotencyKey).slice(0, 80)}" is not an idempotency key (16 to 64 of A-Z, a-z, 0-9 and -).`);
            }

            const caller = req.caller;
            const attempt = async (refreshIdentity: boolean): Promise<Response> => {
                req.signal?.throwIfAborted();
                const headers = new Headers({ Accept: req.accept ?? 'application/json' });
                if (body !== undefined) headers.set('Content-Type', 'application/json');
                // The same key on the second try after a 401: one request, tried twice, is still one save.
                if (req.idempotencyKey !== undefined) headers.set('Idempotency-Key', req.idempotencyKey);
                if (req.auth) {
                    const singleUse = needsSingleUseAppCheck(req.method, url);
                    // A bound request takes its App Check token first, so its ID token, the caller's own, is the last
                    // thing awaited before the fetch (W3's review).
                    const appCheck = caller ? await untilAborted(identity.appCheck(singleUse), req.signal) : null;
                    req.signal?.throwIfAborted();
                    const authorization = await untilAborted(identity.authorization(refreshIdentity, caller?.uid), req.signal);
                    req.signal?.throwIfAborted();
                    if (authorization) headers.set('Authorization', authorization);
                    else if (caller) throw new StaleCaller(`api: no ID token for the caller ${caller.uid.slice(0, 8)}…; ${req.method} ${req.path} not sent.`);
                    const check = caller ? appCheck : await untilAborted(identity.appCheck(singleUse), req.signal);
                    req.signal?.throwIfAborted();
                    if (check) headers.set('X-Firebase-AppCheck', check);
                }
                // The caller's epoch, asked last, with nothing awaited between it and the fetch.
                if (caller && !caller.still()) throw new StaleCaller(`api: the account changed; ${req.method} ${req.path} not sent.`);
                try {
                    // Bearer tokens, not cookies: credentials stay home, and nothing here may be cached.
                    return await fetchImpl(url, { method: req.method, headers, body, signal: req.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
                } catch (error) {
                    // A cancel, or a deadline (AbortSignal.timeout): the caller's to classify, never 'unavailable'.
                    if ((error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError') throw error;
                    throw new ForgeError('unavailable', 0, `The backend did not answer (${(error as Error)?.message ?? error}).`);
                }
            };

            let res = await attempt(false);
            // An expired ID token: refresh it and try once more (backend §12). A single-use route mints a fresh
            // App Check token for the second try, since the gateway may have spent the first before refusing.
            if (res.status === 401 && req.auth) {
                await res.body?.cancel();
                res = await attempt(true);
            }
            if (!res.ok) throw await errorFromResponse(res);
            return res;
        },
    };
}

/**
 * `promise`, or the signal's reason as soon as it aborts: a stalled sign-in, token refresh or attestation must not
 * outlive a cancel or a deadline (EA2.5's review). The SDK's promise runs on; its late result or failure is dropped.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
        promise.then(
            value => { signal.removeEventListener('abort', stop); resolve(value); },
            error => { signal.removeEventListener('abort', stop); reject(error); },
        );
    });
}

/** The gateway URL for `path`; a developer error, said loudly, when there is no gateway or the path leaves it. */
function gatewayUrl(origin: string | null, path: string): string {
    if (!origin) throw new Error('api: VITE_API_ORIGIN is not set, so there is no backend to call (see .env.example).');
    if (!path.startsWith('/v1/')) throw new Error(`api: "${path}" is not a gateway path (/v1/…).`);
    // Checked after resolving: "/v1/../x" starts like a gateway path and resolves to /x.
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/v1/')) throw new Error(`api: "${path}" resolves outside the gateway's /v1/ paths.`);
    return url.href;
}
