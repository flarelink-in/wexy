// EA9-U7 (EA9.3; agent-first-studio-design.md §8, I3): one world on the stage. active-world.ts's install over a fake
// studio port and the stage's real memory ledger: each kind replacing each, in the order §8 sets (the switch, the new world
// published, then the old one retired), the old world retired exactly once, the ledger holding exactly the new world's
// reservation after, a teardown's error said and the new world kept. No browser, no GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createMemoryLedger } from '../src/exec/gate.ts';
import { account, EMPTY, install, retire, uncounted } from '../src/shell/studio/active-world.ts';

/** A fake studio: every commit, publish and destroy logged in order; a world marked `throws` refuses to be destroyed. */
function studio() {
    const log = [];
    const port = {
        commit: next => log.push(`commit ${next.kind}`),
        publish: next => log.push(`publish ${next.kind}`),
        destroy: old => {
            log.push(`destroy ${old.kind}`);
            if (old[old.kind]?.throws) throw new Error('the old world would not let go');
        },
    };
    return { log, port };
}

test('EA9-U7 one world on the stage: each kind replaces each in §8\'s order, the old one retired once after the switch, the ledger holding the new one alone', () => {
    const ledger = createMemoryLedger();
    const { log, port } = studio();
    const world = (kind, label, bytes, extra = {}) => ({ kind, [kind]: { label, ...extra }, held: ledger.record(label, bytes) });
    const labels = () => ledger.holders().map(h => h.label);

    // The empty stage, then the backdrop (counted the moment it is mounted, §8 step 2), then h1's world over it.
    let h = EMPTY;
    const backdrop = world('backdrop', 'backdrop: blackhole', 4_000);
    ({ world: h } = install(h, backdrop, port));
    assert.deepEqual(log.splice(0), ['commit backdrop', 'publish backdrop'], 'nothing to retire on an empty stage');
    assert.deepEqual(labels(), ['backdrop: blackhole']);
    const legacy = world('legacy', 'head: Spiral Galaxy', 9_000);
    ({ world: h } = install(h, legacy, port));
    assert.deepEqual(log.splice(0), ['commit legacy', 'publish legacy', 'destroy backdrop'], 'the switch, then the new world, then the old one retired');
    assert.deepEqual(labels(), ['head: Spiral Galaxy'], 'the backdrop\'s reservation returned with it');

    // An agent world over h1's: its Run made the switch already, so no second commit (§8 step 1).
    const { commit, ...afterRun } = port;
    const agent = world('agent', 'candidate a', 7_000);
    let errors;
    ({ world: h, errors } = install(h, agent, afterRun));
    assert.deepEqual([log.splice(0), errors], [['publish agent', 'destroy legacy'], []]);
    assert.deepEqual(labels(), ['candidate a']);

    // An agent world over an agent world whose destroy throws: the new one stays, the old reservation returned once, the
    // error said.
    const stubborn = world('agent', 'candidate b', 5_000, { throws: true });
    ({ world: h } = install(h, stubborn, afterRun));
    const next = world('agent', 'candidate c', 6_000);
    ({ world: h, errors } = install(h, next, afterRun));
    assert.equal(h, next);
    assert.deepEqual(errors, ['EA_RELEASE agent: the old world would not let go; the new world stays installed']);
    assert.deepEqual(labels(), ['candidate c'], 'returned although its destroy threw');
    assert.equal(stubborn.held.released, true);

    // Back to h1's world, then a replacement of the same kind; then the world on the stage asked to replace itself.
    const legacy2 = world('legacy', 'head: Thunderhead', 8_000);
    ({ world: h } = install(h, legacy2, port));
    assert.deepEqual(log.splice(-3), ['commit legacy', 'publish legacy', 'destroy agent']);
    const legacy3 = world('legacy', 'head: Black Hole', 8_500);
    ({ world: h } = install(h, legacy3, port));
    assert.deepEqual(labels(), ['head: Black Hole']);
    log.length = 0;
    const self = install(h, h, port);
    assert.deepEqual([self.world, self.errors, log], [legacy3, ['EA_INSTALL the world on the stage cannot replace itself'], []], 'nothing switched, nothing retired');
    assert.deepEqual(labels(), ['head: Black Hole']);

    // A retirement is once: a second retire of the same world returns nothing more (the ledger's release is idempotent),
    // and an empty stage retires nothing.
    retire(legacy2, port);
    assert.deepEqual(labels(), ['head: Black Hole']);
    assert.deepEqual(retire(EMPTY, port), []);
    assert.equal(ledger.held(), 8_500, 'exactly the world on the stage');
});

