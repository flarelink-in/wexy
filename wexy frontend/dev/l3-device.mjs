// EA5.1's exit on a real GPU (executor-design.md §13): dev/l3-device.html in headless Chrome on one GPU, handed candidate
// bundles (by default the live candidates of 2026-11-01 in dev/out/agent-live/), each sealed again and every body
// compiled on the device by L3. Compiling makes shader modules and runs nothing on the GPU; no world is built, no model
// is called, nothing is spent. Results go to dev/out/l3-device/<time>/<gpu>.json. Exit 0 when every candidate seals as
// its bundle and every body compiles with the device's provenance and nothing uncaptured; 1 otherwise; 2 when Chrome or
// Vite cannot start. One GPU a run (the GTX 1650 through --force_high_performance_gpu, gotchas).
//   node dev/l3-device.mjs --gpu amd|nvidia [--bundles a.json,b.json] [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { console.error('l3-device: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('l3-device: no Chrome found; pass --chrome <path>.'); await quit(2); }

const LIVE = join(ROOT, 'dev', 'out', 'agent-live');
const paths = opt('bundles', null)?.split(',').map(p => resolve(p.trim()))
    ?? readdirSync(LIVE).filter(d => d.startsWith('live-2026-11-01T09')).sort()
        .flatMap(d => readdirSync(join(LIVE, d)).filter(f => f.endsWith('.candidate.json')).map(f => join(LIVE, d, f)));
if (!paths.length) { console.error('l3-device: no bundles to check.'); await quit(2); }
const bundles = paths.map(p => ({ name: `${basename(dirname(p))}/${basename(p, '.candidate.json')}`, bundle: JSON.parse(readFileSync(p, 'utf8')) }));
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'l3-device', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
mkdirSync(OUT, { recursive: true });

const PORT = 5195;
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/dev/l3-device.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error(`l3-device: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-l3-device-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
    '--window-size=1280,800', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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
    await page.send('Page.navigate', { url: `${origin}/dev/l3-device.html` });
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(200); ready = await evaluate('!!window.__L3__?.ready'); }
    if (!ready) throw new Error(`the page never got ready; its console:\n${consoleLines.join('\n')}`);
    await evaluate(`window.__L3__.run(${JSON.stringify(bundles)})`);
    let result = null;
    for (let i = 0; i < 600 && !result; i++) { await sleep(200); const r = await evaluate('window.__L3__.result ? JSON.stringify(window.__L3__.result) : null'); if (r) result = JSON.parse(r); }
    if (!result) throw new Error(`no result in 120 s; its console:\n${consoleLines.join('\n')}`);
    if (result.error) throw new Error(`the page failed: ${result.error}`);
    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    const problems = [];
    for (const w of result.worlds) {
        if (!w.sealed) { problems.push(`${w.name}: not sealed (${w.reason})`); continue; }
        if (!w.sameId) problems.push(`${w.name}: sealed to another id(C) than its bundle's`);
        for (const m of w.modules) if (!m.ok || m.producedBy !== 'device') problems.push(`${w.name}/${m.module}: ${m.ok ? 'not the device\'s verdict' : 'refused by the device'}`);
        if (w.provenance !== null) problems.push(`${w.name}: provenance refuses: ${w.provenance}`);
    }
    if (result.uncaptured.length) problems.push(`${result.uncaptured.length} uncaptured device error(s)`);
    if (result.lost) problems.push(`the device was lost: ${result.lost}`);
    if (errors.length) problems.push(`${errors.length} console error(s)`);
    writeFileSync(join(OUT, `${gpu}.json`), JSON.stringify({ ...result, bundles: paths, console: consoleLines, problems }, null, 1));
    for (const w of result.worlds) {
        console.log(`${w.name}: ${w.sealed ? `id(C) ${w.candidate.slice(0, 12)}… ${w.sameId ? 'as its bundle' : 'NOT its bundle'}` : `not sealed: ${w.reason}`}`);
        for (const m of w.modules ?? []) console.log(`  ${m.module} (${m.kind}, ${m.lines} lines): ${m.ok ? 'compiles' : 'refused'} · ${m.producedBy} · ${m.ms} ms${m.findings.length ? ` · ${m.findings.map(f => `${f.severity} ${f.line ?? '-'}: ${f.message}`).join(' | ')}` : ''}`);
        if (w.sealed) console.log(`  provenance: ${w.provenance ?? 'holds'}`);
    }
    console.log(`\nl3-device (${gpu}): ${result.gpu}; ${result.browser.match(/Chrome\/[\d.]+/)?.[0] ?? result.browser}`);
    console.log(problems.length ? `FAILED:\n  ${problems.join('\n  ')}` : `every body compiles on the device, provenance holds, nothing uncaptured`);
    console.log(`evidence in ${OUT}`);
    failed = problems.length > 0;
} catch (e) {
    console.error(`l3-device: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
