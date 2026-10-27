import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two pages for now: the home page and the studio; `world.html` (share links) arrives with FE6. All
// static, so the build is served by Firebase Hosting with no server runtime (`firebase.json`). The
// dev pages under dev/ (film gates, smoke test) are served by the dev server only and never built.
export default defineConfig({
    build: {
        target: 'es2022',
        rollupOptions: {
            input: {
                index: resolve(import.meta.dirname, 'index.html'),
                studio: resolve(import.meta.dirname, 'studio.html'),
            },
        },
    },
    // 5173 is the origin the gateway's local profile allows (backend: application-local.yaml).
    server: { port: 5173, strictPort: true },
    preview: { port: 4173 },
});
