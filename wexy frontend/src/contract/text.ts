// Text bounds as the contracts count them (the independent review of EA6.3, 11-02 night): in code points, as the action's
// schema and the backend's validators count a string's length, never in UTF-16 units, so an emoji is one character and
// a cut never leaves half of one behind.

/** A string's length in code points. */
export function codePoints(s: string): number {
    let n = 0;
    for (const _ of s) n++;
    return n;
}

/** `s` cut to at most `max` code points, whole characters only: never a lone half of a surrogate pair. */
export function cutCodePoints(s: string, max: number): string {
    if (s.length <= max) return s;
    let out = '';
    let n = 0;
    for (const ch of s) {
        if (n === max) break;
        out += ch;
        n++;
    }
    return out;
}
