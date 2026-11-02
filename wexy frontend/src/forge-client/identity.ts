// Who is calling, as the gateway asks (backend core-loop-backend.md §10 and §11): a Firebase ID token in
// Authorization, anonymous for the first world (no wall before it), and since W1 (Q92) a Google link for early access,
// which keeps the anonymous uid; and an App Check token in X-Firebase-AppCheck (reCAPTCHA Enterprise). Firebase loads
// on the first call or sign-in that needs it, never with the page, so the first world draws without it and a page view
// spends no reCAPTCHA. The pattern comes from the author's FlareLink client (pre-existing work, README), rewritten here
// without React or axios.

import type { AppCheck } from 'firebase/app-check';
import type { Auth, AuthCredential, AuthProvider, User, UserCredential } from 'firebase/auth';
import { isLoopback, type FirebaseWebConfig, type PublicConfig } from './config';

/** How a caller is signed in: an anonymous Firebase user, or one with Google (W1; the creations platform companion §6). */
export type Provider = 'anonymous' | 'google';

/** Who is signed in, as this browser knows it. The uid stays in the session (it tells an account switch); never on screen. */
export interface SignedIn {
    readonly uid: string;
    readonly provider: Provider;
}

/** A Google credential another Wexy account already holds (`auth/credential-already-in-use`): signing in to it is offered. */
export interface Collision {
    readonly credential: unknown;
}

/** What a sign-in action came to. Nothing but `linked` and `signed-in` changes who is signed in. */
export type LinkOutcome =
    /** The anonymous user gained Google: the same uid, a fresh token that says so. */
    | { readonly kind: 'linked' }
    /** Signed in with Google: there was no user, the creator chose the existing account, or Google was there already. */
    | { readonly kind: 'signed-in' }
    | { readonly kind: 'collision'; readonly collision: Collision }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'failed'; readonly code: string };

/**
 * The account actions (W1): what the studio's Sign in and Sign out do. Every one is the creator's own action; none runs
 * on a page view, so Firebase (and App Check's reCAPTCHA with it) still loads only when a call or the creator needs it.
 */
export interface AccountPort {
    /** Who is signed in now. It never signs anyone in; null when no one is. */
    current(): Promise<SignedIn | null>;
    /** Google for this browser: links the anonymous user, keeping its uid, or signs in when there is none. */
    linkGoogle(): Promise<LinkOutcome>;
    /** After a collision, the creator's choice: sign in to the account that holds that Google credential. */
    signInExisting(collision: Collision): Promise<LinkOutcome>;
    signOut(): Promise<void>;
    /** Calls `listener` when the signed-in user changes, another tab's sign-out included; returns the unsubscribe. */
    onChange(listener: () => void): () => void;
}

export interface Identity {
    /** The `Authorization` value, or null when this build has no way to sign in (the gateway then answers 401). */
    authorization(forceRefresh: boolean): Promise<string | null>;
    /**
     * The `X-Firebase-AppCheck` value, or null when App Check is off or no token could be minted: attestation is
     * defence in depth, and the gateway decides what an unattested request is worth. `singleUse` mints a
     * limited-use token, for the routes where the gateway spends it (http.ts, SINGLE_USE_ROUTES).
     */
    appCheck(singleUse: boolean): Promise<string | null>;
    /** The account actions, when this build can sign in (W1): Firebase, or the loopback dev identity; absent otherwise. */
    readonly account?: AccountPort;
}

/** The Firebase Auth functions the account port uses: injected, so it is tested without Firebase (test/session.test.mjs). */
export interface AuthFunctions {
    linkWithPopup(user: User, provider: AuthProvider): Promise<UserCredential>;
    signInWithPopup(auth: Auth, provider: AuthProvider): Promise<UserCredential>;
    signInWithCredential(auth: Auth, credential: AuthCredential): Promise<UserCredential>;
    signOut(auth: Auth): Promise<void>;
    onAuthStateChanged(auth: Auth, next: () => void): () => void;
    googleProvider(): AuthProvider;
    credentialFromError(error: unknown): AuthCredential | null;
}

interface Loaded {
    auth: Auth;
    signInAnonymously: typeof import('firebase/auth').signInAnonymously;
    fns: AuthFunctions;
    appCheck: AppCheck | null;
    getToken: typeof import('firebase/app-check').getToken;
    getLimitedUseToken: typeof import('firebase/app-check').getLimitedUseToken;
}

/** Where the local dev identity's uid is kept, so a reload keeps ownership of its generations (repairs check it). */
const DEV_UID_KEY = 'wexy.devUid';
/** Where the local dev identity keeps its "signed in with Google" (W1), so a reload keeps early access as a link would. */
const DEV_PROVIDER_KEY = 'wexy.devProvider';

