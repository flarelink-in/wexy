// PL-FE5 (W3.6; the creations platform companion §8, F3, F5, P6, §11): a saved world opened from the platform, over a
// fake gateway that records every request. Only the world routes are called, never a model; the byte cap and the
// SHA-256 the server names are checked before the text is parsed; a device's verdict or any evidence in the file is
// refused by the schema; a body for another interface by the seal; a line this build does not open before its text is
// even fetched. What opens is sealed here and nothing more: this device's L3 and the stage's Run (the gate, the probe,
// the first frame) still stand between it and the stage, as the studio's wiring shows. No GPU, no model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/contract/adapters/canonical.ts';
import { ForgeError } from '../src/forge-client/errors.ts';
import { WORLD_MAX_BYTES } from '../src/platform/artifact.ts';
import { openSaved } from '../src/platform/open-saved.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASTLE = readFileSync(new URL('./fixtures/worlds/castle.wexy-world.json', import.meta.url), 'utf8');
const EXPECTED = JSON.parse(readFileSync(new URL('./fixtures/worlds/expected.json', import.meta.url), 'utf8')).worlds.castle;
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** The castle's file edited as JSON and written canonical again: well-formed, its hash its own, one thing changed. */
const edited = edit => { const w = JSON.parse(CASTLE); edit(w); return canonicalJson(w); };

const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const REV = '01JC3W5F6Q7R8S9T0V1W2X3Y50';
const TIME = '2026-11-04T12:00:00.000Z';
const head = (text, extra = {}) => ({ revisionId: REV, sha256: sha(text), bytes: Buffer.byteLength(text), format: 'wexy-world.v1', line: 'ea.v1', createdAt: TIME, ...extra });
const worldDto = (text, extra = {}) => ({ worldId: WORLD, title: 'The castle on the hill', rowVersion: 3, createdAt: TIME, updatedAt: TIME, head: head(text, extra) });
const revisionDto = (text, extra = {}) => ({ worldId: WORLD, ...head(text), artifact: text, ...extra });

