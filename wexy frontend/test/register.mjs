// Lets `node --test` load the TypeScript sources as Vite does: Node 24 strips the types itself, and this hook
// resolves the extensionless relative imports the sources use (`./errors` is `./errors.ts`). Modules reached
// this way must use `import type` for types (coding principles §12), since stripping cannot tell them apart.
// Vite's `?raw` imports (the embedded host h1 under src/contract/h1/) are served here too: the file's text as the
// module's default export, byte for byte as checked out.
//
// KR-U3 (test/kernels.test.mjs, render-kernels-design.md §10) runs a child process over an edited copy of a file the
// model reads: WEXY_RAW_OVERRIDES maps such a file's absolute path to its stand-in's, and its import (`?raw` or a
// source module, such as a pin re-pinned with its edit) then serves the stand-in's text. Only that test sets it; with it
// unset, every file is served as checked out.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const OVERRIDES = process.env.WEXY_RAW_OVERRIDES ? JSON.parse(process.env.WEXY_RAW_OVERRIDES) : {};

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (/^\.{1,2}\//.test(specifier) && !specifier.endsWith('?raw') && !/\.[cm]?[jt]s$/.test(specifier)) {
            for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
                try { return nextResolve(candidate, context); } catch { /* the next form */ }
            }
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url.endsWith('?raw')) {
            const path = fileURLToPath(url.slice(0, -'?raw'.length));
            const text = readFileSync(Object.hasOwn(OVERRIDES, path) ? OVERRIDES[path] : path, 'utf8');
            return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
        }
        if (url.startsWith('file:') && Object.hasOwn(OVERRIDES, fileURLToPath(url))) {
            // The module as it would load, its text the stand-in's: its own URL, so its relative imports resolve as before.
            return { ...nextLoad(url, context), source: readFileSync(OVERRIDES[fileURLToPath(url)], 'utf8') };
        }
        return nextLoad(url, context);
    },
});
