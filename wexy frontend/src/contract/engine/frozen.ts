// The engine bundle is shared, immutable data (EA1): what a tool returns must be what was hashed, so every object is
// frozen once, at load, and typed read-only all the way down.

export type DeepReadonly<T> = T extends (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** `value` and everything it holds, frozen; a write then throws in strict code (every module is). */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value as DeepReadonly<T>;
}
