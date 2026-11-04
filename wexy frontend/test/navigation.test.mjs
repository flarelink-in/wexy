// Public navigation remains available without a backend or a signed-in account.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectCreationPath } from '../src/shell/studio/creation-path.ts';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Studio model selector defaults to Muse v1.3 and disables the Contributor option', () => {
    const main = read('src/shell/studio/main.ts');
    assert.match(main, /h\('select', \{ id: 'model', 'aria-label': 'Model' \}/);
    assert.match(main, /value: 'muse-v1\.3', selected: true \}, 'Muse v1\.3'/);
    assert.match(main, /value: 'muse-v1\.3-contributor', disabled: true \}, 'Muse v1\.3 Contributor'/);
});

test('Studio provides a no-reload mode switch and restores saved-world context', () => {
    const main = read('src/shell/studio/main.ts');
    const view = read('src/shell/studio/creation-view.ts');
    assert.match(main, /\['live', 'Live creation'\], \['playground', 'Playground'\]/);
    assert.match(main, /this\.playground = mode === 'playground'/);
    assert.match(main, /this\.creationModes\.hidden = !this\.playground/);
    assert.match(read('src/styles/studio.css'), /\.creation-modes\[hidden\] \{ display: none; \}/);
    assert.match(main, /enabled: \(\) => !this\.playground/);
    assert.match(view, /if \(this\.parts\.enabled\?\.\(\) === false\) return;/);
    assert.match(main, /this\.prompt\.value = world\.design\.intent\.trim\(\) \|\| world\.title/);
    assert.match(main, /classList\.toggle\('is-opening', !!o\)/);
    assert.match(main, /classList\.toggle\('is-ready', this\.creation\?\.state\.phase === 'ready'\)/);
    assert.match(read('src/styles/studio.css'), /\.is-opening \.empty-card > :not\(\.empty-open\)/);
});

test('homepage keeps the hero concise and provides undated future directions and project links', () => {
    const html = read('index.html');
    const nav = html.match(/<nav class="nav-links"[\s\S]*?<\/nav>/)?.[0];
    assert.match(nav, /href="https:\/\/github.com\/flarelink-in\/wexy"/);
    const lede = html.match(/<p class="lede">([^<]+)<\/p>/)?.[1];
    assert.ok(lede && lede.split(/\s+/).length <= 25);
    const future = html.match(/<section class="section" id="future"[\s\S]*?<\/section>/)?.[0];
    assert.ok(future);
    assert.match(future, /not features available today or a release schedule/);
    assert.equal((future.match(/<li>/g) ?? []).length, 4);
    assert.doesNotMatch(future, /<time|\b20\d{2}\b/);
    assert.match(future, /https:\/\/youtu.be\/ZXJ62_oP4Gk\?si=tGEfrJRq8euCkaNv/);
    assert.ok(html.indexOf('id="future"') > html.indexOf('id="models"'));
});

test('studio keeps presets beside the idea, not over the empty canvas, and replaces installed titles', () => {
    const main = read('src/shell/studio/main.ts');
    const empty = main.slice(main.indexOf('private mountEmpty()'), main.indexOf('private mountCaptureBar()'));
    assert.doesNotMatch(empty, /STARTERS|empty-examples|chip-lg/);
    assert.match(main, /class: 'examples-chips'[^\n]+STARTERS\.map/);
    assert.match(main, /\$\('#scene-title'\)\.textContent = title \?\? agentTitle\(w\)/);
    const legacy = main.slice(main.indexOf('private publishLegacy('), main.indexOf('private async hotSwap('));
    assert.match(legacy, /\$\('#scene-title'\)\.textContent = spec\.title/);
});

test('homepage and studio expose Creations outside account controls and collapsible navigation', () => {
    for (const file of ['index.html', 'studio.html']) {
        assert.match(read(file), /<a class="(?:nav-creations|studio-creations)[^"]*" href="\/creations">Creations<\/a>/);
    }
});

test('studio switches to agent creation by default, keeping legacy and loader precedence', () => {
    const main = read('src/shell/studio/main.ts');
    assert.match(main, /selectCreationPath\(params, \{ switched: true, gateway: !!this\.live \}/);
    const pick = query => selectCreationPath(new URLSearchParams(query), { switched: true, gateway: true }, { unavailable: 'offline', invalid: 'invalid' });
    assert.equal(pick('').create, 'agent');
    assert.equal(pick('legacy=1').create, 'h1');
    for (const kind of ['scene', 'world', 'replay']) {
        const path = pick(`${kind}=example&autorun=1`);
        assert.deepEqual(path.loader, { kind, name: 'example' });
        assert.equal(path.autorun, false);
    }
});