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
import { AGENT_ACTION, AGENT_ACTION_TEXT, AGENT_ACTION_VERSION, checkStrictSubset, parseDesign, parseProgram, schemaIssues } from '../src/contract/agent/index.ts';
import { ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';

const BACKEND = 'D:/orion-realms/wexy/wexy backend/forge-service/src';
const FIXTURES = fileURLToPath(new URL('./fixtures/agent-wire/', import.meta.url));
/** sha256 of agent-action.v2.json with LF line ends; the backend's copy is the source (EA3.6, 10-30). */
const SCHEMA_HASH = '90255491b3061b8b60d61f24a043bfb06ad53eb7f991313d606cd868b06b9858';
/**
 * SHA-256 over `<name>\n<text>\n` for every recording, sorted by name, LF line ends (as host.test.mjs pins h1). A new
 * recording means the backend's wire changed: a contract change, agreed in both repositories the same day. 11-01 (EA4.4,
 * Q82 (a)): meta's agent.v4, its revision section and the two Tier-1 rules the live turns broke a little longer than
 * v3 (the refused turn's reservation with it), and revised.sse, a turn that revises a base; before, 24373afe… (agent.v4
 * without the two rules), 13b6a9cb… (10-31: agent.v3 and Q80's gates), cb04377c….
 */
const WIRE_HASH = '09ce1a37b791d107cb7da907495a60e9a9b817ef17b7463d7c0f89e45dd4416c';

const lf = (s) => s.replace(/\r\n/g, '\n');
const recordings = () => Object.fromEntries(readdirSync(FIXTURES).sort().map(n => [n, lf(readFileSync(join(FIXTURES, n), 'utf8'))]));
/** The data of each event named `name` in a recording. */
const eventData = (wire, name) => [...wire.matchAll(/^event:(.*)\ndata:(.*)$/gm)].filter(m => m[1] === name).map(m => JSON.parse(m[2]));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('EA-W1 the embedded agent-action.v2 and the wire recordings are the pinned ones', () => {
    assert.equal(AGENT_ACTION_VERSION, 'agent-action.v2');
    assert.equal(createHash('sha256').update(AGENT_ACTION_TEXT).digest('hex'), SCHEMA_HASH);
    const h = createHash('sha256');
    for (const [name, text] of Object.entries(recordings())) h.update(`${name}\n${text}\n`);
    assert.equal(h.digest('hex'), WIRE_HASH);
});

test('EA-W2 the schema and every recording are the backend\'s, byte for byte, when that repository is on this disk', { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' }, () => {
    assert.equal(AGENT_ACTION_TEXT, lf(readFileSync(join(BACKEND, 'main/resources/schemas/agent-action.v2.json'), 'utf8')));
    const files = recordings();
    const dir = join(BACKEND, 'test/resources/agent/wire');
    assert.deepEqual(Object.keys(files), readdirSync(dir).sort(), 'the same recordings on both sides');
    for (const [name, text] of Object.entries(files)) assert.equal(text, lf(readFileSync(join(dir, name), 'utf8')), name);
});

test('EA-W3 every recorded turn quotes this build\'s engine bundle, action contract and adapters, and the agent.v4 prompt, and names its calls in order', () => {
    for (const [name, text] of Object.entries(recordings())) {
        if (!name.endsWith('.sse')) continue;
        const [meta] = eventData(text, 'meta');
        assert.equal(meta.bundleHash, ENGINE_BUNDLE_HASH, `${name}: regenerate the recordings after the bundle changes`);
        assert.equal(meta.actionSchema, AGENT_ACTION_VERSION, name);
        assert.equal(meta.manifestHash, ADAPTER_MANIFEST_HASH, `${name}: regenerate the recordings after the manifest changes`);
        assert.equal(meta.promptVersion, 'agent.v4', name);
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
    const java = readFileSync('D:/orion-realms/wexy/wexy backend/forge-common/src/main/java/ai/wexy/common/AgentTurn.java', 'utf8');
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
