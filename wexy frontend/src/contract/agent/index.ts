// agent-action.v2 (the backend's agent-loop design §5.2; the engine-adapters design §16, EA3.6): the action the
// engine-aware agent answers with, its program made of adapter nodes, embedded byte for byte from the backend's
// forge-service/src/main/resources/schemas, as host h1's files are. The backend owns it; test/agent-contract.test.mjs
// pins its hash and compares it with the backend's copy when that repository is on this disk. The browser holds a
// hand-off's design and program to the very schema the server held the model's answer to, so the two verdicts cannot
// drift (the engine-aware design §13, "One source for shared rules"). The schema keeps to Meta's strict subset, so a
// small validator covers it; a keyword it does not know is refused when the module loads, rather than passed unchecked.
// v1, whose program named engine calls, is refused at this boundary, never read as v2 (agent-stream.ts).

import type { AdapterNode } from '../adapters';
import { deepFreeze } from '../engine/frozen';
import schemaText from './agent-action.v2.json?raw';

/** S, the high-level design: the request understood, the techniques chosen, what success looks like. */
export interface SolutionDesign {
    intent: string;
    interpretation: string | null;
    assumptions: string[];
    visualElements: { name: string; description: string }[];
    motion: string;
    /** Whether anything moves besides the host's camera. */
    animated: boolean;
    techniques: { purpose: string; symbols: string[]; docIds: string[] }[];
    resourceFlow: string[];
    cameraAndTiming: string;
    controls: { name: string; effect: string }[];
    successCriteria: string[];
    unresolved: string[];
}

/**
 * W, the world program: adapter nodes, each `{id, adapterId, adapterVersion, config, inputs}` with its config still JSON
 * text (the engine-adapters design §16). The schema holds their form; the adapters' own check (`checkNodes`) and the
 * resolver hold what they mean. Nothing here runs: EA3 resolves it on the CPU, statically.
 */
export interface WorldProgram {
    nodes: AdapterNode[];
}

type Schema = { readonly [keyword: string]: unknown };

/** What the strict subset uses here; `title` and `description` only annotate. */
const KEYWORDS = new Set(['title', 'description', 'type', 'anyOf', 'enum', 'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems', 'maxLength', 'minimum', 'maximum']);

/**
 * Throws unless every schema node under `node` uses only the keywords this validator implements and closes its
 * objects: a schema that grew a keyword (a `pattern`, a `oneOf`) must not be half-checked in silence.
 */
export function checkStrictSubset(node: Schema, at = ''): void {
    for (const key of Object.keys(node)) {
        if (!KEYWORDS.has(key)) throw new Error(`${AGENT_ACTION_VERSION}: "${key}" at ${at || '/'} is a keyword this validator does not implement.`);
    }
    if ('properties' in node && node.additionalProperties !== false) {
        throw new Error(`${AGENT_ACTION_VERSION}: the object at ${at || '/'} is not closed (additionalProperties: false).`);
    }
    for (const [name, child] of Object.entries((node.properties ?? {}) as Record<string, Schema>)) checkStrictSubset(child, `${at}/${name}`);
    if (node.items) checkStrictSubset(node.items as Schema, `${at}/items`);
    for (const [i, branch] of ((node.anyOf ?? []) as Schema[]).entries()) checkStrictSubset(branch, `${at}/anyOf/${i}`);
}

/** The action contract this build reads; a turn's meta must name it (agent-stream.ts). */
export const AGENT_ACTION_VERSION = 'agent-action.v2';
/** The schema's text as embedded, line ends normalized to LF, for the hash the tests pin. */
export const AGENT_ACTION_TEXT = schemaText.replace(/\r\n/g, '\n');
export const AGENT_ACTION: Schema = deepFreeze(JSON.parse(AGENT_ACTION_TEXT) as Schema);
checkStrictSubset(AGENT_ACTION);

/** The object branch of a nullable top-level part: a hand-off needs the part itself, never its null. */
function part(name: 'design' | 'program'): Schema {
    const anyOf = ((AGENT_ACTION.properties as Record<string, Schema>)[name].anyOf ?? []) as Schema[];
    const object = anyOf.find(s => s.type === 'object');
    if (!object) throw new Error(`${AGENT_ACTION_VERSION}: ${name} has no object branch.`);
    return object;
}

const DESIGN = part('design');
const PROGRAM = part('program');

