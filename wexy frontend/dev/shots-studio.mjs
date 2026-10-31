// Screenshots of the studio while a world is made, in both views, over the playground mock (no backend, no
// spend): what a creator sees at /studio.html, and what Developer view (?dev=1) shows, every 1.5 s from Create to
// the live world, with the Progress and Pipeline texts beside each frame. For judging the copy and the panels.
//   node dev/shots-studio.mjs [--gpu nvidia] [--prompt "…"] [--fault] [--views creator,dev] [--out dir] [--chrome path]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gpu = opt('gpu', 'amd');
const prompt = opt('prompt', 'A spiral galaxy, gold at the core and blue along the arms, threaded with dark dust');
const views = opt('views', 'creator,dev').split(',');
const fault = argv.includes('--fault');
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('shots: no Chrome found; pass --chrome <path>.'); process.exit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'shots-studio', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5198', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
const origin = 'http://127.0.0.1:5198';
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/studio.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error(`shots: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-shots-'));
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
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
});
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const shot = async name => writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
/** What the two progress panels say right now, and what the right panel shows. */
const texts = () => evaluate(`({
    journey: [...document.querySelectorAll('.journey-step')].map(r => (r.className.replace('journey-step ', '') + ' ' + (r.querySelector('.journey-title')?.textContent ?? '') + ': ' + (r.querySelector('.journey-detail')?.textContent ?? '')).trim()),
    trace: [...document.querySelectorAll('.trace-list .step')].map(s => ((s.querySelector('.step-title')?.textContent ?? '') + ' [' + (s.querySelector('.tag')?.textContent ?? '') + '] ' + (s.querySelector('.step-detail')?.textContent ?? '') + ' — ' + (s.querySelector('.step-meta')?.textContent ?? '')).trim()),
    rightVisible: [...document.querySelectorAll('#right .tab-panel')].filter(p => !p.hidden).map(p => p.id),
    rightText: (document.querySelector('#right')?.innerText ?? '').slice(0, 300).replace(/\\n+/g, ' | '),
    message: document.querySelector('#viewport-msg')?.textContent ?? '',
    emptyShown: !(document.querySelector('#empty')?.hidden ?? true),
})`);

const report = {};
try {
    for (const view of views) {
        const since = consoleLines.length;
        const url = `${origin}/studio.html?source=mock&autorun=1${view === 'dev' ? '&dev=1' : ''}${fault ? '&fault=1' : ''}&prompt=${encodeURIComponent(prompt)}`;
        await page.send('Page.navigate', { url });
        const frames = [];
        const t0 = Date.now();
        for (let i = 0; i < 60; i++) {
            await sleep(1500);
            const name = `${view}-${String(i).padStart(2, '0')}`;
            await shot(name);
            const t = await texts().catch(e => ({ error: String(e) }));
            frames.push({ name, atMs: Date.now() - t0, ...t });
            console.log(`${name} +${Math.round((Date.now() - t0) / 1000)}s  journey: ${(t.journey ?? []).join(' / ').slice(0, 160)}`);
            if (consoleLines.slice(since).some(l => /^Wexy: build /.test(l))) { await sleep(1500); await shot(`${view}-${String(i + 1).padStart(2, '0')}-live`); frames.push({ name: `${view}-live`, atMs: Date.now() - t0, ...(await texts()) }); break; }
        }
        report[view] = { url, frames, console: consoleLines.slice(since) };
    }
} finally {
    writeFileSync(join(OUT, 'frames.json'), JSON.stringify(report, null, 1));
    page.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(`\nshots: frames in ${OUT}`);
}
