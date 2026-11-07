// KR-U3's child (render-kernels-design.md §10; test/kernels.test.mjs): what each world of ea.v1's corpus is under this
// checkout's code, printed as one JSON line on stdout: its X hash and id(C), the bundle hash eligibility looks it up
// under and whether the shipped eligibility covers it, or why it was refused; the line a new world is written on and
// the lines opened; and the wire's side (the bundle a turn names, the manifest's text and its pin, the action schema's
// text and its version, h1's rules). Run with `--import ./test/register.mjs`. test/kernels.test.mjs runs it once as checked out and once for
// each edit of a file the model reads (WEXY_RAW_OVERRIDES), and holds the worlds' half to the first run. No GPU.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { ADAPTER_MANIFEST_HASH, ADAPTER_MANIFEST_TEXT } from '../src/contract/adapters/index.ts';
import { AGENT_ACTION_TEXT, AGENT_ACTION_VERSION } from '../src/contract/agent/index.ts';
import { H1 } from '../src/contract/h1/index.ts';
import { EXECUTOR_PROFILE, SHIPPED, eligibilityOf } from '../src/exec/eligibility.ts';
import { ENGINE_BUNDLE_HASH } from '../src/forge-client/agent-client.ts';
import { sealSaved } from '../src/loop/replay.ts';
import { parseWorld } from '../src/platform/artifact.ts';
import { OPENS_LINES, WORLD_LINE } from '../src/platform/lines.ts';
import { openWorld } from '../src/platform/reopen.ts';

const ROOT = new URL('../', import.meta.url);
const text = path => readFileSync(new URL(path, ROOT), 'utf8');
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const json = dir => readdirSync(new URL(dir, ROOT)).filter(f => f.endsWith('.json')).sort().map(f => [`${dir}${f}`, f.replace(/\.json$/, '')]);

if (!SHIPPED.ok) throw new Error(`kernel-probe: the shipped eligibility does not parse: ${SHIPPED.reason}`);
/** A recorded environment of the shipped eligibility (EA-G1's AMD iGPU), at a size its runs covered. */
const ENVIRONMENT = { key: SHIPPED.entries.map(e => e.environment).find(k => k.includes('|amd|')) };
const PIXELS = 1280 * 720;

/** What a sealed world is, as the shell sees it: its X, id(C), eligibility's key and verdict. */
const what = snapshot => ({
    x: snapshot.x.hash,
    candidate: snapshot.id,
    eligibilityKey: snapshot.x.identity.bundleHash,
    eligibility: eligibilityOf(snapshot.x, SHIPPED.entries, { environment: ENVIRONMENT, engineBundleHash: snapshot.x.identity.bundleHash, profile: EXECUTOR_PROFILE, pixels: PIXELS }),
    refused: null,
});
const refusal = reason => ({ x: null, candidate: null, eligibilityKey: null, eligibility: null, refused: reason });

const worlds = {};
// The saved-world corpus (W3): the file's own checks, then the seal.
for (const [path] of json('test/fixtures/worlds/').filter(([p]) => p.endsWith('.wexy-world.json'))) {
    const name = path.slice(path.lastIndexOf('/') + 1, -'.wexy-world.json'.length);
    const parsed = await parseWorld(text(path), null);
    if (!parsed.ok) { worlds[`world:${name}`] = refusal(parsed.reason); continue; }
    const opened = await openWorld(parsed.world, `corpus:${name}`);
    worlds[`world:${name}`] = opened.ok ? what(opened.snapshot) : refusal(opened.reason);
}
// The saved attempts a build opens by the replay's path: the castle replay, the starters, the live candidates and the
// coverage worlds (render-kernels §7's C_ea.v1, with the replay beside it).
for (const [path, name] of [['dev/replays/castle.json', 'castle'], ...json('public/worlds/'), ...json('test/fixtures/live-candidates/'), ...json('test/fixtures/coverage-worlds/')]) {
    const kind = path.startsWith('dev/') ? 'replay' : path.startsWith('public/') ? 'starter' : path.includes('live-') ? 'live' : 'coverage';
    const sealed = await sealSaved(text(path));
    worlds[`${kind}:${name}`] = sealed.ok ? what(sealed.replay.snapshot) : refusal(sealed.reason);
}

process.stdout.write(`${JSON.stringify({
    worlds,
    lines: { writes: WORLD_LINE, opens: [...OPENS_LINES] },
    wire: {
        bundle: ENGINE_BUNDLE_HASH, manifestText: sha(ADAPTER_MANIFEST_TEXT), manifestPin: ADAPTER_MANIFEST_HASH, actionSchemaText: sha(AGENT_ACTION_TEXT),
        actionSchema: AGENT_ACTION_VERSION, h1Rules: sha(H1.rules),
    },
})}\n`);
