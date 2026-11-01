// Agent turns against a running gateway, through this build's own transport, then checked statically, with no GPU
// and no browser. Two uses:
// - gate F, the bounded live probe (the backend's agent-loop design §15.1): the deployed gateway (the VPS through an
//   SSH forward), an anonymous Firebase sign-in over REST, every turn live and spending credit, on the user's go only;
// - gate C, the integrated check: a local gateway under the `local` profile with the service's mock upstream
//   (`--dev-identity`, the backend's local dev token), no key and no spend.
// Each turn goes through createAgentClient over createApi (http.ts: the envelope of a refusal, the single-use App
// Check list, the 401 retry) and readAgentStream (the engine bundle, the action contract and the adapter manifest
// pinned at meta), as the studio's turn does; a handed-off program is then resolved and checked here: resolveProgram,
// checkGraph at P v1, deriveInterfaces. "Statically resolved, not rendered".
//
//   node --import ./test/register.mjs dev/agent-live.mjs [--probe] [--request block-film|galaxy|foggy-dusk]...
//        [--prompt "an idea"]... [--style auto] [--seconds 15] [--max-usd 1.5] [--gateway http://localhost:8400]
//        [--dev-identity] [--label live|mock] [--candidate] [--out dir]
//
// --candidate (EA4.3's machine, live): a hand-off that resolves is made a candidate, each module written and repaired by
// live calls to /v1/agent/module (the turn's own caller, its single-use App Check), each body checked by the host's
// L1, auto-fix and final L1, no compiler (no L3: no GPU here). A program the browser refuses goes to one program
// revision (EA4.4's createReviser: a turn with a base, the same caller), as the studio's candidate does. Its bundle
// (bodies, evidence, the turns and every call's charge) goes to <name>.candidate.json; its module calls and its
// revision's count against --max-usd. --force-revision (with --candidate) tests that revision live: the harness renames
// the first compute stage's entry to `step`, which the server's check passes and the browser refuses (a WGSL built-in),
// before the candidate starts; the report marks the program as altered by the harness, never as the model's.
//
// --probe spends nothing: it reads the mode and sends an empty turn and an empty plan, which the service refuses
// before any charge. The empty turn still costs the gateway's buckets a whole turn (agent-turn-anonymous: two turns, a
// turn and its revision, then one every 120 s, per user, since the EA4.4 review), so a turn run never sends it, and
// waits out a turn's refill between its turns.
// The requests are the paper test's three (the backend's paper/requests.v1.json), by id; gate F sends the first,
// then the other two when its evidence is acceptable. --max-usd stops before the next turn once the turns so far cost
// that much (reservations counted where a call reported no usage). A failure inside a started stream (the model's)
// is evidence and the next request still goes; a refusal before the stream, a version mismatch or a cut stream stops.
// The live identity is Firebase's anonymous sign-up over REST with the studio's web key (.env.local or the
// environment), sent with the dev studio's referrer. There is no browser to attest a call: with a registered debug
// token (WEXY_APPCHECK_DEBUG_TOKEN, .env.local or the environment) each call carries an App Check token Firebase trades
// for it, limited-use where the route spends one; without one, a gateway that enforces App Check (D3) refuses the call
// before anything is forwarded, and one in monitor mode logs it and lets it through.
// The label is the caller's word: this script cannot tell a mock from a model. Per turn it writes the raw stream
// (<name>.sse) and the events with their arrival times (<name>.events.json); report.json holds everything.
// Default out: dev/out/agent-live/<label>-<time>/. Exits 1 when a turn or a check fails, 2 when the gateway or the
// sign-in is not ready.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_MANIFEST_HASH } from '../src/contract/adapters/index.ts';
import { checkGraph } from '../src/contract/adapters/checks.ts';
import { POLICY_V1 } from '../src/contract/adapters/graph.ts';
import { deriveInterfaces } from '../src/contract/adapters/interfaces.ts';
import { resolveProgram } from '../src/contract/adapters/resolve.ts';
import { AGENT_ACTION_VERSION } from '../src/contract/agent/index.ts';
import { createAgentClient, ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';
import { parseConfig } from '../src/forge-client/config.ts';
import { createApi } from '../src/forge-client/http.ts';
import { createIdentity } from '../src/forge-client/identity.ts';
import { createModuleClient } from '../src/forge-client/module-client.ts';
import { candidateBundle, createCandidateSession, handOffOf } from '../src/loop/candidate.ts';
import { createReviser } from '../src/loop/reviser.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const all = n => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const gateway = opt('gateway', 'http://localhost:8400').replace(/\/+$/, '');
const probeOnly = argv.includes('--probe');
const devIdentity = argv.includes('--dev-identity');
const label = opt('label', devIdentity ? 'mock' : 'live');
const style = opt('style', 'auto');
const seconds = Number(opt('seconds', '15'));
const maxMicroUsd = Math.round(Number(opt('max-usd', '1.5')) * 1e6);
const runCandidate = argv.includes('--candidate');
const forceRevision = argv.includes('--force-revision');

/** The paper test's requests (the backend's forge-service/src/main/resources/paper/requests.v1.json). */
const PAPER = {
    'block-film': 'make minecraft 1870s film style',
    galaxy: 'a spiral galaxy, gold at the core and blue along the arms',
    'foggy-dusk': 'rolling hills under thick fog at dusk, the last light fading behind them',
};
const turns = [
    ...all('request').map(id => {
        if (!PAPER[id]) { console.error(`agent-live: no request named "${id}" (${Object.keys(PAPER).join(', ')}); use --prompt for free text.`); process.exit(2); }
        return { name: id, prompt: PAPER[id] };
    }),
    ...all('prompt').map((prompt, i) => ({ name: `prompt-${i + 1}`, prompt })),
];
if (!probeOnly && turns.length === 0) turns.push({ name: 'block-film', prompt: PAPER['block-film'] });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(opt('out', join(ROOT, 'dev', 'out', 'agent-live', `${probeOnly ? 'probe' : label}-${stamp}`)));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// process.exit straight after fetch answers trips a libuv assertion in Node 24 on Windows; a moment's wait first.
const quit = async code => { await sleep(150); process.exit(code); };
const usd = micro => (micro === null ? 'unknown' : `$${(micro / 1e6).toFixed(4)}`);

// --- The identity: the local dev token, or Firebase's anonymous sign-in over REST ---------------------------------
/** A name from the environment, else from .env.local; null when neither has it. */
function localValue(name) {
    if (process.env[name]?.trim()) return process.env[name].trim();
    const file = join(ROOT, '.env.local');
    if (!existsSync(file)) return null;
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || null;
}
const webKey = () => localValue('VITE_FIREBASE_API_KEY');

/**
 * Under App Check enforcement (D3) the gateway refuses what is not attested, and this script has no browser to attest
 * it. A registered debug token (WEXY_APPCHECK_DEBUG_TOKEN, the environment or .env.local) is traded with Firebase for
 * an App Check token, limited-use where the route spends one, as the studio's SDK trades its own. It is never printed
 * or written; the report says only that one was used.
 */
const appCheckDebug = localValue('WEXY_APPCHECK_DEBUG_TOKEN');
async function appCheckToken(key, limitedUse) {
    const project = localValue('VITE_FIREBASE_PROJECT_ID');
    const app = localValue('VITE_FIREBASE_APP_ID');
    if (!project || !app) throw new Error('App Check: no VITE_FIREBASE_PROJECT_ID or VITE_FIREBASE_APP_ID in .env.local or the environment');
    const res = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(project)}/apps/${encodeURIComponent(app)}:exchangeDebugToken?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'http://localhost:5173/' },
        body: JSON.stringify({ debugToken: appCheckDebug, limitedUse }), signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.token !== 'string') throw new Error(`App Check: the debug token's exchange answered HTTP ${res.status}: ${body?.error?.message ?? 'no token'}`);
    return body.token;
}

