// The W1 review's second mid finding (2026-11-02): the link collision's "Sign in to that account" is an account change
// like Sign in and Sign out: never while a world is being made, one at a time, and the studio hears it start and end
// (Create waits on it). The real AccountControl over the real AccountSession and a fake account port, in a DOM shim
// just big enough for the control: no browser, no Firebase.
import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeNode {}

class FakeText extends FakeNode {
    constructor(data) {
        super();
        this.data = String(data);
    }

    get textContent() {
        return this.data;
    }
}

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
        this.title = '';
        this.hidden = false;
        this.disabled = false;
        this.open = false;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
        if (name === 'hidden') this.hidden = true;
        if (name === 'disabled') this.disabled = true;
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    dispatch(type) {
        for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
    }

    /** As a browser's: a disabled button does nothing. */
    click() {
        if (!this.disabled) this.dispatch('click');
    }

    append(...nodes) {
        for (const node of nodes) {
            const child = node instanceof FakeNode ? node : new FakeText(node);
            child.parent = this;
            this.children.push(child);
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
    }

    focus() {
        globalThis.document.activeElement = this;
    }

    get firstElementChild() {
        return this.children.find(c => c instanceof FakeElement) ?? null;
    }

    get textContent() {
        return this.children.map(c => c.textContent).join('');
    }

    set textContent(text) {
        this.children = [];
        if (text !== '') this.append(String(text));
    }

    showModal() {
        this.open = true;
    }

    close() {
        if (!this.open) return;
        this.open = false;
        this.dispatch('close');
    }

    /** Every button under this element, in order. */
    buttons() {
        return this.children.flatMap(c => (c instanceof FakeElement ? [...(c.tagName === 'BUTTON' ? [c] : []), ...c.buttons()] : []));
    }
}

globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeElement;
globalThis.document = { createElement: tag => new FakeElement(tag), body: new FakeElement('body'), activeElement: null };

const { AccountControl } = await import('../src/shell/studio/account.ts');
const { AccountSession } = await import('../src/platform/session.ts');
const { COPY } = await import('../src/loop/copy.ts');

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/** An anonymous creator whose Google link collides; the collision's sign-in answers when the test says. */
function collidingPort() {
    const port = {
        existingCalls: 0,
        linkCalls: 0,
        pending: null,
        async current() { return { uid: 'u1', provider: 'anonymous' }; },
        async linkGoogle() { port.linkCalls++; return { kind: 'collision', collision: { id: 'other-account' } }; },
        signInExisting() {
            port.existingCalls++;
            return new Promise(resolve => { port.pending = resolve; });
        },
        async signOut() {},
        onChange() { return () => {}; },
    };
    return port;
}

async function control() {
    const port = collidingPort();
    const session = new AccountSession(port);
    await session.refresh();
    const heard = [];
    // The allowance read fails here (no backend): the chip stays as it was, which these tests do not look at.
    const api = { send: async () => { throw new Error('no backend in this test'); } };
    const account = new AccountControl(session, api, () => {}, changing => heard.push(changing));
    return { port, account, heard };
}

/** A button by its accessible name: its aria-label (the header's Sign in has two labels, one shown) or its text. */
const button = (root, label) => root.buttons().find(b => b.attributes.get('aria-label') === label || b.textContent === label);
const openDialog = () => document.body.children.find(c => c.tagName === 'DIALOG' && c.open);

test('the W1 review: a collision\'s sign-in is an account change, one at a time, and the studio hears it start and end', async () => {
    const { port, account, heard } = await control();
    button(account.el, COPY.account.signIn).click();
    await settle();
    const dialog = openDialog();
    assert.ok(dialog, 'the collision asks');
    assert.equal(account.changing, false, 'asking is not changing');

    button(dialog, COPY.account.collisionGo).click();
    await settle();
    assert.equal(port.existingCalls, 1);
    assert.equal(account.changing, true, 'the other account\'s sign-in is under way');
    assert.equal(heard.at(-1), true, 'the studio heard it start, so Create waits');
    assert.equal(button(account.el, COPY.account.signIn).disabled, true, 'Sign in waits meanwhile');

    button(account.el, COPY.account.signIn).disabled = false;
    button(account.el, COPY.account.signIn).click();
    await settle();
    assert.equal(port.linkCalls, 1, 'a second change while one is under way is refused');

    port.pending({ kind: 'signed-in' });
    await settle();
    assert.equal(account.changing, false);
    assert.equal(heard.at(-1), false, 'the studio heard it end');
});

test('phones: the chip reads as a line under the idea box, the same words shown and hidden with it, and Sign in keeps its whole name', async () => {
    let who = { uid: 'u1', provider: 'anonymous' };
    const listeners = new Set();
    const port = {
        async current() { return who; },
        async linkGoogle() { return { kind: 'linked' }; },
        async signInExisting() { return { kind: 'signed-in' }; },
        async signOut() { who = null; for (const l of [...listeners]) l(); },
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const session = new AccountSession(port);
    await session.refresh();
    const api = { send: async () => ({ json: async () => ({ label: 'Free', left: 1, resetsAt: null }) }) };
    const account = new AccountControl(session, api, () => {});
    const chip = account.el.children.find(c => c.className === 'account-chip');
    assert.equal(account.line.hidden, true, 'nothing shows before the allowance is read');

    await account.afterEntry();
    assert.equal(account.line.hidden, false);
    assert.equal(account.line.textContent, '1 free world');
    assert.equal(chip.textContent, account.line.textContent, 'the same words in both places');
    assert.equal(chip.hidden, false);
    const signIn = button(account.el, COPY.account.signIn);
    assert.equal(signIn.attributes.get('aria-label'), COPY.account.signIn, 'its name stays whole when its label is short');
    assert.ok(signIn.textContent.includes(COPY.account.signInShort), 'the short label is there for phones');

    await session.signOut();
    await settle();
    assert.equal(account.line.hidden, true, 'no one signed in: no line');
    assert.equal(chip.hidden, true);
});

test('the W1 review: while a world is being made, the collision\'s sign-in waits like Sign in and Sign out', async () => {
    const { port, account } = await control();
    button(account.el, COPY.account.signIn).click();
    await settle();
    const dialog = openDialog();
    assert.ok(dialog);

    account.setBusy(true);
    button(dialog, COPY.account.collisionGo).click();
    await settle();
    assert.equal(port.existingCalls, 0, 'no identity change under a world being made');
    assert.equal(account.changing, false);
});
