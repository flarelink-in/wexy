// EA9.5's EA9-L1 and EA9-L2 (agent-first-studio-design.md §10 and §13's switch checklist), live: every call spends
// credit, so it runs on the user's word only (11-05 "Run after you deploy"; 11-06 "go ahead with L1/L2 tests"). The
// creator's studio as this checkout builds it (a development build on http://localhost:5173, the origin dev's gateway
// allows) against a deployed gateway, signed in as a visitor is (Firebase's anonymous sign-in with the dev project's web
// config from .env.local) and attested by a registered App Check debug token given at run time and never shown: a hosted
// page never takes one, and reCAPTCHA cannot attest localhost (gotchas).
//   - L1: one Create the creator's way: its turn and its modules on the live model, then Show it on this GPU: the world
//     on the stage, titled from its idea, labelled Live, every step done. A turn that ends with no world is followed once
//     by its second try (Q120 (b)), inside the same grant, as the creator's next Create would be;
//   - L2: one "Improve it" on that world: the creator's words, one revision, then Show it: the new version on the stage;
//     or the refusal's one sentence, and the world kept;
//   - the cost: every request to the gateway, its answer taken from the browser's network log as it streamed in
//     (Network.streamResourceContent: the studio cancels each stream after its last event, and Chrome keeps no body of
//     a cancelled one), each turn's and module call's usage as the service reported it, summed, the calls counted. The
//     reservations are forge's own (its `AGENT … call of turn` and `MODULE` lines on the host), which no browser sees;
//   - no console error.
// The gateway must allow this studio's origin (CORS), so a forward to prod's gateway (it allows https://wexy.ai alone)
// stops here before anything is sent. On the charger only (the laptop's power-offs), one GPU harness at a time.
// Evidence: screenshots, each answer as it came (wire/<n>-<what>.sse|json), steps.json: dev/out/ea9-l1/<gpu>-<time>/.
// Exit 0 when every step passes; 1 otherwise; 2 when the gateway, the token, the charger, Vite or Chrome is not ready.
//   node --import ./test/register.mjs dev/ea9-l1.mjs --gpu amd|nvidia [--gateway https://api-dev.wexy.ai]
//        [--idea "…"] [--improve "…"] [--l1-only] [--max-usd 1.5] [--on-battery] [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '../src/loop/copy.ts';
import { titleOf } from '../src/loop/creation.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea9-l1: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const gateway = opt('gateway', 'https://api-dev.wexy.ai').replace(/\/+$/, '');
/** The paper test's galaxy (the backend's paper/requests.v1.json), as a creator would type it. */
const IDEA = opt('idea', 'A spiral galaxy, gold at the core and blue along the arms.');
const WORDS = opt('improve', 'Make the spiral arms brighter, and let the galaxy turn a little faster.');
const l1Only = argv.includes('--l1-only');
const maxMicroUsd = Math.round(Number(opt('max-usd', '1.5')) * 1e6);
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea9-l1: no Chrome found; pass --chrome <path>.'); await quit(2); }
const ORIGIN = 'http://localhost:5173';
const usd = micro => `$${(micro / 1e6).toFixed(4)}`;

// ---- before anything is sent: the charger, the studio's config, the gateway, the token -------------------------------
/** Windows' charger state: true, false, or null with no battery to ask. */
function onCharger() {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], { encoding: 'utf8' });
    const s = String(r.stdout ?? '').trim();
    return s === 'True' ? true : s === 'False' ? false : null;
}
const charger = onCharger();
if (charger === false && !argv.includes('--on-battery')) {
    console.error('ea9-l1: on battery. GPU runs go on the charger (the laptop\'s power-offs); plug it in, or pass --on-battery on the user\'s word.');
    await quit(2);
}
/** A name from the environment, else from .env.local (which Vite reads as well); null when neither has it. */
function localValue(name) {
    if (process.env[name]?.trim()) return process.env[name].trim();
    const file = join(ROOT, '.env.local');
    if (!existsSync(file)) return null;
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || null;
}
const WEB_CONFIG = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID', 'VITE_APPCHECK_SITE_KEY'];
const missing = WEB_CONFIG.filter(n => !localValue(n));
if (missing.length) { console.error(`ea9-l1: the studio needs the dev project's web config; missing: ${missing.join(', ')} (.env.local or the environment).`); await quit(2); }
const debugToken = localValue('WEXY_APPCHECK_DEBUG_TOKEN');
if (!debugToken) { console.error('ea9-l1: no WEXY_APPCHECK_DEBUG_TOKEN (.env.local or the environment): a registered App Check debug token is needed.'); await quit(2); }

