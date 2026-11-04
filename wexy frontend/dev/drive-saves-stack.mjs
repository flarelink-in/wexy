// W3.7's demo as a drive, on the real stack (the creations platform companion §14's W3 row and W3.7; PL-FE5, PL-FE10 and
// PL-FE3's W3 part at the stack): the studio behind ?create=agent, in headless Chrome on one real GPU, against the local
// gateway and the platform service (both started and restarted by this drive from their jars), compose.local's MariaDB,
// and the private dev bucket on B2. The two model routes alone (POST /v1/agent/turn and /v1/agent/module) are answered
// by this drive from EA9-E1's castle recording, so no model is called and nothing is spent; every other request goes
// through a pass-through to the real gateway, its CORS, auth, shield and caps included.
//   - S1: an anonymous creator's world on the stage: "Not saved", "Sign in to keep this world"; nothing sent to the platform;
//   - S2: that sign-in sets the account up (POST /v1/me) and saves the world once (POST /v1/worlds, 201); the stored text
//     read back through the gateway is byte for byte what was sent, its SHA-256 the head's;
//   - S3: a second world, saved as a world of its own;
//   - S4: /creations lists both, the newest first, each with "Open in the studio", and the usage line counts two;
//   - S5: the platform and the gateway stopped and started again: /creations still lists both;
//   - S6: the first opened from /creations: read, checked, sealed and compiled here, "Show it", on the stage From the
//     archive, "Saved"; no model route, nothing saved again;
//   - S7: a rename (PATCH, through the gateway's CORS), then a rename on a version another tab moved: said, and shown as
//     it is now;
//   - S8: the platform's own answers: another account's read of the world is 404, an anonymous save is 403
//     account-required, a save whose sha256 is not its text's is 400;
//   - S8b (W3's review, its mid): a saved world opened up to Show it, then a sign-out: no longer offered, nothing
//     installed, nothing more read for it;
//   - S9: both deleted from /creations (DELETE, after the page's confirmation): the list empty, and the usage back to
//     zero once B2 confirms the erasure (nothing left in the bucket for this account);
//   - S10: signed out in the studio: /creations asks to sign in and shows no world;
//   - no console error; every world call a signed-in caller's; only the recorded model routes; no 5xx from the platform.
// Screenshots, logs and steps.json go to dev/out/drive-saves-stack/<gpu>-<time>/. Exit 0 when every step passes; 1
// otherwise; 2 when the stack is not ready.
//
// Run from `wexy backend` (its .infisical.json), on the charger, no other GPU harness running, Docker up:
//   docker compose -f compose.local.yaml up -d redis mariadb
//   infisical run --env=dev -- node "../wexy frontend/dev/drive-saves-stack.mjs" --gpu amd|nvidia
// Only the five B2_PRIVATE_* values reach the platform (nothing else from Infisical reaches any process: the local
// profiles' own non-secret defaults stand); none is printed. The jars are this tree's, built by
//   ./mvnw -B -ntp -pl forge-gateway,platform-service -am package -DskipTests
// Options: [--gateway-jar <jar>] [--platform-jar <jar>] [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(ROOT, '..', 'wexy backend');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const say = text => console.error(`drive-saves-stack: ${text}`);

const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { say('name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { say('no Chrome found; pass --chrome <path>.'); await quit(2); }
const gatewayJar = resolve(opt('gateway-jar', join(BACKEND, 'forge-gateway', 'target', 'forge-gateway-0.1.0-SNAPSHOT.jar')));
const platformJar = resolve(opt('platform-jar', join(BACKEND, 'platform-service', 'target', 'platform-service-0.1.0-SNAPSHOT.jar')));
for (const jar of [gatewayJar, platformJar]) if (!existsSync(jar)) { say(`no jar at ${jar} (./mvnw -B -ntp -pl forge-gateway,platform-service -am package -DskipTests).`); await quit(2); }

// The private bucket's five values, for the platform alone; the drive never prints them.
const B2_NAMES = ['B2_PRIVATE_ENDPOINT', 'B2_PRIVATE_REGION', 'B2_PRIVATE_BUCKET_NAME', 'B2_PRIVATE_ACCESS_KEY', 'B2_PRIVATE_SECRET_KEY'];
const missingB2 = B2_NAMES.filter(n => !process.env[n]);
if (missingB2.length) { say(`${missingB2.join(', ')} not set: run it under \`infisical run --env=dev -- node ...\` from \`wexy backend\`.`); await quit(2); }
/** A process's environment: the system's own variables and nothing Infisical put there. */
const SYSTEM = /^(path|pathext|systemroot|systemdrive|windir|temp|tmp|userprofile|homedrive|homepath|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|programw6432|commonprogramfiles|commonprogramfiles\(x86\)|computername|username|userdomain|number_of_processors|processor_architecture|processor_identifier|os|comspec|java_home|public|allusersprofile)$/i;
const cleanEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => SYSTEM.test(k))), ...extra });

