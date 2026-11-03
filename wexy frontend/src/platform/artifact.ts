// A saved world's file (W3; the creations platform companion §5, §7 and §8; Q123 to Q125): an agent world's source as
// one canonical `wexy-world.v1` text, and such a text read back as untrusted data. Only agent worlds are saved (Q123:
// "yes only local download for h1"). The file holds the design S, the program W, each module's body as sealed, the
// camera and the studio's keyframes; never the idea's text, a call, a charge, an original body, a repair or a device's
// verdict (F6). Its versions are its format, its line and its pins (lines.ts; Q125). Reading never seals: reopen.ts
// does, after this file's checks pass.

import { BODY_CHECKER } from '../contract/adapters/bodies';
import { canonicalJson, sha256Hex } from '../contract/adapters/canonical';
import { ABI_VERSION } from '../contract/adapters/interfaces';
import { AGENT_ACTION_VERSION, checkStrictSubset, schemaProblems, type SolutionDesign, type WorldProgram } from '../contract/agent';
import { deepFreeze, type DeepReadonly } from '../contract/engine/frozen';
import type { CameraKeyframe } from '../contract/spec';
import type { SealedCandidate } from '../loop/snapshot';
import { viewToKeyframe, type CameraView } from '../runtime/camera-path';
import { LINE_SHAPE, opensLine, OPENS_LINES, WORLD_FORMAT, WORLD_LINE, WORLD_MAX_BYTES } from './lines';
import schemaText from './wexy-world.v1.json?raw';

export { OPENS_LINES, WORLD_FORMAT, WORLD_LINE, WORLD_MAX_BYTES } from './lines';

type Schema = { readonly [keyword: string]: unknown };

/** The schema's text, line ends normalized to LF; the backend keeps a copy that a test holds equal. */
export const WORLD_SCHEMA_TEXT = schemaText.replace(/\r\n/g, '\n');
export const WORLD_SCHEMA: Schema = deepFreeze(JSON.parse(WORLD_SCHEMA_TEXT) as Schema);
checkStrictSubset(WORLD_SCHEMA);

/** What the world was made under: provenance, and the set a test pins (F9). */
export interface WorldPins {
    readonly actionSchema: string;
    readonly abi: string;
    readonly checker: string;
    readonly bundle: string;
    readonly manifest: string;
    readonly policy: string;
}

export interface SavedModule {
    readonly module: string;
    readonly interfaceHash: string;
    readonly codeHash: string;
    readonly body: string;
}

/** A camera in the file: degrees, as h1's CameraKeyframe without `t`, rounded as viewToKeyframe rounds. */
export interface SavedView {
    readonly target: readonly [number, number, number];
    readonly distance: number;
    readonly azimuth: number;
    readonly polar: number;
    readonly fov: number;
}

/** wexy-world.v1: an agent world's source (§5). */
export interface WorldArtifactV1 {
    readonly format: 'wexy-world.v1';
    readonly kind: 'agent';
    readonly line: string;
    readonly pins: WorldPins;
    readonly design: SolutionDesign;
    readonly program: WorldProgram;
    /** X's hash and id(C) when saved: provenance only; the seal's own stand (§8). */
    readonly graph: string;
    readonly candidate: string;
    readonly modules: readonly SavedModule[];
    readonly view: SavedView | null;
    readonly keyframes: readonly CameraKeyframe[];
}

/** What a world is saved from: the sealed candidate on the stage, its design, and the camera when it was saved. */
export interface WorldSource {
    readonly snapshot: DeepReadonly<SealedCandidate>;
    readonly design: DeepReadonly<SolutionDesign>;
    /** The orbit's view, in the runtime's radians; null: the world is framed on its bounds when opened. */
    readonly view: CameraView | null;
    /** The studio's keyframes for the world (Q119); none until EA9.4. */
    readonly keyframes?: readonly CameraKeyframe[];
}

/** A world's text, ready to send: its exact canonical text, the SHA-256 of its UTF-8 bytes, and their count. */
export interface WorldText {
    readonly text: string;
    readonly sha256: string;
    readonly bytes: number;
}

export type Built =
    | { readonly ok: true; readonly world: WorldText }
    /** `too-large`: past WORLD_MAX_BYTES; `unsaveable`: it does not fit the format (a developer's error). */
    | { readonly ok: false; readonly code: 'too-large' | 'unsaveable'; readonly reason: string };

/**
 * Why a text cannot be opened: `too-large` past the cap; `corrupt`, not the bytes its hash names; `unreadable`, not a
 * canonical wexy-world.v1 text; `incompatible`, another format, an h1 world, or a line this build does not open.
 */
export type WorldRefusal = 'too-large' | 'corrupt' | 'unreadable' | 'incompatible';

