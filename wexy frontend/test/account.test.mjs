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
        this.value = '';
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
        if (name === 'hidden') this.hidden = true;
        if (name === 'disabled') this.disabled = true;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'hidden') this.hidden = false;
        if (name === 'disabled') this.disabled = false;
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

    /** The first element under this one, depth first, that `match` accepts. */
    find(match) {
        for (const c of this.children) {
            if (!(c instanceof FakeElement)) continue;
            if (match(c)) return c;
            const deeper = c.find(match);
            if (deeper) return deeper;
        }
        return null;
    }
}

globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeElement;
globalThis.document = { createElement: tag => new FakeElement(tag), body: new FakeElement('body'), activeElement: null };

const { AccountControl } = await import('../src/shell/studio/account.ts');
const { AccountSession } = await import('../src/platform/session.ts');
const { COPY } = await import('../src/loop/copy.ts');
const { ForgeError } = await import('../src/forge-client/errors.ts');

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

// --- W2 (the creations platform companion §6.3, §9; PL-FE3 extended): the account behind a Google session. ---

const ACCOUNT_ID = '01JC3W5F6Q7R8S9T0V1W2X3Y4Z';
const OTHER_ID = '01JC3W5F6Q7R8S9T0V1W2X3Y5B';
const dto = ({ handle = null, rowVersion = 0, status = 'ACTIVE', accountId = ACCOUNT_ID } = {}) =>
    ({ accountId, status, policyVersion: 1, profile: { handle, displayName: null, bio: null, publicEnabled: false, rowVersion } });

/**
 * The gateway for these tests: the allowance, and the platform's routes from `routes` ("METHOD path" → a DTO, an
 * error, or a function of the request that may answer later). An unknown route is 404, as before a bootstrap.
 */
function platformApi(routes) {
    const sent = [];
    return {
        sent,
        platform: () => sent.filter(s => !s.startsWith('GET /v1/forge/')),
        async send(req) {
            sent.push(`${req.method} ${req.path}`);
            const route = routes[`${req.method} ${req.path}`];
            if (req.path === '/v1/forge/allowance' && route === undefined) {
                return new Response(JSON.stringify({ label: 'Early access', left: 1, resetsAt: null }));
            }
            const answer = typeof route === 'function' ? await route(req) : route;
            if (answer instanceof Error) throw answer;
            if (answer === undefined) throw new ForgeError('not-found', 404, 'This account has not been set up yet.');
            return new Response(JSON.stringify(answer));
        },
    };
}

/** An account port whose creator links Google with the same uid, and signs out to no one. */
function googlePort(who) {
    const listeners = new Set();
    const port = {
        who,
        reads: 0,
        async current() { port.reads++; return port.who; },
        async linkGoogle() { port.who = { uid: port.who?.uid ?? 'u1', provider: 'google' }; return { kind: 'linked' }; },
        async signInExisting() { return { kind: 'signed-in' }; },
        async signOut() { port.who = null; for (const l of [...listeners]) l(); },
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        /** Another tab signs in as someone else: Firebase tells this one through its listener. */
        switchTo(next) { port.who = next; for (const l of [...listeners]) l(); },
    };
    return port;
}

const memoryHint = value => ({ value, read() { return this.value; }, write(google) { this.value = google; } });

/** A control over a session of `who`, the gateway's `routes`, and the hint; `said` collects its toasts. */
async function accountControl(who, routes, { hint = memoryHint(false), refresh = true, deadlineMs } = {}) {
    const port = googlePort(who);
    const session = new AccountSession(port, hint);
    if (refresh) await session.refresh();
    const api = platformApi(routes);
    const said = [];
    const account = new AccountControl(session, api, text => said.push(text), () => {}, deadlineMs === undefined ? {} : { accountDeadlineMs: deadlineMs });
    return { port, session, api, account, said, hint };
}

const whoOf = account => account.el.find(c => c.className === 'account-who');
const claimOf = account => account.el.find(c => c.className.includes('account-claim'));
const handleDialog = () => document.body.children.filter(c => c.tagName === 'DIALOG' && c.open && c.find(e => e.tagName === 'INPUT')).at(-1);

