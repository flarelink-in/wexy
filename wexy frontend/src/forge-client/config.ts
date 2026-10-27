// The browser's public configuration (coding principles §11): the gateway's origin, Wexy's Firebase web
// config and the App Check site key, from Vite's VITE_* variables (.env.example lists them). All of it
// ships in the bundle; no secret ever passes through here. Read once; parseConfig is pure, for the tests.

export interface FirebaseWebConfig {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
}

export interface PublicConfig {
    /** The gateway's origin, with no trailing slash; null when unset, and then every API call fails loudly. */
    apiOrigin: string | null;
    /** Null when the web app is not configured: no Firebase, no sign-in. */
    firebase: FirebaseWebConfig | null;
    /** The reCAPTCHA Enterprise site key; null sends no App Check token. */
    appCheckSiteKey: string | null;
    /** A development build: it may use the App Check debug token and the local dev identity, on loopback only. */
    dev: boolean;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The configuration in `env`, and what is wrong with it, in words a developer can act on. A missing origin is
 * a problem; a missing Firebase config is a choice (local development without it), reported as a note.
 */
export function parseConfig(env: Record<string, unknown>): { config: PublicConfig; problems: string[] } {
    const problems: string[] = [];
    let apiOrigin: string | null = null;
    const origin = text(env.VITE_API_ORIGIN);
    if (!origin) {
        problems.push('VITE_API_ORIGIN is not set: every call to the backend will fail. Set it in .env.local (see .env.example).');
    } else {
        try {
            const url = new URL(origin);
            if (url.origin !== origin.replace(/\/+$/, '')) throw new Error('not an origin');
            if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new Error('not https');
            apiOrigin = url.origin;
        } catch {
            problems.push(`VITE_API_ORIGIN "${origin}" is not an https origin (or http on localhost), like https://api.wexy.ai.`);
        }
    }

    const fields = {
        apiKey: text(env.VITE_FIREBASE_API_KEY),
        authDomain: text(env.VITE_FIREBASE_AUTH_DOMAIN),
        projectId: text(env.VITE_FIREBASE_PROJECT_ID),
        appId: text(env.VITE_FIREBASE_APP_ID),
    };
    let firebase: FirebaseWebConfig | null = null;
    if (fields.apiKey) {
        const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) problems.push(`The Firebase web config is incomplete: ${missing.join(', ')} not set. Sign-in stays off.`);
        else firebase = fields;
    }
    const siteKey = text(env.VITE_APPCHECK_SITE_KEY);
    if (siteKey && !firebase) problems.push('VITE_APPCHECK_SITE_KEY is set without the Firebase web config: App Check stays off.');

    return {
        config: { apiOrigin, firebase, appCheckSiteKey: firebase && siteKey ? siteKey : null, dev: env.DEV === true },
        problems,
    };
}

/** localhost, 127.0.0.0/8 or [::1]: where a development identity may be used. */
export function isLoopback(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

let cached: PublicConfig | null = null;

/** This build's configuration. Problems are logged once, at the first read, never per call. */
export function readConfig(): PublicConfig {
    if (cached) return cached;
    const { config, problems } = parseConfig(import.meta.env as unknown as Record<string, unknown>);
    // A missing origin is a mode (the studio alone, dev workflow §3 A), said once as a warning; the rest are errors.
    for (const p of problems) (p.startsWith('VITE_API_ORIGIN is not set') ? console.warn : console.error)(`config: ${p}`);
    cached = config;
    return config;
}
