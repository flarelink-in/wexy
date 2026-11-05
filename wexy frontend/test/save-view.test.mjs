// The studio's save status (W3.6; the creations platform companion §7, §9's "Studio save status" row, §12): every state
// the save controller can be in, in the creator's words, with its one thing to do; and the view that says it twice
// (beside the title, and under the idea box where the header has none), its buttons reaching the studio's actions.
// A DOM shim just big enough for it. No browser, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
    constructor(data) { super(); this.data = String(data); }
    get textContent() { return this.data; }
}
let markupWrites = 0;
class FakeElement extends FakeNode {
    constructor(tag) {
        super();
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.className = '';
        this.hidden = false;
        this.title = '';
    }
    set innerHTML(v) { markupWrites++; }
    get textContent() { return this.children.map(c => c.textContent).join(''); }
    append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(n)); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(k, v) { if (k === 'hidden') this.hidden = true; else this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: tag => new FakeElement(tag) };

const { COPY } = await import('../src/loop/copy.ts');
const { CREATIONS, SaveView, saveLine } = await import('../src/shell/studio/save-view.ts');

const WORLD = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const state = (status, extra = {}) => ({ stage: 1, status, worldId: WORLD, revisionId: null, rowVersion: null, detail: 'a developer\'s words', ...extra });
const STATUSES = ['idle', 'sign-in', 'saving', 'saved', 'conflict', 'storage-full', 'too-large', 'not-saved', 'not-allowed', 'offline', 'failed', 'elsewhere'];

test('W3.6 every save state in the creator\'s words, its one thing to do; nothing for a world with nothing to save', () => {
    assert.equal(saveLine(null), null);
    assert.equal(saveLine(state('idle')), null, 'a starter or a replay: no line at all');
    const lines = Object.fromEntries(STATUSES.filter(s => s !== 'idle').map(s => [s, saveLine(state(s))]));
    assert.deepEqual(Object.fromEntries(Object.entries(lines).map(([s, l]) => [s, [l.tone, l.text, l.actions]])), {
        'saving': ['busy', COPY.save.saving, []],
        'saved': ['ok', COPY.save.saved, ['your-worlds']],
        'sign-in': ['warn', COPY.save.notSaved, ['sign-in']],
        'conflict': ['warn', COPY.save.conflict, ['save-as-new', 'open-saved']],
        'storage-full': ['warn', COPY.save.full, ['your-worlds', 'retry']],
        'too-large': ['warn', COPY.save.tooLarge, []],
        'not-saved': ['warn', COPY.save.notSaved, ['retry']],
        // The account review's L4: an account read and barred has nothing to press that would change it.
        'not-allowed': ['warn', COPY.save.notSaved, []],
        'offline': ['warn', COPY.save.offline, ['retry']],
        'failed': ['warn', COPY.save.notSaved, ['retry']],
        // Q129: another account's world, saved to it: said so, nothing offered here.
        'elsewhere': ['ok', COPY.save.savedElsewhere, []],
    });
    // Another account's world that its owner has not saved: "Not saved", and still nothing offered (never saved here).
    const unsaved = saveLine(state('elsewhere', { worldId: null }));
    assert.deepEqual([unsaved.tone, unsaved.text, unsaved.actions, unsaved.why], ['warn', COPY.save.notSaved, [], COPY.save.elsewhereWhy]);
    assert.ok(!Object.values(lines).some(l => l.actions.includes('save')), 'no Save that would put a world into another account');
    // A new world's conflict (its key used for another body) has no saved world: no "Open the saved one" for nothing.
    assert.deepEqual(saveLine(state('conflict', { worldId: null })).actions, ['save-as-new']);
    // EA9.4 (Q119): saved, then its camera views changed. Its one Save is its owner's: the controller says `changed` only
    // while the account that made it is signed in, and its saveChanges sends for that account alone (save-controller tests).
    const changed = saveLine(state('changed'));
    assert.deepEqual([changed.tone, changed.text, changed.actions, changed.why], ['warn', COPY.save.changed, ['save'], COPY.save.changedWhy]);
    assert.doesNotMatch(`${changed.text} ${changed.why}`, /\d{3}|_|PL_|EA_|developer/);
    for (const [s, l] of Object.entries(lines)) {
        // Plain words (guidelines §2): no code, status number, id or the developer's detail in what a creator reads.
        assert.doesNotMatch(`${l.text} ${l.why}`, /\d{3}|_|PL_|EA_|developer|conflict:|storage-full/, s);
        if (l.tone === 'warn') assert.ok(l.why.length > 0, `${s}: what happened and what to do`);
    }
    // No promise of a download the studio does not offer an agent world (the companion §12's sentences, as built).
    assert.ok(!Object.values(COPY.save).some(v => typeof v === 'string' && /download/i.test(v)));
});

test('W3.6 the view says it beside the title and under the idea box, each button the studio\'s action, drawn once a state', () => {
    markupWrites = 0;
    const calls = [];
    const view = new SaveView({
        retry: () => calls.push('retry'), saveAsNew: () => calls.push('save-as-new'), openSaved: id => calls.push(`open ${id}`), signIn: () => calls.push('sign-in'),
    });
    assert.deepEqual([view.el.hidden, view.line.hidden], [true, true]);
    view.render(state('saving'));
    assert.deepEqual([view.el.hidden, view.line.hidden, view.el.dataset.tone], [false, false, 'busy']);
    const text = root => root.children.find(c => c.className === 'save-text');
    assert.equal(text(view.el).textContent, COPY.save.saving);
    assert.equal(text(view.el).getAttribute('role'), 'status', 'a screen reader hears the change');
    // Drawn again only when what it says changes: the same state twice is one announcement.
    const before = view.el.children;
    view.render(state('saving', { detail: 'other words' }));
    assert.equal(view.el.children, before);
    view.render(state('conflict'));
    const buttons = root => root.children.filter(c => c.tagName === 'BUTTON');
    assert.deepEqual(buttons(view.el).map(b => b.textContent), [COPY.save.saveAsNew, COPY.save.openSaved]);
    for (const b of buttons(view.el)) b.fire('click');
    for (const b of buttons(view.line)) b.fire('click');
    assert.deepEqual(calls, ['save-as-new', `open ${WORLD}`, 'save-as-new', `open ${WORLD}`], 'both copies reach the same actions');
    view.render(state('storage-full'));
    const link = view.el.children.find(c => c.tagName === 'A');
    assert.deepEqual([link.textContent, link.getAttribute('href'), CREATIONS], [COPY.save.yourWorlds, '/creations', '/creations']);
    buttons(view.el)[0].fire('click');
    view.render(state('sign-in'));
    buttons(view.el)[0].fire('click');
    view.render(state('not-saved'));
    assert.equal(buttons(view.el)[0].textContent, COPY.save.tryAgain);
    buttons(view.el)[0].fire('click');
    assert.deepEqual(calls.slice(4), ['retry', 'sign-in', 'retry']);
    // Q129: a world another account made has no button at all.
    view.render(state('elsewhere'));
    assert.equal(buttons(view.el).length, 0);
    view.render(null);
    assert.deepEqual([view.el.hidden, view.line.hidden, view.el.children.length], [true, true, 0]);
    assert.equal(markupWrites, 0, 'nothing here writes markup');
});
