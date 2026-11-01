// EA-E1, headless (EA4.5; candidate-loop-design.md §2's P6, §10 and §13): the candidate loop end to end over the
// recorded wire, with no model, no backend and no GPU. (The executor's EA-E series, EA3.5's, is another: this is the
// candidate-loop design's EA-E1.)
//   - The backend's recorded hand-off (test/fixtures/agent-wire/handed-off.sse) through the real agent client, reader
//     and transport, only fetch faked.
//   - The candidate machine with the real module client. Its author call is answered by the backend's own recording
//     (test/fixtures/module-wire/author.sse) byte for byte: this candidate sends exactly the job that recording echoes,
//     its X and interface the backend's, so the echo is the recording's own.
//   - A fake compiler fails that body once, on one of its lines, so the module is repaired. The repair is answered by
//     the recorded repair (repair.sse), which the backend recorded as a lone call: its deltas, usage and done as
//     recorded, its job identity this request's, as the backend echoes every call's.
//   - The candidate static-verified and sealed, its evidence complete, its bundle downloadable, Q_C counted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgentClient } from '../src/forge-client/agent-client.ts';
import { createApi } from '../src/forge-client/http.ts';
import { createModuleClient } from '../src/forge-client/module-client.ts';
import { CANDIDATE_BUNDLE, candidateBundle, createCandidateSession, handOffOf } from '../src/loop/candidate.ts';
import { candidateId, isSealed } from '../src/loop/snapshot.ts';

const wire = (dir, name) => readFileSync(new URL(`./fixtures/${dir}/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const res = (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const metaOf = (text) => JSON.parse(text.match(/^event:meta\ndata:(.*)$/m)[1]);
const CONFIG = { apiOrigin: 'http://localhost:8400', firebase: null, appCheckSiteKey: null, dev: true };
const IDENTITY = { async authorization() { return 'Bearer id-harness'; }, async appCheck() { return 'ac-harness'; } };
/** The turn the backend recorded its hand-off for (AgentWireTest's BODY). */
const R = { prompt: 'make minecraft 1870s film style', style: 'cinematic', seconds: 12 };

const AUTHOR = wire('module-wire', 'author.sse');
const REPAIR = wire('module-wire', 'repair.sse');

/** The recorded repair, answered for `request`: its job identity the request's, everything else as recorded. */
function echoed(text, request) {
    return text.replace(/^event:meta\ndata:(.*)$/m, (_, data) =>
        `event:meta\ndata:${JSON.stringify({ ...JSON.parse(data), turnId: request.turnId, jobId: request.jobId, purpose: request.purpose, subject: request.subject })}`);
}

/** The module route as recorded: an author verbatim, a repair echoing its job; every request kept. */
function moduleRoute() {
    const requests = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body });
        return res(body.purpose === 'author' ? AUTHOR : echoed(REPAIR, body));
    };
    return { requests, client: createModuleClient(createApi(CONFIG, IDENTITY, fetchImpl)) };
}

/** A fake L3, labelled so: it fails `module`'s first body on the body's line that names its stride, then passes. */
function compilerFailingOnce(module) {
    const calls = [];
    return {
        producedBy: 'fake',
        calls,
        async compile(source, label) {
            calls.push(label);
            if (calls.length > 1 || !label.startsWith(`${module}#`)) return [];
            const line = source.split('\n').findIndex(l => l.includes('let base = index * B_blocks_STRIDE;')) + 1;
            return [{ line, message: 'unresolved value: shimmer', type: 'error' }];
        },
    };
}

