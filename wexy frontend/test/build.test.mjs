// Build safeguards: keep the documented verification command complete and config type-checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const json = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('verification runs tests and contrast before producing the static build', () => {
    assert.equal(json('package.json').scripts.verify, 'npm test && npm run contrast && npm run build');
});

test('the build configuration is included in type-checking', () => {
    assert.ok(json('tsconfig.json').include.includes('vite.config.ts'));
    assert.ok(json('tsconfig.json').compilerOptions.types.includes('node'));
    assert.ok(json('package.json').devDependencies['@types/node']);
});

test('the runtime requirement is declared and mirrored in the lockfile', () => {
    assert.equal(json('package.json').engines.node, '>=24.12.0');
    assert.deepEqual(json('package-lock.json').packages[''].engines, json('package.json').engines);
});