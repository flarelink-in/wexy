// The history, `/creations` (W3.5; the creations platform companion §9's /creations row): a signed-in creator's saved
// worlds, the newest made first, each to rename or delete, and the account's usage. Every string a creator or a server
// wrote (a title above all) goes into the page as text, never as markup (P7, PL-FE6): `h()` appends strings as text
// nodes, and nothing here uses its `html` attribute. A world this build can open is opened in the studio by its id
// (W3.6: `/studio.html?create=agent&world=<id>`, the studio's own Show it then the GPU go); one it cannot says so, and
// offers no Open. The page's own wiring (main.ts) hands the calls in, so this runs under node --test with a DOM shim.

import { opensLine } from '../../platform/lines';
import { worldLink } from '../studio/creation-path';
import type { DeleteAnswer, EditAnswer, WorldPage, WorldUsage, WorldView } from '../../platform/worlds';
import { h } from '../../shared/dom';

/** What the history asks of the page: the calls, and a confirmation the creator answers. */
export interface HistoryActions {
    rename(world: WorldView, title: string): Promise<EditAnswer>;
    remove(world: WorldView): Promise<DeleteAnswer>;
    /**
     * The world as it is now, after a conflict: `missing` when it is gone (or another's), `unavailable` when it cannot be
     * read just now, which never takes it off the list (W3's review, its low).
     */
    reread(world: WorldView): Promise<WorldView | 'missing' | 'unavailable'>;
    more(cursor: string): Promise<WorldPage | null>;
    confirm(question: string): Promise<boolean>;
    /** A world left the list: the usage line is read again. */
    removed(): void;
}

export const COPY = {
    empty: 'No saved worlds yet. Worlds you make in the studio while signed in are saved here once they are on the stage.',
    cantOpen: 'Made for another version of the studio',
    open: 'Open in the studio',
    renameConflict: 'This world changed elsewhere. Here it is as it is now.',
    renameConflictUnread: 'This world changed elsewhere, and it can\'t be read right now. Reload the page to see it as it is.',
    renameRefused: 'That title can\'t be used. A title is 1 to 120 characters, on one line.',
    unavailable: 'That didn\'t work just now. Try again in a moment.',
    deleteConflict: 'This world changed elsewhere. Reload the page to see it.',
    deleteQuestion: (title: string) => `Delete “${title}”? This can't be undone.`,
    more: 'Show more',
    moreFailed: 'More worlds can\'t be loaded right now.',
} as const;

