// Build a separate deploy artifact: index.html must not shadow Firebase's root Function rewrite.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareHosting(root, environment, check = false) {
    if (!['dev', 'prod'].includes(environment)) throw new Error('Expected hosting environment: dev or prod');
    const build = resolve(root, environment === 'dev' ? 'dist-dev' : 'dist');
    const hosting = resolve(root, `hosting-${environment}`);
    const functions = resolve(root, 'functions/hosting', environment);
    const template = readFileSync(resolve(build, 'index.html'), 'utf8');
    if (check) {
        if (existsSync(resolve(hosting, 'index.html'))) throw new Error('Static index.html shadows the root Function');
        if (readFileSync(resolve(functions, 'index.html'), 'utf8') !== template) throw new Error('Function template is stale');
        for (const match of template.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
            const path = match[1].slice(1);
            if (!readFileSync(resolve(hosting, path)).equals(readFileSync(resolve(build, path)))) {
                throw new Error(`Hosting asset is stale: ${path}`);
            }
        }
        for (const page of ['studio.html', 'creations.html']) {
            if (!readFileSync(resolve(hosting, page)).equals(readFileSync(resolve(build, page)))) {
                throw new Error(`${page} artifact is stale`);
            }
        }
        return;
    }
    rmSync(hosting, { recursive: true, force: true });
    cpSync(build, hosting, { recursive: true });
    rmSync(resolve(hosting, 'index.html'));
    // Keep the former URL working without bypassing the dynamic metadata at the canonical root.
    for (const name of ['robots.txt', 'sitemap.xml']) rmSync(resolve(hosting, name), { force: true });
    mkdirSync(functions, { recursive: true });
    writeFileSync(resolve(functions, 'index.html'), template);
    prepareHosting(root, environment, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    prepareHosting(fileURLToPath(new URL('../', import.meta.url)), process.argv[2], process.argv.includes('--check'));
    console.log(`Hosting ${process.argv[2]} artifact and Function template verified.`);
}