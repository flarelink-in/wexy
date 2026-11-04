// The studio's account control (W1; the creations platform companion §6, §9): the allowance chip, Sign in with Google
// and Sign out in the header, and the dialogs a refusal or a link collision opens. Every string is set as text (design
// guidelines §8), the chip says only what the server said (I13), and nothing here touches the world on the stage or
// the idea in the box: a refusal, a cancelled sign-in or a collision leaves both as they were (F2).
//
// When the chip shows: once the creator has an identity in this page, after their first Create or a Sign in, never on
// page load. Loading Firebase starts App Check's reCAPTCHA and an anonymous sign-in, which a page view must not spend
// (Firebase allows 100 new accounts an hour per IP); so a fresh visitor sees Sign in alone.
//
// W2 (the companion §6.3, §9): signed in with Google, the creator has a Wexy account. After a sign-in the studio sets it
// up (POST /v1/me, once); whenever else it learns of a Google session, it reads it (GET /v1/me, and sets it up on a
// 404: a creator who signed in before W2). The header says `@handle` once one is claimed, and offers "Choose a handle"
// until then. A browser that held a Google session shows all this on a reload at once (the session's one-bit hint, the
// user's choice); anyone else's page view still loads nothing. The account is one epoch's: any change of who is signed
// in drops it (F4).

import type { Api } from '../../forge-client/http';
import type { Collision, LinkOutcome } from '../../forge-client/identity';
import { COPY } from '../../loop/copy';
import type { CreationAccount } from '../../loop/creation';
import { chipText, readAllowance } from '../../platform/allowance';
import { bootstrapAccount, claimHandle, readAccount, typedHandle, type AccountRead, type AccountView, type ClaimOutcome } from '../../platform/client';
import { STALE, type AccountSession, type SessionState } from '../../platform/session';
import { h } from '../../shared/dom';

/** Why the limit dialog opens: the anonymous allowance spent, or early access's world of the day made. */
export type LimitKind = 'allowance' | 'quota';

/**
 * How long an account call may take, from its token and App Check to its answer's last byte (the W2 review): the
 * backend's own API bound (its §11, 20 s) less a margin. Past it the account is unavailable, and the next Create asks
 * again.
 */
export const ACCOUNT_DEADLINE_MS = 15_000;

export interface AccountControlOptions {
    /** {@link ACCOUNT_DEADLINE_MS} unless a test says otherwise. */
    readonly accountDeadlineMs?: number;
}

