// The allowance drive (W1; docs/creations-platform-design.md §11 PL-FE8, §14 W1's demo): the studio against a running
// local backend, in headless Chrome on one GPU, walking W1's demo as a creator would. A fresh browser makes one world;
// its next Create opens the limit dialog, the idea and the world kept; Sign in (the loopback dev identity: the same
// uid, now dev.google) gives early access, the chip says "Early access: 1 world today"; a recorded unsafe idea is
// refused with no model call charged and the day's world still unspent; one world, then the chip's reset time, and
// the next Create's dialog says when the next opens; a second fresh browser on the same network meets the dialog at
// once; an allow-listed uid (the gateway's local operator, or --admin-uid) makes three worlds in a row. Screenshots
// and steps.json go to dev/out/drive-allowance/<gpu>-<time>/. Exits 1 when a step fails, 2 when the backend is not up.
//
//   node dev/drive-allowance.mjs [--gpu nvidia] [--gateway http://localhost:8400] [--service http://localhost:8410]
//                                [--admin-uid <32 hex>|none] [--keep] [--timeout 300] [--out dir] [--chrome path]
//
// Local only, mock only: the gateway under the local profile with no Firebase credentials (dev tokens; its local
// operator, 000…001, is on its admin list unless WEXY_ADMIN_UIDS replaces it), the service under local,mock (no key, no spend), Redis from
// compose.local.yaml. Before it starts it clears the allowance keys (wexy:allow:*, wexy:grant:*) in that Redis with
// redis-cli inside its container (docker exec), since every local browser shares one network (127.0.0.1); --keep
// leaves them. It refuses a gateway off loopback.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gpu = opt('gpu', 'amd');
const gateway = opt('gateway', 'http://localhost:8400').replace(/\/+$/, '');
const service = opt('service', 'http://localhost:8410').replace(/\/+$/, '');
/** The gateway's local operator (its application-local.yaml admin list) unless another uid is given; `--admin-uid none` skips. */
const adminUid = opt('admin-uid', '00000000000000000000000000000001') === 'none' ? null : opt('admin-uid', '00000000000000000000000000000001');
const timeoutMs = Number(opt('timeout', '300')) * 1000;
const GALAXY = 'A spiral galaxy, gold at the core and blue along the arms, threaded with dark dust';
const STORM = 'A dark thunderstorm cloud that churns and turns in place while lightning flickers inside it';
/** A recorded refusal of the local profile's content safety (forge-service resources/mock/safety-refusals.txt). */
const UNSAFE = 'a bloody massacre of villagers at dawn';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(gateway)) { console.error(`drive-allowance: ${gateway} is not a loopback gateway; this drive is local only.`); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('drive-allowance: no Chrome found; pass --chrome <path>.'); await quit(2); }

const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-allowance', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); save(false); };

// The backend: the gateway's health (200 means it and Redis are up), and its CORS for the studio's origin.
const status = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(5000) })).status; } catch { return 0; } };
if (await status(`${gateway}/actuator/health`) !== 200) { console.error(`drive-allowance: the gateway at ${gateway} is not ready (start it under the local profile, Redis up).`); await quit(2); }
if (await status(`${service}/actuator/health`) !== 200) { console.error(`drive-allowance: the service at ${service} is not ready (start it under local,mock).`); await quit(2); }

/** The service's allowed charges so far, from its Prometheus scrape: a refusal must leave it unchanged. */
async function allowedCharges() {
    const text = await (await fetch(`${service}/actuator/prometheus`, { signal: AbortSignal.timeout(5000) })).text();
    return text.split('\n').filter(l => l.startsWith('wexy_spend_charges_total') && l.includes('outcome="allowed"'))
        .reduce((n, l) => n + Number(l.trim().split(/\s+/).pop()), 0);
}

