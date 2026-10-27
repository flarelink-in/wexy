// The director's answer to one instruction about a running world (core-loop-frontend.md §8; the backend's
// edit-plan.v1, forge-loop design §5.4): a tagged union the backend validated against its schema and this parser
// checks again at the boundary (coding principles §2). Applying a plan is FE2's patch engine; FE1 only reads it.

import { FUNCTIONS, type FunctionName, type Vec3 } from './spec';

export interface PatchOp {
    /** `uniforms.<name>`, `post.<block>.<field>`, `camera.move` or `camera.keyframes.<n>.<field>`. */
    path: string;
    value: number | string | boolean | Vec3;
}

export type EditPlan =
    | { kind: 'patch'; ops: PatchOp[]; summary: string }
    | { kind: 'rewrite'; functions: FunctionName[]; instruction: string; ops: PatchOp[]; summary: string }
    | { kind: 'restart'; prompt: string }
    | { kind: 'clarify'; question: string };

export const EDIT_LIMITS = { ops: 16, path: 80, value: 40, summary: 200, instruction: 400, prompt: 600, question: 200 } as const;

class EditPlanError extends Error {
    constructor(why: string) {
        super(`The edit plan broke its contract: ${why}.`);
        this.name = 'EditPlanError';
    }
}

const str = (v: unknown, at: string, max: number): string => {
    if (typeof v !== 'string' || !v.trim()) throw new EditPlanError(`${at} is not a non-empty string`);
    return v.trim().slice(0, max);
};

function op(v: unknown, at: string): PatchOp {
    if (!v || typeof v !== 'object') throw new EditPlanError(`${at} is not an object`);
    const { path, value } = v as { path?: unknown; value?: unknown };
    const p = str(path, `${at}.path`, EDIT_LIMITS.path);
    if (typeof value === 'number' && Number.isFinite(value)) return { path: p, value };
    if (typeof value === 'boolean') return { path: p, value };
    if (typeof value === 'string') return { path: p, value: value.slice(0, EDIT_LIMITS.value) };
    if (Array.isArray(value) && value.length === 3 && value.every(x => typeof x === 'number' && Number.isFinite(x))) {
        return { path: p, value: [value[0], value[1], value[2]] };
    }
    throw new EditPlanError(`${at}.value is not a number, a string, a boolean or three numbers`);
}

function ops(v: unknown, at: string, min: number): PatchOp[] {
    if (v === undefined && min === 0) return [];
    if (!Array.isArray(v) || v.length < min || v.length > EDIT_LIMITS.ops) throw new EditPlanError(`${at} is not an array of ${min} to ${EDIT_LIMITS.ops} ops`);
    return v.map((o, i) => op(o, `${at}[${i}]`));
}

/** The edit in a `{edit}` document or a bare plan; throws an EditPlanError on a broken contract. */
export function parseEditPlan(input: unknown): EditPlan {
    const root = input && typeof input === 'object' && 'edit' in input ? (input as { edit: unknown }).edit : input;
    if (!root || typeof root !== 'object') throw new EditPlanError('the edit is not an object');
    const e = root as Record<string, unknown>;
    switch (e.kind) {
        case 'patch':
            return { kind: 'patch', ops: ops(e.ops, 'edit.ops', 1), summary: str(e.summary, 'edit.summary', EDIT_LIMITS.summary) };
        case 'rewrite': {
            if (!Array.isArray(e.functions) || !e.functions.length || !e.functions.every(f => (FUNCTIONS as readonly string[]).includes(f as string))) {
                throw new EditPlanError('edit.functions is not a list of evolve, look or sky');
            }
            return {
                kind: 'rewrite',
                functions: [...new Set(e.functions as FunctionName[])],
                instruction: str(e.instruction, 'edit.instruction', EDIT_LIMITS.instruction),
                ops: ops(e.ops, 'edit.ops', 0),
                summary: str(e.summary, 'edit.summary', EDIT_LIMITS.summary),
            };
        }
        case 'restart':
            return { kind: 'restart', prompt: str(e.prompt, 'edit.prompt', EDIT_LIMITS.prompt) };
        case 'clarify':
            return { kind: 'clarify', question: str(e.question, 'edit.question', EDIT_LIMITS.question) };
        default:
            throw new EditPlanError(`edit.kind is "${String(e.kind)}"`);
    }
}
