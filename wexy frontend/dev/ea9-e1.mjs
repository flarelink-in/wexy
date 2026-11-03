// EA9.1's EA9-E1 on one real GPU (agent-first-studio-design.md §10; Q114, Q115 and Q118 decided 2026-11-03): the studio
// itself behind ?create=agent, the creator's view, end to end with no paid call. A local stand-in gateway answers the agent
// routes in the backend's recorded shapes (EA-VR11's): the turn hands off the castle as the agent wrote it, each module
// call is answered with the castle's own body, and the allowance read after the turn says the free world is made.
//   - without the flag the studio is h1's, unchanged: a starter built by h1's loop over the mock, no creation code loaded;
//   - ?create=agent&scene=galaxy: the creator's view (no Developer view, no agent panel), Create offered once the stage
//     (its device compiler) is ready, the named example loaded by h1's loop with no model called;
//   - Create: Stop offered while the turn runs and the modules are written (L3 on this device), then "Show it", nothing
//     on the stage yet; the steps say so in plain words;
//   - "Show it": the GPU go, the Run (the gate, the probe, the first frame), the castle on the stage titled from the idea
//     and labelled Live, every step done, Create offered again; the chip read again after the turn;
//   - none of Developer view's words in the creator's view (P5); Photo and Make video offered;
//   - EA9-E1c and E1d (the EA9.1 review's two mid findings): with a replacement ready, a photo of the castle holds the
//     stage, so Show it waits (a press starts no Run) and is offered again once the photo is saved; a replacement readied
//     while a film of the world on the stage is made waits for the film, and the film's end offers Show it again;
//   - EA9-E2 (EA9.3): every end of P2 that does not install, forced through the stand-in (asked, declined, exhausted,
//     failed, quota and a refused idea at entry, Stop, a candidate's stop, a refused Run, supersession): the world on the
//     stage and its title unchanged after each, one sentence each;
//   - a starter after it: h1's example replaces the agent's world, no model called;
//   - EA9-E7 (EA9.3): on ?create=agent alone, the backdrop is the world on the stage, counted in the stage's ledger at
//     the largest canvas the viewport gives a world (its reviews), so a window doubled stays within the count; on a phone
//     turned, its rest out of sight keeps no Show it waiting; the first world installs beside it, and the ledger then
//     holds that world alone;
//   - no console error, and the stand-in asked only for the agent routes and the allowance: no h1 route.
// Screenshots and steps.json go to dev/out/ea9-e1/<gpu>-<time>/. Exit 0 when every step passes; 1 otherwise; 2 when
// Chrome or Vite cannot start. On the charger only, one GPU harness at a time.
//   node dev/ea9-e1.mjs --gpu amd|nvidia [--chrome path] [--out dir]
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
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea9-e1: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea9-e1: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea9-e1', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`); };

// ---- the stand-in gateway: the castle, in the backend's recorded shapes (EA-VR11's) -----------------------------------
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const castle = JSON.parse(fixture('dev/replays/castle.json'));
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
const handOff = edit(edit(fixture('test/fixtures/agent-wire/handed-off.sse'), 'design', () => ({ design: castle.design })), 'program', () => ({ program: { nodes: castle.program.nodes } }));
const bodyOf = id => castle.modules.find(m => m.module === id)?.body ?? null;
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
/** While set, every module answer waits for it: a creation held in its writing (EA9-E1d). */
let moduleGate = null;

// EA9-E2 (EA9.3): each end of P2 that does not install, in the backend's recorded shapes. The next turns' answers, in order
// (the hand-off once the queue is empty), and how the module calls are answered meanwhile.
const turnPlan = [];
/** 'castle' (each module's own body), 'budget' (the gateway's spending limit: the candidate stops), 'nan' (see NAN_BODY). */
let modulePlan = 'castle';
/** Lets a turn held by the plan's 'held' go (EA9-E2's Stop). */
let releaseTurn = () => {};
const TURN_ENDS = {
    asked: fixture('test/fixtures/agent-wire/asked.sse'),
    declined: fixture('test/fixtures/agent-wire/declined.sse'),
    exhausted: fixture('test/fixtures/agent-wire/exhausted-revisions.sse'),
    failed: fixture('test/fixtures/agent-wire/error-upstream.sse'),
};
/** Entry refusals: JSON envelopes before any stream, as the gateway sends them (W1). */
const ENTRY_REFUSALS = {
    quota: [429, { code: 'quota', message: 'You have made today\'s worlds.' }],
    refused: [422, { code: 'content-refused', message: 'The idea was refused by content safety.' }],
};
/**
 * The pennants' placement with one float of their state overflowing at run time (exp of more than 88 is past f32's
 * largest): the lint and the device's compiler pass it, and the Run's first-frame look finds it not finite
 * (EA_SANITY NaN). Nothing heavy reaches the GPU, and the frame it judges is drawn offscreen.
 */