test('EA9-U7 the ledger counts what the stage holds (§8 step 2): a world built before the stage, counted once both exist; no admission beside one not counted yet', () => {
    const ledger = createMemoryLedger();
    const record = (label, bytes) => ledger.record(label, bytes);
    const { log, port } = studio();
    const { commit, ...afterRun } = port;

    // The backdrop, mounted while it builds: nothing to count yet, and no candidate admitted beside it.
    const building = { kind: 'backdrop', backdrop: { id: 'kerr-black-hole' }, held: null };
    assert.equal(account(building, null, record, 'backdrop: kerr-black-hole'), building, 'not built: as it was');
    assert.equal(uncounted(building), true);
    // On the viewport before the stage exists: no ledger to count it in.
    assert.equal(account(building, 4_000, null, 'backdrop: kerr-black-hole'), building);
    // Both exist: counted, once, the same backdrop.
    const counted = account(building, 4_000, record, 'backdrop: kerr-black-hole');
    assert.deepEqual([counted.kind, counted.backdrop, uncounted(counted)], ['backdrop', building.backdrop, false]);
    assert.equal(account(counted, 4_000, record, 'backdrop: kerr-black-hole'), counted, 'counted once');
    assert.deepEqual(ledger.holders(), [{ label: 'backdrop: kerr-black-hole', bytes: 4_000 }]);

    // A candidate admitted beside it, then installed by its Run: the backdrop retired, the ledger holding the new Head alone.
    const candidate = ledger.reserve('candidate a', 7_000);
    assert.equal(ledger.held(), 11_000, 'admitted beside the backdrop, both counted');
    const agent = { kind: 'agent', agent: { label: 'a' }, held: candidate };
    const { world: h, errors } = install(counted, agent, afterRun);
    assert.deepEqual([h, errors, log.splice(0)], [agent, [], ['publish agent', 'destroy backdrop']]);
    assert.deepEqual(ledger.holders(), [{ label: 'candidate a', bytes: 7_000 }]);
    // An agent world holds its Run's reservation already: nothing more is counted.
    assert.equal(account(agent, 1, record, 'x'), agent);

    // h1's Head built before the stage: counted the same way; the empty stage holds nothing and is never uncounted.
    const head = account({ kind: 'legacy', legacy: {}, held: null }, 9_000, record, 'head: Spiral Galaxy');
    assert.deepEqual([uncounted(head), head.held.bytes], [false, 9_000]);
    assert.deepEqual([account(EMPTY, 1, record, 'x'), uncounted(EMPTY)], [EMPTY, false]);
});

test('EA9-U7 (EA9.3\'s review) a world that grows is counted again before an admission reads it: the backdrop built, resized, then a candidate', () => {
    // The review's case, in its units: the backdrop counted at 100; its canvas grows, and it may hold 500; a candidate of
    // 600 against a budget of 1,000. Before the fix the count stayed 100 and the candidate was admitted (700 counted, 1,100
    // held).
    const ledger = createMemoryLedger(1_000);
    const record = (label, bytes) => ledger.record(label, bytes);
    const built = account({ kind: 'backdrop', backdrop: { id: 'kerr-black-hole' }, held: null }, 100, record, 'backdrop: kerr-black-hole');
    assert.deepEqual(ledger.holders(), [{ label: 'backdrop: kerr-black-hole', bytes: 100 }]);
    const grown = account(built, 500, record, 'backdrop: kerr-black-hole');
    assert.notEqual(grown, built, 'counted again');
    assert.deepEqual(ledger.holders(), [{ label: 'backdrop: kerr-black-hole', bytes: 500 }], 'the larger count alone: the old one returned');
    assert.equal(built.held.released, true);
    assert.equal(typeof ledger.reserve('candidate a', 600), 'string', 'refused: 500 and 600 are past 1,000');
    // A count that covers what it may hold stays: smaller again, nothing is counted twice or below it.
    assert.equal(account(grown, 300, record, 'backdrop: kerr-black-hole'), grown);
    assert.equal(account(grown, 500, record, 'backdrop: kerr-black-hole'), grown);
    // h1's Head the same way; an agent world's reservation is its Run's, sized at its envelope.
    const head = account(account({ kind: 'legacy', legacy: {}, held: null }, 200, record, 'head: Spiral Galaxy'), 250, record, 'head: Spiral Galaxy');
    assert.deepEqual([head.held.bytes, ledger.held()], [250, 750]);
    const agent = { kind: 'agent', agent: {}, held: ledger.record('candidate b', 10) };
    assert.equal(account(agent, 999, record, 'x'), agent);
});

