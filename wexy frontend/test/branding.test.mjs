// Brand lockups use the original public logo, including before JavaScript starts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { wordmark } from '../src/shared/icons.ts';

test('shared wordmark references the full public logo without duplicating its paths', () => {
    const markup = wordmark(22);
    assert.match(markup, /<image href="\/icon_full.svg" width="1600" height="800"/);
    assert.match(markup, /viewBox="331 290 938 220"/);
    assert.match(markup, /width="94" height="22"/);
    assert.ok(!markup.includes('<path'));
    const asset = readFileSync(new URL('../public/icon_full.svg', import.meta.url), 'utf8');
    assert.match(asset, /viewBox="0 0 1600 800"/);
    assert.match(asset, /width="938" height="220"[^>]*translate\(331 290\)/);
});

test('home and studio include full logos and accessible brand labels in the initial HTML', () => {
    for (const [file, count] of [['index.html', 2], ['studio.html', 1]]) {
        const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.equal((html.match(/href="\/icon_full.svg"/g) || []).length, count, file);
        assert.ok(html.includes('aria-label="Wexy home"'));
        assert.ok(!html.includes('data-logo='));
    }
});