test('W2 a Google sign-in sets the account up once (POST /v1/me), and until a handle is claimed the header offers one', async () => {
    const { api, account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto() });
    button(account.el, COPY.account.signIn).click();
    await settle();

    assert.deepEqual(api.platform(), ['POST /v1/me'], 'one bootstrap, no read before it');
    assert.equal(whoOf(account).hidden, false);
    assert.equal(whoOf(account).textContent, COPY.account.signedIn);
    assert.equal(claimOf(account).hidden, false, 'Choose a handle');
    assert.equal(account.lineClaim.hidden, false, 'and its twin under the idea box, for phones');
});

test('W3.6 the account as a save needs it: unknown until an ACTIVE account is read, inactive when the platform says so; "Sign in to keep this world" is the header\'s own sign-in', async () => {
    const { api, account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto() });
    const heard = [];
    account.onAccount = () => heard.push(account.saveKind);
    assert.equal(account.saveKind, 'unknown', 'anonymous: no account to save to');
    account.signInToSave();
    await settle();
    assert.deepEqual(api.platform(), ['POST /v1/me'], 'the same sign-in and set-up as the header\'s Sign in');
    assert.equal(account.saveKind, 'active');
    assert.ok(heard.includes('active'), 'the studio\'s save hears the account once it is read');
    const suspended = await accountControl({ uid: 'u2', provider: 'google' }, { 'GET /v1/me': dto({ status: 'SUSPENDED' }) }, { hint: memoryHint(true) });
    await suspended.account.restore();
    await settle();
    assert.equal(suspended.account.saveKind, 'inactive', 'an account the platform does not let save');
});

test('W2 a claimed handle reads @handle in the header and on the phone line, and no claim is offered', async () => {
    const { account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto({ handle: 'nova', rowVersion: 1 }) });
    button(account.el, COPY.account.signIn).click();
    await settle();

    assert.equal(whoOf(account).textContent, '@nova');
    assert.equal(claimOf(account).hidden, true);
    assert.equal(account.lineClaim.hidden, true);
    assert.equal(account.line.textContent, '@nova · Early access: 1 world today');
});

test('W2 the handle dialog claims what is typed, lowercased, at the version the account was read at', async () => {
    const patches = [];
    const { account, said } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        'POST /v1/me': dto(),
        'PATCH /v1/me/profile': req => { patches.push(req.body); return dto({ handle: 'nova', rowVersion: 1 }); },
    });
    button(account.el, COPY.account.signIn).click();
    await settle();
    claimOf(account).click();
    const dialog = handleDialog();
    assert.ok(dialog, 'the dialog opens');
    dialog.find(e => e.tagName === 'INPUT').value = ' @Nova ';
    button(dialog, COPY.account.claim).click();
    await settle();

    assert.deepEqual(patches, [{ accountId: ACCOUNT_ID, expectedVersion: 0, handle: 'nova' }]);
    assert.equal(dialog.open, false, 'claimed: the dialog closes');
    assert.equal(whoOf(account).textContent, '@nova');
    assert.equal(claimOf(account).hidden, true);
    assert.deepEqual(said, [COPY.account.handleClaimed('nova')]);
});

test('W2 a taken handle is said in the dialog, which stays open; a shape no handle has is refused before any call', async () => {
    const { api, account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        'POST /v1/me': dto(),
        'GET /v1/me': dto(),
        'PATCH /v1/me/profile': () => new ForgeError('conflict', 409, 'taken'),
    });
    button(account.el, COPY.account.signIn).click();
    await settle();
    claimOf(account).click();
    const dialog = handleDialog();
    const input = dialog.find(e => e.tagName === 'INPUT');
    const error = dialog.find(e => e.attributes.get('role') === 'alert');

    input.value = 'ab';
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.equal(error.textContent, COPY.account.handleRule);
    assert.ok(!api.sent.includes('PATCH /v1/me/profile'), 'refused here, nothing sent');

    input.value = 'nova';
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, COPY.account.handleTaken, 'the account read again: same version, so the handle is taken');
    assert.equal(dialog.open, true, 'the creator can try another');
    assert.equal(input.attributes.get('aria-invalid'), 'true');
    button(dialog, COPY.account.notNow).click();
    assert.equal(dialog.open, false);
});

