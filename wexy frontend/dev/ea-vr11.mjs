// EA6.2's EA-VR11 on one real GPU (visual-review-design.md §8, §10), with EA6.3's notes (§8.2): the review of the stage
// in the studio itself, under ?agent=1, end to end with no paid call. A local stand-in gateway answers the agent routes in
// the backend's recorded shapes: the turn hands off the castle as the agent wrote it (11-02: its hill a 468-unit shell),
// each module call is answered with the castle's own body, and a program revision (a turn with a base) is answered with
// the castle at unit sizes, its design kept, and notes to the three modules that place its parts too high (the castle
// floated over its unit hill); each of their repairs is answered with that body lowered 3.5 units; a second revision
// asks a question instead (a round that ends without a candidate).
//   - the turn, Write the modules (L3 on this device), Run on this GPU: the world on the stage, and its review captured
//     at once: two real frames, EA_SCALE and EA_FRAME from the boxes read on the device;
//   - by the keyboard: a finding unchecked with Space, the creator's words typed, "Improve it" pressed with Enter: one
//     revision citing exactly the words and the finding kept, then the three noted modules repaired, each with its note
//     as its one finding, no module written fresh, the improved candidate awaiting Run, the old world still on the stage;
//   - Run on this GPU again: the unit castle standing on its hill, recaptured, neither finding;
//   - a second round that ends asking: not improved, said in both voices, the world on the stage untouched, both rounds
//     spent;
//   - the studio at 320 px: no horizontal overflow, the review panel inside its column;
//   - no console error, and the stand-in asked only for the agent routes.
// Screenshots, the frames the panel showed and steps.json go to dev/out/ea-vr11/<gpu>-<time>/. Exit 0 when every step
// passes; 1 otherwise; 2 when Chrome or Vite cannot start. On the charger only.
//   node dev/ea-vr11.mjs --gpu amd|nvidia [--chrome path] [--out dir]
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
if (!['amd', 'nvidia'].includes(gpu)) { console.error('ea-vr11: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('ea-vr11: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'ea-vr11', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ''}`); };

// ---- the stand-in gateway: the castle, in the backend's recorded shapes ----------------------------------------------
const lf = s => s.replace(/\r\n/g, '\n');
const fixture = p => lf(readFileSync(join(ROOT, p), 'utf8'));
const castle = JSON.parse(fixture('dev/replays/castle.json'));
/** The castle at unit sizes: the three sizes the agent doubled with its instances' scale, set to 1 (11-02). */
const unitNodes = castle.program.nodes.map(n => (['geohill', 'geocyl', 'geocone'].includes(n.id) ? { ...n, config: JSON.stringify({ ...JSON.parse(n.config), size: 1 }) } : n));
const moduleWire = fixture('test/fixtures/module-wire/author.sse');
/** A recording with its `name` event's data rewritten. */
const edit = (text, name, change) => text.replace(/^event:(.*)\ndata:(.*)$/gm, (whole, event, data) => (event === name ? `event:${event}\ndata:${JSON.stringify(change(JSON.parse(data)))}` : whole));
const withCastle = (text, nodes) => edit(edit(text, 'design', () => ({ design: castle.design })), 'program', () => ({ program: { nodes } }));
const handOff = withCastle(fixture('test/fixtures/agent-wire/handed-off.sse'), castle.program.nodes);
/** EA6.3: the revision's notes to the modules whose code places the castle's parts, as a revision's `repairs` carries them. */
const NOTES = [
    { module: 'castlePlace', message: 'Lower every tower, roof, wall and stone by 3.5 units, so the castle stands on the hill instead of floating above it.' },
    { module: 'flagPlace', message: 'Lower every pennant by 3.5 units, to stay on its lowered tower.' },
    { module: 'flagFlutter', message: 'Lower every pennant by 3.5 units, to stay on its lowered tower.' },
];
const revised = edit(withCastle(fixture('test/fixtures/agent-wire/revised-notes.sse'), unitNodes), 'repairs', () => ({ repairs: NOTES }));
const asked = fixture('test/fixtures/agent-wire/asked.sse');
const bodyOf = id => castle.modules.find(m => m.module === id)?.body ?? null;
/** A body with each of its height writes moved down 3.5 units: what each noted module's repair answers. */
function lowered(id, writes) {
    let body = bodyOf(id);
    for (const w of writes) {
        if (body.split(w).length !== 2) throw new Error(`ea-vr11: ${id}'s body does not hold "${w}" once`);
        body = body.replace(w, `${w.slice(0, -1)} - 3.5;`);
    }
    return body;
}
const LOWERED = {
    castlePlace: lowered('castlePlace', ['b_towerbuf[tb + 2u] = cc.y;', 'b_roofbuf[rb + 2u] = topY + ch * 0.5;', 'b_stonebuf[sb + 2u] = py;']),
    flagPlace: lowered('flagPlace', ['b_flagbuf[base + 2u] = py;']),
    flagFlutter: lowered('flagFlutter', ['b_flagbuf[base + 2u] = py;']),
};
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
const VITE_PORT = 5193;
const GATEWAY_PORT = 5192;
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
        if (req.method === 'POST' && req.url === '/v1/agent/turn') {
            const call = JSON.parse(body);
            const revisions = calls.filter(c => c.route === 'revision').length;
            if (call.base) {
                calls.push({ route: 'revision', findings: call.base.findings, nodes: call.base.program?.nodes?.length ?? null });
                sse(revisions === 0 ? revised : asked);
            } else {
                calls.push({ route: 'turn' });
                sse(handOff);
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/agent/module') {
            const call = JSON.parse(body);
            const answer = call.purpose === 'repair' ? LOWERED[call.module?.id] ?? null : bodyOf(call.module?.id);
            calls.push({
                route: 'module', module: call.module?.id, purpose: call.purpose, note: call.note ?? null,
                findings: call.previous?.findings?.map(f => ({ code: f.code, rung: f.rung, message: f.message })) ?? null,
            });
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
if (!up) { console.error(`ea-vr11: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-ea-vr11-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--no-first-run', '--window-size=1600,1000', '--disable-features=BackForwardCache', ...(gpu === 'nvidia' ? ['--force_high_performance_gpu'] : []), 'about:blank'], { stdio: 'ignore' });
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
    const click = label => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => !b.hidden && (b.textContent ?? '').trim().startsWith(${JSON.stringify(label)})); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const key = async (keyName, code, vk, text) => {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    };
    /** The review panel as a person reads it. */
    const review = () => evaluate(`(() => {
        const r = document.querySelector('.rev');
        if (!r) return null;
        const t = s => r.querySelector(s)?.textContent ?? null;
        return {
            status: r.dataset.status, phase: t('.cand-phase'), id: t('.cand-id'), line: t('.rev-status'),
            frames: [...r.querySelectorAll('.rev-frame')].map(f => ({ view: f.dataset.view ?? null, natural: f.querySelector('img')?.naturalWidth ?? 0, alt: f.querySelector('img')?.alt ?? null, caption: f.querySelector('figcaption')?.textContent ?? null })),
            findings: [...r.querySelectorAll('.rev-findings input[type=checkbox]')].map(b => ({ checked: b.checked, label: (b.closest('label')?.textContent ?? '').trim().slice(0, 160) })),
            gaps: [...r.querySelectorAll('.rev-gap')].map(g => g.textContent),
            note: r.querySelector('.cand-note')?.hidden ? null : t('.cand-note'), reason: r.querySelector('.cand-reason')?.hidden ? null : t('.cand-reason'),
            budget: t('.cand-budget'), why: t('.rev-why'), improve: [...r.querySelectorAll('button')].find(b => b.textContent.startsWith('Improv'))?.disabled ?? null,
        };
    })()`);
    /** The frames the panel shows, as files: what a person saw. */
    const keepFrames = async name => {
        const frames = await evaluate(`(async () => {
            const out = [];
            for (const img of document.querySelectorAll('.rev-frame img')) {
                const b = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
                let s = '';
                for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
                out.push({ view: img.closest('.rev-frame').dataset.view, data: btoa(s) });
            }
            return out;
        })()`);
        for (const f of frames ?? []) writeFileSync(join(OUT, `${name}-${f.view}.jpg`), Buffer.from(f.data, 'base64'));
        return (frames ?? []).length;
    };
    const title = () => evaluate(`document.querySelector('#hud-title')?.textContent ?? null`);

    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html?agent=1&dev=1` });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && !!document.querySelector('.rev') && [...document.querySelectorAll('.cand button')].some(b => b.textContent === 'Run on this GPU' && !b.hidden)`, 40_000);
    const gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    step('the studio starts under ?agent=1: its GPU, the candidate panel, and the review panel saying there is nothing on the stage yet', started
        && (await review())?.status === 'none', { gpu: gpuLabel, review: await review() });

    // The turn hands off the castle as written; its modules written and compiled here; Run on this GPU.
    await click('Run agent turn');
    const handed = await until(`document.querySelector('.agent')?.dataset.phase === 'handed-off'`);
    await click('Write the modules');
    const sealed = handed && await until(`['static-verified', 'failed', 'exhausted'].includes(document.querySelector('.cand')?.dataset.phase)`, 120_000);
    const cand = await evaluate(`({ phase: document.querySelector('.cand')?.dataset.phase, l3: document.querySelector('.cand')?.dataset.l3, id: document.querySelector('.cand .cand-id')?.textContent, reason: document.querySelector('.cand .cand-reason')?.textContent || null })`);
    step('the castle as written: handed off, its four modules written and compiled on this device, sealed', sealed && cand.phase === 'static-verified' && cand.l3 === 'device'
        && calls.filter(c => c.route === 'module').length === 4, { cand, modules: calls.filter(c => c.route === 'module').map(c => c.module) });
    await click('Run on this GPU');
    await until(`!['running', 'idle'].includes(document.querySelector('.cand')?.dataset.run)`, 180_000);
    const run1 = await evaluate(`({ run: document.querySelector('.cand')?.dataset.run, line: document.querySelector('.cand-run')?.textContent })`);
    const ready1 = await until(`document.querySelector('.rev')?.dataset.status === 'ready'`, 60_000);
    const r1 = await review();
    const firstTitle = await title();
    step('Run on this GPU installs it, and its review is captured at once: two real frames, EA_SCALE and EA_FRAME from the boxes read on this device',
        run1.run === 'installed' && ready1 && r1.frames.length === 2 && r1.frames.every(f => f.natural === 768) && r1.findings.length === 2
        && r1.findings[0].label.startsWith('EA_SCALE batchhill spans 468 × 104 × 468') && r1.findings[1].label.startsWith('EA_FRAME the framed view\'s camera is inside batchhill')
        && r1.findings.every(f => f.checked) && /in attempt attempt-/.test(r1.line ?? '') && /2 of 2 views/.test(r1.line ?? ''), { run: run1, review: r1 });
    await keepFrames('castle');
    await shot('castle-reviewed');

    // By the keyboard: EA_FRAME unchecked with Space, the words typed, "Improve it" pressed with Enter.
    await evaluate(`document.querySelectorAll('.rev-findings input[type=checkbox]')[1].focus()`);
    await key(' ', 'Space', 32);
    const unchecked = await evaluate(`document.querySelectorAll('.rev-findings input[type=checkbox]')[1].checked === false && document.activeElement?.type === 'checkbox'`);
    await evaluate(`document.querySelector('.rev-words').focus()`);
    const words = 'The castle sits inside a huge green shell; set the hill\'s size to 1.';
    await page.send('Input.insertText', { text: words });
    await evaluate(`[...document.querySelectorAll('.rev button')].find(b => b.textContent === 'Improve it').focus()`);
    const offered = await review();
    const modulesBefore = calls.filter(c => c.route === 'module').length;
    await key('Enter', 'Enter', 13, '\r');
    const awaiting = await until(`['awaiting-run', 'not-improved'].includes(document.querySelector('.rev')?.dataset.status)`, 120_000);
    const r2 = await review();
    const revision = calls.find(c => c.route === 'revision');
    const candAfter = await evaluate(`({ phase: document.querySelector('.cand')?.dataset.phase, id: document.querySelector('.cand .cand-id')?.textContent })`);
    // The creator's: the words and the finding kept, the one unchecked left out. Beside them, since EA6.3, the host's own
    // finding of how many notes the attempt can still answer (EA_REPAIR_BUDGET), told to every revision.
    const cited = (revision?.findings ?? []).filter(f => f.code !== 'EA_REPAIR_BUDGET');
    const budget = (revision?.findings ?? []).filter(f => f.code === 'EA_REPAIR_BUDGET');
    step('by the keyboard: a finding unchecked with Space, the words typed, "Improve it" with Enter: one revision citing exactly the words and the finding kept, beside the host\'s note budget',
        unchecked && offered.improve === false && awaiting && r2.status === 'awaiting-run' && cited.length === 2 && cited[0].code === 'creator'
        && cited[0].message === words && cited[1].code === 'EA_SCALE' && budget.length === 1,
        { unchecked, offered: offered.why, status: r2.status, revisionFindings: revision?.findings?.map(f => `${f.code}: ${f.message.slice(0, 60)}`) });
    // EA6.3: the three noted modules' bodies were kept (their interfaces held), so each was repaired with its note as its
    // one finding, and compiled on this device; nothing was written fresh.
    const repairs = calls.filter(c => c.route === 'module').slice(modulesBefore);
    const noted = repairs.map(c => [c.module, c.purpose, c.note, (c.findings ?? []).map(f => `${f.code}/${f.rung}`).join(',')]).sort();
    step('the improved candidate: the three noted modules repaired, each with its note as its one finding, no module written fresh; sealed, awaiting Run; the old world still on the stage',
        JSON.stringify(noted) === JSON.stringify(NOTES.map(n => [n.module, 'repair', null, 'EA_REVISION_NOTE/note']).sort())
        && repairs.every(c => NOTES.some(n => n.module === c.module && c.findings[0].message.endsWith(n.message)))
        && candAfter.phase === 'static-verified' && candAfter.id !== cand.id
        && /improved to id\(C\) [0-9a-f]{12}…: Run on this GPU puts it on the stage/.test(r2.line ?? '') && (await title()) === firstTitle,
        { noted, cand: candAfter, line: r2.line, title: await title(), budget: r2.budget });

    // Run on this GPU again: the unit castle on the stage, standing on its hill, recaptured, neither finding.
    await click('Run on this GPU');
    await until(`document.querySelector('.cand')?.dataset.run === 'running'`, 10_000);
    await until(`!['running', 'idle'].includes(document.querySelector('.cand')?.dataset.run)`, 180_000);
    const ready2 = await until(`document.querySelector('.rev')?.dataset.status === 'ready' && !/improved to/.test(document.querySelector('.rev-status')?.textContent ?? '')`, 60_000);
    const r3 = await review();
    // The improved world is another candidate (its review's id) of the same creation, whose title, from the idea, it keeps
    // (EA9.1): the HUD named each candidate by its id(C) before.
    step('Run again: the unit castle on the stage, its parts lowered onto the hill, recaptured, neither EA_SCALE nor EA_FRAME; its creation\'s title kept', ready2 && r3.frames.length === 2 && r3.frames.every(f => f.natural === 768)
        && !r3.findings.some(f => /EA_SCALE|EA_FRAME/.test(f.label)) && (await title()) === firstTitle && r3.id !== r1.id, { review: r3, title: await title() });
    await keepFrames('castle-unit');
    await shot('castle-unit-reviewed');

    // A second round that ends asking: not improved, said, the world on the stage untouched, both rounds spent.
    const secondTitle = await title();
    await evaluate(`document.querySelector('.rev-words').focus()`);
    await page.send('Input.insertText', { text: 'The castle floats above its hill; lower it onto the hill.' });
    await click('Improve it');
    const ended = await until(`['not-improved', 'awaiting-run'].includes(document.querySelector('.rev')?.dataset.status)`, 120_000);
    const r4 = await review();
    step('a second round that ends asking: not improved, in both voices; the world on the stage untouched; both rounds spent',
        ended && r4.status === 'not-improved' && !!r4.note && !!r4.reason && (await title()) === secondTitle && /^visual rounds 2 of 2/.test(r4.budget ?? '')
        && calls.filter(c => c.route === 'revision').length === 2, { review: r4, title: await title() });
    await shot('second-round-asked');

    // The studio at 320 px wide: no horizontal overflow; the review panel inside its column.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(800);
    // What reaches past 320 px, deepest first: the elements whose own box crosses the edge while no child of theirs does.
    const narrow = await evaluate(`(() => {
        const r = document.querySelector('.rev');
        const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
        const past = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > 321; });
        const deepest = past.filter(e => !past.some(o => o !== e && e.contains(o))).slice(0, 8)
            .map(e => { const b = e.getBoundingClientRect(); return { el: name(e), path: [e.parentElement, e.parentElement?.parentElement].filter(Boolean).map(name).join(' < '), width: Math.round(b.width), right: Math.round(b.right), minWidth: getComputedStyle(e).minWidth }; });
        return { page: document.documentElement.scrollWidth, body: document.body.scrollWidth, panel: [r.scrollWidth, r.clientWidth], left: r.getBoundingClientRect().left, right: r.getBoundingClientRect().right, deepest };
    })()`);
    step('the studio at 320 px: no horizontal overflow, the review panel inside its column', narrow.page <= 320 && narrow.body <= 320 && narrow.panel[0] <= narrow.panel[1] + 1
        && narrow.left >= 0 && narrow.right <= 320, narrow);
    await evaluate(`document.querySelector('.rev').scrollIntoView()`);
    await shot('narrow-320');
    await page.send('Emulation.clearDeviceMetricsOverride');

    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    step('no console error', errors.length === 0, errors.slice(0, 5));
    const unexpected = calls.filter(c => c.unexpected);
    step('the stand-in gateway was asked only for the agent routes: one turn, four authors and three repairs, two revisions; no model called', unexpected.length === 0
        && calls.filter(c => c.route === 'turn').length === 1 && calls.filter(c => c.route === 'module').length === 7,
        { calls: calls.map(c => c.route + (c.module ? ` ${c.module} ${c.purpose}` : '')) });
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, steps, calls, console: consoleLines }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\nea-vr11 (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
} catch (e) {
    console.error(`ea-vr11: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopAll();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
