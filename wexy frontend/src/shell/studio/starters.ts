// The starters on the agent path (EA9.4; agent-first-studio-design.md §9; Q122 (a), the user, 2026-11-04: "all three, h1's
// kept too"): worlds Meta's models made earlier, shipped with the page as saved attempts (`public/worlds/<id>.json`, a
// candidate bundle), each sealed again by this host and compiled on this device (loop/replay.ts's `sealSaved` and
// `compileSaved`), then the same Run as any world, with no backend and no model call. Each is labelled From the archive
// (design guidelines §3). Tapping its chip is the host's go for that one candidate (I5); a link grants none.
//
// A saved attempt must seal under the build that ships it: `dev/starters.mjs record` writes the files from their sources
// and pins each one's id(C) and X hash (test/fixtures/starters.json), and EA9-U11 holds every file to them, as
// test/replay.test.mjs holds the castle. A contract change that moves one is seen there, and re-recorded on purpose.

export interface StarterWorld {
    /** Its file's name in public/worlds, and its id here. */
    readonly id: string;
    /** The chip's word or two. */
    readonly label: string;
    /** What the HUD and the header call it once it is on the stage. */
    readonly title: string;
}

/** The three that looked right on both GPUs (the AMD iGPU and the GTX 1650; EA-F2 and EA9-E1's runs, 11-03). */
export const STARTER_WORLDS: readonly StarterWorld[] = Object.freeze([
    { id: 'castle', label: 'Castle', title: 'A fairytale castle on a hill' },
    { id: 'voxel-island', label: 'Voxel island', title: 'A voxel island in old film' },
    { id: 'spiral-galaxy', label: 'Spiral galaxy', title: 'A spiral galaxy' },
]);

/** Where a starter's file is served from. */
export const starterFile = (id: string): string => `/worlds/${id}.json`;

/** A starter's id: what public/worlds holds, never a path. */
export const STARTER_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
