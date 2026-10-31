// The film gates' runner (docs/product/film-adoption-design.md §8): dev/film-gates.html in Chrome on
// each GPU, its films read back with ffprobe. Self-contained in this folder:
// - Vite runs in process, with a middleware the page uploads its films to;
// - one Chrome runs per GPU, the GTX 1650 through --force_high_performance_gpu (Chrome on Windows ignores
//   powerPreference), with --expose-gc for the teardown cases;
// - every DevTools call times out after 60 s, and a lost DevTools connection (a system sleep closes it) fails
//   its case and restarts Chrome.
//
//   node dev/film-gates.mjs [--gpu amd,nvidia] [--only FG1,FG2] [--timeout 900] [--keep] [--headed]
//
// A page asks for what it cannot do itself by logging "[g] action <name>": gpucrash ends Chrome's GPU process.
// For each uploaded film ffprobe checks J packets and decoded frames, the size, H.264 4:2:0, every timestamp
// within one container tick of j / fps, a key frame every 2 s, and the MP4's top-level boxes for its target.
// Results: dev/out/film-gates/<time>/results.json and summary.md; films are deleted once read unless --keep.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, createWriteStream, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
};
const list = (name, fallback) => option(name, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALL = ['FG1', 'FG2', 'FG3', 'FG4', 'FG5', 'FG6', 'FG7'];
/** Cases that need no browser: they run once, before the GPUs. */
const NODE_CASES = ['FG7'];
const GPUS = list('gpu', 'amd,nvidia');
const ONLY = list('only', ALL.join(','));
const HEADED = flag('headed');
const KEEP = flag('keep');
const TIMEOUT_MS = Number(option('timeout', 900)) * 1000;
const OUT = resolve(option('out', join(root, 'dev', 'out', 'film-gates', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
const CHROME = [option('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('film gates: no Chrome found; pass --chrome <path>.'); process.exit(2); }
for (const c of ONLY) if (!ALL.includes(c)) { console.error(`film gates: unknown case ${c}; cases: ${ALL.join(', ')}.`); process.exit(2); }
for (const tool of ['ffprobe', 'ffmpeg']) {
    if (spawnSync(tool, ['-version']).status !== 0) { console.error(`film gates: ${tool} is not on PATH; films cannot be read back.`); process.exit(2); }
}
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------
// Vite, with an upload endpoint
// ---------------------------------------------------------------------------------------------------

let uploadDir = OUT;
const vite = await createServer({
    root,
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 5191, strictPort: false, hmr: false },
    // Pre-bundle every dependency the page imports at start-up, so Vite never reloads a page mid-case to add one.
    optimizeDeps: { entries: ['dev/film-gates.html'], include: ['null-graph', 'null-graph/film', 'null-graph/post', 'null-graph/cameras', 'mediabunny'] },
    plugins: [{
        name: 'film-gates-uploads',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (req.method !== 'PUT' || !req.url?.startsWith('/__g/upload/')) return next();
                const name = decodeURIComponent(req.url.slice('/__g/upload/'.length));
                if (!/^[\w.-]+$/.test(name)) { res.statusCode = 400; res.end(); return; }
                try { await pipeline(req, createWriteStream(join(uploadDir, name))); res.statusCode = 204; } catch { res.statusCode = 500; }
                res.end();
            });
        },
    }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');

// ---------------------------------------------------------------------------------------------------
// Chrome over the DevTools protocol
// ---------------------------------------------------------------------------------------------------

const CDP_TIMEOUT_MS = 60_000;

async function connect(url, onEvent) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(`DevTools WebSocket ${url} failed`)); });
    let nextId = 1;
    const pending = new Map();
    const conn = {
        closed: false,
        send: (method, params = {}) => new Promise((ok, fail) => {
            if (conn.closed) { fail(new Error(`DevTools socket closed; ${method} not sent`)); return; }
            const id = nextId++;
            const timer = setTimeout(() => { pending.delete(id); fail(new Error(`DevTools did not answer ${method} in ${CDP_TIMEOUT_MS / 1000} s`)); }, CDP_TIMEOUT_MS);
            pending.set(id, { ok: v => { clearTimeout(timer); ok(v); }, fail: e => { clearTimeout(timer); fail(e); } });
            ws.send(JSON.stringify({ id, method, params }));
        }),
        close: () => { try { ws.close(); } catch { /* gone */ } },
    };
    const drop = why => {
        conn.closed = true;
        for (const { fail } of pending.values()) fail(new Error(`DevTools socket closed (${why}) before it answered`));
        pending.clear();
    };
    ws.onclose = ev => drop(`code ${ev.code}`);
    ws.onerror = () => drop('error');
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { ok, fail } = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) fail(new Error(m.error.message)); else ok(m.result);
        } else {
            onEvent(m);
        }
    };
    return conn;
}