test('W2 a claim another tab made meanwhile is shown, not fought', async () => {
    const { account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        'POST /v1/me': dto(),
        'GET /v1/me': dto({ handle: 'other', rowVersion: 1 }),
        'PATCH /v1/me/profile': () => new ForgeError('conflict', 409, 'moved on'),
    });
    button(account.el, COPY.account.signIn).click();
    await settle();
    claimOf(account).click();
    const dialog = handleDialog();
    dialog.find(e => e.tagName === 'INPUT').value = 'nova';
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.equal(dialog.open, false);
    assert.equal(whoOf(account).textContent, '@other');
});

test('W2 a reload of a browser that held a Google session shows its account at once; any other page view reads nothing', async () => {
    const restored = await accountControl({ uid: 'u1', provider: 'google' }, { 'GET /v1/me': dto({ handle: 'nova', rowVersion: 1 }) },
        { hint: memoryHint(true), refresh: false });
    await restored.account.restore();
    await settle();
    assert.equal(whoOf(restored.account).textContent, '@nova');
    assert.deepEqual(restored.api.platform(), ['GET /v1/me'], 'read, not set up again');
    assert.equal(restored.account.line.textContent, '@nova · Early access: 1 world today');

    const fresh = await accountControl({ uid: 'u1', provider: 'google' }, { 'GET /v1/me': dto() }, { hint: memoryHint(false), refresh: false });
    await fresh.account.restore();
    await settle();
    assert.equal(fresh.port.reads, 0, 'no hint: who is signed in is not even asked, so no Firebase loads');
    assert.deepEqual(fresh.api.sent, []);
});

test('W2 a Google session from before W2 has no account yet: its 404 is set up then', async () => {
    const { api, account } = await accountControl({ uid: 'u1', provider: 'google' }, { 'POST /v1/me': dto() },
        { hint: memoryHint(true), refresh: false });
    await account.restore();
    await settle();
    assert.deepEqual(api.platform(), ['GET /v1/me', 'POST /v1/me']);
    assert.equal(claimOf(account).hidden, false);
});

test('W2 an account the platform could not give at the sign-in is read again at the next Create, once', async () => {
    let up = false;
    const { api, account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        'POST /v1/me': () => (up ? dto() : new ForgeError('unavailable', 503, 'down')),
        'GET /v1/me': () => (up ? dto({ handle: 'nova', rowVersion: 1 }) : new ForgeError('unavailable', 503, 'down')),
    });
    button(account.el, COPY.account.signIn).click();
    await settle();
    assert.equal(whoOf(account).textContent, COPY.account.signedIn, 'signed in, its account unknown');
    assert.equal(claimOf(account).hidden, true, 'nothing to claim on until the account is known');

    up = true;
    await account.afterEntry();
    await settle();
    assert.equal(whoOf(account).textContent, '@nova');
    assert.deepEqual(api.platform(), ['POST /v1/me', 'GET /v1/me']);
    await account.afterEntry();
    await settle();
    assert.deepEqual(api.platform(), ['POST /v1/me', 'GET /v1/me'], 'known now: no further read');
});

test('W2 signing out drops the account at once (F4): no handle, no claim, nothing of it on the line', async () => {
    const { account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto({ handle: 'nova', rowVersion: 1 }) });
    button(account.el, COPY.account.signIn).click();
    await settle();
    assert.equal(whoOf(account).textContent, '@nova');

    button(account.el, COPY.account.signOut).click();
    await settle();
    assert.equal(whoOf(account).hidden, true);
    assert.notEqual(whoOf(account).textContent, '@nova');
    assert.equal(claimOf(account).hidden, true);
    assert.ok(!account.line.textContent.includes('nova'));
});

test('W2 an account read that answers after the account changed is dropped', async () => {
    const answers = [];
    const { session, port, account } = await accountControl({ uid: 'u1', provider: 'google' },
        { 'GET /v1/me': () => new Promise(resolve => answers.push(resolve)) }, { hint: memoryHint(true), refresh: false });
    await account.restore();
    await settle();
    assert.equal(answers.length, 1, 'u1\'s read is under way');

    port.who = { uid: 'u2', provider: 'google' };
    await session.refresh();
    await settle();
    assert.equal(answers.length, 2, 'u2\'s own read');
    answers[0](dto({ handle: 'nova', rowVersion: 1 }));
    await settle();
    assert.notEqual(whoOf(account).textContent, '@nova', 'u1\'s handle never shows for u2');
    answers[1](dto({ handle: 'vega', rowVersion: 1 }));
    await settle();
    assert.equal(whoOf(account).textContent, '@vega');
});