const GATEWAY_PORT = 8400;
const PLATFORM_PORT = 8430;
const PROXY_PORT = 5198;
const VITE_PORT = 5173; // the gateway's local CORS names http://localhost:5173 alone
const gateway = `http://localhost:${GATEWAY_PORT}`;
const studioOrigin = `http://localhost:${VITE_PORT}`;

const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-saves-stack', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const calls = [];
const save = done => writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, done, steps, calls }, null, 1));
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); save(false); };

const status = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(5000) })).status; } catch { return 0; } };
const tcpOpen = port => new Promise(r => { const s = tcpConnect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); s.setTimeout(2000, () => { s.destroy(); r(false); }); });
if (!(await tcpOpen(6390))) { say('Redis is not on 127.0.0.1:6390: docker compose -f compose.local.yaml up -d redis mariadb'); await quit(2); }
if (!(await tcpOpen(3316))) { say('MariaDB is not on 127.0.0.1:3316: docker compose -f compose.local.yaml up -d redis mariadb'); await quit(2); }
for (const port of [GATEWAY_PORT, PLATFORM_PORT, PROXY_PORT, VITE_PORT]) {
    if (await tcpOpen(port)) { say(`something already listens on ${port}; stop it, so this drive's services and restarts are its own.`); await quit(2); }
}

// ---- the services, this drive's own: started, stopped and started again -------------------------------------------------
// The platform's JVM trusts the Windows certificate store, as curl and Chrome on this laptop do: Avast's HTTPS scanning
// re-signs B2's certificate with its own root, which Windows trusts and Java's own store does not, so every B2 call
// failed its handshake (PKIX path building failed, SdkClientException; 2026-11-04). The gateway calls nothing outside.
const WINDOWS_TRUST = process.platform === 'win32' ? ['-Djavax.net.ssl.trustStoreType=Windows-ROOT'] : [];
const STANDING_TTL_MS = 2_000;
const services = {
    platform: { jar: platformJar, port: PLATFORM_PORT, jvm: WINDOWS_TRUST, args: [], env: () => cleanEnv(Object.fromEntries(B2_NAMES.map(n => [n, process.env[n]]))), proc: null, runs: 0 },
    // The account's standing kept 2 s, not a minute: S2b suspends an account the studio's allowance read has just
    // found active, and a minute's word would let its call through (the gateway checks that read too, since the review).
    gateway: { jar: gatewayJar, port: GATEWAY_PORT, jvm: [], args: [`--wexy.auth.standing.ttl=${STANDING_TTL_MS}ms`], env: () => cleanEnv({}), proc: null, runs: 0 },
};
async function start(name) {
    const s = services[name];
    const log = openSync(join(OUT, `${name}-${++s.runs}.log`), 'w');
    s.proc = spawn('java', ['-Xmx384m', ...s.jvm, '-jar', s.jar, '--spring.profiles.active=local', `--server.port=${s.port}`, ...s.args],
        { cwd: dirname(s.jar), stdio: ['ignore', log, log], env: s.env() });
    for (let i = 0; i < 240; i++) {
        if (await status(`http://localhost:${s.port}/actuator/health`) === 200) return true;
        if (s.proc.exitCode !== null) break;
        await sleep(500);
    }
    return false;
}
async function stop(name) {
    const s = services[name];
    if (!s.proc || s.proc.exitCode !== null) return;
    spawnSync('taskkill', ['/PID', String(s.proc.pid), '/T', '/F']);
    for (let i = 0; i < 60 && (await tcpOpen(s.port)); i++) await sleep(250);
}

