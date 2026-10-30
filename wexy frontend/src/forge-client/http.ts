// The one way to the backend (core-loop-frontend.md §3 and §10): every request goes to the configured gateway
// origin and nowhere else, with the caller's identity attached (identity.ts), and every refusal comes back as a
// ForgeError carrying one of the backend's codes (errors.ts). The tokens are bearer credentials, so a request
// can name a gateway path only, never a URL: no other host can receive them.

import type { PublicConfig } from './config';
import { errorFromResponse, ForgeError } from './errors';
import type { Identity } from './identity';

/**
 * The routes where the gateway spends the App Check token, so each request needs a limited-use token of its
 * own: a cached one would pass once and be refused as a replay after. The gateway's ForgeRoutesTest pins the
 * same routes there (the agent turn's since EA2.4); test/http.test.mjs pins them here.
 */
export const SINGLE_USE_ROUTES: readonly string[] = ['POST /v1/forge/plan', 'POST /v1/agent/turn', 'POST /v1/worlds'];

export function needsSingleUseAppCheck(method: string, path: string): boolean {
    const pathname = decodeURIComponent(new URL(path, 'https://gateway.invalid').pathname);
    return SINGLE_USE_ROUTES.includes(`${method.toUpperCase()} ${pathname}`);
}

export interface ApiRequest {
    method: 'GET' | 'POST';
    /** A gateway path, starting /v1/. */
    path: string;
    /** Sent as JSON. */
    body?: unknown;
    /**
     * Whether the route signs the caller in. The forge and publishing routes do, and they are also the ones that
     * check App Check; the public reads do neither, so they get no tokens at all (backend §11).
     */
    auth: boolean;
    accept?: 'application/json' | 'text/event-stream';
    signal?: AbortSignal;
}

export interface Api {
    /** The response when its status is 2xx; a ForgeError otherwise. A cancel rejects with the AbortError itself. */
    send(req: ApiRequest): Promise<Response>;
}

export function createApi(config: PublicConfig, identity: Identity, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Api {
    return {
        async send(req) {
            req.signal?.throwIfAborted();
            const url = gatewayUrl(config.apiOrigin, req.path);
            const body = req.body === undefined ? undefined : JSON.stringify(req.body);

            const attempt = async (refreshIdentity: boolean): Promise<Response> => {
                req.signal?.throwIfAborted();
                const headers = new Headers({ Accept: req.accept ?? 'application/json' });
                if (body !== undefined) headers.set('Content-Type', 'application/json');
                if (req.auth) {
                    const authorization = await untilAborted(identity.authorization(refreshIdentity), req.signal);
                    req.signal?.throwIfAborted();
                    if (authorization) headers.set('Authorization', authorization);
                    const appCheck = await untilAborted(identity.appCheck(needsSingleUseAppCheck(req.method, url)), req.signal);
                    req.signal?.throwIfAborted();
                    if (appCheck) headers.set('X-Firebase-AppCheck', appCheck);
                }
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