const mode = await fetch(`${gateway}/v1/forge/mode`, { signal: AbortSignal.timeout(20_000) })
    .then(async r => ({ status: r.status, body: (await r.text()).slice(0, 300) })).catch(e => ({ status: 0, body: String(e?.message ?? e) }));
if (mode.status !== 200) { console.error(`ea9-l1: ${gateway} is not ready (GET /v1/forge/mode: HTTP ${mode.status} ${mode.body}).`); await quit(2); }
const preflight = await fetch(`${gateway}/v1/agent/turn`, {
    method: 'OPTIONS', signal: AbortSignal.timeout(20_000),
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-firebase-appcheck' },
}).then(r => ({ status: r.status, allows: r.headers.get('access-control-allow-origin') })).catch(e => ({ status: 0, allows: null, error: String(e?.message ?? e) }));
if (preflight.allows !== ORIGIN) {
    console.error(`ea9-l1: ${gateway} does not allow the studio's origin ${ORIGIN} (preflight HTTP ${preflight.status}). A forward to prod's gateway allows https://wexy.ai alone; dev's is https://api-dev.wexy.ai.`);
    await quit(2);
}
// The token's exchange, as the SDK makes it: a token Firebase refuses would fail every call after the sign-in.
const exchange = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(localValue('VITE_FIREBASE_PROJECT_ID'))}/apps/${encodeURIComponent(localValue('VITE_FIREBASE_APP_ID'))}:exchangeDebugToken?key=${encodeURIComponent(localValue('VITE_FIREBASE_API_KEY'))}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ debugToken, limitedUse: true }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })).catch(e => ({ status: 0, body: { error: { message: String(e?.message ?? e) } } }));
if (exchange.status !== 200 || typeof exchange.body?.token !== 'string') {
    console.error(`ea9-l1: Firebase refused the App Check debug token (HTTP ${exchange.status}: ${exchange.body?.error?.message ?? 'no token'}). Register WEXY_APPCHECK_DEBUG_TOKEN's value under App Check > Apps > Manage debug tokens.`);
    await quit(2);
}
console.log(`ea9-l1: ${gateway} ready, CORS allows ${ORIGIN}; App Check by a registered debug token (not shown); ${charger === null ? 'no battery' : charger ? 'on the charger' : 'ON BATTERY (--on-battery)'}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea9-l1', `${gpu}-${stamp}`)));
mkdirSync(join(OUT, 'wire'), { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); };
const git = (...a) => String(spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).stdout ?? '').trim();
const studio = { commit: git('rev-parse', '--short', 'HEAD'), changedSrc: git('status', '--porcelain', '--', 'src').split('\n').filter(Boolean) };

// ---- Vite for the studio: the gateway named, the rest of the web config from .env.local --------------------------------
const taken = await fetch(`${ORIGIN}/studio.html`, { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false);
if (taken) { console.error(`ea9-l1: something already answers on ${ORIGIN} (another dev server?); stop it first.`); await quit(2); }
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', 'localhost'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_API_ORIGIN: gateway } });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${ORIGIN}/studio.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
const stopVite = () => spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
if (!up) { console.error(`ea9-l1: Vite did not answer on ${ORIGIN}\n${viteOut}`); stopVite(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea9-l1-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=1600,1000', '--disable-features=BackForwardCache',
    ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
let devtools = null;
let target = null;
for (let i = 0; i < 150 && !target; i++) {
    try {
        devtools = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(s => s.trim());
        target = (await (await fetch(`http://127.0.0.1:${devtools[0]}/json/list`)).json()).find(t => t.type === 'page');
    } catch { /* not yet */ }
    if (!target) await sleep(200);
}
const browserVersion = devtools ? await fetch(`http://127.0.0.1:${devtools[0]}/json/version`).then(r => r.json()).then(v => v.Browser).catch(() => null) : null;

function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

