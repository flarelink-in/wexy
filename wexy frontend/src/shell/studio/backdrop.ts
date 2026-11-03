// The empty stage's live backdrop (the user, 11-02: "for now setup a way for null-graph canvas as background", so the
// empty stage no longer waits on the loader video): a playground example drawn by the viewport's own NullGraph engine
// behind the empty card, from the studio's first second until the first world replaces it.
//
// - It is the viewport's world only until then: install() swaps the first world in, then drops this one.
// - It is never a world the person made: no HUD, controls, timeline or capture, and the card names its source
//   (design guidelines §3).
// - It is hand-written (an archetype), so it reaches the GPU as the home page's hero does, not through the ladder
//   (I2 is about model-written text).
// - It keeps to itself: its camera runs on its own clock (the studio's playhead, path and camera mode stay as they
//   are), and it holds still while the device checks a candidate, so a probe never times its frames (EA5.4's quiet
//   windows: a world drawing on the same queue read five to seven times slower).

import type { CameraKeyframe } from '../../contract/spec';
import { archetypeById, archetypeSpec } from '../../forge-client/archetypes';
import { cameraPath, firstView, fitView, type CameraView } from '../../runtime/camera-path';
import { SceneRuntime } from '../../runtime/scene-runtime';
import type { Viewport } from '../../runtime/viewport';
import type { WorldRuntime } from '../../runtime/world';

/** The home page's hero, so the studio opens on the world the visitor has just seen. */
export const BACKDROP_DEFAULT = 'kerr-black-hole';
/**
 * The hero's own tuning (src/shell/landing/main.ts): with fewer particles than the scene's million, the disk, jets
 * and ring glow brighter to keep their look. Another playground example runs as written, with fewer particles.
 */
const TUNING: Record<string, Record<string, number>> = {
    'kerr-black-hole': { diskGlow: 1.7, jetPower: 1.5, ringGlow: 1.3 },
};
/** Seconds for the camera to travel the scene's keyframes one way; it then travels back, so the loop has no seam. */
const LEG_SECONDS = 36;
/** The clock's largest step: after a hold, the camera carries on from where it stopped instead of jumping. */
const MAX_STEP_SECONDS = 1 / 15;

export interface Backdrop {
    /** The playground example it draws (its archetype's id). */
    readonly id: string;
    /**
     * Settles once the world is on the viewport (true), or could not be (false). A check on the device waits for it:
     * by then its pipelines are compiled and its first frame done (SceneRuntime.build).
     */
    readonly ready: Promise<boolean>;
    /**
     * What it would hold with its canvas at `pixels`, and never less than it holds now (SceneRuntime.deviceBytesAt): the
     * stage's ledger counts it at the largest canvas the viewport can give it (EA9.3, §8 step 2, and its review). Null
     * while it builds, and once it is dropped.
     */
    bytes(pixels: number): number | null;
    /** Stops its frames until the returned release is called (the viewport's own pause, so holds add up). */
    hold(): () => void;
    /**
     * How many of the viewport's pauses are its own now: its rest while scrolled out of sight, and the holds of a check.
     * A Run need not wait for them (EA9.3): they hold nothing a Run's commit could race.
     */
    holdCount(): number;
    /** Takes it off the viewport if it is still there and frees it. Calling it again does nothing. */
    drop(): void;
}

export interface BackdropOptions {
    /** A touch screen, taken as a phone's or a tablet's GPU: fewer particles. */
    touch: boolean;
    /** prefers-reduced-motion: one still frame, no motion. */
    still: boolean;
}

