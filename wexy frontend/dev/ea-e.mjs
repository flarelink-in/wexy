// EA5.4's EA-E on one real GPU (executor-design.md §10, §13): the studio itself under ?agent=1, end to end, with no paid
// call. A local stand-in gateway answers the agent routes from the backend's own recordings: the turn is
// test/fixtures/agent-wire/handed-off.sse with its program made galaxy's (a live world inside the shipped eligibility),
// and each module call is answered with galaxy's sealed body in the recorded module stream's shape, except galaxySpin's
// first answer: a body that passes the host's lint (L1, L2) and fails the device's compiler (L3), so the candidate loop
// routes it to a repair, which the stand-in answers with the good body (EA-G2's "a body L3 refuses, repaired"). The
// studio runs on Vite with that gateway as its origin and no Firebase config, so it signs nothing in and sends the
// backend's local dev token; Chrome runs on one GPU with its WebGPU developer features, so the environment is the
// exact model the shipped eligibility names.
//   - h1 first: a starter world on the stage;
//   - the agent turn, Write the modules (L3 refuses one body, the repair passes), Run on this GPU; the old world draws
//     while the agent world is checked and built (P8); the agent world on the stage, with its studio state (§5);
//   - back to h1 with a starter, which retires the agent world;
//   - a device loss (the GPU process crashed, chrome://gpucrash): the studio says so; a reload, and a starter world on
//     the stage again (the known-good fallback, §9).
// A screenshot of every state and steps.json go to dev/out/ea-e/<gpu>-<time>/. Exit 0 when every step passes and the
// console holds no error before the crash; 1 otherwise; 2 when Chrome or Vite cannot start. On the charger only.
//   node dev/ea-e.mjs --gpu amd|nvidia [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea-e: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea-e: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea-e', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); };

// ---- the stand-in gateway: the backend's recordings, answered as the backend answers them ----------------------------
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const galaxy = JSON.parse(fixture('test/fixtures/live-candidates/galaxy.json'));
const handedOff = fixture('test/fixtures/agent-wire/handed-off.sse');
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
/** A recording with its `name` event's data rewritten. */
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
const turn = edit(handedOff, 'program', () => ({ program: { nodes: galaxy.program.nodes } }));
const goodBody = id => galaxy.modules.find(m => m.module === id)?.body ?? null;
/** galaxySpin's first answer: the host's lint passes it; the device's compiler refuses its type error. */
const l3Fails = goodBody('galaxySpin').replace(/(fn spinGalaxy\(index: u32\) \{\n)/, '$1    let wrongType: f32 = vec2<f32>(1.0, 2.0);\n');
/**
 * A module stream for `call`: the recording's meta, every field the browser holds to its job echoed (its turn and job,
 * purpose, subject, versions, module and interfaceHash: module-stream.ts readMeta), the recording's usage, `answer`, its
 * own done.
 */
function moduleStream(call, answer) {
    const meta = JSON.parse(moduleWire.match(/^event:meta\ndata:(.*)$/m)[1]);
    const usage = JSON.parse(moduleWire.match(/^event:usage\ndata:(.*)$/m)[1]);
    const sha = createHash('sha256').update(answer, 'utf8').digest('hex');
    const half = Math.floor(answer.length / 2);
    return [['meta', {
        ...meta, turnId: call.turnId, jobId: call.jobId, purpose: call.purpose, subject: call.subject, versions: call.versions,
        module: call.module.id, interfaceHash: call.module.interface.interfaceHash,
    }],
        ['delta', { text: answer.slice(0, half) }], ['delta', { text: answer.slice(half) }], ['usage', usage],
        ['done', { status: 'ok', answerSha256: sha, answerChars: answer.length }]].map(([e, d]) => `event:${e}\ndata:${JSON.stringify(d)}\n\n`).join('');
}
const calls = [];
const VITE_PORT = 5199;
const GATEWAY_PORT = 5198;
const studioOrigin = `http://127.0.0.1:${VITE_PORT}`;
const gateway = createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': studioOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization, content-type', 'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
        const sse = text => { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.end(text); };
        if (req.method === 'POST' && req.url === '/v1/agent/turn') {
            calls.push({ route: 'turn', authorization: (req.headers.authorization ?? '').replace(/(dev\.anonymous\.).*/, '$1…') });
            sse(turn);
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/agent/module') {
            const call = JSON.parse(body);
            const id = call.module?.id;
            const first = call.purpose === 'author' && id === 'galaxySpin' && !calls.some(c => c.route === 'module' && c.module === id);
            const answer = first ? l3Fails : goodBody(id);
            calls.push({ route: 'module', module: id, purpose: call.purpose, previousFindings: call.previous?.findings?.map(f => `${f.rung} ${f.code}`) ?? null, l3Fails: first });
            if (answer === null) { res.writeHead(404, cors); res.end('{}'); return; }
            sse(moduleStream(call, answer));
            return;
        }
        calls.push({ route: `${req.method} ${req.url}`, unexpected: true });
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end('{"error":{"code":"not_found"}}');
    });
});
await new Promise(r => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));

