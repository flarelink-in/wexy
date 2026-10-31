// The contract gates' runner (FE1 design §10): dev/contract-gates.html in headless Chrome on each GPU, the GTX 1650
// through --force_high_performance_gpu (Chrome on Windows ignores powerPreference). Results go to
// dev/out/contract-gates/<time>/<gpu>.json and summary.md. Exits 1 when a check fails on any GPU.
//   node dev/contract-gates.mjs [--gpu amd,nvidia] [--chrome path] [--timeout 600]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gpus = opt('gpu', 'amd,nvidia').split(',').map(s => s.trim()).filter(Boolean);
const timeoutMs = Number(opt('timeout', '600')) * 1000;
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('gates: no Chrome found; pass --chrome <path>.'); process.exit(2); }
const OUT = resolve(join(ROOT, 'dev', 'out', 'contract-gates', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Vite for the page, on a port of its own.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5198', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const origin = 'http://127.0.0.1:5198';
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/dev/contract-gates.html`)).ok) break; } catch { /* starting */ } await sleep(200); }

function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

async function runOn(gpu) {
    const profile = mkdtempSync(join(tmpdir(), 'wexy-contract-gates-'));
    const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
        '--window-size=1440,900', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
    let target = null;
    let port = null;
    for (let i = 0; i < 150 && !target; i++) {
        try {
            port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
            target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
        } catch { /* not yet */ }
        if (!target) await sleep(200);
    }
    const lines = [];
    const page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description).join(' ');
            if (text.startsWith('[g] ')) { lines.push(text.slice(4)); console.log(`  ${text.slice(4)}`); }
        }
    });
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    let result = null;
    try {
        await page.send('Page.navigate', { url: `${origin}/dev/contract-gates.html` });
        for (const end = Date.now() + timeoutMs; Date.now() < end && !result;) {
            const r = await page.send('Runtime.evaluate', { expression: 'window.__CG__ ? JSON.stringify(window.__CG__) : null', returnByValue: true });
            if (r.result.value) result = JSON.parse(r.result.value);
            else await sleep(500);
        }
        if (!result) result = { ok: false, checks: [], error: `no result within ${timeoutMs / 1000} s` };
    } finally {
        page.close();
        spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    }
    result.gpu = gpu;
    result.log = lines;
    writeFileSync(join(OUT, `${gpu}.json`), JSON.stringify(result, null, 1));
    return result;
}

const summary = [`# Contract gates, ${new Date().toISOString()}`, ''];
let failed = 0;
try {
    for (const gpu of gpus) {
        console.log(`\n=== ${gpu} ===`);
        const r = await runOn(gpu);
        const bad = r.checks.filter(c => !c.ok).length;
        failed += bad + (r.error ? 1 : 0);
        summary.push(`## ${gpu}: ${r.adapter ? `${r.adapter.vendor} ${r.adapter.architecture} (${r.adapter.description})` : 'no adapter'}`, '',
            `- checks: ${r.checks.length - bad}/${r.checks.length}${r.error ? `; error: ${r.error.split('\n')[0]}` : ''}`);
        if (r.probes) for (const [world, p] of Object.entries(r.probes)) summary.push(`- ${world}: ${p.particles} particles, measured ${p.measuredMs.toFixed(1)} ms a frame at 1280×720, predicted ${p.probe.predictedMs.toFixed(1)} ms (×${p.ratio.toFixed(2)}); ladder ${p.ladderMs} ms`);
        if (r.slow) summary.push(`- slow kernel: refused in ${Math.round(r.slow.ms)} ms, predicted ${r.slow.probe ? Math.round(r.slow.probe.predictedMs) : '?'} ms a frame`);
        if (r.compiles) summary.push(`- compiles (cold/warm ms): ${Object.entries(r.compiles).map(([k, v]) => `${k} ${v.cold}/${v.warm}`).join(', ')}`);
        summary.push('');
        console.log(`${gpu}: ${r.checks.length - bad}/${r.checks.length} checks ok${r.error ? ` (error: ${r.error.split('\n')[0]})` : ''}`);
    }
} finally {
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    writeFileSync(join(OUT, 'summary.md'), summary.join('\n'));
    console.log(`\ncontract gates: ${failed ? `${failed} failure(s)` : 'all ok'} — ${OUT}`);
    process.exit(failed ? 1 : 0);
}
