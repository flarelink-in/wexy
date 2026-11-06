// The account drive (W2; docs/creations-platform-design.md §14 W2's demo, PL-FE3): the studio against a running local
// gateway and the platform service, in headless Chrome with the GPU off (no world is made: W2 calls no model), walking
// W2's demo as a creator would. A fresh browser signs in (the loopback dev identity: dev.google.<uid>), and its account
// is set up; it chooses a handle, typed in mixed case, and the header says @handle; a reload shows it at once (the
// session's one-bit hint); the platform service is stopped and started again on the same MariaDB, and a reload still
// shows it; a second fresh browser asks for the same handle in another case and is told it is taken, at phone width,
// where the handle's claim sits under the idea box and the page stays within 390 px; the first signs out, and a reload
// loads nothing. Screenshots and steps.json go to dev/out/drive-account/<time>/. Exits 1 when a step fails, 2 when the
// stack is not ready.
//
//   node dev/drive-account.mjs [--gateway http://localhost:8400] [--platform-jar <jar>] [--platform-port 8430]
//                              [--chrome path] [--out dir] [--gpu]
//
// Local only: the gateway under the local profile (dev tokens; started by you), compose.local.yaml's MariaDB on 3316
// and Redis on 6390, and the platform service, which this drive starts from its jar under the local profile and
// restarts itself (any platform already listening on the port is refused, so the restart is this drive's own). Forge
// need not run: the allowance chip then says "Allowance unavailable", which W2 does not look at. Handles accumulate in
// the local database, so each run claims a fresh one.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gateway = opt('gateway', 'http://localhost:8400').replace(/\/+$/, '');
const platformPort = Number(opt('platform-port', '8430'));
const platformJar = resolve(opt('platform-jar', join(ROOT, '..', 'wexy backend', 'platform-service', 'target', 'platform-service-0.1.0-SNAPSHOT.jar')));
const useGpu = argv.includes('--gpu');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(gateway)) { console.error(`drive-account: ${gateway} is not a loopback gateway; this drive is local only.`); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('drive-account: no Chrome found; pass --chrome <path>.'); await quit(2); }
if (!existsSync(platformJar)) { console.error(`drive-account: no platform jar at ${platformJar} (./mvnw -pl platform-service -am package).`); await quit(2); }

const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-account', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
mkdirSync(OUT, { recursive: true });
const steps = [];
const save = done => writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gateway, platformPort, done, steps }, null, 1));
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); save(false); };

const status = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(5000) })).status; } catch { return 0; } };
if (await status(`${gateway}/actuator/health`) !== 200) { console.error(`drive-account: the gateway at ${gateway} is not ready (start it under the local profile, Redis up).`); await quit(2); }
const platformHealth = `http://localhost:${platformPort}/actuator/health`;
if (await status(platformHealth) !== 0) { console.error(`drive-account: something already answers on ${platformPort}; stop it, so this drive's restart is its own.`); await quit(2); }

// --- The platform service, this drive's own: started, stopped and started again on the same database. ---
let platform = null;
let platformRuns = 0;
async function startPlatform() {
    const log = openSync(join(OUT, `platform-${++platformRuns}.log`), 'w');
    platform = spawn('java', ['-Xmx384m', '-jar', platformJar, '--spring.profiles.active=local', `--server.port=${platformPort}`],
        { cwd: dirname(platformJar), stdio: ['ignore', log, log] });
    for (let i = 0; i < 240; i++) {
        if (await status(platformHealth) === 200) return true;
        if (platform.exitCode !== null) break;
        await sleep(500);
    }
    return false;
}
async function stopPlatform() {
    if (!platform || platform.exitCode !== null) return;
    spawnSync('taskkill', ['/PID', String(platform.pid), '/T', '/F']);
    for (let i = 0; i < 60 && (await status(platformHealth)) !== 0; i++) await sleep(250);
}

