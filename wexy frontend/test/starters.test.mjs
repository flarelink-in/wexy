// EA9-U11 (EA9.4; agent-first-studio-design.md §9 and §10; Q122 (a), the user, 2026-11-04: "all three, h1's kept too"):
// each starter shipped with the page (public/worlds/<id>.json) seals under this build to the id(C) and X hash recorded for
// it (test/fixtures/starters.json, written by dev/starters.mjs), as test/replay.test.mjs holds the castle; compiles on a
// device; holds nothing but what a replay reads; and is titled for the creator. No GPU, no model, no backend.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDeviceCompiler } from '../src/exec/device-compiler.ts';
import { TITLE_CHARS } from '../src/loop/creation.ts';
import { compileSaved, sealSaved } from '../src/loop/replay.ts';
import { STARTER_ID, STARTER_WORLDS, starterFile } from '../src/shell/studio/starters.ts';
import { cleanDevice } from './exec-fakes.mjs';

const ROOT = new URL('../', import.meta.url);
const PINS = JSON.parse(readFileSync(new URL('test/fixtures/starters.json', ROOT), 'utf8')).starters;
const fileOf = id => readFileSync(new URL(`public${starterFile(id)}`, ROOT), 'utf8');

test('EA9-U11 each shipped starter reseals under this build to its recorded id(C) and X hash, and compiles on a device', async () => {
    const shipped = readdirSync(new URL('public/worlds/', ROOT)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(shipped, STARTER_WORLDS.map(s => s.id).sort(), 'public/worlds holds exactly the starters the studio lists');
    assert.deepEqual(Object.keys(PINS).sort(), shipped, 'every starter is pinned');
    assert.ok(STARTER_WORLDS.length >= 3, 'three that looked right on both GPUs (Q122 (a))');
    for (const starter of STARTER_WORLDS) {
        const text = fileOf(starter.id);
        const pin = PINS[starter.id];
        assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), pin.sha256, `${starter.id}: the file is the bytes recorded (re-record with dev/starters.mjs, never by hand)`);
        const sealed = await sealSaved(text);
        assert.equal(sealed.ok, true, `${starter.id}: ${sealed.reason}`);
        const s = sealed.replay.snapshot;
        // A starter opens on its line's kernel for good (render-kernels §9.3): since KR0 nothing the model reads moves it.
        const moved = `${starter.id} seals to another X or id(C) than recorded, so a change reached ea.v1's kernel, which is released and frozen `
            + '(render-kernels Q141 (b)): undo it, or build it as the next line once ea.v1 is sealed (§8.1). Re-recording a starter '
            + '(dev/starters.mjs record) is a choice, to show a new line off, never the way to make this pass';
        assert.equal(s.x.hash, pin.x, moved);
        assert.equal(s.id, pin.candidate, moved);
        assert.deepEqual(s.bodies.map(b => b.module), pin.modules);
        const compiler = createDeviceCompiler(cleanDevice().device, { generation: () => 1, gpu: 'a fake device' });
        const compiled = await compileSaved(s, compiler);
        assert.deepEqual(compiled.map(c => [c.module, c.ok, c.producedBy]), s.bodies.map(b => [b.module, true, 'device']), `${starter.id}: every body compiles on the device`);
        assert.equal(compiler.provenance(s, compiled), null, `${starter.id}: verdicts this device made, for these very bodies`);
    }
});

test('EA9-U11 a starter\'s file holds only what a replay reads: this build\'s versions, its idea, its program and bodies; no call, charge, model or review', () => {
    for (const starter of STARTER_WORLDS) {
        const file = JSON.parse(fileOf(starter.id));
        assert.deepEqual(Object.keys(file).sort(), ['attempt', 'modules', 'note', 'program', 'request', 'versions'], starter.id);
        // The files of 11-05 name no line; one recorded since KR0 names its line beside them (render-kernels §9.3).
        const versions = Object.keys(file.versions).sort().join();
        assert.ok(['abi,bundle,checker,manifest', 'abi,bundle,checker,line,manifest'].includes(versions), `${starter.id}: versions ${versions}`);
        assert.deepEqual(Object.keys(file.request).sort(), ['prompt', 'seconds', 'style'], starter.id);
        for (const m of file.modules) assert.deepEqual(Object.keys(m).sort(), ['body', 'codeHash', 'interfaceHash', 'module'], `${starter.id} ${m.module}`);
        assert.ok(!/costMicroUsd|generationId|muse-|"calls"|"evidence"|"reviews"/.test(fileOf(starter.id)), `${starter.id}: no call, charge or review`);
    }
});

