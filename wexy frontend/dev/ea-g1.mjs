// EA5.4's EA-G1 and part of EA-G2 on one real GPU (executor-design.md §10, §13): dev/ea-g1.html in headless Chrome, the
// live candidates and their ×4 and ×16 variants run through the stage as the studio's Run runs them, with the gate pinned
// to each candidate in turn (the EA-G1 bootstrap), then ten replacements and a cancel, then the coverage worlds of 11-02
// (and, with --lose, a device loss). Chrome runs with its WebGPU developer features, so the adapter reports its model and
// the environment has a key (eligibility.ts, ea5-env.v3). No model is called and nothing is spent. Results:
// dev/out/ea-g1/<time>/<gpu>.json, and the eligibility entries it wrote, <gpu>.eligibility.json, for the developer to
// review before they ship. Exit 0 when every live world installs at scale 1 with no uncaptured error, no prediction under
// what ran, the engine back at its baseline after each world and the ten replacements, and the cancel leaving nothing; 1
// otherwise; 2 when Chrome or Vite cannot start. A coverage world that is not clean is reported and adds nothing to
// eligibility, never a failure. One GPU a run (the GTX 1650 through --force_high_performance_gpu, gotchas). On the
// charger only.
//   node dev/ea-g1.mjs --gpu amd|nvidia [--small] [--lose] [--chrome path] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = n => argv.includes(`--${n}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quit = async code => { await sleep(150); process.exit(code); };
const gpu = opt('gpu', '');
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea-g1: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea-g1: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea-g1', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
mkdirSync(OUT, { recursive: true });

