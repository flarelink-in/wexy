// A film of an h1 world through the studio's own dialog, in headless Chrome, to catch what the export says when it
// refuses: for each scene and shape asked, forge the starter (the playground mock, no backend), open "Make video",
// wait for the measurement, pick the shape, the quality and 6 s, make the film, and record the outcome: ready, or the
// dialog's refusal in its words and the library's, plus every console error and exception. Screenshots and
// results.json go to dev/out/film-smoke/<gpu>-<time>/. Exits 1 when a film did not come out. With --autofix the mock
// serves the galaxy's evolve with two GLSL slips (?autofix=1), so the world passes only through rung L2's auto-fix and
// the film must be made from the fixed text (F2): the build must report both auto-fixes.
//   node dev/film-smoke.mjs [--gpu nvidia] [--scenes galaxy,storm] [--shapes Wide,Vertical,Square] [--quality HD] [--autofix] [--chrome path]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gpu = opt('gpu', 'amd');
const scenes = opt('scenes', 'galaxy,storm').split(',');
const shapes = opt('shapes', 'Wide,Vertical').split(',');
const quality = opt('quality', 'HD');
const autofixed = argv.includes('--autofix');
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('film-smoke: no Chrome found; pass --chrome <path>.'); process.exit(2); }
const OUT = resolve(join(ROOT, 'dev', 'out', 'film-smoke', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const origin = 'http://127.0.0.1:5199';
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/studio.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error('film-smoke: Vite did not answer on 5199'); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-film-smoke-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
    '--window-size=1440,900', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 150 && !target; i++) {
    try {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    } catch { /* not yet */ }
    if (!target) await sleep(200);
}
function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
const consoleLines = [];
const page = connect(target.webSocketDebuggerUrl, m => {
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '' });
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
});
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const waitFor = async (expression, ms) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression).catch(() => false)) return true; await sleep(250); }
    return false;
};
const shot = async name => writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const clickText = text => evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const measured = `(() => { const e = document.querySelector('.export-dialog .ex-estimate'); return !!e && !e.textContent.includes('Measuring') && (e.textContent.includes('Takes') || !!document.querySelector('.export-dialog .ex-warn')); })()`;
const dialogTitle = `document.querySelector('#ex-title')?.textContent ?? ''`;
const warn = `document.querySelector('.export-dialog .ex-warn')?.textContent ?? ''`;
const dialogText = `(document.querySelector('.export-dialog')?.innerText ?? '').slice(0, 600)`;

const results = [];
try {
    for (const scene of scenes) {
        for (const shape of shapes) {
            const since = consoleLines.length;
            const name = `${scene}-${shape.toLowerCase()}-${quality.toLowerCase()}`;
            await page.send('Page.navigate', { url: `${origin}/studio.html?scene=${scene}&dev=1${autofixed ? '&autofix=1' : ''}` });
            const forged = await waitFor(`!document.querySelector('#btn-export')?.disabled`, 180000);
            const spec = await evaluate(`(() => { const t = document.querySelector('#panel-spec')?.innerText ?? ''; const m = t.match(/"particles"[\\s\\S]{0,400}/); return m ? m[0].replace(/\\s+/g, ' ').slice(0, 300) : ''; })()`).catch(() => '');
            await evaluate(`document.querySelector('#btn-export').click()`);
            const first = await waitFor(measured, 90000);
            await clickText(shape); await sleep(150); await clickText(quality); await sleep(150); await clickText('6 s');
            await waitFor(measured, 90000);
            const estimate = await evaluate(`document.querySelector('.export-dialog .ex-estimate')?.textContent ?? ''`);
            const refusedBefore = await evaluate(warn);
            await shot(`${name}-01-setup`);
            await clickText('Make video');
            const ended = await waitFor(`/ready|Part of your video/.test(${dialogTitle}) || !!document.querySelector('.export-dialog .ex-warn')`, 300000);
            await sleep(500);
            await shot(`${name}-02-end`);
            const title = await evaluate(dialogTitle);
            const refusal = await evaluate(warn);
            const text = await evaluate(dialogText);
            const errors = consoleLines.slice(since).filter(l => l.type === 'error' || l.type === 'exception').map(l => l.text);
            // The studio's build line ("…, 2 auto-fix(es)"): with --autofix the galaxy must have gone through both.
            const autofixes = Number(consoleLines.slice(since).map(l => /(\d+) auto-fix\(es\)/.exec(l.text)?.[1]).find(Boolean) ?? NaN);
            const ok = forged && first && ended && /ready/.test(title) && !refusal && (!autofixed || scene !== 'galaxy' || autofixes === 2);
            results.push({ scene, shape, quality, ok, forged, measured: first, estimate, refusedBefore, title, refusal, autofixes, errors, spec, dialog: text });
            console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${title || 'no title'}${autofixed ? ` (${autofixes} auto-fixes)` : ''}${refusal ? ` — ${refusal}` : ''}${errors.length ? ` — console: ${errors[0].slice(0, 200)}` : ''}`);
            if (ok) { await evaluate(`document.querySelector('.export-dialog .icon-btn')?.click()`); await sleep(800); }
        }
    }
} finally {
    writeFileSync(join(OUT, 'results.json'), JSON.stringify({ gpu, results, console: consoleLines }, null, 1));
    page.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    const failed = results.filter(r => !r.ok).length;
    console.log(`\nfilm-smoke (${gpu}): ${results.length - failed}/${results.length} films — ${OUT}`);
    process.exit(failed ? 1 : 0);
}
