// EA9.5's EA9-G1 on one real GPU (agent-first-studio-design.md §10 and §13's switch checklist): the creator's studio with
// no flag (the agent path, the default since 11-04), end to end, with no paid call. As EA-E does under ?agent=1, but every
// world is made the creator's way: Create (its turn and its modules, written and compiled here), then Show it (the GPU go).
// A local stand-in gateway answers the agent routes from the backend's recordings, one world at a time (EA-F2's three
// live worlds, test/fixtures/live-candidates), and the castle with one body whose first frame is not finite (EA9-E2's
// refused Run).
//   - the creator's view: no Developer view, the GPU's mark, Create offered over the backdrop;
//   - the solid world (block-film), the moving world (galaxy) and the fullscreen world (foggy-dusk): each Create, then
//     Show it, on the stage titled from its idea and labelled Live, every step done, Film and Photo offered; while each
//     replacement is tested, the world before it draws on (P8: the HUD written from drawn frames);
//   - a failed replacement: its Run refused, said in the creator's words, the world on the stage as it was and drawing;
//   - Stop during a turn, and during the writing: nothing applied, the world on the stage unchanged;
//   - a photo (a Full HD PNG, opaque everywhere) and a video (6 s at 1080p, 60 fps: 360 H.264 frames) of the world;
//   - a device loss (the GPU process crashed, chrome://gpucrash): the studio says so and makes nothing more; a reload,
//     and a world made the creator's way again (the known-good path);
//   - no console error before the crash, and the stand-in asked only for the agent routes, the review's terms and the
//     allowance: no h1 route, no model called.
// A screenshot of every state, the photo, the video and steps.json go to dev/out/ea9-g1/<gpu>-<time>/. Exit 0 when every
// step passes; 1 otherwise; 2 when Chrome, Vite, ffprobe or ffmpeg cannot start. On the charger only, one GPU a run.
//   node dev/ea9-g1.mjs --gpu amd|nvidia [--no-lose] [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea9-g1: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
/** The device loss is the last section; --no-lose leaves it out (a run that must keep the GPU process). */
const lose = !argv.includes('--no-lose');
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea9-g1: no Chrome found; pass --chrome <path>.'); await quit(2); }
for (const tool of ['ffprobe', 'ffmpeg']) {
    if (spawnSync(tool, ['-version']).status !== 0) { console.error(`ea9-g1: ${tool} is not on PATH; the video cannot be read back.`); await quit(2); }
}
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea9-g1', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
const downloads = join(OUT, 'downloads');
mkdirSync(downloads, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ''}`); };
/** The video: the export dialog's defaults (Wide, 1080p, 60 fps) at its shortest length, as EA-F2 makes it. */
const FILM = { width: 1920, height: 1080, fps: 60, seconds: 6 };

// ---- the stand-in gateway: the backend's recordings, one world at a time ---------------------------------------------
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const handedOff = fixture('test/fixtures/agent-wire/handed-off.sse');
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
const live = name => ({ name, ...JSON.parse(fixture(`test/fixtures/live-candidates/${name}.json`)) });
const castle = { name: 'castle', ...JSON.parse(fixture('dev/replays/castle.json')) };
/** The castle's pennants with one float overflowing at run time: its first frame is not finite (EA_SANITY), as EA9-E2's. */
const NAN_BODY = (() => {
    const body = castle.modules.find(m => m.module === 'flagPlace')?.body ?? '';
    const line = '    b_flagbuf[base + 13u] = 0.58;';
    if (!body.includes(line)) throw new Error('ea9-g1: flagPlace no longer holds the line NAN_BODY rewrites');
    return body.replace(line, '    b_flagbuf[base + 13u] = exp(f32(index) + 200.0);');
})();
/** The world the next turns hand off, and how their module calls are answered: its bodies, the castle's broken one, held. */
let world = null;
let broken = false;
let releaseTurn = () => {};
let moduleGate = null;
let releaseModules = () => {};
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
const VITE_PORT = 5197;
const GATEWAY_PORT = 5196;
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
        const json = (status, value, type = 'application/json') => { res.writeHead(status, { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
        if (req.method === 'POST' && req.url === '/v1/agent/turn') {
            const w = world;
            calls.push({ route: 'turn', world: w?.name ?? null, held: w?.held === true, base: !!JSON.parse(body).base, retryOf: JSON.parse(body).retryOf ?? null });
            const turn = edit(w.design ? edit(handedOff, 'design', () => ({ design: w.design })) : handedOff, 'program', () => ({ program: { nodes: w.program.nodes } }));
            // Held until the drive lets it go; the studio's Stop has cancelled it by then, so its answer finds no reader.
            if (w.held) void new Promise(r => { releaseTurn = r; }).then(() => { try { sse(turn); } catch { /* the reader went */ } });
            else sse(turn);
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/agent/module') {
            const call = JSON.parse(body);
            const id = call.module?.id;
            const answer = broken && id === 'flagPlace' ? NAN_BODY : world?.modules.find(m => m.module === id)?.body ?? null;
            calls.push({ route: 'module', world: world?.name ?? null, module: id, purpose: call.purpose });
            if (answer === null) { res.writeHead(404, cors); res.end('{}'); return; }
            if (moduleGate) void moduleGate.then(() => { try { sse(moduleStream(call, answer)); } catch { /* the reader went */ } });
            else sse(moduleStream(call, answer));
            return;
        }
        // EA6.4, on the creator's path since EA9.4: the review's terms, read once a review reaches the session; every gate
        // shut, as production stands today, so no model's review is ever sent.
        if (req.method === 'GET' && req.url === '/v1/agent/review') {
            calls.push({ route: 'review-terms' });
            json(200, fixture('test/fixtures/review-wire/terms-shut.json'));
            return;
        }
        // W1: the chip is read again after an entry; the backend's DTO.
        if (req.method === 'GET' && req.url === '/v1/forge/allowance') {
            calls.push({ route: 'allowance' });
            json(200, { label: 'Free', left: 0, resetsAt: null });
            return;
        }
        calls.push({ route: `${req.method} ${req.url}`, unexpected: true });
        json(404, { code: 'not-found', message: 'the stand-in has no such route' });
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
if (!up) { console.error(`ea9-g1: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea9-g1-'));
// EA-E's flags: with --enable-gpu-benchmarking a typed navigation to chrome://gpucrash crashes the GPU process.
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--enable-gpu-benchmarking', '--no-first-run', '--window-size=1600,1000', '--disable-features=BackForwardCache',
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