// Vite for the studio, told the gateway through the environment, with no Firebase config: the loopback dev identity.
// The main checkout's git-ignored .env.local holds the dev project's Firebase and App Check keys: each is blanked.
const NO_FIREBASE = { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_AUTH_DOMAIN: '', VITE_FIREBASE_PROJECT_ID: '', VITE_FIREBASE_APP_ID: '', VITE_APPCHECK_SITE_KEY: '' };
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', 'localhost'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_API_ORIGIN: gateway, ...NO_FIREBASE } });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
const origin = 'http://localhost:5173';

/** A fresh browser: its own profile, so its own dev uid. The GPU off: W2 makes no world. */
async function browser(name) {
    const profile = mkdtempSync(join(tmpdir(), `wexy-account-${name}-`));
    const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
        '--window-size=1280,800', ...(useGpu ? ['--enable-unsafe-webgpu'] : ['--disable-gpu']), 'about:blank'], { stdio: 'ignore' });
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

const studioReady = `!!document.querySelector('.account') && !!document.querySelector('#prompt')`;
const who = `(() => { const w = document.querySelector('.account-who'); return w && !w.hidden ? w.textContent : null; })()`;
const claimShown = `(() => { const b = document.querySelector('.account-claim'); return !!b && !b.hidden; })()`;
const handleDialog = `(() => { const d = [...document.querySelectorAll('.account-dialog')].find(d => d.open && d.querySelector('input')); return d ? { title: d.querySelector('h2')?.textContent, error: d.querySelector('.acct-error')?.hidden ? null : d.querySelector('.acct-error')?.textContent } : null; })()`;
const toast = `document.querySelector('#toast')?.textContent ?? ''`;
const hint = `localStorage.getItem('wexy.googleSession')`;

/** Opens the handle dialog with `claimButton` (a selector), types `handle`, presses Claim. */
async function claim(b, claimButton, handle) {
    await b.evaluate(`document.querySelector(${JSON.stringify(claimButton)}).click()`);
    await b.waitFor(`!!(${handleDialog})`, 10000, 'the handle dialog');
    await b.evaluate(`(() => { const d = [...document.querySelectorAll('.account-dialog')].find(d => d.open && d.querySelector('input'));
        d.querySelector('input').value = ${JSON.stringify(handle)};
        [...d.querySelectorAll('button')].find(x => x.textContent === 'Claim').click(); return true; })()`);
}