// Every local browser shares one network (127.0.0.1), so a run starts from no allowance taken, unless --keep.
if (!argv.includes('--keep')) {
    const ps = spawnSync('docker', ['ps', '--filter', 'publish=6390', '--format', '{{.Names}}'], { encoding: 'utf8' });
    const container = ps.stdout?.trim().split('\n')[0];
    if (!container) { console.error('drive-allowance: no Redis container publishing 6390 (compose.local.yaml); start it, or pass --keep.'); await quit(2); }
    let cleared = 0;
    for (const pattern of ['wexy:allow:*', 'wexy:grant:*']) {
        const keys = spawnSync('docker', ['exec', container, 'redis-cli', '--scan', '--pattern', pattern], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
        for (const key of keys) { spawnSync('docker', ['exec', container, 'redis-cli', 'DEL', key]); cleared++; }
    }
    console.log(`drive-allowance: cleared ${cleared} allowance key(s) in ${container}`);
}

// Vite for the studio, told the gateway through the environment, with no Firebase config: the loopback dev identity.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', 'localhost'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_API_ORIGIN: gateway, VITE_FIREBASE_API_KEY: '' } });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
const origin = 'http://localhost:5173';
let viteUp = false;
for (let i = 0; i < 100 && !viteUp; i++) { try { viteUp = (await fetch(`${origin}/studio.html`)).ok; } catch { /* starting */ } if (!viteUp) await sleep(200); }
if (!viteUp) { console.error(`drive-allowance: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); await quit(2); }

/** A fresh browser: its own profile, so its own dev uid. */
async function browser(name) {
    const profile = mkdtempSync(join(tmpdir(), `wexy-allowance-${name}-`));
    const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
        '--window-size=1280,800', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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
    const lines = [];
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); return; }
        if (m.method === 'Runtime.exceptionThrown') lines.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? '' });
        if (m.method === 'Runtime.consoleAPICalled') lines.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    };
    await new Promise(r => { ws.onopen = r; });
    const send = (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    await send('Page.enable');
    const evaluate = async expression => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    const waitFor = async (expression, ms, what) => {
        for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression).catch(() => false)) return true; await sleep(250); }
        step(`${name}: waited for ${what}`, false, `not within ${Math.round(ms / 1000)} s`);
        return false;
    };
    const shot = async file => writeFileSync(join(OUT, `${file}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const close = async () => {
        ws.close();
        for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
        if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
        await sleep(500);
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    };
    return { name, send, evaluate, waitFor, shot, close, lines };
}

const runEnded = `(() => { const b = document.querySelector('.btn-forge'); return !!b && !b.disabled && document.querySelectorAll('.trace-list .step').length > 0; })()`;
const chip = `document.querySelector('.account-chip')?.hidden ? null : (document.querySelector('.account-chip')?.textContent ?? null)`;
const dialog = `(() => { const d = document.querySelector('.account-dialog'); return d?.open ? { title: d.querySelector('h2')?.textContent, body: d.querySelector('.acct-body')?.textContent, actions: [...d.querySelectorAll('button')].map(b => b.textContent) } : null; })()`;
const promptText = `document.querySelector('#prompt')?.value ?? null`;
const worldTitle = `document.querySelector('#scene-title')?.textContent ?? null`;
const journey = `[...document.querySelectorAll('.journey-step')].map(r => r.querySelector('.journey-detail')?.textContent ?? '').filter(Boolean)`;

/** Types `idea` in the box and presses Create; resolves once the run has ended. */
async function create(b, idea) {
    await b.evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(idea)}; p.dispatchEvent(new Event('input')); document.querySelector('.btn-forge').click(); return true; })()`);
    await sleep(400);
    return b.waitFor(runEnded, timeoutMs, 'the run to end');
}

let gpuLabel = null;
const browsers = [];

/** Writes the steps so far, after every step: a run this laptop cuts short (gotchas) still leaves what it saw. */
function save(done) {
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu: gpuLabel, gpuFlag: gpu, gateway, service, label: 'mock', done, steps }, null, 1));
}

/** Closes a browser whose steps are done, so no more than one renders at a time: three at once made step 7 the
 *  laptop's heaviest minute, and it lost power there (2026-11-02). */
async function retire(b) {
    browsers.splice(browsers.indexOf(b), 1);
    await b.close();
}

try {
    // 1. A fresh browser makes its one world.
    const a = await browser('first');
    browsers.push(a);
    await a.send('Page.navigate', { url: `${origin}/studio.html?prompt=${encodeURIComponent(GALAXY)}` });
    await a.waitFor(`!!document.querySelector('.btn-forge') && !document.querySelector('.btn-forge').disabled`, 60000, 'the studio');
    step('a fresh browser offers Sign in, and no chip before its first Create', await a.evaluate(`(() => !document.querySelector('.account button')?.hidden)()`)
        && (await a.evaluate(chip)) === null);
    await create(a, GALAXY);
    const firstWorld = await a.evaluate(worldTitle);
    await a.waitFor(`${chip} === 'Free world made'`, 15000, 'the chip after the free world');
    step('a fresh browser makes its one free world, and the chip says it is made', firstWorld && firstWorld !== 'Untitled world' && (await a.evaluate(chip)) === 'Free world made', { world: firstWorld, chip: await a.evaluate(chip) });
    gpuLabel = await a.evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    await a.shot('01-free-world');

    // 2. Its next Create: the limit dialog, with Sign in; the idea in the box and the world on stage kept.
    await create(a, STORM);
    await a.waitFor(`!!(${dialog})`, 15000, 'the limit dialog');
    const limited = await a.evaluate(dialog);
    step('its next Create opens the limit dialog with Sign in with Google', limited?.title === "You've made your free world" && limited.actions.includes('Sign in with Google'), limited);
    step('the idea stays in its box and the world on the stage', (await a.evaluate(promptText)) === STORM && (await a.evaluate(worldTitle)) === firstWorld);
    await a.shot('02-limit-dialog');

    // 3. Sign in (the dev identity's link): early access, one world today.
    await a.evaluate(`[...document.querySelectorAll('.account-dialog button')].find(b => b.textContent === 'Sign in with Google').click()`);
    await a.waitFor(`${chip} === 'Early access: 1 world today'`, 15000, 'the early-access chip');
    step('after Sign in, the chip says "Early access: 1 world today"', (await a.evaluate(chip)) === 'Early access: 1 world today', await a.evaluate(chip));
    await a.shot('03-early-access');

    // 4. An unsafe idea, while today's world is still unmade: refused before any model call, nothing charged and no
    //    allowance spent. (With the allowance spent, forge answers the spent allowance first and never asks content
    //    safety: an entry peeks before it checks, so a refused creator costs no Azure call.)
    const before = await allowedCharges();
    await create(a, UNSAFE);
    await a.waitFor(`${journey}.some(d => d === "This idea can't be made here. Try a different one.")`, 15000, 'the refusal');
    step('an unsafe idea is refused in the studio\'s words', (await a.evaluate(journey)).includes("This idea can't be made here. Try a different one."), await a.evaluate(journey));
    step('…with no model call charged', (await allowedCharges()) === before, { before, after: await allowedCharges() });
    step('…and the idea stays in its box', (await a.evaluate(promptText)) === UNSAFE);
    await a.waitFor(`${chip} === 'Early access: 1 world today'`, 15000, 'the chip after the refusal');
    step('…and no allowance spent: the chip still says "Early access: 1 world today"', (await a.evaluate(chip)) === 'Early access: 1 world today', await a.evaluate(chip));
    await a.shot('04-refused');

    // 5. One world, then the reset time.
    await create(a, STORM);
    await a.waitFor(`/^Early access: next world at /.test(${chip} ?? '')`, 15000, 'the reset on the chip');
    step('early access makes one world, and the chip then shows when the next opens', /^Early access: next world at /.test((await a.evaluate(chip)) ?? ''), await a.evaluate(chip));
    await create(a, GALAXY);
    await a.waitFor(`!!(${dialog})`, 15000, 'the quota dialog');
    const quota = await a.evaluate(dialog);
    step("today's second world: the dialog says when the next opens", quota?.title === "Today's world is made" && /the next opens at /.test(quota?.body ?? ''), quota);
    await a.shot('05-quota');
    await a.evaluate(`document.querySelector('.account-dialog').close()`);
    step('the first browser: no console exception', a.lines.filter(l => l.type === 'exception').length === 0, a.lines.filter(l => l.type === 'exception').slice(0, 3));
    await retire(a);

    // 6. A second fresh browser on the same network: its first Create meets the dialog (the network's one is spent).
    const b = await browser('second');
    browsers.push(b);
    await b.send('Page.navigate', { url: `${origin}/studio.html?prompt=${encodeURIComponent(GALAXY)}` });
    await b.waitFor(`!!document.querySelector('.btn-forge') && !document.querySelector('.btn-forge').disabled`, 60000, 'the studio');
    await create(b, GALAXY);
    await b.waitFor(`!!(${dialog})`, 15000, 'the limit dialog');
    step('a second browser on the same network is asked to sign in at its first Create', (await b.evaluate(dialog))?.title === "You've made your free world", await b.evaluate(dialog));
    await b.shot('06-second-browser');
    await retire(b);

    // 7. An admin (an allow-listed dev uid, signed in): its own number.
    if (adminUid) {
        const c = await browser('admin');
        browsers.push(c);
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('wexy.devUid', ${JSON.stringify(adminUid)}); localStorage.setItem('wexy.devProvider', 'google');` });
        await c.send('Page.navigate', { url: `${origin}/studio.html?prompt=${encodeURIComponent(GALAXY)}` });
        await c.waitFor(`!!document.querySelector('.btn-forge') && !document.querySelector('.btn-forge').disabled`, 60000, 'the studio');
        const made = [];
        for (const idea of [GALAXY, STORM, GALAXY]) {
            await create(c, idea);
            made.push({ world: await c.evaluate(worldTitle), dialog: await c.evaluate(dialog) });
        }
        step('an admin makes three worlds in a row', made.every(m => !m.dialog), made);
        await c.shot('07-admin');
    }
} finally {
    save(true);
    for (const b of [...browsers]) await b.close();
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    const failed = steps.filter(s => !s.ok).length;
    console.log(`\ndrive-allowance (mock, ${gpuLabel ?? gpu}): ${steps.length - failed}/${steps.length} steps ok — evidence in ${OUT}`);
    await quit(failed ? 1 : 0);
}
