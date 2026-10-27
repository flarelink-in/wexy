// JSON for people: numeric arrays and short flat objects stay on one line, so a camera keyframe
// reads as one row instead of fourteen.

export function formatJson(value: unknown, indent = 0): string {
    const pad = '  '.repeat(indent);
    const inner = '  '.repeat(indent + 1);
    if (Array.isArray(value)) {
        if (value.every(v => typeof v !== 'object' || v === null)) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
        return `[\n${value.map(v => inner + formatJson(v, indent + 1)).join(',\n')}\n${pad}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (!entries.length) return '{}';
        const flat = entries.every(([, v]) => typeof v !== 'object' || v === null || (Array.isArray(v) && v.every(x => typeof x !== 'object')));
        const oneLine = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatJson(v)}`).join(', ')} }`;
        if (flat && oneLine.length + indent * 2 <= 104) return oneLine;
        return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, indent + 1)}`).join(',\n')}\n${pad}}`;
    }
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
    return JSON.stringify(value);
}
