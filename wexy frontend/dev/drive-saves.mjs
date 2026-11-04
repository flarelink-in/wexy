// W3.6's studio drive on one real GPU (the creations platform companion §7, §8, §9, §14's W3.6 row; PL-FE5): the studio
// itself behind ?create=agent, against a local stand-in gateway answering the agent routes in the backend's recorded shapes
// (EA9-E1's castle) and the platform's world routes from an in-memory store held to their contract (the companion §10's
// W3 note: the hash, the key, the DTOs). No model, no spend, no backend.
//   - W3-E1: an anonymous creator's world on the stage: not saved, "Sign in to keep this world" beside its title; nothing sent;
//   - W3-E2: that sign-in (the dev identity's link, the same uid) sets the account up, then saves the world once:
//     POST /v1/worlds under a key, its text the hash it claims; "Saved", with the way to the history;
//   - W3-E3: /creations lists it, "Open in the studio" linking to the studio by its id;
//   - W3-E4: the studio opens it by that link: read, checked, sealed and compiled here, then "Show it" on the stage's card,
//     the GPU go; the castle on the stage From the archive, "Saved", not saved again; no model route called;
//   - W3-E5: a new world whose save the stand-in answers 409: "Not saved: changed in another tab", "Save as a new world"
//     (and no "Open the saved one" for a world never saved), which saves it under a new key;
//   - W3-E6: a full storage: said once, never sent again by itself; "Try again" once room is made saves it;
//   - W3-E7: at 390 px the save's line sits under the idea box, the header having no title, the page as wide as the screen;
//   - W3-E8 (Q129): a world waiting for Show it, then Sign out: asked first; discarded, the world on the stage stays its owner's;
//   - no console error, no unexpected route, every world call a signed-in caller's.
// Screenshots and steps.json go to dev/out/drive-saves/<gpu>-<time>/. Exit 0 when every step passes; 1 otherwise; 2 when
// Chrome or Vite cannot start. On the charger only, one GPU harness at a time.
//   node dev/drive-saves.mjs --gpu amd|nvidia [--chrome path] [--out dir]
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
if (!['amd', 'nvidia'].includes(gpu)) { console.error('drive-saves: name one GPU: --gpu amd or --gpu nvidia.'); await quit(2); }
const CHROME = [opt('chrome'), process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    .filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('drive-saves: no Chrome found; pass --chrome <path>.'); await quit(2); }
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'drive-saves', `${gpu}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)));
mkdirSync(OUT, { recursive: true });
const steps = [];
const step = (name, ok, detail = null) => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail != null ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); };

// ---- the stand-in gateway: the agent routes as EA9-E1's (the castle), and the platform's world routes in memory --------
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

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulids = 0;
/** A ULID's shape (the platform's ids): its time, then a run-unique tail. */
function ulid() {
    let t = Date.now(), head = '';
    for (let i = 0; i < 10; i++) { head = CROCKFORD[t % 32] + head; t = Math.floor(t / 32); }
    let n = ++ulids * 7919, tail = '';
    for (let i = 0; i < 16; i++) { tail += CROCKFORD[(n + i * 13) % 32]; n = Math.floor(n / 3) + i; }
    return head + tail;
}
const iso = () => new Date().toISOString();
const ACCOUNT = { accountId: ulid(), status: 'ACTIVE', policyVersion: 1, profile: { handle: null, displayName: null, bio: null, publicEnabled: false, rowVersion: 0 } };
let accountMade = false;
/** worldId → { world: the DTO, texts: revisionId → its exact text }. */
const worlds = new Map();
/** Idempotency-Key → what its first request was answered (the companion §10: the same key and body, the same answer). */
const keys = new Map();
/** The next saves' answers, in order: 'conflict' (409) or 'full' (403 storage-full); a save is kept when it is empty. */
const savePlan = [];
const calls = [];

const VITE_PORT = 5194;
const GATEWAY_PORT = 5195;
const studioOrigin = `http://127.0.0.1:${VITE_PORT}`;
const gateway = createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': studioOrigin, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization, content-type, idempotency-key', 'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
        const sse = text => { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.end(text); };
        const json = (status, value) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        const url = new URL(req.url, 'http://x');
        const path = url.pathname;
        const who = String(req.headers.authorization ?? '');
        const google = /^Bearer dev\.google\./.test(who);
        const route = `${req.method} ${path.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '{id}')}`;
        const record = extra => calls.push({ route, who: google ? 'google' : /dev\.anonymous/.test(who) ? 'anonymous' : 'none', ...extra });
        if (req.method === 'POST' && path === '/v1/agent/turn') { record(); sse(handOff); return; }
        if (req.method === 'POST' && path === '/v1/agent/module') {
            const call = JSON.parse(body);
            const answer = bodyOf(call.module?.id);
            record({ module: call.module?.id });
            if (answer === null) { json(404, { code: 'not-found', message: 'no such module' }); return; }
            sse(moduleStream(call, answer));
            return;
        }
        if (req.method === 'GET' && path === '/v1/forge/allowance') { record(); json(200, { label: google ? 'Early access' : 'Free', left: 1, resetsAt: null }); return; }
        // W2's account: set up once a Google caller asks, read after.
        if (path === '/v1/me' && req.method === 'POST') { record(); if (!google) { json(403, { code: 'account-required', message: 'Sign in first.' }); return; } accountMade = true; json(201, ACCOUNT); return; }
        if (path === '/v1/me' && req.method === 'GET') { record(); if (!google || !accountMade) { json(404, { code: 'not-found', message: 'No account yet.' }); return; } json(200, ACCOUNT); return; }
        // W3's world routes (the companion §10's W3 note), a signed-in account's only.
        if (path.startsWith('/v1/worlds') || path.startsWith('/v1/me/')) {
            if (!google || !accountMade) { record({ refused: 'account' }); json(403, { code: 'account-required', message: 'Sign in to save worlds.' }); return; }
        }
        if (req.method === 'POST' && path === '/v1/worlds') {
            const key = String(req.headers['idempotency-key'] ?? '');
            let b = null;
            try { b = JSON.parse(body); } catch { /* refused below */ }
            const plan = keys.has(key) ? null : savePlan[0] ?? null;
            record({ key, title: b?.title ?? null, sha256: b?.sha256 ?? null, plan, bytes: b?.artifact?.length ?? 0 });
            if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) { json(400, { code: 'bad-request', message: 'A save needs its Idempotency-Key.' }); return; }
            if (!b || Object.keys(b).sort().join() !== 'artifact,sha256,title' || typeof b.artifact !== 'string' || sha256(b.artifact) !== b.sha256) {
                json(400, { code: 'bad-request', message: 'A save takes exactly title, artifact and sha256, the artifact\'s own.' });
                return;
            }
            const kept = keys.get(key);
            if (kept) { json(kept.hash === sha256(body) ? kept.status : 409, kept.hash === sha256(body) ? kept.answer : { code: 'conflict', message: 'This key was used for another body.' }); return; }
            if (plan) {
                savePlan.shift();
                if (plan === 'conflict') { json(409, { code: 'conflict', message: 'This key was used for another body.' }); return; }
                json(403, { code: 'storage-full', message: 'Your saved worlds are full.' });
                return;
            }
            const now = iso();
            const head = { revisionId: ulid(), sha256: b.sha256, bytes: Buffer.byteLength(b.artifact), format: 'wexy-world.v1', line: 'ea.v1', createdAt: now };
            const world = { worldId: ulid(), title: b.title.trim(), rowVersion: 0, createdAt: now, updatedAt: now, head };
            worlds.set(world.worldId, { world, texts: new Map([[head.revisionId, b.artifact]]) });
            keys.set(key, { hash: sha256(body), status: 201, answer: world });
            json(201, world);
            return;
        }
        const one = path.match(/^\/v1\/worlds\/([0-9A-HJKMNP-TV-Z]{26})$/);
        if (req.method === 'GET' && one) { record(); const w = worlds.get(one[1]); if (w) json(200, w.world); else json(404, { code: 'not-found', message: 'No such world.' }); return; }
        const rev = path.match(/^\/v1\/worlds\/([0-9A-HJKMNP-TV-Z]{26})\/revisions\/([0-9A-HJKMNP-TV-Z]{26})$/);
        if (req.method === 'GET' && rev) {
            record();
            const w = worlds.get(rev[1]);
            const text = w?.texts.get(rev[2]);
            if (!w || text === undefined) { json(404, { code: 'not-found', message: 'No such revision.' }); return; }
            const h = w.world.head;
            json(200, { worldId: w.world.worldId, revisionId: rev[2], sha256: h.sha256, bytes: h.bytes, format: h.format, line: h.line, createdAt: h.createdAt, artifact: text });
            return;
        }
        if (req.method === 'GET' && path === '/v1/me/worlds') {
            record();
            json(200, { worlds: [...worlds.values()].map(w => w.world).reverse(), next: null });
            return;
        }
        if (req.method === 'GET' && path === '/v1/me/usage') {
            record();
            const used = [...worlds.values()].reduce((n, w) => n + w.world.head.bytes, 0);
            json(200, { usedBytes: used, reservedBytes: 0, worlds: worlds.size, limits: { bytes: 104857600, worlds: 50 } });
            return;
        }
        record({ unexpected: true });
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
if (!up) { console.error(`drive-saves: Vite did not answer on ${studioOrigin}\n${viteOut}`); stopAll(); await quit(2); }

