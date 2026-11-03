// `/creations`, the history (W3.5; the creations platform companion §9): the page's wiring around view.ts. It loads
// Firebase only to learn who is signed in, as an account page may; it never signs anyone in by itself. Signed in with
// Google, the account is set up when it has none (POST /v1/me, as the studio does after a sign-in), then the worlds
// and the usage are read. Every answer is the epoch's it was asked under (F4): when another account signs in, or this
// one signs out, the page is read again from the start, and a late answer for the account before is dropped.

import '../../styles/base.css';
import '../../styles/creations.css';
import { readConfig } from '../../forge-client/config';
import { createApi } from '../../forge-client/http';
import { createIdentity, type LinkOutcome } from '../../forge-client/identity';
import { bootstrapAccount, readAccount } from '../../platform/client';
import { AccountSession } from '../../platform/session';
import { deleteWorld, listWorlds, readUsage, readWorld, renameWorld } from '../../platform/worlds';
import { h } from '../../shared/dom';
import { renderHistory } from './view';

const COPY = {
    noBackend: 'Saving worlds isn\'t set up in this build.',
    noSignIn: 'Signing in isn\'t set up in this build.',
    signIn: 'Sign in with Google to see the worlds you saved.',
    loading: 'Loading your worlds…',
    unavailable: 'Your worlds can\'t be loaded right now.',
    collision: 'That Google account already has a Wexy account. Sign in to it to see its worlds.',
    signInFailed: 'Signing in didn\'t finish. Try again.',
};

const root = document.getElementById('history') as HTMLElement;

/** A message in place of the history, with one action when there is one to take. */
function say(text: string, action?: { label: string; run: () => void }): void {
    root.textContent = '';
    root.append(h('p', { class: 'history-message', role: 'status' }, text));
    if (action) root.append(h('button', { type: 'button', class: 'btn btn-primary', onclick: action.run }, action.label));
}

/** The page's own confirmation: a native dialog, Escape or Cancel for no. */
function confirmDialog(question: string): Promise<boolean> {
    return new Promise(resolve => {
        const yes = h('button', { type: 'button', class: 'btn btn-primary' }, 'Delete');
        const no = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Cancel');
        const dialog = h('dialog', { class: 'history-dialog' }, h('p', null, question), h('div', { class: 'world-actions' }, no, yes));
        const done = (answer: boolean) => {
            dialog.close();
            dialog.remove();
            resolve(answer);
        };
        yes.addEventListener('click', () => done(true));
        no.addEventListener('click', () => done(false));
        dialog.addEventListener('cancel', e => { e.preventDefault(); done(false); });
        document.body.append(dialog);
        dialog.showModal();
        no.focus();
    });
}

async function main(): Promise<void> {
    const config = readConfig();
    if (!config.apiOrigin) return say(COPY.noBackend);
    const identity = createIdentity(config);
    if (!identity.account) return say(COPY.noSignIn);
    const api = createApi(config, identity);
    const session = new AccountSession(identity.account);
    let shown = 0;

    const show = async (): Promise<void> => {
        const turn = ++shown;
        const state = await session.refresh().catch(() => null);
        if (turn !== shown) return;
        if (!state) return say(COPY.unavailable, { label: 'Try again', run: () => void show() });
        if (state.kind !== 'google') return say(COPY.signIn, { label: 'Sign in with Google', run: () => void signIn() });
        const epoch = state.epoch;
        const mine = () => turn === shown && session.current.epoch === epoch;
        say(COPY.loading);
        let account = await readAccount(api);
        if (account.kind === 'none') account = await bootstrapAccount(api);
        const page = account.kind === 'account' ? await listWorlds(api) : null;
        const usage = page ? await readUsage(api) : null;
        if (!mine()) return;
        if (!page) return say(COPY.unavailable, { label: 'Try again', run: () => void show() });
        const history = renderHistory(root, page, usage, {
            rename: (world, title) => renameWorld(api, world, title),
            remove: world => deleteWorld(api, world, crypto.randomUUID()),
            reread: async world => {
                const now = await readWorld(api, world.worldId);
                return typeof now === 'string' ? null : now;
            },
            more: cursor => listWorlds(api, { cursor }),
            confirm: confirmDialog,
            removed: () => { void readUsage(api).then(u => { if (mine()) history.usage(u); }); },
        });
    };

    const signIn = async (): Promise<void> => {
        const outcome: LinkOutcome = await session.linkGoogle().catch(() => ({ kind: 'failed', code: 'threw' }) as const);
        if (outcome.kind === 'collision') {
            return say(COPY.collision, { label: 'Sign in to that account', run: () => { void session.signInExisting(outcome.collision).then(() => show()); } });
        }
        if (outcome.kind === 'failed') return say(COPY.signInFailed, { label: 'Sign in with Google', run: () => void signIn() });
        await show();
    };

    // Another account, a sign-out, another tab's: the page is read again for whoever is signed in now.
    session.subscribe(() => { void show(); });
    await show();
}

void main();