/**
 * The identity for this build. Without a Firebase web config, a development build calling a loopback gateway
 * sends the backend's local dev token, `dev.anonymous.<uid>` (its forge-loop design §9, Q22, accepted), and since W1
 * `dev.google.<uid>` once the dev account has "signed in": the uid kept, as a Google link keeps it, and the gateway's
 * local profile accepts both. Any other build sends nothing, and the gateway refuses with `auth`.
 */
export function createIdentity(config: PublicConfig): Identity {
    const { firebase } = config;
    if (!firebase) {
        const dev = !!(config.dev && config.apiOrigin && isLoopback(new URL(config.apiOrigin).hostname));
        if (!dev) return { authorization: async () => null, appCheck: async () => null };
        return {
            authorization: async () => `Bearer dev.${devProvider()}.${devUid()}`,
            appCheck: async () => null,
            account: devAccount(),
        };
    }

    let loaded: Promise<Loaded> | null = null;
    const load = () => (loaded ??= loadFirebase(firebase, config).catch(error => {
        loaded = null; // a later call tries again: the network may be back
        throw error;
    }));

    let signingIn: Promise<User> | null = null;
    const signIn = (fb: Loaded) => (signingIn ??= fb.signInAnonymously(fb.auth)
        .then(credential => credential.user)
        .catch(error => {
            const code = (error as { code?: string }).code ?? String(error);
            throw new Error(`identity: anonymous sign-in failed (${code}). Is Anonymous enabled in Firebase Authentication for ${firebase.projectId}?`);
        })
        .finally(() => { signingIn = null; }));

    return {
        account: firebaseAccount(async () => {
            const fb = await load();
            return { auth: fb.auth, fns: fb.fns };
        }),
        async authorization(forceRefresh) {
            const fb = await load();
            const user = fb.auth.currentUser ?? (await signIn(fb));
            return `Bearer ${await user.getIdToken(forceRefresh)}`;
        },
        async appCheck(singleUse) {
            if (!config.appCheckSiteKey) return null;
            try {
                const fb = await load();
                const check = fb.appCheck;
                if (!check) return null;
                // Where the gateway spends the token, a fresh one; if minting it fails, the cached token is still
                // worth sending: unspent until such a route takes it, and the gateway judges it either way.
                const { token } = singleUse
                    ? await fb.getLimitedUseToken(check).catch(() => fb.getToken(check))
                    : await fb.getToken(check);
                return token;
            } catch (error) {
                if (config.dev) console.warn('identity: no App Check token for this request.', error);
                return null;
            }
        },
    };
}

/** Firebase codes that mean the creator closed or replaced the window: nothing happened, and nothing is said. */
const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

/**
 * The account port over Firebase Auth (W1; the creations platform companion §6): Google links the anonymous user with
 * `linkWithPopup`, so the uid and its worlds stay, and a fresh ID token follows at once, since the cached one still
 * says `sign_in_provider: anonymous` and the gateway and forge would go on counting the caller as anonymous. A
 * credential another account holds is a collision: no account is merged, and the creator chooses. Exported for the
 * tests, which hand it fake functions.
 */
export function firebaseAccount(load: () => Promise<{ auth: Auth; fns: AuthFunctions }>): AccountPort {
    const outcomeOf = (error: unknown, fns: AuthFunctions): LinkOutcome => {
        const code = (error as { code?: unknown })?.code;
        if (typeof code !== 'string') return { kind: 'failed', code: String((error as Error)?.message ?? error).slice(0, 80) };
        if (code === 'auth/credential-already-in-use') {
            const credential = fns.credentialFromError(error);
            return credential ? { kind: 'collision', collision: { credential } } : { kind: 'failed', code };
        }
        if (CANCELLED.has(code)) return { kind: 'cancelled' };
        if (code === 'auth/popup-blocked') return { kind: 'blocked' };
        return { kind: 'failed', code };
    };
    return {
        async current() {
            const { auth } = await load();
            const user = auth.currentUser;
            return user ? { uid: user.uid, provider: user.isAnonymous ? 'anonymous' : 'google' } : null;
        },
        async linkGoogle() {
            const { auth, fns } = await load();
            const user = auth.currentUser;
            try {
                if (!user) {
                    await fns.signInWithPopup(auth, fns.googleProvider());
                    return { kind: 'signed-in' };
                }
                if (!user.isAnonymous) return { kind: 'signed-in' };
                const linked = await fns.linkWithPopup(user, fns.googleProvider());
                await linked.user.getIdToken(true);
                return { kind: 'linked' };
            } catch (error) {
                if ((error as { code?: unknown })?.code === 'auth/provider-already-linked' && user) {
                    await user.getIdToken(true);
                    return { kind: 'linked' };
                }
                return outcomeOf(error, fns);
            }
        },
        async signInExisting(collision) {
            const { auth, fns } = await load();
            try {
                await fns.signInWithCredential(auth, collision.credential as AuthCredential);
                return { kind: 'signed-in' };
            } catch (error) {
                return outcomeOf(error, fns);
            }
        },
        async signOut() {
            const { auth, fns } = await load();
            await fns.signOut(auth);
        },
        onChange(listener) {
            let off: (() => void) | null = null;
            let stopped = false;
            void load().then(({ auth, fns }) => {
                if (!stopped) off = fns.onAuthStateChanged(auth, listener);
            }, () => {});
            return () => {
                stopped = true;
                off?.();
            };
        },
    };
}

