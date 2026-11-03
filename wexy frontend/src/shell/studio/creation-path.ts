// Which creation path the studio's idea box runs, decided once at startup from the URL (EA9.1; agent-first-studio-design.md
// §9 "Flags"; Q114 decided 2026-11-03: build behind `?create=agent`). Pure: no DOM and no network, so it runs under
// node --test (EA9-U16).
//   - `?legacy=1` wins the creation path while the rollback exists; `?create=agent` selects the agent path before the
//     switch (EA9.5), and the default selects it after.
//   - `?agent=1` is Developer view with the agent's panels, today's harness entry; it never overrides `?legacy=1`.
//   - `?dev=1` alone never chooses a path.
//   - A loader (`?scene=`, `?replay=`) calls no model, and suppresses an autorun named beside it.
//   - A selector this build does not know makes no request: its sentence is said, and nothing autoruns.
//   - Nothing here grants a GPU go: an autorun Create on the agent path still stops at "Show it" (I5).

export interface PathFacts {
    /** The default is the agent path (EA9.5's switch, on the user's approval). False until then. */
    readonly switched: boolean;
    /** This page can reach the backend: the build knows a gateway, and `?source=mock` does not keep it on the mock. */
    readonly gateway: boolean;
}

export interface CreationPathSelection {
    /** What the idea box's Create runs: h1's loop, or the agent's creation (creation.ts). */
    readonly create: 'h1' | 'agent';
    /** Developer view's agent panels (`?agent=1`): the turn, the candidate, the saved attempts, the review. */
    readonly agentPanels: boolean;
    /** The creation controller and the stage it needs are mounted: for the agent's Create, or its panels. */
    readonly agentPath: boolean;
    /** Developer view (`?dev=1`, or `?agent=1`). */
    readonly devView: boolean;
    /** A loader named in the URL: one of h1's hand-written examples, or a saved attempt (Developer view's). */
    readonly loader: { readonly kind: 'scene' | 'replay'; readonly name: string } | null;
    /** Create on load (`?autorun`), on the selected path; never beside a loader or an unknown selector. */
    readonly autorun: boolean;
    /** Why the agent's Create cannot run here (no backend): said, and Create stays off; the examples still work. */
    readonly unavailable: string | null;
    /** A selector this build does not know: said, and nothing starts. */
    readonly invalid: string | null;
}

/** The one value each new selector takes; anything else is a selector this build does not know. */
const KNOWN: Readonly<Record<'legacy' | 'create', readonly string[]>> = { legacy: ['0', '1'], create: ['agent'] };

export function selectCreationPath(params: URLSearchParams, facts: PathFacts, sentences: { unavailable: string; invalid: string }): CreationPathSelection {
    const unknown = (['legacy', 'create'] as const).filter(k => params.has(k) && !KNOWN[k].includes(params.get(k) ?? ''));
    const legacy = params.get('legacy') === '1';
    // An unknown selector keeps the default path (never a fallback to h1 after the switch); it only says so and starts nothing.
    const create: 'h1' | 'agent' = legacy ? 'h1' : params.get('create') === 'agent' || facts.switched ? 'agent' : 'h1';
    const agentPanels = params.get('agent') === '1';
    const dev = params.has('dev') && params.get('dev') !== '0';
    const scene = params.get('scene');
    const replay = params.get('replay');
    const loader = scene !== null ? { kind: 'scene' as const, name: scene } : replay !== null ? { kind: 'replay' as const, name: replay } : null;
    const unavailable = create === 'agent' && !facts.gateway ? sentences.unavailable : null;
    const invalid = unknown.length ? sentences.invalid : null;
    return {
        create, agentPanels, agentPath: create === 'agent' || agentPanels, devView: dev || agentPanels, loader,
        autorun: params.has('autorun') && loader === null && invalid === null && unavailable === null,
        unavailable, invalid,
    };
}
