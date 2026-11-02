// A saved attempt replayed (11-02; loop/replay.ts): the castle attempt of 11-02 (dev/replays/castle.json, the bundle
// Developer view downloaded) sealed again by this host exactly as it was sealed live, and compiled on a device; and a
// file is never trusted: each way it can be wrong is refused in the developer's words. No GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { compileSaved, sealSaved } from '../src/loop/replay.ts';
import { cleanDevice, live } from './exec-fakes.mjs';

const CASTLE = readFileSync(new URL('../dev/replays/castle.json', import.meta.url), 'utf8');
const castle = () => JSON.parse(CASTLE);

test('the castle replay: its program and bodies as the live attempt wrote them, sealed by this host; its pennants now draw unlit, so its X is new', async () => {
    const file = castle();
    const r = await sealSaved(CASTLE);
    assert.equal(r.ok, true, r.reason);
    const snap = r.replay.snapshot;
    assert.equal(snap.x.identity.programHash, file.programHash, 'the program the live attempt sealed');
    const hashes = list => list.map(b => `${b.module} ${b.codeHash}`).sort();
    assert.deepEqual(hashes(snap.bodies), hashes(file.modules), 'its bodies, byte for byte');
    // 11-02's fix: batchflag's emissive material takes no lights. Its rig stays named, and it draws unlit; the live
    // attempt's X bound the lights to it, which WebGPU refused at the probe's first frame. So X and id(C) are new.
    assert.notEqual(snap.x.hash, file.graph);
    assert.notEqual(snap.id, file.candidate);
    const op = id => snap.x.operations.find(o => o.id === id);
    assert.deepEqual([op('batchflag#create').args.lights, op('batchflag#create').args.shader.lights], ['sun', false]);
    assert.ok(!op('batchflag#draw').accesses.some(a => a.resource.startsWith('sun#')), 'its draw reads no lights');
    for (const lit of ['batchhill', 'batchstone', 'batchtower', 'batchroof']) assert.equal(op(`${lit}#create`).args.shader.lights, true, `${lit} stays lit`);
    assert.deepEqual(snap.checked.findings.filter(f => /takes no lights/.test(f.message)).map(f => [f.node, f.severity]), [['batchflag', 'warning']]);
    assert.equal(r.replay.attempt, file.attempt);
    assert.match(r.replay.prompt, /^A toon-shaded fairytale castle/);
    assert.deepEqual(snap.bodies.map(b => b.module), ['castlePlace', 'flagFlutter', 'flagPlace', 'sky']);
    const compiler = createDeviceCompiler(cleanDevice().device, { generation: () => 1, gpu: 'a fake device' });
    const compiled = await compileSaved(snap, compiler);
    assert.deepEqual(compiled.map(c => [c.module, c.ok, c.producedBy]), snap.bodies.map(b => [b.module, true, 'device']));
    assert.equal(compiler.provenance(snap, compiled), null, 'verdicts this device made, for these very bodies');
    // A live fixture (no format, no versions) replays too.
    const galaxy = await sealSaved(JSON.stringify(live('galaxy')));
    assert.equal(galaxy.ok, true, galaxy.reason);
});

test('a replay trusts nothing in the file: each fault is refused in the developer\'s words', async () => {
    const with_ = edit => { const f = castle(); edit(f); return JSON.stringify(f); };
    const refused = async (text, pattern, what) => {
        const r = await sealSaved(text);
        assert.equal(r.ok, false, what);
        assert.match(r.reason, pattern, what);
    };
    await refused('{', /^the file is not JSON: /, 'not JSON');
    await refused('[]', /^the file is not a saved attempt$/, 'not an object');
    await refused(with_(f => { f.format = 'wexy-candidate-bundle.v1'; }), /^the file is wexy-candidate-bundle\.v1, not wexy-candidate-bundle\.v2$/, 'another format');
    await refused(with_(f => { delete f.program; }), /^the file holds no program \(program\.nodes\)$/, 'no program');
    await refused(with_(f => { delete f.modules[0].interfaceHash; }), /^the file's modules are not each \{module, interfaceHash, body\}$/, 'a module without its interface');
    await refused(with_(f => { f.versions.manifest = '0'.repeat(64); }), /^it was written against another manifest \(000000000000…\); this build's is 3c7775588fb8…$/, 'another manifest');
    await refused(with_(f => { f.versions.abi = 'ea-abi.v1'; }), /^it was written against another abi \(ea-abi\.v1\); this build's is ea-abi\.v2$/, 'another ABI');
    await refused(with_(f => { f.modules[0].body = f.modules[0].body.replace('6.0', '7.0'); }),
        /^the host does not seal it: module castlePlace's body is not the text its codeHash names$/, 'a body edited, its hash not');
    await refused(with_(f => { f.modules[3].interfaceHash = 'f'.repeat(64); }), /^the host does not seal it: module sky's body was written for another interface$/, 'another interface');
    await refused(with_(f => { f.modules.pop(); }), /^the host does not seal it: module sky has no body$/, 'a module missing');
    await refused(with_(f => { f.program.nodes[0].adapterId = 'ng.render.odd'; }), /^its program does not resolve here: EA_/, 'a program this host cannot resolve');
});
