// The loop drive (FE1.5, docs/forge-loop-frontend-design.md §13): the studio against a running backend (dev workflow
// §3 B with the mock Meta, §3 C live), in headless Chrome on one GPU. For each idea it opens the studio with the
// gateway configured, lets Create run the loop, and checks what came back: the Live badge before Create, the plan
// and each function streamed from the backend with a model and tokens on their lines, the world verified on this
// GPU and swapped in labelled Live, the outcome recorded by the backend (202), no console error. Last, a creator
// who leaves mid-stream: the service must record the generation as cancelled. A screenshot per idea, the trace as
// Developer view showed it, the console and steps.json go to dev/out/drive-loop/<label>-<gpu>-<time>/.
// Exits 1 when a step fails, 2 when the backend is not up.
//
//   node dev/drive-loop.mjs [--gpu nvidia] [--label mock|live] [--ideas galaxy,storm] [--prompt "an idea"]...
//                           [--repairs 0|1|any] [--gateway http://localhost:8400] [--service-log path]
//                           [--no-cancel] [--timeout 300] [--out dir] [--chrome path]
//
// The gateway runs under the local profile with no Firebase credentials (dev tokens), the service under local,mock
// (no key, no spend) or local (live: every world spends credit, on the user's go only). The label is the caller's
// word for the numbers: this script cannot tell a mock from a model, and says so in its report.
//
// A deployed gateway (the VPS, through an SSH forward or its public host) keeps its actuator private, so readiness
// is its public mode read instead (F8), and its CORS must allow this drive's studio, http://localhost:5173 (Q55).
// It takes Firebase tokens only: the studio needs the Firebase web config, from .env.local or the environment
// (`infisical run --env=dev -- node dev/drive-loop.mjs --gateway …`), and every world there is live.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const all = n => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const gpu = opt('gpu', 'amd');
const label = opt('label', 'mock');
const gateway = opt('gateway', 'http://localhost:8400').replace(/\/+$/, '');
const serviceLog = opt('service-log', null);
const expectedRepairs = opt('repairs', '0');
const timeoutMs = Number(opt('timeout', '300')) * 1000;
const withCancel = !argv.includes('--no-cancel');
/** The creator's sentence (loop/copy.ts) a scenario is expected to end in; set, no world is expected. */
const expectFailure = opt('expect-failure', null);

/** The studio's own starter ideas: the mock's planner answers the galaxy to one and the storm to the other. */
const IDEAS = {
    galaxy: 'A spiral galaxy, gold at the core and blue along the arms, threaded with dark dust',
    storm: 'A dark thunderstorm cloud that churns and turns in place while lightning flickers inside it',
};
const ideas = [
    ...opt('ideas', all('prompt').length ? '' : 'galaxy,storm').split(',').filter(Boolean).map(name => {
        if (!IDEAS[name]) { console.error(`drive-loop: no idea named "${name}" (${Object.keys(IDEAS).join(', ')}); use --prompt for free text.`); process.exit(2); }
        return { name, idea: IDEAS[name] };
    }),
    ...all('prompt').map((idea, i) => ({ name: `prompt-${i + 1}`, idea })),
];

const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('drive-loop: no Chrome found; pass --chrome <path>.'); process.exit(2); }

const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-loop', `${label}-${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); };