async function signIn(key, appCheck) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'http://localhost:5173/', ...(appCheck ? { 'X-Firebase-AppCheck': appCheck } : {}) },
        body: JSON.stringify({ returnSecureToken: true }), signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.idToken !== 'string') throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? 'no token'}`);
    return { idToken: body.idToken, uid: body.localId, expiresInS: Number(body.expiresIn) };
}

const report = { gateway, started: new Date().toISOString(), label: probeOnly ? 'probe (no model call)' : label, gpu: 'none', browser: 'none (Node fetch)',
    client: { bundleHash: ENGINE_BUNDLE_HASH, actionSchema: AGENT_ACTION_VERSION, manifestHash: ADAPTER_MANIFEST_HASH, transport: 'createAgentClient over createApi' },
    request: { style, seconds }, maxMicroUsd, probe: {}, turns: [] };
const save = () => writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

// The studio's own config for this gateway: no Firebase config, so a development build on a loopback origin carries
// the dev identity (identity.ts), and the live run supplies its own identity below.
const { config, problems } = parseConfig({ VITE_API_ORIGIN: gateway, DEV: devIdentity });
if (!config.apiOrigin) { console.error(`agent-live: ${problems.join(' ')}`); await quit(2); }
let identity;
if (devIdentity) {
    identity = createIdentity(config);
    const authorization = await identity.authorization(false);
    if (!authorization) { console.error('agent-live: no dev identity: the gateway must be on a loopback origin.'); await quit(2); }
    report.probe.signIn = { ok: true, dev: true };
    console.log(`agent-live: the local dev identity (${authorization.slice(7, 26)}…), for a gateway under the local profile`);
} else {
    const key = webKey();
    if (!key) { console.error('agent-live: no VITE_FIREBASE_API_KEY in .env.local or the environment.'); await quit(2); }
    const attest = appCheckDebug ? (limitedUse) => appCheckToken(key, limitedUse) : null;
    let signed;
    try { signed = await signIn(key, attest ? await attest(false) : null); } catch (e) { console.error(`agent-live: anonymous sign-in failed (${e.message}).`); await quit(2); }
    identity = { authorization: async () => `Bearer ${signed.idToken}`, appCheck: async (singleUse) => (attest ? attest(singleUse) : null) };
    report.probe.signIn = { ok: true, uid: `${signed.uid.slice(0, 6)}…`, expiresInS: signed.expiresInS };
    report.probe.appCheck = attest ? 'a registered debug token, exchanged with Firebase per request (not shown)' : 'none';
    console.log(`agent-live: signed in anonymously (${report.probe.signIn.uid}, the token valid ${signed.expiresInS} s); App Check ${attest ? 'by a registered debug token (not shown)' : 'none'}`);
}
const auth = { Authorization: await identity.authorization(false) };
/** The probe's own App Check header: a limited-use token, as the turn and plan routes spend one. */
const attested = async () => { const t = await identity.appCheck(true); return t ? { 'X-Firebase-AppCheck': t } : {}; };

// --- The free probe: the mode, then requests the service must refuse before any charge -------------------------
async function answer(path, init) {
    const t0 = performance.now();
    const res = await fetch(`${gateway}${path}`, { ...init, signal: AbortSignal.timeout(20_000) }).catch(e => ({ status: 0, error: e }));
    const text = res.text ? await res.text().catch(() => '') : String(res.error?.message ?? '');
    return { status: res.status, ms: Math.round(performance.now() - t0), body: text.slice(0, 300) };
}
report.probe.mode = await answer('/v1/forge/mode', {});
console.log(`  mode: HTTP ${report.probe.mode.status} in ${report.probe.mode.ms} ms ${report.probe.mode.body.replace(/\s+/g, ' ').slice(0, 160)}`);
if (report.probe.mode.status !== 200) { console.error('agent-live: the gateway is not ready (the mode read failed).'); await quit(2); }
if (probeOnly) {
    report.probe.emptyTurn = await answer('/v1/agent/turn', { method: 'POST', headers: { ...auth, ...(await attested()), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: '{}' });
    report.probe.emptyPlan = await answer('/v1/forge/plan', { method: 'POST', headers: { ...auth, ...(await attested()), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: '{}' });
    for (const [name, r] of Object.entries({ 'empty turn': report.probe.emptyTurn, 'empty plan': report.probe.emptyPlan })) {
        console.log(`  ${name}: HTTP ${r.status} in ${r.ms} ms ${r.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    save();
    const turnRoute = report.probe.emptyTurn.status === 400 ? 'served (the empty turn refused as bad-request, no charge)'
        : report.probe.emptyTurn.status === 404 ? 'not served by this deployment' : `unexpected (HTTP ${report.probe.emptyTurn.status})`;
    console.log(`agent-live: /v1/agent/turn ${turnRoute}; probe only, nothing spent. ${join(OUT, 'report.json')}`);
    await quit(report.probe.emptyTurn.status === 400 ? 0 : 1);
}
save();

