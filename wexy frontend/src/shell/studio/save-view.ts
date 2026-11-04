// The world on the stage's save, as the creator reads it (W3.6; the creations platform companion §7, §9's "Studio save
// status" row and §12): beside the world's title, "Saving…", "Saved", or "Not saved" with what to do, one action at a
// time (save-controller.ts decides; this only says). Twice, as the account's chip is: in the header beside the title on
// wide screens, and as a line under the idea box where the header has no title (≤1020 px); the CSS shows one, so one is
// announced. Every word is the copy module's; nothing here is markup from anywhere else.

import { COPY } from '../../loop/copy';
import type { SaveState } from '../../platform/save-controller';
import { h } from '../../shared/dom';

/** What a creator can do about a save: `retry` ("Try again"), `save` (after another account signed in), and the rest. */
export type SaveAction = 'retry' | 'save' | 'sign-in' | 'save-as-new' | 'open-saved' | 'your-worlds';

/** One save state in the creator's words. */
export interface SaveLine {
    /** busy while it saves; ok once saved; warn when it is not. */
    readonly tone: 'busy' | 'ok' | 'warn';
    readonly text: string;
    /** The whole sentence: what happened and what to do. Empty when the word says it all. */
    readonly why: string;
    readonly actions: readonly SaveAction[];
}

/** `state` in the creator's words; null when there is nothing to say (no world of the creator's on the stage). */
export function saveLine(state: SaveState | null): SaveLine | null {
    if (!state) return null;
    switch (state.status) {
        case 'idle': return null;
        case 'saving': return { tone: 'busy', text: COPY.save.saving, why: '', actions: [] };
        case 'saved': return { tone: 'ok', text: COPY.save.saved, why: '', actions: ['your-worlds'] };
        case 'sign-in': return { tone: 'warn', text: COPY.save.notSaved, why: COPY.save.signInWhy, actions: ['sign-in'] };
        // "Open the saved one" only when there is one: a revision's conflict (another tab moved its head). A new world's
        // 409 (its key used for another body) has no saved world to open, and no button stands for nothing (§10).
        case 'conflict': return { tone: 'warn', text: COPY.save.conflict, why: COPY.save.conflictWhy, actions: state.worldId ? ['save-as-new', 'open-saved'] : ['save-as-new'] };
        case 'storage-full': return { tone: 'warn', text: COPY.save.full, why: COPY.save.fullWhy, actions: ['your-worlds', 'retry'] };
        case 'too-large': return { tone: 'warn', text: COPY.save.tooLarge, why: COPY.save.tooLargeWhy, actions: [] };
        case 'not-saved': return { tone: 'warn', text: COPY.save.notSaved, why: COPY.save.notSavedWhy, actions: ['save'] };
        case 'offline': return { tone: 'warn', text: COPY.save.offline, why: COPY.save.offlineWhy, actions: ['retry'] };
        case 'failed': return { tone: 'warn', text: COPY.save.notSaved, why: COPY.save.failedWhy, actions: ['retry'] };
    }
}

/** What the view's buttons do: the studio's (main.ts), over the save controller and the account. */
export interface SaveViewActions {
    retry(): void;
    saveAsNew(): void;
    /** "Open the saved one" after a conflict: the saved head, once the creator confirms the stage's world goes. */
    openSaved(worldId: string): void;
    signIn(): void;
}

/** The history's address: where a world is renamed or deleted, and room is made. */
export const CREATIONS = '/creations';

export class SaveView {
    /** Beside the title in the header. */
    readonly el = h('div', { class: 'save-status', hidden: true });
    /** The same under the idea box, for screens whose header has no title. */
    readonly line = h('div', { class: 'save-status save-line', hidden: true });
    private readonly actions: SaveViewActions;
    private shown = '';

    constructor(actions: SaveViewActions) {
        this.actions = actions;
    }

    render(state: SaveState | null): void {
        const line = saveLine(state);
        // Drawn again only when what it says changes, so a screen reader hears each state once.
        const key = line ? `${line.tone}|${line.text}|${line.actions.join(',')}|${state?.worldId ?? ''}` : '';
        if (key === this.shown) return;
        this.shown = key;
        for (const root of [this.el, this.line]) this.fill(root, line, state?.worldId ?? null);
    }

    private fill(root: HTMLElement, line: SaveLine | null, worldId: string | null): void {
        root.hidden = !line;
        if (!line) {
            root.replaceChildren();
            return;
        }
        root.dataset.tone = line.tone;
        root.title = line.why;
        root.replaceChildren(
            h('i', { class: 'save-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'save-text', role: 'status' }, line.text, line.why ? h('span', { class: 'sr-only' }, ` ${line.why}`) : null),
            ...line.actions.map(a => this.control(a, worldId)),
        );
    }

    private control(action: SaveAction, worldId: string | null): HTMLElement {
        if (action === 'your-worlds') return h('a', { class: 'save-link', href: CREATIONS }, COPY.save.yourWorlds);
        const label = action === 'retry' ? COPY.save.tryAgain : action === 'save' ? COPY.save.save : action === 'sign-in' ? COPY.save.signIn
            : action === 'save-as-new' ? COPY.save.saveAsNew : COPY.save.openSaved;
        const button = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, label);
        button.addEventListener('click', () => {
            switch (action) {
                case 'retry':
                case 'save': this.actions.retry(); return;
                case 'sign-in': this.actions.signIn(); return;
                case 'save-as-new': this.actions.saveAsNew(); return;
                case 'open-saved': if (worldId) this.actions.openSaved(worldId); return;
            }
        });
        return button;
    }
}