// The backend first. A local gateway's actuator shares its port: health is 503 while the meter (Redis) is down, so
// 200 means the gateway and Redis are up. A deployed gateway answers 404 there (its actuator is on 8401, never
// published), so its readiness is the mode, the public read that crosses the gateway to the service (F8).
const status = async path => { try { return (await fetch(`${gateway}${path}`, { signal: AbortSignal.timeout(5000) })).status; } catch { return 0; } };
// process.exit straight after a few fetch answers trips a libuv assertion in Node 24 on Windows (exit 127 instead of
// the code asked for); a moment's wait lets the connections close first.
const quit = async code => { await sleep(150); process.exit(code); };
const healthStatus = await status('/actuator/health');
const modeStatus = healthStatus === 404 ? await status('/v1/forge/mode') : null;
const readiness = `/actuator/health ${healthStatus}${modeStatus === null ? '' : `, /v1/forge/mode ${modeStatus}`}`;
if (healthStatus !== 200 && modeStatus !== 200) {
    console.error(`drive-loop: the gateway at ${gateway} is not ready (${readiness}). Locally: start it under the local profile, with Redis up. `
        + 'Deployed: the service must serve /v1/forge/mode (since 2026-10-29), and the gateway must reach it.');
    await quit(2);
}
// The studio below runs on http://localhost:5173 and calls the gateway from there: its CORS must allow that origin.
const preflight = await fetch(`${gateway}/v1/forge/plan`, { method: 'OPTIONS', signal: AbortSignal.timeout(5000),
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } }).catch(() => null);
const allowedOrigin = preflight?.headers.get('access-control-allow-origin') ?? null;
if (allowedOrigin !== 'http://localhost:5173' && allowedOrigin !== '*') {
    console.error(`drive-loop: the gateway at ${gateway} does not allow the studio's origin http://localhost:5173 (preflight ${preflight?.status ?? 'unreachable'}, `
        + `allow-origin ${allowedOrigin ?? 'none'}): add it to WEXY_CORS_ALLOWED_ORIGINS on that gateway (Q55).`);
    await quit(2);
}
console.log(`drive-loop: ${gateway} ready (${readiness}; CORS allows http://localhost:5173)`);

