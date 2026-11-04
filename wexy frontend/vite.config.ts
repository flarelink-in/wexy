import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * `/creations` as Firebase Hosting serves it (firebase.json's rewrite to creations.html, W3.5), under `npm run dev` and
 * `npm run preview` too, so the page's own address works before a deploy.
 */
function pageRoutes(): Plugin {
    const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
        if (req.url === '/creations' || req.url?.startsWith('/creations?')) req.url = `/creations.html${req.url.slice('/creations'.length)}`;
        next();
    };
    return {
        name: 'wexy-page-routes',
        configureServer(server) { server.middlewares.use(rewrite); },
        configurePreviewServer(server) { server.middlewares.use(rewrite); },
    };
}

// The home page, the studio and, since W3.5, the history (`/creations`); `world.html` (share links) arrives with W4.
// All static client pages. prepare-hosting.mjs pairs the public landing template with a metadata Function; the dev
// pages under dev/ (film gates, smoke test) are served by the dev server only and never built.
export default defineConfig({
    plugins: [pageRoutes()],
    build: {
        target: 'es2022',
        rollupOptions: {
            input: {
                index: resolve(import.meta.dirname, 'index.html'),
                studio: resolve(import.meta.dirname, 'studio.html'),
                creations: resolve(import.meta.dirname, 'creations.html'),
            },
        },
    },
    // 5173 is the origin the gateway's local profile allows (backend: application-local.yaml).
    server: { port: 5173, strictPort: true },
    preview: { port: 4173 },
});
