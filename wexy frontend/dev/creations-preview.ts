// The history's view over stand-in worlds (W3.5), for dev/creations-layout.mjs: a long title, one with no space in its
// 120 characters, and a world of a line this build does not open. No backend, no sign-in.
import '../src/styles/base.css';
import '../src/styles/creations.css';
import { renderHistory } from '../src/shell/creations/view';

const at = '2026-11-03T12:00:00.000Z';
const world = (id: string, title: string, line = 'ea.v1') => ({
    worldId: `01JC3W5F6Q7R8S9T0V1W2X3Y${id}`, title, rowVersion: 0, createdAt: at, updatedAt: at,
    head: { revisionId: '01JC3W5F6Q7R8S9T0V1W2X3Y50', sha256: 'a'.repeat(64), bytes: 20541, format: 'wexy-world.v1', line, createdAt: at },
});
const nothing = async () => ({ kind: 'unavailable' as const });
renderHistory(document.getElementById('history') as HTMLElement, {
    worlds: [
        world('4Z', 'The castle on the hill'),
        world('4Y', 'A long title that runs on, to see how a card wraps its words at a phone\'s width with nothing to scroll sideways', 'ea.v0'),
        world('4X', 'Storm'),
        world('4W', 'W'.repeat(120)),
    ],
    next: 'page-2',
}, { usedBytes: 82_164, reservedBytes: 0, worlds: 4, limits: { bytes: 104_857_600, worlds: 50 } }, {
    rename: nothing, remove: nothing, reread: async () => 'unavailable', more: async () => null, confirm: async () => false, removed: () => {},
});
document.body.dataset.ready = '1';
