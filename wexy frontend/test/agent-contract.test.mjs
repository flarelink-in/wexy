// EA-W series, headless (EA2.5; the backend's agent-loop design §15.1, gates B1 and C): what the agent's two halves share,
// embedded here from the backend byte for byte. The action schema (src/contract/agent) and the wire recordings the
// reader is tested on (test/fixtures/agent-wire, written by the backend's AgentWireTest) are each pinned by hash and
// compared with the backend's files when that repository is on this disk. Then the strict-subset validator that holds a
// hand-off's design and program to the schema.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADAPTER_MANIFEST_HASH, ADAPTERS } from '../src/contract/adapters/index.ts';
import { AGENT_ACTION, AGENT_ACTION_TEXT, AGENT_ACTION_VERSION, checkStrictSubset, MAX_MODULE_REPAIRS, parseDesign, parseProgram, parseRepairs, schemaIssues } from '../src/contract/agent/index.ts';
import { ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';
import { NOTE_CHARS } from '../src/forge-client/module-client.ts';
import { NOTE_CODE, REPAIR_BUDGET_CODE, SET_ASIDE_CODE } from '../src/loop/candidate.ts';

const BACKEND = fileURLToPath(new URL('../../wexy backend/forge-service/src', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/agent-wire/', import.meta.url));
/**
 * sha256 of agent-action.v3.json with LF line ends; the backend's copy is the source (EA6.3, 11-02: v2's revision with
 * moduleRepairs, the notes to modules whose code must change); before, v2's 90255491… (EA3.6, 10-30).
 */
const SCHEMA_HASH = 'c25fc7689301b9a8f79ae424de5aac489a11fed8399e9dbcb771c20581f26b39';
/**
 * SHA-256 over `<name>\n<text>\n` for every recording, sorted by name, LF line ends (as host.test.mjs pins h1). A new
 * recording means the backend's wire changed: a contract change, agreed in both repositories the same day. 11-02 night
 * (EA6.3, Q111 (a)): agent-action.v3 and agent.v6, so every meta's actionSchema and promptVersion and the refused turn's
 * reservation (156,247 → 160,117 µUSD, the template's notes and its size × scale rule), revised.sse's `repairs` (none)
 * and revised-notes.sse, a revision whose notes name a module; then agent.v6 two lines longer (the independent review's
 * EA_NOTE_SET_ASIDE and EA_REPAIR_BUDGET), the reservation 160,117 → 160,585 µUSD; before, 6e4a57cd… and 457d236a… (11-02, Q84
 * revised): agent.v5, which states the candidate's module budget the turn's check now holds, so every meta's promptVersion
 * and the refused turn's reservation (156,034 → 156,247 µUSD, the template a line longer); before, 0d532c42… (11-01,
 * EA5.0, Q86 (a)): null-graph 1.2.1's engine bundle and the adapter manifest naming it, so every meta's bundle and manifest
 * hashes, the refused turn's reservation (the bundle's family index a little longer) and core:NullGraph's declaration
 * (its new release calls); before, 09ce1a37… (EA4.4, Q82 (a)): meta's agent.v4, its revision section and the two Tier-1 rules the live turns broke a little longer than
 * v3 (the refused turn's reservation with it), and revised.sse, a turn that revises a base; before, 24373afe… (agent.v4
 * without the two rules), 13b6a9cb… (10-31: agent.v3 and Q80's gates), cb04377c….
 */
// 2bed7a26… since 2026-11-05 evening (what the model reads, corrected): the engine bundle aa60280b… (null-graph's docs
// on each shape's facing, pbr, the lights and the clear; the family index and H from the adapter manifest), so every
// meta's bundleHash, a read_doc's bytes (6602 → 6769) and the refused turn's reservation (162,508 → 164,675 µUSD:
// agent.v7's camera and batch facts, the longer index); before, 91569a5d… (2026-11-05, the ground shape): agent.v7 and
// the manifest that names the ground, so every meta's promptVersion and manifestHash, and the refused turn's
// reservation (160,585 → 162,508 µUSD, the template's shape facts and the manifest's longer summaries); before,
// 810e4a46… (2026-11-04): error-upstream.sse's turn makes a third call, its second schema repair, and its error says
// why the last answer was not an object, in the parser's words; before, c5da82a4….
const WIRE_HASH = '2bed7a268e94e3355806fcbcfcc00019e562c32027e9ab5d95d4b2a6a69f23bb';

const lf = (s) => s.replace(/\r\n/g, '\n');
const recordings = () => Object.fromEntries(readdirSync(FIXTURES).sort().map(n => [n, lf(readFileSync(join(FIXTURES, n), 'utf8'))]));
/** The data of each event named `name` in a recording. */
const eventData = (wire, name) => [...wire.matchAll(/^event:(.*)\ndata:(.*)$/gm)].filter(m => m[1] === name).map(m => JSON.parse(m[2]));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('EA-W1 the embedded agent-action.v3 and the wire recordings are the pinned ones', () => {
    assert.equal(AGENT_ACTION_VERSION, 'agent-action.v3');
    assert.equal(createHash('sha256').update(AGENT_ACTION_TEXT).digest('hex'), SCHEMA_HASH);
    const h = createHash('sha256');
    for (const [name, text] of Object.entries(recordings())) h.update(`${name}\n${text}\n`);
    assert.equal(h.digest('hex'), WIRE_HASH);
});

test('EA-W2 the schema and every recording are the backend\'s, byte for byte, when that repository is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, () => {
    assert.equal(AGENT_ACTION_TEXT, lf(readFileSync(join(BACKEND, 'main/resources/schemas/agent-action.v3.json'), 'utf8')));
    const files = recordings();
    const dir = join(BACKEND, 'test/resources/agent/wire');
    assert.deepEqual(Object.keys(files), readdirSync(dir).sort(), 'the same recordings on both sides');
    for (const [name, text] of Object.entries(files)) assert.equal(text, lf(readFileSync(join(dir, name), 'utf8')), name);
});

test('EA-W3 every recorded turn quotes this build\'s engine bundle, action contract and adapters, and the agent.v7 prompt, and names its calls in order', () => {
    for (const [name, text] of Object.entries(recordings())) {
        if (!name.endsWith('.sse')) continue;
        const [meta] = eventData(text, 'meta');
        assert.equal(meta.bundleHash, ENGINE_BUNDLE_HASH, `${name}: regenerate the recordings after the bundle changes`);
        assert.equal(meta.actionSchema, AGENT_ACTION_VERSION, name);
        assert.equal(meta.manifestHash, ADAPTER_MANIFEST_HASH, `${name}: regenerate the recordings after the manifest changes`);
        assert.equal(meta.promptVersion, 'agent.v7', name);
        assert.deepEqual(eventData(text, 'call').map(c => c.n), eventData(text, 'call').map((_, i) => i + 1), name);
    }
});

test('EA-W4 the validator refuses a keyword it does not implement, and an object left open', () => {
    assert.doesNotThrow(() => checkStrictSubset(AGENT_ACTION));
    assert.throws(() => checkStrictSubset({ type: 'string', pattern: '^a' }), /"pattern" at \/ is a keyword this validator does not implement/);
    assert.throws(() => checkStrictSubset({ type: 'object', properties: { a: { oneOf: [] } }, additionalProperties: false }), /"oneOf" at \/a/);
    assert.throws(() => checkStrictSubset({ type: 'object', properties: {} }), /not closed/);
});

test('EA-W5 the recorded design and program pass; each departure from the schema is refused at its path', () => {
    const wire = recordings()['handed-off.sse'];
    const [{ design }] = eventData(wire, 'design');
    const [{ program }] = eventData(wire, 'program');
    assert.deepEqual(parseDesign(design), { ok: true, value: design });
    assert.deepEqual(parseProgram(program), { ok: true, value: program });

    const refused = (parse, value, expected) => {
        const parsed = parse(value);
        assert.equal(parsed.ok, false, expected);
        assert.ok(parsed.problems.some(p => p.includes(expected)), `${expected} in ${parsed.problems.join(' | ')}`);
    };
    const d = (change) => { const v = clone(design); change(v); return v; };
    const p = (change) => { const v = clone(program); change(v); return v; };
    refused(parseDesign, d(v => { v.extra = 1; }), '/design/extra: is not in the schema');
    refused(parseDesign, d(v => { delete v.intent; }), '/design/intent: is missing');
    refused(parseDesign, d(v => { v.animated = 'yes'; }), '/design/animated: is string, not boolean');
    refused(parseDesign, d(v => { v.visualElements = []; }), '/design/visualElements: has 0 items, under 1');
    refused(parseDesign, d(v => { v.interpretation = 7; }), '/design/interpretation: is number, not string or null');
    refused(parseDesign, null, '/design: is null, not object');
    // Lengths count code points, as the schema and the backend do: 400 emoji are 800 UTF-16 units and still fit.
    assert.equal(parseDesign(d(v => { v.intent = '🧱'.repeat(400); })).ok, true);
    refused(parseDesign, d(v => { v.intent = '🧱'.repeat(401); }), '/design/intent: is 401 characters, over 400');
    assert.equal(parseDesign(d(v => { v.interpretation = null; })).ok, true);

    // v2's nodes (EA3.6): the form is the schema's; what a node means is the adapters' check (EA-A).
    refused(parseProgram, p(v => { v.nodes[0].adapterId = 'ng.render.anything'; }), '/program/nodes/0/adapterId: "ng.render.anything" is not one of');
    refused(parseProgram, p(v => { v.nodes[0].adapterVersion = 1.5; }), '/program/nodes/0/adapterVersion: is number, not integer');
    refused(parseProgram, p(v => { v.nodes[0].adapterVersion = 0; }), '/program/nodes/0/adapterVersion: 0 is under 1');
    refused(parseProgram, p(v => { v.nodes[0].config = JSON.parse(v.nodes[0].config); }), '/program/nodes/0/config: is object, not string');
    refused(parseProgram, p(v => { v.nodes[0].config = 'x'.repeat(4097); }), '/program/nodes/0/config: is 4097 characters, over 4096');
    refused(parseProgram, p(v => { v.nodes = Array(33).fill(v.nodes[0]); }), '/program/nodes: has 33 items, over 32');
    refused(parseProgram, p(v => { v.nodes = []; }), '/program/nodes: has 0 items, under 1');
    refused(parseProgram, p(v => { delete v.nodes[4].inputs[0].output; }), '/program/nodes/4/inputs/0/output: is missing');
    refused(parseProgram, p(v => { v.nodes[4].inputs = Array(17).fill(v.nodes[4].inputs[0]); }), '/program/nodes/4/inputs: has 17 items, over 16');
    // A raw engine call has no place in a node: no escape hatch.
    refused(parseProgram, p(v => { v.nodes[1].member = 'createCube'; }), '/program/nodes/1/member: is not in the schema');
    refused(parseProgram, [], '/program: is array, not object');
    // A key is one escaped reference token (RFC 6901), in the structured issue and in its text (the EA3.1 review).
    refused(parseDesign, d(v => { v['a/b~c'] = 1; }), '/design/a~1b~0c: is not in the schema');
    const designSchema = AGENT_ACTION.properties.design.anyOf.find(s => s.type === 'object');
    assert.deepEqual(schemaIssues(designSchema, { ...design, 'x:y': 1 }, '/design'), [{ path: '/design/x:y', message: 'is not in the schema' }]);
});

test('EA-W6 one wire limit for an event: the reader\'s is the backend\'s AgentTurn.MAX_EVENT_CHARS, when it is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, async () => {
    const { AGENT_EVENT_CHARS, AGENT_STREAM_LIMITS } = await import('../src/forge-client/agent-stream.ts');
    const java = readFileSync(fileURLToPath(new URL('../../wexy backend/forge-common/src/main/java/ai/wexy/common/AgentTurn.java', import.meta.url)), 'utf8');
    const backend = Number(/MAX_EVENT_CHARS = ([\d_]+);/.exec(java)?.[1].replace(/_/g, ''));
    assert.equal(AGENT_EVENT_CHARS, backend);
    for (const name of ['design', 'program', 'check']) assert.equal(AGENT_STREAM_LIMITS.eventChars[name], backend, name);
});

test('EA-W7 the schema\'s adapters are the manifest\'s, and v1\'s program is refused at its form, never read as nodes', () => {
    const nodes = AGENT_ACTION.properties.program.anyOf.find(s => s.type === 'object').properties.nodes;
    assert.deepEqual(nodes.items.properties.adapterId.enum, ADAPTERS.adapters.map(a => a.id));
    assert.deepEqual(nodes.items.required, ['id', 'adapterId', 'adapterVersion', 'config', 'inputs']);
    // EA2's recorded hand-off, kept as the incompatible contract it is (test/fixtures/agent-wire-v1): its design is still
    // a design, and its program is not a program of this contract.
    const v1 = lf(readFileSync(fileURLToPath(new URL('./fixtures/agent-wire-v1/handed-off.sse', import.meta.url)), 'utf8'));
    const [{ design }] = eventData(v1, 'design');
    const [{ program }] = eventData(v1, 'program');
    assert.equal(parseDesign(design).ok, true);
    const parsed = parseProgram(program);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.problems.includes('/program/nodes: is missing'), parsed.problems.join(' | '));
    assert.ok(parsed.problems.includes('/program/objects: is not in the schema'), parsed.problems.join(' | '));
});

