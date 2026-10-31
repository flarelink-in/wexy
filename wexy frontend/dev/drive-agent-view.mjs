// The agent turn's Developer view in headless Chrome with the GPU off (EA2.5; gate B2 of the backend's agent-loop design
// §15.1). dev/agent-view.html runs the panel over the backend's wire recordings and leaves window.__AV__, which this
// prints and keeps. A GPU-free DOM harness, not the studio drive: no WebGPU, no renderer, no backend, no spend. Results
// go to dev/out/agent-view/<time>/ (result.json, agent-view.png). Exit 0 when every check passes, 1 when one fails, 2
// when Chrome or Vite cannot start.
//   node dev/drive-agent-view.mjs [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// process.exit straight after a few fetch answers trips a libuv assertion in Node 24 on Windows (gotchas): wait first.
const quit = async code => { await sleep(150); process.exit(code); };
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('agent-view: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'agent-view', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
mkdirSync(OUT, { recursive: true });

const PORT = 5199;
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/dev/agent-view.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error(`agent-view: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-agent-view-'));
// The GPU off: the page must need none, and must not ask for one (it counts every request for an adapter).
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--window-size=1440,900', '--disable-features=BackForwardCache', 'about:blank'], { stdio: 'ignore' });
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
    await page.send('Page.navigate', { url: `${origin}/dev/agent-view.html` });
    let result = null;
    for (let i = 0; i < 300 && !result; i++) {
        await sleep(200);
        const r = await page.send('Runtime.evaluate', { expression: 'window.__AV__ ? JSON.stringify(window.__AV__) : null', returnByValue: true });
        if (r.result?.value) result = JSON.parse(r.result.value);
    }
    if (!result) throw new Error(`the page left no result in 60 s; its console:\n${consoleLines.join('\n')}`);
    const harnessLines = consoleLines.length;
    const { contentSize } = await page.send('Page.getLayoutMetrics');
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 } });
    writeFileSync(join(OUT, 'agent-view.png'), Buffer.from(shot.data, 'base64'));

    // EA-V6, the studio itself, its GPU still off: the panel mounts only behind ?agent=1, before WebGPU is asked for,
    // above h1's trace in Developer view, with h1's Create as it was; without the flag, none of the agent path loads.
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
    const studio = {};
    for (const [label, query] of [['agent', '?agent=1&source=mock'], ['plain', '?source=mock']]) {
        await page.send('Page.navigate', { url: `${origin}/studio.html${query}` });
        let seen = null;
        for (let i = 0; i < 50 && !seen?.settled; i++) {
            await sleep(200);
            seen = await evaluate(`(() => {
                const panel = document.querySelector('#left > .agent');
                const trace = document.querySelector('#left > .trace');
                const forge = document.querySelector('.btn-forge');
                const loaded = performance.getEntriesByType('resource').map(e => new URL(e.name).pathname);
                return {
                    settled: !!forge && (${label === 'agent'} ? !!panel : document.readyState === 'complete'),
                    panel: !!panel,
                    aboveTrace: !!(panel && trace && (panel.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING)),
                    dev: document.body.classList.contains('dev'),
                    status: panel?.querySelector('.agent-phase')?.textContent ?? null,
                    forge: forge?.textContent ?? null,
                    agentCode: loaded.filter(n => /agent-(view|stream|client|turn)|contract\\/agent/.test(n)),
                    gpu: document.querySelector('#gpu-pill')?.textContent ?? null,
                };
            })()`);
        }
        studio[label] = seen;
    }
    await sleep(1000); // a late-loading agent chunk would show on the plain page now
    studio.plainLate = await evaluate(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(n => /agent-(view|stream|client|turn)|contract\\/agent/.test(n))`);
    const a = studio.agent ?? {};
    const p = studio.plain ?? {};
    result.checks.push({
        name: 'EA-V6 the studio mounts the panel only behind ?agent=1: above h1\'s trace, in Developer view, h1\'s Create as it was',
        ok: !!(a.panel && a.aboveTrace && a.dev && /^(No backend|No turn yet)$/.test(a.status ?? '') && /Create world/.test(a.forge ?? '')
            && !p.panel && !p.dev && p.agentCode?.length === 0 && studio.plainLate?.length === 0 && /Create world/.test(p.forge ?? '')),
        detail: studio,
    });
    result.ok = result.ok && result.checks.at(-1).ok;
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ...result, console: consoleLines.slice(0, harnessLines), studioConsole: consoleLines.slice(harnessLines) }, null, 1));
    for (const c of result.checks ?? []) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `\n     ${JSON.stringify(c.detail).slice(0, 600)}`}`);
    if (result.error) console.log(`the page failed: ${result.error}`);
    // The harness page's console only: the studio's own lines (a missing WebGPU, say) are kept, not judged.
    const errors = consoleLines.slice(0, harnessLines).filter(l => /^(error|exception)/.test(l) && !/^error: \[av\] FAIL/.test(l));
    if (errors.length) console.log(`console errors:\n  ${errors.join('\n  ')}`);
    const passed = (result.checks ?? []).filter(c => c.ok).length;
    console.log(`\nagent-view: ${passed}/${(result.checks ?? []).length} checks${result.ok && !errors.length ? '' : ', FAILED'}; traps ${JSON.stringify(result.trap)}; WebGPU exposed: ${result.webgpuExposed}`);
    console.log(`${result.browser}\nevidence in ${OUT}`);
    failed = !result.ok || errors.length > 0;
} catch (e) {
    console.error(`agent-view: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