const handle = `w2_${Math.random().toString(36).slice(2, 8)}`;
const browsers = [];
try {
    let viteUp = false;
    for (let i = 0; i < 100 && !viteUp; i++) { try { viteUp = (await fetch(`${origin}/studio.html`)).ok; } catch { /* starting */ } if (!viteUp) await sleep(200); }
    if (!viteUp) throw new Error(`Vite did not answer on ${origin}\n${viteOut}`);
    step('the platform service starts on the local MariaDB (its migrations run)', await startPlatform(), { jar: platformJar });

    // 1. A fresh browser signs in: its account is set up, and a handle is offered.
    const a = await browser('first');
    browsers.push(a);
    await a.send('Page.navigate', { url: `${origin}/studio.html` });
    await a.waitFor(studioReady, 60000, 'the studio');
    step('a fresh browser holds no hint, and its header offers Sign in alone', (await a.evaluate(hint)) === null && (await a.evaluate(who)) === null);
    await a.evaluate(`[...document.querySelectorAll('.account button')].find(b => b.getAttribute('aria-label') === 'Sign in with Google').click()`);
    await a.waitFor(claimShown, 15000, 'Choose a handle');
    step('after Sign in the account is set up: "Signed in with Google", and Choose a handle', (await a.evaluate(who)) === 'Signed in with Google' && await a.evaluate(claimShown),
        { who: await a.evaluate(who) });
    await a.shot('01-signed-in');

    // 2. It claims a handle, typed in mixed case: the header says it, lowercase.
    const typed = handle.slice(0, 4).toUpperCase() + handle.slice(4);
    await claim(a, '.account-claim', typed);
    await a.waitFor(`${who} === '@${handle}'`, 15000, 'the claimed handle');
    step(`the handle is claimed as typed (${typed}) and shown lowercase`, (await a.evaluate(who)) === `@${handle}` && !(await a.evaluate(claimShown)) && !(await a.evaluate(handleDialog)),
        { who: await a.evaluate(who), toast: await a.evaluate(toast) });
    await a.shot('02-claimed');

    // 3. A reload shows it at once: the session's hint, no click.
    await a.send('Page.reload');
    await a.waitFor(studioReady, 60000, 'the studio after a reload');
    await a.waitFor(`${who} === '@${handle}'`, 15000, 'the handle after a reload');
    step('a reload shows @handle at once, with no click', (await a.evaluate(who)) === `@${handle}` && (await a.evaluate(hint)) === '1');

    // 4. The platform service is stopped and started again: the account is still there.
    await stopPlatform();
    step('the platform service stopped', (await status(platformHealth)) === 0);
    step('…and started again on the same database', await startPlatform());
    await a.send('Page.reload');
    await a.waitFor(studioReady, 60000, 'the studio after the restart');
    await a.waitFor(`${who} === '@${handle}'`, 15000, 'the handle after the restart');
    step('after the restart, a reload still shows @handle', (await a.evaluate(who)) === `@${handle}`);
    await a.shot('03-after-restart');

    // 5. A second fresh browser, at phone width, asks for the same handle in another case: taken.
    const b = await browser('second');
    browsers.push(b);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await b.send('Page.navigate', { url: `${origin}/studio.html` });
    await b.waitFor(studioReady, 60000, 'the studio at 390 px');
    await b.evaluate(`[...document.querySelectorAll('.account button')].find(b => b.getAttribute('aria-label') === 'Sign in with Google').click()`);
    const phoneClaim = `(() => { const b = document.querySelector('.account-line-claim'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; })()`;
    await b.waitFor(phoneClaim, 15000, 'Choose a handle under the idea box');
    const width = await b.evaluate('document.documentElement.scrollWidth');
    step('at 390 px the claim sits under the idea box, out of the header, and the page fits', await b.evaluate(phoneClaim)
        && (await b.evaluate(`getComputedStyle(document.querySelector('.account-claim')).display`)) === 'none' && width <= 390, { width });
    await claim(b, '.account-line-claim', handle.toUpperCase());
    await b.waitFor(`(${handleDialog})?.error === "That handle is taken. Try another."`, 15000, 'the taken handle\'s sentence');
    step('the same handle in another case is taken, said in the dialog, which stays open', (await b.evaluate(handleDialog))?.error === 'That handle is taken. Try another.',
        await b.evaluate(handleDialog));
    await b.shot('04-taken-at-390');
    await b.close();
    browsers.splice(browsers.indexOf(b), 1);

    // 6. The first signs out: the hint goes, and a reload loads nothing.
    await a.evaluate(`[...document.querySelectorAll('.account button')].find(b => b.textContent === 'Sign out').click()`);
    await a.waitFor(`${who} === null`, 15000, 'signed out');
    step('signed out: no handle, and no hint', (await a.evaluate(who)) === null && (await a.evaluate(hint)) === null);
    await a.send('Page.reload');
    await a.waitFor(studioReady, 60000, 'the studio after signing out');
    await sleep(1500);
    step('a reload after signing out shows Sign in alone', (await a.evaluate(who)) === null);
    const exceptions = browsers.flatMap(x => x.lines.filter(l => l.type === 'exception'));
    step('no page threw', exceptions.length === 0, exceptions.slice(0, 3));
} catch (error) {
    step('the drive ran to its end', false, String(error?.stack ?? error).slice(0, 400));
} finally {
    for (const b of browsers) await b.close();
    await stopPlatform();
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    save(true);
    const failed = steps.filter(s => !s.ok);
    console.log(`${steps.length - failed.length}/${steps.length} steps passed; ${OUT}`);
    await quit(failed.length ? 1 : 0);
}