// --- The W2 review (2026-11-03): an account switch under an open claim, and a bootstrap that never answers. ---

test('W2 review, high: a switch to another Google account closes the first one\'s claim at once, and nothing is claimed for it', async () => {
    const mutations = [];
    const pendingB = [];
    let port;
    const control = await accountControl({ uid: 'A', provider: 'google' }, {
        'GET /v1/me': () => (port.who.uid === 'A' ? dto() : new Promise(resolve => pendingB.push(resolve))),
        'PATCH /v1/me/profile': req => {
            mutations.push({ uid: port.who.uid, ...req.body });
            return dto({ handle: 'alice', rowVersion: 1 });
        },
    }, { hint: memoryHint(true), refresh: false });
    port = control.port;
    const { account } = control;
    await account.restore();
    await settle();
    claimOf(account).click();
    const dialog = handleDialog();
    assert.ok(dialog, 'A\'s claim is open');
    dialog.find(e => e.tagName === 'INPUT').value = 'alice';

    // Another tab signs in as B; B's account has not answered yet.
    port.switchTo({ uid: 'B', provider: 'google' });
    await settle();
    assert.equal(dialog.open, false, 'the switch closes A\'s claim');
    assert.equal(claimOf(account).hidden, true, 'and offers none until B\'s own account is read');
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.deepEqual(mutations, [], 'nothing typed for A is sent under B');

    pendingB[0](dto({ accountId: OTHER_ID }));
    await settle();
    assert.equal(claimOf(account).hidden, false, 'B\'s own claim, once its account is read');
    // A claim that still comes from A's dialog once B is known is A's, and refused here: never sent for B.
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.deepEqual(mutations, [], 'A\'s dialog claims nothing for B, even with B\'s account in hand');
});

test('W2 review, high: the first Google account\'s handle never shows under the next, even before the next one\'s answer', async () => {
    const pendingB = [];
    let port;
    const control = await accountControl({ uid: 'A', provider: 'google' }, {
        'GET /v1/me': () => (port.who.uid === 'A' ? dto({ handle: 'alice', rowVersion: 1 }) : new Promise(resolve => pendingB.push(resolve))),
    }, { hint: memoryHint(true), refresh: false });
    port = control.port;
    const { account } = control;
    await account.restore();
    await settle();
    assert.equal(whoOf(account).textContent, '@alice');

    port.switchTo({ uid: 'B', provider: 'google' });
    await settle();
    assert.equal(whoOf(account).textContent, COPY.account.signedIn, 'B reads as signed in, not as A');
    assert.ok(!account.line.textContent.includes('alice'));
    pendingB[0](dto({ handle: 'bob', rowVersion: 1, accountId: OTHER_ID }));
    await settle();
    assert.equal(whoOf(account).textContent, '@bob');
});

test('W2 review: no account change while a handle is being claimed, so the claim goes out under the account it was typed for', async () => {
    let answer;
    const { port, account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        'POST /v1/me': dto(),
        'PATCH /v1/me/profile': () => new Promise(resolve => { answer = resolve; }),
    });
    button(account.el, COPY.account.signIn).click();
    await settle();
    claimOf(account).click();
    const dialog = handleDialog();
    dialog.find(e => e.tagName === 'INPUT').value = 'nova';
    button(dialog, COPY.account.claim).click();
    await settle();
    assert.equal(button(account.el, COPY.account.signOut).disabled, true, 'Sign out waits for the claim');
    button(account.el, COPY.account.signOut).disabled = false;
    button(account.el, COPY.account.signOut).click();
    await settle();
    assert.equal(port.who?.provider, 'google', 'still signed in: the claim held the account');

    answer(dto({ handle: 'nova', rowVersion: 1 }));
    await settle();
    assert.equal(whoOf(account).textContent, '@nova');
    assert.equal(button(account.el, COPY.account.signOut).disabled, false);
});