const PORT = 5196;
const origin = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOut = '';
vite.stdout.on('data', d => { viteOut += d; });
vite.stderr.on('data', d => { viteOut += d; });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${origin}/dev/ea-g1.html`)).ok; } catch { /* starting */ } if (!up) await sleep(200); }
if (!up) { console.error(`ea-g1: Vite did not answer on ${origin}\n${viteOut}`); spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea-g1-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=2100,1250', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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

const ms = v => (v === null || v === undefined ? '—' : `${Number(v).toFixed(3)}`);
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
    await page.send('Page.navigate', { url: `${origin}/dev/ea-g1.html` });
    const evaluate = async expression => (await page.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(200); ready = await evaluate('!!window.__G1__?.ready'); }
    if (!ready) throw new Error(`the page never got ready; its console:\n${consoleLines.join('\n')}`);
    await evaluate(`window.__G1__.run(${JSON.stringify({ small: flag('small'), lose: flag('lose') })})`);
    let result = null;
    for (let i = 0; i < 4500 && !result; i++) { await sleep(200); const r = await evaluate('window.__G1__.result ? JSON.stringify(window.__G1__.result) : null'); if (r) result = JSON.parse(r); }
    if (!result) throw new Error(`no result in 15 minutes; its console:\n${consoleLines.slice(-40).join('\n')}`);
    if (result.error) throw new Error(`the page failed: ${result.error}\n${consoleLines.slice(-40).join('\n')}`);

    const problems = [];
    for (const r of result.runs) {
        if (r.scale === 1 && r.status !== 'installed') problems.push(`${r.world}: not installed (${r.status}: ${r.reason})`);
        for (const u of r.underPredicted) problems.push(`${r.world} ×${r.scale}: under-predicted ${u}`);
        if (r.uncaptured.length) problems.push(`${r.world} ×${r.scale}: ${r.uncaptured.length} uncaptured error(s): ${r.uncaptured[0]}`);
        if (r.baseline) problems.push(`${r.world} ×${r.scale}: ${r.baseline}`);
        if (r.retireError) problems.push(`${r.world} ×${r.scale}: ${r.retireError}`);
    }
    if (result.replacements.installed !== 10) problems.push(`ten replacements: ${result.replacements.installed} installed`);
    if (result.replacements.after.baseline) problems.push(`after ten replacements: ${result.replacements.after.baseline}`);
    if (result.replacements.after.held !== 0) problems.push(`after ten replacements the ledger holds ${result.replacements.after.held} bytes`);
    if (result.cancelled.record.status !== 'stopped') problems.push(`the cancel: ${result.cancelled.record.status} (${result.cancelled.record.reason})`);
    if (result.cancelled.after.baseline || result.cancelled.after.held !== 0) problems.push(`after the cancel: ${result.cancelled.after.baseline ?? `the ledger holds ${result.cancelled.after.held}`}`);
    // A cancel during the stage's own compiles, a Head on the stage (the EA5.4 review).
    const c = result.cancelDuringCompiles;
    if (c.record.status !== 'stopped' || c.record.reason !== 'cancelled') problems.push(`the cancel during the compiles: ${c.record.status} (${c.record.reason})`);
    if (c.compiles < 1) problems.push('the cancel during the compiles: no compile began');
    if (!c.headKept) problems.push('the cancel during the compiles: the Head was not kept');
    if (c.headDraws !== null) problems.push(`the cancel during the compiles: the Head did not draw clean (${c.headDraws})`);
    if (!c.countsKept || !c.heldKept) problems.push(`the cancel during the compiles left something: counts kept ${c.countsKept}, ledger kept ${c.heldKept}`);
    if (c.retireError || c.baseline || c.held !== 0) problems.push(`after the cancel during the compiles: ${c.retireError ?? c.baseline ?? `the ledger holds ${c.held}`}`);
    // A probe over budget on the device (stacked planes, about 29 G fragments a frame at full size): refused by the probe
    // before any full-size work, on any laptop GPU, and the Head kept and drawing.
    const o = result.overBudget;
    if (!o.refused) problems.push(`over budget: ${o.record.status}${o.record.reason ? ` (${o.record.reason})` : ''}, not refused by the probe`);
    else if (!o.headKept || o.headDraws !== null) problems.push(`over budget: refused, but the Head ${o.headKept ? `did not draw clean (${o.headDraws})` : 'was not kept'}`);
    if (o.retireError || o.baseline || o.held !== 0) problems.push(`after the over-budget run: ${o.retireError ?? o.baseline ?? `the ledger holds ${o.held}`}`);
    // A device loss, asked for: its outcome asserted, not only recorded (the EA5.4 review).
    if (flag('lose')) {
        const l = result.loss;
        if (!l) problems.push('the device loss did not run');
        else {
            if (l.record.status !== 'stopped' || l.record.reason !== 'device-lost') problems.push(`the device loss: ${l.record.status} (${l.record.reason}), not stopped as device-lost`);
            if (!l.headKept) problems.push('the device loss: the stage did not leave the Head where it was');
            if (l.installed) problems.push('the device loss: the candidate was installed');
            if (!l.heldIsHead) problems.push('the device loss: the ledger holds more than the Head\'s share');
            if (!l.compilerLost) problems.push('the device loss: the compiler\'s verdicts were not voided');
            if (!l.replay || l.replay === 'INSTALLED') problems.push(`the device loss: the next Run was ${l.replay ?? 'not tried'}, not refused`);
        }
    }
    // A coverage world's own errors are its record's (reported below, never a failure); any other is the gate's.
    const coverageErrors = result.coverage.reduce((n, r) => n + r.uncaptured.length, 0);
    const unattributed = result.uncaptured.length - coverageErrors;
    if (!flag('lose') && unattributed > 0 && !problems.some(p => p.includes('uncaptured'))) problems.push(`${unattributed} uncaptured device error(s)`);
    if (result.lost && !flag('lose')) problems.push(`the device was lost: ${result.lost}`);
    if (!('key' in result.environment)) problems.push(`no environment key (${result.environment.unknown}): no eligibility written`);
    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    if (errors.length) problems.push(`${errors.length} console error(s): ${errors[0]}`);

    writeFileSync(join(OUT, `${gpu}.json`), JSON.stringify({ ...result, console: consoleLines, problems }, null, 1));
    writeFileSync(join(OUT, `${gpu}.eligibility.json`), `${JSON.stringify({ format: 'wexy-eligibility.v1', note: `Written by dev/ea-g1.mjs on ${result.stamp} (${result.gpu}): review before it ships in src/exec/eligibility.json.`, entries: result.eligibility }, null, 2)}\n`);
    console.log(`ea-g1 (${gpu}): ${result.gpu}; ${result.browser.match(/Chrome\/[\d.]+/)?.[0] ?? result.browser}; canvas ${result.canvas.width}×${result.canvas.height}, envelope ${result.envelope.width}×${result.envelope.height}`);
    console.log(`environment: ${result.environment.key ?? `unknown (${result.environment.unknown})`}`);
    console.log('world ×scale: status · predicted init/step/frame/first frame · ran init, first frame · steady step/frame/canvas frame (ms) · reserved MB (an estimate) · the Run (s)');
    const line = r => {
        const p = r.report?.probe;
        const a = r.report?.actual;
        return `  ${r.world} ×${r.scale}: ${r.status}${r.status === 'installed' ? '' : ` (${r.reason})`}`
            + (p ? ` · ${ms(p.initMs)}/${ms(p.computeMsPerFrame)}/${ms(p.drawMsPerFrame)}/${ms(p.firstFrameMs)}` : '')
            + (a ? ` · ${ms(a.initMs)}, ${ms(a.firstFrameMs)}` : '')
            + (r.measured ? ` · ${ms(r.measured.stepMs)}/${ms(r.measured.frameMs)}/${ms(r.measured.canvasFrameMs)}` : '')
            + (r.report ? ` · ${(r.report.reservation.total / 1e6).toFixed(0)}` : '')
            + (r.runMs !== null ? ` · ${(r.runMs / 1000).toFixed(1)}` : '');
    };
    for (const r of result.runs) console.log(line(r));
    // The coverage worlds: each clean, or why not (it then adds nothing to eligibility).
    const unclean = r => (r.status !== 'installed' ? `${r.status}: ${r.reason}`
        : [...r.underPredicted.map(u => `under-predicted ${u}`), ...(r.uncaptured.length ? [`${r.uncaptured.length} uncaptured error(s): ${r.uncaptured[0]}`] : []),
            ...(r.baseline ? [r.baseline] : []), ...(r.retireError ? [r.retireError] : []), ...(r.demands ? [] : ['no demands read'])].join('; ') || null);
    console.log('coverage worlds (11-02; not the gate\'s):');
    for (const r of result.coverage) console.log(line(r));
    const notClean = result.coverage.filter(r => unclean(r));
    console.log(`coverage: ${result.coverage.length - notClean.length}/${result.coverage.length} clean${notClean.length ? `; not clean, so not in eligibility: ${notClean.map(r => `${r.world} (${unclean(r)})`).join('; ')}` : ''}`);
    console.log(`ten replacements: ${result.replacements.installed}/10; the cancel during the probe: ${result.cancelled.record.status} (${result.cancelled.record.reason}); `
        + `during the compiles (a Head on the stage): ${c.record.status} (${c.record.reason}), the Head ${c.headKept ? 'kept' : 'LOST'}`);
    console.log(`over budget (foggy-dusk, its fog ×2048 stacked across the screen): ${o.record.status}${o.record.reason ? ` (${o.record.reason})` : ''}${o.refused ? `, the Head ${o.headKept ? 'kept' : 'LOST'}` : ''}`
        + `; the Run ${o.record.runMs !== null ? `${(o.record.runMs / 1000).toFixed(1)} s` : '—'}, the frame batches ${o.record.report?.probe?.phases?.frame?.runs?.join('/') ?? '—'}`);
    if (result.loss) console.log(`the device loss (a Head on the stage): ${result.loss.record.status} (${result.loss.record.reason}); the Head ${result.loss.headKept ? 'kept' : 'LOST'}; the next Run: ${result.loss.replay}`);
    console.log(`eligibility: ${result.eligibility.length} entries written`);
    console.log(problems.length ? `FAILED:\n  ${problems.join('\n  ')}`
        : 'every live world installed clean; init, a step, a steady frame and the cold first frame each at most predicted; the engine\'s bookkeeping back at its baseline');
    console.log(`evidence in ${OUT}`);
    failed = problems.length > 0;
} catch (e) {
    console.error(`ea-g1: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