/**
 * The loopback dev identity's account (W1): "Sign in" turns `dev.anonymous.<uid>` into `dev.google.<uid>`, the uid
 * kept as a Google link keeps it, and "Sign out" forgets both, so the next call is a new anonymous caller. Never a
 * collision: no two dev uids share a Google account. The drives use it to walk the allowance without OAuth.
 */
function devAccount(): AccountPort {
    const listeners = new Set<() => void>();
    const tell = () => { for (const l of [...listeners]) l(); };
    return {
        current: async () => ({ uid: devUid(), provider: devProvider() === 'google' ? 'google' : 'anonymous' }),
        async linkGoogle() {
            devUid();
            setDev(DEV_PROVIDER_KEY, 'google');
            tell();
            return { kind: 'linked' };
        },
        signInExisting: async () => ({ kind: 'failed', code: 'dev/no-collision' }),
        async signOut() {
            setDev(DEV_PROVIDER_KEY, null);
            setDev(DEV_UID_KEY, null);
            tell();
        },
        onChange(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

async function loadFirebase(firebase: FirebaseWebConfig, config: PublicConfig): Promise<Loaded> {
    const [{ initializeApp }, authModule, checkModule] = await Promise.all([
        import('firebase/app'), import('firebase/auth'), import('firebase/app-check'),
    ]);
    const app = initializeApp(firebase);
    // App Check starts before Auth is touched, so Auth's own requests carry a token from the first one.
    let appCheck: AppCheck | null = null;
    if (config.appCheckSiteKey) {
        // reCAPTCHA cannot attest localhost, so a development build on a loopback page asks the SDK for a debug
        // token instead; the SDK logs it, to be registered under App Check > Apps > Manage debug tokens. A debug
        // token passes attestation from anywhere, so a production build (dev false) or a real host never asks. A
        // token already set on the page is kept: a test harness gives a registered one at run time (never a build's).
        if (config.dev && isLoopback(location.hostname)) {
            const page = globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string };
            if (typeof page.FIREBASE_APPCHECK_DEBUG_TOKEN !== 'string') page.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        }
        try {
            appCheck = checkModule.initializeAppCheck(app, {
                provider: new checkModule.ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
                isTokenAutoRefreshEnabled: true,
            });
        } catch (error) {
            console.error('identity: App Check did not start, so calls go without attestation.', error);
        }
    }
    const auth = authModule.getAuth(app);
    // The persisted user (an anonymous uid survives reloads) is known only once this resolves.
    await auth.authStateReady();
    return {
        auth,
        signInAnonymously: authModule.signInAnonymously,
        fns: {
            linkWithPopup: authModule.linkWithPopup,
            signInWithPopup: authModule.signInWithPopup,
            signInWithCredential: authModule.signInWithCredential,
            signOut: authModule.signOut,
            onAuthStateChanged: (a, next) => authModule.onAuthStateChanged(a, () => next()),
            googleProvider: () => new authModule.GoogleAuthProvider(),
            credentialFromError: error => authModule.GoogleAuthProvider.credentialFromError(error as Parameters<typeof authModule.GoogleAuthProvider.credentialFromError>[0]),
        },
        appCheck,
        getToken: checkModule.getToken,
        getLimitedUseToken: checkModule.getLimitedUseToken,
    };
}

/**
 * A uid for the local dev identity, kept per browser; storage can be missing or blocked, which costs only stability
 * (the uid is then this call's alone).
 */
let memoryUid: string | null = null;
function devUid(): string {
    const fresh = () => crypto.randomUUID().replace(/-/g, '');
    try {
        const kept = localStorage.getItem(DEV_UID_KEY);
        if (kept && /^[a-f0-9]{32}$/.test(kept)) return kept;
        const uid = fresh();
        localStorage.setItem(DEV_UID_KEY, uid);
        return uid;
    } catch {
        return (memoryUid ??= fresh());
    }
}

/** The dev identity's provider: `google` once its account signed in, `anonymous` otherwise. */
function devProvider(): 'anonymous' | 'google' {
    try {
        return localStorage.getItem(DEV_PROVIDER_KEY) === 'google' ? 'google' : 'anonymous';
    } catch {
        return 'anonymous';
    }
}

function setDev(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Storage blocked: the dev identity lives in this page alone.
    }
    if (key === DEV_UID_KEY && value === null) memoryUid = null;
}