function jsonType(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function typeMatches(type: unknown, v: unknown): boolean {
    const types = Array.isArray(type) ? type : [type];
    return types.some(t => t === jsonType(v) || (t === 'integer' && Number.isInteger(v)) || (t === 'number' && typeof v === 'number' && Number.isFinite(v)));
}

/** Code points, as the schema counts a string's length (and the backend's validator does). */
const codePoints = (s: string): number => {
    let n = 0;
    for (const _ of s) n++;
    return n;
};

/** One thing wrong with a value: where, as an RFC 6901 JSON pointer ('' is the value itself), and what. */
export interface SchemaIssue {
    path: string;
    message: string;
}

/**
 * A key or index as one JSON-pointer reference token (RFC 6901 §3): `~` as `~0`, then `/` as `~1`. A key is the
 * model's text, so a `/`, `~` or `:` in it must not move the pointer to another property.
 */
export const pointerToken = (key: string | number): string => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * What is wrong with `value` under `schema`, each with its path; at most `max`, since the first few are what a
 * developer acts on. Empty when it conforms.
 */
export function schemaIssues(schema: Schema, value: unknown, path = '', out: SchemaIssue[] = [], max = 20): SchemaIssue[] {
    const fail = (at: string, message: string) => { out.push({ path: at, message }); };
    if (out.length >= max) return out;
    if (schema.anyOf) {
        const branches = schema.anyOf as Schema[];
        if (branches.some(b => schemaIssues(b, value, path, [], 1).length === 0)) return out;
        // The branch of the value's own type says what is wrong with it; otherwise no branch takes its type at all.
        const same = branches.find(b => b.type === undefined || typeMatches(b.type, value));
        if (same) return schemaIssues(same, value, path, out, max);
        fail(path, `is ${jsonType(value)}, not ${branches.map(b => (Array.isArray(b.type) ? b.type.join(' or ') : String(b.type))).join(' or ')}`);
        return out;
    }
    if (schema.type !== undefined && !typeMatches(schema.type, value)) {
        fail(path, `is ${jsonType(value)}, not ${Array.isArray(schema.type) ? schema.type.join(' or ') : String(schema.type)}`);
        return out;
    }
    if (schema.enum && !(schema.enum as unknown[]).includes(value)) {
        fail(path, `${JSON.stringify(value)?.slice(0, 40)} is not one of ${(schema.enum as unknown[]).join(', ')}`);
    }
    if (typeof value === 'string' && typeof schema.maxLength === 'number' && codePoints(value) > schema.maxLength) {
        fail(path, `is ${codePoints(value)} characters, over ${schema.maxLength}`);
    }
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) fail(path, `${value} is under ${schema.minimum}`);
        if (typeof schema.maximum === 'number' && value > schema.maximum) fail(path, `${value} is over ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(path, `has ${value.length} items, under ${schema.minItems}`);
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(path, `has ${value.length} items, over ${schema.maxItems}`);
        if (schema.items) {
            for (const [i, item] of value.entries()) {
                if (out.length >= max) break;
                schemaIssues(schema.items as Schema, item, `${path}/${i}`, out, max);
            }
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
        const props = schema.properties as Record<string, Schema>;
        const record = value as Record<string, unknown>;
        for (const key of (schema.required ?? []) as string[]) {
            if (!Object.hasOwn(record, key)) fail(`${path}/${pointerToken(key)}`, 'is missing');
        }
        for (const key of Object.keys(record)) {
            if (out.length >= max) break;
            if (!Object.hasOwn(props, key)) fail(`${path}/${pointerToken(key)}`, 'is not in the schema');
            else schemaIssues(props[key], record[key], `${path}/${pointerToken(key)}`, out, max);
        }
    }
    return out.slice(0, max);
}

/** The same, each as `path: problem` text for a developer to read; the value itself is `/`. */
export function schemaProblems(schema: Schema, value: unknown, path = '', max = 20): string[] {
    return schemaIssues(schema, value, path, [], max).map(i => `${i.path || '/'}: ${i.message}`);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** A design as the schema has it, or what is wrong with it. */
export function parseDesign(value: unknown): Parsed<SolutionDesign> {
    const problems = schemaProblems(DESIGN, value, '/design');
    return problems.length ? { ok: false, problems } : { ok: true, value: value as SolutionDesign };
}

/** A program as the schema has it, or what is wrong with it. */
export function parseProgram(value: unknown): Parsed<WorldProgram> {
    const problems = schemaProblems(PROGRAM, value, '/program');
    return problems.length ? { ok: false, problems } : { ok: true, value: value as WorldProgram };
}
