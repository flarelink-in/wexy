// EA-W8 to W10, headless (EA4.2; candidate-loop-design.md §5, §6): the module route's recorded wire and its pins, the
// browser's half of the contract. The backend's ModuleRoutesTest records each way a module call ends; the copies under
// fixtures/module-wire are its, byte for byte, and they show what the browser will hold a module stream to (EA4.3's
// reader): meta names this build's versions and echoes one job; the body is the deltas, and done names its hash; a
// failure is one error, never done. No backend runs, no GPU, no call.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BODY_CHECKER, BODY_DIAL, checkBody } from '../src/contract/adapters/bodies.ts';
import { ADAPTER_MANIFEST_HASH } from '../src/contract/adapters/index.ts';
import { ABI_VERSION, deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { AGENT_ACTION_VERSION } from '../src/contract/agent/index.ts';
import { unfence } from '../src/contract/unfence.ts';
import { ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';

const BACKEND = 'D:/orion-realms/wexy/wexy backend/forge-service/src';
const FIXTURES = fileURLToPath(new URL('./fixtures/module-wire/', import.meta.url));
const lf = (s) => s.replace(/\r\n/g, '\n');
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const recordings = () => Object.fromEntries(readdirSync(FIXTURES).sort().map(n => [n, lf(readFileSync(join(FIXTURES, n), 'utf8'))]));
const events = (wire) => [...wire.matchAll(/^event:(.*)\ndata:(.*)$/gm)].map(m => ({ name: m[1], data: JSON.parse(m[2]) }));
/** The mock program the backend answers turns with: its `place` stage's interface, as this build derives it. */
async function place() {
    const program = JSON.parse(readFileSync(join(BACKEND, 'main/resources/mock/agent/program.json'), 'utf8')).program;
    const r = await resolveProgram(program.nodes);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const d = await deriveInterfaces(r.graph);
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    return { x: r.graph, iface: d.interfaces.find(i => i.module === 'place') };
}
const onDisk = { skip: !existsSync(BACKEND) && 'the backend repository is not on this disk' };

test('EA-W8 the module recordings are the backend\'s byte for byte; its pins, and its fixture of the place interface, are this build\'s', onDisk, async () => {
    const dir = join(BACKEND, 'test/resources/agent/module-wire');
    const files = recordings();
    assert.deepEqual(Object.keys(files), readdirSync(dir).sort(), 'the same recordings on both sides');
    for (const [name, text] of Object.entries(files)) assert.equal(text, lf(readFileSync(join(dir, name), 'utf8')), `${name}: copy it again from ${dir}`);
    // The pins the server holds a request to are this build's: the ABI, the checker, a body's characters.
    const java = readFileSync(join(BACKEND, 'main/java/ai/wexy/forge/agent/ModuleRequest.java'), 'utf8');
    assert.equal(/String ABI = "([^"]+)";/.exec(java)?.[1], ABI_VERSION);
    assert.equal(/String CHECKER = "([^"]+)";/.exec(java)?.[1], BODY_CHECKER);
    assert.equal(Number(/MAX_BODY_CHARS = ([\d_]+);/.exec(java)?.[1].replace(/_/g, '')), BODY_DIAL.maxChars);
    // The backend's tests send the interface this build derives: a changed ABI or resolver leaves no stale fixture.
    const { x, iface } = await place();
    const fixture = JSON.parse(readFileSync(join(BACKEND, 'test/resources/agent/module/place.json'), 'utf8'));
    assert.deepEqual([fixture.graph, fixture.programHash], [x.hash, x.identity.programHash], 'regenerate the backend\'s place.json');
    const { node, consumers, paths, kind, module, ...wire } = iface;
    assert.deepEqual(fixture.interface, { ...wire, entries: iface.entries.map(({ path, ...e }) => e) });
});

test('EA-W9 each recorded call names this build\'s versions and echoes one job; a done names the hash of exactly the body its deltas carry', async () => {
    const versions = { bundle: ENGINE_BUNDLE_HASH, actionSchema: AGENT_ACTION_VERSION, manifest: ADAPTER_MANIFEST_HASH, abi: ABI_VERSION, checker: BODY_CHECKER };
    const ended = {};
    for (const [name, text] of Object.entries(recordings())) {
        if (!name.endsWith('.sse')) continue;
        const list = events(text);
        const [meta] = list;
        assert.equal(meta.name, 'meta', name);
        assert.deepEqual(meta.data.versions, versions, `${name}: rewrite the backend's recordings after a version changes`);
        assert.deepEqual([meta.data.subject.module, meta.data.subject.interfaceHash], [meta.data.module, meta.data.interfaceHash], name);
        assert.equal(meta.data.role, 'module', name);
        const terminal = list.filter(e => e.name === 'done' || e.name === 'error');
        assert.equal(terminal.length, 1, `${name}: exactly one done or error`);
        assert.equal(list.at(-1), terminal[0], `${name}: and it is last`);
        ended[name] = terminal[0].name;
        if (terminal[0].name === 'done') {
            const body = unfence(list.filter(e => e.name === 'delta').map(e => e.data.text).join(''));
            assert.deepEqual([sha(body), body.length], [terminal[0].data.answerSha256, terminal[0].data.answerChars], `${name}: the body is the deltas, whole`);
        }
    }
    assert.deepEqual(ended, { 'author.sse': 'done', 'error-empty.sse': 'error', 'error-length.sse': 'error', 'repair.sse': 'done' });
    assert.deepEqual(JSON.parse(recordings()['denied.json']), { code: 'budget', message: 'Live creation has reached its spending limit for now.' });
});

test('EA-W10 the mock\'s bodies against this build\'s checker: its fault fails at the finding the backend quotes, and its fix passes', onDisk, async () => {
    const { iface } = await place();
    const fault = readFileSync(join(BACKEND, 'main/resources/mock/modules/place.fault.wgsl'), 'utf8').trim();
    const failed = await checkBody(iface, fault);
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.findings.filter(f => f.severity === 'error').map(f => [f.code, f.line]), [['call', 6]]);
    // The repair recording quotes that very finding to the model, and the body it brings back passes.
    const repair = events(recordings()['repair.sse']);
    assert.equal(repair[0].data.subject.codeHash, sha(fault.replace(/\r\n?/g, '\n')));
    const fixed = await checkBody(iface, unfence(repair.filter(e => e.name === 'delta').map(e => e.data.text).join('')));
    assert.deepEqual(fixed.findings, []);
    assert.equal(fixed.ok, true);
});
