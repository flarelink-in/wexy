// The caller's allowance as the server says it (W1; the creations platform companion §1, §9; the backend's §10, I13):
// `GET /v1/forge/allowance`, held to its closed shape, and the chip's words for it. The browser counts nothing: a world
// made, a refusal, a sign-in each send the studio back to the server for the number. An answer that is not the DTO, or
// none at all, is "unavailable", never zero and never unlimited.

import type { Api } from '../forge-client/http';
import { clockTime } from '../loop/copy';

export interface Allowance {
    /** What the server calls this caller's allowance: anonymous callers' "Free", signed-in callers' "Early access". */
    readonly label: 'Free' | 'Early access';
    /** Worlds left in this window, as the server counted them. */
    readonly left: number;
    /** When the next one opens, or null where waiting opens nothing (an anonymous allowance spent: sign in instead). */
    readonly resetsAt: Date | null;
}

const KEYS = ['label', 'left', 'resetsAt'];

/** The DTO, exactly: three keys, a known label, a whole count, an ISO time or null. Anything else is unknown. */
export function parseAllowance(body: unknown): Allowance | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).length !== KEYS.length || !KEYS.every(k => Object.hasOwn(fields, k))) return null;
    const { label, left, resetsAt } = fields;
    if (label !== 'Free' && label !== 'Early access') return null;
    if (typeof left !== 'number' || !Number.isSafeInteger(left) || left < 0) return null;
    if (resetsAt === null) return { label, left, resetsAt: null };
    if (typeof resetsAt !== 'string') return null;
    const at = Date.parse(resetsAt);
    return Number.isFinite(at) ? { label, left, resetsAt: new Date(at) } : null;
}

/**
 * The caller's allowance, or null when the server's answer is not one (unavailable). A cancel rejects with its own
 * AbortError. Only for a caller who is signed in: an authenticated read signs an anonymous caller in otherwise.
 */
export async function readAllowance(api: Api, signal?: AbortSignal): Promise<Allowance | null> {
    try {
        const res = await api.send({ method: 'GET', path: '/v1/forge/allowance', auth: true, signal });
        return parseAllowance(await res.json());
    } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        return null;
    }
}

/** The chip's words: what the server said, or that it said nothing usable. */
export function chipText(allowance: Allowance | null, now: Date = new Date()): string {
    if (!allowance) return 'Allowance unavailable';
    const { label, left, resetsAt } = allowance;
    const worlds = `${left} world${left === 1 ? '' : 's'}`;
    if (label === 'Free') return left > 0 ? `${left} free world${left === 1 ? '' : 's'}` : 'Free world made';
    if (left > 0) return `Early access: ${worlds} today`;
    return resetsAt ? `Early access: next world at ${clockTime(resetsAt, now)}` : 'Early access: today\'s world made';
}