/** The backdrop for archetype `id`, starting to build now; null for an id no archetype has. */
export function startBackdrop(vp: Viewport, id: string, options: BackdropOptions): Backdrop | null {
    const archetype = archetypeById(id);
    if (!archetype) return null;
    const spec = archetypeSpec(archetype);
    // A background, not the world: half the scene's particles on a desktop, as the hero draws it, and a quarter on a phone.
    spec.particles.count = Math.min(spec.particles.count, options.touch ? 262_144 : 524_288);
    for (const [name, value] of Object.entries(TUNING[archetype.id] ?? {})) {
        const uniform = spec.uniforms[name];
        if (uniform) uniform.value = Math.min(uniform.max, Math.max(uniform.min, value));
    }

    let world: BackdropWorld | null = null;
    let dropped = false;
    /** Its own pauses of the viewport (holdCount), each with its let-go. */
    let own = 0;
    const holds = new Set<() => void>();
    const hold = () => {
        // Counted before the viewport is paused: the viewport tells its hold from inside pause(), and the studio, told,
        // must find this pause the backdrop's own (main.ts's stageHolders), or Show it waits for a rest (EA9.3). Given back
        // before the release, for the same reason.
        own++;
        const release = vp.pause();
        let done = false;
        const letGo = () => {
            if (done) return;
            done = true;
            holds.delete(letGo);
            own--;
            release();
        };
        holds.add(letGo);
        return letGo;
    };
    // Off screen (a phone scrolled down to type), it draws nothing.
    let offscreen: (() => void) | null = null;
    const visibility = new IntersectionObserver(([entry]) => {
        if (dropped) return;
        if (!entry.isIntersecting && !offscreen) offscreen = hold();
        else if (entry.isIntersecting && offscreen) { offscreen(); offscreen = null; }
    });

    const ready = (async () => {
        try {
            const { runtime } = await SceneRuntime.build(vp.engine, spec, vp.canvas.width, vp.canvas.height);
            if (!runtime) return false;
            // A world that reached the viewport during the build keeps it.
            if (dropped || vp.runtime) { runtime.destroy(); return false; }
            world = new BackdropWorld(runtime, spec.camera.keyframes, options.still, vp.canvas.width / vp.canvas.height);
            vp.setRuntime(world);
            visibility.observe(vp.canvas);
            return true;
        } catch {
            return false;
        }
    })();

    return {
        id: archetype.id,
        ready,
        bytes: pixels => world?.deviceBytesAt(pixels) ?? null,
        hold: () => (world && vp.runtime === world ? hold() : () => {}),
        holdCount: () => own,
        drop: () => {
            if (dropped) return;
            dropped = true;
            visibility.disconnect();
            for (const letGo of [...holds]) letGo();
            holds.clear();
            offscreen = null;
            if (!world) return;
            if (vp.runtime === world) vp.setRuntime(null);
            world.destroy();
            world = null;
        },
    };
}

/**
 * The archetype's runtime with the camera taken over: whatever view the viewport passes, it shows its own, the scene's
 * keyframes there and back on the backdrop's clock, fitted to the frame's shape. Under reduced motion it never steps,
 * and the camera rests on the first keyframe.
 */
class BackdropWorld implements WorldRuntime {
    private clock = 0;
    private last = 0;
    private readonly path: ((seconds: number) => CameraView) | null;
    private readonly rest: CameraView;

    constructor(private readonly inner: SceneRuntime, keyframes: CameraKeyframe[], private readonly still: boolean, private aspect: number) {
        this.path = cameraPath(keyframes, LEG_SECONDS);
        this.rest = firstView(keyframes);
    }

    get dt(): number { return this.inner.dt; }
    /** The archetype's runtime's own count at a canvas of `pixels` (SceneRuntime.deviceBytesAt): from the sizes, not VRAM. */
    deviceBytesAt(pixels: number): number { return this.inner.deviceBytesAt(pixels); }
    get simTime(): number { return this.inner.simTime; }
    get quality(): number { return this.inner.quality; }
    set quality(q: number) { this.inner.quality = q; }
    get qualityFloor(): number | null { return this.inner.qualityFloor; }

    step(): void {
        if (!this.still) this.inner.step();
    }

    view(_ignored: CameraView, seconds: number): void {
        const now = performance.now() / 1000;
        if (this.last && !this.still) this.clock += Math.min(now - this.last, MAX_STEP_SECONDS);
        this.last = now;
        const s = this.clock % (2 * LEG_SECONDS);
        const v = this.path ? this.path(s < LEG_SECONDS ? s : 2 * LEG_SECONDS - s) : this.rest;
        this.inner.view(fitView(v, this.aspect), seconds);
    }

    draw(): ReturnType<WorldRuntime['draw']> {
        return this.inner.draw();
    }

    resize(width: number, height: number): void {
        this.aspect = width / height;
        this.inner.resize(width, height);
    }

    destroy(): void {
        this.inner.destroy();
    }
}