test('EA9-U7 (EA9.3\'s review) a throw in the handover never undoes a switch: a commit that throws keeps the old world; a publication that throws still retires it', () => {
    const ledger = createMemoryLedger();
    const world = (kind, label, bytes) => ({ kind, [kind]: { label }, held: ledger.record(label, bytes) });
    const labels = () => ledger.holders().map(h => h.label);
    const log = [];
    const port = (fails = {}) => ({
        commit: next => { log.push(`commit ${next[next.kind].label}`); if (fails.commit) throw new Error('the viewport refused'); },
        publish: next => { log.push(`publish ${next[next.kind].label}`); if (fails.publish) throw new Error('the HUD threw'); },
        destroy: old => log.push(`destroy ${old[old.kind].label}`),
    });

    // The publication throws once the new world is committed: it is on the stage, said, and the old one retired once.
    const old = world('legacy', 'head: Spiral Galaxy', 9_000);
    const next = world('agent', 'candidate a', 7_000);
    const published = install(old, next, port({ publish: true }));
    assert.equal(published.world, next, 'the new world is the one on the stage');
    assert.deepEqual(log.splice(0), ['commit candidate a', 'publish candidate a', 'destroy head: Spiral Galaxy']);
    assert.deepEqual(published.errors, ['EA_PUBLISH agent: the HUD threw; it is on the stage, and the old world is retired']);
    assert.deepEqual([labels(), old.held.released], [['candidate a'], true], 'the ledger holds the new world alone');

    // The commit throws: nothing switched. The old world stays, untouched; the new one, never shown, is let go.
    const third = world('legacy', 'head: Thunderhead', 8_000);
    const refused = install(next, third, port({ commit: true }));
    assert.equal(refused.world, next, 'the world on the stage stays');
    assert.deepEqual(log.splice(0), ['commit head: Thunderhead', 'destroy head: Thunderhead'], 'not published; the old world not destroyed');
    assert.deepEqual(refused.errors, ['EA_COMMIT legacy: the viewport refused; the world on the stage stays']);
    assert.deepEqual([labels(), next.held.released, third.held.released], [['candidate a'], false, true]);
});

test('EA9-U7 (EA9.3\'s review) a scene runtime says what it would hold at a larger canvas: its post chain scales with the pixels, the rest does not, never below now', async () => {
    const { SceneRuntime } = await import('../src/runtime/scene-runtime.ts');
    let post = 8_000;
    const runtime = Object.assign(Object.create(SceneRuntime.prototype), {
        count: 100, paramsBuffer: { size: 256 }, simBuffer: { size: 64 }, pixels: 1_000,
        post: { chain: { memoryReport: () => ({ bytes: post }), resize() {}, getPassSequence: () => [] } },
        camera: { updateProjection() {} }, pass: {},
    });
    const fixed = runtime.deviceBytes - post;
    assert.equal(runtime.deviceBytesAt(4_000), fixed + 32_000, 'four times the pixels, four times the post chain');
    assert.equal(runtime.deviceBytesAt(500), fixed + 8_000, 'never below what it holds now');
    // A resize moves the size its post chain is reckoned from.
    runtime.resize(100, 40);
    post = 32_000;
    assert.equal(runtime.deviceBytesAt(4_000), fixed + 32_000);
    assert.equal(runtime.deviceBytesAt(8_000), fixed + 64_000);
    // Rounded up: 10 bytes at 3 pixels are 13⅓ at 4, counted as 14.
    runtime.resize(3, 1);
    post = 10;
    assert.equal(runtime.deviceBytesAt(4), fixed + 14);
});