export class AccountControl {
    readonly el: HTMLElement;
    private readonly chip = h('span', { class: 'account-chip', role: 'status', hidden: true });
    /**
     * The chip's words as a line under the idea box, for phones (the user's choice, 2026-11-02): their header has room
     * for Sign in and Make video only. The studio places it; the CSS shows one of the two, so one is announced. Since W2
     * it starts with the creator's @handle once there is one, which the phone header has no room for either.
     */
    readonly line = h('p', { class: 'account-line', role: 'status', hidden: true });
    /** W2: "Choose a handle" beside that line, for phones; the studio places it after the line. */
    readonly lineClaim = h('button', { type: 'button', class: 'btn btn-sm btn-quiet account-line-claim', hidden: true }, COPY.account.chooseHandle);
    private readonly who = h('span', { class: 'account-who', hidden: true }, COPY.account.signedIn);
    private readonly claimBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet account-claim', hidden: true }, COPY.account.chooseHandle);
    private readonly signInBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': COPY.account.signIn },
        h('span', { class: 'acct-long' }, COPY.account.signIn), h('span', { class: 'acct-short' }, COPY.account.signInShort));
    private readonly signOutBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', hidden: true }, COPY.account.signOut);
    private readonly dialog = new AccountDialog();
    private readonly handleDialog = new HandleDialog(raw => void this.claim(raw));
    private readonly off: () => void;
    /** A world is being made: no identity change until it is done. */
    private building = false;
    /** A sign-in, a sign-out or a collision's sign-in is under way. */
    private working = false;
    /** A handle's claim is under way. */
    private claiming = false;
    private reads = 0;
    /** The allowance's words as the chip shows them, or null while the chip is hidden. */
    private chipWords: string | null = null;
    /** The signed-in creator's account (W2), this epoch's alone; null when unknown or not a Google session. */
    private account: AccountView | null = null;
    private accountReads = 0;
    /** An account read or set-up is under way (the latest one). */
    private accountLoading = false;
    /** The platform's set-up answered 404: no route leads to it, so this page asks no more (the independent review). */
    private platformAbsent = false;
    /** The epoch and account the open claim dialog was opened for: it claims for that account or for none. */
    private claimFor: { readonly epoch: number; readonly accountId: string } | null = null;
    private readonly session: AccountSession;
    private readonly api: Api;
    private readonly say: (text: string) => void;
    private readonly onChanging: (changing: boolean) => void;
    private readonly deadlineMs: number;

    /** `onChanging` hears when an account change starts and ends, so the studio can hold Create meanwhile. */
    constructor(session: AccountSession, api: Api, say: (text: string) => void, onChanging: (changing: boolean) => void = () => {},
                options: AccountControlOptions = {}) {
        this.session = session;
        this.api = api;
        this.say = say;
        this.onChanging = onChanging;
        this.deadlineMs = options.accountDeadlineMs ?? ACCOUNT_DEADLINE_MS;
        this.el = h('div', { class: 'account', 'aria-label': 'Account' }, this.chip, this.who, this.claimBtn, this.signInBtn, this.signOutBtn);
        this.signInBtn.addEventListener('click', () => void this.signIn());
        this.signOutBtn.addEventListener('click', () => void this.signOut());
        this.claimBtn.addEventListener('click', () => this.openClaim());
        this.lineClaim.addEventListener('click', () => this.openClaim());
        this.off = session.subscribe(state => {
            // F4 (the W2 review): whoever is signed in now, the last one's account, its allowance's words (I13: another
            // caller's limits are never shown, the independent review) and any claim opened for it go at once, before
            // anything of the new one is read; Google to Google included.
            this.dropAccount();
            this.dropAllowance();
            this.render(state);
            void this.readAllowance();
            void this.loadAccount(false);
        });
        this.render(session.current);
    }

    /**
     * After an entry call (Create): it made or found an identity, so who it is and what is left can be read. A Google
     * session whose account could not be read before (the platform unreachable at the sign-in) is read again too.
     */
    async afterEntry(): Promise<void> {
        try {
            await this.session.refresh();
            if (this.session.current.kind === 'google' && !this.account && !this.accountLoading) void this.loadAccount(false);
            await this.readAllowance();
        } catch {
            // No identity to read (the network, a blocked storage): the chip stays as it was.
        }
    }

    /**
     * On a page load (W2): a browser that held a Google session reads who is signed in, so its account and allowance
     * show at once. Without the hint nothing loads, as W1 decided for every page view.
     */
    async restore(): Promise<void> {
        if (this.session.hinted) await this.afterEntry();
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

    /**
     * The signed-in creator's account as a save needs it (W3.6; the companion §7 step 3): `active` once read and ACTIVE,
     * `inactive` when read and not, `unknown` while not read (being set up after a sign-in, or unreachable), and for
     * anyone not signed in with Google.
     */
    get saveKind(): 'active' | 'inactive' | 'unknown' {
        const account = this.session.current.kind === 'google' ? this.account : null;
        if (!account) return 'unknown';
        return account.status === 'ACTIVE' ? 'active' : 'inactive';
    }

    /** Called whenever the account shown changes (read, set up, dropped): the studio's save hears it (W3.6). */
    onAccount: (() => void) | null = null;

    /**
     * Whether a world written and waiting for Show it would be discarded by an account change (Q129, the user, 2026-11-04):
     * then Sign out, and a collision's sign-in to another account, ask first. The studio says; absent, nothing waits.
     */
    unshownWorld: (() => boolean) | null = null;
    /** The confirmation's "Show it first": the studio's Show it for that world (the creator's press, the GPU go). */
    showUnshown: (() => void) | null = null;

    /** "Sign in to keep this world" (W3.6): the header's own Sign in, so its dialogs and its waits are the same. */
    signInToSave(): void {
        void this.signIn();
    }

    dispose(): void {
        this.off();
        this.dialog.el.remove();
        this.handleDialog.el.remove();
        this.line.remove();
        this.lineClaim.remove();
    }

    private signIn(): Promise<void> {
        return this.act(async () => this.settle(await this.session.linkGoogle()));
    }

    private signOut(): Promise<void> {
        // A world waiting for Show it is this account's: signing out discards it, so the creator chooses first (Q129).
        // Escape, or closing the dialog, keeps both the account and the world.
        if (this.unshownWorld?.()) {
            this.dialog.open(COPY.account.unshownSignOutTitle, COPY.account.unshownSignOutBody, [
                { label: COPY.account.showFirst, run: () => this.showUnshown?.() },
                { label: COPY.account.unshownSignOutGo, quiet: true, run: () => void this.signOutNow(true) },
            ]);
            return Promise.resolve();
        }
        return this.signOutNow();
    }

    /** `discarding`: the creator chose to discard a world waiting for Show it, which the toast then says, not "still here". */
    private signOutNow(discarding = false): Promise<void> {
        return this.act(async () => {
            await this.session.signOut();
            // Another tab may have signed someone in meanwhile: then nobody was signed out, as the creator sees it.
            if (this.session.current.kind !== 'google') this.say(discarding ? COPY.account.signedOutDiscarded : COPY.account.signedOut);
        });
    }

    /** A collision's sign-in to the account that holds the credential: another uid, so it asks first as Sign out does. */
    private signInExisting(collision: Collision): void {
        const go = () => void this.act(async () => this.settle(await this.session.signInExisting(collision)));
        if (!this.unshownWorld?.()) return go();
        this.dialog.open(COPY.account.unshownSignInTitle, COPY.account.unshownSignInBody, [
            { label: COPY.account.showFirst, run: () => this.showUnshown?.() },
            { label: COPY.account.unshownSignInGo, quiet: true, run: go },
        ]);
    }

    /**
     * One account change at a time, never while a world is being made (the W1 review, 2026-11-02) or a handle is being
     * claimed (the W2 review): Sign in, Sign out and a collision's sign-in all run here, so none switches the identity
     * under a world's calls or a claim; Create waits on {@link changing} the other way round.
     */
    private async act(change: () => Promise<void>): Promise<void> {
        if (this.working || this.building || this.claiming) return;
        this.setWorking(true);
        try {
            await change();
        } catch {
            this.say(COPY.account.failed);
        } finally {
            this.setWorking(false);
            // A read the session's change asked for while this one ran was left to it (loadAccount); a change that
            // ended without a set-up (cancelled, failed, or another tab's sign-in under it) reads the account now.
            if (this.session.current.kind === 'google' && !this.account && !this.accountLoading) void this.loadAccount(false);
        }
    }

    private setWorking(working: boolean): void {
        this.working = working;
        this.render(this.session.current);
        this.onChanging(working);
    }

    /**
     * What a sign-in came to: a link or a sign-in sets the account up (W2, POST /v1/me); a collision asks the creator; a
     * cancel says nothing; the rest is said in a toast. The set-up runs after the change, not inside it (the W2 review):
     * the identity is settled once Firebase has answered, so a slow platform never holds Create or Sign out.
     */
    private async settle(outcome: LinkOutcome): Promise<void> {
        switch (outcome.kind) {
            case 'linked':
            case 'signed-in':
                void this.loadAccount(true);
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
                    { label: COPY.account.collisionGo, run: () => this.signInExisting(outcome.collision) },
                    { label: COPY.account.cancel, quiet: true },
                ]);
        }
    }

    /** The server's allowance for whoever is signed in now; an answer for an account that has changed meanwhile is dropped. */
    private async readAllowance(): Promise<void> {
        const { kind } = this.session.current;
        if (kind !== 'anonymous' && kind !== 'google') {
            this.chip.hidden = true;
            this.chipWords = null;
            this.renderLine();
            return;
        }
        const read = ++this.reads;
        const answer = await this.session.guard(() => readAllowance(this.api, AbortSignal.timeout(this.deadlineMs))).catch(() => null);
        if (answer === STALE || read !== this.reads) return;
        const text = chipText(answer);
        this.chip.textContent = text;
        this.chip.hidden = false;
        // The whole text on hover too, should a narrow header cut it.
        this.chip.title = text;
        this.chipWords = text;
        this.renderLine();
    }

    /**
     * The last account's view goes (F4; the W2 review): its handle, its read under way, and the claim dialog opened
     * for it. The dialog's binding ({@link claimFor}) stays: should a claim still come from it once the next account
     * is known, the binding refuses it, so what was typed for one account is never sent for another.
     */
    private dropAccount(): void {
        this.account = null;
        this.accountReads++;
        this.accountLoading = false;
        this.handleDialog.close();
    }

    /** The last caller's allowance words go, chip and phone line, and a read of them under way is dropped. */
    private dropAllowance(): void {
        this.reads++;
        this.chip.hidden = true;
        this.chip.textContent = '';
        this.chip.title = '';
        this.chipWords = null;
        this.renderLine();
    }

    /**
     * The signed-in creator's account (W2): set up after a sign-in (`bootstrap`), else read, and set up on a 404. Not a
     * Google session: none, dropped at once. A sign-in under way sets the account up itself when it settles, so the
     * session's change during it reads nothing. An answer for an account that has changed meanwhile is dropped (F4).
     * The whole of it, the read and a set-up after it, token and attestation included, has one deadline (the W2
     * review): past it the account is unavailable, and the next Create asks again.
     */
    private async loadAccount(bootstrap: boolean): Promise<void> {
        if (this.session.current.kind !== 'google') {
            this.dropAccount();
            this.renderAccount();
            return;
        }
        if (this.working && !bootstrap) return;
        // No route leads to the platform (its set-up answered 404): asked once a page, not at every Create.
        if (this.platformAbsent) return;
        const read = ++this.accountReads;
        this.accountLoading = true;
        const signal = AbortSignal.timeout(this.deadlineMs);
        const answer = await this.session.guard(async (): Promise<AccountRead> => {
            if (bootstrap) return bootstrapAccount(this.api, signal);
            const found = await readAccount(this.api, signal);
            return found.kind === 'none' ? bootstrapAccount(this.api, signal) : found;
        }).catch((): AccountRead => ({ kind: 'unavailable' }));
        if (read === this.accountReads) this.accountLoading = false;
        if (answer === STALE || read !== this.accountReads) return;
        if (answer.kind === 'absent') this.platformAbsent = true;
        this.account = answer.kind === 'account' ? answer.account : null;
        this.renderAccount();
    }

    private openClaim(): void {
        if (!this.account || this.working || this.claiming) return;
        this.claimFor = { epoch: this.session.current.epoch, accountId: this.account.accountId };
        this.handleDialog.open();
    }

    /**
     * Claims the handle typed, at the version the account was read at, for the account the dialog was opened for and
     * no other: a dialog that outlived its epoch or its account claims nothing (the W2 review), and the request names
     * the account, which the server checks against the caller's. Refused here when its shape is wrong; otherwise the
     * server decides, and its answer is said in the dialog, which stays open until the claim is made or the creator
     * leaves. A claim made in another tab meanwhile is shown, not fought.
     */
    private async claim(raw: string): Promise<void> {
        const account = this.account;
        const bound = this.claimFor;
        if (!account || !bound || this.claiming) return;
        if (bound.epoch !== this.session.current.epoch || bound.accountId !== account.accountId) {
            this.claimFor = null;
            this.handleDialog.close();
            return;
        }
        const handle = typedHandle(raw);
        if (!handle) {
            this.handleDialog.error(COPY.account.handleRule);
            return;
        }
        this.claiming = true;
        this.render(this.session.current);
        this.handleDialog.busy(true);
        try {
            const signal = AbortSignal.timeout(this.deadlineMs);
            const outcome = await this.session.guard(() => claimHandle(this.api, account, handle, signal))
                .catch((): ClaimOutcome => ({ kind: 'unavailable' }));
            if (outcome === STALE) {
                this.handleDialog.close();
                return;
            }
            switch (outcome.kind) {
                case 'claimed':
                    this.account = outcome.account;
                    this.claimFor = null;
                    this.handleDialog.close();
                    this.say(COPY.account.handleClaimed(outcome.account.profile.handle ?? handle));
                    return;
                case 'stale':
                    this.account = outcome.account;
                    if (outcome.account.profile.handle) {
                        this.claimFor = null;
                        this.handleDialog.close();
                    } else {
                        this.handleDialog.error(COPY.account.handleRetry);
                    }
                    return;
                case 'taken':
                    this.handleDialog.error(COPY.account.handleTaken);
                    return;
                case 'refused':
                    this.handleDialog.error(COPY.account.handleReserved);
                    return;
                case 'forbidden':
                    this.handleDialog.error(COPY.account.handleForbidden);
                    return;
                default:
                    this.handleDialog.error(COPY.account.handleUnavailable);
            }
        } finally {
            this.claiming = false;
            this.handleDialog.busy(false);
            this.render(this.session.current);
        }
    }

    /** The buttons for `state`. The chip and its phone line are readAllowance's alone, which every change of account reaches. */
    private render(state: SessionState): void {
        const google = state.kind === 'google';
        this.who.hidden = !google;
        this.signInBtn.hidden = google;
        this.signOutBtn.hidden = !google;
        this.signInBtn.disabled = this.working || this.building || this.claiming;
        this.signOutBtn.disabled = this.working || this.building || this.claiming;
        this.renderAccount();
    }

    /** The account's part of the header (W2): `@handle`, or "Choose a handle" while an active account has none. */
    private renderAccount(): void {
        const account = this.session.current.kind === 'google' ? this.account : null;
        const handle = account?.profile.handle ?? null;
        this.who.textContent = handle ? `@${handle}` : COPY.account.signedIn;
        const claimable = !!account && account.status === 'ACTIVE' && handle === null;
        for (const button of [this.claimBtn, this.lineClaim]) {
            button.hidden = !claimable;
            button.disabled = this.working || this.claiming;
        }
        if (!account) this.handleDialog.close();
        this.renderLine();
        this.onAccount?.();
    }

    /** The phone's line: the chip's words, after the @handle once there is one. */
    private renderLine(): void {
        if (this.chipWords === null) {
            this.line.textContent = '';
            this.line.hidden = true;
            return;
        }
        const handle = this.session.current.kind === 'google' ? this.account?.profile.handle ?? null : null;
        this.line.textContent = handle ? `@${handle} · ${this.chipWords}` : this.chipWords;
        this.line.hidden = false;
    }
}

