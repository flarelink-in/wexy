// W3.5's layout check (the creations platform companion §14: "320, 390 and 1280 px"): the history's view over stand-in
// worlds (dev/creations-preview.html), and the real /creations page as a build with no backend shows it, each at 320,
// 390 and 1280 px in headless Chrome with the GPU off. Each page must be exactly as wide as the screen (no sideways
// scroll; gotchas: measure with mobile emulation) and throw nothing. Screenshots and result.json in
// dev/out/creations-layout/<time>/. No backend, no model, no GPU.
//
//   node dev/creations-layout.mjs [--chrome path]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const CHROME = [arg('chrome'), process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => existsSync(p));
const PORT = 5196;
const ORIGIN = `http://localhost:${PORT}`;
const OUT = join(ROOT, 'dev/out/creations-layout', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
if (!CHROME) { console.error('creations-layout: no Chrome; pass --chrome <path>.'); process.exit(2); }

// Vite with no gateway and no Firebase: the real page says so, which is what a build without a backend shows.
const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_API_ORIGIN: '', VITE_FIREBASE_API_KEY: '' } });
for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${ORIGIN}/dev/creations-preview.html`)).ok) break; } catch { /* not yet */ }
    await sleep(200);
}

const profile = mkdtempSync(join(tmpdir(), 'wexy-creations-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
    '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 150 && !target; i++) {
    try {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    } catch { /* not yet */ }
    if (!target) await sleep(200);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const thrown = [];
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '');
};
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
await send('Runtime.enable');
await send('Page.enable');

const results = [];
for (const [page, path, ready] of [
    ['preview', '/dev/creations-preview.html', `document.body.dataset.ready === '1'`],
    ['page', '/creations', `!!document.querySelector('.history-message')`],
    ['home', '/', `!!document.querySelector('.nav-creations')`],
    ['studio', '/studio.html', `!!document.querySelector('.creation-view') || !!document.querySelector('.btn-forge')`],
]) {
    for (const width of [320, 390, 1280]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        thrown.length = 0;
        await send('Page.navigate', { url: `${ORIGIN}${path}` });
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) { ok = await evaluate(ready).catch(() => false); if (!ok) await sleep(250); }
        await sleep(300);
        if (page === 'studio') {
            const switched = await evaluate(`(() => {
                const live = document.querySelector('.creation-modes [data-mode="live"]');
                const playground = document.querySelector('.creation-modes [data-mode="playground"]');
                if (!live || !playground) return false;
                const modes = live.closest('.creation-modes');
                const model = document.querySelector('#model');
                if (model?.value !== 'muse-v1.3' || !model.querySelector('option[value="muse-v1.3-contributor"]')?.disabled) return false;
                const initiallyHidden = modes.hidden && getComputedStyle(modes).display === 'none';
                playground.click();
                const selected = !modes.hidden && playground.getAttribute('aria-pressed') === 'true'
                    && document.querySelector('.btn-forge')?.textContent.includes('Playground example');
                live.click();
                return initiallyHidden && selected && modes.hidden && getComputedStyle(modes).display === 'none'
                    && live.getAttribute('aria-pressed') === 'true'
                    && !document.querySelector('.btn-forge')?.textContent.includes('Playground example');
            })()`);
            if (!switched) thrown.push('Live / Playground did not switch in place');
        }
        const m = await evaluate(`({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth,
            cards: document.querySelectorAll('.world-card').length, message: document.querySelector('.history-message')?.textContent ?? null,
            creations: (() => { const a = document.querySelector('.nav-creations, .studio-creations');
                if (!a) return null; const r = a.getBoundingClientRect();
                return { href: a.getAttribute('href'), visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth }; })() })`);
        writeFileSync(join(OUT, `${page}-${width}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        const pass = ok && m.inner === width && m.scroll === m.client && thrown.length === 0
            && (!['home', 'studio'].includes(page) || m.creations?.visible && m.creations.href === '/creations');
        results.push({ page, width, pass, ready: ok, ...m, thrown: [...thrown] });
        console.log(`${pass ? 'PASS' : 'FAIL'} ${page} at ${width}: page ${m.scroll} px wide, ${m.cards} cards${m.message ? `, "${m.message}"` : ''}${thrown.length ? `, threw: ${thrown[0]}` : ''}`);
    }
}
writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ chrome: CHROME, gpu: 'off', results }, null, 2)}\n`);
ws.close();
for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
vite.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
console.log(`evidence: ${OUT}`);
await sleep(150);
process.exit(results.every(r => r.pass) ? 0 : 1);
