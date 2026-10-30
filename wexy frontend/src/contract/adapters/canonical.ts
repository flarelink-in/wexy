// Canonical identity for EA3 (engine-adapters-design.md §6, "Canonical identity"): one string per value, so the same
// program, manifests and policy give the same hash on every run and in every browser. Object keys are sorted (UTF-16
// code-unit order, as Array.prototype.sort leaves them), arrays keep their order, numbers are written as ECMAScript
// writes them (as RFC 8785 does) with -0 as 0, and anything that is not plain JSON data throws: a non-finite number,
// any number from 2^53 up (every such double is an integer, and no longer an exact one), undefined, a function, a
// symbol, a class instance, a hole or a cycle. The digest is SHA-256 of the UTF-8 bytes through Web Crypto, which
// needs a secure context, as WebGPU already does; Node 24 has it too.

import { pointerToken } from '../agent';

/** `value` as canonical JSON text; throws, naming the path, on anything that is not plain JSON data. */
export function canonicalJson(value: unknown): string {
    const ancestors = new Set<object>();
    const refuse = (what: string, at: string): never => { throw new Error(`canonical JSON: ${what} at ${at || '/'}`); };
    const write = (v: unknown, at: string): string => {
        if (v === null) return 'null';
        switch (typeof v) {
            case 'boolean': return v ? 'true' : 'false';
            case 'string': return JSON.stringify(v);
            case 'number':
                if (!Number.isFinite(v)) return refuse(`${v} is not a finite number`, at);
                if (Number.isInteger(v) && !Number.isSafeInteger(v)) return refuse(`${v} is past the safe integers`, at);
                return Object.is(v, -0) ? '0' : JSON.stringify(v);
            case 'object': {
                if (ancestors.has(v)) return refuse('a cycle', at);
                const proto = Object.getPrototypeOf(v);
                if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return refuse('a value that is not plain data', at);
                if (Object.getOwnPropertySymbols(v).length) return refuse('a symbol key', at);
                ancestors.add(v);
                try {
                    if (Array.isArray(v)) {
                        const items: string[] = [];
                        for (let i = 0; i < v.length; i++) {
                            if (!Object.hasOwn(v, i)) refuse('a hole', `${at}/${i}`);
                            items.push(write(v[i], `${at}/${i}`));
                        }
                        return `[${items.join(',')}]`;
                    }
                    const record = v as Record<string, unknown>;
                    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${write(record[k], `${at}/${pointerToken(k)}`)}`).join(',')}}`;
                } finally {
                    ancestors.delete(v);
                }
            }
            default:
                return refuse(`${typeof v} is not JSON`, at);
        }
    };
    return write(value, '');
}

/** Lower-case hex SHA-256 of `text`'s UTF-8 bytes. */
export async function sha256Hex(text: string): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('EA3 identity needs Web Crypto (crypto.subtle), which only a secure context has.');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** The SHA-256 of `value`'s canonical JSON. */
export const canonicalHash = (value: unknown): Promise<string> => sha256Hex(canonicalJson(value));
