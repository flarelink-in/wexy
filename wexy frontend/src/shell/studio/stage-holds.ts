// Who holds the stage, as a Run's admission sees it (EA9.1; agent-first-studio-design.md §6 step 5, P7). A Run admits,
// builds, probes and commits on the viewport's device, and its commit retires the world that was on the stage; a photo, a
// film and a review's capture draw and read back on that same device, from that same world. So a Run waits for every one
// of them: for a photo's hold as for a film (the EA9.1 review). The other way round, Photo and Make video wait for a Run
// whatever kind of world is on the stage (main.ts). Pure: the studio says what holds the stage now, and Show it, Run on
// this GPU and a saved attempt's Run read the one answer.

/** What holds the stage now, as the studio knows it. */
export interface StageHolders {
    /** A Run is under way (the stage's own `busy`): its gate, build, probe, first frame and commit. */
    readonly running: boolean;
    /** One of h1's examples is being built and checked. */
    readonly building: boolean;
    /** The review captures the world on the stage (EA6.1). */
    readonly capturing: boolean;
    /** A film is being recorded (the export dialog's busy). */
    readonly recording: boolean;
    /**
     * A pause holds the viewport (viewport.ts's `held`): a photo, a film's measurement or its recording, a review's
     * capture, a probe's quiet window.
     */
    readonly held: boolean;
}

/** Who holds the stage now, in the developer's words (Run on this GPU says why it waits), or null when no one does. */
export function stageTaken(s: StageHolders): string | null {
    if (s.running) return 'A Run is under way.';
    if (s.building) return 'A world is being made: Run once it is done.';
    if (s.capturing) return 'The stage is being captured for its review: Run once it is done.';
    if (s.recording) return 'A film is being made: Run once it is done.';
    if (s.held) return 'A photo or a film holds the stage: Run once it is done.';
    return null;
}
