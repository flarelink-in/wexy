// The homepage only advertises the three currently supported featured presets.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { MockClient } from '../src/forge-client/mock-client.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const landing = readFileSync(new URL('../src/shell/landing/main.ts', import.meta.url), 'utf8');

test('homepage chips and showcase link only to black hole, magnetar and storm', () => {
    const ids = [...html.matchAll(/href="\.\/studio\.html\?scene=([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual([...new Set(ids)].sort(), ['kerr-black-hole', 'magnetic-star', 'storm']);
    for (const id of new Set(ids)) assert.equal(ids.filter(value => value === id).length, 3);
    assert.doesNotMatch(html, /sakura|celestial-torii|galaxy/i);
});

test('featured preview images exist and use the supplied wide image dimensions', () => {
    for (const id of ['magnetic-star', 'storm']) {
        assert.match(html, new RegExp(`src="/showcase/${id}\\.webp"[^>]+width="1920" height="1080"`));
        assert.ok(existsSync(new URL(`../public/showcase/${id}.webp`, import.meta.url)));
    }
});

test('rotating homepage ideas do not advertise the disabled shrine', () => {
    assert.doesNotMatch(landing, /ARCHETYPES\.map/);
    assert.match(landing, /magneticStar\.examplePrompt/);
    assert.match(landing, /thunderstorm/);
});

test('each featured link resolves to a studio starter and routes to its unpaid world', async () => {
    const studio = readFileSync(new URL('../src/shell/studio/main.ts', import.meta.url), 'utf8');
    assert.match(studio, /ARCHETYPES\.filter\(a => a\.id !== 'celestial-torii'\)/);
    assert.match(studio, /starter \|\| !this\.live \? 'mock' : 'live'/);
    const { ARCHETYPES } = await import('../src/forge-client/archetypes/index.ts');
    const prompts = [
        ...['kerr-black-hole', 'magnetic-star'].map(id => ARCHETYPES.find(a => a.id === id).examplePrompt),
        'A dark thunderstorm cloud that churns and turns in place while lightning flickers inside it',
    ];
    for (const [i, prompt] of prompts.entries()) {
        const result = await new MockClient({ pace: 0 }).plan(
            { prompt, style: 'auto', seconds: 12 }, {}, new AbortController().signal,
        );
        assert.equal(result.generation.source, 'mock');
        assert.match(result.draft.title, [/Kerr|black hole/i, /magnet/i, /^Thunderhead$/][i]);
    }
});