// --- The independent W2 review (2026-11-03): its three frontend Lows. ---

test('W2 independent review: another tab\'s switch during this tab\'s own sign-in still reads the account it leaves signed in', async () => {
    let finishLink;
    const { port, account } = await accountControl({ uid: 'u1', provider: 'anonymous' },
        { 'GET /v1/me': () => dto({ handle: 'bob', rowVersion: 1, accountId: OTHER_ID }) });
    port.linkGoogle = () => new Promise(resolve => { finishLink = resolve; });
    button(account.el, COPY.account.signIn).click();
    await settle();
    port.switchTo({ uid: 'B', provider: 'google' });
    await settle();
    finishLink({ kind: 'cancelled' });
    await settle();
    assert.equal(whoOf(account).textContent, '@bob', 'B\'s account, read once this tab\'s change ended');
});

test('W2 independent review: a sign-out that leaves someone signed in (another tab) does not say "Signed out"', async () => {
    const { port, account, said } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto() });
    button(account.el, COPY.account.signIn).click();
    await settle();
    port.signOut = async () => { port.who = { uid: 'B', provider: 'google' }; };
    button(account.el, COPY.account.signOut).click();
    await settle();
    assert.ok(!said.includes(COPY.account.signedOut), 'B is signed in: nothing was signed out from the creator\'s view');
});

test('W2 independent review: the last account\'s allowance words go at a switch, before the next one\'s answer (F4, I13)', async () => {
    const pendingB = [];
    let port;
    const control = await accountControl({ uid: 'A', provider: 'google' }, {
        'GET /v1/me': () => dto({ accountId: port.who.uid === 'A' ? ACCOUNT_ID : OTHER_ID }),
        'GET /v1/forge/allowance': () => (port.who.uid === 'A'
            ? { label: 'Early access', left: 19, resetsAt: null }
            : new Promise(resolve => pendingB.push(resolve))),
    }, { hint: memoryHint(true), refresh: false });
    port = control.port;
    const { account } = control;
    await account.restore();
    await settle();
    const chip = account.el.find(c => c.className === 'account-chip');
    assert.equal(chip.textContent, 'Early access: 19 worlds today');

    port.switchTo({ uid: 'B', provider: 'google' });
    await settle();
    assert.equal(chip.hidden, true, 'A\'s numbers are not B\'s');
    assert.equal(account.line.hidden, true);
    pendingB[0]({ label: 'Early access', left: 1, resetsAt: null });
    await settle();
    assert.equal(chip.textContent, 'Early access: 1 world today');
});

test('W2 independent review: a gateway without the platform\'s routes is asked once a page, not at every Create', async () => {
    const { api, account } = await accountControl({ uid: 'u1', provider: 'google' }, {}, { hint: memoryHint(true), refresh: false });
    await account.restore();
    await settle();
    assert.deepEqual(api.platform(), ['GET /v1/me', 'POST /v1/me'], 'the read, then the set-up, both 404');
    await account.afterEntry();
    await settle();
    await account.afterEntry();
    await settle();
    assert.deepEqual(api.platform(), ['GET /v1/me', 'POST /v1/me'], 'no more reads, and no more single-use App Check tokens spent');
    assert.equal(whoOf(account).textContent, COPY.account.signedIn);
});

test('W2 a suspended account reads as signed in, and is offered no claim', async () => {
    const { account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, { 'POST /v1/me': dto({ status: 'SUSPENDED' }) });
    button(account.el, COPY.account.signIn).click();
    await settle();
    assert.equal(whoOf(account).textContent, COPY.account.signedIn);
    assert.equal(claimOf(account).hidden, true);
    assert.equal(account.lineClaim.hidden, true);
});

test('W2 review, mid: a bootstrap that never answers holds neither the sign-in nor Create, and its deadline leaves the next Create to read again', async () => {
    let up = false;
    const { account } = await accountControl({ uid: 'u1', provider: 'anonymous' }, {
        // As fetch does: no answer until the platform is up, but the request's signal ends it.
        'POST /v1/me': req => (up ? dto() : new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal.reason)))),
        'GET /v1/me': () => dto({ handle: 'nova', rowVersion: 1 }),
    }, { deadlineMs: 60 });
    button(account.el, COPY.account.signIn).click();
    await settle();
    assert.equal(account.changing, false, 'the sign-in is over, so Create may run');
    assert.equal(button(account.el, COPY.account.signOut).disabled, false, 'and Sign out is free');

    await new Promise(resolve => setTimeout(resolve, 150));
    await settle();
    up = true;
    await account.afterEntry();
    await settle();
    assert.equal(whoOf(account).textContent, '@nova', 'the deadline gave the set-up up, and the next Create read the account');
});

