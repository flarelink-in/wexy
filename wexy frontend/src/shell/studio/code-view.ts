// A code panel that is also an editor: a transparent textarea over a highlighted <pre>, sharing one
// line grid, so gate errors and repair patches land on exact lines while the text stays editable.

import { h } from '../../shared/dom';
import { highlightJsonLine, highlightWgslLine } from '../../shared/highlight';

export interface CodeMark {
    line: number;
    kind: 'error' | 'warning' | 'patched';
    message?: string;
}

export class CodeView {
    readonly el: HTMLElement;
    onChange?: (text: string) => void;
    onSave?: () => void;

    private readonly scroller: HTMLElement;
    private readonly gutter: HTMLElement;
    private readonly pre: HTMLElement;
    private readonly input: HTMLTextAreaElement;
    private readonly highlight: (line: string) => string;
    private marks: CodeMark[] = [];
    private value = '';

    constructor(lang: 'wgsl' | 'json', editable: boolean) {
        this.highlight = lang === 'wgsl' ? highlightWgslLine : highlightJsonLine;
        this.gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
        this.pre = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
        this.input = h('textarea', {
            class: 'code-input', spellcheck: 'false', wrap: 'off', autocapitalize: 'off', autocomplete: 'off',
            'aria-label': lang === 'wgsl' ? 'WGSL hook source' : 'Scene spec JSON',
        });
        this.scroller = h('div', { class: 'code-scroll' }, this.gutter, h('div', { class: 'code-body' }, this.pre, this.input));
        this.el = h('div', { class: `code code-${lang}` }, this.scroller);
        this.setEditable(editable);

        this.input.addEventListener('input', () => {
            this.value = this.input.value;
            // Typing invalidates the marks: they described the text as it was compiled.
            this.marks = [];
            this.render();
            this.onChange?.(this.value);
        });
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                document.execCommand('insertText', false, '    ');
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.onSave?.();
            }
        });
    }

    get text(): string {
        return this.value;
    }

    setEditable(editable: boolean): void {
        this.input.readOnly = !editable;
        this.el.classList.toggle('readonly', !editable);
    }

    /** Replace the text. `follow` keeps the newest line in view, for a streaming model. */
    setText(text: string, follow = false): void {
        this.value = text;
        if (this.input.value !== text) this.input.value = text;
        this.marks = [];
        this.render();
        if (follow) this.scroller.scrollTop = this.scroller.scrollHeight;
    }

    setMarks(marks: CodeMark[]): void {
        this.marks = marks;
        this.render();
    }

    revealLine(line: number): void {
        const row = this.pre.children[line - 1] as HTMLElement | undefined;
        if (!row) return;
        const top = row.offsetTop - this.scroller.clientHeight / 3;
        this.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    private render(): void {
        const lines = this.value.split('\n');
        const byLine = new Map<number, CodeMark>();
        for (const m of this.marks) if (m.line > 0 && !byLine.has(m.line)) byLine.set(m.line, m);
        this.pre.innerHTML = lines
            .map((l, i) => {
                const mark = byLine.get(i + 1);
                const cls = mark ? ` mark-${mark.kind}` : '';
                return `<span class="ln${cls}">${this.highlight(l) || ' '}</span>`;
            })
            .join('');
        this.gutter.innerHTML = lines
            .map((_, i) => {
                const mark = byLine.get(i + 1);
                return `<span class="${mark ? `g-${mark.kind}` : ''}"${mark?.message ? ` title="${mark.message.replace(/"/g, '&quot;')}"` : ''}>${i + 1}</span>`;
            })
            .join('');
    }
}