/** A Chrome that did not close (its DevTools gone with a system sleep, say): the browser and every child process. */
function killTree(proc) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    else try { proc.kill('SIGKILL'); } catch { /* gone */ }
}

async function openChrome(gpu) {
    const profile = mkdtempSync(join(tmpdir(), 'wexy-film-gates-'));
    const proc = spawn(CHROME, [
        ...(HEADED ? ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : ['--headless=new']),
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', '--js-flags=--expose-gc',
        '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    let target = null;
    for (const deadline = Date.now() + 30_000; !target && Date.now() < deadline;) {
        try {
            const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
            target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        } catch { /* not listening yet */ }
        if (!target) await sleep(200);
    }
    if (!target) throw new Error(`Chrome exposed no page\n${stderr}`);
    const lines = [];
    const page = await connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            lines.push({ t: Date.now(), kind: m.params.type, text: (m.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ') });
        } else if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            lines.push({ t: Date.now(), kind: 'exception', text: d?.exception?.description ?? d?.text });
        }
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const [port, browserPath] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(s => s.trim());
    const browser = await connect(`ws://127.0.0.1:${port}${browserPath}`, () => {});
    return {
        pid: proc.pid, lines, send: page.send, browser: browser.send,
        alive: () => !page.closed && !browser.closed,
        async close() {
            // Browser.close ends the browser with its GPU, renderer and utility processes; killing the browser
            // process alone leaves those running on Windows.
            await browser.send('Browser.close').catch(() => {});
            page.close();
            browser.close();
            for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
            if (proc.exitCode === null) killTree(proc);
            await sleep(500);
            try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort: crashpad may outlive the browser by a few seconds */ }
        },
    };
}

/** gpucrash: end Chrome's GPU process (DevTools' command; not awaited, the browser need not answer it). */
async function act(chrome, action) {
    if (action === 'gpucrash') chrome.browser('Browser.crashGpuProcess').catch(e => console.log(`   gpucrash: ${e.message}`));
    else throw new Error(`unknown action ${action}`);
}

// ---------------------------------------------------------------------------------------------------
// Reading the films back
// ---------------------------------------------------------------------------------------------------

function topLevelBoxes(file) {
    const fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const boxes = [];
    for (let at = 0; at + 8 <= size;) {
        readSync(fd, head, 0, 16, at);
        let len = head.readUInt32BE(0);
        if (len === 1) len = Number(head.readBigUInt64BE(8));
        else if (len === 0) len = size - at;
        boxes.push(head.toString('latin1', 4, 8));
        if (len < 8) break;
        at += len;
    }
    closeSync(fd);
    return boxes;
}

const ff = (tool, args) => spawnSync(tool, args, { maxBuffer: 1 << 28 });

function probe(file) {
    const s = ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
        'stream=codec_name,width,height,pix_fmt,time_base,nb_read_frames:format=size,bit_rate', '-of', 'json', file]);
    if (s.status !== 0) return { error: String(s.stderr).trim() };
    const { streams: [stream = {}] = [], format = {} } = JSON.parse(String(s.stdout));
    const [num, den] = (stream.time_base ?? '1/1').split('/').map(Number);
    const packets = String(ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,flags', '-of', 'csv=p=0', file]).stdout)
        .trim().split(/\r?\n/).filter(Boolean).map(l => { const [pts, flags] = l.split(','); return { pts: Number(pts), key: flags.includes('K') }; });
    return {
        codec: stream.codec_name, width: stream.width, height: stream.height, pixFmt: stream.pix_fmt, timeBase: [num, den],
        decoded: Number(stream.nb_read_frames), packets, bytes: Number(format.size), bitRate: Number(format.bit_rate), boxes: topLevelBoxes(file),
    };
}

/** The checks of one uploaded film against what the page said it holds: { file, id, width, height, fps, frames, target, partial? }. */
function checkVideo(dir, v, checks) {
    const path = join(dir, v.file);
    const add = (name, ok, detail = null) => checks.push({ name: `${v.id}: ${name}`, ok: !!ok, detail });
    if (!existsSync(path)) { add('was uploaded', false); return null; }
    const p = probe(path);
    if (p.error) { add('ffprobe reads it', false, p.error); return p; }
    const facts = { codec: p.codec, size: `${p.width}x${p.height}`, pixFmt: p.pixFmt, boxes: p.boxes, bytes: p.bytes, mbps: Math.round(p.bitRate / 1e5) / 10 };
    add(`${v.frames} packets and ${v.frames} decoded frames`, p.packets.length === v.frames && p.decoded === v.frames, { packets: p.packets.length, decoded: p.decoded });
    const want = v.target === 'memory' ? ['ftyp', 'moov', 'mdat'] : ['ftyp', 'moov', 'free', 'mdat'];
    add(`boxes ${want.join(' ')} (${v.target})`, JSON.stringify(p.boxes) === JSON.stringify(want), p.boxes);
    if (v.partial) return { ...p, facts };
    add(`${v.width}×${v.height} h264 yuv420p`, p.width === v.width && p.height === v.height && p.codec === 'h264' && p.pixFmt === 'yuv420p', facts);
    const [num, den] = p.timeBase;
    const pts = p.packets.map(x => x.pts).sort((a, b) => a - b);
    const worst = Math.max(0, ...pts.map((t, j) => Math.abs((t - pts[0]) - Math.round(j * den / (v.fps * num)))));
    add('every timestamp within one container tick of j / fps, from 0', pts[0] === 0 && worst <= 1, { firstPts: pts[0], worstTicks: worst });
    const keys = p.packets.filter(x => x.key).map(x => x.pts).sort((a, b) => a - b);
    const wantKeys = Math.ceil(v.frames / (2 * v.fps));
    add(`a key frame every 2 s (${wantKeys})`, keys.length === wantKeys && keys[0] === 0, { keys: keys.length });
    return { ...p, facts };
}

// ---------------------------------------------------------------------------------------------------
// FG7: the package, no browser
// ---------------------------------------------------------------------------------------------------

/**
 * The published null-graph as an app meets it: Wexy depends on the registry package and typechecks and builds against
 * it, and a bare consumer (types: [], skipLibCheck: false, no mediabunny installed) type-checks the package's
 * declarations through its exports map. One copy of the core in the page is FG1's instanceof check.
 */
function packageGate() {
    const checks = [];
    const add = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail });
    const dep = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['null-graph'];
    const installed = JSON.parse(readFileSync(join(root, 'node_modules/null-graph/package.json'), 'utf8')).version;
    const locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/null-graph'];
    add(`Wexy depends on the published package (${dep}), installed as ${installed}`,
        dep === '1.2.0' && installed === '1.2.0' && locked.version === '1.2.0'
        && locked.resolved === 'https://registry.npmjs.org/null-graph/-/null-graph-1.2.0.tgz'
        && locked.integrity === 'sha512-5FtlMcfBakZPx6hUpiih6rP7z/vypjCSJ/KN0XJHxdFqflrgLF9t07gZJHSOfIxvi4fhbE6tA5GUpWtgPLTaIQ==',
        { dep, installed, resolved: locked.resolved, integrity: locked.integrity });
    for (const script of ['typecheck', 'build']) {
        const r = spawnSync('npm', ['run', script], { cwd: root, encoding: 'utf8', shell: true });
        add(`npm run ${script} passes against the package`, r.status === 0, r.status === 0 ? null : `${r.stdout}${r.stderr}`.slice(-1500));
    }
    const dir = mkdtempSync(join(tmpdir(), 'wexy-consumer-'));
    try {
        cpSync(join(root, 'node_modules/null-graph'), join(dir, 'node_modules/null-graph'), { recursive: true });
        cpSync(join(root, 'node_modules/gl-matrix'), join(dir, 'node_modules/gl-matrix'), { recursive: true });
        const webgpu = join(root, 'node_modules/@webgpu/types/dist/index.d.ts').replace(/\\/g, '/');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
        writeFileSync(join(dir, 'consumer.ts'), `/// <reference path="${webgpu}" />
import { NullGraph } from 'null-graph';
import {
    cleanupFilms, fitAspect, listFilms, probeFilm, recordFilm, snapshot,
    type CreateFilmWorkload, type FilmProgress, type FilmReport, type FilmResult, type FilmTarget,
} from 'null-graph/film';
const createWorkload: CreateFilmWorkload = async ({ engine, width, height }) => {
    const pass = engine.createPass({ name: 'consumer', isMainScreenPass: true });
    return { dt: 1 / 60, step() {}, draw: frame => (void fitAspect(frame.view ?? { target: [0, 0, 0], distance: 1, azimuth: 0, polar: 1 }, width / height), [pass]), dispose() {} };
};
export async function main(device: GPUDevice, target: FilmTarget): Promise<[FilmResult<FilmReport>, Uint8Array, number]> {
    const film = await recordFilm({ device, createWorkload, film: { width: 64, height: 36, fps: 60, seconds: 1 }, output: { target }, onProgress: (p: FilmProgress) => void p.etaMs });
    const shot = await snapshot({ device, createWorkload, width: 8, height: 8 });
    await cleanupFilms();
    const support = await probeFilm({ device, width: 64, height: 36, fps: 60 });
    return [film, shot.png, (await listFilms()).length + support.codecs.length + (new NullGraph().isDestroyed ? 1 : 0)];
}
`);
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'], types: [], skipLibCheck: false },
            files: ['consumer.ts'],
        }));
        const r = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
        add("the package's declarations type-check in a bare consumer (types: [], skipLibCheck: false), through its exports", r.status === 0, r.status === 0 ? null : `${r.stdout}${r.stderr}`.slice(-1500));
        add('the bare consumer has no mediabunny', !existsSync(join(dir, 'node_modules/mediabunny')));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return checks;
}