test('EA9-U7 the studio\'s wiring: H is the one world field, set only by put and count; a Run waits for an uncounted world; the backdrop on either path', () => {
    const main = readFileSync(new URL('../src/shell/studio/main.ts', import.meta.url), 'utf8');
    // No field of another world beside H: runtime, spec, agentWorld and backdrop are H's getters.
    assert.doesNotMatch(main, /this\.(runtime|spec|agentWorld|backdrop|headReservation|retire)\s*=[^=]/, 'no field set beside H');
    for (const name of ['runtime', 'spec', 'agentWorld', 'backdrop']) assert.match(main, new RegExp(`private get ${name}\\(\\)`), `${name} reads H`);
    // H is set by put (inside install's handover) and by count alone.
    const writes = [...main.matchAll(/this\.world = /g)].length;
    assert.equal(writes, 2, 'two writers of H: put\'s publish and count');
    assert.match(main, /publish: w => \{\n\s+this\.world = w;/);
    assert.match(main, /this\.world = accountWorld\(/);
    // Every world reaches the stage through put: h1's install, the agent's, the backdrop and its failure.
    assert.match(main, /this\.put\(\{ kind: 'legacy'/);
    assert.match(main, /this\.put\(\{ kind: 'agent'/);
    assert.match(main, /this\.put\(\{ kind: 'backdrop'/);
    assert.match(main, /this\.put\(EMPTY,/);
    // The ledger: H counted when the stage is made and when the backdrop reaches the viewport; no Run beside an uncounted H.
    assert.match(main, /this\.stage = stages\.createStage\(\{[\s\S]*?\}\);\n[\s\S]{0,200}this\.count\(\);/);
    assert.match(main, /On the viewport: counted from now[^\n]*\n\s+this\.count\(\);\n\s+this\.refreshRun\(\);/);
    assert.match(main, /if \(uncounted\(this\.world\)\) return /);
    // The backdrop on either path (EA9.3), ?backdrop=off keeping the still stage.
    assert.match(main, /if \(backdrop !== 'off'\) this\.mountBackdrop\(vp, backdrop\);/);
    // EA9.3's reviews: H counted at the largest canvas the viewport ever gives a world, its live cap, whatever the
    // display or the page's zoom; and again after every resize of it.
    assert.match(main, /if \(path\.agentPath\) vp\.onRuntimeResized = \(\) => this\.count\(\);/);
    assert.match(main, /\[w\.legacy\.runtime\.deviceBytesAt\(MAX_LIVE_PIXELS\), w\.legacy\.runtime\.deviceBytes, /);
    assert.match(main, /\[w\.backdrop\.bytes\(MAX_LIVE_PIXELS\), w\.backdrop\.bytes\(0\), /);
    assert.match(main, /ledger\.record\(`head: \$\{spec\.title\}`, runtime\.deviceBytesAt\(MAX_LIVE_PIXELS\)\)/);
    assert.doesNotMatch(main, /deviceBytes\)(?! \?\?)|liveBound|displayTarget\?\./, 'no Head counted at its size now alone, nor at the display\'s');
    const backdrop = readFileSync(new URL('../src/shell/studio/backdrop.ts', import.meta.url), 'utf8');
    assert.match(backdrop, /bytes: pixels => world\?\.deviceBytesAt\(pixels\) \?\? null,/, 'the backdrop counted at the size asked');
    // ... no step after a switch makes an installed Run a failure, and H is set before any of them.
    const run = main.slice(main.indexOf('private async runCandidate('), main.indexOf('// ------------------------------------------------------------------ the world on the stage'));
    assert.match(run, /const r = await stage\.run\(snapshot, compiled\);\n\s+if \(r\.status === 'installed'\) \{\n(?:\s+\/\/[^\n]*\n)*\s+const notes = this\.installAgent\(/, 'nothing between the commit and H');
    assert.match(run, /this\.afterSwitch\('the controls that offer a Run', \(\) => this\.refreshRun\(\)\)/);
    assert.match(run, /this\.afterSwitch\('the Run\\'s numbers', \(\) => \{ said = \[runNumbers\(r\.report\)/);
    assert.match(run, /this\.afterSwitch\('the Run\\'s line', \(\) => step\.ok\(/);
    assert.match(run, /this\.afterSwitch\('the replaced creation', \(\) => this\.creation\?\.replaced\(\)\)/);
    assert.match(run, /this\.afterSwitch\('its review', \(\) => this\.reviews\?\.installed\(this\.stageWorld\(\)\)\)/);
    assert.doesNotMatch(run, /^\s+this\.reviews\?\.installed\(/m);
    // h1's install says whether it switched, and its callers stop when it did not.
    assert.match(main, /if \(this\.runtime !== runtime\) return false;/);
    assert.match(main, /if \(!this\.install\(world, spec, false, client\.source\)\) \{\n[^\n]*\n\s+this\.journey\.fail\('check', COPY\.failures\.internal\);/);
    assert.match(main, /if \(!this\.install\(result\.world, result\.spec, sameScene, this\.draftSource\)\) this\.showMessage\(COPY\.editFailed, 'error'\);/);
    // The Controls panel by H's kind after an h1 build that brought no world.
    assert.match(main, /else if \(this\.agentWorld\) this\.director\.note\(this\.agentControlsNote\(\)\);\n\s+else this\.director\.clear\(\);/);
    assert.match(main, /this\.director\.note\(this\.agentControlsNote\(\)\);\n\s+this\.exportBtn\.disabled = false;/, 'publishAgent says the same');
    // A film waits for an example's build; h1's Create and hot-swap wait for a Run, as a Run waits for them.
    assert.match(main, /if \(this\.stage\?\.busy \|\| this\.busy\) return;\n\s+const world = this\.agentWorld;/);
    assert.equal([...main.matchAll(/\n\s+if \(this\.stage\?\.busy\) return;\n/g)].length >= 3, true, 'forge, hotSwap and the photo');
    assert.match(main, /this\.forgeBtn\.disabled = this\.busy \|\| !this\.viewport \|\| !!this\.accountControl\?\.changing \|\| !!this\.stage\?\.busy;/);
});

test('EA9-U7 (EA9.3\'s reviews) the viewport never gives a world a canvas past its live cap, its first canvas included: what the ledger counts a Head at', async () => {
    const { liveSize, MAX_LIVE_PIXELS } = await import('../src/runtime/viewport.ts');
    // A box within the cap: its pixels at min(DPR, 1.5), rounded.
    assert.deepEqual(liveSize(390, 844, 3), { width: 585, height: 1266 });
    assert.deepEqual(liveSize(1422, 748, 1), { width: 1422, height: 748 });
    // Past it: scaled to it and rounded down, its shape kept, whatever the window.
    for (const [w, h, dpr, scale] of [[2844, 1496, 1, 1], [3840, 2160, 1.5, 1], [7680, 4320, 2, 1], [2844, 1496, 1, 0.75], [100_000, 3, 1, 1]]) {
        const s = liveSize(w, h, dpr, scale);
        assert.ok(s.width * s.height <= MAX_LIVE_PIXELS, `${w}×${h} at ${dpr}: ${s.width}×${s.height} past the cap`);
        assert.ok(s.width >= 2 && s.height >= 2);
    }
    const big = liveSize(2844, 1496, 1);
    assert.ok(Math.abs(big.width / big.height - 2844 / 1496) < 0.01, 'its shape kept');
    assert.ok(big.width * big.height > MAX_LIVE_PIXELS - big.width - big.height, 'within a row and a column of the cap');
    // The first canvas is sized so too (the review: it was its box at the ratio, uncapped, until the first frame).
    const viewport = readFileSync(new URL('../src/runtime/viewport.ts', import.meta.url), 'utf8');
    assert.match(viewport, /const first = liveSize\(rect\.width, rect\.height, devicePixelRatio\);\n\s+canvas\.width = first\.width;\n\s+canvas\.height = first\.height;/);
    assert.match(viewport, /const \{ width: w, height: h \} = liveSize\(rect\.width, rect\.height, devicePixelRatio, this\.stats\.scale\);/);
});

test('EA9-U7 (EA9.3\'s review) the viewport says when it resized the world on it, once a size is set, and a listener\'s throw stays its own', async () => {
    globalThis.requestAnimationFrame ??= () => 1;
    globalThis.cancelAnimationFrame ??= () => {};
    const { Viewport } = await import('../src/runtime/viewport.ts');
    const resized = [];
    const runtime = { resize: (w, h) => resized.push(`runtime ${w}×${h}`) };
    const vp = Object.assign(Object.create(Viewport.prototype), {
        canvas: { width: 0, height: 0 }, engine: { width: 0, height: 0, resize(w, h) { this.width = w; this.height = h; } },
        stats: { width: 0, height: 0 }, runtime, runtimeSize: null,
    });
    vp.onRuntimeResized = () => resized.push('told');
    vp.resizeTo(800, 600);
    assert.deepEqual(resized.splice(0), ['runtime 800×600', 'told'], 'told after the world was resized');
    vp.resizeTo(800, 600);
    assert.deepEqual(resized, [], 'nothing changed, nothing said');
    const error = console.error;
    const said = [];
    console.error = (...args) => { said.push(args); };
    try {
        vp.onRuntimeResized = () => { throw new Error('a listener\'s fault'); };
        vp.resizeTo(1024, 768);
        assert.deepEqual([resized, said.length, vp.canvas.width], [['runtime 1024×768'], 1, 1024], 'resized as ever, the throw said');
    } finally {
        console.error = error;
    }
});