// ---- the wire: every request to the gateway, its answer read back as it came -------------------------------------------
const records = [];
const byId = new Map();
const reads = [];
const parseJSON = s => { try { return JSON.parse(s); } catch { return null; } };
/** An SSE body as its events: { event, data } with the data parsed. */
const parseSSE = text => text.replace(/\r\n/g, '\n').split('\n\n').map(block => {
    const lines = block.split('\n').filter(l => l && !l.startsWith(':'));
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
    return event ? { event, data: parseJSON(data) ?? data } : null;
}).filter(Boolean);
/** What a request was, from its route and body: a turn, a revision (a base), a second try (retryOf), a module call. */
function whatOf(rec) {
    const body = rec.body ?? {};
    if (rec.path === '/v1/agent/turn') return body.base ? 'revision' : body.retryOf ? 'second-try' : 'turn';
    if (rec.path === '/v1/agent/module') return `module-${body.module?.id ?? 'unknown'}-${body.purpose ?? 'call'}`;
    return `${rec.method.toLowerCase()}${rec.path.replace(/^\/v1/, '').replace(/[^A-Za-z0-9]+/g, '-')}`;
}
/** What the report keeps of a request's body: the creator's words and the call's identity, never a whole program. */
function asked(rec) {
    const b = rec.body;
    if (!b) return null;
    if (rec.path === '/v1/agent/turn') {
        return { prompt: b.prompt, style: b.style, seconds: b.seconds, retryOf: b.retryOf ?? null,
            base: b.base ? { turnId: b.base.turnId ?? null, findings: (b.base.findings ?? []).map(f => `${f.code}: ${String(f.message ?? '').slice(0, 120)}`) } : null };
    }
    if (rec.path === '/v1/agent/module') return { turnId: b.turnId, jobId: b.jobId, module: b.module?.id ?? null, purpose: b.purpose };
    return null;
}
/** An answer's calls and their charges, as the service reported them. */
function summarize(events, rec) {
    const meta = events.find(e => e.event === 'meta')?.data ?? null;
    const usages = events.filter(e => e.event === 'usage').map(e => e.data);
    const end = [...events].reverse().find(e => e.event === 'done' || e.event === 'error') ?? null;
    const calls = rec.path === '/v1/agent/turn' ? events.filter(e => e.event === 'call').length : meta ? 1 : 0;
    const costs = usages.map(u => (Number.isFinite(u?.costMicroUsd) ? u.costMicroUsd : null));
    return {
        model: meta?.model ?? null, promptVersion: meta?.promptVersion ?? null, turnId: meta?.turnId ?? null, source: meta?.source ?? null,
        calls, reported: costs.filter(c => c !== null).reduce((a, c) => a + c, 0), unknown: Math.max(0, calls - costs.filter(c => c !== null).length),
        tokens: usages.map(u => ({ in: u?.in ?? null, out: u?.out ?? null, reasoning: u?.reasoning ?? null, cached: u?.cached ?? null })),
        purposes: rec.path === '/v1/agent/turn' ? events.filter(e => e.event === 'call').map(e => e.data?.purpose ?? null) : [meta?.purpose ?? null],
        end: end ? { event: end.event, status: end.data?.status ?? null, code: end.data?.code ?? null, message: typeof end.data?.message === 'string' ? end.data.message.slice(0, 200) : null } : null,
    };
}
let page = null;
async function readBack(rec) {
    try {
        if (!rec.body && rec.hasPostData) rec.body = parseJSON((await page.send('Network.getRequestPostData', { requestId: rec.requestId })).postData);
    } catch { /* gone */ }
    rec.what = whatOf(rec);
    rec.asked = asked(rec);
    try {
        const sse = /event-stream/.test(rec.mime ?? '');
        let text;
        if (sse && rec.streamed) {
            await rec.streamed;
            if (rec.streamError) throw new Error(`the stream was not taken: ${rec.streamError}`);
            text = rec.raw;
        } else {
            const b = await page.send('Network.getResponseBody', { requestId: rec.requestId });
            text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        }
        rec.file = `wire/${String(rec.n).padStart(2, '0')}-${rec.what}.${sse ? 'sse' : 'json'}`;
        writeFileSync(join(OUT, rec.file), text);
        if (sse) rec.wire = summarize(parseSSE(text), rec);
        else rec.answer = text.slice(0, 400);
    } catch (e) { rec.bodyError = String(e?.message ?? e); }
    delete rec.body;
}
/** Every charge reported so far, and the calls whose charge is not known. */
const spent = () => records.filter(r => r.wire).reduce((s, r) => ({ reported: s.reported + r.wire.reported, unknown: s.unknown + r.wire.unknown, calls: s.calls + r.wire.calls }), { reported: 0, unknown: 0, calls: 0 });
const paid = r => r.path === '/v1/agent/turn' || r.path === '/v1/agent/module';