const MB = 1024 * 1024;
const size = (bytes: number) => (bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`);

/** "3 of 50 worlds · 1.2 MB of 100 MB". */
export function usageLine(u: WorldUsage): string {
    return `${u.worlds} of ${u.limits.worlds} worlds · ${size(u.usedBytes + u.reservedBytes)} of ${size(u.limits.bytes)}`;
}

/** "Saved 3 Nov 2026, 21:40", in the creator's own locale and time zone. */
export function savedAt(iso: string): string {
    const when = new Date(iso);
    return `Saved ${Number.isNaN(when.getTime()) ? 'at an unknown time' : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** One world's card: its title, when it was saved, its rename and its deletion. */
export function worldCard(world: WorldView, actions: HistoryActions): HTMLLIElement {
    let current = world;
    const title = h('h2', { class: 'world-title' }, current.title);
    const meta = h('p', { class: 'world-meta' }, savedAt(current.updatedAt));
    const badge = h('p', { class: 'world-badge' }, COPY.cantOpen);
    badge.hidden = opensLine(current.head.line);
    const note = h('p', { class: 'world-note', role: 'status' });
    const input = h('input', { type: 'text', class: 'world-input', maxlength: '120', 'aria-label': 'Title' });
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
    const cancel = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Cancel');
    const form = h('div', { class: 'world-rename' }, input, save, cancel);
    form.hidden = true;
    const open = h('a', { class: 'btn world-open', href: worldLink(current.worldId) }, COPY.open);
    open.hidden = !opensLine(current.head.line);
    const rename = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Rename');
    const remove = h('button', { type: 'button', class: 'btn btn-quiet world-delete' }, 'Delete');
    const buttons = h('div', { class: 'world-actions' }, open, rename, remove);
    const card = h('li', { class: 'world-card' }, title, form, meta, badge, note, buttons);

    const busy = (on: boolean) => { for (const b of [rename, remove, save, cancel]) b.disabled = on; };
    const show = (w: WorldView) => {
        current = w;
        title.textContent = w.title;
        meta.textContent = savedAt(w.updatedAt);
        badge.hidden = opensLine(w.head.line);
        open.hidden = !opensLine(w.head.line);
    };
    const editing = (on: boolean) => {
        form.hidden = !on;
        title.hidden = on;
        buttons.hidden = on;
        if (on) {
            input.value = current.title;
            input.focus();
        } else {
            rename.focus();
        }
    };
    const leave = () => { card.remove(); actions.removed(); };

    const submit = async () => {
        const wanted = input.value.trim();
        if (wanted === current.title) return editing(false);
        busy(true);
        note.textContent = '';
        try {
            const answer = await actions.rename(current, wanted);
            switch (answer.kind) {
                case 'done':
                    show(answer.world);
                    return editing(false);
                case 'conflict': {
                    const now = await actions.reread(current);
                    if (now === 'missing') return leave();
                    if (now === 'unavailable') {
                        // Still the creator's world, as far as anyone knows: kept, and the way to see it as it is now said.
                        note.textContent = COPY.renameConflictUnread;
                        return editing(false);
                    }
                    show(now);
                    note.textContent = COPY.renameConflict;
                    return editing(false);
                }
                case 'missing': return leave();
                case 'refused':
                    note.textContent = COPY.renameRefused;
                    return;
                default:
                    note.textContent = COPY.unavailable;
            }
        } finally {
            busy(false);
        }
    };

    rename.addEventListener('click', () => editing(true));
    cancel.addEventListener('click', () => editing(false));
    save.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Enter') void submit();
        else if (key === 'Escape') editing(false);
    });
    remove.addEventListener('click', async () => {
        if (!(await actions.confirm(COPY.deleteQuestion(current.title)))) return;
        busy(true);
        note.textContent = '';
        try {
            const answer = await actions.remove(current);
            if (answer.kind === 'deleting' || answer.kind === 'missing') return leave();
            note.textContent = answer.kind === 'conflict' ? COPY.deleteConflict : COPY.unavailable;
        } finally {
            busy(false);
        }
    });
    return card;
}

/** The history in `root`: the usage line, the cards, and "Show more" while the server says there is more. */
export function renderHistory(root: HTMLElement, page: WorldPage, usage: WorldUsage | null, actions: HistoryActions): {
    usage(u: WorldUsage | null): void;
} {
    root.textContent = '';
    const line = h('p', { class: 'history-usage' });
    const list = h('ul', { class: 'world-list' });
    const empty = h('p', { class: 'history-empty' }, COPY.empty);
    const more = h('button', { type: 'button', class: 'btn history-more' }, COPY.more);
    const failed = h('p', { class: 'world-note', role: 'status' });
    let next = page.next;
    const add = (worlds: readonly WorldView[]) => { for (const w of worlds) list.append(worldCard(w, actions)); };
    const setUsage = (u: WorldUsage | null) => {
        line.textContent = u ? usageLine(u) : '';
        line.hidden = !u;
    };
    const refresh = () => {
        empty.hidden = list.children.length > 0;
        more.hidden = next === null;
    };
    add(page.worlds);
    setUsage(usage);
    more.addEventListener('click', async () => {
        if (next === null) return;
        more.disabled = true;
        failed.textContent = '';
        const got = await actions.more(next);
        more.disabled = false;
        if (!got) {
            failed.textContent = COPY.moreFailed;
            return;
        }
        next = got.next;
        add(got.worlds);
        refresh();
    });
    root.append(line, list, empty, more, failed);
    refresh();
    return {
        usage(u) {
            setUsage(u);
            refresh();
        },
    };
}
