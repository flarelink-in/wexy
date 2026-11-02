// EA6.1's EA-G3 on one real GPU (visual-review-design.md §6, §10): dev/ea-g3.html in headless Chrome with its WebGPU
// developer features, the review's capture of worlds the stage installed, on the stage's own engine with the viewport
// running: known colours, a portrait canvas, a moving world, a ping-pong pair, AutoExposure's history, cleanup after a
// refused draw, a refused readback and a validation error, and the castle as written and at unit sizes. No model is
// called and nothing is spent. Results: dev/out/ea-g3/<gpu>-<time>/result.json and the captured frames as JPEG files for
// a person to look at. Exit 0 when every check passes, 1 otherwise, 2 when Chrome or Vite cannot start. One GPU a run (the
// GTX 1650 through --force_high_performance_gpu, gotchas). On the charger only.
//   node dev/ea-g3.mjs --gpu amd|nvidia [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea-g3: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea-g3: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea-g3', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });

const PORT = 5194;
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/dev/ea-g3.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error(`ea-g3: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea-g3-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=1400,1400', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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

let failed = true;
let page = null;
try {
    if (!target) throw new Error('Chrome did not open a page to drive');
    const consoleLines = [];
    page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    });
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `${origin}/dev/ea-g3.html` });
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(200); ready = await evaluate('!!window.__G3__?.ready'); }
    if (!ready) throw new Error(`the page never got ready; its console:\n${consoleLines.join('\n')}`);
    await evaluate('window.__G3__.run()');
    let result = null;
    for (let i = 0; i < 3000 && !result; i++) { await sleep(200); const r = await evaluate('window.__G3__.result ? JSON.stringify(window.__G3__.result) : null'); if (r) result = JSON.parse(r); }
    if (!result) throw new Error(`no result in 10 minutes; its console:\n${consoleLines.slice(-40).join('\n')}`);
    const checks = result.checks ?? [];
    for (const s of result.saved ?? []) writeFileSync(join(OUT, s.name), Buffer.from(s.base64, 'base64'));
    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ...result, saved: (result.saved ?? []).map(s => s.name), console: consoleLines }, null, 1));
    console.log(`ea-g3 (${gpu}): ${result.gpu ?? '?'}; ${(result.browser ?? '').match(/Chrome\/[\d.]+/)?.[0] ?? ''}`);
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${JSON.stringify(c.detail).slice(0, 600)}`}`);
    if (result.holds) console.log(`the stage held still for each capture: ${result.holds.join(', ')} ms`);
    if (result.error) console.log(`the page failed: ${result.error}`);
    if (errors.length) console.log(`console errors: ${errors.slice(0, 5).join(' | ')}`);
    const passed = checks.filter(c => c.ok).length;
    failed = !!result.error || passed !== checks.length || errors.length > 0;
    console.log(`ea-g3: ${passed}/${checks.length} checks${failed ? ', FAILED' : ''}\nevidence in ${OUT}`);
} catch (e) {
    console.error(`ea-g3: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
