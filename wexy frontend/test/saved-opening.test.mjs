// W3's review, its mid (the creations platform companion §8, F4): a saved world opened by its id stayed runnable after the
// account changed: its readiness was set, and its Show it ran, with no look at who was signed in since the read. Here the
// opening (src/shell/studio/saved-opening.ts) over fake ports: the account changes before the read answers, during L3,
// after Show it is offered, and during the Run, and each time nothing more of that world is offered or run; its reads go
// out bound to the epoch's caller. And the path itself: sign in first, read, compile, Show it, the Run. No GPU, no model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COPY } from '../src/loop/copy.ts';
import { SavedOpening } from '../src/shell/studio/saved-opening.ts';

const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const opened = { ok: true, world: { worldId: WORLD, title: 'The castle', revisionId: '01JC3W5F6Q7R8S9T0V1W2X3Y50', rowVersion: 3,
    snapshot: { id: 'c'.repeat(64) }, design: {}, view: null, provenance: { graph: 'g', candidate: 'c', same: true } } };
const compiled = [{ module: 'm', ok: true }];

/** A session as the opening reads it: Google under epoch 1 unless told otherwise; `move(kind)` is an account change. */
function fakeSession(kind = 'google') {
    const listeners = new Set();
    const s = {
        current: { epoch: 1, kind },
        uid: 'uid-1',
        refresh: async () => s.current,
        subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
        caller() {
            if (s.current.kind !== 'google') return null;
            const { epoch } = s.current;
            return { uid: s.uid, still: () => s.current.epoch === epoch };
        },
        move(next = 'google') {
            s.current = { epoch: s.current.epoch + 1, kind: next };
            s.uid = `uid-${s.current.epoch}`;
            for (const l of [...listeners]) l();
        },
    };
    return s;
}

/** A deferred value: `promise`, settled when `resolve` is called. */
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

/** The opening over fake ports; each step's answer can be held (a deferred) so a test can move the account meanwhile. */
function harness({ session = fakeSession(), open = async () => opened, compile = async () => ({ compiled }), run = async () => 'installed', blocked = () => false } = {}) {
    const record = [];
    const runs = [];
    const reads = [];
    let changes = 0;
    const base = { send: async req => { reads.push(req); return new Response('{}'); } };
    const opening = new SavedOpening(WORLD, {
        api: base, session,
        open: async (api, id) => { await api.send({ method: 'GET', path: `/v1/worlds/${id}`, auth: true }); return open(); },
        compile, blocked,
        run: async (ready, epoch, signal) => { runs.push({ title: ready.world.title, epoch, signal }); return run(signal); },
        changed: () => { changes++; },
        record: (ok, text) => record.push([ok, text]),
    });
    return { opening, session, record, runs, reads, changes: () => changes };
}

test('W3-review mid: the path: signed in, read as the epoch\'s caller, compiled here, Show it offered, then the Run under that epoch', async () => {
    const h = harness();
    await h.opening.start();
    assert.deepEqual(h.opening.view(), { worldId: WORLD, sentence: COPY.open.ready('The castle'), offer: null, ready: true, running: false });
    assert.equal(h.reads.length, 1);
    assert.equal(h.reads[0].caller.uid, 'uid-1', 'its read is bound to the caller of the epoch it was read under');
    assert.equal(h.reads[0].caller.still(), true);
    assert.deepEqual(h.record.map(r => r[0]), [true]);
    await h.opening.show();
    assert.deepEqual(h.runs.map(r => [r.title, r.epoch, r.signal.aborted]), [['The castle', 1, false]]);
});

test('W3-review mid: no Google session: Sign in is offered, nothing read; once signed in, it opens', async () => {
    const session = fakeSession('anonymous');
    const h = harness({ session });
    const started = h.opening.start();
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual([h.opening.view().sentence, h.opening.view().offer, h.reads.length], [COPY.open.signIn, 'sign-in', 0]);
    session.move('google');
    await started;
    assert.equal(h.opening.view().ready, true);
    assert.equal(h.reads[0].caller.uid, 'uid-2', 'read as the caller who signed in');
});