// Q129 (the user, 2026-11-04): a world written and waiting for Show it is the signed-in account's, and an account change
// discards it, so Sign out, and a collision's sign-in to another account, ask first. Escape keeps both.
test('Q129 Sign out asks first when a world waits for Show it: Show it first keeps the account, Sign out and discard signs out, Escape keeps both', async () => {
    const { port, account, said } = await accountControl({ uid: 'u1', provider: 'google' }, { 'GET /v1/me': dto() }, { hint: memoryHint(true) });
    let shows = 0;
    let waiting = true;
    account.unshownWorld = () => waiting;
    account.showUnshown = () => { shows++; };
    const signOut = () => button(account.el, COPY.account.signOut);
    await account.restore();
    await settle();

    signOut().click();
    await settle();
    let dialog = openDialog();
    assert.ok(dialog, 'it asks');
    assert.equal(dialog.find(e => e.tagName === 'H2').textContent, COPY.account.unshownSignOutTitle);
    assert.equal(dialog.find(e => e.tagName === 'P').textContent, COPY.account.unshownSignOutBody);
    assert.deepEqual(dialog.buttons().map(b => b.textContent), [COPY.account.showFirst, COPY.account.unshownSignOutGo]);
    button(dialog, COPY.account.showFirst).click();
    await settle();
    assert.deepEqual([shows, port.who?.uid ?? null, dialog.open], [1, 'u1', false], 'Show it first: shown, still signed in');

    signOut().click();
    await settle();
    dialog = openDialog();
    dialog.close();
    await settle();
    assert.equal(port.who?.uid, 'u1', 'Escape: still signed in, the world kept');

    signOut().click();
    await settle();
    button(openDialog(), COPY.account.unshownSignOutGo).click();
    await settle();
    assert.equal(port.who, null, 'Sign out and discard: signed out');
    // Said as it is (the account review's L1): the world was discarded, not kept.
    assert.equal(said.at(-1), COPY.account.signedOutDiscarded);

    // Nothing waiting: Sign out asks nothing.
    const plain = await accountControl({ uid: 'u2', provider: 'google' }, { 'GET /v1/me': dto() }, { hint: memoryHint(true) });
    plain.account.unshownWorld = () => false;
    await plain.account.restore();
    await settle();
    button(plain.account.el, COPY.account.signOut).click();
    await settle();
    assert.equal(plain.port.who, null);
    assert.equal(plain.said.at(-1), COPY.account.signedOut);
    waiting = false;
});

test('Q129 a collision\'s "Sign in to that account" asks the same first when a world waits for Show it', async () => {
    const { port, account } = await control();
    let shows = 0;
    account.unshownWorld = () => true;
    account.showUnshown = () => { shows++; };
    button(account.el, COPY.account.signIn).click();
    await settle();
    button(openDialog(), COPY.account.collisionGo).click();
    await settle();
    let dialog = openDialog();
    assert.ok(dialog, 'it asks before signing in to another account');
    assert.equal(dialog.find(e => e.tagName === 'P').textContent, COPY.account.unshownSignInBody);
    assert.deepEqual(dialog.buttons().map(b => b.textContent), [COPY.account.showFirst, COPY.account.unshownSignInGo]);
    button(dialog, COPY.account.showFirst).click();
    await settle();
    assert.deepEqual([shows, port.existingCalls], [1, 0], 'Show it first: no sign-in');

    button(account.el, COPY.account.signIn).click();
    await settle();
    button(openDialog(), COPY.account.collisionGo).click();
    await settle();
    button(openDialog(), COPY.account.unshownSignInGo).click();
    await settle();
    assert.equal(port.existingCalls, 1, 'Sign in and discard: signed in to that account');
    port.pending({ kind: 'signed-in' });
    await settle();
});
