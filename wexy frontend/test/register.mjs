// Lets `node --test` load the TypeScript sources as Vite does: Node 24 strips the types itself, and this hook
// resolves the extensionless relative imports the sources use (`./errors` is `./errors.ts`). Modules reached
// this way must use `import type` for types (coding principles §12), since stripping cannot tell them apart.
// Vite's `?raw` imports (the embedded host h1 under src/contract/h1/) are served here too: the file's text as the
// module's default export, byte for byte as checked out.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

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
            const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
            return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
        }
        return nextLoad(url, context);
    },
});
