// EA5.5's EA-F2 on one real GPU (executor-design.md §9a, §10): a film and a photo of each live world through the studio's
// own export dialog, with no paid call. Each world goes on the stage as EA-E puts it there: the studio under ?agent=1 on
// Vite, against a local stand-in gateway that answers the agent routes from the backend's recordings (the hand-off turn
// carrying that world's program; each module call its sealed body), then Write the modules (L3 on the device) and Run on
// this GPU. Then, for each of block-film, galaxy and foggy-dusk:
//   - Film and Photo offered for the agent world;
//   - Make a video: the dialog measures the default size (Wide, 1080p, 60 fps), then 6 s are made; Download; ffprobe reads
//     360 H.264 frames at 1920×1080; the studio's own account of the film (Developer view's console line): its frames at
//     one fixed step a frame from time zero, frame 0 at step 0, none off time; and the stage's ledger the same after every
//     film and measurement of the world, so nothing of them stays held;
//   - Photo: a 1920×1080 PNG, opaque everywhere, of the world at time zero, from the same view: the film's frame 0 is
//     that picture, within the codec's error (its last frame is said beside it, for scale);
//   - no console error and no WebGPU error;
//   - and for the first world, a 4K film (past what EA-G1 ran, 2048×1152), measured at its size since coverage became
//     advisory (G1, 23d37da): offered with its cost, or refused by the probe in the studio's words; the world still on
//     the stage.
// Screenshots, the films and photos and steps.json go to dev/out/ea-f2/<gpu>-<time>/. Exit 0 when every step passes; 1
// otherwise; 2 when Chrome, Vite, ffprobe or ffmpeg cannot start. On the charger only, one GPU a run.
//   node dev/ea-f2.mjs --gpu amd|nvidia [--worlds block-film,galaxy,foggy-dusk] [--chrome path] [--out dir]
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
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea-f2: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const WORLDS = opt('worlds', 'block-film,galaxy,foggy-dusk').split(',');
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea-f2: no Chrome found; pass --chrome <path>.'); await quit(2); }
for (const tool of ['ffprobe', 'ffmpeg']) {
    if (spawnSync(tool, ['-version']).status !== 0) { console.error(`ea-f2: ${tool} is not on PATH; the films cannot be read back.`); await quit(2); }
}
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea-f2', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
const downloads = join(OUT, 'downloads');
mkdirSync(downloads, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); };
/** The film's size and length: the dialog's defaults (Wide, 1080p, 60 fps), and its shortest length. */
const FILM = { width: 1920, height: 1080, fps: 60, seconds: 6 };
/** A frame's mean difference from the photo, per byte of RGB, that H.264's error stays within at this size (8-bit levels). */
const SAME_PICTURE = 6;

// ---- the stand-in gateway: the backend's recordings, answered as the backend answers them, for one world at a time --
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const handedOff = fixture('test/fixtures/agent-wire/handed-off.sse');
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
let world = null;
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
        if (req.method === 'POST' && req.url === '/v1/agent/turn' && world) {
            calls.push({ world: world.name, route: 'turn' });
            sse(edit(handedOff, 'program', () => ({ program: { nodes: world.program.nodes } })));
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/agent/module' && world) {
            const call = JSON.parse(body);
            const answer = world.modules.find(m => m.module === call.module?.id)?.body ?? null;
            calls.push({ world: world.name, route: 'module', module: call.module?.id, purpose: call.purpose });
            if (answer === null) { res.writeHead(404, cors); res.end('{}'); return; }
            sse(moduleStream(call, answer));
            return;
        }
        // EA6.4: the studio reads a model's review's terms once a review reaches the session; the backend's recording,
        // every gate shut, so no review is ever sent.
        if (req.method === 'GET' && req.url === '/v1/agent/review') {
            calls.push({ route: 'review-terms' });
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(fixture('test/fixtures/review-wire/terms-shut.json'));
            return;
        }
        // W1 (EA9.1): the studio reads the chip around a turn; the backend's DTO, as dev/ea9-e1.mjs's stand-in answers it.
        if (req.method === 'GET' && req.url === '/v1/forge/allowance') {
            calls.push({ route: 'allowance' });
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ label: 'Free', left: 0, resetsAt: null }));
            return;
        }
        calls.push({ route: `${req.method} ${req.url}`, unexpected: true });
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end('{"error":{"code":"not_found"}}');
    });
});
await new Promise(r => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));