export type ParsedWorld =
    | { readonly ok: true; readonly world: DeepReadonly<WorldArtifactV1>; readonly sha256: string; readonly bytes: number }
    | { readonly ok: false; readonly code: WorldRefusal; readonly reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** This build's pins for a world sealed here. */
export function pinsOf(snapshot: DeepReadonly<SealedCandidate>): WorldPins {
    const id = snapshot.x.identity;
    return { actionSchema: AGENT_ACTION_VERSION, abi: ABI_VERSION, checker: BODY_CHECKER, bundle: id.bundleHash, manifest: id.manifestHash, policy: id.policyHash };
}

/** The view as the file keeps it: degrees, rounded as a keyframe is. */
export function savedView(view: CameraView): SavedView {
    const k = viewToKeyframe(view, 0);
    return { target: [k.target[0], k.target[1], k.target[2]], distance: k.distance, azimuth: k.azimuth, polar: k.polar, fov: k.fov };
}

/** Plain JSON data, deeply copied: the frozen state the studio holds is never handed on. */
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Every problem with `value` as a wexy-world.v1 world that the schema cannot say: the hashes' shape and the line's.
 * The schema's own come first. Empty when it conforms.
 */
export function worldProblems(value: unknown, max = 20): string[] {
    const problems = schemaProblems(WORLD_SCHEMA, value, '', max);
    if (problems.length || !isObject(value)) return problems;
    const world = value as unknown as WorldArtifactV1;
    const hex = (v: string, at: string) => { if (!HEX64.test(v)) problems.push(`${at}: is not 64 lowercase hex digits`); };
    if (!LINE_SHAPE.test(world.line)) problems.push(`/line: "${world.line.slice(0, 32)}" is not a line (name.vN)`);
    hex(world.graph, '/graph');
    hex(world.candidate, '/candidate');
    for (const k of ['bundle', 'manifest', 'policy'] as const) hex(world.pins[k], `/pins/${k}`);
    world.modules.forEach((m, i) => { hex(m.interfaceHash, `/modules/${i}/interfaceHash`); hex(m.codeHash, `/modules/${i}/codeHash`); });
    return problems.slice(0, max);
}

/**
 * The world's text from what is on the stage: built from a whitelist of fields, written canonical, hashed. A world
 * that does not fit the format is a developer's error, said here before anything is sent.
 */
export async function worldArtifact(source: WorldSource): Promise<Built> {
    const s = source.snapshot;
    const artifact: WorldArtifactV1 = {
        format: WORLD_FORMAT,
        kind: 'agent',
        line: WORLD_LINE,
        pins: pinsOf(s),
        design: plain<SolutionDesign>(source.design),
        program: { nodes: plain(s.program) },
        graph: s.x.hash,
        candidate: s.id,
        modules: s.bodies.map(b => ({ module: b.module, interfaceHash: b.interfaceHash, codeHash: b.codeHash, body: b.body })),
        view: source.view ? savedView(source.view) : null,
        keyframes: (source.keyframes ?? []).map(k => ({
            t: k.t, target: [k.target[0], k.target[1], k.target[2]], distance: k.distance, azimuth: k.azimuth, polar: k.polar, fov: k.fov,
        })),
    };
    const problems = worldProblems(artifact, 3);
    if (problems.length) return { ok: false, code: 'unsaveable', reason: `the world does not fit ${WORLD_FORMAT}: ${problems.join('; ')}` };
    let text: string;
    try {
        text = canonicalJson(artifact);
    } catch (e) {
        return { ok: false, code: 'unsaveable', reason: (e as Error).message };
    }
    const bytes = utf8Bytes(text);
    if (bytes > WORLD_MAX_BYTES) return { ok: false, code: 'too-large', reason: `the world's text is ${bytes} bytes; at most ${WORLD_MAX_BYTES}` };
    return { ok: true, world: { text, sha256: await sha256Hex(text), bytes } };
}

/**
 * A saved world's text, read as untrusted data (§8's steps 1 and 2), its expected SHA-256 the one the server named
 * (null for a file the creator picked, which only its own checks hold). Nothing is sealed or compiled here.
 */
export async function parseWorld(text: string, expectedSha256: string | null): Promise<ParsedWorld> {
    if (typeof text !== 'string') return { ok: false, code: 'unreadable', reason: 'the world is not text' };
    const bytes = utf8Bytes(text);
    if (bytes > WORLD_MAX_BYTES) return { ok: false, code: 'too-large', reason: `the text is ${bytes} bytes; at most ${WORLD_MAX_BYTES}` };
    const sha256 = await sha256Hex(text);
    if (expectedSha256 !== null && sha256 !== expectedSha256) {
        return { ok: false, code: 'corrupt', reason: `the text is not the bytes its hash names (${sha256.slice(0, 12)}…, not ${String(expectedSha256).slice(0, 12)}…)` };
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (e) {
        return { ok: false, code: 'unreadable', reason: `the text is not JSON: ${(e as Error).message}` };
    }
    let canonical: string | null = null;
    try {
        canonical = canonicalJson(value);
    } catch { /* not plain JSON data: refused below */ }
    if (canonical !== text) return { ok: false, code: 'unreadable', reason: 'the text is not canonical JSON (its bytes are not the ones its value writes)' };
    if (!isObject(value)) return { ok: false, code: 'unreadable', reason: 'the text is not a saved world' };
    if (value.format !== WORLD_FORMAT) {
        return { ok: false, code: 'incompatible', reason: `the file is ${typeof value.format === 'string' ? value.format.slice(0, 40) : 'of no format'}, not ${WORLD_FORMAT}` };
    }
    if (value.kind === 'h1') return { ok: false, code: 'incompatible', reason: 'an h1 world: the studio never saves these (Q123)' };
    const problems = worldProblems(value, 3);
    if (problems.length) return { ok: false, code: 'unreadable', reason: `the file is not a ${WORLD_FORMAT} world: ${problems.join('; ')}` };
    const world = value as unknown as WorldArtifactV1;
    if (!opensLine(world.line)) {
        return { ok: false, code: 'incompatible', reason: `line ${world.line} is not one this build opens (${OPENS_LINES.join(', ')})` };
    }
    return { ok: true, world: deepFreeze(world) as DeepReadonly<WorldArtifactV1>, sha256, bytes };
}