// ---- the pass-through: the model routes from the castle's recording, everything else to the real gateway -------------
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const castle = JSON.parse(fixture('dev/replays/castle.json'));
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
const handOff = edit(edit(fixture('test/fixtures/agent-wire/handed-off.sse'), 'design', () => ({ design: castle.design })), 'program', () => ({ program: { nodes: castle.program.nodes } }));
const bodyOf = id => castle.modules.find(m => m.module === id)?.body ?? null;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
function moduleStream(call, answer) {
    const meta = JSON.parse(moduleWire.match(/^event:meta\ndata:(.*)$/m)[1]);
    const usage = JSON.parse(moduleWire.match(/^event:usage\ndata:(.*)$/m)[1]);
    const half = Math.floor(answer.length / 2);
    return [['meta', {
        ...meta, turnId: call.turnId, jobId: call.jobId, purpose: call.purpose, subject: call.subject, versions: call.versions,
        module: call.module.id, interfaceHash: call.module.interface.interfaceHash,
    }],
        ['delta', { text: answer.slice(0, half) }], ['delta', { text: answer.slice(half) }], ['usage', usage],
        ['done', { status: 'ok', answerSha256: sha256(answer), answerChars: answer.length }]].map(([e, d]) => `event:${e}\ndata:${JSON.stringify(d)}\n\n`).join('');
}

const MODEL = /^POST \/v1\/(agent|forge)\//;
const RECORDED = new Set(['POST /v1/agent/turn', 'POST /v1/agent/module']);
const proxy = createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const path = new URL(req.url, 'http://x').pathname;
        const route = `${req.method} ${path.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '{id}')}`;
        const who = String(req.headers.authorization ?? '');
        const caller = /^Bearer dev\.google\./.test(who) ? 'google' : /^Bearer dev\.anonymous\./.test(who) ? 'anonymous' : 'none';
        const preflightOf = req.method === 'OPTIONS' ? `${req.headers['access-control-request-method']} ${path}` : null;
        if (RECORDED.has(route) || (preflightOf && RECORDED.has(preflightOf))) {
            const cors = { 'Access-Control-Allow-Origin': studioOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization, content-type', 'Access-Control-Max-Age': '600' };
            if (preflightOf) { res.writeHead(204, cors); res.end(); return; }
            const sse = text => { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.end(text); };
            if (route === 'POST /v1/agent/turn') { calls.push({ route, caller, status: 200, recorded: true }); sse(handOff); return; }
            const call = JSON.parse(body.toString('utf8'));
            const answer = bodyOf(call.module?.id);
            calls.push({ route, caller, status: answer === null ? 404 : 200, recorded: true, module: call.module?.id });
            if (answer === null) { res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }); res.end('{"code":"not-found","message":"no such module"}'); return; }
            sse(moduleStream(call, answer));
            return;
        }
        // Through to the real gateway: its own CORS, auth, shield and caps answer.
        const headers = { ...req.headers, host: `localhost:${GATEWAY_PORT}` };
        const out = httpRequest({ host: '127.0.0.1', port: GATEWAY_PORT, method: req.method, path: req.url, headers }, up => {
            const back = [];
            up.on('data', d => back.push(d));
            up.on('end', () => {
                const text = Buffer.concat(back);
                const entry = { route, caller, status: up.statusCode };
                if (req.method !== 'OPTIONS' && /^(POST|PATCH|DELETE) \/v1\/worlds/.test(route)) {
                    entry.key = req.headers['idempotency-key'] ?? null;
                    try { const b = JSON.parse(body.toString('utf8')); entry.sentSha = b.sha256 ?? null; entry.textSha = typeof b.artifact === 'string' ? sha256(b.artifact) : null; entry.bytes = typeof b.artifact === 'string' ? Buffer.byteLength(b.artifact) : null; entry.title = b.title ?? null; } catch { /* no body */ }
                    try { entry.answer = JSON.parse(text.toString('utf8')); } catch { /* not JSON */ }
                }
                if (req.method === 'OPTIONS') entry.allowMethods = up.headers['access-control-allow-methods'] ?? null;
                calls.push(entry);
                res.writeHead(up.statusCode, up.headers);
                res.end(text);
            });
        });
        out.on('error', e => { calls.push({ route, caller, status: 502, error: e.message }); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"code":"unavailable","message":"the gateway did not answer"}'); });
        out.end(body);
    });
});

let vite = null;
let chrome = null;
let profile = null;
let page = null;
let failed = true;
const stopAll = async () => {
    page?.close();
    if (chrome) { for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100); if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']); }
    if (vite) spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    proxy.close();
    await stop('gateway');
    await stop('platform');
    await sleep(800);
    if (profile) try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
};

