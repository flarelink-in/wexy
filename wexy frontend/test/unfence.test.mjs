// C-series, headless: the fence rule (src/contract/unfence.ts), the backend's CodeBlocks.unfence mirrored (its U4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unfence } from '../src/contract/unfence.ts';

const FN = 'fn sky(dir: vec3f) -> vec3f {\n    return vec3f(0.0);\n}';

test('C5 unfenced text is unchanged; a fenced answer is its first block; the rest is dropped', () => {
    assert.equal(unfence(FN), FN);
    assert.equal(unfence(`\`\`\`wgsl\n${FN}\n\`\`\``), FN);
    assert.equal(unfence(`Here you go:\n\n\`\`\`\n${FN}\n\`\`\`\n\nAnd a second block:\n\`\`\`wgsl\nfn other() {}\n\`\`\`\n`), FN);
    // An indented fence line is still a fence; a stream cut before the closing fence runs to the end.
    assert.equal(unfence(`  \`\`\`wgsl\n${FN}`), FN);
    assert.equal(unfence('```\n```'), '');
    assert.equal(unfence(''), '');
});