// Vite for the studio on the gateway's CORS origin (its local profile allows localhost:5173), told the gateway
// through the environment: no file is written, and a .env.local is not needed for this run.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', 'localhost'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_API_ORIGIN: gateway } });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
const origin = 'http://localhost:5173';
let viteUp = false;
for (let i = 0; i < 100 && !viteUp; i++) { try { viteUp = (await fetch(`${origin}/studio.html`)).ok; } catch { /* starting */ } if (!viteUp) await sleep(200); }
if (!viteUp) { console.error(`drive-loop: Vite did not answer on ${origin} (is another dev server on 5173?)\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-loop-drive-'));
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
const [port] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(s => s.trim());
const browserVersion = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json().then(v => v.Browser).catch(() => null);
function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
/** Every console line and exception since Chrome started, in order; each idea reads the lines after its navigation. */
const consoleLines = [];
const page = connect(target.webSocketDebuggerUrl, m => {
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '' });
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
});
await page.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');

/** A registered App Check debug token (WEXY_APPCHECK_DEBUG_TOKEN, from the environment or .env.local); null when none. */
function appCheckDebugToken() {
    const name = 'WEXY_APPCHECK_DEBUG_TOKEN';
    if (process.env[name]?.trim()) return process.env[name].trim();
    const file = join(ROOT, '.env.local');
    if (!existsSync(file)) return null;
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || null;
}
// A gateway that enforces App Check (D3) refuses what the studio cannot attest, and reCAPTCHA cannot attest localhost.
// A registered debug token goes into the page before any of its scripts runs, and identity.ts keeps it. The SDK logs
// only a token it makes, never one it is given, so the value reaches no console line, screenshot or report.
const appCheckDebug = appCheckDebugToken();
if (appCheckDebug) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `self.FIREBASE_APPCHECK_DEBUG_TOKEN = ${JSON.stringify(appCheckDebug)};` });
}
console.log(`drive-loop: App Check ${appCheckDebug ? 'by a registered debug token, given at run time (not shown)' : 'by what the studio can attest (no debug token given)'}`);

const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const waitFor = async (expression, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression).catch(() => false)) return true; await sleep(250); }
    step(`waited for ${what}`, false, `not within ${Math.round(ms / 1000)} s`);
    return false;
};
const shot = async name => writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const errorsOf = lines => lines.filter(l => l.type === 'error' || l.type === 'exception').map(l => l.text);

/** The trace panel's rows, as Developer view shows them: the title, the actor, the state, the detail and the call's line. */
const readTrace = () => evaluate(`[...document.querySelectorAll('.trace-list .step')].map(s => ({
    title: s.querySelector('.step-title')?.textContent ?? '',
    actor: s.querySelector('.tag')?.textContent ?? '',
    state: [...s.classList].find(c => c.startsWith('is-'))?.slice(3) ?? '',
    detail: s.querySelector('.step-detail')?.textContent ?? '',
    meta: s.querySelector('.step-meta')?.textContent ?? '',
    extra: (s.querySelector('.step-extra')?.innerText ?? '').slice(0, 600),
}))`);
const readHud = () => evaluate(`({
    source: document.querySelector('#hud-source')?.textContent ?? '', hidden: !!document.querySelector('#hud-source')?.hidden,
    fps: document.querySelector('#hud-fps')?.textContent ?? '', res: document.querySelector('#hud-res')?.textContent ?? '',
    count: document.querySelector('#hud-count')?.textContent ?? '', title: document.querySelector('#scene-title')?.textContent ?? '',
    gpu: document.querySelector('#gpu-pill')?.textContent ?? '', cost: document.querySelector('.trace-cost')?.innerText ?? '',
    badge: document.querySelector('#source-badge')?.textContent ?? '', badgeClass: document.querySelector('#source-badge')?.className ?? '',
})`);
/** "Wexy: build 1 "Spiral Galaxy" live (live), 1048576 particles, plan 4120 ms, author 9870 ms, 0 repair(s), 0 auto-fix(es)" */
const BUILD_LINE = /^Wexy: build (\d+) "(.*)" live \((\w+)\), (\d+) particles, plan (\d+) ms, author (\d+) ms, (\d+) repair\(s\), (\d+) auto-fix\(es\)$/;
const loopEnded = `(() => { const b = document.querySelector('.btn-forge'); return document.querySelectorAll('.trace-list .step').length > 0 && !!b && !b.disabled; })()`;

const results = [];
let gpuLabel = null;
try {
    for (const [i, { name, idea }] of ideas.entries()) {
        const since = consoleLines.length;
        const t0 = Date.now();
        await page.send('Page.navigate', { url: `${origin}/studio.html?dev=1&autorun=1&prompt=${encodeURIComponent(idea)}` });
        // Before Create: this build knows the gateway, and says so.
        const badge = await waitFor(`document.querySelector('#source-badge')?.classList.contains('badge-live')`, 30000, `${name}: the Live badge`);
        step(`${name}: the studio knows the gateway, and the badge says Live before Create`, badge, await evaluate(`document.querySelector('#source-badge')?.textContent`).catch(() => null));
        const ended = await waitFor(loopEnded, timeoutMs, `${name}: the loop to end`);
        const loopMs = Date.now() - t0;
        // The outcome report waits four seconds for the preview to settle, then posts; a failed run posts nothing.
        const built = consoleLines.slice(since).map(l => BUILD_LINE.exec(l.text)).find(Boolean);
        if (built) await waitFor(`[...document.querySelectorAll('.trace-list .step')].some(s => s.querySelector('.step-title')?.textContent === 'Report the outcome' && !s.classList.contains('is-running'))`, 30000, `${name}: the outcome report`);
        await sleep(300);
        await shot(`${String(i + 1).padStart(2, '0')}-${name}`);
        const trace = await readTrace();
        const hud = await readHud();
        gpuLabel ??= hud.gpu;
        const lines = consoleLines.slice(since);
        const calls = trace.filter(s => /·/.test(s.meta)).map(s => `${s.title}: ${s.meta}`);
        const plan = trace.find(s => s.title === 'Plan the world');
        const writes = trace.filter(s => s.title.startsWith('Write '));
        const verifies = trace.filter(s => s.title.startsWith('Verify'));
        const repairs = trace.filter(s => s.title.startsWith('Repair '));
        const report = trace.find(s => s.title === 'Report the outcome');
        const modelOn = s => s && s.state === 'ok' && /·\s*\S+\s*·/.test(s.meta) && !/playground example/.test(s.meta);
        const b = built ? { build: Number(built[1]), title: built[2], source: built[3], particles: Number(built[4]), planMs: Number(built[5]), authorMs: Number(built[6]), repairs: Number(built[7]), autofixes: Number(built[8]) } : null;
        if (expectFailure) {
            // The backend refused or broke off, as the scenario asked: no world, the creator's sentence, no exception.
            const journey = await evaluate(`[...document.querySelectorAll('.journey-step')].map(r => ({ state: r.className, title: r.querySelector('.journey-title')?.textContent ?? '', detail: r.querySelector('.journey-detail')?.textContent ?? '' }))`);
            const stopped = trace.filter(s => s.state === 'error' || s.state === 'warn').map(s => `${s.title}: ${s.detail}`);
            step(`${name}: the loop ended without a world and the creator read "${expectFailure}"`, ended && !b && journey.some(r => r.detail === expectFailure), { journey: journey.map(r => `${r.title}: ${r.detail}`), stopped, calls, loopMs });
            step(`${name}: no exception`, lines.filter(l => l.type === 'exception').length === 0, errorsOf(lines).slice(0, 5));
            results.push({ name, idea, loopMs, built: b, calls, trace, hud, console: lines, errors: errorsOf(lines) });
            continue;
        }
        step(`${name}: the plan streamed from the backend, with its model and tokens on the line`, modelOn(plan) && /\d[\d,]* in \/ \d[\d,]* out/.test(plan?.meta ?? ''), plan ? `${plan.state}: ${plan.detail} — ${plan.meta}` : 'no plan step');
        step(`${name}: every function streamed from the backend (${writes.map(w => w.title.slice(6)).join(', ') || 'none'})`, writes.length >= 2 && writes.every(modelOn), writes.map(w => `${w.title}: ${w.state} — ${w.meta}`));
        const lastVerify = verifies.at(-1);
        step(`${name}: the ladder passed on this GPU (${verifies.length} attempt${verifies.length === 1 ? '' : 's'})`, ended && lastVerify?.state === 'ok', lastVerify ? `${lastVerify.detail} — ${lastVerify.meta}` : 'no verify step');
        step(`${name}: the world swapped in, labelled Live`, b?.source === 'live' && hud.source === 'Live' && !hud.hidden, b ? { ...b, hud: { source: hud.source, fps: hud.fps, res: hud.res, count: hud.count } } : { trace: trace.map(s => `${s.title} ${s.state}: ${s.detail}`).slice(-3) });
        if (expectedRepairs !== 'any') step(`${name}: ${expectedRepairs} repair(s) through the backend`, b && b.repairs === Number(expectedRepairs) && repairs.every(r => r.state === 'ok') && repairs.length === Number(expectedRepairs), { repairs: b?.repairs ?? null, steps: repairs.map(r => `${r.title}: ${r.state} — ${r.detail} — ${r.meta}`) });
        step(`${name}: the outcome was recorded by the backend (202)`, report?.state === 'ok' && /202/.test(report.detail), report ? `${report.state}: ${report.detail}` : 'no report step');
        const errors = errorsOf(lines);
        step(`${name}: no console error or exception`, errors.length === 0, errors.slice(0, 5));
        results.push({ name, idea, loopMs, built: b, calls, trace, hud, console: lines, errors });
    }

    // A creator who leaves while the plan streams: the browser drops the request, the gateway drops its upstream
    // call, and the service records the generation as cancelled, with its reservation released (loop design §9).
    if (withCancel) {
        const since = consoleLines.length;
        const t0 = Date.now();
        await page.send('Page.navigate', { url: `${origin}/studio.html?dev=1&autorun=1&prompt=${encodeURIComponent(IDEAS.galaxy)}` });
        const streaming = await waitFor(`/^Streaming the plan/.test(document.querySelector('.trace-list .step .step-detail')?.textContent ?? '')`, 60000, 'the plan to start streaming');
        const leftAt = Date.now();
        await page.send('Page.navigate', { url: 'about:blank' });
        let logged = null;
        if (serviceLog && existsSync(serviceLog)) {
            for (const end = Date.now() + 10000; Date.now() < end && !logged;) {
                await sleep(500);
                const fresh = readFileSync(serviceLog, 'utf8').split(/\r?\n/).filter(l => /cancelled/i.test(l));
                logged = fresh.at(-1) ?? null;
                if (logged && !/plan /i.test(logged)) logged = null;
            }
            step('leaving mid-stream: the service recorded the plan as cancelled', streaming && !!logged, { afterMs: logged ? Date.now() - leftAt : null, line: logged });
        } else {
            step('leaving mid-stream: the request was dropped (the service log was not given, so its record is not judged)', streaming, { note: 'pass --service-log <path> to check the cancel in the service log' });
        }
        results.push({ name: 'cancel', idea: IDEAS.galaxy, loopMs: Date.now() - t0, console: consoleLines.slice(since), logged });
    }
} finally {
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ label, gpu: gpuLabel, gpuFlag: gpu, browser: browserVersion, gateway, readiness, ideas: results, steps }, null, 1));
    page.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(1000);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    const failed = steps.filter(s => !s.ok).length;
    console.log(`\ndrive-loop (${label}, ${gpuLabel ?? gpu}, ${browserVersion ?? 'Chrome'}): ${steps.length - failed}/${steps.length} steps ok — evidence in ${OUT}`);
    process.exit(failed ? 1 : 0);
}