// EA-VR4, the contract's half (EA6.3; the visual-review design §8.2, Q111 (a)): a revision's notes to its modules, as both
// repositories read them. The machine's half (where each note goes) is in test/candidate.test.mjs.

test('EA-VR4a a revision\'s notes are the schema\'s, held whole: a list of at most 12, one a module, each saying something', () => {
    const repairs = AGENT_ACTION.properties.revision.anyOf.find(b => b.type === 'object').properties.moduleRepairs;
    assert.equal(MAX_MODULE_REPAIRS, 12);
    assert.equal(repairs.maxItems, MAX_MODULE_REPAIRS);
    assert.equal(repairs.items.properties.module.maxLength, 40, 'a module as an adapter\'s config names it');
    assert.equal(repairs.items.properties.message.maxLength, NOTE_CHARS, 'a note as a module call carries it');
    const [{ repairs: recorded }] = eventData(recordings()['revised-notes.sse'], 'repairs');
    assert.deepEqual(parseRepairs(recorded), { ok: true, value: recorded });
    assert.deepEqual(parseRepairs([]), { ok: true, value: [] });
    const note = (module, message = 'Lower it by 2 units.') => ({ module, message });
    const cases = [
        ['not a list', { place: 'x' }, /\/repairs: is object, not array/],
        ['thirteen', Array.from({ length: 13 }, (_, i) => note(`m${i}`)), /\/repairs: has 13 items, over 12/],
        ['a key of its own', [{ ...note('place'), line: 3 }], /\/repairs\/0\/line: is not in the schema/],
        ['no message', [{ module: 'place' }], /\/repairs\/0\/message: is missing/],
        ['a module past 40', [note('m'.repeat(41))], /\/repairs\/0\/module: is 41 characters, over 40/],
        ['a note past 300 code points', [note('place', '\u{1F3F0}'.repeat(301))], /\/repairs\/0\/message: is 301 characters, over 300/],
        ['a module twice', [note('place'), note('glow'), note('place', 'Brighter.')], /\/repairs\/2\/module: place has a note already/],
        ['no module', [note('  ')], /\/repairs\/0\/module: names no module/],
        ['a note that says nothing', [note('place', ' ')], /\/repairs\/0\/message: says nothing/],
        // Non-breaking spaces and the BOM are blank here, and the backend's check agrees since the independent review.
        ['a note of non-breaking spaces', [note('place', '\u00A0\u2007\u202F\uFEFF')], /\/repairs\/0\/message: says nothing/],
        ['a module of a non-breaking space', [note('\u00A0')], /\/repairs\/0\/module: names no module/],
    ];
    for (const [label, value, pattern] of cases) {
        const parsed = parseRepairs(value);
        assert.equal(parsed.ok, false, label);
        assert.match(parsed.problems.join('\n'), pattern, label);
    }
    // 300 code points of two UTF-16 units each are within the bound, as the backend counts them too.
    assert.equal(parseRepairs([note('place', '\u{1F3F0}'.repeat(300))]).ok, true);
});

test('EA-VR4b the backend checks what the browser reads: its note\'s bound, and the code a kept body\'s note is sent as, when it is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, () => {
    const request = readFileSync(join(BACKEND, 'main/java/ai/wexy/forge/agent/ModuleRequest.java'), 'utf8');
    assert.match(request, new RegExp(`static final int NOTE_CHARS = ${NOTE_CHARS};`));
    const repair = readFileSync(join(BACKEND, 'main/resources/prompts/module.repair.v4.md'), 'utf8');
    assert.ok(repair.includes(NOTE_CODE), `module.repair.v4 explains ${NOTE_CODE}`);
    const agent = readFileSync(join(BACKEND, 'main/resources/prompts/agent.v7.md'), 'utf8');
    for (const code of [SET_ASIDE_CODE, REPAIR_BUDGET_CODE]) assert.ok(agent.includes(code), `agent.v7 explains ${code}`);
    // Blank as the browser's trim counts it (the independent review of EA6.3).
    assert.match(readFileSync(join(BACKEND, 'main/java/ai/wexy/forge/agent/ModuleRequest.java'), 'utf8'), /Character\.isSpaceChar\(c\) \|\| c == 0xFEFF/);
});