/** A gateway answering "METHOD path" from a map (a body, or a ForgeError to throw), recording every request. */
function gateway(routes) {
    const sent = [];
    return {
        sent,
        async send(req) {
            sent.push(`${req.method} ${req.path}`);
            const next = routes[`${req.method} ${req.path}`];
            if (next instanceof Error) throw next;
            if (next === undefined) throw new ForgeError('not-found', 404, 'No such route.');
            return new Response(JSON.stringify(next), { status: 200 });
        },
    };
}
/** The two routes a reopen reads, the world's head and its revision, answering `world` and `revision`. */
const routes = (world, revision) => ({ [`GET /v1/worlds/${WORLD}`]: world, [`GET /v1/worlds/${WORLD}/revisions/${REV}`]: revision });
/** Every request a reopen made went to a world route: none to a model's (F5). */
const onlyWorldRoutes = sent => {
    assert.ok(sent.length > 0);
    for (const r of sent) assert.match(r, /^GET \/v1\/worlds\//, r);
    assert.ok(!sent.some(r => /\/v1\/(forge|agent)\//.test(r)), 'no model route');
};

test('PL-FE5 the castle opens from the platform as it was saved: its head read, its bytes checked, sealed here, and only world routes called', async () => {
    const api = gateway(routes(worldDto(CASTLE), revisionDto(CASTLE)));
    const opened = await openSaved(api, WORLD);
    assert.equal(opened.ok, true, opened.reason);
    const w = opened.world;
    assert.deepEqual([w.worldId, w.title, w.revisionId, w.rowVersion], [WORLD, 'The castle on the hill', REV, 3], 'the server\'s title and head, the save binding\'s');
    assert.deepEqual([w.snapshot.x.hash, w.snapshot.id], [EXPECTED.x, EXPECTED.candidate], 'sealed by this host to the corpus\' recorded X and id(C)');
    assert.equal(w.provenance.same, true);
    assert.deepEqual(w.design, JSON.parse(CASTLE).design);
    assert.deepEqual(api.sent, [`GET /v1/worlds/${WORLD}`, `GET /v1/worlds/${WORLD}/revisions/${REV}`]);
    onlyWorldRoutes(api.sent);
    // Sealed, never compiled or admitted: what opens carries no device verdict; L3 and the Run are the studio's (below).
    assert.ok(!('compiled' in w) && !('verdicts' in w.snapshot), 'no device verdict comes from a file or a server');
});

test('PL-FE5 the byte cap and the server\'s SHA-256 are checked before the text is parsed', async () => {
    // Past the cap, and not even JSON: refused for its size, so no parse was tried.
    const big = 'x'.repeat(WORLD_MAX_BYTES + 1);
    const tooBig = await openSaved(gateway(routes(worldDto(big), revisionDto(big))), WORLD);
    assert.deepEqual([tooBig.ok, tooBig.code], [false, 'too-large']);
    // Not JSON, and not the bytes the server's hash names: refused as corrupt, not as unreadable.
    const junk = '{not json';
    const tampered = await openSaved(gateway(routes(worldDto(CASTLE), revisionDto(junk, { sha256: sha(CASTLE) }))), WORLD);
    assert.deepEqual([tampered.ok, tampered.code], [false, 'corrupt']);
    assert.match(tampered.reason, /^PL_UNAVAILABLE /, 'a hash mismatch is the platform\'s, said as unavailable (the companion §12)');
    // A byte changed in transit: the same.
    const flipped = CASTLE.replace('"kind":"agent"', '"kind":"agenT"');
    const changed = await openSaved(gateway(routes(worldDto(CASTLE), revisionDto(flipped, { sha256: sha(CASTLE) }))), WORLD);
    assert.deepEqual([changed.ok, changed.code], [false, 'corrupt']);
    // Two answers that disagree on the bytes (the head moved between them): nothing is trusted yet.
    const moved = await openSaved(gateway(routes(worldDto(CASTLE), revisionDto(CASTLE, { sha256: 'b'.repeat(64) }))), WORLD);
    assert.deepEqual([moved.ok, moved.code], [false, 'unavailable']);
    // A revision that is not the head asked for, nor of this world: the same.
    for (const other of [{ revisionId: '01JC3W5F6Q7R8S9T0V1W2X3Y51' }, { worldId: '01JC3W5F6Q7R8S9T0V1W2X3Y4Y' }]) {
        const wrong = await openSaved(gateway(routes(worldDto(CASTLE), revisionDto(CASTLE, other))), WORLD);
        assert.deepEqual([wrong.ok, wrong.code], [false, 'unavailable'], JSON.stringify(other));
    }
});

test('PL-FE5 a device\'s verdict or any evidence in the file is refused by the schema; a body for another interface by the seal', async () => {
    const forged = [
        edited(w => { w.producedBy = 'device'; }),
        edited(w => { w.modules[0].producedBy = 'device'; }),
        edited(w => { w.modules[0].verdict = { ok: true, producedBy: 'device', gpu: 'any' }; }),
        edited(w => { w.evidence = { probe: { initMs: 0 } }; }),
    ];
    for (const text of forged) {
        const opened = await openSaved(gateway(routes(worldDto(text), revisionDto(text))), WORLD);
        assert.deepEqual([opened.ok, opened.code], [false, 'unreadable'], text.slice(0, 60));
        assert.match(opened.reason, /^PL_INCOMPATIBLE /);
    }
    // Well-formed and its hash its own, but its first body claims another interface: the host's seal refuses it.
    const other = edited(w => { w.modules[0].interfaceHash = 'c'.repeat(64); });
    const unsealed = await openSaved(gateway(routes(worldDto(other), revisionDto(other))), WORLD);
    assert.deepEqual([unsealed.ok, unsealed.code], [false, 'unsealed']);
    assert.match(unsealed.reason, /^PL_UNSEALED /);
});

test('PL-FE5 a line this build does not open stops before its text is fetched; a world gone or another\'s, or no answer, opens nothing', async () => {
    // A later line (a world saved by a newer studio): well formed, not one this build lists in OPENS_LINES.
    const api = gateway(routes(worldDto(CASTLE, { line: 'ea.v2' }), revisionDto(CASTLE)));
    const old = await openSaved(api, WORLD);
    assert.deepEqual([old.ok, old.code], [false, 'incompatible']);
    assert.match(old.reason, /^PL_INCOMPATIBLE .*line ea\.v2 not in OPENS_LINES \(ea\.v1\)/);
    assert.deepEqual(api.sent, [`GET /v1/worlds/${WORLD}`], 'its text is never fetched, so nothing of it is parsed or sealed');
    const gone = await openSaved(gateway({}), WORLD);
    assert.deepEqual([gone.ok, gone.code], [false, 'missing']);
    const down = await openSaved(gateway({ [`GET /v1/worlds/${WORLD}`]: new ForgeError('unavailable', 503, 'B2 is not configured') }), WORLD);
    assert.deepEqual([down.ok, down.code], [false, 'unavailable']);
    const revisionGone = await openSaved(gateway({ [`GET /v1/worlds/${WORLD}`]: worldDto(CASTLE) }), WORLD);
    assert.deepEqual([revisionGone.ok, revisionGone.code], [false, 'missing']);
    // An id that is not a ULID never reaches a path.
    const odd = gateway({});
    assert.deepEqual((await openSaved(odd, '../me')).code, 'missing');
    assert.deepEqual(odd.sent, []);
});

test('PL-FE5 the studio opens a saved world only through L3 on this device and the stage\'s Run, its Show it the go', () => {
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    const method = signature => {
        const at = main.indexOf(signature);
        assert.ok(at >= 0, `main.ts has ${signature}`);
        return main.slice(at, main.indexOf('\n    }\n', at));
    };
    // The opening is saved-opening.ts's (its behaviour: test/saved-opening.test.mjs); main.ts hands it the steps.
    const open = method('private async openFromUrl(');
    assert.match(open, /new SavedOpening\(worldId, \{/);
    // Read as the epoch's caller (the module binds the api it hands over), checked and sealed by open-saved.ts.
    assert.match(open, /open: async \(bound, id\) => \(await import\('\.\.\/\.\.\/platform\/open-saved'\)\)\.openSaved\(bound, id\),/);
    // Every body compiled here, any refusal an end.
    assert.match(open, /const compiled = await compileSaved\(world\.snapshot, compiler\);/);
    assert.match(open, /const refused = compiled\.filter\(c => !c\.ok\)\.map\(c => c\.module\);\s*return refused\.length \? \{ problem: /);
    assert.match(open, /if \(!compiler\) return \{ problem: 'no device compiler here' \};/);
    // Show it: the stage's own Run, which admits, builds, probes and draws the first frame before any switch, under the
    // epoch the world was read in; and a Run waits for every other holder of the stage.
    assert.match(open, /blocked: \(\) => this\.runBlocked\(\) !== null,/);
    assert.match(open, /await this\.runCandidate\(ready\.world\.snapshot, ready\.compiled, \{ kind: 'reopened', world: ready\.world, ranAs: readAs \}, signal\);/);
    assert.match(method('private async showOpened('), /await this\.opening\?\.show\(\);/);
    assert.match(method('private async runCandidate('), /const r = await stage\.run\(snapshot, compiled, signal\);/);
    // And it is a press: the card's button, a double click one press; a world on the stage ends the opening.
    assert.match(method('private renderOpening('), /show\.addEventListener\('click', e => \{ if \(e\.detail <= 1\) void this\.showOpened\(\); \}\);/);
    assert.match(method('private endOpening('), /this\.opening\.end\(\);\s*this\.opening = null;/);
    // The module itself runs nothing while it opens: only its Show it calls the Run.
    const module = readFileSync(join(ROOT, 'src/shell/studio/saved-opening.ts'), 'utf8');
    const start = module.slice(module.indexOf('async start()'), module.indexOf('async show()'));
    assert.doesNotMatch(start, /ports\.run\(|runCandidate|setRuntime/, 'opening runs nothing: the creator\'s Show it does');
});

test('W3.6 the studio saves what its Run installed, by where it came from: a creation\'s world, a reopened one as saved, a replay none; another kind of world clears the line', () => {
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    const method = signature => {
        const at = main.indexOf(signature);
        assert.ok(at >= 0, `main.ts has ${signature}`);
        return main.slice(at, main.indexOf('\n    }\n', at));
    };
    const save = method('private saveInstalled(');
    const creation = save.slice(save.indexOf("if (origin.kind === 'creation')"), save.indexOf("} else if (origin.kind === 'reopened')"));
    const reopened = save.slice(save.indexOf("} else if (origin.kind === 'reopened')"), save.lastIndexOf('} else {'));
    const replay = save.slice(save.lastIndexOf('} else {'));
    assert.match(creation, /source: 'live', snapshot, design: about\.design, view: this\.viewport\?\.currentView\(\) \?\? null,/, 'S and the camera as it is at the install (F8)');
    assert.match(creation, /improves: about\.revises \? saves\.state\(\)\?\.stage \?\? null : null,/, 'a revision of the creation\'s world on the stage, under the install the controller knows it by');
    assert.match(reopened, /source: 'reopened'[\s\S]*ranAs: origin\.ranAs,\s*saved: \{ worldId: o\.worldId, revisionId: o\.revisionId, rowVersion: o\.rowVersion \}/,
        'its saved head, so it is not saved again, for its owner, the caller it was read as (Q129)');
    assert.match(replay, /source: 'archive'/);
    // Every Run that installs hands its world over, after the switch, by its origin.
    assert.match(method('private async runCandidate('), /this\.afterSwitch\('its save', \(\) => this\.saveInstalled\(snapshot, origin\)\);/);
    // The creation's go is the creation's; the replay panel's a replay's.
    assert.match(main, /go: \(snapshot, compiled, about\) => this\.runCandidate\(snapshot, compiled, about \? \{ kind: 'creation', about, ranAs: this\.callerUid\(\) \} : \{ kind: 'replay' \}\),/);
    assert.match(main, /go: \(snapshot, compiled\) => this\.runCandidate\(snapshot, compiled, \{ kind: 'replay' \}\)/);
    // h1's world, the backdrop or nothing: the line goes, and the save of the world before says nothing more.
    assert.match(method('private put('), /if \(next\.kind !== 'agent'\) this\.afterSwitch\('the save line', \(\) => \{ this\.saves\?\.cleared\(\); this\.saveView\?\.render\(null\); \}\);/);
    // The account's word reaches the saves once each change: its epoch, or its account's standing.
    const mount = method('private async mountSaves(');
    assert.match(mount, /if \(now === heard\) return;\s*heard = now;\s*this\.saves\?\.accountChanged\(\);/);
    assert.match(mount, /session\.subscribe\(moved\);\s*control\.onAccount = moved;/);
});

test('W3-review the studio binds what it saves and opens to the account: its caller, the owner of a Run, and a reopened Run that stops on a switch', () => {
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    const method = signature => {
        const at = main.indexOf(signature);
        assert.ok(at >= 0, `main.ts has ${signature}`);
        return main.slice(at, main.indexOf('\n    }\n', at));
    };
    // The saves' facts carry the session's caller, so every save goes out bound to it (the review's high).
    assert.match(method('private async mountSaves('), /caller: session\.caller\(\),/);
    // A creation's world is owned by the caller its Show it was pressed as (the second review's high).
    assert.match(method('private callerUid('), /return this\.accountSession\?\.caller\(\)\?\.uid \?\? null;/);
    const save = method('private saveInstalled(');
    assert.match(save, /ranAs: origin\.ranAs,/);
    // A reopened world keeps its camera for a later Save (the second review's low).
    assert.match(save, /source: 'reopened', snapshot, design: o\.design, view: this\.viewport\?\.currentView\(\) \?\? null,/);
    // The opening's Run takes the opening's signal, and the stage gets it (the second review's low).
    assert.match(method('private async openFromUrl('), /run: async \(ready, readAs, signal\) => \{\s*const summary = await this\.runCandidate\(ready\.world\.snapshot, ready\.compiled, \{ kind: 'reopened', world: ready\.world, ranAs: readAs \}, signal\);/);
    assert.match(method('private async runCandidate('), /const r = await stage\.run\(snapshot, compiled, signal\);/);
});

test('2026-11-04 Developer view\'s probe line names each kind\'s cap, not one budget of 250 ms', () => {
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    assert.match(main, /parts\.push\(`caps: init \$\{p\.caps\.init\}, step \$\{p\.caps\.step\}, frame \$\{p\.caps\.frame\}, first frame \$\{p\.caps\.firstFrame\} ms`\);/);
    assert.doesNotMatch(main, /budgetMs \?\? 250/);
});

test('account-guards review: Show it first says why when the stage is held, and Try again reads an account not read yet before it saves', () => {
    const main = readFileSync(join(ROOT, 'src/shell/studio/main.ts'), 'utf8');
    // L3: the confirmation's Show it first is the creator's Show it; when it cannot start, it is said, not lost.
    assert.match(main, /control\.showUnshown = \(\) => \{\s*if \(this\.creation\?\.showBlocked\(\)\) this\.showToast\(COPY\.account\.showFirstLater, null\);\s*else void this\.creation\?\.show\(\);\s*\};/);
    // L4: "Not saved" for an account not read yet: Try again reads it (its read saves the waiting world); else the request again.
    assert.match(main, /retry: \(\) => \{\s*if \(session\.current\.kind === 'google' && control\.saveKind === 'unknown'\) void control\.afterEntry\(\);\s*else void this\.saves\?\.retry\(\);\s*\},/);
});

test('W3-review /creations: every call of the page goes out bound to its epoch\'s caller, and a world that cannot be read is not taken as gone', () => {
    const page = readFileSync(join(ROOT, 'src/shell/creations/main.ts'), 'utf8');
    assert.match(page, /const own = boundTo\(api, \{ uid: caller\.uid, still: \(\) => mine\(\) && caller\.still\(\) \}\);/);
    // Every platform call names `own`; `api` itself is handed only to the binding.
    for (const call of ['readAccount(own)', 'bootstrapAccount(own)', 'listWorlds(own)', 'readUsage(own)', 'renameWorld(own, world, title)',
        'deleteWorld(own, world, crypto.randomUUID())', 'readWorld(own, world.worldId)', 'listWorlds(own, { cursor })', 'readUsage(own).then(']) {
        assert.ok(page.includes(call), call);
    }
    const uses = [...page.matchAll(/\bapi\b/g)].length;
    const allowed = [...page.matchAll(/const api = createApi\(config, identity\);|boundTo\(api,/g)].length;
    assert.equal(uses, allowed, '`api` appears only where it is made and where it is bound');
    // The reread's three answers reach the view as they are (W3's review, its low).
    assert.match(page, /reread: world => readWorld\(own, world\.worldId\),/);
});