// ---- Vite for the studio, the stand-in as its origin, no Firebase: the local dev identity -----------------------------
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_API_ORIGIN: `http://127.0.0.1:${GATEWAY_PORT}`, VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_AUTH_DOMAIN: '', VITE_FIREBASE_PROJECT_ID: '', VITE_FIREBASE_APP_ID: '', VITE_APPCHECK_SITE_KEY: '' },
});
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${studioOrigin}/studio.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
const stopAll = () => { gateway.close(); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); };
if (!up) { console.error(`ea-e: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea-e-'));
// EA-G1's flags, and --enable-gpu-benchmarking: with it, a typed navigation to chrome://gpucrash crashes the GPU process
// (Chrome's own GPU tests drive it so), which no page script can do.
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--enable-gpu-benchmarking', '--no-first-run', '--window-size=1600,1000', '--disable-features=BackForwardCache',
    ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
let browserPort = null;
let target = null;
for (let i = 0; i < 150 && !target; i++) {
    try {
        browserPort = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        target = (await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json()).find(t => t.type === 'page');
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
    let crashedAt = Infinity;
    page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ at: Date.now(), line: `${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}` });
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ at: Date.now(), line: `exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}` });
    });
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const until = async (expression, ms = 20_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await evaluate(expression)) return true;
        return false;
    };
    let shots = 0;
    const shot = async name => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
    };
    const click = label => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => !b.hidden && (b.textContent ?? '').trim().startsWith(${JSON.stringify(label)})); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
    const starter = label => evaluate(`(() => { const b = [...document.querySelectorAll('.examples-chips .chip')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const studio = `${studioOrigin}/studio.html?agent=1&dev=1`;

    await page.send('Page.navigate', { url: studio });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && [...document.querySelectorAll('.cand button')].some(b => b.textContent === 'Run on this GPU' && !b.hidden)`, 30_000);
    const gpuLabel = await text('#gpu-pill');
    step('the studio starts under ?agent=1: its GPU, the agent panel, the candidate panel with Run on this GPU', started, { gpu: gpuLabel });

    // h1 first: a starter world on the stage (the playground's example: no backend).
    await starter('Galaxy');
    const h1 = await until(`document.querySelector('#empty')?.hidden && /\\S/.test(document.querySelector('#hud-title')?.textContent ?? '') && !document.querySelector('#btn-export')?.disabled`, 60_000);
    const h1Title = await text('#hud-title');
    step('h1 first: a starter world on the stage, Film and Photo offered', h1, { title: h1Title });
    await shot('h1-world');

    // The agent turn, over the backend's recorded hand-off (its program galaxy's).
    await click('Run agent turn');
    const handed = await until(`document.querySelector('.agent')?.dataset.phase === 'handed-off'`, 30_000);
    step('the agent turn hands off (the recorded wire, its program galaxy\'s)', handed, { phase: await evaluate(`document.querySelector('.agent')?.dataset.phase`) });

    // Write the modules: galaxySpin's first body fails L3 on the device; its repair passes; the candidate is sealed.
    await click('Write the modules');
    const sealed = await until(`['static-verified', 'failed', 'exhausted'].includes(document.querySelector('.cand')?.dataset.phase)`, 90_000);
    // galaxySpin's row as a person reads it: its head, then each verdict about it, oldest first (candidate-view moduleRow).
    const cand = await evaluate(`(() => {
        const c = document.querySelector('.cand');
        const row = c.querySelector('.cand-module[data-module="galaxySpin"]');
        return {
            phase: c.dataset.phase, l3: c.dataset.l3, status: c.querySelector('.cand-phase')?.textContent, reason: c.querySelector('.cand-reason')?.textContent || null,
            spinHead: row?.querySelector('.cand-module-head')?.textContent ?? null,
            spinVerdicts: row ? [...row.querySelectorAll('.cand-verdict')].map(v => (v.textContent ?? '').slice(0, 240)) : [],
        };
    })()`);
    const spinCalls = calls.filter(c => c.route === 'module' && c.module === 'galaxySpin');
    step('Write the modules: sealed and compiled on this device', sealed && cand.phase === 'static-verified' && cand.l3 === 'device', cand);
    const failedAt = cand.spinVerdicts.findIndex(v => /^compile fail \(device/.test(v) && /L3 on the body/.test(v));
    const passedAt = cand.spinVerdicts.findIndex(v => /^compile pass \(device, current\)/.test(v));
    step('a body L3 refuses on the device is repaired (EA-G2): galaxySpin authored, refused by L3 on the body, repaired, passed',
        spinCalls.length === 2 && spinCalls[0].purpose === 'author' && spinCalls[0].l3Fails && spinCalls[1].purpose === 'repair'
        && (spinCalls[1].previousFindings ?? []).some(f => f === 'L3 compile') && /· passed · 2 calls, 1 repair/.test(cand.spinHead ?? '')
        && failedAt >= 0 && passedAt > failedAt,
        { spinCalls, head: cand.spinHead, verdicts: cand.spinVerdicts });
    await shot('candidate-sealed');

    // Run on this GPU: the old world draws on while the agent world is built (P8: frames go on while its pipelines
    // compile), then the switch. It holds only while the probe times a submission (its quiet windows). The HUD writes its
    // fps only from a drawn frame (at most every 250 ms), so its writes while the Run runs are frames the old world drew
    // then; each is counted in the page, as it happens, with the longest gap between them.
    await evaluate(`(() => {
        const hud = document.querySelector('#hud-fps');
        window.__p8 = { writes: 0, values: [], at: [], title: document.querySelector('#hud-title')?.textContent, began: 0, ended: 0 };
        new MutationObserver(() => {
            if (document.querySelector('.cand')?.dataset.run !== 'running') return;
            window.__p8.writes++;
            window.__p8.values.push(hud.textContent);
            window.__p8.at.push(performance.now());
        }).observe(hud, { childList: true, characterData: true, subtree: true });
        new MutationObserver(() => {
            const run = document.querySelector('.cand')?.dataset.run;
            if (run === 'running' && !window.__p8.began) window.__p8.began = performance.now();
            if (run !== 'running' && window.__p8.began && !window.__p8.ended) window.__p8.ended = performance.now();
        }).observe(document.querySelector('.cand'), { attributes: true, attributeFilter: ['data-run'] });
        return true;
    })()`);
    await click('Run on this GPU');
    await until(`!['running', 'idle'].includes(document.querySelector('.cand')?.dataset.run)`, 120_000);
    const run = await evaluate(`({ run: document.querySelector('.cand')?.dataset.run, line: document.querySelector('.cand-run')?.textContent })`);
    step('Run on this GPU installs the agent world', run.run === 'installed', run);
    const p8 = await evaluate('window.__p8');
    const ranMs = Math.round(p8.ended - p8.began);
    const marks = [p8.began, ...p8.at, p8.ended];
    const longestGapMs = Math.round(Math.max(...marks.slice(1).map((t, i) => t - marks[i])));
    step('the old world drew during the Run (P8), holding only while the probe timed a submission: the HUD written from drawn frames',
        p8.writes >= 2 && p8.values.every(v => /^[1-9]\d* fps$/.test(v ?? '')),
        { ranMs, writes: p8.writes, longestGapMs, fps: p8.values.slice(0, 12), worldOnStage: p8.title });
    await sleep(1500);
    const agentState = await evaluate(`({
        title: document.querySelector('#hud-title')?.textContent, count: document.querySelector('#hud-count')?.textContent, fps: document.querySelector('#hud-fps')?.textContent,
        exportOn: !document.querySelector('#btn-export')?.disabled, photoOn: !document.querySelector('#btn-snapshot')?.disabled, captureBarShown: !document.querySelector('#capture-bar')?.hidden,
        director: document.querySelector('.director .inspector-empty p')?.textContent ?? null,
    })`);
    step('the agent world on the stage, with its studio state: its title, Film and Photo offered (EA5.5), the Director\'s note (§5)',
        /^Agent world [0-9a-f]{12}…$/.test(agentState.title ?? '') && agentState.exportOn && agentState.photoOn && agentState.captureBarShown
        && /agent program/.test(agentState.director ?? '') && /^[1-9]\d* fps$/.test(agentState.fps ?? ''), agentState);
    await shot('agent-world');

    // Back to h1: a starter retires the agent world.
    await starter('Galaxy');
    const back = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(h1Title)} && !document.querySelector('#btn-export')?.disabled && !document.querySelector('#capture-bar')?.hidden`, 60_000);
    step('back to h1: a starter world replaces the agent world, Film and Photo offered again', back, { title: await text('#hud-title') });
    await shot('back-to-h1');
    const beforeCrash = consoleLines.filter(l => /^(error|exception)/.test(l.line)).map(l => l.line);
    step('no console error through the turn, the Run and the return to h1', beforeCrash.length === 0, beforeCrash.slice(0, 5));

    // A device loss: the GPU process crashed. The studio says so; a reload, and a starter world on the stage again.
    crashedAt = Date.now();
    const crashTarget = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' })).json();
    const crash = connect(crashTarget.webSocketDebuggerUrl);
    await crash.ready;
    await crash.send('Page.enable');
    await crash.send('Page.navigate', { url: 'chrome://gpucrash', transitionType: 'typed' }).catch(e => consoleLines.push({ at: Date.now(), line: `gpucrash: ${e.message}` }));
    const said = await until(`/graphics card stopped responding/.test(document.querySelector('#viewport-msg')?.textContent ?? '')`, 30_000);
    step('a device loss (the GPU process crashed): the studio says so', said, { message: await text('#viewport-msg') });
    // The crash's tab closed and the studio's in front again: a background tab's timers and frames are throttled.
    crash.close();
    await fetch(`http://127.0.0.1:${browserPort}/json/close/${crashTarget.id}`).catch(() => {});
    await page.send('Page.bringToFront');
    await shot('device-lost');
    await page.send('Page.reload');
    // The GPU pill says "Starting WebGPU…" until the device exists; its mark once the viewport runs.
    const restarted = await until(`!!document.querySelector('#gpu-pill i.ok') && !!document.querySelector('.examples-chips .chip')`, 30_000);
    await starter('Galaxy');
    const recovered = restarted && await until(`document.querySelector('#empty')?.hidden && document.querySelector('#hud-title')?.textContent === ${JSON.stringify(h1Title)}`, 60_000);
    step('recovered: after a reload, a starter world on the stage again (the known-good fallback)', recovered, {
        title: await text('#hud-title'),
        steps: recovered ? undefined : await evaluate(`[...document.querySelectorAll('.trace-list > li')].map(li => (li.className + ': ' + (li.innerText ?? '')).replace(/\\s+/g, ' ').slice(0, 200))`),
        message: recovered ? undefined : await text('#viewport-msg'),
    });
    await shot('recovered');

    const unexpected = calls.filter(c => c.unexpected);
    step('the stand-in gateway was asked only for the agent routes', unexpected.length === 0, unexpected);
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, steps, calls, console: consoleLines.map(l => `${l.at >= crashedAt ? '[after the crash] ' : ''}${l.line}`) }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea-e (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
} catch (e) {
    console.error(`ea-e: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopAll();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
