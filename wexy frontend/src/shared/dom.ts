// A small element builder: enough structure for the studio's panels without a framework.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = String(value);
        else if (key === 'html') el.innerHTML = String(value);
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(value));
    }
    append(el, children);
    return el;
}

function append(el: Element, children: Child[]): void {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else el.append(c instanceof Node ? c : String(c));
    }
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Missing element ${selector}`);
    return el;
}

/**
 * True when `target` is, or is inside, a control that answers Space or Enter itself (a button, a checkbox, a link, a
 * tab): a page-wide shortcut on those keys must leave it its own press (EA9.4: the studio's Space, which plays the camera
 * move, had taken the review's checkboxes' Space). A slider answers its arrows, never Space, so it is none: the page's
 * Space plays over the timeline's track or a range, as it did before (EA9.4's review).
 */
export function isControl(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return false;
    const control = el.closest('button, a[href], input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]');
    return control !== null && !control.matches('input[type="range"]');
}

/** True while focus is in a text field, so single-key shortcuts leave typing alone. */
export function isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)) || el.isContentEditable);
}

export function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
