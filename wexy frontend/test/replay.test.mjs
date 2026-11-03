// A saved attempt replayed (11-02; loop/replay.ts): the castle attempt of 11-02 (dev/replays/castle.json, the bundle
// Developer view downloaded) sealed again by this host exactly as it was sealed live, and compiled on a device; and a
// file is never trusted: each way it can be wrong is refused in the developer's words. No GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { compileSaved, sealSaved } from '../src/loop/replay.ts';
import { createHash } from 'node:crypto';
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
    await refused(with_(f => { f.format = 'wexy-candidate-bundle.v1'; }), /^the file is wexy-candidate-bundle\.v1, not wexy-candidate-bundle\.v3 or wexy-candidate-bundle\.v2$/, 'another format');
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

/** The castle as a v3 bundle (Q113 (a), EA6.4): its reviews of the stage, `frames` JPEGs each, as the review panel bundles them. */
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function v3(sealedId, frames) {
    const f = castle();
    f.format = 'wexy-candidate-bundle.v3';
    const jpeg = (n, i) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, i]); return b; };
    const records = frames.map((sizes, r) => ({
        id: `review-${frames.length - r}`, candidate: r === 0 ? sealedId : 'e'.repeat(64), graph: 'x', gpu: 'a stand-in GPU', deviceGeneration: 1, attempt: f.attempt,
        tick: 240, seconds: 4, policy: 'ea6-capture.v2', status: 'ready', creator: r === 0 ? 'improve' : null, improvedTo: null,
        host: { detector: 'visual-host.v1', verdict: 'fail', findings: [{ code: 'EA_SCALE', message: '<img src=x onerror="globalThis.__ran__=1"> spans 468 units' }], gaps: [], notes: [] },
        model: r === 0 ? { verdict: 'fail', issues: [{ n: 1, kind: 'floating', severity: 'error', sentence: 'The castle floats.', scope: 'modules', modules: [] }], evidenceId: 'ev-9', generationId: 'gen-1', model: 'muse-spark-1.3', promptVersion: 'review.v1', costMicroUsd: 5660, sent: [] } : null,
        renderEvidenceId: 'ev-8', visualEvidenceIds: [], missing: [],
        frames: sizes.map((n, i) => {
            const b = n === null ? null : jpeg(n, i);
            return { id: `review-${frames.length - r}.v${i + 1}`, view: i ? 'side' : 'framed', describes: 'The castle.', width: 768, height: 432, sha256: b ? sha(b) : '0'.repeat(64),
                jpeg: b ? Buffer.from(b).toString('base64') : null };
        }),
    }));
    f.reviews = { records, jpegBytes: 0, bound: 600_000, omitted: [{ review: 'review-0', frame: 'review-0.v1', why: 'its bytes were dropped here' }] };
    return f;
}

test('EA-VR9b a v3 bundle replays what was judged: each JPEG shown only as the image its hash names, within the bound; v2 still replays', async () => {
    const plain = await sealSaved(CASTLE);
    assert.equal(plain.ok, true);
    assert.deepEqual([plain.replay.format, plain.replay.reviews, plain.replay.notes], ['wexy-candidate-bundle.v2', [], []], 'v2: no reviews, nothing said');
    const id = plain.replay.snapshot.id;
    const file = v3(id, [[200_000, 200_000], [150_000, 50_001], [1_000, null]]);
    // One frame tampered: its bytes are not the ones its hash names.
    file.reviews.records[2].frames[0].jpeg = Buffer.from(new Uint8Array(1_000).fill(7)).toString('base64');
    const r = await sealSaved(JSON.stringify(file));
    assert.equal(r.ok, true, r.reason);
    const reviews = r.replay.reviews;
    assert.deepEqual(reviews.map(x => [x.id, x.ofThis, x.frames.map(f => f.bytes?.length ?? null)]), [
        ['review-3', true, [200_000, 200_000]],
        // 400,000 held; 150,000 more is 550,000; then 50,001 would pass 600,000.
        ['review-2', false, [150_000, null]],
        ['review-1', false, [null, null]],
    ]);
    assert.deepEqual(r.replay.notes, [
        'review-2: review-2.v2 is past the bundle\'s 600000 JPEG bytes: not shown',
        'review-1: review-1.v1 is not the image its hash names: not shown',
        'review-0: review-0.v1 was left out when saved: its bytes were dropped here',
    ]);
    // What the host and the model said, kept as text: markup in it is never made into anything.
    assert.equal(reviews[0].host.findings[0].message, '<img src=x onerror="globalThis.__ran__=1"> spans 468 units');
    assert.deepEqual([reviews[0].model.model, reviews[0].model.issues[0].kind, reviews[0].creator], ['muse-spark-1.3', 'floating', 'improve']);
    assert.equal(globalThis.__ran__, undefined);
    // Not standard base64, or a frame with no hash: not shown, said.
    const odd = v3(id, [[100]]);
    odd.reviews.records[0].frames[0].jpeg = 'data:image/jpeg;base64,AAAA';
    const o = await sealSaved(JSON.stringify(odd));
    assert.deepEqual([o.replay.reviews[0].frames[0].bytes, o.replay.notes[0]], [null, 'review-1: review-1.v1 is not standard base64 with its hash: not shown']);
    // More reviews than a session keeps, more frames than a review carries: the rest left out, said.
    const many = v3(id, Array.from({ length: 17 }, () => [10, 10, 10]));
    const m = await sealSaved(JSON.stringify(many));
    assert.equal(m.replay.reviews.length, 16);
    assert.ok(m.replay.notes.includes('the file holds 17 reviews; the newest 16 are shown'));
    assert.ok(m.replay.notes.some(n => /: 3 frames; a review carries at most 2$/.test(n)));
    assert.ok(m.replay.reviews.every(x => x.frames.length === 2));
});