/**
 * The account as a creation needs it (EA9.1; agent-first-studio-design.md §6), over the session and this control: E_auth,
 * whether a caller is established, the entry's own caller made first when none is (`enter`), Create waiting while the
 * account changes, W1's dialog and the read after an entry. One wiring, the studio's and its tests'.
 */
export function creationAccount(session: AccountSession, control: Pick<AccountControl, 'changing' | 'afterEntry' | 'limit'>): CreationAccount {
    return {
        epoch: () => session.current.epoch,
        uid: () => session.caller()?.uid ?? null,
        established: () => session.established,
        enter: async () => {
            try {
                await session.enter();
            } catch (error) {
                console.warn('Wexy: no caller could be made or found for this Create, so it sent nothing.', error);
                throw error;
            }
        },
        changing: () => control.changing,
        subscribe: listener => session.subscribe(() => listener()),
        afterEntry: () => control.afterEntry(),
        limit: (kind, sentence) => control.limit(kind, sentence),
    };
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

/**
 * The handle's dialog (W2): a labelled field after an `@`, the rule and that a handle is for good, an error line the
 * screen reader hears, Claim and Not now. It stays open on a refusal, so the creator can try another; Escape or Not now
 * leaves, focus back where it came from. What the creator types is a value, shown nowhere as markup.
 */
class HandleDialog {
    readonly el: HTMLDialogElement;
    private readonly input = h('input', {
        type: 'text', id: 'acct-handle', class: 'acct-input', maxlength: '31', autocomplete: 'off', autocapitalize: 'none',
        spellcheck: 'false', 'aria-describedby': 'acct-handle-hint acct-handle-error',
    });
    private readonly errorLine = h('p', { id: 'acct-handle-error', class: 'acct-error', role: 'alert', hidden: true });
    private readonly claimBtn = h('button', { type: 'button', class: 'btn btn-sm' }, COPY.account.claim);
    private readonly cancelBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, COPY.account.notNow);
    private opener: HTMLElement | null = null;

    constructor(submit: (raw: string) => void) {
        this.el = h('dialog', { class: 'account-dialog', 'aria-labelledby': 'acct-handle-title' },
            h('h2', { id: 'acct-handle-title' }, COPY.account.handleTitle),
            h('label', { class: 'acct-label', for: 'acct-handle' }, COPY.account.handleLabel),
            h('div', { class: 'acct-field' }, h('span', { class: 'acct-at', 'aria-hidden': 'true' }, '@'), this.input),
            h('p', { id: 'acct-handle-hint', class: 'acct-body' }, COPY.account.handleHint),
            this.errorLine,
            h('div', { class: 'acct-actions' }, this.claimBtn, this.cancelBtn));
        this.claimBtn.addEventListener('click', () => submit(this.input.value));
        this.input.addEventListener('keydown', event => {
            if ((event as KeyboardEvent).key !== 'Enter') return;
            event.preventDefault();
            submit(this.input.value);
        });
        this.cancelBtn.addEventListener('click', () => this.close());
        this.el.addEventListener('close', () => {
            this.opener?.focus?.();
            this.opener = null;
        });
        document.body.append(this.el);
    }

    open(): void {
        if (this.el.open) return;
        this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.input.value = '';
        this.error(null);
        this.el.showModal();
        this.input.focus();
    }

    close(): void {
        if (this.el.open) this.el.close();
    }

    /** The refusal's sentence under the field, or none. */
    error(text: string | null): void {
        this.errorLine.textContent = text ?? '';
        this.errorLine.hidden = text === null;
        if (text === null) this.input.removeAttribute('aria-invalid');
        else this.input.setAttribute('aria-invalid', 'true');
    }

    busy(busy: boolean): void {
        this.claimBtn.disabled = busy;
    }
}
