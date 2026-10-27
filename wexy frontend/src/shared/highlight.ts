// Line-oriented syntax highlighting for WGSL and JSON. Returns one HTML string per line, so the
// code view can put line numbers, error marks and patch marks on exact lines.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const WGSL_KEYWORDS = 'fn|let|var|const|override|return|if|else|for|loop|while|break|continue|continuing|switch|case|default|discard|struct|alias|true|false|enable|requires';
const WGSL_TYPES = 'f32|f16|i32|u32|bool|vec[234][fhiu]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler|texture_\\w+';
/** The host's bindings: what the model may read but never declare. */
const HOST = 'camera|particles|sim|params';

const WGSL_RE = new RegExp(
    `(\\/\\/.*$)|(@\\w+)|\\b(${WGSL_KEYWORDS})\\b|\\b(${WGSL_TYPES})\\b|\\b(${HOST})\\b|` +
    `(\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?[fuhi]?\\b|\\.\\d+(?:[eE][+-]?\\d+)?\\b)|\\b([A-Za-z_]\\w*)(?=\\s*\\()`,
    'gm',
);

export function highlightWgslLine(line: string): string {
    let out = '';
    let last = 0;
    WGSL_RE.lastIndex = 0;
    for (let m = WGSL_RE.exec(line); m; m = WGSL_RE.exec(line)) {
        out += escape(line.slice(last, m.index));
        const cls = m[1] ? 'c' : m[2] ? 'a' : m[3] ? 'k' : m[4] ? 't' : m[5] ? 'h' : m[6] ? 'n' : 'f';
        out += `<span class="tk-${cls}">${escape(m[0])}</span>`;
        last = m.index + m[0].length;
        if (m[0].length === 0) WGSL_RE.lastIndex++;
    }
    return out + escape(line.slice(last));
}

const JSON_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

export function highlightJsonLine(line: string): string {
    let out = '';
    let last = 0;
    JSON_RE.lastIndex = 0;
    for (let m = JSON_RE.exec(line); m; m = JSON_RE.exec(line)) {
        out += escape(line.slice(last, m.index));
        if (m[1]) out += m[2] ? `<span class="tk-key">${escape(m[1])}</span>${m[2]}` : `<span class="tk-s">${escape(m[1])}</span>`;
        else if (m[3]) out += `<span class="tk-n">${m[3]}</span>`;
        else out += `<span class="tk-k">${m[4]}</span>`;
        last = m.index + m[0].length;
    }
    return out + escape(line.slice(last));
}
