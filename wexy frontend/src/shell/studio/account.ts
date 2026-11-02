// The studio's account control (W1; the creations platform companion §6, §9): the allowance chip, Sign in with Google
// and Sign out in the header, and the dialogs a refusal or a link collision opens. Every string is set as text (design
// guidelines §8), the chip says only what the server said (I13), and nothing here touches the world on the stage or
// the idea in the box: a refusal, a cancelled sign-in or a collision leaves both as they were (F2).
//
// When the chip shows: once the creator has an identity in this page, after their first Create or a Sign in, never on
// page load. Loading Firebase starts App Check's reCAPTCHA and an anonymous sign-in, which a page view must not spend
// (Firebase allows 100 new accounts an hour per IP); so a fresh visitor sees Sign in alone.

import type { Api } from '../../forge-client/http';
import type { LinkOutcome } from '../../forge-client/identity';
import { COPY } from '../../loop/copy';
import { chipText, readAllowance } from '../../platform/allowance';
import { STALE, type AccountSession, type SessionState } from '../../platform/session';
import { h } from '../../shared/dom';

/** Why the limit dialog opens: the anonymous allowance spent, or early access's world of the day made. */
export type LimitKind = 'allowance' | 'quota';

export class AccountControl {
    readonly el: HTMLElement;
    private readonly chip = h('span', { class: 'account-chip', role: 'status', hidden: true });
    /**
     * The chip's words as a line under the idea box, for phones (the user's choice, 2026-11-02): their header has room
     * for Sign in and Make video only. The studio places it; the CSS shows one of the two, so one is announced.
     */
    readonly line = h('p', { class: 'account-line', role: 'status', hidden: true });
    private readonly who = h('span', { class: 'account-who', hidden: true }, COPY.account.signedIn);
    private readonly signInBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': COPY.account.signIn },
        h('span', { class: 'acct-long' }, COPY.account.signIn), h('span', { class: 'acct-short' }, COPY.account.signInShort));
    private readonly signOutBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', hidden: true }, COPY.account.signOut);
    private readonly dialog = new AccountDialog();
    private readonly off: () => void;
    /** A world is being made: no identity change until it is done. */
    private building = false;
    /** A sign-in, a sign-out or a collision's sign-in is under way. */
    private working = false;
    private reads = 0;
    private readonly session: AccountSession;
    private readonly api: Api;
    private readonly say: (text: string) => void;
    private readonly onChanging: (changing: boolean) => void;

    /** `onChanging` hears when an account change starts and ends, so the studio can hold Create meanwhile. */
    constructor(session: AccountSession, api: Api, say: (text: string) => void, onChanging: (changing: boolean) => void = () => {}) {
        this.session = session;
        this.api = api;
        this.say = say;
        this.onChanging = onChanging;
        this.el = h('div', { class: 'account', 'aria-label': 'Account' }, this.chip, this.who, this.signInBtn, this.signOutBtn);
        this.signInBtn.addEventListener('click', () => void this.signIn());
        this.signOutBtn.addEventListener('click', () => void this.signOut());
        this.off = session.subscribe(state => {
            this.render(state);
            void this.readAllowance();
        });
        this.render(session.current);
    }

    /** After an entry call (Create): it made or found an identity, so who it is and what is left can be read. */
    async afterEntry(): Promise<void> {
        try {
            await this.session.refresh();
            await this.readAllowance();
        } catch {
            // No identity to read (the network, a blocked storage): the chip stays as it was.
        }
    }

    /** A refused entry call: the limit dialog, with Sign in for a spent anonymous allowance; nothing else changes. */
    limit(kind: LimitKind, sentence: string): void {
        if (kind === 'allowance') {
            this.dialog.open(COPY.account.allowanceTitle, sentence, [
                { label: COPY.account.signIn, run: () => void this.signIn() },
                { label: COPY.account.notNow, quiet: true },
            ]);
        } else {
            this.dialog.open(COPY.account.quotaTitle, sentence, [{ label: COPY.account.ok }]);
        }
        void this.readAllowance();
    }

    /** While a world is being made, the account stays as it is: Sign in and Sign out wait. */
    setBusy(busy: boolean): void {
        this.building = busy;
        this.render(this.session.current);
    }

    /** An account change is under way: a live world must not start until it ends (its calls are one identity's). */
    get changing(): boolean {
        return this.working;
    }

    dispose(): void {
        this.off();
        this.dialog.el.remove();
        this.line.remove();
    }

    private signIn(): Promise<void> {
        return this.act(async () => this.settle(await this.session.linkGoogle()));
    }

    private signOut(): Promise<void> {
        return this.act(async () => {
            await this.session.signOut();
            this.say(COPY.account.signedOut);
        });
    }

    /**
     * One account change at a time, never while a world is being made (the W1 review, 2026-11-02): Sign in, Sign out and
     * a collision's sign-in all run here, so none switches the identity under a world's calls; Create waits on
     * {@link changing} the other way round.
     */
    private async act(change: () => Promise<void>): Promise<void> {
        if (this.working || this.building) return;
        this.setWorking(true);
        try {
            await change();
        } catch {
            this.say(COPY.account.failed);
        } finally {
            this.setWorking(false);
        }
    }

    private setWorking(working: boolean): void {
        this.working = working;
        this.render(this.session.current);
        this.onChanging(working);
    }

    /** What a sign-in came to: a collision asks the creator; a cancel says nothing; the rest is said in a toast. */
    private async settle(outcome: LinkOutcome): Promise<void> {
        switch (outcome.kind) {
            case 'linked':
            case 'signed-in':
                return;
            case 'cancelled':
                return;
            case 'blocked':
                this.say(COPY.account.blocked);
                return;
            case 'failed':
                this.say(COPY.account.failed);
                return;
            case 'collision':
                this.dialog.open(COPY.account.collisionTitle, COPY.account.collisionBody, [
                    {
                        label: COPY.account.collisionGo,
                        run: () => void this.act(async () => this.settle(await this.session.signInExisting(outcome.collision))),
                    },
                    { label: COPY.account.cancel, quiet: true },
                ]);
        }
    }

    /** The server's allowance for whoever is signed in now; an answer for an account that has changed meanwhile is dropped. */
    private async readAllowance(): Promise<void> {
        const { kind } = this.session.current;
        if (kind !== 'anonymous' && kind !== 'google') {
            this.chip.hidden = true;
            this.line.hidden = true;
            return;
        }
        const read = ++this.reads;
        const answer = await this.session.guard(() => readAllowance(this.api)).catch(() => null);
        if (answer === STALE || read !== this.reads) return;
        const text = chipText(answer);
        for (const el of [this.chip, this.line]) {
            el.textContent = text;
            el.hidden = false;
        }
        // The whole text on hover too, should a narrow header cut it.
        this.chip.title = text;
    }

    /** The buttons for `state`. The chip and its phone line are readAllowance's alone, which every change of account reaches. */
    private render(state: SessionState): void {
        const google = state.kind === 'google';
        this.who.hidden = !google;
        this.signInBtn.hidden = google;
        this.signOutBtn.hidden = !google;
        this.signInBtn.disabled = this.working || this.building;
        this.signOutBtn.disabled = this.working || this.building;
    }
}

