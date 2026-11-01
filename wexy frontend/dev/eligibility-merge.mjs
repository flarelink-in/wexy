// Ships EA-G1's eligibility (executor-design.md §7): the entries dev/ea-g1.mjs wrote for each GPU, each file parsed by the
// gate's own strict reader first, merged into src/exec/eligibility.json. Never by hand: an entry is only what a clean run
// on that exact environment wrote. Review each run's result (its <gpu>.json: problems, predictions against what ran)
// before shipping its entries.
//   node --import ./test/register.mjs dev/eligibility-merge.mjs dev/out/ea-g1/<time>/amd.eligibility.json [more.json …]
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ELIGIBILITY_FORMAT, parseEligibility } from '../src/exec/eligibility.ts';

const files = process.argv.slice(2);
if (!files.length) {
    console.error('eligibility-merge: name the <gpu>.eligibility.json files EA-G1 wrote.');
    process.exit(2);
}
const entries = [];
for (const f of files) {
    const parsed = parseEligibility(readFileSync(resolve(f), 'utf8'));
    if (!parsed.ok) {
        console.error(`eligibility-merge: ${f}: ${parsed.reason}`);
        process.exit(1);
    }
    // Each entry names its run's result too (§5: "the result's path"), the <gpu>.json beside the file it came in.
    const result = relative(resolve('.'), resolve(f).replace(/\.eligibility\.json$/, '.json')).split('\\').join('/');
    for (const e of parsed.entries) {
        if (!e.evidence.includes(result)) e.evidence = `${e.evidence}; ${result}`;
        const twin = entries.find(x => x.adapter === e.adapter && x.adapterVersion === e.adapterVersion && x.environment === e.environment
            && x.engineBundleHash === e.engineBundleHash && x.executorProfile === e.executorProfile);
        if (twin) {
            console.error(`eligibility-merge: ${e.adapter}@${e.adapterVersion} on ${e.environment} twice: one run for each environment`);
            process.exit(1);
        }
        entries.push(e);
    }
    console.log(`${f}: ${parsed.entries.length} entries (${[...new Set(parsed.entries.map(e => e.environment))].join(', ')})`);
}
const out = {
    format: ELIGIBILITY_FORMAT,
    note: 'Which adapters may execute, where, and within what (executor-design.md §7, Q88). Written from EA-G1\'s results by dev/eligibility-merge.mjs, never by hand from memory: each entry names its run.',
    entries,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
if (!parseEligibility(text).ok) {
    console.error('eligibility-merge: the merged file does not parse');
    process.exit(1);
}
writeFileSync(resolve('src/exec/eligibility.json'), text);
console.log(`src/exec/eligibility.json: ${entries.length} entries`);
