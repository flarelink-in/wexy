import type { Draft } from '../../contract/draft';
import type { SceneSpec, Style } from '../../contract/spec';
import { celestialTorii } from './celestial-torii';
import { kerrBlackHole } from './kerr-black-hole';
import { magneticStar } from './magnetic-star';
import type { Archetype } from './types';

export type { Archetype, ArchetypeHooks, Fault } from './types';

export const ARCHETYPES: Archetype[] = [kerrBlackHole, celestialTorii, magneticStar];

export function archetypeById(id: string): Archetype | undefined {
    return ARCHETYPES.find(a => a.id === id);
}

/** The whole spec of a playground example: its draft and its hooks as the expert program. A fresh copy each time. */
export function archetypeSpec(a: Archetype): SceneSpec {
    return { ...structuredClone(a.draft), program: { kind: 'hooks', ...a.hooks } };
}

/** The draft the planner would have written for a playground example: the controls as an array, the rest as is. */
export function archetypeDraft(a: Archetype): Draft {
    const d = structuredClone(a.draft);
    const post = d.post;
    return {
        title: d.title,
        summary: d.summary,
        style: d.style,
        particles: d.particles,
        arrangement: null,
        light: null,
        sky: d.sky,
        uniforms: Object.entries(d.uniforms).map(([name, u]) => ({ name, label: u.label, value: u.value, min: u.min, max: u.max, step: u.step ?? 0.01 })),
        camera: { keyframes: d.camera.keyframes, move: d.camera.move ?? null },
        post: {
            bloom: post.bloom ? { threshold: post.bloom.threshold, intensity: post.bloom.intensity } : null,
            halation: post.halation ? { ...post.halation } : null,
            tonemap: post.tonemap ? { ...post.tonemap } : null,
            fxaa: post.fxaa ?? false,
            vignette: post.vignette ? { ...post.vignette } : null,
        },
    };
}

/**
 * The mock's routing to a playground example: the prompt's subject first, then the requested style, then a
 * default. The live planner gets no such routing: the backend's templates hold its exemplars.
 */
export function routePrompt(prompt: string, style: Style | 'auto'): { archetype: Archetype; reason: string } {
    const hits = ARCHETYPES
        .map(a => ({ a, words: prompt.match(new RegExp(a.keywords.source, 'gi')) ?? [] }))
        .filter(h => h.words.length > 0)
        .sort((x, y) => y.words.length - x.words.length);
    if (hits.length) {
        const words = [...new Set(hits[0].words.map(w => w.toLowerCase()))].slice(0, 3);
        return { archetype: hits[0].a, reason: `subject "${words.join('", "')}"` };
    }
    if (style !== 'auto') {
        const byStyle = ARCHETYPES.find(a => a.style === style);
        if (byStyle) return { archetype: byStyle, reason: `style ${style}` };
    }
    return { archetype: kerrBlackHole, reason: 'no subject match; default cosmic scene' };
}
