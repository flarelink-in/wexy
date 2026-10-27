import type { HookName, Program, SceneSpec, Style } from '../../contract/spec';

/** A realistic first-draft mistake for the repair path (?fault=1), and the fix the repair turn makes. */
export interface Fault {
    hook: HookName;
    /** Exact text in the hook that the mistake replaces. Must occur once. */
    find: string;
    replace: string;
    /** What the repair turn reports it changed. */
    note: string;
}

/** The expert program's three stages, as the archetypes write them. */
export type ArchetypeHooks = Omit<Extract<Program, { kind: 'hooks' }>, 'kind'>;

/**
 * A scene the mock can "write": a hand-written draft and hooks, the playground's three examples. They are written
 * at the expert setting of the freedom dial (whole stages against the host header), which the live planner and
 * author never use: a live world is h1's functions (the backend's templates hold its own exemplars).
 */
export interface Archetype {
    id: string;
    name: string;
    tagline: string;
    style: Style;
    keywords: RegExp;
    examplePrompt: string;
    draft: Omit<SceneSpec, 'program'>;
    hooks: ArchetypeHooks;
    fault: Fault;
    /** Prompt words that nudge the drafted uniform defaults. */
    tweaks: Array<{ match: RegExp; uniform: string; value: number }>;
}
