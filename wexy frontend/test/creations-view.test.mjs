// PL-FE6 on `/creations` (W3.5; the creations platform companion §9, §11): the history's view (src/shell/creations/
// view.ts) in a DOM shim just big enough for it. A title a creator or a model wrote is text, never markup; a world of a
// line this build does not open says so; rename and delete go through the page's calls and say each refusal; "Show
// more" pages on the server's cursor. No browser, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
    constructor(data) { super(); this.data = String(data); this.parent = null; }
    get textContent() { return this.data; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
}
let markupWrites = 0;
class FakeElement extends FakeNode {
    constructor(tag) {
        super();
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parent = null;
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.focused = false;
    }
    set innerHTML(v) { markupWrites++; }
    get textContent() { return this.children.map(c => c.textContent).join(''); }
    set textContent(v) {
        for (const c of this.children) c.parent = null;
        this.children = v === '' ? [] : [new FakeText(v)];
        if (this.children[0]) this.children[0].parent = this;
    }
    append(...nodes) {
        for (const n of nodes) {
            const node = n instanceof FakeNode ? n : new FakeText(n);
            node.remove?.();
            node.parent = this;
            this.children.push(node);
        }
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    async fire(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) await fn(event); }
    focus() { this.focused = true; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: tag => new FakeElement(tag) };

const { COPY, renderHistory, usageLine, worldCard } = await import('../src/shell/creations/view.ts');

const ID = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const TIME = '2026-11-03T12:00:00.000Z';
const world = (title = 'The castle', line = 'ea.v1', id = ID) => ({ worldId: id, title, rowVersion: 0, createdAt: TIME, updatedAt: TIME,
    head: { revisionId: '01JC3W5F6Q7R8S9T0V1W2X3Y50', sha256: 'a'.repeat(64), bytes: 20541, format: 'wexy-world.v1', line, createdAt: TIME } });
const usage = { usedBytes: 20541, reservedBytes: 0, worlds: 1, limits: { bytes: 104857600, worlds: 50 } };

/** Every element under `node`, itself included. */
const all = node => [node, ...(node.children ?? []).filter(c => c instanceof FakeElement).flatMap(all)];
const byClass = (root, cls) => all(root).filter(e => e.className.split(' ').includes(cls));
const button = (root, label) => all(root).find(e => e.tagName === 'BUTTON' && e.textContent === label);

function actions(over = {}) {
    const calls = [];
    return {
        calls,
        rename: async (w, t) => { calls.push(['rename', w.worldId, t]); return over.rename?.(w, t) ?? { kind: 'done', world: { ...w, title: t, rowVersion: w.rowVersion + 1 } }; },
        remove: async w => { calls.push(['remove', w.worldId]); return over.remove?.(w) ?? { kind: 'deleting', operationId: '01JC3W5F6Q7R8S9T0V1W2X3Y60' }; },
        reread: async w => { calls.push(['reread', w.worldId]); return over.reread?.(w) ?? { ...w, title: 'Renamed elsewhere', rowVersion: 5 }; },
        more: async c => { calls.push(['more', c]); return over.more?.(c) ?? null; },
        confirm: async q => { calls.push(['confirm', q]); return over.confirm ?? true; },
        removed: () => calls.push(['removed']),
    };
}

test('PL-FE6 a title is shown as text, never as markup, wherever it appears', async () => {
    markupWrites = 0;
    const evil = '<img src=x onerror="globalThis.__ran__=1"><script>globalThis.__ran__=2</script>';
    const root = new FakeElement('main');
    const a = actions({ confirm: false });
    renderHistory(root, { worlds: [world(evil)], next: null }, usage, a);
    const [card] = byClass(root, 'world-card');
    assert.equal(byClass(card, 'world-title')[0].textContent, evil);
    assert.ok(!all(root).some(e => ['IMG', 'SCRIPT'].includes(e.tagName)), 'no element made from the text');
    await button(card, 'Delete').fire('click');
    assert.deepEqual(a.calls[0], ['confirm', COPY.deleteQuestion(evil)], 'the question names it as text, too');
    assert.equal(markupWrites, 0, 'nothing in the view writes markup');
    assert.equal(globalThis.__ran__, undefined);
});

test('PL-FE6 a world this build cannot open says so; the usage line counts what is held and reserved', () => {
    const root = new FakeElement('main');
    renderHistory(root, { worlds: [world('Old', 'ea.v0'), world('New', 'ea.v1', '01JC3W5F6Q7R8S9T0V1W2X3Y4Y')], next: null }, usage, actions());
    const [old, now] = byClass(root, 'world-card');
    assert.equal(byClass(old, 'world-badge')[0].hidden, false);
    assert.equal(byClass(old, 'world-badge')[0].textContent, COPY.cantOpen);
    assert.equal(byClass(now, 'world-badge')[0].hidden, true);
    assert.equal(byClass(root, 'history-usage')[0].textContent, usageLine(usage));
    assert.equal(usageLine(usage), '1 of 50 worlds · 20 KB of 100.0 MB');
    // W3.6: a world this build opens is opened in the studio by its id; one it cannot open offers no Open at all.
    const openOf = card => all(card).find(e => e.tagName === 'A' && e.textContent === COPY.open);
    assert.deepEqual([openOf(now).hidden, openOf(now).getAttribute('href')], [false, '/studio.html?create=agent&world=01JC3W5F6Q7R8S9T0V1W2X3Y4Y']);
    assert.equal(openOf(old).hidden, true, 'no Open for a line this build does not open');
    assert.ok(!all(root).some(e => e.tagName === 'BUTTON' && /open/i.test(e.textContent)), 'Open is a link to the studio, never a button that does nothing');
});

test('PL-FE6 a rename goes through the page\'s call, and each answer is said: done, a conflict, a refusal, a gone world', async () => {
    const a = actions();
    const card = worldCard(world(), a);
    await button(card, 'Rename').fire('click');
    const input = all(card).find(e => e.tagName === 'INPUT');
    assert.equal(input.value, 'The castle');
    input.value = '  The castle at dusk  ';
    await button(card, 'Save').fire('click');
    assert.deepEqual(a.calls.at(-1), ['rename', ID, 'The castle at dusk']);
    assert.equal(byClass(card, 'world-title')[0].textContent, 'The castle at dusk');
    assert.equal(byClass(card, 'world-rename')[0].hidden, true);

    const conflicted = actions({ rename: () => ({ kind: 'conflict' }) });
    const c2 = worldCard(world(), conflicted);
    await button(c2, 'Rename').fire('click');
    all(c2).find(e => e.tagName === 'INPUT').value = 'Mine';
    await button(c2, 'Save').fire('click');
    assert.deepEqual(conflicted.calls.map(c => c[0]), ['rename', 'reread']);
    assert.equal(byClass(c2, 'world-title')[0].textContent, 'Renamed elsewhere');
    assert.equal(byClass(c2, 'world-note')[0].textContent, COPY.renameConflict);

    const refused = actions({ rename: () => ({ kind: 'refused', message: 'x' }) });
    const c3 = worldCard(world(), refused);
    await button(c3, 'Rename').fire('click');
    all(c3).find(e => e.tagName === 'INPUT').value = 'Two\nlines';
    await button(c3, 'Save').fire('click');
    assert.equal(byClass(c3, 'world-note')[0].textContent, COPY.renameRefused);

    const list = new FakeElement('ul');
    const gone = actions({ rename: () => ({ kind: 'missing' }) });
    const c4 = worldCard(world(), gone);
    list.append(c4);
    await button(c4, 'Rename').fire('click');
    all(c4).find(e => e.tagName === 'INPUT').value = 'Anything';
    await button(c4, 'Save').fire('click');
    assert.equal(list.children.length, 0, 'a world gone elsewhere leaves the list');
    assert.deepEqual(gone.calls.at(-1), ['removed']);
});

test('W3-review low: after a rename\'s conflict, a world that cannot be read just now stays on the list; only one gone leaves it', async () => {
    const list = new FakeElement('ul');
    const unread = actions({ rename: () => ({ kind: 'conflict' }), reread: () => 'unavailable' });
    const card = worldCard(world(), unread);
    list.append(card);
    await button(card, 'Rename').fire('click');
    all(card).find(e => e.tagName === 'INPUT').value = 'Mine';
    await button(card, 'Save').fire('click');
    assert.equal(list.children.length, 1, 'still listed: it was not deleted, it could not be read');
    assert.equal(byClass(card, 'world-title')[0].textContent, 'The castle', 'shown as last read');
    assert.equal(byClass(card, 'world-note')[0].textContent, COPY.renameConflictUnread);
    assert.equal(byClass(card, 'world-rename')[0].hidden, true);
    assert.ok(!unread.calls.some(c => c[0] === 'removed'), 'the usage is not read again: nothing left');

    const gone = actions({ rename: () => ({ kind: 'conflict' }), reread: () => 'missing' });
    const c2 = worldCard(world(), gone);
    list.append(c2);
    await button(c2, 'Rename').fire('click');
    all(c2).find(e => e.tagName === 'INPUT').value = 'Mine';
    await button(c2, 'Save').fire('click');
    assert.equal(list.children.length, 1, 'the gone one left');
    assert.deepEqual(gone.calls.at(-1), ['removed']);
});

test('PL-FE6 a deletion asks first, then leaves the list once the platform takes it; a conflict is said', async () => {
    const list = new FakeElement('ul');
    const no = actions({ confirm: false });
    const kept = worldCard(world(), no);
    list.append(kept);
    await button(kept, 'Delete').fire('click');
    assert.deepEqual(no.calls.map(c => c[0]), ['confirm'], 'nothing sent without the creator\'s yes');
    assert.equal(list.children.length, 1);

    const yes = actions();
    const goes = worldCard(world(), yes);
    list.append(goes);
    await button(goes, 'Delete').fire('click');
    assert.deepEqual(yes.calls.map(c => c[0]), ['confirm', 'remove', 'removed']);
    assert.equal(list.children.length, 1);

    const moved = actions({ remove: () => ({ kind: 'conflict' }) });
    const stays = worldCard(world(), moved);
    await button(stays, 'Delete').fire('click');
    assert.equal(byClass(stays, 'world-note')[0].textContent, COPY.deleteConflict);
});

test('PL-FE6 the history is empty said plainly, and "Show more" follows the server\'s cursor until it has none', async () => {
    const empty = new FakeElement('main');
    renderHistory(empty, { worlds: [], next: null }, usage, actions());
    assert.equal(byClass(empty, 'history-empty')[0].hidden, false);
    assert.equal(byClass(empty, 'history-more')[0].hidden, true);

    const root = new FakeElement('main');
    const a = actions({ more: c => (c === 'page-2' ? { worlds: [world('Older', 'ea.v1', '01JC3W5F6Q7R8S9T0V1W2X3Y4X')], next: null } : null) });
    renderHistory(root, { worlds: [world()], next: 'page-2' }, usage, a);
    const more = byClass(root, 'history-more')[0];
    assert.equal(more.hidden, false);
    await more.fire('click');
    assert.deepEqual(a.calls.at(-1), ['more', 'page-2']);
    assert.equal(byClass(root, 'world-card').length, 2);
    assert.equal(more.hidden, true);
    assert.equal(byClass(root, 'history-empty')[0].hidden, true);
});