// ---------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------

const results = { started: new Date().toISOString(), argv, origin, headed: HEADED, chrome: CHROME, runs: [] };
console.log(`film gates: ${ONLY.length} case(s) on ${GPUS.join(', ')}${HEADED ? ' (headed)' : ' (headless)'}; ${origin}; output ${OUT}`);
try {
    for (const name of ONLY.filter(c => NODE_CASES.includes(c))) {
        const t0 = Date.now();
        const checks = packageGate();
        const entry = { gpu: 'node', case: name, ms: Date.now() - t0, ok: checks.every(c => c.ok), checks };
        results.runs.push(entry);
        const failed = checks.filter(c => !c.ok);
        console.log(`node ${name}: ${entry.ok ? 'ok' : 'FAILED'} — ${checks.length - failed.length}/${checks.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        for (const c of failed) console.log(`   FAIL ${c.name}${c.detail != null ? ` — ${JSON.stringify(c.detail).slice(0, 600)}` : ''}`);
    }
    for (const gpu of GPUS) {
        uploadDir = join(OUT, gpu);
        mkdirSync(uploadDir, { recursive: true });
        let chrome = await openChrome(gpu);
        console.log(`\n== ${gpu}: Chrome pid ${chrome.pid}`);
        for (const name of ONLY.filter(c => !NODE_CASES.includes(c))) {
            if (!chrome.alive()) {
                await chrome.close();
                chrome = await openChrome(gpu);
                console.log(`== ${gpu}: DevTools connection lost; Chrome restarted, pid ${chrome.pid}`);
            }
            const from = chrome.lines.length;
            const t0 = Date.now();
            let lost = null;
            await chrome.send('Page.navigate', { url: `${origin}/dev/film-gates.html?case=${encodeURIComponent(name)}` }).catch(e => { lost = e.message; });
            let finished = false;
            let seen = from;
            const actions = [];
            for (const deadline = t0 + TIMEOUT_MS; !finished && !lost && Date.now() < deadline;) {
                for (; seen < chrome.lines.length; seen++) {
                    const [, action] = /^\[g\] action ([\w-]+)/.exec(chrome.lines[seen].text) ?? [];
                    if (action) actions.push(await act(chrome, action).then(() => `${action}: ok`, e => `${action}: ${e.message}`));
                }
                finished = chrome.lines.slice(from).some(l => /^\[g\] (done|failed)/.test(l.text));
                if (!chrome.alive()) lost = 'DevTools socket closed';
                if (!finished && !lost) await sleep(100);
            }
            let result;
            if (lost) {
                result = { ok: false, error: `the runner lost Chrome's DevTools connection (${lost}); a system sleep closes it` };
            } else {
                try {
                    const { result: r } = await chrome.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__FILM_G__ ?? null)', returnByValue: true });
                    result = JSON.parse(r.value ?? 'null');
                } catch (e) { result = { ok: false, error: `could not read the result: ${e.message}` }; }
                if (!finished) result = { ...(result ?? {}), ok: false, error: `timed out after ${TIMEOUT_MS / 1000} s` };
            }
            const log = chrome.lines.slice(from).map(l => `[${((l.t - t0) / 1000).toFixed(1)}s ${l.kind}] ${l.text}`);
            const checks = [...(result?.checks ?? [])];
            if (!result?.ok) checks.push({ name: 'the case ran to its end', ok: false, detail: result?.error ?? 'no result' });
            const vendors = [...new Set((result?.adapters ?? []).map(a => a.vendor))];
            checks.push({ name: `every adapter was the ${gpu} GPU`, ok: vendors.length === 1 && vendors[0] === gpu, detail: result?.adapters?.[0] ?? null });
            checks.push({ name: 'nothing left in OPFS', ok: (result?.leftoverFilms ?? []).length === 0, detail: result?.leftoverFilms ?? null });
            const files = {};
            for (const v of result?.videos ?? []) files[v.file] = checkVideo(uploadDir, v, checks);
            const errors = log.filter(l => /\b(exception|error)\]/.test(l) && !/\[g\] (FAIL|failed)/.test(l));
            const entry = { gpu, case: name, ms: Date.now() - t0, ok: checks.every(c => c.ok), checks, result, files, actions, log, consoleErrors: errors };
            results.runs.push(entry);
            const failed = checks.filter(c => !c.ok);
            console.log(`${gpu} ${name}: ${entry.ok ? 'ok' : 'FAILED'} — ${checks.length - failed.length}/${checks.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
            for (const c of failed) console.log(`   FAIL ${c.name}${c.detail != null ? ` — ${JSON.stringify(c.detail).slice(0, 400)}` : ''}`);
            writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
            await chrome.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
            await sleep(1000);
            if (!KEEP) for (const v of result?.videos ?? []) { const p = join(uploadDir, v.file); if (existsSync(p)) unlinkSync(p); }
        }
        await chrome.close();
    }
} finally {
    await vite.close();
}

const md = [`# Wexy film gates (${results.started}, ${HEADED ? 'headed' : 'headless'} Chrome)`, ''];
for (const gpu of ['node', ...GPUS]) {
    const runs = results.runs.filter(r => r.gpu === gpu);
    if (!runs.length) continue;
    const a = runs.find(r => r.result?.adapters?.length)?.result.adapters[0] ?? {};
    md.push(`## ${gpu}: ${a.vendor ?? '?'} ${a.architecture ?? ''} ${a.description ?? ''}`.trim(), '', '| case | result | checks | s |', '|---|---|---|---|');
    for (const r of runs) md.push(`| ${r.case} | ${r.ok ? 'ok' : '**FAILED**'} | ${r.checks.filter(c => c.ok).length}/${r.checks.length} | ${(r.ms / 1000).toFixed(1)} |`);
    md.push('');
}
const failed = results.runs.filter(r => !r.ok);
writeFileSync(join(OUT, 'summary.md'), md.join('\n'));
console.log(`\n${md.join('\n')}\nfilm gates: ${failed.length ? `${failed.length} case(s) FAILED` : 'all passed'} — ${join(OUT, 'results.json')}`);
process.exit(failed.length ? 1 : 0);
