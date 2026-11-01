// WCAG 2 contrast of the pairs the design guidelines rule on (docs/design-guidelines.md §5), with the
// colours read from src/styles/base.css, so a token change is measured, not eyeballed. Small text
// needs 4.5:1; large text and the parts of a control need 3:1. A translucent colour is blended over
// the surface it sits on first.
//   node dev/contrast.mjs        (exit 1 if a pair that must pass fails)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'base.css'), 'utf8');
const token = name => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
    if (!m) throw new Error(`contrast: ${name} is not a #rrggbb value in base.css`);
    return m[1];
};

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const over = ([r, g, b, a], base) => [r, g, b].map((c, i) => c * a + base[i] * (1 - a));
const luminance = ([r, g, b]) => {
    const lin = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

const surfaces = ['--bg', '--bg-2', '--panel', '--panel-2', '--panel-3'].map(n => [n, rgb(token(n))]);
// The primary fill, at rest and on hover (base.css .btn-primary, studio.css .cap-record): solid ink since 11-01.
const primary = ['--accent', '--accent-hover'].map(n => [n, rgb(token(n))]);
const label = rgb(token('--on-primary'));

/** [what, text colour (rgb or rgba), surfaces, the ratio it must reach, or 0 for record only] */
const pairs = [
    ['--text', rgb(token('--text')), surfaces, 4.5],
    ['--text-2', rgb(token('--text-2')), surfaces, 4.5],
    ['--text-3-strong (essential small text)', rgb(token('--text-3-strong')), surfaces, 4.5],
    ['--text-3 (non-essential only)', rgb(token('--text-3')), surfaces, 0],
    ['--on-primary label', label, primary, 4.5],
    ['--on-primary kbd at 70%', [...label, 0.7], primary, 0],
];

let failed = 0;
for (const [name, color, bases, need] of pairs) {
    const cells = bases.map(([bn, base]) => {
        const r = ratio(color.length === 4 ? over(color, base) : color, base);
        const bad = need > 0 && r < need;
        if (bad) failed++;
        return `${bn} ${r.toFixed(1)}${bad ? ' FAIL' : ''}`;
    });
    console.log(`${name}${need ? ` (needs ${need}:1)` : ''}: ${cells.join(', ')}`);
}
console.log(failed ? `contrast: ${failed} pair(s) below their minimum` : 'contrast: every required pair passes');
process.exit(failed ? 1 : 0);
