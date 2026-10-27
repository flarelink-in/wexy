// Every sentence a creator reads about the loop, in one place, so they are reviewed together for honesty
// (coding principles §4; design guidelines §2 and §3; core-loop-frontend.md §13). Plain words: what happened and
// what to do. No code, counts or model names here; those belong to Developer view and the provenance sheet.

import type { FunctionName } from '../contract/spec';
import type { Source } from '../forge-client/client';

/** Why a world did not arrive, as the loop classifies it. */
export type FailureKind =
    | 'cancelled' | 'plan' | 'author-slow' | 'ran-out' | 'paused' | 'budget' | 'rate' | 'offline' | 'sign-in'
    | 'too-heavy' | 'verify' | 'internal';

export const COPY = {
    journey: {
        plan: 'Planning the scene',
        build: 'Building the world',
        check: 'Testing it on your device',
        ready: 'Ready to film',
    },
    reading: 'Reading your idea…',
    working: 'Working out the motion and the light…',
    writing: {
        evolve: 'Writing how everything moves…',
        look: 'Shaping the light and the glow…',
        sky: 'Painting the sky…',
    } satisfies Record<FunctionName, string>,
    checking: 'Making sure it runs smoothly here…',
    repairing: 'Fixing a small mistake in the AI\'s first try…',
    warming: 'Getting your graphics card ready… the first world of a session takes a little longer.',
    runs: 'Runs on your graphics card',
    ready: 'Drag the view to look around, then press Record',
    /** At 15 s without an answer. */
    slow: {
        plan: 'Still thinking about your idea…',
        evolve: 'Still writing the motion…',
        look: 'Still writing the look…',
        sky: 'Still painting the sky…',
        repair: 'Still fixing it…',
    },
    source: {
        live: 'Live',
        archive: 'From the archive',
        mock: 'Playground example',
    } satisfies Record<Source, string>,
    sourceTitle: {
        live: 'Planned and written by Meta\'s models just now, checked and run on your graphics card.',
        archive: 'Made by Meta\'s models earlier and replayed here; checked and run on your graphics card.',
        mock: 'Written by hand, not by Meta\'s models. The 3D world, the controls and the video are real.',
    } satisfies Record<Source, string>,
    failures: {
        'cancelled': '',
        'plan': 'Your idea didn\'t come through. Try again, or pick a starter.',
        'author-slow': 'That took too long. Try again, or try a simpler idea.',
        'ran-out': 'The AI couldn\'t finish writing this one. Try a simpler idea.',
        'paused': 'Live creation is paused right now. Try again in a little while, or open a starter.',
        'budget': 'Live creation is paused right now. Try again in a little while, or open a starter.',
        'rate': 'You\'ve made a lot of worlds; try again in a few minutes.',
        'offline': 'Wexy couldn\'t reach its server. Check your connection and try again.',
        'sign-in': 'Wexy couldn\'t sign you in on this device. Reload the page and try again.',
        'too-heavy': 'This idea is too heavy for this graphics card. Try fewer things, or a simpler look.',
        'verify': 'This one didn\'t work on your device. Try again, or try another idea.',
        'internal': 'Something went wrong. Press Create to try again.',
    } satisfies Record<FailureKind, string>,
    /** A rate limit with a known wait. */
    rateWithMinutes: (minutes: number) => `You've made a lot of worlds; try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    /** An edit that failed after repairs keeps the world (design guidelines §4). */
    editFailed: 'That change didn\'t work on your device. Your world is as it was.',
    deviceLost: 'Your graphics card reset while running this change. We went back to the last version that worked.',
} as const;
