// Every sentence a creator reads about the loop, in one place, so they are reviewed together for honesty
// (coding principles §4; design guidelines §2 and §3; core-loop-frontend.md §13). Plain words: what happened and
// what to do. No code, counts or model names here; those belong to Developer view and the provenance sheet.

import type { FunctionName } from '../contract/spec';
import type { Source } from '../forge-client/client';

/** Why a world did not arrive, as the loop classifies it. */
export type FailureKind =
    | 'cancelled' | 'plan' | 'author-slow' | 'author-failed' | 'ran-out' | 'paused' | 'budget' | 'rate' | 'offline' | 'sign-in'
    | 'allowance' | 'quota' | 'refused' | 'suspended' | 'too-heavy' | 'verify' | 'internal';

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
        'allowance': 'This browser has made its free world, or your network has made today\'s. Sign in with Google for early access: one world a day.',
        'quota': 'You\'ve made today\'s world. Early access gives one a day. You can still open, film and export your worlds.',
        'refused': 'This idea can\'t be made here. Try a different one.',
        // 2026-11-04 (the user: "suspension force that"): a suspended or deleting account, refused at the gateway.
        'suspended': 'This account can\'t make worlds right now.',
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
        allowanceTitle: 'The free world is made',
        quotaTitle: 'Today\'s world is made',
        collisionTitle: 'That Google account already has a Wexy account',
        collisionBody: 'Sign in to it here instead? The world on screen stays as it is.',
        collisionGo: 'Sign in to that account',
        cancel: 'Cancel',
        /**
         * Q129 (the user, 2026-11-04): a world written and waiting for Show it is the signed-in account's; another account,
         * or none, discards it, so a sign-out or a collision's sign-in asks first. Escape keeps the account and the world.
         */
        unshownSignOutTitle: 'Sign out?',
        unshownSignOutBody: 'Your new world hasn\'t been shown yet. Signing out discards it.',
        unshownSignOutGo: 'Sign out and discard',
        unshownSignInTitle: 'Sign in to that account?',
        unshownSignInBody: 'Your new world hasn\'t been shown yet. Signing in to that account discards it.',
        unshownSignInGo: 'Sign in and discard',
        showFirst: 'Show it first',
        signedOutDiscarded: 'Signed out. Your new world was discarded.',
        showFirstLater: 'Show it can\'t start right now. Your new world is still waiting: press Show it when it\'s ready.',
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
        /** EA9.1: a new world is being made, so this one waits (agent-first-studio-design.md §6). */
        making: 'A new world is being made; this one stays on the stage. Improve it once that is done.',
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
    /**
     * The agent path's Create (EA9.1; agent-first-studio-design.md §6, §7 and §11): its button, its four steps and the
     * one sentence each end says. The world on the stage stays in every one; nothing here names a code or a number a
     * creator cannot use (§2's P5).
     */
    creation: {
        create: 'Create world',
        stop: 'Stop',
        show: 'Show it',
        planning: 'Designing your world from your idea…',
        planned: 'Designed',
        writingStart: 'Writing its parts…',
        writing: (done: number, total: number) => `${done} of ${total} parts written`,
        written: (total: number) => `${total} part${total === 1 ? '' : 's'} written and checked`,
        readyToShow: 'It passed its checks. Press Show it to test it on your graphics card.',
        testing: 'Testing it on your graphics card…',
        asked: (question: string) => `One more detail would help: ${question} Add it to your idea, then press Create.`,
        declined: 'That idea can\'t be made here. Try describing a place, the things in it, and how they move.',
        exhausted: 'This idea needed more steps than one try allows. Try a simpler version of it.',
        cancelled: 'Stopped. Your current world is unchanged.',
        accountChanged: 'You signed in or out, so this world was stopped. Your current world is unchanged.',
        accountChangedDiscarded: 'You signed in or out, so this world was stopped, and your new world waiting for Show it was discarded. Your current world is unchanged.',
        /** Q127 (a) reversed (the user, 2026-11-04): a world written and not yet shown belongs to the account that made it. */
        discarded: 'The account changed before your new world was shown, so it was discarded. Your current world is unchanged.',
        deviceLost: 'Your graphics card stopped responding, so this world was stopped. Reload the page to carry on.',
        notHere: 'This world can\'t be tested on this device; your current world is unchanged.',
        runRefused: 'This world didn\'t pass its test on your graphics card; your current world is unchanged. Press Show it to try again, or try a simpler idea.',
        /** A Run refused, by its code (G4, EA9.2; the design's §11): a measurement that came out unclear, or too much here. */
        // EA_PROBE_UNVERIFIED also carries the world's own GPU errors in the probe (the EA9.2 review), so this promises
        // no retry: the creator may try again, or a different idea.
        runUnclear: 'Your graphics card couldn\'t finish testing this world. Close other tabs or apps and press Show it again, or try a different idea.',
        /** The world on the stage paused: its window outgrew what it was tested at (EA_RESIZE; the EA9.2 review). */
        resized: 'Paused: this window is larger than this world was tested at. Press Show it to test it at this size.',
        runHeavy: 'This world is too heavy for your graphics card. Try a simpler idea; your current world is unchanged.',
        runDrawn: 'This world didn\'t draw correctly on your device; your current world is unchanged. Try a different idea.',
        runBuilt: 'This world didn\'t build on your device; your current world is unchanged. Try a different idea.',
        runStopped: 'Stopped. Your current world is unchanged, and this one is still ready: press Show it to test it again.',
        /** What a screen reader hears once a new world is on the stage (EA9.2, E6). */
        onStage: 'Your new world is on the stage. Drag the view to look around, then press Record.',
        /** A new idea that did not start (Q126 (b)): why, then the world written before it, given back. */
        kept: (why: string) => `${why} Your last world is still ready: press Show it to test it.`,
        keptStopped: 'Stopped. Your last world is still ready: press Show it to test it.',
        noGateway: 'Making a new world needs the Wexy service, which this page can\'t reach. Try one of the examples instead.',
        invalid: 'This link asks for a way of making worlds this page doesn\'t have, so nothing was started.',
        noControls: 'This world has no sliders. Drag to look around, then take a photo or make a video.',
    },
    /**
     * The world on the stage's save, beside its title (W3.6; the creations platform companion §7, §9 and §12): what its
     * save came to, in a word or a few, and the one thing to do. The world stays on the stage in every one (F2). Nothing
     * here offers a download: a creator has none for an agent world yet.
     */
    save: {
        saving: 'Saving…',
        saved: 'Saved',
        yourWorlds: 'Your worlds',
        signIn: 'Sign in to keep this world',
        signInWhy: 'Sign in with Google to save this world to your account.',
        notSaved: 'Not saved',
        tryAgain: 'Try again',
        save: 'Save',
        failedWhy: 'Saving isn\'t available right now. Your world is still here: you can still film it and take photos.',
        offline: 'Not saved: no connection',
        offlineWhy: 'Wexy couldn\'t reach its server. Check your connection, then press Try again.',
        notSavedWhy: 'Saving isn\'t available for this account right now. Your world is still here: you can still film it and take photos.',
        notAllowedWhy: 'This account can\'t save worlds right now. Your world is still here: you can still film it and take photos.',
        /** Q129 (the user, 2026-11-04): a world belongs to the account that made it, and only that account saves it. */
        savedElsewhere: 'Saved to the account that made it',
        savedElsewhereWhy: 'This world is saved to the account that made it, not to this one. It stays here: you can still film it and take photos.',
        elsewhereWhy: 'This world was made with another account, and only that account can save it. It stays here: you can still film it and take photos.',
        conflict: 'Not saved: changed in another tab',
        conflictWhy: 'A newer version of this world was saved elsewhere. Save your copy as a new world, or open the saved one.',
        saveAsNew: 'Save as a new world',
        openSaved: 'Open the saved one',
        openSavedConfirm: 'Open the saved version? The world on the stage isn\'t saved, and the saved one will replace it.',
        full: 'Not saved: your storage is full',
        fullWhy: 'Your saved worlds are full. Delete one you no longer need in Your worlds, then press Try again.',
        tooLarge: 'Not saved: too large',
        tooLargeWhy: 'This world is too large to save. It stays here: you can still film it and take photos.',
    },
    /**
     * A saved world opened in the studio (W3.6; the companion §8 and §12): one sentence a step. Show it is the GPU go,
     * as for any world (Q115): the link that opened the page grants none. The world on the stage stays until then.
     */
    open: {
        opening: 'Opening your saved world…',
        signIn: 'Sign in with Google to open your saved worlds.',
        checking: 'Checking it on your graphics card…',
        ready: (title: string) => `“${title}” is ready. Press Show it to test it on your graphics card.`,
        show: 'Show it',
        testing: 'Testing it on your graphics card…',
        missing: 'This world isn\'t available. It may have been deleted, or saved to another account.',
        unavailable: 'Your saved worlds can\'t be reached right now. Reload the page to try again.',
        incompatible: 'This world was made for another version of the studio, so it can\'t be opened here.',
        unsealed: 'This saved world can\'t be opened in this version of the studio.',
        notHere: 'This saved world can\'t be tested on this device.',
        runRefused: 'This saved world didn\'t pass its test on your graphics card; your current world is unchanged. Press Show it to try again.',
        accountChanged: 'You signed in or out while this world was opening. Open it again from Your worlds.',
        noStage: 'Opening a saved world needs WebGPU, which this browser doesn\'t offer.',
    },
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
