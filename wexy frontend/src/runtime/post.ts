// spec.post -> a NullGraph PostChain. The model only chooses effects and numbers; ordering,
// render targets and the HDR boundary come from null-graph/post.

import type { NullGraph } from 'null-graph';
import { Bloom, FXAA, Halation, Outline, PostChain, SSAO, Tonemap, Vignette } from 'null-graph/post';
import type { Effect } from 'null-graph/post';
import type { PostSpec } from '../contract/spec';

export interface PostHandles {
    chain: PostChain;
    bloom?: Bloom;
    halation?: Halation;
    tonemap: Tonemap;
    outline?: Outline;
    vignette?: Vignette;
    /** True when the scene pass carries a samplable depth target (Outline silhouettes, SSAO). */
    depth: boolean;
    /** Effect names in chain order, for display. */
    names: string[];
}

/**
 * @param sceneDepth the scene writes depth itself (a raymarched backdrop's frag_depth), so the
 *   pass needs a depth target even when no effect reads one.
 */
export function buildPostChain(engine: NullGraph, spec: PostSpec, sceneDepth = false): PostHandles {
    const depth = Boolean(spec.outline || spec.ssao || sceneDepth);
    const chain = new PostChain(engine, depth ? { gbuffer: { depth: 'depth24plus' } } : {});
    const effects: Effect[] = [];

    if (spec.ssao) effects.push(new SSAO({ radius: spec.ssao.radius, bias: spec.ssao.bias, intensity: spec.ssao.intensity }));

    let bloom: Bloom | undefined;
    if (spec.bloom) {
        bloom = new Bloom({ threshold: spec.bloom.threshold, knee: spec.bloom.knee ?? 0.5, intensity: spec.bloom.intensity, mips: spec.bloom.mips ?? 5 });
        effects.push(bloom);
    }
    let halation: Halation | undefined;
    if (spec.halation) {
        const h = spec.halation;
        halation = new Halation({ threshold: h.threshold, intensity: h.intensity, radius: h.radius, tint: h.tint });
        effects.push(halation);
    }
    // Always tonemap: the scene renders linear HDR into rgba16float and the swapchain is 8-bit.
    const tonemap = new Tonemap({ curve: spec.tonemap?.curve ?? 'aces', exposure: spec.tonemap?.exposure ?? 1 });
    effects.push(tonemap);

    // FXAA before Outline, as ChainPresets.anime() does, keeps the ink lines one pixel crisp.
    if (spec.fxaa) effects.push(new FXAA());
    let outline: Outline | undefined;
    if (spec.outline) {
        const o = spec.outline;
        outline = new Outline({
            thickness: o.thickness, depthSensitivity: o.depthSensitivity,
            lumaSensitivity: o.lumaSensitivity ?? 0, strength: o.strength ?? 1, color: o.color,
        });
        effects.push(outline);
    }
    let vignette: Vignette | undefined;
    if (spec.vignette) {
        vignette = new Vignette({ intensity: spec.vignette.intensity, softness: spec.vignette.softness });
        effects.push(vignette);
    }

    chain.setChain(effects);
    return { chain, bloom, halation, tonemap, outline, vignette, depth, names: effects.map(e => e.name) };
}