const profile = mkdtempSync(join(tmpdir(), 'wexy-drive-saves-'));
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

/** The ideas, and the titles the studio gives their worlds: each one's first sentence (creation.ts, titleOf). */
const IDEA = 'A castle on a hill. Four towers, pennants fluttering in the wind.';
const TITLE = 'A castle on a hill';
const IDEA_B = 'A castle by the sea. Waves below it.';
const TITLE_B = 'A castle by the sea';
const IDEA_C = 'A castle in the snow. Flakes drifting down.';
const TITLE_C = 'A castle in the snow';
const MODEL = /^POST \/v1\/(agent|forge)\//;

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
    /** The save's two copies as a person reads them: shown or not, its word, its buttons and links. */
    const saveLook = () => evaluate(`(() => {
        // Rendered at all: a child of a hidden parent keeps its own computed display, so its own style cannot say.
        const read = e => e ? { shown: !e.hidden && e.checkVisibility(), tone: e.dataset.tone ?? null,
            text: e.querySelector('.save-text')?.firstChild?.textContent ?? null,
            buttons: [...e.querySelectorAll('button')].map(b => b.textContent), links: [...e.querySelectorAll('a')].map(a => a.getAttribute('href')) } : null;
        return { header: read(document.querySelector('.doc .save-status')), line: read(document.querySelector('.save-line')) };
    })()`);
    const stage = () => evaluate(`({ title: document.querySelector('#hud-title')?.textContent ?? null, source: document.querySelector('#hud-source')?.hidden ? null : document.querySelector('#hud-source')?.textContent ?? null,
        header: document.querySelector('#scene-title')?.textContent ?? null, forge: document.querySelector('.btn-forge span')?.textContent ?? null })`);
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

    // W3-E1: an anonymous creator's world on the stage, not saved; "Sign in to keep this world" beside its title.
    await page.send('Page.navigate', { url: `${studioOrigin}/studio.html?create=agent` });
    const started = await until(`!!document.querySelector('#gpu-pill i.ok') && !document.querySelector('.btn-forge')?.disabled`, 60_000);
    const gpuLabel = await evaluate(`document.querySelector('#gpu-pill')?.textContent ?? null`);
    const readyA = started && await create(IDEA);
    const onStageA = await installedAs(TITLE, 'Live');
    const asked = await until(saveIs('Not saved'), 15_000);
    const e1 = { stage: await stage(), save: await saveLook() };
    await shot('anonymous-not-saved');
    step('W3-E1 an anonymous creator\'s world on the stage: "Not saved" beside its title, "Sign in to keep this world" its one action; nothing sent to the platform',
        readyA && onStageA && asked && e1.save.header.shown && e1.save.header.tone === 'warn' && e1.save.header.buttons.join() === 'Sign in to keep this world'
        && saves().length === 0 && !calls.some(c => c.route === 'POST /v1/me'), { gpu: gpuLabel, ...e1 });

    // W3-E2: that sign-in sets the account up, then saves the world once.
    await pressSave('Sign in to keep this world');
    const kept = await until(saveIs('Saved'), 30_000);
    await sleep(500);
    const e2 = { save: await saveLook(), saves: saves(), me: calls.filter(c => c.route === 'POST /v1/me').length };
    await shot('saved');
    const first = saves()[0];
    const savedWorld = first ? [...worlds.values()][0]?.world ?? null : null;
    step('W3-E2 the sign-in (the same uid, now Google) sets the account up once, then saves the world once: under a key, its text the hash it claims; "Saved", and the way to the history',
        kept && e2.me === 1 && e2.saves.length === 1 && first.who === 'google' && first.title === TITLE && /^[A-Za-z0-9-]{16,64}$/.test(first.key) && worlds.size === 1
        && e2.save.header.tone === 'ok' && e2.save.header.links.join() === '/creations' && e2.save.header.buttons.length === 0, e2);

    // W3-E3: /creations lists it, and opens it in the studio by its id.
    await page.send('Page.navigate', { url: `${studioOrigin}/creations` });
    const listed = await until(`[...document.querySelectorAll('.world-card .world-title')].some(t => t.textContent === ${JSON.stringify(TITLE)})`, 30_000);
    const card = await evaluate(`(() => { const c = document.querySelector('.world-card'); const a = c?.querySelector('a.world-open'); return c ? { title: c.querySelector('.world-title')?.textContent, open: a && !a.hidden ? a.getAttribute('href') : null, usage: document.querySelector('.history-usage')?.textContent ?? null } : null; })()`);
    await shot('creations');
    const link = savedWorld ? `/studio.html?create=agent&world=${savedWorld.worldId}` : null;
    step('W3-E3 /creations lists the saved world, with "Open in the studio" linking to the studio by its id',
        listed && card?.title === TITLE && card.open === link, { card, link });

    // W3-E4: the studio opens it: read, checked, sealed and compiled here, then Show it on the stage's card, the GPU go.
    const mark = calls.length;
    await evaluate(`document.querySelector('.world-card a.world-open').click()`);
    const offered = await until(`!!document.querySelector('.empty-open-show') && !document.querySelector('.empty-open-show').disabled`, 90_000);
    const card4 = await evaluate(`({ text: document.querySelector('.empty-open-text')?.textContent ?? null, url: location.pathname + location.search })`);
    const beforeGo = calls.slice(mark).map(c => c.route);
    await shot('reopen-ready');
    await evaluate(`document.querySelector('.empty-open-show').click()`);
    const reopened = await installedAs(TITLE, 'From the archive');
    const savedAgain = await until(saveIs('Saved'), 10_000);
    await sleep(800);
    const e4 = { card: card4, stage: await stage(), save: await saveLook(), routes: calls.slice(mark).map(c => c.route) };
    await shot('reopened');
    step('W3-E4 opened by the link: offered on the stage\'s card once sealed and compiled here ("ready. Press Show it"), and nothing on the stage before the press',
        offered && card4.url === link && card4.text === `“${TITLE}” is ready. Press Show it to test it on your graphics card.`
        && beforeGo.includes('GET /v1/worlds/{id}') && beforeGo.includes('GET /v1/worlds/{id}/revisions/{id}'), { card: card4, beforeGo });
    step('W3-E4 then Show it puts the castle on the stage From the archive, its title the saved one, "Saved": no model route called, nothing saved again',
        reopened && savedAgain && e4.stage.title === TITLE && e4.stage.header === TITLE && !e4.routes.some(r => MODEL.test(r)) && !e4.routes.includes('POST /v1/worlds'), e4);

    // W3-E5: a new world whose save is answered 409: said, "Save as a new world" saves it under a new key.
    savePlan.push('conflict');
    const readyB = await create(IDEA_B);
    const onStageB = await installedAs(TITLE_B, 'Live');
    const conflicted = await until(saveIs('Not saved: changed in another tab'), 30_000);
    const e5a = await saveLook();
    await shot('conflict');
    await pressSave('Save as a new world');
    const resaved = await until(saveIs('Saved'), 30_000);
    const tries = saves().slice(1);
    step('W3-E5 a 409 is said ("Not saved: changed in another tab"), the world kept on the stage; "Save as a new world" (no "Open the saved one" for a world never saved) saves it under a new key',
        readyB && onStageB && conflicted && e5a.header.buttons.join() === 'Save as a new world' && resaved && tries.length === 2
        && tries[0].plan === 'conflict' && tries[1].key !== tries[0].key && tries[1].title === TITLE_B && (await stage()).title === TITLE_B,
        { save: e5a, tries: tries.map(t => ({ key: t.key, plan: t.plan, title: t.title })) });

    // W3-E6: a full storage: said once, never sent again by itself; "Try again" once room is made saves it.
    savePlan.push('full');
    const readyC = await create(IDEA_C);
    const onStageC = await installedAs(TITLE_C, 'Live');
    const full = await until(saveIs('Not saved: your storage is full'), 30_000);
    const e6a = await saveLook();
    const sentFull = saves().length;
    await sleep(4_000);
    const notByItself = saves().length === sentFull;
    await shot('storage-full');
    await pressSave('Try again');
    const savedC = await until(saveIs('Saved'), 30_000);
    step('W3-E6 a full storage is said, with the way to the history and "Try again"; never sent again by itself; "Try again" once room is made saves it',
        readyC && onStageC && full && notByItself && e6a.header.links.join() === '/creations' && e6a.header.buttons.join() === 'Try again' && savedC
        && saves().length === sentFull + 1 && worlds.size === 3, { save: e6a, sent: saves().length });

    // W3-E7: at 390 px the header has no title, so the save's line sits under the idea box; the page as wide as the screen.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(800);
    const phone = { save: await saveLook(), width: await evaluate('document.documentElement.scrollWidth') };
    await shot('phone');
    await page.send('Emulation.clearDeviceMetricsOverride');
    step('W3-E7 at 390 px the save\'s word sits under the idea box (the header has no title), and the page is exactly as wide as the screen',
        !phone.save.header.shown && phone.save.line.shown && phone.save.line.text === 'Saved' && phone.width === 390, phone);

    // W3-E8 (Q129, 2026-11-04): a world written and waiting for Show it, then Sign out: asked first; "Sign out and discard"
    // discards it unshown, and the world on the stage stays, saved to the account that made it, never offered here.
    await sleep(500);
    await evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = 'A castle at dawn. Mist over the moat.'; p.dispatchEvent(new Event('input')); })()`);
    await evaluate(`document.querySelector('.btn-forge').click()`);
    const readyD = await until(`document.querySelector('.btn-forge span')?.textContent === 'Show it' && !document.querySelector('.btn-forge').disabled`, 90_000);
    const savesBefore = saves().length;
    await evaluate(`[...document.querySelectorAll('.account button')].find(b => b.textContent === 'Sign out' && !b.hidden)?.click()`);
    const askedD = await until(`document.querySelector('dialog.account-dialog[open] .acct-body')?.textContent === "Your new world hasn't been shown yet. Signing out discards it."`, 10_000);
    const choices = await evaluate(`[...document.querySelectorAll('dialog.account-dialog[open] button')].map(b => b.textContent)`);
    await shot('sign-out-asks');
    await evaluate(`[...document.querySelectorAll('dialog.account-dialog[open] button')].find(b => b.textContent === 'Sign out and discard')?.click()`);
    const goneD = await until(`document.querySelector('.btn-forge span')?.textContent !== 'Show it' && localStorage.getItem('wexy.devProvider') === null`, 20_000);
    // Said as it is (the account review's L1): the new world was discarded, not "still here".
    await until(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.startsWith('Signed out')`, 5_000);
    const toastD = await evaluate(`document.querySelector('#toast').textContent`);
    await sleep(800);
    const e8 = { choices, toast: toastD, stage: await stage(), save: await saveLook(), forge: await evaluate(`document.querySelector('.btn-forge span')?.textContent ?? null`) };
    await shot('discarded');
    step('W3-E8 (Q129) a world waiting for Show it: Sign out asks first (Show it first, Sign out and discard); discarded, said so, it never shows; the world on the stage stays, saved to the account that made it, nothing offered',
        readyD && askedD && choices.join() === 'Show it first,Sign out and discard' && goneD && e8.toast === 'Signed out. Your new world was discarded.'
        && e8.stage.title === TITLE_C && e8.forge !== 'Show it'
        && e8.save.header.text === 'Saved to the account that made it' && e8.save.header.buttons.length === 0 && saves().length === savesBefore, e8);

    const errors = consoleLines.filter(l => /^(error|exception)/.test(l));
    step('no console error', errors.length === 0, errors.slice(0, 5));
    const unexpected = calls.filter(c => c.unexpected || c.refused);
    const worldCalls = calls.filter(c => /\/v1\/(worlds|me\/)/.test(c.route));
    step('the stand-in was asked only for the agent routes, the allowance, the account and the world routes; every world call a signed-in caller\'s',
        unexpected.length === 0 && worldCalls.length > 0 && worldCalls.every(c => c.who === 'google') && calls.filter(c => c.route === 'POST /v1/agent/turn').length === 4,
        { unexpected, routes: [...new Set(calls.map(c => c.route))] });
    writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ gpu, gpuLabel, steps, calls, console: consoleLines }, null, 1));
    const passed = steps.filter(s => s.ok).length;
    console.log(`\ndrive-saves (${gpu}): ${gpuLabel}; ${passed}/${steps.length} steps${passed === steps.length ? '' : ', FAILED'}\nevidence in ${OUT}`);
    failed = passed !== steps.length;
} catch (e) {
    console.error(`drive-saves: ${e?.stack ?? e}`);
} finally {
    page?.close();
    for (let i = 0; i < 30 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']);
    stopAll();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* best effort */ }
}
await quit(failed ? 1 : 0);