function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

const probe = file => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,pix_fmt', '-of', 'json', file]);
    return r.status === 0 ? JSON.parse(String(r.stdout)).streams[0] : { error: String(r.stderr) };
};
/** A PNG decoded to RGBA: its size and the pixels whose alpha is not 255. */
const decodePNG = file => {
    const info = probe(file);
    if (info.error) return info;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return { error: String(r.stderr) };
    let translucent = 0;
    for (let i = 3; i < r.stdout.length; i += 4) if (r.stdout[i] !== 255) translucent++;
    return { width: info.width, height: info.height, translucent };
};

/** Each world's idea, and the title the studio gives it: its first sentence (creation.ts's titleOf). */
const IDEAS = {
    'block-film': ['A blocky hillside of stone and grass. Filmed like an old reel.', 'A blocky hillside of stone and grass'],
    'galaxy': ['A spiral galaxy turning slowly. Gold at the core, blue arms.', 'A spiral galaxy turning slowly'],
    'foggy-dusk': ['Rolling hills under thick fog at dusk. The last light fading.', 'Rolling hills under thick fog at dusk'],
    'castle': ['A castle whose pennants misbehave. Its gate open.', 'A castle whose pennants misbehave'],
};
/** The last step's words for the refused Run (COPY.creation.runDrawn: EA_SANITY, G4). */
const RUN_DRAWN = 'This world didn\'t draw correctly on your device; your current world is unchanged. Try a different idea.';
const STOPPED = 'Stopped. Your current world is unchanged.';

