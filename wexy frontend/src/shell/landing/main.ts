// The marketing page. The hero is not a video: it is the studio's own Kerr archetype rendered live
// by NullGraph, with a still underneath for browsers without WebGPU.

import '@fontsource-variable/geist';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/geist-mono';
import '../../styles/base.css';
import '../../styles/landing.css';

import { ARCHETYPES, archetypeSpec } from '../../forge-client/archetypes';
import { kerrBlackHole } from '../../forge-client/archetypes/kerr-black-hole';
import { cameraPath, firstView } from '../../runtime/camera-path';
import { SceneRuntime } from '../../runtime/scene-runtime';
import { Viewport } from '../../runtime/viewport';
import { icon, logo, wordmark, type IconName } from '../../shared/icons';
import type { SceneSpec } from '../../contract/spec';

for (const el of document.querySelectorAll<HTMLElement>('[data-logo]')) el.innerHTML = wordmark(Number(el.dataset.logo) || 24);
for (const el of document.querySelectorAll<HTMLElement>('[data-mark]')) el.outerHTML = logo(Number(el.dataset.mark) || 26).replace('class="logo"', `class="logo ${el.className}"`);
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) el.outerHTML = icon(el.dataset.icon as IconName, 15);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- nav

const nav = document.getElementById('nav')!;
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 24);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---------------------------------------------------------------- hero prompt

const input = document.getElementById('hero-prompt') as HTMLInputElement;
const form = document.getElementById('prompt-bar') as HTMLFormElement;
const prompts = ARCHETYPES.map(a => a.examplePrompt);
let current = prompts[0];
let typing = true;

form.addEventListener('submit', () => {
    if (!input.value.trim()) input.value = current;
});
input.addEventListener('focus', () => { typing = false; input.placeholder = current; });

/** Type each example into the placeholder, hold, erase, next; stops once the visitor takes over. */
async function cycle(): Promise<void> {
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    if (reduceMotion) { input.placeholder = current; return; }
    for (let i = 0; typing; i = (i + 1) % prompts.length) {
        current = prompts[i];
        for (let n = 1; n <= current.length && typing; n++) {
            input.placeholder = current.slice(0, n);
            await wait(22);
        }
        await wait(2600);
        for (let n = current.length; n > 0 && typing; n -= 3) {
            input.placeholder = current.slice(0, n);
            await wait(10);
        }
    }
    input.placeholder = current;
}
void cycle();

// ---------------------------------------------------------------- live hero

async function startHero(): Promise<void> {
    const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement;
    const live = document.getElementById('hero-live')!;
    let viewport: Viewport;
    try {
        viewport = await Viewport.create(canvas);
    } catch {
        return; // The still stays; the page reads the same without WebGPU.
    }

    // The studio's archetype at half the particles, glow raised to keep the disk's brightness:
    // a landing page should not ask a laptop GPU for a million particles.
    const spec: SceneSpec = archetypeSpec(kerrBlackHole);
    spec.particles.count = 524_288;
    spec.uniforms.diskGlow.value = 1.7;
    spec.uniforms.jetPower.value = 1.5;
    spec.uniforms.ringGlow.value = 1.3;
    // Out and back: the path ends where it starts with zero slope, so the loop has no seam.
    spec.camera.keyframes = [
        { t: 0, target: [0, 0, 0], distance: 20, azimuth: -30, polar: 79, fov: 42 },
        { t: 0.5, target: [0, 0, 0], distance: 17.5, azimuth: 38, polar: 81, fov: 42 },
        { t: 1, target: [0, 0, 0], distance: 20, azimuth: -30, polar: 79, fov: 42 },
    ];
    const { runtime } = await SceneRuntime.build(viewport.engine, spec, canvas.width, canvas.height);
    if (!runtime) return;

    viewport.setRuntime(runtime);
    viewport.setView(firstView(spec.camera.keyframes));
    viewport.duration = 40;
    viewport.path = cameraPath(spec.camera.keyframes, viewport.duration);
    viewport.mode = 'path';
    viewport.playing = !reduceMotion;
    viewport.simPaused = reduceMotion;
    document.body.classList.add('hero-is-live');
    live.hidden = false;

    // Draw only while the hero is on screen.
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? viewport.start() : viewport.stop()), { threshold: 0.02 })
        .observe(canvas);
}
void startHero();
