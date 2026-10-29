// Hand-written h1 collision example, independent of the backend's byte-pinned teaching fixtures.
// Analytic encounter and tidal distortion, not an N-body simulation; always verified by the normal ladder.
import { parseDraft, specFromDraft, type Draft } from '../../contract/draft';
import { H1 } from '../../contract/h1';
import type { SceneSpec, Style } from '../../contract/spec';
import evolve from './collision.evolve.wgsl?raw';
import look from './collision.look.wgsl?raw';

export const COLLISION_PROMPT = 'Two spiral galaxies colliding, with golden cores, blue and rose arms and long tidal tails';

export function isCollisionPrompt(prompt: string): boolean {
    return /galax|andromeda|milky way/i.test(prompt) && /collid|collision|merg|encounter|interact/i.test(prompt);
}

export function collidingGalaxies(style: Style | 'auto' = 'auto'): { draft: Draft; spec: SceneSpec } {
    const { draft } = parseDraft(H1.plans.galaxy);
    if (!draft) throw new Error('The galaxy template is invalid.');
    draft.title = 'Colliding Galaxies';
    draft.summary = 'Two tilted spiral galaxies sweep past each other, trailing blue and rose tidal ribbons; a stylized encounter, not an N-body simulation.';
    if (style !== 'auto') draft.style = style;
    draft.particles.count = 524288;
    draft.particles.spawn.x = { dist: 'power', min: 0.15, max: 4.2, power: 1.25, use: 'disk radius' };
    draft.uniforms = [
        { name: 'spin', label: 'Motion speed', value: 0.65, min: 0, max: 2, step: 0.05 },
        { name: 'armTwist', label: 'Arm twist', value: 3.4, min: 1, max: 5, step: 0.1 },
        { name: 'thickness', label: 'Disk thickness', value: 0.16, min: 0.02, max: 0.6, step: 0.01 },
        { name: 'coreGlow', label: 'Core glow', value: 1.4, min: 0, max: 3, step: 0.1 },
        { name: 'encounter', label: 'Encounter stage', value: 0, min: 0, max: 3.14, step: 0.01 },
        { name: 'tails', label: 'Tidal tails', value: 1, min: 0, max: 1.5, step: 0.05 },
    ];
    draft.camera.keyframes = [
        { t: 0, target: [0, 0, 0], distance: 25, azimuth: 8, polar: 38, fov: 45 },
        { t: 1, target: [0, 0, 0], distance: 23, azimuth: 25, polar: 48, fov: 45 },
    ];
    return { draft, spec: specFromDraft(draft, { kind: 'functions', evolve, look, sky: H1.exemplars.galaxy.sky }) };
}