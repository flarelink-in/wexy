// FlareLink-inspired public HTML endpoints, written independently for Wexy's static landing page.
import { readFileSync } from 'node:fs';
import { onRequest } from 'firebase-functions/v2/https';
import { publicResponse, SECURITY_HEADERS, SITES } from './render.mjs';

function handler(environment) {
    let template;
    return (req, res) => {
        try {
            const response = publicResponse(req, SITES[environment], () => {
                template ??= readFileSync(new URL(`./hosting/${environment}/index.html`, import.meta.url), 'utf8');
                return template;
            });
            res.set(response.headers).status(response.status).send(response.body);
        } catch {
            // Fail closed: never send an old fallback shell pointing at another release's assets.
            console.error(`Public HTML template unavailable for ${environment}; rebuild the matching Hosting artifact.`);
            res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Retry-After': '60' })
                .status(503).send('This page is temporarily unavailable. Please try again shortly.');
        }
    };
}

// Public-only endpoints: crawlers cannot supply App Check. The gateway's protections are unchanged.
const options = { region: 'us-central1', invoker: 'public', minInstances: 0, maxInstances: 2,
    memory: '256MiB', timeoutSeconds: 15, concurrency: 40 };
export const renderPublicDev = onRequest(options, handler('dev'));
export const renderPublicProd = onRequest(options, handler('prod'));