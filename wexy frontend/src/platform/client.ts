// The platform's account calls (W2; the creations platform companion §3, §6; the backend's §10): POST /v1/me, GET /v1/me
// and PATCH /v1/me/profile, each answered with the caller's own self DTO, held here to its closed shape. An answer that
// is not that DTO is "unavailable", never an account. The browser decides nothing: who owns what, the account's status
// and whether a handle is free are the server's to say (F4); the studio only says it.

import { ForgeError } from '../forge-client/errors';
import type { Api } from '../forge-client/http';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';

/** The self DTO: the platform's account id (a ULID, never the Firebase uid), its status, terms and profile. */
export interface AccountView {
    readonly accountId: string;
    readonly status: AccountStatus;
    readonly policyVersion: number;
    readonly profile: {
        /** Lowercase, claimed once; null until then. */
        readonly handle: string | null;
        readonly displayName: string | null;
        readonly bio: string | null;
        readonly publicEnabled: boolean;
        /** The version a change must name (`expectedVersion`). */
        readonly rowVersion: number;
    };
}

/** What reading the caller's account came to. */
export type AccountRead =
    | { readonly kind: 'account'; readonly account: AccountView }
    /** No account yet (404): the caller signed in before W2, or its bootstrap never ran. */
    | { readonly kind: 'none' }
    /**
     * The set-up itself answered 404: the platform never does, so no route leads to it (a gateway from before W2, or a
     * rollback). Asking again before a reload would only spend single-use App Check tokens (the independent W2 review).
     */
    | { readonly kind: 'absent' }
    | { readonly kind: 'unavailable' };

/** What claiming a handle came to. */
export type ClaimOutcome =
    | { readonly kind: 'claimed'; readonly account: AccountView }
    /** Another account holds it. */
    | { readonly kind: 'taken' }
    /** The profile moved on meanwhile (another tab); here is it as it is now. */
    | { readonly kind: 'stale'; readonly account: AccountView }
    /** Refused by the server's rules though it had the right shape: a reserved name. */
    | { readonly kind: 'refused' }
    /** The account cannot make changes (suspended or being deleted). */
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'unavailable' };

const STATUSES: readonly AccountStatus[] = ['ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED'];
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The stored form of a handle (the backend's Handle): lowercase ASCII letters, digits and underscores, 3 to 30. */
const STORED_HANDLE = /^[a-z0-9_]{3,30}$/;
/** What a creator may type: the same, in any case. Anything else is refused here, never mapped to ASCII. */
const TYPED_HANDLE = /^[A-Za-z0-9_]{3,30}$/;

const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value, k));

const text = (value: unknown, max: number): value is string | null =>
    value === null || (typeof value === 'string' && [...value].length <= max);

/** The DTO, exactly: its keys, a ULID, a known status, a handle in its stored form or null, bounded text. Else null. */
export function parseAccount(body: unknown): AccountView | null {
    if (!exactly(body, ['accountId', 'status', 'policyVersion', 'profile'])) return null;
    const { accountId, status, policyVersion, profile } = body;
    if (typeof accountId !== 'string' || !ULID.test(accountId)) return null;
    if (typeof status !== 'string' || !STATUSES.includes(status as AccountStatus)) return null;
    if (typeof policyVersion !== 'number' || !Number.isSafeInteger(policyVersion) || policyVersion < 1) return null;
    if (!exactly(profile, ['handle', 'displayName', 'bio', 'publicEnabled', 'rowVersion'])) return null;
    const { handle, displayName, bio, publicEnabled, rowVersion } = profile;
    if (handle !== null && (typeof handle !== 'string' || !STORED_HANDLE.test(handle))) return null;
    if (!text(displayName, 50) || !text(bio, 280)) return null;
    if (typeof publicEnabled !== 'boolean') return null;
    if (typeof rowVersion !== 'number' || !Number.isSafeInteger(rowVersion) || rowVersion < 0) return null;
    return {
        accountId,
        status: status as AccountStatus,
        policyVersion,
        profile: { handle, displayName, bio, publicEnabled, rowVersion },
    };
}

/**
 * The handle as it would be stored, or null when the server would refuse its shape (it may still refuse a reserved
 * name). A leading `@`, which the studio shows before the field, is the creator's to leave out or put in.
 */
export function typedHandle(raw: string): string | null {
    const value = raw.trim().replace(/^@/, '');
    return TYPED_HANDLE.test(value) ? value.toLowerCase() : null;
}

const read = async (res: Response): Promise<AccountRead> => {
    const account = parseAccount(await res.json().catch(() => null));
    return account ? { kind: 'account', account } : { kind: 'unavailable' };
};

/** Every failure but a cancel is unavailable here; a cancel rejects with its own AbortError. */
const unavailable = (error: unknown): AccountRead => {
    if ((error as Error)?.name === 'AbortError') throw error;
    return { kind: 'unavailable' };
};

/** `GET /v1/me`: the caller's account, `none` before its bootstrap (404), else unavailable. Never makes one. */
export async function readAccount(api: Api, signal?: AbortSignal): Promise<AccountRead> {
    try {
        return await read(await api.send({ method: 'GET', path: '/v1/me', auth: true, signal }));
    } catch (error) {
        if (error instanceof ForgeError && error.code === 'not-found') return { kind: 'none' };
        return unavailable(error);
    }
}

/**
 * `POST /v1/me` (a single-use App Check token): the caller's account, made on the first call and found on any other;
 * the companion's §6 calls it once after a sign-in. Never `none`.
 */
export async function bootstrapAccount(api: Api, signal?: AbortSignal): Promise<AccountRead> {
    try {
        return await read(await api.send({ method: 'POST', path: '/v1/me', body: {}, auth: true, signal }));
    } catch (error) {
        if (error instanceof ForgeError && error.code === 'not-found') return { kind: 'absent' };
        return unavailable(error);
    }
}

/**
 * `PATCH /v1/me/profile` with the handle, for `account` (its id and the version it was read at). The server checks
 * both against the caller's own account (the W2 review): a claim prepared for one account can never land on another,
 * whatever token it goes out with. A 409 is the handle taken, or the profile moved on or another account signed in;
 * the account is read again to tell which, rather than reading the server's words.
 */
export async function claimHandle(api: Api, account: AccountView, handle: string, signal?: AbortSignal): Promise<ClaimOutcome> {
    const expectedVersion = account.profile.rowVersion;
    try {
        const res = await api.send({ method: 'PATCH', path: '/v1/me/profile',
            body: { accountId: account.accountId, expectedVersion, handle }, auth: true, signal });
        const answer = await read(res);
        return answer.kind === 'account' ? { kind: 'claimed', account: answer.account } : { kind: 'unavailable' };
    } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        if (!(error instanceof ForgeError)) return { kind: 'unavailable' };
        switch (error.code) {
            case 'conflict': {
                const now = await readAccount(api, signal);
                if (now.kind !== 'account') return { kind: 'unavailable' };
                const moved = now.account.accountId !== account.accountId || now.account.profile.rowVersion !== expectedVersion;
                return moved ? { kind: 'stale', account: now.account } : { kind: 'taken' };
            }
            case 'bad-request': return { kind: 'refused' };
            case 'forbidden': return { kind: 'forbidden' };
            default: return { kind: 'unavailable' };
        }
    }
}
