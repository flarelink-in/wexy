// WorldRuntime (EA5.0; executor-design.md §5): what the viewport drives, as an interface, so a world runs on the stage
// whatever built it. h1's SceneRuntime implements it from its spec; EA5's agent runtime (src/exec/world-runtime.ts)
// implements it from a sealed candidate's X. The viewport reads nothing else of a world: not its spec, its particles
// or its program.

import type { ComputeStageNode, RenderPassNode } from 'null-graph';
import type { CameraView } from './camera-path';

export interface WorldRuntime {
    /** The fixed step, seconds: finite, positive, dividing 1/60 (a film needs whole steps a frame at 30 and 60 fps). */
    readonly dt: number;
    /** Seconds advanced by completed fixed steps. */
    readonly simTime: number;
    /** One fixed step. */
    step(): void;
    /** Places the camera for a frame at `seconds` of simulated time. */
    view(v: CameraView, seconds: number): void;
    /** The frame's sequence, as NullGraph's render() takes it. */
    draw(): (ComputeStageNode | RenderPassNode)[];
    /** The host's resize: the world's own size-dependent resources follow. */
    resize(width: number, height: number): void;
    /** Back to time zero on the same allocations, for a film's calibration (EA5.5); absent when a world cannot. */
    reset?(): Promise<void> | void;
    /** The preview guard's quality dial, 0 to 1. */
    quality: number;
    /** The lowest quality the dial may reach; null for a world with no dial (resolution alone then). */
    readonly qualityFloor: number | null;
    /** Releases everything the world made, each once. */
    destroy(): void;
}