test('W3-review mid: the account changes before the read answers: nothing of that world is compiled or offered', async () => {
    const read = deferred();
    let compiles = 0;
    const h = harness({ open: () => read.promise, compile: async () => { compiles++; return { compiled }; } });
    const started = h.opening.start();
    await new Promise(r => setTimeout(r, 5));
    h.session.move('google');
    read.resolve(opened);
    await started;
    assert.deepEqual([h.opening.view().sentence, h.opening.view().offer, h.opening.view().ready], [COPY.open.accountChanged, 'your-worlds', false]);
    assert.equal(compiles, 0);
    assert.equal(h.reads[0].caller.still(), false, 'and its read, had it been retried, would not have gone out as the new account');
});

test('W3-review mid: the account changes during L3: never ready, never run', async () => {
    const l3 = deferred();
    const h = harness({ compile: () => l3.promise });
    const started = h.opening.start();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.opening.view().sentence, COPY.open.checking);
    h.session.move('none');
    l3.resolve({ compiled });
    await started;
    assert.deepEqual([h.opening.view().sentence, h.opening.view().ready], [COPY.open.accountChanged, false]);
    await h.opening.show();
    assert.equal(h.runs.length, 0);
});

test('W3-review mid: the account changes once Show it is offered: it is taken away at once, and a press runs nothing', async () => {
    const h = harness();
    await h.opening.start();
    assert.equal(h.opening.view().ready, true);
    const before = h.changes();
    h.session.move('google');
    assert.deepEqual([h.opening.view().sentence, h.opening.view().offer, h.opening.view().ready], [COPY.open.accountChanged, 'your-worlds', false]);
    assert.ok(h.changes() > before, 'the card is told at once');
    await h.opening.show();
    assert.equal(h.runs.length, 0);
});

test('W3-review mid: Show it checks the epoch itself, even unheard: a session that moved without telling runs nothing', async () => {
    const h = harness();
    await h.opening.start();
    // The epoch moves without the listener: Show it must still look.
    h.session.current = { epoch: 9, kind: 'google' };
    await h.opening.show();
    assert.equal(h.runs.length, 0);
    assert.equal(h.opening.view().sentence, COPY.open.accountChanged);
});

test('W3-review mid: the account changes during the Run: the Run is stopped (its signal aborts), and the card does not offer it again', async () => {
    const running = deferred();
    const h = harness({ run: signal => { signal.addEventListener('abort', () => running.resolve('stopped')); return running.promise; } });
    await h.opening.start();
    const shown = h.opening.show();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(h.opening.view().running, true);
    assert.equal(h.runs[0].signal.aborted, false);
    h.session.move('google');
    assert.equal(h.runs[0].signal.aborted, true, "the second review of W3: a Run of A's world under way is stopped, not installed for B");
    await shown;
    assert.deepEqual([h.opening.view().sentence, h.opening.view().ready, h.opening.view().running], [COPY.open.accountChanged, false, false]);
});

test('W3-review mid: a refusal says its sentence and ends; another holder of the stage makes Show it wait; no gateway says so', async () => {
    for (const [code, sentence] of [['missing', COPY.open.missing], ['unavailable', COPY.open.unavailable], ['incompatible', COPY.open.incompatible], ['unsealed', COPY.open.unsealed]]) {
        const h = harness({ open: async () => ({ ok: false, code, reason: `PL_X ${code}` }) });
        await h.opening.start();
        assert.deepEqual([h.opening.view().sentence, h.opening.view().offer, h.opening.view().ready], [sentence, 'your-worlds', false], code);
        assert.deepEqual(h.record, [[false, `PL_X ${code}`]]);
    }
    const notHere = harness({ compile: async () => ({ problem: 'L3 refused m on this device' }) });
    await notHere.opening.start();
    assert.equal(notHere.opening.view().sentence, COPY.open.notHere);

    let blocked = true;
    const waits = harness({ blocked: () => blocked });
    await waits.opening.start();
    await waits.opening.show();
    assert.equal(waits.runs.length, 0, 'another holder of the stage: Show it waits');
    blocked = false;
    await waits.opening.show();
    assert.equal(waits.runs.length, 1);

    const none = new SavedOpening(WORLD, { api: null, session: null, open: async () => opened, compile: async () => ({ compiled }), blocked: () => false,
        run: async () => 'installed', changed: () => {}, record: () => {} });
    await none.start();
    assert.equal(none.view().sentence, COPY.creation.noGateway);
});

test('W3-review mid: ended (a world reached the stage), it says nothing more and hears no account change', async () => {
    const h = harness();
    await h.opening.start();
    h.opening.end();
    const before = h.changes();
    h.session.move('google');
    assert.equal(h.changes(), before);
    await h.opening.show();
    assert.equal(h.runs.length, 0);
});
