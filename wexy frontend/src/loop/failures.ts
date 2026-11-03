// How a refusal or a failure from the backend reads to a creator (core-loop-frontend.md §13; coding principles §4): one
// table for h1's loop and the agent path, so a code reads the same whichever path met it. Moved out of machine.ts on
// 2026-11-03 (EA9.1, agent-first-studio-design.md §6 and §11), so the creation controller reaches no part of h1's loop.

import { ForgeError } from '../forge-client/errors';
import { COPY, type FailureKind } from './copy';

/** Where the failure happened: a plan (or an agent turn), an author, a repair. */
export type FailureStage = 'plan' | 'author' | 'repair';

/** A failure the creator can read: the kind, its sentence and the developer's detail. */
export function classifyError(error: unknown, stage: FailureStage): { kind: FailureKind; sentence: string; detail: string } {
    if ((error as Error)?.name === 'AbortError') return { kind: 'cancelled', sentence: '', detail: 'cancelled' };
    if (error instanceof ForgeError) {
        const detail = `${stage}: ${error.code} (HTTP ${error.status}): ${error.message}`;
        const sentence = (kind: FailureKind) => ({ kind, sentence: COPY.failures[kind], detail });
        switch (error.code) {
            case 'budget': return sentence('budget');
            case 'paused': return sentence('paused');
            case 'unavailable': return error.status === 0 ? sentence('offline') : sentence('paused');
            case 'rate': {
                const minutes = error.retryAfterSeconds === null ? null : Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
                return { kind: 'rate', sentence: minutes === null ? COPY.failures.rate : COPY.rateWithMinutes(minutes), detail };
            }
            // W1: on a forge route, account-required is the anonymous allowance spent (the account's one world, or its
            // network's for the day): the studio offers Google sign-in, never a reload.
            case 'account-required': return sentence('allowance');
            case 'quota': {
                const reset = error.retryAfterSeconds === null ? null : new Date(Date.now() + error.retryAfterSeconds * 1000);
                return { kind: 'quota', sentence: reset === null ? COPY.failures.quota : COPY.quotaUntil(reset), detail };
            }
            case 'content-refused': return sentence('refused');
            case 'auth': case 'appcheck': case 'forbidden': return sentence('sign-in');
            case 'timeout': return stage === 'plan' ? sentence('plan') : sentence('author-slow');
            case 'upstream':
                // The backend judged the answer (empty, no function, declined) or Meta failed, twice: not slowness.
                if (/ran out of room/i.test(error.message)) return sentence('ran-out');
                return stage === 'plan' ? sentence('plan') : sentence('author-failed');
            case 'not-found': return sentence('plan');
            default: return sentence('internal');
        }
    }
    return { kind: 'internal', sentence: COPY.failures.internal, detail: `${stage}: ${(error as Error)?.message ?? String(error)}` };
}
