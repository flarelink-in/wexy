// The studio drive, "by eye" (docs/product/film-adoption-design.md §8 and §10): the studio itself,
// through its dialog, in headless Chrome on one GPU. Forge Kerr, open "Make video", measure, make a vertical HD
// film (double-clicked: progress at once, one film; it plays in the dialog) and a square 4K film (downloaded and
// read back with ffprobe), cancel a wide 4K film, close the dialog (its film let go from OPFS), take a photo
// (downloaded, decoded by ffmpeg: size and alpha), and check the preview runs on. A screenshot of every state, the
// downloads and steps.json go to dev/out/drive-studio/<gpu>-<time>/. Exits 1 when a step fails.
//   node dev/drive-studio.mjs [--gpu nvidia] [--out dir] [--chrome path]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const gpu = opt('gpu', 'amd');
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('drive: no Chrome found; pass --chrome <path>.'); process.exit(2); }
for (const tool of ['ffprobe', 'ffmpeg']) {
    if (spawnSync(tool, ['-version']).status !== 0) { console.error(`drive: ${tool} is not on PATH; downloads cannot be read back.`); process.exit(2); }
}
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-studio', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const downloads = join(OUT, 'downloads');
mkdirSync(downloads, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };

// Vite for the studio, on a port of its own.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5197', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
const origin = 'http://127.0.0.1:5197';
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/studio.html`)).ok) break; } catch { /* starting */ } await sleep(200); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-studio-drive-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
    '--window-size=1440,900', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 150 && !target; i++) {
    try {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    } catch { /* not yet */ }
    if (!target) await sleep(200);
}
const [port, browserPath] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(s => s.trim());
function connect(url, onEvent = () => {}) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else onEvent(m); };
    const ready = new Promise(r => { ws.onopen = r; });
    return { ready, send: (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
const consoleErrors = [];
const downloadsDone = [];
/** The dialog's own line per film made ("Wexy: completed film, …"): a double start shows as two. */
let filmsLogged = 0;
const page = connect(target.webSocketDebuggerUrl, m => {
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'info' && /^Wexy: \w+ film/.test(m.params.args[0]?.value ?? '')) filmsLogged++;
});
const browser = connect(`ws://127.0.0.1:${port}${browserPath}`, m => { if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') downloadsDone.push(m.params.guid); });
await page.ready;
await browser.ready;
await page.send('Runtime.enable');
await page.send('Page.enable');
await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads.replace(/\//g, '\\'), eventsEnabled: true });

const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const waitFor = async (expression, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression).catch(() => false)) return true; await sleep(250); }
    step(`waited for ${what}`, false, `not within ${ms / 1000} s`);
    return false;
};
const shot = async name => writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const clickText = text => evaluate(`(() => { const b = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const measured = `(() => { const e = document.querySelector('.export-dialog .ex-estimate'); return !!e && !e.textContent.includes('Measuring') && (e.textContent.includes('Takes') || !!document.querySelector('.export-dialog .ex-warn')); })()`;
const dialogTitle = `document.querySelector('#ex-title')?.textContent ?? ''`;
const opfsFilms = `(async () => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('null-graph-films'); let n = 0; for await (const _ of d.keys()) n++; return n; } catch { return 0; } })()`;
const shownLocks = `(async () => (await navigator.locks.query()).held.filter(l => l.name.startsWith('wexy-film:')).length)()`;
/** The next finished download. With allowAndName it is named after its GUID; Chrome's temporary .crdownload is not. */
const nextDownload = async (before, ms = 60000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
        if (downloadsDone.length > before && existsSync(join(downloads, downloadsDone[before]))) return join(downloads, downloadsDone[before]);
        await sleep(250);
    }
    return null;
};
const probe = file => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,pix_fmt', '-of', 'json', file]);
    return r.status === 0 ? JSON.parse(String(r.stdout)).streams[0] : { error: String(r.stderr) };
};
/** A PNG decoded by ffmpeg to RGBA: its size, its stored pixel format, and the pixels whose alpha is not 255. */
const decodePNG = file => {
    const info = probe(file);
    if (info.error) return info;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return { error: String(r.stderr) };
    let translucent = 0;
    for (let i = 3; i < r.stdout.length; i += 4) if (r.stdout[i] !== 255) translucent++;
    return { width: info.width, height: info.height, pixFmt: info.pix_fmt, bytes: r.stdout.length, translucent };
};

try {
    await page.send('Page.navigate', { url: `${origin}/studio.html?scene=kerr-black-hole&dev=1&format=wide` });
    const forged = await waitFor(`!document.querySelector('#btn-export')?.disabled`, 180000, 'the scene to be forged');
    step('the studio forges Kerr and offers "Make video"', forged);
    await sleep(2500);
    await shot('01-studio-live');
    const hud = `document.querySelector('#hud-res')?.textContent ?? ''`;
    const hudAtStart = await evaluate(hud);

    // The dialog: open, measured by the runner's dry run.
    await evaluate(`document.querySelector('#btn-export').click()`);
    step('the dialog measures the default size and shows an estimate', await waitFor(measured, 90000, 'the first measurement'), await evaluate(`document.querySelector('.export-dialog .ex-estimate')?.textContent`));
    await shot('02-dialog-wide-fhd');
    const devDetails = await evaluate(`document.querySelector('.export-dialog .ex-summary')?.innerText`);
    step('Developer view shows the measured GPU cost', /per frame/.test(devDetails ?? ''), devDetails);

    // A vertical HD film, 6 s.
    await clickText('Vertical'); await sleep(100); await clickText('HD'); await sleep(100); await clickText('6 s');
    await waitFor(measured, 90000, 'the vertical HD measurement');
    await shot('03-dialog-tall-hd');
    // A double click: two clicks on the same button before anything re-renders. One film, and progress at once.
    const filmsBefore = filmsLogged;
    const feedback = await evaluate(`(async () => {
        const go = [...document.querySelectorAll('.export-dialog button')].find(b => b.textContent.includes('Make video'));
        const t0 = performance.now();
        go.click(); go.click();
        const t = document.querySelector('#ex-title');
        while (!/Making/.test(t.textContent) && performance.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
        return Math.round(performance.now() - t0);
    })()`);
    step('"Make video" shows its progress at once (under 300 ms)', feedback < 300, { ms: feedback });
    await sleep(800);
    await shot('04-making-tall-hd');
    const madeTall = await waitFor(`/ready|Part of your video/.test(${dialogTitle})`, 240000, 'the vertical HD film');
    await sleep(500);
    await shot('05-done-tall-hd');
    const doneLine = await evaluate(`document.querySelector('.export-dialog .ex-done-line')?.textContent`);
    const video = await evaluate(`(async () => { const v = document.querySelector('.export-dialog video'); if (!v) return null; if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true })); const t0 = v.currentTime; await new Promise(r => setTimeout(r, 1500)); return { w: v.videoWidth, h: v.videoHeight, duration: v.duration, src: v.src.slice(0, 5), muted: v.muted, paused: v.paused, advanced: v.currentTime !== t0 }; })()`);
    step('the vertical HD film is made and plays in the dialog (720×1280, 6 s, muted, time advancing)', madeTall && video?.w === 720 && video?.h === 1280 && Math.abs(video.duration - 6) < 0.1 && video.muted && !video.paused && video.advanced, { doneLine, video });
    await sleep(2500); // a second film from the double click would have finished by now
    step('the double click made one film', filmsLogged - filmsBefore === 1, { films: filmsLogged - filmsBefore });
    step('while shown: one film in OPFS, held by Wexy\'s lock', (await evaluate(opfsFilms)) === 1 && (await evaluate(shownLocks)) === 1, { films: await evaluate(opfsFilms), locks: await evaluate(shownLocks) });
    let before = downloadsDone.length;
    await clickText('Download');
    const tallFile = await nextDownload(before);
    const tallProbe = tallFile ? probe(tallFile) : null;
    step('Download saves it; ffprobe reads 360 H.264 frames at 720×1280', tallProbe?.codec_name === 'h264' && tallProbe.width === 720 && tallProbe.height === 1280 && Number(tallProbe.nb_read_frames) === 360, { file: tallFile, tallProbe });

    // Make another: a square 4K film, 6 s; the first film let go first.
    await clickText('Make another');
    await waitFor(measured, 90000, 'the setup again');
    step('"Make another" lets the first film go from OPFS', (await evaluate(opfsFilms)) === 0, { films: await evaluate(opfsFilms) });
    await clickText('Square'); await sleep(100); await clickText('4K');
    await waitFor(measured, 120000, 'the square 4K measurement');
    await shot('06-dialog-square-4k');
    await clickText('Make video');
    const madeSquare = await waitFor(`/ready|Part of your video/.test(${dialogTitle})`, 600000, 'the square 4K film');
    await sleep(500);
    await shot('07-done-square-4k');
    const squareSummary = await evaluate(`document.querySelector('.export-dialog .ex-summary')?.innerText`);
    before = downloadsDone.length;
    await clickText('Download');
    const squareFile = await nextDownload(before, 120000);
    const squareProbe = squareFile ? probe(squareFile) : null;
    step('a square 4K film: 360 H.264 frames at 2160×2160', madeSquare && squareProbe?.width === 2160 && squareProbe.height === 2160 && Number(squareProbe.nb_read_frames) === 360, { squareProbe, squareSummary });

    // Close: the film is let go (OPFS empty, lock released).
    await evaluate(`document.querySelector('.export-dialog .icon-btn').click()`);
    await sleep(800);
    step('closing the dialog lets the film go: OPFS empty, no lock held', (await evaluate(opfsFilms)) === 0 && (await evaluate(shownLocks)) === 0, { films: await evaluate(opfsFilms), locks: await evaluate(shownLocks) });

    // A cancel: wide 4K, cancelled 2 s in.
    await evaluate(`document.querySelector('#btn-export').click()`);
    await waitFor(measured, 90000, 'the measurement before the cancel');
    await clickText('Wide'); await sleep(100); await clickText('4K');
    await waitFor(measured, 120000, 'the wide 4K measurement');
    await clickText('Make video');
    await sleep(2000);
    await shot('08-making-wide-4k');
    await clickText('Cancel');
    const backToSetup = await waitFor(`/Make a video/.test(${dialogTitle}) && !!document.querySelector('.export-dialog .ex-estimate')`, 60000, 'the setup after the cancel');
    step('Cancel returns to the setup and leaves nothing in OPFS', backToSetup && (await evaluate(opfsFilms)) === 0, { films: await evaluate(opfsFilms) });
    await evaluate(`document.querySelector('.export-dialog .icon-btn').click()`);
    await sleep(500);

    // The photo: a Full HD PNG of the live view, opaque.
    before = downloadsDone.length;
    await evaluate(`document.querySelector('#btn-snapshot').click()`);
    const photo = await nextDownload(before);
    const png = photo ? decodePNG(photo) : null;
    step('Photo saves a 1920×1080 PNG of the live view, opaque everywhere', png?.width === 1920 && png?.height === 1080 && png.bytes === 1920 * 1080 * 4 && png.translucent === 0, { photo, png });

    // The preview runs on.
    const a = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
    await sleep(700);
    const b = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
    // The preview's internal size, as its frame guard sets it: reported, not judged (the guard may rightly step down).
    step('the preview runs on after all of it (two screenshots 0.7 s apart differ)', a !== b, { resolution: { atStart: hudAtStart, afterPhoto: await evaluate(hud) } });
    await shot('09-studio-after');
    step('no console error or exception', consoleErrors.length === 0, consoleErrors.slice(0, 5));
} finally {
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, steps, consoleErrors }, null, 1));
    await browser.send('Browser.close').catch(() => {});
    page.close(); browser.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(1000);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
    const failed = steps.filter(s => !s.ok).length;
    console.log(`\ndrive (${gpu}): ${steps.length - failed}/${steps.length} steps ok — screenshots in ${OUT}`);
    process.exit(failed ? 1 : 0);
}
