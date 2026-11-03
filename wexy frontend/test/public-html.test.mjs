// Public HTML invariants: fixed origins, escaped metadata, real errors, no client/GPU execution.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicResponse, renderHome, escapeHtml, SITES } from '../functions/render.mjs';
import { prepareHosting } from '../scripts/prepare-hosting.mjs';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const respond = (url = '/', environment = 'prod', method = 'GET') =>
    publicResponse({ method, url }, SITES[environment], () => template);

test('public HTML replaces metadata once and preserves the existing landing body', () => {
    const html = renderHome(template, SITES.prod);
    assert.equal(html.slice(html.indexOf('</head>')), template.slice(template.indexOf('</head>')));
    for (const name of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'description']) {
        assert.equal((html.match(new RegExp(`(?:name|property)="${name}"`, 'g')) || []).length, 1, name);
    }
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.ok(html.includes('href="https://wexy.ai/"'));
    assert.ok(html.includes('<meta property="og:image" content="https://wexy.ai/icon-full.png">'));
    assert.ok(html.includes('<meta name="twitter:image" content="https://wexy.ai/icon-full.png">'));
    assert.ok(html.includes('<meta property="og:image:alt" content="Wexy — worlds, not videos">'));
    assert.ok(existsSync(new URL('../public/icon-full.png', import.meta.url)));
    assert.ok(html.includes('<h1 id="hero-title">'));
});

test('metadata escapes HTML-significant input', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    const html = renderHome(template, { origin: 'https://example.test/"<injected>', indexable: false });
    assert.ok(!html.includes('<injected>'));
    assert.ok(html.includes('&quot;&lt;injected&gt;'));
    assert.throws(() => renderHome('broken', SITES.prod), /incomplete/);
});

test('queries never poison canonical URLs; dev HTML is noindex and environment-specific', () => {
    const prod = respond('/?prompt=%3Cscript%3E&host=evil.test');
    assert.equal(prod.status, 200);
    assert.ok(!prod.body.includes('evil.test'));
    const dev = respond('/', 'dev');
    assert.ok(dev.body.includes('href="https://dev.wexy.ai/"'));
    assert.ok(dev.body.includes('<meta property="og:image" content="https://dev.wexy.ai/icon-full.png">'));
    assert.ok(dev.body.includes('<meta name="twitter:image" content="https://dev.wexy.ai/icon-full.png">'));
    assert.ok(dev.body.includes('content="noindex, nofollow"'));
    assert.equal(dev.headers['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(prod.headers['X-Robots-Tag'], undefined);
    assert.equal(prod.headers['Cache-Control'], 'no-store');
    assert.equal(prod.headers['X-Frame-Options'], 'DENY');
});

test('robots and sitemaps expose only the public homepage in prod, none in dev', () => {
    assert.match(respond('/robots.txt').body, /Sitemap: https:\/\/wexy.ai\/sitemap.xml/);
    assert.match(respond('/robots.txt').body, /Disallow: \/studio/);
    assert.equal(respond('/robots.txt', 'dev').body, 'User-agent: *\nDisallow: /\n');
    assert.match(respond('/sitemap.xml').body, /<loc>https:\/\/wexy.ai\/<\/loc>/);
    assert.ok(!respond('/sitemap.xml', 'dev').body.includes('<url>'));
});

test('only GET/HEAD public routes exist; no fallback shell, template reads or API proxy for other paths', () => {
    for (const url of ['/nope', '/assets/missing.js', '/studio', '//evil.test/', '/%2e%2e/', '/api/user']) {
        const response = publicResponse({ method: 'GET', url }, SITES.prod, () => { throw new Error('read'); });
        assert.equal(response.status, 404, url);
    }
    assert.equal(respond('/', 'prod', 'POST').status, 405);
    assert.equal(respond('/', 'prod', 'POST').headers.Allow, 'GET, HEAD');
    for (const url of ['/', '/robots.txt', '/sitemap.xml']) {
        const head = respond(url, 'prod', 'HEAD');
        assert.equal(head.body, '');
        assert.deepEqual(head.headers, respond(url).headers);
    }
});

test('Hosting uses pinned environment-specific Functions, no broad fallback and guarded build artifacts', () => {
    const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
    for (const environment of ['dev', 'prod']) {
        const hosting = config.hosting.find(item => item.target === environment);
        assert.equal(hosting.public, `hosting-${environment}`);
        assert.ok(hosting.predeploy[0].includes(`${environment} --check`));
        const pinned = hosting.rewrites.filter(item => item.function?.pinTag);
        assert.equal(pinned.length, 1, 'one pinned rewrite per service avoids concurrent Cloud Run tag updates');
        const rewrite = pinned[0];
        assert.equal(rewrite.function.functionId, environment === 'dev' ? 'renderPublicDev' : 'renderPublicProd');
        assert.equal(rewrite.function.region, 'us-central1');
        const pattern = new RegExp(rewrite.regex);
        for (const path of ['/', '/robots.txt', '/sitemap.xml']) assert.ok(pattern.test(path), path);
        for (const path of ['/studio', '/missing', '/robotsXtxt', '/sitemap.xml/extra', '/assets/app.js']) {
            assert.ok(!pattern.test(path), path);
        }
        assert.ok(!hosting.rewrites.some(item => item.source === '**'));
        assert.equal(hosting.redirects[0].source, '/index.html');
        // W3.5: the history's address, exactly, and ahead of the public-HTML Function (first match wins).
        const creations = hosting.rewrites.findIndex(item => item.source === '/creations');
        assert.ok(creations >= 0 && creations < hosting.rewrites.indexOf(rewrite), 'the /creations rewrite, before the Function');
        assert.equal(hosting.rewrites[creations].destination, '/creations.html');
    }
});

test('artifact preparation removes shadowing files, pairs exact templates/assets and catches stale deploys', () => {
    const root = mkdtempSync(join(tmpdir(), 'wexy-hosting-'));
    try {
        for (const environment of ['dev', 'prod']) {
            const build = join(root, environment === 'dev' ? 'dist-dev' : 'dist');
            mkdirSync(join(build, 'assets'), { recursive: true });
            writeFileSync(join(build, 'index.html'), '<head></head><body><script src="/assets/app.js"></script></body>');
            writeFileSync(join(build, 'assets/app.js'), 'browser code');
            writeFileSync(join(build, 'studio.html'), '<h1>Studio</h1>');
            // W3.5: the history is a page of its own, held to its build as the studio is.
            writeFileSync(join(build, 'creations.html'), '<h1>Your worlds</h1>');
            writeFileSync(join(build, 'robots.txt'), 'old robots');
            prepareHosting(root, environment);
            assert.ok(!existsSync(join(root, `hosting-${environment}`, 'index.html')));
            assert.ok(!existsSync(join(root, `hosting-${environment}`, 'robots.txt')));
            assert.ok(existsSync(join(build, 'index.html')), 'vite preview remains intact');
            writeFileSync(join(root, `hosting-${environment}/assets/app.js`), 'stale');
            assert.throws(() => prepareHosting(root, environment, true), /stale/);
            prepareHosting(root, environment);
            writeFileSync(join(root, `hosting-${environment}/creations.html`), 'stale');
            assert.throws(() => prepareHosting(root, environment, true), /creations\.html artifact is stale/);
            prepareHosting(root, environment);
            writeFileSync(join(root, `hosting-${environment}/index.html`), 'shadow');
            assert.throws(() => prepareHosting(root, environment, true), /shadows/);
        }
        assert.throws(() => prepareHosting(root, 'unknown'), /environment/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});