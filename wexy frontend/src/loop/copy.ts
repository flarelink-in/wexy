// Every sentence a creator reads about the loop, in one place, so they are reviewed together for honesty
// (coding principles §4; design guidelines §2 and §3; core-loop-frontend.md §13). Plain words: what happened and
// what to do. No code, counts or model names here; those belong to Developer view and the provenance sheet.

import type { FunctionName } from '../contract/spec';
import type { Source } from '../forge-client/client';

/** Why a world did not arrive, as the loop classifies it. */
export type FailureKind =
    | 'cancelled' | 'plan' | 'author-slow' | 'author-failed' | 'ran-out' | 'paused' | 'budget' | 'rate' | 'offline' | 'sign-in'
    | 'allowance' | 'quota' | 'refused' | 'too-heavy' | 'verify' | 'internal';

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
        'author-failed': 'The AI couldn\'t write this one just now. Try again, or try a simpler idea.',
        'ran-out': 'The AI couldn\'t finish writing this one. Try a simpler idea.',
        'paused': 'Live creation is paused right now. Try again in a little while, or open a starter.',
        'budget': 'Live creation is paused right now. Try again in a little while, or open a starter.',
        'rate': 'You\'ve made a lot of worlds; try again in a few minutes.',
        'offline': 'Wexy couldn\'t reach its server. Check your connection and try again.',
        'sign-in': 'Wexy couldn\'t sign you in on this device. Reload the page and try again.',
        // W1 (the creations platform companion §12): what the server said of the caller's allowance and the idea. The
        // world on the stage and the idea in the box stay as they are; nothing was spent.
        'allowance': 'You\'ve made your free world. Sign in with Google for early access: one world a day.',
        'quota': 'You\'ve made today\'s world. Early access gives one a day. You can still open, film and export your worlds.',
        'refused': 'This idea can\'t be made here. Try a different one.',
        'too-heavy': 'This idea is too heavy for this graphics card. Try fewer things, or a simpler look.',
        'verify': 'This one didn\'t work on your device. Try again, or try another idea.',
        'internal': 'Something went wrong. Press Create to try again.',
    } satisfies Record<FailureKind, string>,
    /** A rate limit with a known wait. */
    rateWithMinutes: (minutes: number) => `You've made a lot of worlds; try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    /** The account control and its dialogs (W1; the creations platform companion §9, §12). The world stays in every one. */
    account: {
        signIn: 'Sign in with Google',
        /** The header's Sign in on phones, whose header has room for it and Make video only; its accessible name stays signIn. */
        signInShort: 'Sign in',
        signOut: 'Sign out',
        signedIn: 'Signed in with Google',
        notNow: 'Not now',
        ok: 'OK',
        allowanceTitle: 'You\'ve made your free world',
        quotaTitle: 'Today\'s world is made',
        collisionTitle: 'That Google account already has a Wexy account',
        collisionBody: 'Sign in to it here instead? The world on screen stays as it is.',
        collisionGo: 'Sign in to that account',
        cancel: 'Cancel',
        blocked: 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
        failed: 'Sign-in didn\'t work just now. Your world is still here; try again in a moment.',
        signedOut: 'Signed out. Your world is still here.',
        /** W2 (the creations platform companion §9): the account's @handle, claimed once in the header's dialog. */
        chooseHandle: 'Choose a handle',
        handleTitle: 'Choose your handle',
        handleLabel: 'Handle',
        handleHint: '3 to 30 letters, digits or underscores. Your handle can\'t be changed later.',
        claim: 'Claim',
        handleRule: 'Use 3 to 30 letters (a to z), digits or underscores.',
        handleTaken: 'That handle is taken. Try another.',
        handleReserved: 'That handle is reserved. Try another.',
        handleRetry: 'Your profile changed in another tab. Try again.',
        handleForbidden: 'This account can\'t make changes right now.',
        handleUnavailable: 'Couldn\'t claim a handle just now. Try again in a moment.',
        handleClaimed: (handle: string) => `You're @${handle}.`,
    },
    /** Early access's world of the day made, with the reset the server gave, as a time on this device's clock (W1). */
    quotaUntil: (reset: Date) => `You've made today's world. Early access gives one a day; the next opens at ${clockTime(reset)}. You can still open, film and export your worlds.`,
    /** The candidate loop's ends (candidate-loop-design.md §11): what happened, and that the current world is kept. */
    candidate: {
        moduleFailed: 'One part of this world could not be written correctly; your current world is unchanged.',
        setup: 'This version has a setup problem; the current world is unchanged.',
        stale: 'The world changed while that fix was being prepared.',
        tooLarge: 'This attempt grew too large; your current world is unchanged.',
        stream: 'We couldn\'t finish writing this version; your current world is unchanged.',
        budget: 'We reached this attempt\'s limit; your last checked world is still available.',
        refused: 'Something went wrong preparing this world.',
        /** A revision's notes named a part its program does not have (EA6.3, visual-review-design.md §11): nothing applied. */
        planRefused: 'This change could not be applied safely; your current world is unchanged.',
    },
    /**
     * The review of the world on the stage (visual-review-design.md §11; Q110, 11-02: the creator's button is "Improve it").
     * Whatever happens to a review, the world stays on the stage.
     */
    review: {
        captureFailed: 'We could not take a look at this world; it is still on the stage.',
        unavailable: 'This world cannot be captured for review yet; you can still view it on the stage.',
        tooLarge: 'These review images are too large; capture them again before sending.',
        stale: 'The world changed while that feedback was being prepared.',
        budget: 'We reached this world\'s limit for improvements; it is still on the stage.',
        noSession: 'This saved world can be reviewed here, but it has no active session to improve it.',
        busy: 'The stage is busy right now; capture it again in a moment.',
        improving: 'An improvement is already under way; this world stays on the stage.',
        notApplied: 'This improvement could not be applied; the previous world is still on the stage.',
        /** A model's review (EA6.4, visual-review-design.md §9.1, §11): never offered before Q62's gates and the creator's consent. */
        aiUnavailable: 'AI review is not available; tell us what to improve.',
        aiConsent: 'AI review needs your go-ahead to send these frames first.',
        aiInvalid: 'AI review did not return a usable verdict; you can still give your own feedback.',
        aiFailed: 'AI review did not answer this time; you can still give your own feedback.',
        aiBusy: 'An AI review is already under way; this world stays on the stage.',
        aiDropped: 'These frames are no longer kept here; capture the world again to review it.',
        /** When this browser would not keep the creator's go-ahead, or its withdrawal (EA6.4): never silently. */
        aiKeptHere: 'This browser would not keep your go-ahead: it holds on this page only, until you leave it.',
        aiWithdrawnHere: 'This browser would not forget your go-ahead: it is withdrawn on this page only. Clear this site\'s data to withdraw it everywhere.',
    },
    /**
     * What the creator consents to before a model's review sends anything (EA6.4, §9's privacy gate), word for word, by
     * the policy version the backend reports (`wexy.review.policy-version`): a version this build has no text for keeps
     * the review shut, and so do terms of another provider or mode than the text was written for (`providerId`, `mode`:
     * what it says of Standard mode is not true of contributor mode). Drafted from Meta's Data Commitments, Terms and
     * docs, read 2026-11-03: what they say, and what they do not (no retention period is stated). Links are this
     * module's own, never the server's.
     */
    disclosures: {
        'meta-standard.2026-11-03': {
            providerId: 'meta',
            mode: 'standard',
            provider: 'Meta',
            sends: (model: string) => `Review with AI sends the two frames shown here, your idea, the world's design and the host's findings you keep `
                + `checked to Meta's model ${model}, through Wexy's server, which keeps none of the frames.`,
            statements: [
                'Meta says it does not use content sent to its Standard service to train its models.',
                'Meta keeps what it receives as its Terms and Privacy Policy describe; it does not state for how long.',
                'Meta may process it to detect and respond to misuse of its API.',
            ],
            links: [
                { label: 'Meta\'s data commitments', url: 'https://dev.meta.ai/legal/commitments' },
                { label: 'Meta Model API terms', url: 'https://dev.meta.ai/legal/terms-of-service' },
                { label: 'Meta\'s Privacy Policy', url: 'https://www.facebook.com/privacy/policy/' },
            ],
            agree: 'Allow AI review with Meta',
            withdraw: 'Withdraw consent',
        },
    } as Readonly<Record<string, { providerId: string; mode: 'standard' | 'contributor'; provider: string; sends: (model: string) => string;
        statements: readonly string[]; links: readonly { label: string; url: string }[]; agree: string; withdraw: string }>>,
    /** An edit that failed after repairs keeps the world (design guidelines §4). */
    editFailed: 'That change didn\'t work on your device. Your world is as it was.',
    deviceLost: 'Your graphics card reset while running this change. We went back to the last version that worked.',
} as const;

/**
 * A moment as this device's clock shows it, hours and minutes in the creator's own format ("09:00", "9:00 AM"); a day
 * other than today gets its weekday ("Tue 09:00"), since a reset can fall tomorrow.
 */
export function clockTime(at: Date, now: Date = new Date()): string {
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
    if (at.toDateString() === now.toDateString()) return time;
    return `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)} ${time}`;
}
