// C-series, headless: the director's edit plan at the boundary (src/contract/edit-plan.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEditPlan } from '../src/contract/edit-plan.ts';

test('C19 the four kinds parse, from the backend\'s {edit} document or bare', () => {
    assert.deepEqual(parseEditPlan({ edit: { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.9 }], summary: 'The glow is stronger.' } }),
        { kind: 'patch', ops: [{ path: 'post.bloom.intensity', value: 0.9 }], summary: 'The glow is stronger.' });
    assert.deepEqual(parseEditPlan({ kind: 'rewrite', functions: ['evolve', 'evolve', 'sky'], instruction: 'collide', summary: 's' }),
        { kind: 'rewrite', functions: ['evolve', 'sky'], instruction: 'collide', ops: [], summary: 's' });
    assert.deepEqual(parseEditPlan({ kind: 'restart', prompt: 'a storm' }), { kind: 'restart', prompt: 'a storm' });
    assert.deepEqual(parseEditPlan({ kind: 'clarify', question: 'Faster how?' }), { kind: 'clarify', question: 'Faster how?' });
    assert.deepEqual(parseEditPlan({ kind: 'patch', ops: [{ path: 'camera.keyframes.0.target', value: [0, 1, 0] }, { path: 'camera.move', value: 'orbit' }, { path: 'post.fxaa', value: true }], summary: 's' }).ops.map(o => o.value),
        [[0, 1, 0], 'orbit', true]);
});

test('C20 a broken plan is refused with what broke', () => {
    for (const [bad, pattern] of [
        [{ kind: 'patch', ops: [], summary: 's' }, /edit\.ops is not an array of 1 to 16/],
        [{ kind: 'patch', ops: [{ path: 'x', value: { a: 1 } }], summary: 's' }, /edit\.ops\[0\]\.value/],
        [{ kind: 'rewrite', functions: ['arrange'], instruction: 'x', summary: 's' }, /edit\.functions/],
        [{ kind: 'undo' }, /edit\.kind is "undo"/],
        [{ edit: null }, /not an object/],
        [{ kind: 'clarify', question: '' }, /edit\.question/],
    ]) {
        assert.throws(() => parseEditPlan(bad), pattern);
    }
});