/** The gateway as a caller with `token` would see it (the drive's own checks, beside the studio's). */
const asCaller = async (token, method, path, body, key) => {
    const res = await fetch(`${gateway}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
};

try {
    if (!(await start('platform'))) throw new Error(`the platform did not start (see ${join(OUT, 'platform-1.log')})`);
    if (!(await start('gateway'))) throw new Error(`the gateway did not start (see ${join(OUT, 'gateway-1.log')})`);
    await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));

    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(VITE_PORT), '--strictPort', '--host', 'localhost'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: cleanEnv({ VITE_API_ORIGIN: `http://127.0.0.1:${PROXY_PORT}`, VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_AUTH_DOMAIN: '', VITE_FIREBASE_PROJECT_ID: '', VITE_FIREBASE_APP_ID: '', VITE_APPCHECK_SITE_KEY: '' }),
    });
    let viteOut = '';
    vite.stdout.on('data', d => { viteOut += d; });
    vite.stderr.on('data', d => { viteOut += d; });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${studioOrigin}/studio.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
    if (!up) throw new Error(`Vite did not answer on ${studioOrigin}\n${viteOut}`);

    profile = mkdtempSync(join(tmpdir(), 'wexy-drive-saves-stack-'));
    chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
        '--no-first-run', '--window-size=1440,900', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore', env: cleanEnv({}) });
    let target = null;
    for (let i = 0; i < 150 && !target; i++) {
        try {
            const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
            target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
        } catch { /* not yet */ }
        if (!target) await sleep(200);
    }
    if (!target) throw new Error('Chrome did not open a page to drive');

    const consoleLines = [];
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); return; }
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    };
    await new Promise(r => { ws.onopen = r; });
    const send = (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
    page = { close: () => ws.close() };
    await send('Runtime.enable');
    await send('Page.enable');
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const until = async (expression, ms = 30_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await evaluate(expression)) return true;
        return false;
    };
    let shots = 0;
    const shot = async name => writeFileSync(join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const navigate = async url => { await send('Page.navigate', { url }); await sleep(300); };
    const saveLook = () => evaluate(`(() => {
        const e = document.querySelector('.doc .save-status');
        return e ? { shown: !e.hidden && e.checkVisibility(), tone: e.dataset.tone ?? null, text: e.querySelector('.save-text')?.firstChild?.textContent ?? null,
            buttons: [...e.querySelectorAll('button')].map(b => b.textContent), links: [...e.querySelectorAll('a')].map(a => a.getAttribute('href')) } : null;
    })()`);
    const stage = () => evaluate(`({ title: document.querySelector('#hud-title')?.textContent ?? null, source: document.querySelector('#hud-source')?.hidden ? null : document.querySelector('#hud-source')?.textContent ?? null })`);
    const pressSave = label => evaluate(`(() => { const b = [...document.querySelectorAll('.doc .save-status button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const saveIs = text => `document.querySelector('.doc .save-status .save-text')?.firstChild?.textContent === ${JSON.stringify(text)}`;
    const create = async idea => {
        await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(idea)}; p.dispatchEvent(new Event('input')); })()`);
        await evaluate(`document.querySelector('.btn-forge').click()`);
        const ready = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' && !document.querySelector('.btn-forge').disabled`, 90_000);
        await evaluate(`document.querySelector('.btn-forge').click()`);
        return ready;
    };
    const installedAs = (title, source) => until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(title)} && document.querySelector('#hud-source')?.textContent === ${JSON.stringify(source)}`, 90_000);
    const saves = () => calls.filter(c => c.route === 'POST /v1/worlds');
    const cards = () => evaluate(`[...document.querySelectorAll('.world-card')].map(c => ({ title: c.querySelector('.world-title')?.textContent ?? null,
        open: (a => a && !a.hidden ? a.getAttribute('href') : null)(c.querySelector('a.world-open')), note: c.querySelector('.world-note')?.textContent ?? '' }))`);
    const usageText = () => evaluate(`document.querySelector('.history-usage')?.textContent ?? null`);
    const historyMessage = () => evaluate(`document.querySelector('.history-message')?.textContent ?? null`);

    const IDEA_A = 'A castle on a hill. Four towers, pennants fluttering in the wind.';
    const TITLE_A = 'A castle on a hill';
    const IDEA_B = 'A castle by the sea. Waves below it.';
    const TITLE_B = 'A castle by the sea';

    // S1: an anonymous creator's world on the stage: not saved, nothing sent.
    await navigate(`${studioOrigin}/studio.html?create=agent`);
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && !document.querySelector('.btn-forge')?.disabled`, 60_000);
    const gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    const readyA = started && await create(IDEA_A);
    const onStageA = await installedAs(TITLE_A, 'Live');
    const askedA = await until(saveIs('Not saved'), 15_000);
    const s1 = { stage: await stage(), save: await saveLook() };
    await shot('anonymous-not-saved');
    step('S1 an anonymous creator\'s world on the stage: "Not saved", "Sign in to keep this world"; nothing sent to the platform',
        readyA && onStageA && askedA && s1.save?.buttons.join() === 'Sign in to keep this world' && saves().length === 0 && !calls.some(c => c.route === 'POST /v1/me'),
        { gpu: gpuLabel, ...s1 });

    // S2: that sign-in sets the account up and saves the world once; the stored text is the sent text, byte for byte.
    await pressSave('Sign in to keep this world');
    const keptA = await until(saveIs('Saved'), 45_000);
    await sleep(500);
    const uid = await evaluate(`localStorage.getItem('wexy.devUid')`);
    const token = `dev.google.${uid}`;
    const firstSave = saves()[0] ?? null;
    const worldA = firstSave?.answer ?? null;
    let readBack = null;
    let savedText = null;
    if (worldA?.worldId) {
        const r = await asCaller(token, 'GET', `/v1/worlds/${worldA.worldId}/revisions/${worldA.head.revisionId}`);
        savedText = typeof r.json?.artifact === 'string' ? r.json.artifact : null;
        readBack = { status: r.status, sha: typeof r.json?.artifact === 'string' ? sha256(r.json.artifact) : null, headSha: r.json?.sha256 ?? null, bytes: r.json?.bytes ?? null };
    }
    await shot('saved');
    step('S2 the sign-in sets the account up (POST /v1/me) and saves the world once (POST /v1/worlds 201, under a key); read back through the gateway, byte for byte',
        keptA && calls.filter(c => c.route === 'POST /v1/me' && c.status === 201).length === 1 && saves().length === 1 && firstSave.status === 201
        && firstSave.caller === 'google' && /^[A-Za-z0-9-]{16,64}$/.test(firstSave.key ?? '') && firstSave.title === TITLE_A && firstSave.sentSha === firstSave.textSha
        && readBack?.status === 200 && readBack.sha === firstSave.textSha && readBack.headSha === firstSave.textSha && readBack.bytes === firstSave.bytes,
        { save: firstSave && { status: firstSave.status, key: firstSave.key, bytes: firstSave.bytes, worldId: worldA?.worldId }, readBack });

    // S2b (2026-11-04, "suspension force that"): the account suspended in the platform's database. A model call through
    // the real gateway is refused there, 403 forbidden, before forge (which this drive does not run, so anything else
    // would be a 503); the platform refuses its saves as well. Then the account is active again.
    const me = await asCaller(token, 'GET', '/v1/me');
    const accountId = me.json?.accountId ?? '';
    const sql = q => spawnSync('docker', ['exec', 'wexy-mariadb-1', 'mariadb', '-N', '-uwexy_platform', '-plocal-dev-not-a-secret', 'wexy_platform', '-e', q], { encoding: 'utf8' });
    const suspended = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(accountId) && sql(`UPDATE account SET status='SUSPENDED' WHERE id='${accountId}'`).status === 0;
    // The gateway's word on the account, from the sign-in's allowance read, outlived: it asks the platform again.
    await sleep(STANDING_TTL_MS + 500);
    const turn = await asCaller(token, 'POST', '/v1/agent/turn', { prompt: 'a lighthouse' });
    const refusedSave = await asCaller(token, 'POST', '/v1/worlds', { title: 'Suspended', artifact: savedText ?? '{}', sha256: sha256(savedText ?? '{}') }, randomUUID());
    const restored = suspended && sql(`UPDATE account SET status='ACTIVE' WHERE id='${accountId}'`).status === 0;
    // And its barred word outlived too, before the studio's next allowance read.
    await sleep(STANDING_TTL_MS + 500);
    step('S2b a suspended account: its model call refused at the gateway (403 forbidden, its words), its save refused by the platform; active again after',
        suspended && restored && turn.status === 403 && turn.json?.code === 'forbidden' && turn.json?.message === 'This account can\'t make worlds right now.'
        && refusedSave.status === 403 && refusedSave.json?.code === 'forbidden',
        { me: me.status, turn: [turn.status, turn.json?.code, turn.json?.message], save: [refusedSave.status, refusedSave.json?.code] });

    // S3: a second world, a world of its own.
    const readyB = await create(IDEA_B);
    const onStageB = await installedAs(TITLE_B, 'Live');
    const keptB = await until(saveIs('Saved'), 45_000);
    const secondSave = saves()[1] ?? null;
    const worldB = secondSave?.answer ?? null;
    step('S3 a second world is saved as a world of its own (a new key, a new world id)',
        readyB && onStageB && keptB && saves().length === 2 && secondSave.status === 201 && secondSave.key !== firstSave?.key && worldB?.worldId && worldB.worldId !== worldA?.worldId,
        { status: secondSave?.status, worldId: worldB?.worldId });

    // S4: /creations lists both, the newest first, with the usage.
    const linkOf = w => `/studio.html?create=agent&world=${w?.worldId}`;
    await navigate(`${studioOrigin}/creations`);
    const listed = await until(`document.querySelectorAll('.world-card').length === 2`, 30_000);
    const s4 = { cards: await cards(), usage: await usageText() };
    await shot('creations');
    step('S4 /creations lists both, the newest first, each with its Open link; the usage line counts two',
        listed && s4.cards[0]?.title === TITLE_B && s4.cards[1]?.title === TITLE_A && s4.cards[0].open === linkOf(worldB) && s4.cards[1].open === linkOf(worldA)
        && /^2 of 50 worlds/.test(s4.usage ?? ''), s4);

    // S5: the services stopped and started again: the history still there.
    await stop('platform');
    await stop('gateway');
    const back = (await start('platform')) && (await start('gateway'));
    await navigate(`${studioOrigin}/creations`);
    const relisted = back && await until(`document.querySelectorAll('.world-card').length === 2`, 45_000);
    const s5 = { cards: await cards(), usage: await usageText() };
    step('S5 the platform and the gateway stopped and started again: /creations still lists both', relisted && s5.cards.map(c => c.title).join('|') === `${TITLE_B}|${TITLE_A}`, s5);

    // S6: the first opened from /creations, sealed and compiled here, Show it: no model route, nothing saved again.
    const mark = calls.length;
    await evaluate(`[...document.querySelectorAll('.world-card')].find(c => c.querySelector('.world-title')?.textContent === ${JSON.stringify(TITLE_A)})?.querySelector('a.world-open')?.click()`);
    const offered = await until(`!!document.querySelector('.empty-open-show') && !document.querySelector('.empty-open-show').disabled`, 90_000);
    const s6card = await evaluate(`({ text: document.querySelector('.empty-open-text')?.textContent ?? null, url: location.pathname + location.search })`);
    await shot('reopen-ready');
    await evaluate(`document.querySelector('.empty-open-show')?.click()`);
    const reopened = await installedAs(TITLE_A, 'From the archive');
    const savedAgain = await until(saveIs('Saved'), 10_000);
    await sleep(1500);
    const s6routes = calls.slice(mark).map(c => `${c.route} ${c.status}`);
    await shot('reopened');
    step('S6 reopened from /creations: read and checked, sealed and compiled here, then Show it puts it on the stage From the archive, "Saved"; no model route, nothing saved again',
        offered && s6card.url === linkOf(worldA) && reopened && savedAgain && s6routes.includes('GET /v1/worlds/{id} 200') && s6routes.includes('GET /v1/worlds/{id}/revisions/{id} 200')
        && !calls.slice(mark).some(c => MODEL.test(c.route)) && !calls.slice(mark).some(c => c.route === 'POST /v1/worlds' || c.route === 'POST /v1/worlds/{id}/revisions'),
        { card: s6card, routes: s6routes });

    // S7: a rename through the page (a PATCH through the gateway's CORS); then one on a version another tab moved.
    await navigate(`${studioOrigin}/creations`);
    await until(`document.querySelectorAll('.world-card').length === 2`, 30_000);
    const renameIn = async (title, to) => evaluate(`(async () => {
        const c = [...document.querySelectorAll('.world-card')].find(c => c.querySelector('.world-title')?.textContent === ${JSON.stringify(title)});
        if (!c) return false;
        [...c.querySelectorAll('button')].find(b => b.textContent === 'Rename').click();
        const input = c.querySelector('.world-input'); input.value = ${JSON.stringify(to)};
        [...c.querySelectorAll('.world-rename button')].find(b => b.textContent === 'Save').click();
        return true; })()`);
    const RENAMED = 'The castle on the hill';
    await renameIn(TITLE_A, RENAMED);
    const renamed = await until(`[...document.querySelectorAll('.world-card .world-title')].some(t => t.textContent === ${JSON.stringify(RENAMED)})`, 20_000);
    const patch = calls.filter(c => c.route === 'PATCH /v1/worlds/{id}').at(-1);
    const preflight = calls.filter(c => c.route === 'OPTIONS /v1/worlds/{id}').at(-1);
    // Another tab renames it meanwhile: the page's copy is a version behind.
    const current = await asCaller(token, 'GET', `/v1/worlds/${worldA.worldId}`);
    const OTHER = 'Renamed in another tab';
    const otherTab = await asCaller(token, 'PATCH', `/v1/worlds/${worldA.worldId}`, { expectedVersion: current.json?.rowVersion, title: OTHER });
    await renameIn(RENAMED, 'A stale rename');
    const conflictSaid = await until(`[...document.querySelectorAll('.world-card')].some(c => c.querySelector('.world-title')?.textContent === ${JSON.stringify(OTHER)} && c.querySelector('.world-note')?.textContent === 'This world changed elsewhere. Here it is as it is now.')`, 20_000);
    const lastPatch = calls.filter(c => c.route === 'PATCH /v1/worlds/{id}').at(-1);
    await shot('rename-conflict');
    step('S7 a rename is a PATCH the gateway\'s CORS lets through (200); one on a version another tab moved is 409, said, and the world shown as it is now',
        renamed && patch?.status === 200 && /PATCH/.test(preflight?.allowMethods ?? '') && otherTab.status === 200 && conflictSaid && lastPatch?.status === 409,
        { patch: patch?.status, allow: preflight?.allowMethods ?? null, otherTab: otherTab.status, stale: lastPatch?.status });

    // S8: the platform's own answers to callers the studio would never be.
    const stranger = await asCaller(`dev.google.${randomUUID().replace(/-/g, '')}`, 'GET', `/v1/worlds/${worldA.worldId}`);
    const anonymous = await asCaller(`dev.anonymous.${randomUUID().replace(/-/g, '')}`, 'POST', '/v1/worlds', { title: 'x', artifact: '{}', sha256: sha256('{}') }, randomUUID());
    // The castle's own saved text under another hash: only the hash is wrong.
    const forged = await asCaller(token, 'POST', '/v1/worlds', { title: 'Forged', artifact: savedText ?? '{}', sha256: 'c'.repeat(64) }, randomUUID());
    step('S8 another account\'s read of the world is 404 (or 403 before it has an account), an anonymous save 403 account-required, a saved world\'s own text under another sha256 400',
        [403, 404].includes(stranger.status) && anonymous.status === 403 && anonymous.json?.code === 'account-required' && savedText !== null && forged.status === 400,
        { stranger: [stranger.status, stranger.json?.code], anonymous: [anonymous.status, anonymous.json?.code], forged: [forged.status, forged.json?.code] });

    // S8b (W3's review, its mid): a saved world opened, Show it offered, then a sign-out: the world is no longer offered,
    // nothing is installed, and nothing more is read for it. Then the dev identity is put back as it was (the same uid,
    // signed in), as that creator signing in again, so the deletions below are theirs.
    await navigate(`${studioOrigin}/studio.html?create=agent&world=${worldA.worldId}`);
    const offeredB = await until(`!!document.querySelector('.empty-open-show') && !document.querySelector('.empty-open-show').disabled`, 90_000);
    await until(`[...document.querySelectorAll('.account button')].some(b => b.textContent === 'Sign out' && !b.hidden)`, 20_000);
    const markOpen = calls.length;
    await evaluate(`[...document.querySelectorAll('.account button')].find(b => b.textContent === 'Sign out')?.click()`);
    const withdrawn = await until(`document.querySelector('.empty-open-text')?.textContent === 'You signed in or out while this world was opening. Open it again from Your worlds.' && !document.querySelector('.empty-open-show')`, 20_000);
    await sleep(1500);
    const s8b = { stage: await stage(), card: await evaluate(`({ text: document.querySelector('.empty-open-text')?.textContent ?? null, links: [...document.querySelectorAll('.empty-open a')].map(a => a.getAttribute('href')) })`),
        after: calls.slice(markOpen).filter(c => /\/v1\/worlds/.test(c.route) && !c.route.startsWith('OPTIONS')).map(c => `${c.route} ${c.status}`) };
    await shot('opening-withdrawn');
    step('S8b (the review\'s mid) a saved world offered for Show it, then a sign-out: no longer offered ("Open it again from Your worlds"), nothing installed, nothing more read for it',
        offeredB && withdrawn && s8b.stage.source !== 'From the archive' && s8b.card.links.includes('/creations') && s8b.after.length === 0, s8b);
    await evaluate(`(() => { localStorage.setItem('wexy.devUid', ${JSON.stringify(uid)}); localStorage.setItem('wexy.devProvider', 'google'); localStorage.setItem('wexy.googleSession', '1'); return true; })()`);

    // S9: both deleted from the page, after its confirmation; the usage back to zero once B2 confirms the erasure.
    await navigate(`${studioOrigin}/creations`);
    await until(`document.querySelectorAll('.world-card').length === 2`, 30_000);
    for (let i = 0; i < 2; i++) {
        const n = await evaluate(`document.querySelectorAll('.world-card').length`);
        await evaluate(`document.querySelector('.world-card .world-delete')?.click()`);
        await until(`!!document.querySelector('dialog.history-dialog[open]')`, 10_000);
        await evaluate(`[...document.querySelectorAll('dialog.history-dialog[open] button')].find(b => b.textContent === 'Delete')?.click()`);
        await until(`document.querySelectorAll('.world-card').length === ${n - 1}`, 20_000);
    }
    const emptied = await until(`document.querySelectorAll('.world-card').length === 0 && !!document.querySelector('.history-empty') && document.querySelector('.history-empty').checkVisibility()`, 20_000);
    const deletes = calls.filter(c => c.route === 'DELETE /v1/worlds/{id}');
    let usage = null;
    for (let i = 0; i < 60; i++) {
        usage = (await asCaller(token, 'GET', '/v1/me/usage')).json;
        if (usage && usage.worlds === 0 && usage.usedBytes === 0 && usage.reservedBytes === 0) break;
        await sleep(2_000);
    }
    const gone = await asCaller(token, 'GET', `/v1/worlds/${worldA.worldId}`);
    await shot('deleted');
    step('S9 both deleted from /creations (DELETE 202 each, under a key, after the confirmation): the list empty; usage back to zero once B2 confirms the erasure; the world 404',
        emptied && deletes.length === 2 && deletes.every(d => d.status === 202 && /^[A-Za-z0-9-]{16,64}$/.test(d.key ?? '')) && usage?.worlds === 0 && usage.usedBytes === 0
        && usage.reservedBytes === 0 && gone.status === 404, { deletes: deletes.map(d => d.status), usage, gone: gone.status });

    // S10: signed out in the studio: /creations asks to sign in and shows no world.
    await navigate(`${studioOrigin}/studio.html?create=agent`);
    await until(`[...document.querySelectorAll('.account button')].some(b => b.textContent === 'Sign out' && !b.hidden)`, 30_000);
    await evaluate(`[...document.querySelectorAll('.account button')].find(b => b.textContent === 'Sign out')?.click()`);
    await until(`localStorage.getItem('wexy.devUid') === null`, 10_000);
    const markOut = calls.length;
    await navigate(`${studioOrigin}/creations`);
    const asks = await until(`document.querySelector('.history-message')?.textContent === 'Sign in with Google to see the worlds you saved.'`, 20_000);
    const s10 = { message: await historyMessage(), cards: (await cards()).length, worldCalls: calls.slice(markOut).filter(c => /\/v1\/(worlds|me\/)/.test(c.route) && c.route[0] !== 'O').map(c => c.route) };
    await shot('signed-out');
    step('S10 signed out: /creations asks to sign in, shows no world, and asks the platform for none', asks && s10.cards === 0 && s10.worldCalls.length === 0, s10);

    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    step('no console error', errors.length === 0, errors.slice(0, 5));
    const worldCalls = calls.filter(c => /\/v1\/(worlds|me\/)/.test(c.route) && !c.route.startsWith('OPTIONS'));
    const platform5xx = calls.filter(c => c.status >= 500 && !c.route.startsWith('GET /v1/forge/'));
    const modelCalls = calls.filter(c => MODEL.test(c.route));
    step('every world call a signed-in caller\'s; the model routes only the recorded ones (two worlds made); no 5xx from the platform\'s routes',
        worldCalls.length > 0 && worldCalls.every(c => c.caller === 'google') && modelCalls.every(c => c.recorded)
        && calls.filter(c => c.route === 'POST /v1/agent/turn').length === 2 && platform5xx.length === 0,
        { routes: [...new Set(calls.map(c => `${c.route} ${c.status}`))], platform5xx });
    const passed = steps.filter(s => s.ok).length;
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, done: true, steps, calls, console: consoleLines }, null, 1));
    console.log(`\ndrive-saves-stack (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
    // The platform says when B2 is the reason (its log names the dependency, never the key): said here, so a 503 is not
    // read as the studio's.
    const b2Down = Array.from({ length: services.platform.runs }, (_, i) => join(OUT, `platform-${i + 1}.log`))
        .some(f => existsSync(f) && /dependency\.unavailable dep=b2/.test(readFileSync(f, 'utf8')));
    if (b2Down) say('the platform could not reach B2 (dependency.unavailable dep=b2 in its log): the bucket, the network, or a TLS interceptor Java does not trust.');
} catch (e) {
    say(e?.stack ?? String(e));
    save(false);
} finally {
    await stopAll();
}
await quit(failed ? 1 : 0);
