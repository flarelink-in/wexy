// The paper test's check (the engine-aware design §13): reads the backend's paper report (its JSON, or the host's
// log with the report between its markers), refuses one built from another engine bundle, checks every answer
// against the bundle (dev/paper-lib.mjs) and prints a table, the findings and the verdict: every answer fits the
// schema, and names only what null-graph exports (the design's automatic criteria; whether each plan could be built
// by hand from its text is a person's call). Writes dev/out/paper-check/<report>.json, and a .md digest of each
// plan for that reading. No network, no GPU.
//   node --import ./test/register.mjs dev/paper-check.mjs <paper.log | paper-<time>.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE } from '../src/contract/engine/index.ts';
import { checkAnswer, nameCount, parseAction, readReport } from './paper-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
    console.error('usage: node --import ./test/register.mjs dev/paper-check.mjs <paper.log | paper-<time>.json>');
    process.exit(2);
}
const report = readReport(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
if (report.bundle?.bundleHash !== ENGINE.bundle.bundleHash) {
    console.error(`paper-check: the report quotes bundle ${report.bundle?.bundleHash ?? 'none'}, this checkout has ${ENGINE.bundle.bundleHash}: `
        + 'check it against the bundle it was built from');
    process.exit(2);
}

const cents = micro => (micro == null ? '?' : `${(micro / 10_000).toFixed(2)}¢`);
const AUTOMATIC = new Set(['name', 'member']);
const rows = report.answers.map(a => {
    const call = a.notStrict ?? a.strict;
    const action = parseAction(call.text);
    const findings = action ? checkAnswer(action) : [];
    const names = action ? nameCount(action) : { total: 0, distinct: 0 };
    const fails = findings.filter(f => f.level === 'fail');
    return {
        id: a.id, request: a.request, kind: a.kind, action, findings, names,
        strict: a.notStrict ? 'refused; not strict' : a.strict.ok ? 'yes' : 'failed',
        schema: a.schemaProblems.length ? `${a.schemaProblems.length} problems` : a.kind ? 'ok' : 'no answer',
        schemaProblems: a.schemaProblems,
        invented: fails.filter(f => AUTOMATIC.has(f.code)).length,
        faults: fails.filter(f => !AUTOMATIC.has(f.code)).length,
        warnings: findings.filter(f => f.level === 'warn').length,
        tokens: `${call.promptTokens ?? '?'} (${call.cachedTokens ?? 0} cached) / ${call.completionTokens ?? '?'} (${call.reasoningTokens ?? '?'} reasoning)`,
        cost: cents(call.costMicroUsd), ms: call.totalMs, finish: call.finishReason,
        pass: Boolean(a.kind) && a.schemaProblems.length === 0 && fails.every(f => !AUTOMATIC.has(f.code)),
    };
});
const pass = rows.length > 0 && rows.every(r => r.pass);
const spent = report.answers.flatMap(a => [a.strict, a.notStrict].filter(Boolean)).reduce((n, c) => n + (c.costMicroUsd ?? 0), 0);

const pad = (s, n) => String(s).padEnd(n);
const lines = [
    `paper test: ${report.model}, null-graph ${report.bundle.engineVersion} (bundle ${report.bundle.bundleHash.slice(0, 12)}, documents ${report.bundle.docsSource}), ${report.startedAt}`,
    `templates: ${report.template}; ${report.answers.length} requests, ${cents(spent)} at the listed prices`,
    '',
    `${pad('request', 12)}${pad('kind', 28)}${pad('strict', 20)}${pad('schema', 13)}${pad('names', 9)}${pad('invented', 10)}${pad('faults', 8)}${pad('warnings', 10)}${pad('tokens in / out', 47)}${pad('cost', 8)}time`,
    ...rows.map(r => `${pad(r.id, 12)}${pad(r.kind ?? '-', 28)}${pad(r.strict, 20)}${pad(r.schema, 13)}${pad(`${r.names.total}/${r.names.distinct}`, 9)}${pad(r.invented, 10)}${pad(r.faults, 8)}${pad(r.warnings, 10)}${pad(r.tokens, 47)}${pad(r.cost, 8)}${(r.ms / 1000).toFixed(1)} s`),
    '',
    pass ? 'verdict: PASS on the automatic criteria: every answer fits paper-action.v1 and names only what null-graph exports. Read the plans (the .md) for the third: could each be built by hand from its text?'
        : 'verdict: FAIL on the automatic criteria: see the schema problems and the invented names below.',
];
for (const r of rows) {
    if (!r.findings.length && !r.schemaProblems.length) continue;
    lines.push('', `${r.id}:`);
    for (const p of r.schemaProblems) lines.push(`  schema  ${p}`);
    for (const f of r.findings) lines.push(`  ${f.level}    ${f.code}: ${f.message}`);
}
console.log(lines.join('\n'));

/** One plan, digested for a person: what it means to show, and how it would build it. */
const digest = r => {
    const a = r.action;
    if (!a) return [`## ${r.id}: no plan`, '', `"${r.request}"`, '', ...r.schemaProblems.map(p => `- ${p}`)];
    const d = a.design ?? {};
    const p = a.program ?? {};
    return [
        `## ${r.id}: ${r.kind}`, '', `Request: "${r.request}"`, '',
        `**Intent.** ${d.intent ?? '-'}`, d.interpretation ? `**Interpretation.** ${d.interpretation}` : null, `**Motion.** ${d.motion ?? '-'}`,
        `**Camera and timing.** ${d.cameraAndTiming ?? '-'}`, '',
        '**Techniques**', ...(d.techniques ?? []).map(t => `- ${t.purpose}: ${(t.symbols ?? []).join(', ')} (${(t.docIds ?? []).join(', ')})`), '',
        '**Unresolved**', ...((d.unresolved ?? []).length ? d.unresolved.map(u => `- ${u}`) : ['- none']), '',
        '**Success criteria**', ...(d.successCriteria ?? []).map(s => `- ${s}`), '',
        '**Objects**', ...(p.objects ?? []).map(o => `- \`${o.id}\`: ${o.symbol}${o.member ? `.${o.member}` : ''}: ${o.purpose}; config \`${o.config}\`; inputs ${(o.inputs ?? []).join(', ') || 'none'}`), '',
        '**Resources**', ...((p.resources ?? []).length ? p.resources.map(x => `- \`${x.id}\` ${x.kind}${x.strideFloats ? `, ${x.strideFloats} floats` : ''}${x.count ? ` × ${x.count}` : ''}: ${x.purpose} (${x.layout})`) : ['- none']), '',
        '**Modules**', ...((p.modules ?? []).length ? p.modules.map(m => `- \`${m.id}\` ${m.stage}, run by \`${m.usedBy}\`: \`${m.signature}\`; bindings ${(m.bindings ?? []).map(b => `${b.group}.${b.binding} ${b.resource}`).join(', ') || 'none'}: ${m.purpose}`) : ['- none']), '',
        '**Schedule**', ...(p.schedule ?? []).map((s, i) => `${i + 1}. ${s.when} ${s.kind} \`${s.objectId}\`${s.required ? '' : ' (optional)'}: reads ${(s.reads ?? []).join(', ') || 'nothing'}; writes ${(s.writes ?? []).join(', ') || 'nothing'}`), '',
        '**Controls**', ...((p.controls ?? []).length ? p.controls.map(c => `- \`${c.id}\` ${c.type} on ${c.target}, ${c.min ?? '?'} to ${c.max ?? '?'}, default ${c.default}`) : ['- none']), '',
        '**Findings**', ...(r.findings.length ? r.findings.map(f => `- ${f.level} ${f.code}: ${f.message}`) : ['- none']),
    ].filter(l => l !== null);
};
const outDir = join(ROOT, 'dev', 'out', 'paper-check');
mkdirSync(outDir, { recursive: true });
const name = basename(file).replace(/\.(json|log|txt)$/, '');
writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify({ report: { startedAt: report.startedAt, model: report.model, bundle: report.bundle }, pass, rows: rows.map(({ action, ...r }) => r) }, null, 1)}\n`);
writeFileSync(join(outDir, `${name}.md`), `${[`# Paper test, ${report.startedAt}`, '', ...lines.slice(0, rows.length + 6).map(l => `    ${l}`), '', ...rows.flatMap(r => [...digest(r), ''])].join('\n')}\n`);
console.log(`\nwritten: dev/out/paper-check/${name}.json and .md (each plan digested for reading)`);
process.exit(pass ? 0 : 1);