test('EA9-U11 a starter as the creator meets it: its id a file name, its label short, its title within a title\'s bound; none named after a game', async () => {
    for (const starter of STARTER_WORLDS) {
        assert.match(starter.id, STARTER_ID);
        assert.ok(starter.label.length <= 16 && starter.label.trim() === starter.label, starter.label);
        assert.ok([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(starter.title)].length <= TITLE_CHARS, starter.title);
        assert.ok(!/minecraft|mine ?craft/i.test(`${starter.label} ${starter.title}`), 'a world is described, never named after a game');
    }
    // A file that names no line and whose manifest no line accepts is refused (KR0, render-kernels §9.3): never opened
    // under the newest line.
    const castle = JSON.parse(fileOf('castle'));
    castle.versions.manifest = '0'.repeat(64);
    const refused = await sealSaved(JSON.stringify(castle));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /^KR_LEGACY_ROUTE: 0 matches for 000000000000…\//);
});

// The studio's EA9.4 wiring, which only a browser runs (dev/ea9-e1.mjs): read from main.ts, as EA9-U7 reads its own.
const MAIN = readFileSync(new URL('src/shell/studio/main.ts', ROOT), 'utf8');
function methodOf(signature) {
    const at = MAIN.indexOf(signature);
    assert.ok(at >= 0, `main.ts has ${signature}`);
    return MAIN.slice(at, MAIN.indexOf('\n    }\n', at));
}