test('EA-E1 (the candidate loop, P6): the recorded hand-off, its module written and repaired over the recorded wire, a fake L3 failing once: static-verified and sealed', async () => {
    // The turn, as the backend recorded it, through the real client.
    const turn = await createAgentClient(createApi(CONFIG, IDENTITY, async () => res(wire('agent-wire', 'handed-off.sse')))).turn(R, () => {}, new AbortController().signal);
    assert.equal(turn.status, 'handed-off');

    const route = moduleRoute();
    const compiler = compilerFailingOnce('place');
    const states = [];
    const session = createCandidateSession({ modules: route.client, compiler, attemptId: () => 'attempt-1', now: () => 1_000 + states.length }, s => states.push(s.phase));
    const end = await session.start(handOffOf(R, turn));

    assert.equal(end.phase, 'static-verified', JSON.stringify(end.stop));
    // The author's job is the recording's own, field for field: the two repositories derive the same X and interface.
    const recorded = metaOf(AUTHOR);
    const author = route.requests[0].body;
    assert.deepEqual([author.turnId, author.jobId, author.purpose, author.subject, author.versions],
        [recorded.turnId, recorded.jobId, recorded.purpose, recorded.subject, recorded.versions]);
    assert.equal(author.module.interface.interfaceHash, recorded.interfaceHash);
    assert.deepEqual(author.request, R, 'R verbatim (P7)');
    assert.equal(route.requests[0].url, 'http://localhost:8400/v1/agent/module');

    // The module: written, failed once by the fake L3 on its own line, repaired, passed.
    const [place] = end.modules;
    assert.deepEqual([end.modules.length, place.module, place.phase, place.calls, place.repairs], [1, 'place', 'passed', 2, 1]);
    assert.equal(place.codeHash, sha(place.body));
    assert.deepEqual(end.jobs.map(j => [j.jobId, j.module, j.purpose, j.status, j.charge]), [['job-1', 'place', 'author', 'ok', 'known'], ['job-2', 'place', 'repair', 'ok', 'known']]);
    assert.deepEqual(end.jobs.map(j => j.promptVersion), ['module.author.v1', 'module.repair.v1']);
    assert.deepEqual(compiler.calls.map(l => l.split('#')[0]), ['place', 'place']);

    // The repair answered exactly what failed, about the body as judged.
    const repair = route.requests[1].body;
    const failedCompile = end.evidence.find(e => e.phase === 'compile' && e.verdict === 'fail');
    const bodyLine = repair.previous.body.split('\n').findIndex(l => l.includes('let base = index * B_blocks_STRIDE;')) + 1;
    assert.deepEqual([repair.purpose, repair.jobId, repair.subject.revision, repair.subject.codeHash], ['repair', 'job-2', 1, sha(repair.previous.body)]);
    assert.deepEqual(repair.previous.evidenceIds, [failedCompile.id]);
    assert.deepEqual(repair.previous.findings.map(f => [f.rung, f.line, f.code, f.message.split(' (')[0]]), [['L3', bodyLine, failedCompile.findings[0].code, 'unresolved value: shimmer']]);

    // Every verdict a record, the fake's labelled so; the completion references the module's current checks.
    assert.deepEqual(end.evidence.map(e => [e.phase, e.verdict, e.producedBy]), [
        ['resolve', 'pass', 'host'], ['check', 'pass', 'host'], ['interface', 'pass', 'host'],
        ['lint', 'pass', 'host'], ['compile', 'fail', 'fake'], ['lint', 'pass', 'host'], ['compile', 'pass', 'fake'],
        ['candidate', 'pass', 'host'],
    ]);
    const completion = end.evidence.at(-1);
    assert.deepEqual(completion.refs, place.evidence);
    assert.deepEqual(place.evidence, end.evidence.slice(5, 7).map(e => e.id), 'its last lint and compile');
    assert.equal(completion.subject.candidate, end.id);

    // id(C), and the sealed snapshot EA5's authority will take.
    assert.equal(end.id, await candidateId(end.graph, [['place', place.interfaceHash, place.codeHash]]));
    assert.ok(isSealed(session.snapshot) && session.snapshot.id === end.id);
    assert.deepEqual(end.verified, { id: end.id, revision: end.revision });

    // Q_C: the turn's three calls, then an author and a repair, each settled with its recorded usage.
    assert.deepEqual(end.budget.calls, { settled: 5, reserved: 0, unknown: 0 });
    assert.deepEqual([end.budget.authors, end.budget.repairs, end.budget.revisions], [1, 1, 0]);
    assert.ok(end.jobs.every(j => typeof j.costMicroUsd === 'number' && j.costMicroUsd > 0));

    // The bundle Developer view downloads: the candidate, its bodies, its evidence, each call's charge; no credential.
    const bundle = candidateBundle(end);
    assert.deepEqual([bundle.format, bundle.candidate, bundle.phase, bundle.modules[0].body], [CANDIDATE_BUNDLE, end.id, 'static-verified', place.body]);
    assert.equal(bundle.evidence.length, 8);
    assert.deepEqual(bundle.omitted, { records: 0, byPhase: {} });
    assert.deepEqual(bundle.versions.templates, ['agent.v4', 'module.author.v1', 'module.repair.v1']);
    // The hand-off's turn as recorded, each call with its charge (the EA4.5 review): with the jobs, a record for each
    // call Q_C settled.
    assert.deepEqual(bundle.calls.turns, [{
        role: 'hand-off', turnId: turn.meta.turnId, revision: 0, status: 'handed-off', model: turn.meta.model, promptVersion: 'agent.v4', charge: 'known',
        calls: ['first', 'after-tools', 'revise'].map((purpose, i) => ({ n: i + 1, purpose, charge: 'known', costMicroUsd: 46_000, generationId: `gen-${i + 1}` })), error: null,
    }]);
    assert.equal(bundle.calls.turns[0].calls.length + bundle.calls.jobs.length, end.budget.calls.settled);
    assert.ok(!/Bearer|ac-harness|id-harness/.test(JSON.stringify(bundle)), 'no credential in the bundle');
    // The phases it showed, in order.
    assert.deepEqual([...new Set(states)], ['resolving', 'authoring', 'checking', 'correcting', 'static-verified']);
});