// ---- Vite for the studio, the stand-in as its origin, no Firebase: the local dev identity (as EA-E) ------------------
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
if (!up) { console.error(`ea-f2: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea-f2-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=1600,1000', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
let target = null;
let devtools = null;
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

// ---- reading the films and photos back ----------------------------------------------------------------------------
const probe = file => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,pix_fmt,r_frame_rate', '-of', 'json', file]);
    return r.status === 0 ? JSON.parse(String(r.stdout)).streams[0] : { error: String(r.stderr) };
};
/** RGB bytes of one picture: a film's frame `n`, or a PNG. */
/** A picture's (or a film's frame `n`'s) RGB, at full size or averaged down by `scale` (area). */
const rgb = (file, n = null, scale = 1) => {
    const filters = [...(n === null ? [] : [`select=eq(n\\,${n})`]), ...(scale > 1 ? [`scale=iw/${scale}:ih/${scale}:flags=area`] : [])];
    const args = ['-v', 'error', '-i', file, ...(filters.length ? ['-vf', filters.join(',')] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
    const r = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
};
const meanDifference = (a, b) => {
    if (!a || !b || a.length !== b.length) return null;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return Math.round((sum / a.length) * 1000) / 1000;
};
/** A PNG decoded to RGBA: its size, its pixel format, and the pixels whose alpha is not 255. */
const decodePNG = file => {
    const info = probe(file);
    if (info.error) return info;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return { error: String(r.stderr) };
    let translucent = 0;
    for (let i = 3; i < r.stdout.length; i += 4) if (r.stdout[i] !== 255) translucent++;
    return { width: info.width, height: info.height, pixFmt: info.pix_fmt, bytes: r.stdout.length, translucent };
};

let failed = true;
let page = null;
let browser = null;
try {
    if (!target) throw new Error('Chrome did not open a page to drive');
    const consoleLines = [];
    const downloadsDone = [];
    page = connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
        if (m.method === 'Log.entryAdded') consoleLines.push(`${m.params.entry.level}: [${m.params.entry.source}] ${m.params.entry.text}`);
    });
    browser = connect(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`, m => { if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') downloadsDone.push(m.params.guid); });
    await page.ready;
    await browser.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Log.enable');
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads.replace(/\//g, '\\'), eventsEnabled: true });
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
    const clickText = text => evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const measured = `(() => { const e = document.querySelector('.export-dialog .ex-estimate'); return !!e && !e.textContent.includes('Measuring') && (e.textContent.includes('Takes') || !!document.querySelector('.export-dialog .ex-warn')); })()`;
    const dialogTitle = `document.querySelector('#ex-title')?.textContent ?? ''`;
    /** The next finished download, kept under `name`: with allowAndName Chrome names it by its GUID. */
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
    const studio = `${studioOrigin}/studio.html?agent=1&dev=1`;
    const accountRe = /^info: Wexy: agent film ([0-9a-f]{12})…, (\d+) frames at (\d+) step\(s\) a frame from time zero; frame 0 at step (\d+|null); (\d+) frame\(s\) off time; the stage's ledger holds (\d+) bytes$/;

    for (const name of WORLDS) {
        world = { name, ...JSON.parse(fixture(`test/fixtures/live-candidates/${name}.json`)) };
        const since = consoleLines.length;
        await page.send('Page.navigate', { url: studio });
        const started = await until(`!!document.querySelector('#gpu-pill i.ok') && [...document.querySelectorAll('.cand button')].some(b => b.textContent === 'Run on this GPU' && !b.hidden)`, 30_000);
        step(`${name}: the studio starts under ?agent=1`, started, { gpu: await evaluate(`document.querySelector('#gpu-pill')?.textContent`) });
        await click('Run agent turn');
        const handed = await until(`document.querySelector('.agent')?.dataset.phase === 'handed-off'`, 30_000);
        await click('Write the modules');
        const sealed = await until(`['static-verified', 'failed', 'exhausted'].includes(document.querySelector('.cand')?.dataset.phase)`, 90_000);
        const cand = await evaluate(`({ phase: document.querySelector('.cand')?.dataset.phase, l3: document.querySelector('.cand')?.dataset.l3 })`);
        await click('Run on this GPU');
        await until(`!['running', 'idle'].includes(document.querySelector('.cand')?.dataset.run)`, 120_000);
        const run = await evaluate(`({ run: document.querySelector('.cand')?.dataset.run, line: document.querySelector('.cand-run')?.textContent })`);
        await sleep(1000);
        const offered = await evaluate(`({ title: document.querySelector('#hud-title')?.textContent, film: !document.querySelector('#btn-export')?.disabled, photo: !document.querySelector('#btn-snapshot')?.disabled, bar: !document.querySelector('#capture-bar')?.hidden })`);
        step(`${name}: on the stage (the turn, the modules compiled on this device, Run), with Film and Photo offered`,
            handed && sealed && cand.phase === 'static-verified' && cand.l3 === 'device' && run.run === 'installed' && offered.film && offered.photo && offered.bar,
            { cand, run, offered });
        await shot(`${name}-on-the-stage`);
        if (run.run !== 'installed') continue;
        // The world's id(C), from Developer view's Run line: its HUD title is its creation's, from the idea (EA9.1).
        const id = (run.line ?? '').match(/id\(C\) ([0-9a-f]{12})…/)?.[1] ?? null;

        // The film: the dialog measures the default size (its candidate built and probed at 1080p), then 6 s.
        await evaluate(`document.querySelector('#btn-export').click()`);
        const first = await until(measured, 120_000);
        await clickText(`${FILM.seconds} s`);
        await sleep(300);
        const estimate = await evaluate(`document.querySelector('.export-dialog .ex-estimate')?.textContent ?? ''`);
        const refusal = await evaluate(`document.querySelector('.export-dialog .ex-warn')?.textContent ?? ''`);
        const summary = await evaluate(`document.querySelector('.export-dialog .ex-summary')?.innerText ?? ''`);
        step(`${name}: the dialog measured the film at ${FILM.width}×${FILM.height}, ${FILM.fps} fps`, first && /Takes/.test(estimate) && !refusal, { estimate, refusal, summary: summary.replace(/\s+/g, ' ').slice(0, 300) });
        await shot(`${name}-dialog`);
        const filmStart = Date.now();
        await clickText('Make video');
        const made = await until(`/ready|Part of your video/.test(${dialogTitle}) || !!document.querySelector('.export-dialog .ex-warn')`, 600_000);
        const madeMs = Date.now() - filmStart;
        const title = await evaluate(dialogTitle);
        await shot(`${name}-film-made`);
        let before = downloadsDone.length;
        await clickText('Download');
        const filmFile = /ready/.test(title) ? await nextDownload(before, `${name}.mp4`) : null;
        const film = filmFile ? probe(filmFile) : null;
        const frames = FILM.fps * FILM.seconds;
        step(`${name}: the film made and downloaded: ffprobe reads ${frames} H.264 frames at ${FILM.width}×${FILM.height}`,
            made && /ready/.test(title) && film?.codec_name === 'h264' && film.width === FILM.width && film.height === FILM.height && Number(film.nb_read_frames) === frames,
            { title, madeMs, film, warn: await evaluate(`document.querySelector('.export-dialog .ex-warn')?.textContent ?? null`) });
        await evaluate(`document.querySelector('.export-dialog .icon-btn')?.click()`);
        await sleep(800);

        // The photo: Full HD, the world's time zero, from the view on the stage (the film's own still).
        before = downloadsDone.length;
        await evaluate(`document.querySelector('#btn-snapshot').click()`);
        const photoFile = await nextDownload(before, `${name}.png`);
        const png = photoFile ? decodePNG(photoFile) : null;
        step(`${name}: the photo, a ${FILM.width}×${FILM.height} PNG, opaque everywhere`, png?.width === FILM.width && png?.height === FILM.height && png.translucent === 0, { png });

        // Frame 0 is time zero: the photo's picture, within the codec's error. Both are compared averaged down 4× (area):
        // since an agent world is framed on what it built (11-02), block-film's picture is busy and its grain per-pixel
        // noise, which H.264 does not keep (7.1 levels at full size, 2.6 averaged down; 2.1 on 11-02, when the camera
        // looked at a flat wall). A different view, or another moment of a moving world, does not average out.
        const SCALE = 4;
        const picture = photoFile ? rgb(photoFile, null, SCALE) : null;
        const atZero = filmFile ? meanDifference(rgb(filmFile, 0, SCALE), picture) : null;
        const atLast = filmFile ? meanDifference(rgb(filmFile, frames - 1, SCALE), picture) : null;
        const fullSize = photoFile && filmFile ? meanDifference(rgb(filmFile, 0), rgb(photoFile)) : null;
        step(`${name}: the film's frame 0 is the photo of time zero (mean difference ≤ ${SAME_PICTURE} levels, both averaged down ${SCALE}×; its last frame for scale)`,
            atZero !== null && atZero <= SAME_PICTURE, { frame0: atZero, lastFrame: atLast, frame0FullSize: fullSize });

        // The studio's account of the film and of each measurement: frame k at k·s steps from time zero; nothing held after.
        const lines = consoleLines.slice(since);
        const accounts = lines.map(l => accountRe.exec(l)).filter(Boolean).map(m => ({ id: m[1], frames: Number(m[2]), stepsPerFrame: Number(m[3]), firstFrameSteps: m[4] === 'null' ? null : Number(m[4]), offTime: Number(m[5]), held: Number(m[6]) }));
        const filmAccount = accounts.find(a => a.frames === frames);
        step(`${name}: the studio's account: ${frames} frames at one fixed step a frame from time zero, none off time; the ledger the same after every film and measurement`,
            !!filmAccount && filmAccount.id === id && filmAccount.stepsPerFrame === 1 && filmAccount.firstFrameSteps === 0 && filmAccount.offTime === 0
            && accounts.every(a => a.offTime === 0 && a.firstFrameSteps === 0 && a.held === accounts[0].held),
            { accounts });
        const errors = lines.filter(l => /^(error|exception)/.test(l) || /WebGPU|GPUValidationError|Invalid /.test(l));
        step(`${name}: no console error and no WebGPU error`, errors.length === 0, errors.slice(0, 5));

        // 4K, past what EA-G1 ran (2048×1152). Coverage has been advisory since 23d37da (G1): no entry refuses nothing, and
        // the probe decides at the film's size. So the film is measured at 3840×2160, its cost said, and Make video is
        // offered, or the probe refuses it in the studio's words, its reason in Developer view; the world still on the stage.
        if (name === WORLDS[0]) {
            await evaluate(`document.querySelector('#btn-export').click()`);
            await until(measured, 120_000);
            await clickText('4K');
            await sleep(300);
            const measured4k = await until(`(() => { const e = document.querySelector('.export-dialog .ex-estimate'); return !!e && !e.textContent.includes('Measuring'); })()`, 120_000);
            const said = await evaluate(`document.querySelector('.export-dialog .ex-warn')?.textContent ?? ''`);
            const detail = await evaluate(`document.querySelector('.export-dialog .ex-note-block')?.textContent ?? ''`);
            const summary4k = await evaluate(`document.querySelector('.export-dialog .ex-summary')?.innerText ?? ''`);
            const disabled = await evaluate(`[...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes('Make video'))?.disabled ?? null`);
            await shot(`${name}-4k`);
            await evaluate(`document.querySelector('.export-dialog .icon-btn')?.click()`);
            await sleep(500);
            const still = await evaluate(`document.querySelector('#hud-title')?.textContent`);
            const offered4k = disabled === false && said === '' && /3840×2160/.test(summary4k) && /\d+(\.\d+)? ms per frame/.test(summary4k);
            const refused4k = disabled === true && said === 'This world could not be filmed at this size; it is still on the stage.' && /^EA_FILM [0-9a-f]{12}… at 3840x2160: /.test(detail);
            step(`${name}: a 4K film, past EA-G1's sizes, measured at its size (coverage advisory, G1): offered with its cost, or refused by the probe in the studio's words; the world still on the stage`,
                measured4k && (offered4k || refused4k) && still === offered.title, { offered: offered4k, said, detail: detail.slice(0, 240), summary: summary4k.replace(/\s+/g, ' ').slice(0, 240), disabled, still });
        }
    }
    const unexpected = calls.filter(c => c.unexpected);
    step('the stand-in gateway was asked only for the agent routes', unexpected.length === 0, unexpected);
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel: steps[0]?.detail?.gpu ?? null, film: FILM, steps, calls, console: consoleLines }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea-f2 (${gpu}): ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
} catch (e) {
    console.error(`ea-f2: ${e?.stack ?? e}`);
} finally {
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
