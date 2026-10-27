// Who is calling, as the gateway asks (backend core-loop-backend.md §10 and §11): a Firebase ID token in
// Authorization, anonymous until a creator signs in to publish (Q8: no wall before the first world), and an App
// Check token in X-Firebase-AppCheck (reCAPTCHA Enterprise). Firebase loads on the first call that needs a
// token, never with the page, so the first world draws without it. The pattern comes from the author's
// FlareLink client (pre-existing work, README), rewritten here without React or axios.

import type { AppCheck } from 'firebase/app-check';
import type { Auth, User } from 'firebase/auth';
import { isLoopback, type FirebaseWebConfig, type PublicConfig } from './config';

export interface Identity {
    /** The `Authorization` value, or null when this build has no way to sign in (the gateway then answers 401). */
    authorization(forceRefresh: boolean): Promise<string | null>;
    /**
     * The `X-Firebase-AppCheck` value, or null when App Check is off or no token could be minted: attestation is
     * defence in depth, and the gateway decides what an unattested request is worth. `singleUse` mints a
     * limited-use token, for the routes where the gateway spends it (http.ts, SINGLE_USE_ROUTES).
     */
    appCheck(singleUse: boolean): Promise<string | null>;
}

interface Loaded {
    auth: Auth;
    signInAnonymously: typeof import('firebase/auth').signInAnonymously;
    appCheck: AppCheck | null;
    getToken: typeof import('firebase/app-check').getToken;
    getLimitedUseToken: typeof import('firebase/app-check').getLimitedUseToken;
}

/** Where the local dev identity's uid is kept, so a reload keeps ownership of its generations (repairs check it). */
const DEV_UID_KEY = 'wexy.devUid';

/**
 * The identity for this build. Without a Firebase web config, a development build calling a loopback gateway
 * sends the backend's local dev token, `dev.anonymous.<uid>` (its forge-loop design §9, Q22, accepted); any
 * other build sends nothing, and the gateway refuses with `auth`.
 */
export function createIdentity(config: PublicConfig): Identity {
    const { firebase } = config;
    if (!firebase) {
        const devToken = config.dev && config.apiOrigin && isLoopback(new URL(config.apiOrigin).hostname)
            ? `dev.anonymous.${devUid()}` : null;
        return {
            authorization: async () => (devToken ? `Bearer ${devToken}` : null),
            appCheck: async () => null,
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
        // token passes attestation from anywhere, so a production build (dev false) or a real host never asks.
        if (config.dev && isLoopback(location.hostname)) {
            (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
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
        appCheck,
        getToken: checkModule.getToken,
        getLimitedUseToken: checkModule.getLimitedUseToken,
    };
}

/** A uid for the local dev identity, kept per browser; storage can be missing or blocked, which costs only stability. */
function devUid(): string {
    const fresh = () => crypto.randomUUID().replace(/-/g, '');
    try {
        const kept = localStorage.getItem(DEV_UID_KEY);
        if (kept && /^[a-f0-9]{32}$/.test(kept)) return kept;
        const uid = fresh();
        localStorage.setItem(DEV_UID_KEY, uid);
        return uid;
    } catch {
        return fresh();
    }
}
