// Deterministic particle seeding: the same LCG the NullGraph film scenes use, so a seed reproduces
// the same initial state on every machine, which a deterministic export depends on.

import type { ParticlesSpec, SpawnDistribution } from '../contract/spec';

export const PARTICLE_STRIDE = 8;

export function seedParticles(sim: ParticlesSpec, count: number): Float32Array {
    const data = new Float32Array(count * PARTICLE_STRIDE);
    let state = sim.seed >>> 0;
    const rand = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const draw = (d: SpawnDistribution) => {
        switch (d.dist) {
            case 'uniform': return d.min + rand() * (d.max - d.min);
            case 'power': return d.min + Math.pow(rand(), d.power) * (d.max - d.min);
            case 'triangular': return d.min + (rand() + rand()) * 0.5 * (d.max - d.min);
        }
    };
    const { spawn } = sim;
    const randomPhase = spawn.phase === 'random-angle';
    for (let i = 0; i < count; i++) {
        const o = i * PARTICLE_STRIDE;
        // a.xyz stay zero: the first evolve step places every particle.
        data[o + 3] = randomPhase ? rand() * Math.PI * 2 : 0;
        data[o + 4] = draw(spawn.x);
        data[o + 5] = draw(spawn.y);
        data[o + 6] = draw(spawn.z);
        data[o + 7] = draw(spawn.w);
    }
    return data;
}

/** The particle count the device can hold: one storage binding of count × 32 bytes. */
export function clampParticleCount(requested: number, device: GPUDevice): number {
    const maxByBinding = Math.floor(device.limits.maxStorageBufferBindingSize / (PARTICLE_STRIDE * 4));
    const maxByDispatch = device.limits.maxComputeWorkgroupsPerDimension * 128;
    const max = Math.min(maxByBinding, maxByDispatch, 4 * 1024 * 1024);
    return Math.max(128, Math.min(Math.floor(requested), max));
}