test('EA9.4 wiring: the starters\' chips on the agent path come first, h1\'s examples after but its galaxy; a chip\'s press is the go, through the same Run, From the archive', () => {
    const chips = methodOf('private starterChips(');
    assert.match(chips, /const made = agent \? STARTER_WORLDS\.map\(/);
    assert.match(chips, /STARTERS\.filter\(s => !agent \|\| s\.id !== 'galaxy'\)/);
    assert.match(chips, /return \[\.\.\.made, \.\.\.examples\];/, 'the worlds Meta\'s models made first');
    assert.match(chips, /dataset: \{ source: 'archive', starter: s\.id \}/);
    assert.match(chips, /if \(e\.detail > 1\) return;\s*void this\.openStarter\(s\);/, 'a double click is one press');
    // Beside the idea only: none over the empty stage (11-04's presets, master's navigation test), on either path.
    assert.match(methodOf('private mountLeft()'), /h\('div', \{ class: 'examples-chips' \}, this\.starterChips\(\)\)/);
    assert.doesNotMatch(methodOf('private mountEmpty()'), /starterChips|STARTERS|chip-lg/);
    // h1's examples are the Playground's: their press selects it (master's mode switch), the agent starters' does not.
    assert.match(methodOf('private starter('), /this\.playground = true;/);
    assert.doesNotMatch(methodOf('private async openStarter('), /this\.playground/);
    const press = methodOf('private async openStarter(');
    // Never with no WebGPU or after a device loss (EA9.4's review); on its way, the world on the stage takes no paid change.
    assert.match(press, /if \(this\.noWebGpu \|\| this\.deviceLostNow\) return;/);
    assert.match(press, /this\.starterOpening = load;[\s\S]*finally \{\s*if \(this\.starterOpening === load\) \{\s*this\.starterOpening = null;/);
    const open = methodOf('private async openingStarter(');
    assert.match(open, /const current = \(\) => load === this\.starterLoads && !this\.deviceLostNow;/, 'a device lost meanwhile keeps its own sentence');
    // Read, sealed by this host, compiled on this device: never trusted as sent (I2), and no backend or model is reached.
    assert.match(open, /const \{ sealSaved, compileSaved \} = await import\('\.\.\/\.\.\/loop\/replay'\);/);
    assert.match(open, /if \(refused\.length\) throw/);
    assert.match(open, /this\.runCandidate\(opened\.snapshot, opened\.compiled, \{ kind: 'starter', title: starter\.title, keyframes: \[\] \}\)/);
    assert.doesNotMatch(open, /this\.forge\(|\/v1\/|createAgentClient|createModuleClient/, 'no h1 route, no model');
    // Its title and source: the starter's, From the archive; nobody's to save.
    const run = methodOf('private async runCandidate(');
    assert.match(run, /origin\.kind === 'starter' \? origin\.title : null/);
    assert.match(run, /origin\.kind === 'creation' \? 'live' : 'archive'/);
    assert.match(methodOf('private saveInstalled('), /source: origin\.kind === 'starter' \? 'starter' : 'archive'/);
});

test('EA9.4 wiring: an agent world\'s keyframes are H\'s (Q119 (a)): K, Space, the timeline, its film and its save read them; at most 16; a new version keeps them', () => {
    const keys = methodOf('private get keys()');
    assert.match(keys, /if \(this\.world\.kind === 'legacy'\) return this\.world\.legacy\.spec\.camera\.keyframes;/);
    assert.match(keys, /if \(this\.world\.kind === 'agent'\) return this\.world\.agent\.keyframes;/);
    const add = methodOf('private addKeyframe()');
    assert.match(add, /const vp = this\.viewport, current = this\.keys;/);
    assert.match(add, /this\.world\.kind === 'agent' && keys\.length >= AGENT_KEYFRAMES/);
    assert.match(add, /this\.setKeys\(keys\);/);
    assert.match(methodOf('private removeKeyframe('), /keys\.length <= this\.fewestKeys/, 'h1 keeps one; an agent world may have none');
    assert.match(methodOf('private rebuildPath()'), /this\.viewport\.path = cameraPath\(keys, this\.duration\);/);
    assert.match(methodOf('private setPlaying('), /if \(playing && !this\.viewport\.path\)/, 'nothing to play without a path');
    const after = methodOf('private afterKeysChanged(');
    assert.match(after, /this\.timeline\.setKeyframes\(this\.keys \?\? \[\], this\.fewestKeys\);/);
    assert.match(after, /this\.keyframesChanged\(\)/, 'its save hears');
    const wire = methodOf('private wireKeys()');
    // Space plays them, never in place of a focused control's own Space (EA-VR11 caught the review's checkboxes losing it).
    assert.match(wire, /if \(e\.key === ' ' && this\.keys && !isControl\(e\.target\)\) \{ e\.preventDefault\(\);/);
    assert.match(wire, /else if \(e\.key\.toLowerCase\(\) === 'k' && this\.keys\) this\.addKeyframe\(\);/);
    // Its film follows its keyframes' path, or with none holds the view where it is.
    const exp = methodOf('private openExport()');
    assert.match(exp, /pathFor: seconds => cameraPath\(keys, seconds\) \?\? \(\(\) => still\)/);
    assert.doesNotMatch(exp, /pathFor: \(\) => \(\) => still/);
    // The world on the stage's page: its keyframes on the timeline, its path, playing when it comes with some.
    const pub = methodOf('private publishAgent(');
    assert.match(pub, /vp\.path = cameraPath\(w\.keyframes, this\.duration\);/);
    assert.match(pub, /this\.timeline\.setKeyframes\(w\.keyframes, 0\);/);
    // h1's world builds its path before it plays (setPlaying needs one).
    const legacy = methodOf('private publishLegacy(');
    const pathAt = legacy.indexOf('this.rebuildPath();');
    assert.ok(pathAt >= 0 && pathAt < legacy.indexOf('this.setPlaying(true);'), 'the path first');
    // A new version of the world on the stage keeps its keyframes; a saved world or a starter brings its own.
    const of = methodOf('private keyframesOf(');
    assert.match(of, /if \(origin\.kind === 'creation'\) return origin\.about\.revises \? this\.agentWorld\?\.keyframes \?\? \[\] : \[\];/);
    assert.match(of, /if \(origin\.kind === 'reopened'\) return origin\.world\.keyframes;/);
    assert.match(methodOf('private saveInstalled('), /keyframes: w\.keyframes,/);
    assert.match(MAIN, /const AGENT_KEYFRAMES = 16;/);
    // The timeline's Remove is off at the fewest views a world keeps: one for h1's path, none for an agent world.
    const timeline = readFileSync(new URL('src/shell/studio/timeline.ts', ROOT), 'utf8');
    assert.match(timeline, /this\.removeBtn\.disabled = this\.selected < 0 \|\| this\.keys\.length <= this\.fewest;/);
    assert.match(timeline, /setKeyframes\(keys: CameraKeyframe\[\], fewest = 1\): void \{\s*this\.keys = keys;\s*this\.fewest = fewest;/);
});

test('EA9.4 a page-wide Space leaves a focused control its own: buttons, checkboxes, links, tabs; the page, the timeline\'s track and a range play', async () => {
    const { isControl } = await import('../src/shared/dom.ts');
    // An element as the browser answers `closest`: itself or an ancestor matching any of the selector's parts.
    const el = (tag, attrs = {}, parent = null) => {
        const node = { tag, attrs, parent };
        node.matches = sel => sel.split(',').map(s => s.trim()).some(s => {
            const m = /^([a-z]+)?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/.exec(s);
            if (!m) return false;
            const [, t, a, v] = m;
            return (!t || t === node.tag) && (!a || (a in node.attrs && (v === undefined || node.attrs[a] === v)));
        });
        node.closest = sel => { for (let n = node; n; n = n.parent) if (n.matches(sel)) return n; return null; };
        return node;
    };
    const body = el('body');
    assert.equal(isControl(body), false, 'the page: Space plays');
    assert.equal(isControl(el('input', { type: 'checkbox' }, body)), true, 'a finding\'s checkbox');
    assert.equal(isControl(el('span', {}, el('button', {}, body))), true, 'inside a button');
    // A slider answers its arrows, never Space: the page's Space plays there, as before EA9.4 (its review).
    assert.equal(isControl(el('div', { role: 'slider' }, body)), false, 'the timeline\'s track');
    assert.equal(isControl(el('input', { type: 'range' }, body)), false, 'a Director\'s slider');
    assert.equal(isControl(el('input', { type: 'text' }, body)), true, 'a text field');
    assert.equal(isControl(el('a', { href: '/creations' }, body)), true);
    assert.equal(isControl(el('div', { role: 'tab' }, body)), true);
    assert.equal(isControl(el('canvas', {}, body)), false, 'the stage');
    assert.equal(isControl(null), false);
});

test('EA9.4 wiring: the right panel by H\'s kind: an agent world\'s review in the creator\'s words, h1\'s Director; the Spec and WGSL tabs h1\'s alone', () => {
    const show = methodOf('private showControls()');
    assert.match(show, /const agent = this\.world\.kind === 'agent' && !!this\.improveView;/);
    assert.match(show, /this\.director\.el\.hidden = agent;/);
    assert.match(show, /this\.improveView\.el\.hidden = !agent;/);
    assert.match(show, /this\.controlsSub\.textContent = agent \? COPY\.improve\.sub : 'Changes show up instantly';/);
    assert.match(show, /this\.tabs\.spec\.hidden = !h1;\s*this\.tabs\.wgsl\.hidden = !h1;/);
    // Each install tells the panel what is on the stage: a creation's world takes changes; a starter's, a reopened or a
    // replayed one was made earlier; any other kind of world hides it.
    const run = methodOf('private async runCandidate(');
    assert.match(run, /this\.improveView\?\.installed\(origin\.kind === 'creation' \? 'creation' : 'earlier', change\)/);
    // What the world is to the one before it, read before the Run can replace it: new, an improved version, or the same.
    assert.match(run, /const change: 'new' \| 'improved' \| 'same' = origin\.kind !== 'creation' \|\| !origin\.about\.revises \? 'new'\s*: this\.agentWorld\?\.candidate === snapshot\.id \? 'same' : 'improved';\s*const r = await stage\.run\(/);
    assert.match(methodOf('private put('), /if \(next\.kind !== 'agent'\) this\.afterSwitch\('the right panel', \(\) => this\.improveView\?\.installed\(null\)\);/);
    // The review reaches the creator on the agent path, its paid actions through the session holding the world on the stage.
    const reviews = methodOf('private async mountReviews(');
    assert.match(reviews, /session: \(\) => this\.creation\?\.sessionFor\(this\.agentWorld\?\.candidate \?\? null\) \?\? null,/);
    assert.match(reviews, /paidBusy: \(\) => this\.paidBusy\(\),/);
    // Its paid actions wait for a new world being made, and for any other on its way to the stage: a Run, an example, a
    // starter (EA9.4's review: their install ended a round under way, its spend lost).
    const paid = methodOf('private paidBusy()');
    for (const re of [/this\.creation\?\.creating\) return 'a new world/, /this\.stage\?\.busy\) return 'another world/, /this\.busy\) return 'another world/, /this\.starterOpening !== null\) return 'another world/]) assert.match(paid, re);
    assert.match(methodOf('private runBlocked()'), /if \(this\.reviews\?\.improving\) return/, 'and no other Run beside a round');
    assert.match(methodOf('private async forge('), /if \(this\.creation\?\.busy \|\| this\.reviews\?\.improving \|\| this\.starterOpening !== null\) return;/, 'nor an example by its shortcut');
    // Mounted whatever the gateway: Developer view's review without one, the creator's panel only with a creation.
    const mount = methodOf('private async mountCreation(');
    assert.ok(mount.lastIndexOf('await this.mountReviews(api);') > mount.indexOf('if (client && api) {'), 'outside the gateway\'s branch');
    assert.match(reviews, /if \(!creation\) return;\s*const improve = new ImproveView/);
});