let failed = true;
let page = null;
let browser = null;
let gpuLabel = null;
const consoleLines = [];
let crashedAt = Infinity;
try {
    if (!target) throw new Error('Chrome did not open a page to drive');
    const downloadsDone = [];
    page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push({ at: Date.now(), line: `${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}` });
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push({ at: Date.now(), line: `exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}` });
    });
    browser = connect(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`, m => { if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') downloadsDone.push(m.params.guid); });
    await page.ready;
    await browser.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads.replace(/\//g, '\\'), eventsEnabled: true });
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const until = async (expression, ms = 30_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) if (await evaluate(expression).catch(() => false)) return true;
        return false;
    };
    let shots = 0;
    const shot = async name => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
    };
    const nextDownload = async (before, name, ms = 120_000) => {
        for (const end = Date.now() + ms; Date.now() < end;) {
            const guid = downloadsDone[before];
            if (guid && existsSync(join(downloads, guid))) {
                const file = join(downloads, name);
                renameSync(join(downloads, guid), file);
                return file;
            }
            await sleep(250);
        }
        return null;
    };
    /** The creator's controls, steps and stage, as a person reads them. */
    const look = () => evaluate(`(() => {
        const forge = document.querySelector('.btn-forge');
        return {
            label: forge?.querySelector('span')?.textContent ?? null, disabled: !!forge?.disabled,
            rows: [...document.querySelectorAll('.journey-step')].map(r => r.className.replace('journey-step is-', '') + ': ' + (r.querySelector('.journey-detail')?.textContent ?? '')),
            title: document.querySelector('#hud-title')?.textContent ?? null,
            source: document.querySelector('#hud-source')?.hidden ? null : document.querySelector('#hud-source')?.textContent ?? null,
            fps: document.querySelector('#hud-fps')?.textContent ?? null,
            film: !document.querySelector('#btn-export')?.disabled, photo: !document.querySelector('#btn-snapshot')?.disabled,
            dev: document.body.classList.contains('dev'), agentPanel: !!document.querySelector('.agent'),
        };
    })()`);
    const settled = label => `(() => { const f = document.querySelector('.btn-forge'); return f?.querySelector('span')?.textContent === ${JSON.stringify(label)} && !f.disabled; })()`;
    const type = idea => evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(idea)}; p.dispatchEvent(new Event('input')); return true; })()`);
    const press = () => evaluate(`document.querySelector('.btn-forge').click()`);
    /**
     * Counts the HUD's fps writes while a Run runs (the button reads Stop): each one a frame the world on the stage drew
     * then, the world before the one being tested (P8), with their words.
     */
    const watchFrames = () => evaluate(`(() => {
        const hud = document.querySelector('#hud-fps');
        window.__frames = { writes: 0, values: [] };
        window.__framesObserver?.disconnect();
        window.__framesObserver = new MutationObserver(() => {
            if (document.querySelector('.btn-forge span')?.textContent !== 'Stop') return;
            window.__frames.writes++;
            window.__frames.values.push(hud.textContent);
        });
        window.__framesObserver.observe(hud, { childList: true, characterData: true, subtree: true });
        return true;
    })()`);
    const frames = () => evaluate(`(() => { window.__framesObserver?.disconnect(); return window.__frames; })()`);
    const onStageLines = () => consoleLines.filter(l => l.line.startsWith('info: Wexy: on the stage:')).length;

    /** A world made the creator's way: its idea, Create, Stop offered while it is written, then Show it, the GPU go. */
    async function make(name, { measureOld = false } = {}) {
        world = name === 'castle' ? castle : live(name);
        const [idea, title] = IDEAS[name];
        await type(idea);
        await press();
        const working = await until(settled('Stop'), 10_000);
        const ready = await until(settled('Show it'), 120_000);
        const readyLook = await look();
        if (measureOld) await watchFrames();
        const shown = onStageLines();
        await press();
        const ended = await until(`(${settled('Create world')}) || ((${settled('Show it')}) && !!document.querySelector('.journey-step.is-failed'))`, 180_000);
        await sleep(1200);
        const after = await look();
        const drawn = measureOld ? await frames() : null;
        return { name, idea, title, working, ready, readyLook, ended, after, drawn, put: onStageLines() - shown };
    }
    const installed = r => r.ended && r.after.label === 'Create world' && r.after.title === r.title && r.after.source === 'Live'
        && r.after.rows.every(row => row.startsWith('done: ')) && r.after.film && r.after.photo && /^[1-9]\d* fps$/.test(r.after.fps ?? '') && r.put === 1;
    /** The world before drew while this one was tested (P8): its HUD written from drawn frames, every write an fps. */
    const drewOn = r => (r.drawn?.writes ?? 0) >= 2 && r.drawn.values.every(v => /^[1-9]\d* fps$/.test(v ?? ''));

    // ---- the creator's view ----------------------------------------------------------------------------------------
    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html` });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && (${settled('Create world')})`, 60_000);
    gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    const first = await look();
    step('no flag: the creator\'s view (no Developer view, no agent panel), the GPU\'s mark, Create offered over the backdrop',
        started && !first.dev && !first.agentPanel && first.label === 'Create world', { gpu: gpuLabel, first });

    // ---- the three live worlds, each made the creator's way ----------------------------------------------------------
    const made = [];
    for (const [i, name] of ['block-film', 'galaxy', 'foggy-dusk'].entries()) {
        const r = await make(name, { measureOld: i > 0 });
        made.push(r);
        await shot(`${name}-on-the-stage`);
        step(`${name}: Create (Stop offered while it is written), then Show it: on the stage, titled from its idea, Live, every step done, Film and Photo offered`,
            r.working && r.ready && installed(r), { readyRows: r.readyLook.rows, after: r.after, put: r.put });
        if (i > 0) step(`${name}: while it was tested, the world before it drew on (P8): the HUD written from drawn frames`, drewOn(r), r.drawn);
    }

    // ---- Stop: during a turn, and during the writing (before the failed replacement: its world waits for Show it, and a
    // newer idea stopped before its admission gives it back, Q126 (b)) ---------------------------------------------------
    const stops = [];
    for (const where of ['turn', 'writing']) {
        world = where === 'turn' ? { ...live('galaxy'), held: true } : live('galaxy');
        if (where === 'writing') moduleGate = new Promise(r => { releaseModules = r; });
        const before = await look();
        const shown = onStageLines();
        await type(`A galaxy, stopped during its ${where}. Then nothing.`);
        await press();
        const busy = await until(settled('Stop'), 10_000);
        if (where === 'writing') await until(`[...document.querySelectorAll('.journey-step')][1]?.classList.contains('is-running')`, 30_000);
        else await sleep(600);
        await press();
        const ended = await until(settled('Create world'), 30_000);
        releaseTurn();
        releaseModules();
        moduleGate = null;
        await sleep(800);
        const after = await look();
        stops.push({ where, busy, ended, said: after.rows.filter(r => r.startsWith('failed: ')), title: after.title, put: onStageLines() - shown });
        step(`Stop during the ${where}: nothing applied, the world on the stage unchanged, one sentence`,
            busy && ended && after.title === before.title && onStageLines() === shown && after.rows.filter(r => r.startsWith('failed: ')).length === 1
            && after.rows.some(r => r === `failed: ${STOPPED}` || r.startsWith(`failed: ${STOPPED} `)), stops.at(-1));
    }
    await shot('after-stops');

    // ---- a failed replacement: its Run refused; the world on the stage as it was, drawing ------------------------------
    broken = true;
    const kept = await look();
    const refused = await make('castle', { measureOld: true });
    broken = false;
    const failedRows = refused.after.rows.filter(r => r.startsWith('failed: '));
    await shot('failed-replacement');
    step('a failed replacement: its Run refused (its first frame not finite), said in the creator\'s words; the world on the stage unchanged and drawing',
        refused.ready && refused.ended && refused.after.label === 'Show it' && failedRows.length === 1 && failedRows[0] === `failed: ${RUN_DRAWN}`
        && refused.after.title === kept.title && refused.after.source === 'Live' && refused.put === 0 && drewOn(refused),
        { after: refused.after, drawn: refused.drawn, put: refused.put });

    // ---- a photo and a video of the world on the stage (the refused world waiting beside it) ---------------------------
    const subject = await look();
    let before = downloadsDone.length;
    await evaluate(`document.querySelector('#btn-snapshot').click()`);
    const photoFile = await nextDownload(before, 'photo.png');
    const png = photoFile ? decodePNG(photoFile) : null;
    step(`a photo of the world on the stage: a ${FILM.width}×${FILM.height} PNG, opaque everywhere`, png?.width === FILM.width && png?.height === FILM.height && png.translucent === 0,
        { world: subject.title, png });
    await evaluate(`document.querySelector('#btn-export').click()`);
    const measured = await until(`(() => { const e = document.querySelector('.export-dialog .ex-estimate'); return !!e && !e.textContent.includes('Measuring') && (e.textContent.includes('Takes') || !!document.querySelector('.export-dialog .ex-warn')); })()`, 120_000);
    await evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes(${JSON.stringify(`${FILM.seconds} s`)})); b?.click(); return !!b; })()`);
    await sleep(300);
    const filmStart = Date.now();
    await evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes('Make video')); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const madeFilm = await until(`/ready|Part of your video/.test(document.querySelector('#ex-title')?.textContent ?? '') || !!document.querySelector('.export-dialog .ex-warn')`, 600_000);
    const filmTitle = await evaluate(`document.querySelector('#ex-title')?.textContent ?? ''`);
    await shot('video-made');
    before = downloadsDone.length;
    await evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes('Download')); b?.click(); return !!b; })()`);
    const filmFile = /ready/.test(filmTitle) ? await nextDownload(before, 'video.mp4') : null;
    const film = filmFile ? probe(filmFile) : null;
    await evaluate(`document.querySelector('.export-dialog .icon-btn')?.click()`);
    await sleep(800);
    step(`a video of the world on the stage: ${FILM.seconds} s at ${FILM.width}×${FILM.height}, ffprobe reads ${FILM.fps * FILM.seconds} H.264 frames; the world still on the stage`,
        measured && madeFilm && /ready/.test(filmTitle) && film?.codec_name === 'h264' && film.width === FILM.width && film.height === FILM.height
        && Number(film.nb_read_frames) === FILM.fps * FILM.seconds && (await look()).title === subject.title,
        { title: filmTitle, ms: Date.now() - filmStart, film });
    const beforeCrash = consoleLines.filter(l => /^(error|exception)/.test(l.line)).map(l => l.line);
    step('no console error through the worlds, the refused Run, the stops, the photo and the video', beforeCrash.length === 0, beforeCrash.slice(0, 5));

    // ---- a device loss: the studio says so, makes nothing more; a reload, and a world made again -----------------------
    if (lose) {
        crashedAt = Date.now();
        const crashTarget = await (await fetch(`http://127.0.0.1:${devtools[0]}/json/new?about:blank`, { method: 'PUT' })).json();
        const crash = connect(crashTarget.webSocketDebuggerUrl);
        await crash.ready;
        await crash.send('Page.enable');
        await crash.send('Page.navigate', { url: 'chrome://gpucrash', transitionType: 'typed' }).catch(e => consoleLines.push({ at: Date.now(), line: `gpucrash: ${e.message}` }));
        const said = await until(`/graphics card stopped responding/.test(document.querySelector('#viewport-msg')?.textContent ?? '')`, 30_000);
        crash.close();
        await fetch(`http://127.0.0.1:${devtools[0]}/json/close/${crashTarget.id}`).catch(() => {});
        await page.send('Page.bringToFront');
        await sleep(800);
        const lost = await look();
        const turnsBefore = calls.filter(c => c.route === 'turn').length;
        await type('A world after the device was lost. It should not start.');
        await press();
        await sleep(1500);
        await shot('device-lost');
        step('a device loss (the GPU process crashed): the studio says so, and a Create starts nothing (no turn asked for)',
            said && calls.filter(c => c.route === 'turn').length === turnsBefore, { message: await evaluate(`document.querySelector('#viewport-msg')?.textContent ?? null`), lost });
        await page.send('Page.reload');
        const restarted = await until(`!!document.querySelector('#gpu-pill i.ok') && (${settled('Create world')})`, 60_000);
        const again = restarted ? await make('galaxy') : null;
        await shot('recovered');
        step('recovered: after a reload, a world made the creator\'s way again, on the stage and Live', restarted && !!again && installed(again), again?.after ?? null);
    }

    const unexpected = calls.filter(c => c.unexpected);
    const turns = calls.filter(c => c.route === 'turn');
    step('the stand-in was asked only for the agent routes, the review\'s terms and the allowance; no h1 route, no revision, no second try',
        // Every turn here was a hand-off or stopped before its admission (the held one), so none leaves a second try.
        unexpected.length === 0 && turns.every(c => !c.base && !c.retryOf) && calls.some(c => c.route === 'allowance'),
        { unexpected, turns: turns.map(c => `${c.world}${c.held ? ' (held)' : ''}${c.retryOf ? ` retryOf ${c.retryOf}` : ''}`) });
    failed = steps.some(s => !s.ok);
} catch (e) {
    console.error(`ea9-g1: ${e?.stack ?? e}`);
    step('the drive ran to its end', false, String(e?.stack ?? e).slice(0, 400));
} finally {
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, film: FILM, steps, calls, console: consoleLines.map(l => `${l.at >= crashedAt ? '[after the crash] ' : ''}${l.line}`) }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea9-g1 (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    await browser?.send('Browser.close').catch(() => {});
    page?.close();
    browser?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopAll();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