const NAN_BODY = (() => {
    const body = bodyOf('flagPlace');
    const line = '    b_flagbuf[base + 13u] = 0.58;';
    if (!body?.includes(line)) throw new Error('ea9-e1: flagPlace no longer holds the line NAN_BODY rewrites');
    return body.replace(line, '    b_flagbuf[base + 13u] = exp(f32(index) + 200.0);');
})();
const VITE_PORT = 5190;
const GATEWAY_PORT = 5191;
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
        const json = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.method === 'POST' && req.url === '/v1/agent/turn') {
            const plan = turnPlan.shift() ?? 'handoff';
            calls.push({ route: 'turn', base: !!JSON.parse(body).base, plan });
            if (plan in TURN_ENDS) sse(TURN_ENDS[plan]);
            else if (plan in ENTRY_REFUSALS) json(...ENTRY_REFUSALS[plan]);
            // Held until the drive lets it go; the studio's Stop has cancelled it by then, so its answer finds no reader.
            else if (plan === 'held') void new Promise(resolve => { releaseTurn = resolve; }).then(() => { try { sse(handOff); } catch { /* the reader went */ } });
            else sse(handOff);
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/agent/module') {
            const call = JSON.parse(body);
            const answer = modulePlan === 'nan' && call.module?.id === 'flagPlace' ? NAN_BODY : bodyOf(call.module?.id);
            calls.push({ route: 'module', module: call.module?.id, purpose: call.purpose, plan: modulePlan });
            if (modulePlan === 'budget') { json(503, { code: 'budget', message: 'Live creation has reached its spending limit for now.' }); return; }
            if (answer === null) { res.writeHead(404, cors); res.end('{}'); return; }
            if (moduleGate) void moduleGate.then(() => sse(moduleStream(call, answer)));
            else sse(moduleStream(call, answer));
            return;
        }
        // W1: the chip is read again after an entry; the backend's DTO, the anonymous caller's one world made.
        if (req.method === 'GET' && req.url === '/v1/forge/allowance') {
            calls.push({ route: 'allowance' });
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ label: 'Free', left: 0, resetsAt: null }));
            return;
        }
        calls.push({ route: `${req.method} ${req.url}`, unexpected: true });
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end('{"code":"not-found","message":"the stand-in has no such route"}');
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
if (!up) { console.error(`ea9-e1: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea9-e1-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=1440,900', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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

/** The idea, and the title the studio gives its world: its first sentence (creation.ts, titleOf). */
const IDEA = 'A castle on a hill. Four towers, pennants fluttering in the wind.';
const TITLE = 'A castle on a hill';
/** Two replacements (EA9-E1c, E1d): the stand-in answers the castle again, the studio titles each from its own idea. */
const IDEA_B = 'A castle by the sea. Waves below it.';
const TITLE_B = 'A castle by the sea';
const IDEA_C = 'A castle in the snow. Flakes drifting down.';
const TITLE_C = 'A castle in the snow';
/** EA9-E4's GPU half: one more, waiting for Show it while the studio is measured at phone sizes. */
const IDEA_D = 'A castle at dusk. Torches lit along the walls.';
const TITLE_D = 'A castle at dusk';
/** A done step's time on the Journey (creation-view.ts's elapsed; EA9.2): seconds, or minutes and seconds. */
const TOOK = '(\\d+ s|\\d+ min \\d\\d s)';
/** What the last step says of a world paused past its envelope (COPY.creation.resized; the EA9.2 review). */
const RESIZED = 'Paused: this window is larger than this world was tested at. Press Show it to test it at this size.';
/** Lets the module answers held by `moduleGate` go. */
let releaseModules = () => {};

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
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const until = async (expression, ms = 30_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await evaluate(expression)) return true;
        return false;
    };
    let shots = 0;
    const shot = async name => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
    };
    /** The creator's controls and steps, as a person reads them. */
    const look = () => evaluate(`(() => {
        const forge = document.querySelector('.btn-forge');
        const again = document.querySelector('.btn-again');
        return {
            label: forge?.querySelector('span')?.textContent ?? null, disabled: !!forge?.disabled, again: again ? !again.hidden : false,
            rows: [...document.querySelectorAll('.journey-step')].map(r => r.className.replace('journey-step is-', '') + ': ' + (r.querySelector('.journey-detail')?.textContent ?? '')),
            title: document.querySelector('#hud-title')?.textContent ?? null,
            header: document.querySelector('#scene-title')?.textContent ?? null,
            source: document.querySelector('#hud-source')?.hidden ? null : document.querySelector('#hud-source')?.textContent ?? null,
            badge: document.querySelector('#source-badge')?.textContent ?? null,
            chip: document.querySelector('.account-chip')?.hidden === false ? document.querySelector('.account-chip').textContent : null,
            dev: document.body.classList.contains('dev'), agentPanel: !!document.querySelector('.agent'),
        };
    })()`);

    const loaded = () => evaluate(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(n => /loop\\/creation|creation-view|agent-turn|loop\\/candidate/.test(n))`);
    const starter = name => evaluate(`(() => { const b = [...document.querySelectorAll('.examples-chips .chip')].find(c => c.textContent === ${JSON.stringify(name)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const h1Installed = () => `document.querySelector('#hud-source')?.textContent === 'Playground example' && !!document.querySelector('#hud-title')?.textContent && document.querySelector('.journey-step:last-child')?.classList.contains('is-done')`;

    // The page without the flag: h1's, unchanged (EA9.1's exit): a starter built by h1's loop over the mock, and none of
    // the agent path loaded.
    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html?scene=galaxy` });
    const plain = await until(h1Installed(), 60_000);
    const plainLook = { ...(await look()), creationCode: await loaded() };
    step('without the flag the studio is h1\'s: a starter built by h1\'s loop, labelled Playground example; no creation code loaded',
        plain && plainLook.label === 'Create world' && plainLook.creationCode.length === 0 && !plainLook.dev, plainLook);

    // ?create=agent with a loader: h1's hand-written example, no model called; then the agent's Create replaces it.
    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html?create=agent&scene=galaxy` });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && !document.querySelector('.btn-forge')?.disabled && (${h1Installed()})`, 60_000);
    const gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    const first = await look();
    const firstCalls = calls.length;
    step('?create=agent: the creator\'s view (no Developer view, no agent panel), Create offered once the stage is ready; ?scene= loads h1\'s example and calls no model',
        started && !first.dev && !first.agentPanel && first.label === 'Create world' && !first.disabled && first.source === 'Playground example' && firstCalls === 0,
        { gpu: gpuLabel, first, calls: firstCalls });

    await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(IDEA)}; p.dispatchEvent(new Event('input')); })()`);
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const working = await until(`document.querySelector('.btn-forge span')?.textContent === 'Stop'`, 5_000);
    const workingLook = await look();
    await shot('writing');
    const ready = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it'`, 90_000);
    const readyLook = await look();
    await shot('ready');
    step('Create: Stop offered while the turn runs and the modules are written here; then "Show it", nothing on the stage yet, the steps in plain words',
        working && ready && readyLook.again && readyLook.title !== TITLE && new RegExp(`^done: Designed · ${TOOK}$`).test(readyLook.rows[0])
        && new RegExp(`^done: \\d+ parts written and checked · ${TOOK}$`).test(readyLook.rows[1])
        && readyLook.rows[2] === 'pending: It passed its checks. Press Show it to test it on your graphics card.' && readyLook.rows[3].startsWith('pending'),
        { working: workingLook, ready: readyLook, calls: calls.map(c => c.route + (c.module ? ` ${c.module}` : '')) });

    await evaluate(`document.querySelector('.btn-forge').click()`);
    const installed = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(TITLE)} && document.querySelector('.btn-forge span')?.textContent === 'Create world'`, 90_000);
    await sleep(500);
    const done = await look();
    await shot('installed');
    step('"Show it": the castle on the stage, titled from the idea and labelled Live; every step done; Create offered again',
        installed && done.title === TITLE && done.header === TITLE && done.source === 'Live' && !done.again && done.rows.length === 4 && done.rows.every(r => r.startsWith('done: ')), done);
    step('the chip read again after the turn: the server\'s words for the free world made', done.chip === 'Free world made' || /Free world made/.test(await evaluate(`document.querySelector('.account-line')?.textContent ?? ''`)),
        { chip: done.chip, line: await evaluate(`document.querySelector('.account-line')?.textContent ?? null`) });

    // P5: the creator's view names no id(C), Q_C, WGSL, JSON, GPU number or code (the HUD's own fps and size excepted).
    const words = await evaluate(`[document.querySelector('#left'), document.querySelector('#right'), document.querySelector('#hud-title'), document.querySelector('#hud-source'), document.querySelector('#hud-count'), document.querySelector('#viewport-msg')]
        .filter(Boolean).filter(e => !e.hidden).map(e => e.innerText).join('\\n')`);
    const developer = [/\b[0-9a-f]{12}…/, /id\(C\)/, /Q_C/, /WGSL/, /JSON/, /\d+(\.\d+)? ms\b/, /\bEA_[A-Z]/, /\bL3\b/, /\bprobe\b/i, /agent\.v\d|module\.(author|repair)/, /\bnodes\b/];
    step('the creator\'s view holds none of Developer view\'s words (P5)', developer.every(re => !re.test(words)), { found: developer.filter(re => re.test(words)).map(String), words: words.slice(0, 900) });
    const capture = await evaluate(`({ bar: !document.querySelector('#capture-bar')?.hidden, photo: !document.querySelector('#btn-snapshot')?.disabled, film: !document.querySelector('#btn-export')?.disabled })`);
    step('Photo and Make video are offered for the world on the stage', capture.bar && capture.photo && capture.film, capture);

    // EA9-E1c (the EA9.1 review's first mid finding): a replacement ready, then a photo of the castle. While the photo holds
    // the stage, Show it waits (a press starts no Run); once the photo is saved, Show it is offered again and installs.
    const create = async idea => {
        await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(idea)}; p.dispatchEvent(new Event('input')); })()`);
        await evaluate(`document.querySelector('.btn-forge').click()`);
    };
    const forgeNow = `({ label: document.querySelector('.btn-forge span')?.textContent ?? null, disabled: !!document.querySelector('.btn-forge')?.disabled })`;
    await create(IDEA_B);
    const readyB = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' && !document.querySelector('.btn-forge').disabled`, 90_000);
    const duringPhoto = await evaluate(`(() => {
        const now = () => (${forgeNow});
        const before = now();
        document.querySelector('#btn-snapshot').click();
        const during = now();
        document.querySelector('.btn-forge').click();
        return { before, during, pressed: now() };
    })()`);
    const saved = await until(`/Photo saved/.test(document.querySelector('#toast')?.textContent ?? '') && !document.querySelector('#toast').hidden`, 60_000);
    await sleep(200);
    const afterPhoto = await evaluate(forgeNow);
    step('EA9-E1c a photo holds the stage: Show it waits while it is taken (a press starts no Run), and is offered again once it is saved',
        readyB && saved && duringPhoto.before.label === 'Show it' && !duringPhoto.before.disabled && duringPhoto.during.disabled
        && duringPhoto.pressed.label === 'Show it' && afterPhoto.label === 'Show it' && !afterPhoto.disabled
        && (await evaluate(`document.querySelector('#hud-title')?.textContent`)) === TITLE, { readyB, duringPhoto, saved, afterPhoto });
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const installedB = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(TITLE_B)} && document.querySelector('.btn-forge span')?.textContent === 'Create world'`, 90_000);
    step('EA9-E1c then Show it installs the replacement', installedB, await look());

    // EA9-E1d (the review's second mid finding): a replacement held in its writing, a film of the world on the stage started,
    // the replacement let go so it is ready while the film is made. Show it waits for the film; the film's end (here, its
    // Cancel) offers it again, with no other event needed.
    moduleGate = new Promise(resolve => { releaseModules = resolve; });
    const turnsBefore = calls.filter(c => c.route === 'turn').length;
    await create(IDEA_C);
    // Held in its writing: its turn answered, its module calls asked and waiting at the stand-in.
    let writingC = await until(`document.querySelector('.btn-forge span')?.textContent === 'Stop'`, 10_000);
    for (let i = 0; i < 150 && !(calls.filter(c => c.route === 'turn').length > turnsBefore && calls.findLastIndex(c => c.route === 'module') > calls.findLastIndex(c => c.route === 'turn')); i++) await sleep(100);
    writingC = writingC && calls.findLastIndex(c => c.route === 'module') > calls.findLastIndex(c => c.route === 'turn')
        && (await evaluate(`document.querySelector('.btn-forge span')?.textContent`)) === 'Stop';
    await evaluate(`document.querySelector('#btn-export').click()`);
    const makeVideo = `[...document.querySelectorAll('.export-dialog .ex-foot button')].find(b => /Make video/.test(b.textContent))`;
    const measured = await until(`!!(${makeVideo}) && !(${makeVideo}).disabled`, 90_000);
    await evaluate(`(${makeVideo}).click()`);
    const recording = await until(`document.body.classList.contains('exporting')`, 20_000);
    releaseModules();
    moduleGate = null;
    const readyDuring = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' || !document.body.classList.contains('exporting')`, 60_000)
        && await evaluate(`document.body.classList.contains('exporting') && document.querySelector('.btn-forge span')?.textContent === 'Show it'`);
    const whileFilm = await evaluate(forgeNow);
    await shot('ready-during-film');
    await evaluate(`[...document.querySelectorAll('.export-dialog .ex-foot button')].find(b => b.textContent.trim() === 'Cancel')?.click()`);
    const filmEnded = await until(`!document.body.classList.contains('exporting')`, 60_000);
    await sleep(200);
    const afterFilm = await evaluate(forgeNow);
    await evaluate(`document.querySelector('.export-dialog .icon-btn')?.click()`);
    await sleep(300);
    const closed = await evaluate(forgeNow);
    step('EA9-E1d a replacement readied while a film is made: Show it waits for the film, and its end offers Show it again',
        writingC && measured && recording && readyDuring && whileFilm.label === 'Show it' && whileFilm.disabled && filmEnded
        && afterFilm.label === 'Show it' && !afterFilm.disabled && !closed.disabled, { writingC, measured, recording, readyDuring, whileFilm, filmEnded, afterFilm, closed });
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const installedC = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(TITLE_C)} && document.querySelector('.btn-forge span')?.textContent === 'Create world'`, 90_000);
    step('EA9-E1d then Show it installs it', installedC, await look());

    // EA9-E4's GPU half (EA9.2): a world written and waiting for Show it, the studio at phone sizes, upright and turned:
    // exactly as wide as the screen, Show it and the steps within it. Then Show it puts it on the stage.
    await create(IDEA_D);
    const readyD = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' && !document.querySelector('.btn-forge').disabled`, 90_000);
    const phoneLooks = [];
    for (const [width, height] of [[390, 844], [360, 740], [320, 640], [844, 390]]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
        await sleep(700);
        phoneLooks.push({ width, height, ...(await evaluate(`(() => {
            const forge = document.querySelector('.btn-forge');
            forge.scrollIntoView({ block: 'center' });
            const f = forge.getBoundingClientRect();
            const a = document.querySelector('.btn-again').getBoundingClientRect();
            const j = document.querySelector('.journey').getBoundingClientRect();
            return {
                page: document.documentElement.scrollWidth, body: document.body.scrollWidth, label: forge.querySelector('span')?.textContent ?? null,
                forge: [f.left, f.right, f.top, f.bottom].map(Math.round), again: [a.left, a.right].map(Math.round), journey: [j.left, j.right].map(Math.round),
            };
        })()`)) });
        await shot(`phone-${width}x${height}`);
    }
    await page.send('Emulation.clearDeviceMetricsOverride');
    await sleep(700);
    step('EA9-E4 a world waiting for Show it, the studio at 390×844, 360×740, 320×640 and 844×390: exactly as wide as the screen, Show it and the steps within it',
        readyD && phoneLooks.every(p => p.page <= p.width && p.body <= p.width && p.label === 'Show it' && p.forge[0] >= 0 && p.forge[1] <= p.width
            && p.forge[2] >= 0 && p.forge[3] <= p.height && p.again[0] >= 0 && p.again[1] <= p.width && p.journey[0] >= 0 && p.journey[1] <= p.width), phoneLooks);
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const installedD = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(TITLE_D)} && document.querySelector('.btn-forge span')?.textContent === 'Create world'`, 90_000);
    step('EA9-E4 then Show it installs it, back at the desktop size', installedD, await look());

    // EA9-E1e (the EA9.2 review's net): a world grown past what it was tested at pauses (EA_RESIZE), and Show it is offered
    // to test it again at this size; pressed, the world runs again, with no paid call. Emulated by a window twice the
    // screen it reports, which no real display allows: a page zoom or a larger second display can come close.
    const screenNow = await evaluate(`({ width: screen.width, height: screen.height })`);
    const callsBefore = calls.length;
    await page.send('Emulation.setDeviceMetricsOverride', {
        width: screenNow.width * 2, height: screenNow.height * 2, deviceScaleFactor: 1, mobile: false, screenWidth: screenNow.width, screenHeight: screenNow.height,
    });
    const pausedOffer = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' && !document.querySelector('.btn-forge').disabled`, 20_000);
    const pausedLook = await look();
    await shot('resized-paused');
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const rerun = await until(`document.querySelector('.btn-forge span')?.textContent === 'Create world'`, 90_000);
    await sleep(800);
    const rerunLook = await look();
    await shot('resized-rerun');
    await page.send('Emulation.clearDeviceMetricsOverride');
    await sleep(700);
    step('EA9-E1e a world grown past what it was tested at pauses, Show it is offered, and pressed it runs again at this size with no paid call',
        pausedOffer && pausedLook.rows[3] === `pending: ${RESIZED}` && rerun && rerunLook.title === TITLE_D && rerunLook.rows.every(r => r.startsWith('done: '))
        && calls.length === callsBefore, { screen: screenNow, pausedLook, rerunLook, calls: calls.slice(callsBefore) });

    // EA9-E2 (EA9.3; P2): every end that does not install, forced through the stand-in, the castle at dusk on the stage.
    // After each one: the HUD's title as it was, no world put on the stage (the studio says each change in its console),
    // and one sentence, the creator's, in the one step that failed.
    const onStage = () => consoleLines.filter(l => l.startsWith('info: Wexy: on the stage:')).length;
    const turnCount = () => calls.filter(c => c.route === 'turn').length;
    const settled = label => `(() => { const f = document.querySelector('.btn-forge'); return f?.querySelector('span')?.textContent === ${JSON.stringify(label)} && !f.disabled; })()`;
    const developerWords = [/\b[0-9a-f]{12}…/, /id\(C\)/, /\bEA_[A-Z]/, /\bL3\b/, /\bprobe\b/i, /\bms\b/, /JSON|WGSL|schema/];
    const E2 = [
        ['asked', { turn: 'asked' }, 'One more detail would help: Blocks of stone, or of wood — and does the river run? Add it to your idea, then press Create.'],
        ['declined', { turn: 'declined' }, 'That idea can\'t be made here. Try describing a place, the things in it, and how they move.'],
        ['exhausted', { turn: 'exhausted' }, 'This idea needed more steps than one try allows. Try a simpler version of it.'],
        ['failed (the model\'s service)', { turn: 'failed' }, null],
        ['quota at entry', { turn: 'quota', dialog: true }, 'You\'ve made today\'s world. Early access gives one a day. You can still open, film and export your worlds.'],
        ['an idea content safety refused', { turn: 'refused' }, 'This idea can\'t be made here. Try a different one.'],
        ['cancel (Stop during the turn)', { turn: 'held', stop: true }, 'Stopped. Your current world is unchanged.'],
        ['a candidate\'s stop (the gateway\'s limit on a module)', { modules: 'budget' }, null],
        ['a refused Run (its first frame not finite)', { modules: 'nan', show: true }, 'This world didn\'t draw correctly on your device; your current world is unchanged. Try a different idea.'],
        // The refused world waits for Show it; a new idea from the quiet Create world supersedes it once its turn is admitted.
        ['supersession (a new idea, admitted, over a world waiting for Show it)', { turn: 'asked', again: true }, 'One more detail would help: Blocks of stone, or of wood — and does the river run? Add it to your idea, then press Create.'],
    ];
    const e2 = [];
    for (const [name, how, sentence] of E2) {
        const shownBefore = onStage();
        const turns = turnCount();
        if (how.turn) turnPlan.push(how.turn);
        modulePlan = how.modules ?? 'castle';
        await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(`A castle, ${name}. Its gate open.`)}; p.dispatchEvent(new Event('input')); })()`);
        await evaluate(`document.querySelector(${JSON.stringify(how.again ? '.btn-again' : '.btn-forge')}).click()`);
        let asked = false;
        for (let i = 0; i < 100 && turnCount() === turns; i++) await sleep(100);
        asked = turnCount() > turns;
        if (how.stop) {
            await until(settled('Stop'), 10_000);
            await evaluate(`document.querySelector('.btn-forge').click()`);
        }
        if (how.show) {
            await until(settled('Show it'), 90_000);
            modulePlan = 'castle';
            await evaluate(`document.querySelector('.btn-forge').click()`);
            await until(`document.querySelector('.journey-step.is-failed') !== null && (${settled('Show it')})`, 90_000);
        }
        const ended = await until(how.show ? settled('Show it') : settled('Create world'), 90_000);
        let dialog = null;
        if (how.dialog) {
            dialog = await evaluate(`(() => { const d = document.querySelector('dialog.account-dialog[open]'); return d ? d.innerText : null; })()`);
            await evaluate(`document.querySelector('dialog.account-dialog[open] button')?.click()`);
        }
        releaseTurn();
        modulePlan = 'castle';
        await sleep(400);
        const after = await look();
        const failedRows = after.rows.filter(r => r.startsWith('failed: ')).map(r => r.slice('failed: '.length));
        const said = failedRows[0] ?? '';
        const ok = asked && ended && after.title === TITLE_D && onStage() === shownBefore && failedRows.length === 1
            && (sentence === null ? said.length > 0 && developerWords.every(re => !re.test(said)) : said === sentence)
            && (!how.dialog || !!dialog) && !(await evaluate(`!!document.querySelector('dialog.account-dialog[open]')`));
        e2.push({ name, ok, said, title: after.title, label: after.label, put: onStage() - shownBefore, dialog: dialog?.slice(0, 80) ?? null });
    }
    await shot('e2-after');
    step('EA9-E2 every end that does not install (P2), forced through the stand-in: the world on the stage and its title unchanged after each, one sentence each',
        e2.every(e => e.ok) && e2.length === E2.length, e2);

    // A starter after the agent's world: h1's example replaces it (no model called), and the creation lets it go.
    const before = calls.length;
    const pressed = await starter('Storm');
    const storm = await until(`${h1Installed()} && document.querySelector('#hud-title')?.textContent !== ${JSON.stringify(TITLE)}`, 60_000);
    const stormLook = await look();
    await shot('starter-after');
    step('a starter replaces the agent\'s world: h1\'s example on the stage, labelled Playground example, no model called, Create offered',
        pressed && storm && stormLook.source === 'Playground example' && stormLook.label === 'Create world' && calls.length === before, { stormLook, calls: calls.length - before });

    // EA9.3, the backdrop in the ledger: on the agent path with no example named, the backdrop is the world on the stage,
    // counted once it is on the viewport; the first world is admitted beside it, and after its install the ledger holds
    // that world alone.
    const linesBefore = consoleLines.length;
    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html?create=agent` });
    const countedLine = () => consoleLines.slice(linesBefore).find(l => l.startsWith('info: Wexy: counted on the stage: backdrop')) ?? null;
    const counted = await until(`!!document.querySelector('#gpu-pill i.ok') && document.querySelector('#empty')?.classList.contains('has-backdrop')`, 60_000)
        && await (async () => { for (let i = 0; i < 100 && !countedLine(); i++) await sleep(100); return !!countedLine(); })();
    const emptyCard = await evaluate(`({ backdrop: document.querySelector('#empty')?.classList.contains('has-backdrop') ?? false, source: document.querySelector('.empty-source')?.textContent ?? null, hud: !document.querySelector('#hud')?.hidden })`);
    await shot('backdrop');
    // EA9.3's reviews: the backdrop is counted at the largest canvas the viewport ever gives a world (its live cap), more
    // than it holds at this window; the window doubled stays within that count; smaller again, the count stays. The
    // ledger holds the backdrop alone here, so its total is the backdrop's count.
    const countLines = (since = linesBefore) => consoleLines.slice(since).filter(l => l.startsWith('info: Wexy: counted on the stage: backdrop'));
    const parse = line => ({
        count: Number(((line ?? '').match(/ledger holds (\d+) bytes/) ?? [0, 0])[1]), now: Number(((line ?? '').match(/it holds (\d+) bytes now/) ?? [0, 0])[1]),
    });
    const atSmall = parse(countLines().at(-1));
    const screenAt = await evaluate(`({ width: screen.width, height: screen.height, innerWidth, innerHeight })`);
    const doubled = { width: screenAt.innerWidth * 2, height: screenAt.innerHeight * 2, deviceScaleFactor: 1, mobile: false, screenWidth: screenAt.width, screenHeight: screenAt.height };
    await page.send('Emulation.setDeviceMetricsOverride', doubled);
    await sleep(1500);
    const atDoubled = parse(countLines().at(-1));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await sleep(700);
    const resized = { first: atSmall, atDoubled, afterSmaller: parse(countLines().at(-1)), counts: countLines().length, screen: screenAt };
    await create(IDEA);
    const overBackdrop = await until(settled('Show it'), 90_000);
    // A phone turned: the stage scrolls away with the page (held upright it stays in view, studio.css, except while the
    // idea is typed). The backdrop rests while it is out of sight (its own pause), and that rest keeps no Show it waiting.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(800);
    const outOfSight = await evaluate(`(() => {
        const c = document.querySelector('#gpu-canvas').getBoundingClientRect();
        const f = document.querySelector('.btn-forge');
        return { canvas: [Math.round(c.top), Math.round(c.bottom)], hidden: c.bottom <= 0 || c.top >= innerHeight, label: f.querySelector('span')?.textContent ?? null, disabled: f.disabled };
    })()`);
    await shot('backdrop-out-of-sight');
    await page.send('Emulation.clearDeviceMetricsOverride');
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(700);
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const installedOver = await until(`document.querySelector('#hud-title')?.textContent === ${JSON.stringify(TITLE)} && (${settled('Create world')})`, 90_000);
    await sleep(300);
    const putLine = consoleLines.slice(linesBefore).filter(l => l.startsWith('info: Wexy: on the stage: agent')).at(-1) ?? '';
    const held = (putLine.match(/the stage's ledger holds \d+ bytes: (.*)$/) ?? [null, ''])[1].split(', ').filter(Boolean);
    // The count at the small window is the one at the largest canvas: within 0.1% of what the backdrop holds once the
    // doubled window takes it there (the linear estimate's rounding, the re-count after that resize covering the rest),
    // and after it, at least that.
    const atCapCovered = resized.first.count >= 0.999 * resized.atDoubled.now && resized.atDoubled.count >= resized.atDoubled.now;
    step('EA9-E7 the backdrop on the agent path: counted in the stage\'s ledger once on the viewport, at the largest canvas, more than it holds now; the window doubled stays within it; its rest out of sight keeps no Show it waiting; the first world installed beside it, then the ledger holds that world alone',
        counted && emptyCard.backdrop && /playground example, running live/.test(emptyCard.source ?? '') && !emptyCard.hud
        && resized.first.now > 0 && resized.first.count > resized.first.now && resized.atDoubled.now > resized.first.now && atCapCovered
        && resized.afterSmaller.count === resized.atDoubled.count && overBackdrop
        && outOfSight.hidden && outOfSight.label === 'Show it' && !outOfSight.disabled && installedOver
        && held.length === 1 && held[0].startsWith('candidate ') && !putLine.includes('backdrop'),
        { counted: countedLine(), resized, estimateShortBy: resized.atDoubled.now - resized.first.count, emptyCard, outOfSight, put: putLine.slice(0, 300), held });

    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    step('no console error', errors.length === 0, errors.slice(0, 5));
    const unexpected = calls.filter(c => c.unexpected);
    const modules = calls.filter(c => c.route === 'module');
    const written = modules.filter(c => c.plan !== 'budget');
    const stopped = modules.filter(c => c.plan === 'budget');
    // Five castles written (the first, its three replacements, the one over the backdrop; EA9-E1e ran the one at dusk
    // again with no call) and E2's refused Run: six worlds of one author call a module. E2's candidate stop asked for at
    // most one round of them.
    step('the stand-in was asked for 15 turns (five castles, E2\'s ten ends with its two entry refusals), one author a module for each world written, and the allowance; no h1 route, no model called',
        unexpected.length === 0 && calls.filter(c => c.route === 'turn').length === 15 && written.length === 6 * castle.modules.length
        && stopped.length >= 1 && stopped.length <= castle.modules.length && modules.every(c => c.purpose === 'author')
        && calls.some(c => c.route === 'allowance'), { calls: calls.map(c => c.route + (c.plan ? ` [${c.plan}]` : '') + (c.module ? ` ${c.module} ${c.purpose}` : '')) });
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, idea: IDEA, steps, calls, console: consoleLines }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea9-e1 (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
} catch (e) {
    console.error(`ea9-e1: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopAll();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