let failed = true;
let browser = null;
let gpuLabel = null;
const consoleLines = [];
const phases = [];
try {
    if (!target) throw new Error('Chrome did not open a page to drive');
    page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ at: Date.now(), line: `${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}` });
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ at: Date.now(), line: `exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}` });
        if (m.method === 'Network.requestWillBeSent') {
            const { requestId, request } = m.params;
            if (!request.url.startsWith(`${gateway}/`) || request.method === 'OPTIONS') return;
            const rec = { n: records.length + 1, requestId, method: request.method, path: new URL(request.url).pathname, at: Date.now(), phase: phases.at(-1) ?? 'open',
                status: null, mime: null, ms: null, failed: null, hasPostData: !!request.hasPostData, body: request.postData ? parseJSON(request.postData) : null };
            records.push(rec);
            byId.set(requestId, rec);
        }
        if (m.method === 'Network.responseReceived') {
            const rec = byId.get(m.params.requestId);
            if (!rec) return;
            rec.status = m.params.response.status;
            rec.mime = m.params.response.mimeType;
            // A stream is taken as it comes: the studio cancels its reader after the terminal event, and Chrome then keeps
            // no body to read back (11-06's first run: "No data found for resource"). What came before this is buffered.
            if (/event-stream/.test(rec.mime ?? '')) {
                rec.raw = '';
                rec.streamed = page.send('Network.streamResourceContent', { requestId: rec.requestId })
                    .then(r => { rec.raw = Buffer.from(r.bufferedData ?? '', 'base64').toString('utf8') + rec.raw; })
                    .catch(e => { rec.streamError = String(e?.message ?? e); });
            }
        }
        if (m.method === 'Network.dataReceived') {
            const rec = byId.get(m.params.requestId);
            if (rec?.raw !== undefined && m.params.data) rec.raw += Buffer.from(m.params.data, 'base64').toString('utf8');
        }
        if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
            const rec = byId.get(m.params.requestId);
            if (!rec) return;
            rec.ms = Date.now() - rec.at;
            if (m.method === 'Network.loadingFailed') rec.failed = `${m.params.errorText}${m.params.canceled ? ' (cancelled)' : ''}`;
            reads.push(readBack(rec));
        }
    });
    browser = connect(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`);
    await page.ready;
    await browser.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable', { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000, maxPostDataSize: 1_000_000 });
    // A registered debug token goes into the page before any of its scripts runs, and identity.ts keeps it on loopback.
    // The SDK logs only a token it makes, never one it is given, so the value reaches no console line, shot or report.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `self.FIREBASE_APPCHECK_DEBUG_TOKEN = ${JSON.stringify(debugToken)};` });

    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    let overBudget = null;
    /** Waits for `expression`; meanwhile a spend past --max-usd presses Stop once and ends the wait. */
    const until = async (expression, ms = 30_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) {
            if (await evaluate(expression).catch(() => false)) return true;
            const s = spent();
            if (!overBudget && s.reported > maxMicroUsd) {
                overBudget = { at: Date.now(), ...s };
                console.error(`ea9-l1: ${usd(s.reported)} reported, past --max-usd ${usd(maxMicroUsd)}: pressing Stop.`);
                await evaluate(`(() => { const f = document.querySelector('.btn-forge'); if (f?.querySelector('span')?.textContent === 'Stop') f.click(); })()`).catch(() => {});
                return false;
            }
        }
        return false;
    };
    let shots = 0;
    const shot = async name => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
    };
    const look = () => evaluate(`(() => {
        const forge = document.querySelector('.btn-forge');
        return {
            label: forge?.querySelector('span')?.textContent ?? null, disabled: !!forge?.disabled,
            rows: [...document.querySelectorAll('.journey-step')].map(r => r.className.replace('journey-step is-', '') + ': ' + (r.querySelector('.journey-detail')?.textContent ?? '')),
            title: document.querySelector('#hud-title')?.textContent ?? null,
            source: document.querySelector('#hud-source')?.hidden ? null : document.querySelector('#hud-source')?.textContent ?? null,
            fps: document.querySelector('#hud-fps')?.textContent ?? null, res: document.querySelector('#hud-res')?.textContent ?? null,
            count: document.querySelector('#hud-count')?.textContent ?? null,
            film: !document.querySelector('#btn-export')?.disabled, photo: !document.querySelector('#btn-snapshot')?.disabled,
            dev: document.body.classList.contains('dev'), agentPanel: !!document.querySelector('.agent'),
            chip: document.querySelector('.account-chip')?.hidden ? null : document.querySelector('.account-chip')?.textContent ?? null,
            secondTry: /second try/.test(document.body.innerText),
        };
    })()`);
    const panel = () => evaluate(`(() => {
        const p = document.querySelector('.imp');
        const q = s => p?.querySelector(s);
        const shown = e => !!e && !e.hidden;
        return {
            shown: shown(p), status: shown(q('.imp-status')) ? q('.imp-status').textContent : '',
            thread: [...(p?.querySelectorAll('.imp-msg') ?? [])].map(m => (m.classList.contains('imp-studio') ? 'studio: ' : 'creator: ') + m.textContent),
            send: q('.imp-send') ? { label: q('.imp-send').textContent, disabled: q('.imp-send').disabled } : null,
            show: shown(q('.imp-show')) ? { disabled: q('.imp-show').disabled } : null,
            left: shown(q('.imp-left')) ? q('.imp-left').textContent : '', words: q('.imp-words')?.value ?? null,
        };
    })()`);
    const settled = label => `(() => { const f = document.querySelector('.btn-forge'); return f?.querySelector('span')?.textContent === ${JSON.stringify(label)} && !f.disabled; })()`;
    const type = idea => evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(idea)}; p.dispatchEvent(new Event('input')); return true; })()`);
    const press = () => evaluate(`document.querySelector('.btn-forge').click()`);
    const onStageLines = () => consoleLines.filter(l => l.line.startsWith('info: Wexy: on the stage:')).length;
    const costOf = phase => {
        const rs = records.filter(r => r.phase === phase && paid(r));
        const turns = rs.filter(r => r.path === '/v1/agent/turn');
        const modules = rs.filter(r => r.path === '/v1/agent/module');
        const sum = (list, f) => list.reduce((a, r) => a + (r.wire ? f(r.wire) : 0), 0);
        return {
            turns: turns.map(r => ({ what: r.what, status: r.status, ms: r.ms, calls: r.wire?.calls ?? null, purposes: r.wire?.purposes ?? null, reported: r.wire ? usd(r.wire.reported) : null,
                unknown: r.wire?.unknown ?? null, model: r.wire?.model ?? null, promptVersion: r.wire?.promptVersion ?? null, end: r.wire?.end ?? null, failed: r.failed })),
            moduleCalls: modules.length, modulesAnswered: modules.filter(r => r.status === 200).length,
            turnCalls: sum(turns, w => w.calls), moduleCallsCharged: sum(modules, w => w.calls),
            reportedMicroUsd: sum(rs, w => w.reported), reported: usd(sum(rs, w => w.reported)), unknownCharges: sum(rs, w => w.unknown),
            refused: rs.filter(r => r.status !== null && r.status !== 200).map(r => ({ what: r.what, status: r.status, answer: r.answer ?? null })),
        };
    };

    // ---- the creator's view -----------------------------------------------------------------------------------------
    phases.push('open');
    await page.send('Page.navigate', { url: `${ORIGIN}/studio.html` });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && (${settled('Create world')})`, 90_000);
    gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    const first = await look();
    await shot('creator-view');
    step('the creator\'s view of this checkout\'s studio (no flag): no Developer view, the GPU\'s mark, Create offered', started && !first.dev && !first.agentPanel && first.label === 'Create world',
        { gpu: gpuLabel, browser: browserVersion, studio, first });

    // ---- L1: one Create, then Show it --------------------------------------------------------------------------------
    phases.push('L1');
    const title = titleOf(IDEA);
    const tries = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
        await type(IDEA);
        const t0 = Date.now();
        await press();
        const working = await until(settled('Stop'), 20_000);
        // A turn may take its 600 s, and the module calls theirs (255 s each, a few at a time): half an hour at most.
        const ended = await until(`(${settled('Show it')}) || (${settled('Create world')})`, 30 * 60_000);
        await sleep(800);
        const after = await look();
        tries.push({ attempt, working, ended, ms: Date.now() - t0, after });
        await shot(`l1-try-${attempt}-${after.label === 'Show it' ? 'ready' : 'ended'}`);
        // A second try only when the studio offers one (a turn that ended with no world, Q120 (b)), and only once.
        if (after.label === 'Show it' || !after.secondTry || overBudget) break;
        console.log(`ea9-l1: the first Create ended with no world (${after.rows.filter(r => r.startsWith('failed') || r.startsWith('asked')).join(' | ')}); its second try, once.`);
    }
    await Promise.all(reads);
    const lastTry = tries.at(-1);
    step(`L1 Create${tries.length > 1 ? ' (and its second try, Q120 (b))' : ''}: Stop offered while it was written, then Show it offered`,
        tries.every(t => t.working) && lastTry.after.label === 'Show it', { tries: tries.map(t => ({ attempt: t.attempt, ms: t.ms, label: t.after.label, rows: t.after.rows })) });
    let installed = null;
    if (lastTry.after.label === 'Show it') {
        const shown = onStageLines();
        const t0 = Date.now();
        await press();
        const ended = await until(`(${settled('Create world')}) || ((${settled('Show it')}) && !!document.querySelector('.journey-step.is-failed'))`, 5 * 60_000);
        await sleep(2000);
        const after = await look();
        installed = { ended, ms: Date.now() - t0, after, put: onStageLines() - shown };
        await shot('l1-on-the-stage');
        step('L1 Show it on this GPU: the world on the stage, titled from its idea, Live, every step done, Film and Photo offered',
            ended && after.label === 'Create world' && after.title === title && after.source === 'Live' && after.rows.every(r => r.startsWith('done: '))
            && after.film && after.photo && /^[1-9]\d* fps$/.test(after.fps ?? '') && installed.put === 1, { title, after, put: installed.put, ms: installed.ms });
    }
    await Promise.all(reads);
    const l1 = costOf('L1');
    step(`L1's cost recorded: ${l1.turnCalls} turn call(s) and ${l1.moduleCallsCharged} module call(s), ${l1.reported} reported, ${l1.unknownCharges} charge(s) unknown`,
        l1.turns.length >= 1 && l1.turns.every(t => t.calls !== null) && l1.unknownCharges === 0, l1);

    // ---- L2: one "Improve it", then Show it ---------------------------------------------------------------------------
    let l2 = null;
    if (!l1Only && installed?.after.label === 'Create world' && installed.put === 1) {
        phases.push('L2');
        const panelReady = await until(`(() => { const p = document.querySelector('.imp'); const w = p?.querySelector('.imp-words'); return !!p && !p.hidden && !!w && !w.disabled; })()`, 90_000);
        const p0 = await panel();
        await shot('l2-panel');
        step('L2 the world\'s right panel: its review in the creator\'s words, the box for what to change', panelReady && p0.shown, p0);
        // The anonymous turn bucket: two turns, then one every 120 s (the gateway's agent-turn-anonymous); a revision is a turn.
        const turnsSoFar = records.filter(r => r.path === '/v1/agent/turn');
        if (turnsSoFar.length >= 2) {
            const wait = turnsSoFar.at(-1).at + 125_000 - Date.now();
            if (wait > 0) { console.log(`ea9-l1: ${turnsSoFar.length} turns so far; waiting ${Math.ceil(wait / 1000)} s for the turn bucket to refill.`); await sleep(wait); }
        }
        const kept = await look();
        const shownBefore = onStageLines();
        const before = (await panel()).thread.length;
        await evaluate(`(() => { const w = document.querySelector('.imp-words'); w.value = ${JSON.stringify(WORDS)}; w.dispatchEvent(new Event('input')); })()`);
        const t0 = Date.now();
        await evaluate(`document.querySelector('.imp-send').click()`);
        const answered = await until(`(() => { const m = [...document.querySelectorAll('.imp .imp-msg')]; return m.length >= ${before} + 2 && m.at(-1).classList.contains('imp-studio'); })()`, 30 * 60_000);
        await sleep(800);
        const p1 = await panel();
        const readyLook = await look();
        await shot(`l2-${p1.show && !p1.show.disabled ? 'ready' : 'answered'}`);
        const ready = !!p1.show && !p1.show.disabled;
        let on = null;
        if (ready) {
            const t1 = Date.now();
            await evaluate(`document.querySelector('.imp-show').click()`);
            const ended = await until(`[...document.querySelectorAll('.imp .imp-msg')].some(m => /Here it is/.test(m.textContent)) && (${settled('Create world')})`, 5 * 60_000);
            await sleep(2000);
            on = { ended, ms: Date.now() - t1, after: await look(), panel: await panel(), put: onStageLines() - shownBefore };
            await shot('l2-on-the-stage');
        }
        await Promise.all(reads);
        l2 = { answered, ms: Date.now() - t0, p1, readyLook, on };
        const revisionInstalled = ready && on?.ended && on.after.title === kept.title && on.after.source === 'Live' && on.after.rows.every(r => r.startsWith('done: ')) && on.put === 1;
        const refusedKept = answered && !ready && p1.thread.at(-1)?.startsWith('studio: ') && readyLook.title === kept.title && onStageLines() === shownBefore;
        step('L2 "Improve it": the creator\'s words in the thread, one revision; then either Show it put the new version on the stage (Live, every step done), or one sentence and the world kept',
            answered && p1.thread.includes(`creator: ${COPY.improve.you}${WORDS}`) && (revisionInstalled || refusedKept),
            { outcome: revisionInstalled ? 'installed' : refusedKept ? 'refused, world kept' : 'neither', thread: p1.thread, left: (on?.panel ?? p1).left, after: on?.after ?? readyLook, ms: l2.ms });
        const cost = costOf('L2');
        step(`L2's cost recorded: ${cost.turnCalls} turn call(s) and ${cost.moduleCallsCharged} module call(s), ${cost.reported} reported, ${cost.unknownCharges} charge(s) unknown`,
            cost.turns.length >= 1 && cost.turns.every(t => t.what === 'revision' && t.calls !== null) && cost.unknownCharges === 0, cost);
        l2.cost = cost;
    }

    // ---- the allowance after, the console, the total -------------------------------------------------------------------
    await Promise.all(reads);
    const allowance = records.filter(r => r.path === '/v1/forge/allowance').map(r => ({ phase: r.phase, status: r.status, answer: r.answer ?? null }));
    const errors = consoleLines.filter(l => /^(error|exception)/.test(l.line)).map(l => l.line);
    step('no console error', errors.length === 0, errors.slice(0, 8));
    const total = spent();
    step(`the total: ${total.calls} call(s), ${usd(total.reported)} reported, ${total.unknown} unknown${overBudget ? `; STOPPED past --max-usd ${usd(maxMicroUsd)}` : ''}`, !overBudget,
        { total: { ...total, reported: usd(total.reported) }, allowance, routes: records.map(r => `${r.phase} ${r.method} ${r.path} ${r.status ?? '-'}${r.failed ? ` (${r.failed})` : ''}`) });
    failed = steps.some(s => !s.ok);
    writeFileSync(join(OUT, 'costs.json'), `${JSON.stringify({ l1, l2: l2?.cost ?? null, total: { ...total, reported: usd(total.reported) } }, null, 2)}\n`);
} catch (e) {
    console.error(`ea9-l1: ${e?.stack ?? e}`);
    step('the drive ran to its end', false, String(e?.stack ?? e).slice(0, 400));
} finally {
    await Promise.race([Promise.all(reads), sleep(5000)]);
    writeFileSync(join(OUT, 'steps.json'), `${JSON.stringify({
        label: 'live (paid)', gpu, gpuLabel, browser: browserVersion, gateway, studio, idea: IDEA, improve: l1Only ? null : WORDS, maxMicroUsd, charger,
        reservations: 'forge\'s own: its SPEND lines on the host (not visible to the browser)', steps,
        requests: records.map(({ requestId, hasPostData, body, raw, streamed, ...r }) => r), console: consoleLines.map(l => l.line),
    }, null, 1)}\n`);
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea9-l1 (${gpu}): ${gpuLabel}; ${browserVersion}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    await browser?.send('Browser.close').catch(() => {});
    page?.close();
    browser?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopVite();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
