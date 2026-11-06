// EA9.6: hand-written examples are data, never a planner/author/repair simulation or a model client.
import { specFromDraft, parseDraft } from '../contract/draft';
import { H1, EXEMPLAR_WORLDS, type ExemplarWorld } from '../contract/h1';
import { withProgramText, type SceneSpec, type Style } from '../contract/spec';
import { archetypeSpec, routePrompt } from './archetypes';
import { collidingGalaxies, isCollisionPrompt } from './examples/colliding-galaxies';

const WORDS: Record<ExemplarWorld, RegExp> = {
    galaxy: /galax|spiral|milky|nebula|\bstars?\b|andromeda/i,
    storm: /storm|thunder|cloud|lightning|cumul|rain/i,
};

/** No network, identity or invented usage. The caller still verifies the spec before installing it. */
export function loadExample(prompt: string, style: Style | 'auto'): SceneSpec {
    if (isCollisionPrompt(prompt)) return collidingGalaxies(style).spec;
    const world = EXEMPLAR_WORLDS.find(w => WORDS[w].test(prompt));
    if (world) {
        const parsed = parseDraft(H1.plans[world]);
        if (!parsed.draft) throw new Error(`example ${world}: ${parsed.problems.join('; ')}`);
        if (style !== 'auto') parsed.draft.style = style;
        let spec = specFromDraft(parsed.draft, { kind: 'functions', ...H1.exemplars[world] });
        for (const fn of ['evolve', 'look', 'sky'] as const) {
            if (fn !== 'sky' || spec.sky === 'function') spec = withProgramText(spec, fn, H1.exemplars[world][fn]);
        }
        return spec;
    }
    const archetype = routePrompt(prompt, style).archetype;
    const spec = archetypeSpec(archetype);
    for (const tweak of archetype.tweaks) {
        if (tweak.match.test(prompt) && spec.uniforms[tweak.uniform]) spec.uniforms[tweak.uniform].value = tweak.value;
    }
    const selected = style === 'auto' ? archetype.style : style;
    spec.style = selected;
    // Preserve the original examples' grading; retirement changes no world or shader bytes.
    if (selected !== archetype.style) {
        const post = spec.post;
        if (selected === 'brutalist') {
            post.tonemap = { curve: 'agx', exposure: (post.tonemap?.exposure ?? 1) * 1.05 };
            post.vignette = { intensity: 0.42, softness: 0.5 };
            if (post.bloom) post.bloom.intensity *= 0.7;
        } else if (selected === 'cinematic' || selected === 'anime-cel') {
            post.halation ??= { threshold: 1.0, intensity: 0.3, radius: 1.6, tint: [1, 0.38, 0.18] };
            post.vignette = { intensity: 0.28, softness: 0.6 };
            if (selected === 'anime-cel') post.fxaa = true;
        } else if (selected === 'cosmic' && post.bloom) {
            post.bloom.intensity *= 1.2;
        }
    }
    return spec;
}