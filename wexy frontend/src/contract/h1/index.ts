// Host h1, embedded byte for byte from the backend's forge-service/src/main/resources (Q28, decided 2026-10-27):
// the two views the model is shown (the particle pass and the sky pass), the rules of the Standard setting, the
// helper library the host compiles in front of every function, two exemplars of each function, the recorded fault
// for the repair path, and the two recorded plans the mock replays. The backend owns these files; each side pins
// the other's hash (test/host.test.mjs, HostContractTest), so what the model is told and what the browser compiles
// cannot drift apart. The text is normalized as the backend reads it (LF line ends, no trailing blank lines), so
// the bytes match whatever this checkout's line endings are.

import particles from './particles.wgsl?raw';
import sky from './sky.wgsl?raw';
import rules from './rules.md?raw';
import helpers from './helpers.wgsl?raw';
import galaxyEvolve from './exemplars/galaxy.evolve.wgsl?raw';
import galaxyLook from './exemplars/galaxy.look.wgsl?raw';
import galaxySky from './exemplars/galaxy.sky.wgsl?raw';
import galaxyEvolveFault from './exemplars/galaxy.evolve.fault.wgsl?raw';
import stormEvolve from './exemplars/storm.evolve.wgsl?raw';
import stormLook from './exemplars/storm.look.wgsl?raw';
import stormSky from './exemplars/storm.sky.wgsl?raw';
import galaxyPlan from './plans/galaxy.json?raw';
import stormPlan from './plans/storm.json?raw';
import type { FunctionName } from '../spec';

/** The backend's HostContract.read: LF line ends and no trailing whitespace, the same bytes on every OS. */
export const normalizeHostText = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

export type ExemplarWorld = 'galaxy' | 'storm';
export const EXEMPLAR_WORLDS: readonly ExemplarWorld[] = ['galaxy', 'storm'];

export const H1 = {
    version: 'h1',
    /** The particle pass as the model sees it: Sim, Params, Particle, Look, the helper signatures, evolve and look. */
    particles: normalizeHostText(particles),
    /** The sky pass as the model sees it. */
    sky: normalizeHostText(sky),
    rules: normalizeHostText(rules),
    /** The helper library's code: compiled in front of every function (host.ts). */
    helpers: normalizeHostText(helpers),
    exemplars: {
        galaxy: { evolve: normalizeHostText(galaxyEvolve), look: normalizeHostText(galaxyLook), sky: normalizeHostText(galaxySky) },
        storm: { evolve: normalizeHostText(stormEvolve), look: normalizeHostText(stormLook), sky: normalizeHostText(stormSky) },
    } satisfies Record<ExemplarWorld, Record<FunctionName, string>>,
    /** The mock's fault: the galaxy's evolve with `hash11(i)`, a u32 where an f32 is expected (line 11, column 25). */
    faults: { 'galaxy.evolve': normalizeHostText(galaxyEvolveFault) },
    /** The recorded plans, scene-draft.v1 instances, as text. */
    plans: { galaxy: normalizeHostText(galaxyPlan), storm: normalizeHostText(stormPlan) } satisfies Record<ExemplarWorld, string>,
} as const;

/** Every embedded file by its path under host/h1 (and mock/plans), for the hash the backend pins. */
export const H1_FILES: Readonly<Record<string, string>> = {
    'particles.wgsl': H1.particles,
    'sky.wgsl': H1.sky,
    'rules.md': H1.rules,
    'helpers.wgsl': H1.helpers,
    'exemplars/galaxy.evolve.wgsl': H1.exemplars.galaxy.evolve,
    'exemplars/galaxy.look.wgsl': H1.exemplars.galaxy.look,
    'exemplars/galaxy.sky.wgsl': H1.exemplars.galaxy.sky,
    'exemplars/storm.evolve.wgsl': H1.exemplars.storm.evolve,
    'exemplars/storm.look.wgsl': H1.exemplars.storm.look,
    'exemplars/storm.sky.wgsl': H1.exemplars.storm.sky,
    'mock/faults/galaxy.evolve.wgsl': H1.faults['galaxy.evolve'],
    'mock/plans/galaxy.json': H1.plans.galaxy,
    'mock/plans/storm.json': H1.plans.storm,
};