// --- The turns ------------------------------------------------------------------------------------------------
/** One event as the report keeps it: designs and programs whole once, in the result; the rest as they came. */
const kept = (ev, at) => (ev.type === 'design' || ev.type === 'program' ? { at, type: ev.type, chars: JSON.stringify(ev[ev.type]).length } : { at, ...ev });

/** The transport's fetch, with every response's body teed into `sink`: the raw stream, as it came. */
function teeingFetch(sink, at) {
    return async (input, init) => {
        const res = await fetch(input, init);
        sink.status = res.status;
        sink.headersMs = at();
        sink.headers = Object.fromEntries(res.headers);
        if (!res.body) return res;
        const [mine, theirs] = res.body.tee();
        sink.raw = '';
        sink.chunks = [];
        sink.done = (async () => {
            const decoder = new TextDecoder();
            try {
                for await (const chunk of mine) {
                    const text = decoder.decode(chunk, { stream: true });
                    sink.raw += text;
                    // When each piece came, and whether it held a heartbeat (a comment line): silence is evidence too.
                    sink.chunks.push({ at: at(), chars: text.length, heartbeat: /(^|\n):/.test(text) });
                }
            } catch (e) { sink.chunks.push({ at: at(), cut: String(e?.message ?? e) }); }
            sink.raw += decoder.decode();
        })();
        return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
}

async function runTurn({ name, prompt }) {
    const entry = { name, prompt, style, seconds, sentAt: new Date().toISOString() };
    const controller = new AbortController();
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const events = [];
    const sink = { raw: '', status: null, headers: null, headersMs: null, done: Promise.resolve() };
    const client = createAgentClient(createApi(config, identity, teeingFetch(sink, at)));
    try {
        entry.result = await client.turn({ prompt, style, seconds }, ev => events.push(kept(ev, at())), controller.signal);
    } catch (e) {
        entry.error = { name: e?.name ?? 'Error', code: e?.code ?? null, status: e?.status ?? null, message: String(e?.message ?? e) };
    } finally {
        entry.elapsedMs = at();
        await Promise.race([sink.done, sleep(3000)]);
        controller.abort();
    }
    const h = sink.headers ?? {};
    entry.http = { status: sink.status, contentType: h['content-type'] ?? null, headersMs: sink.headersMs, rateRemaining: h['x-ratelimit-remaining'] ?? null,
        retryAfter: h['retry-after'] ?? null };
    writeFileSync(join(OUT, `${name}.sse`), sink.raw);
    writeFileSync(join(OUT, `${name}.events.json`), `${JSON.stringify(events, null, 2)}\n`);
    entry.rawChars = sink.raw.length;
    entry.chunks = sink.chunks ?? [];
    entry.heartbeatsAt = entry.chunks.filter(c => c.heartbeat).map(c => c.at);
    entry.events = events.map(e => `${e.at} ms ${e.type}${e.call ? ` ${e.call.n}:${e.call.purpose}` : ''}${e.usage ? ` ${e.usage.n}` : ''}${e.check ? ` ${e.check.n} ${e.check.ok ? 'ok' : 'fail'}` : ''}`);

    // The calls, from the events (a turn that ends in an error event has no result, but its calls were made and paid
    // for): when each began, its tokens and cost, what it read, what the server's check said.
    const byN = new Map();
    for (const e of events) {
        const n = e.call?.n ?? e.usage?.n ?? e.tools?.n ?? e.check?.n;
        if (n === undefined) continue;
        if (!byN.has(n)) byN.set(n, { n, purpose: null, startedMs: null, usageMs: null, tokens: null, costMicroUsd: null, generationId: null, reads: [], check: null });
        const c = byN.get(n);
        if (e.type === 'call') { c.purpose = e.call.purpose; c.startedMs = e.at; }
        if (e.type === 'usage') {
            c.usageMs = e.at; c.costMicroUsd = e.usage.costMicroUsd; c.generationId = e.usage.generationId;
            c.tokens = { in: e.usage.in, out: e.usage.out, reasoning: e.usage.reasoning, cached: e.usage.cached };
        }
        if (e.type === 'tools') c.reads.push(...e.tools.results.map(r => `${r.tool}(${r.target})${r.ok ? '' : ` refused: ${r.error}`}`));
        if (e.type === 'check') c.check = { ok: e.check.ok, findings: e.check.findings };
    }
    entry.calls = [...byN.values()];
    entry.costMicroUsd = entry.result ? entry.result.costMicroUsd : null;
    entry.knownCostMicroUsd = entry.calls.reduce((s, c) => s + (c.costMicroUsd ?? 0), 0);

    // The hand-off, checked here as the studio would before anything runs: X, its checks, the module interfaces.
    if (entry.result?.status === 'handed-off') {
        const nodes = entry.result.program.nodes;
        entry.program = { nodes: nodes.map(n => `${n.id}:${n.adapterId}@${n.adapterVersion}`) };
        const r = await resolveProgram(nodes, POLICY_V1);
        if (!r.ok) entry.static = { resolved: false, diagnostics: r.diagnostics };
        else {
            const x = r.graph;
            const c = await checkGraph(x, POLICY_V1);
            const d = await deriveInterfaces(x);
            entry.static = {
                resolved: true, graph: x.hash, executable: x.executable,
                counts: { nodes: x.nodes.length, resources: x.resources.length, objects: x.objects.length, operations: x.operations.length, modules: x.modules.length },
                estimate: x.estimate, output: x.output,
                checked: { ok: c.ok, errors: c.findings.filter(f => f.severity === 'error'), warnings: c.findings.filter(f => f.severity === 'warning').map(f => `${f.check} ${f.subject ?? ''}: ${f.message}`), truncated: c.truncated },
                interfaces: d.ok ? d.interfaces.map(i => ({ module: i.module, node: i.node, kind: i.kind, entries: i.entries.map(e => e.signature), interfaceHash: i.interfaceHash })) : { diagnostics: d.diagnostics },
            };
        }
        if (runCandidate) {
            let handed = entry.result;
            if (forceRevision) {
                // The harness's change, not the model's: the first compute stage's entry renamed to a WGSL built-in.
                const stage = handed.program.nodes.find(n => n.adapterId === 'ng.compute.stage');
                if (stage) {
                    const config = JSON.parse(stage.config);
                    entry.forcedRevision = { node: stage.id, entry: config.entry, renamedTo: 'step' };
                    handed = { ...handed, program: { nodes: handed.program.nodes.map(n => (n === stage ? { ...n, config: JSON.stringify({ ...config, entry: 'step' }) } : n)) } };
                    console.log(`  forced: the harness renamed ${stage.id}'s entry ${config.entry} to step, which the browser refuses`);
                }
            }
            entry.candidate = await candidateOf(name, handed, { prompt, style, seconds });
        }
    }
    return entry;
}

/**
 * The hand-off made a candidate (EA4.3's machine) with live module calls: the same caller and App Check as the turn,
 * the host's checker, no compiler, and a program revision through the turn route (EA4.4). What it did, and the bundle
 * Developer view downloads (EA4.5).
 */
async function candidateOf(name, result, request) {
    const t0 = performance.now();
    const phases = [];
    const session = createCandidateSession({
        modules: createModuleClient(createApi(config, identity)), revise: createReviser(createAgentClient(createApi(config, identity))),
    }, s => {
        if (phases.at(-1)?.phase !== s.phase) phases.push({ at: Math.round(performance.now() - t0), phase: s.phase });
    });
    const end = await session.start(handOffOf(request, result));
    writeFileSync(join(OUT, `${name}.candidate.json`), `${JSON.stringify(candidateBundle(end), null, 2)}\n`);
    // The hand-off's own calls are the turn's, counted with it; a revision's are the candidate's.
    const revisions = end.turns.filter(t => t.role === 'revision');
    const known = (calls) => calls.reduce((s, c) => s + (c.costMicroUsd ?? 0), 0);
    return {
        phase: end.phase, id: end.id, stop: end.stop, elapsedMs: Math.round(performance.now() - t0), phases,
        modules: end.modules.map(m => ({ module: m.module, kind: m.kind, phase: m.phase, calls: m.calls, repairs: m.repairs, lines: m.body?.split('\n').length ?? null })),
        revisions: revisions.map(t => ({ turnId: t.turnId, status: t.status, model: t.model, promptVersion: t.promptVersion, charge: t.charge, error: t.error,
            calls: t.calls.map(c => ({ n: c.n, purpose: c.purpose, charge: c.charge, costMicroUsd: c.costMicroUsd })) })),
        jobs: end.jobs.map(j => ({ jobId: j.jobId, module: j.module, purpose: j.purpose, status: j.status, charge: j.charge, costMicroUsd: j.costMicroUsd, model: j.model, promptVersion: j.promptVersion, error: j.error })),
        verdicts: end.evidence.filter(e => e.phase === 'lint' || e.phase === 'candidate' || e.verdict === 'fail').map(e => ({
            phase: e.phase, verdict: e.verdict, module: e.subject.module, findings: e.findings.map(f => `${f.severity} ${f.code}${f.line ? ` line ${f.line}` : ''}: ${f.message.slice(0, 160)}`),
        })),
        budget: end.budget,
        knownCostMicroUsd: known(end.jobs) + known(revisions.flatMap(t => t.calls)),
    };
}

let spent = 0;
let failed = false;
/** The anonymous bucket gives a user one turn and refills it in 120 s (the gateway's GatewayShieldProperties). */
const BUCKET_MS = 125_000;
let lastStart = null;
for (const t of turns) {
    if (spent >= maxMicroUsd) { console.log(`agent-live: stopped before "${t.name}": ${usd(spent)} spent of ${usd(maxMicroUsd)} allowed.`); report.stopped = `budget before ${t.name}`; break; }
    if (lastStart !== null && !devIdentity && performance.now() - lastStart < BUCKET_MS) {
        const wait = Math.ceil(BUCKET_MS - (performance.now() - lastStart));
        console.log(`agent-live: waiting ${Math.round(wait / 1000)} s for the anonymous turn bucket to refill`);
        await sleep(wait);
    }
    lastStart = performance.now();
    console.log(`agent-live: turn "${t.name}": ${JSON.stringify(t.prompt)} (style ${style}, ${seconds} s)`);
    const e = await runTurn(t);
    report.turns.push(e);
    save();
    spent += e.costMicroUsd ?? e.knownCostMicroUsd;
    const meta = e.result?.meta;
    if (meta) console.log(`  meta: turn ${meta.turnId}, ${meta.model}, prompt ${meta.promptVersion}, action ${meta.actionSchema}, bundle ${meta.bundleHash.slice(0, 12)}, manifest ${String(meta.manifestHash).slice(0, 12)}`);
    for (const c of e.calls) {
        console.log(`  call ${c.n} ${c.purpose}: at ${c.startedMs} ms, usage at ${c.usageMs} ms; tokens ${JSON.stringify(c.tokens)}; ${usd(c.costMicroUsd)}`
            + `${c.reads.length ? `; read ${c.reads.join(', ')}` : ''}${c.check ? `; check ${c.check.ok ? 'ok' : `fail (${c.check.findings.filter(f => f.level === 'fail').map(f => f.code).join(', ')})`}` : ''}`);
    }
    console.log(`  stream: ${e.chunks.length} piece(s); heartbeats at ${e.heartbeatsAt.length ? e.heartbeatsAt.map(ms => `${(ms / 1000).toFixed(1)} s`).join(', ') : 'none'}`
        + `${e.chunks.at(-1)?.cut ? `; cut at ${(e.chunks.at(-1).at / 1000).toFixed(1)} s (${e.chunks.at(-1).cut})` : ''}`);
    if (e.error) {
        console.log(`  FAILED after ${e.elapsedMs} ms, ${usd(e.knownCostMicroUsd)}: ${e.error.name} ${e.error.code ?? ''} (HTTP ${e.http?.status ?? '-'}): ${e.error.message}`);
        failed = true;
        // A failure inside a started stream (the model's, an error event) is evidence, and the next request still goes;
        // a refusal before the stream (a 429, a refused charge), a version mismatch or a cut stream stops the run.
        const inStream = e.http?.status === 200 && e.error.name === 'ForgeError' && e.events.some(l => / meta$/.test(l)) && /^upstream|^timeout/.test(e.error.code ?? '');
        if (!inStream) break;
        continue;
    }
    const r = e.result;
    console.log(`  ${r.status} after ${e.elapsedMs} ms, ${usd(e.costMicroUsd)}${r.status === 'handed-off' ? '' : `: ${r.reason ?? r.question ?? ''}`}`);
    if (e.program) console.log(`  program: ${e.program.nodes.join(', ')}`);
    if (e.static) {
        const s = e.static;
        if (!s.resolved) { console.log(`  resolve REFUSED: ${s.diagnostics.map(d => `${d.code} ${d.path}: ${d.message}`).join(' | ')}`); failed = true; }
        else {
            console.log(`  X ${s.graph.slice(0, 12)}: ${JSON.stringify(s.counts)}; checks ${s.checked.ok ? 'pass' : `FAIL ${s.checked.errors.map(f => `${f.check} ${f.subject}: ${f.message}`).join(' | ')}`}; ${s.checked.warnings.length} warnings`);
            if (Array.isArray(s.interfaces)) for (const i of s.interfaces) console.log(`  module ${i.module} (${i.kind}, ${i.node}): ${i.entries.join('; ')} [${i.interfaceHash.slice(0, 12)}]`);
            if (!s.checked.ok) failed = true;
        }
    }
    if (e.candidate) {
        const c = e.candidate;
        spent += c.knownCostMicroUsd;
        console.log(`  candidate: ${c.phase} after ${c.elapsedMs} ms (${c.phases.map(p => `${p.phase}@${p.at}`).join(' → ')}); ${c.jobs.length} module call(s), `
            + `${c.revisions.length} revision(s), ${usd(c.knownCostMicroUsd)} known${c.stop ? `; stopped (${c.stop.scope}): ${c.stop.diagnostic}` : ''}`);
        for (const t of c.revisions) {
            console.log(`    revision ${t.turnId ?? '(no turn id)'}: ${t.status}, ${t.charge}, ${t.model ?? '-'} ${t.promptVersion ?? ''}${t.error ? `: ${t.error}` : ''}; `
                + `calls ${t.calls.map(x => `${x.n} ${x.purpose} ${usd(x.costMicroUsd)}`).join(', ') || 'none'}`);
        }
        for (const j of c.jobs) console.log(`    ${j.jobId} ${j.module} ${j.purpose}: ${j.status}, ${j.charge} ${usd(j.costMicroUsd)}, ${j.model ?? '-'} ${j.promptVersion ?? ''}${j.error ? `: ${j.error}` : ''}`);
        for (const v of c.verdicts) console.log(`    ${v.phase} ${v.module ?? ''} ${v.verdict}${v.findings.length ? `: ${v.findings.join(' | ')}` : ''}`);
        if (c.phase !== 'static-verified') failed = true;
    }
    if (r.status !== 'handed-off') { failed = true; break; }
}
report.spentMicroUsd = spent;
report.finished = new Date().toISOString();
save();
console.log(`agent-live (${label}): ${report.turns.length} turn(s), ${usd(spent)} counted (reservations where no usage came). ${join(OUT, 'report.json')}`);
await quit(failed ? 1 : 0);