interface DialogAction {
    label: string;
    run?: () => void;
    quiet?: boolean;
}

/**
 * One small dialog for the account's questions: labelled, closed by Escape (the native dialog), focus back where it
 * came from (design guidelines §8). Text only; no action is the accent, which is Create's and the export's (§1).
 */
class AccountDialog {
    readonly el: HTMLDialogElement;
    private readonly title = h('h2', { id: 'acct-title' });
    private readonly body = h('p', { class: 'acct-body' });
    private readonly actions = h('div', { class: 'acct-actions' });
    private opener: HTMLElement | null = null;

    constructor() {
        this.el = h('dialog', { class: 'account-dialog', 'aria-labelledby': 'acct-title' }, this.title, this.body, this.actions);
        this.el.addEventListener('close', () => {
            this.opener?.focus?.();
            this.opener = null;
        });
        document.body.append(this.el);
    }

    open(title: string, body: string, actions: DialogAction[]): void {
        if (this.el.open) this.el.close();
        this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.title.textContent = title;
        this.body.textContent = body;
        this.actions.replaceChildren(...actions.map(a => {
            const button = h('button', { type: 'button', class: a.quiet ? 'btn btn-sm btn-quiet' : 'btn btn-sm' }, a.label);
            button.addEventListener('click', () => {
                this.el.close();
                a.run?.();
            });
            return button;
        }));
        this.el.showModal();
        (this.actions.firstElementChild as HTMLElement | null)?.focus();
    }
}
