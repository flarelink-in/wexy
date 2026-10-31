// GPU smoke test for the engine layer, independent of the studio UI. For each archetype: gate the
// hooks (cold and warm), gate a faulted draft (must fail on the expected line), build + smoke,
// measure export-quality GPU cost, run live, and optionally export a short film. Results are
// logged as one JSON line for the page driver (NullGraph's test/gpu/drive-page.mjs).
//   /dev/smoke.html?scene=kerr-black-hole&seconds=3&calib=1&export=1
//   &count=N      particle override          &rung=N        pin the preview guard
//   &nobackdrop=1 trivial backdrop           &post=min      tonemap-only chain
//   &variant=A-D  torii backdrop variant     &ab=A,D        interleaved torii cost comparison
//   &keep=1       with export=1, leave the MP4 as base64 in window.__mp4 for the driver to save

import { ARCHETYPES, archetypeById, archetypeSpec } from '../src/forge-client/archetypes';
import { cameraPath, firstView } from '../src/runtime/camera-path';
import { codecLabel, measureExport, recordExport } from '../src/capture/film';
import { runGate } from '../src/verify/gate';
import { SceneRuntime } from '../src/runtime/scene-runtime';
import { Viewport } from '../src/runtime/viewport';
import { programText, withProgramText, type SceneSpec } from '../src/contract/spec';

const q = new URLSearchParams(location.search);
const logEl = document.getElementById('log')!;
const log = (s: string) => { logEl.textContent += s + '\n'; console.log(s); };

const TRIVIAL_BACKDROP = `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> V {
    let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: V; o.pos = vec4f(p[i], 0.9999, 1.0); o.uv = p[i]; return o;
}
@fragment fn fs_main(v: V) -> @location(0) vec4f {
    return vec4f(vec3f(0.02, 0.03, 0.08) + camera.eye * 0.0 + particles[0].xyz * 0.0, 1.0);
}`;

/**
 * Peel the torii backdrop's quality edits off one at a time, to find which costs what on a given
 * driver: D is the shipped hook, C drops the billow gate, B also the tuft gate, A is the film's.
 */
function toriiVariant(body: string, variant: string): string {
    const swap = (s: string, from: string, to: string) => {
        if (!s.includes(from)) throw new Error(`variant ${variant}: missing ${from.slice(0, 60)}`);
        return s.replace(from, to);
    };
    let b = body;
    if ('ABC'.includes(variant)) {
        b = swap(b,
            '        // The billow displacement is most of the cost: three noise octaves per SDF sample.\n' +
            '        var bp = p;\n        if (params.quality > 0.7) {\n            bp += vec3f(\n' +
            '                (noise3(p * 3.6) - 0.5) * 0.22,\n                (noise3(p * 4.2 + vec3f(3.1)) - 0.5) * 0.18,\n' +
            '                (noise3(p * 3.6 + vec3f(7.3)) - 0.5) * 0.22\n            );\n        }\n',
            '        let bp = p + vec3f(\n            (noise3(p * 3.6) - 0.5) * 0.22,\n' +
            '            (noise3(p * 4.2 + vec3f(3.1)) - 0.5) * 0.18,\n            (noise3(p * 3.6 + vec3f(7.3)) - 0.5) * 0.22\n        );\n');
    }
    if ('AB'.includes(variant)) b = swap(b, 'if (dBushes < 0.35 && params.quality > 0.55) {', 'if (dBushes < 0.35) {');
    if (variant === 'A') {
        b = swap(b, '    let marchSteps = i32(mix(30.0, 72.0, params.quality));\n    for (var step = 0; step < marchSteps; step = step + 1) {',
            '    for (var step = 0; step < 72; step = step + 1) {');
        b = swap(b, '        let reflSteps = i32(mix(12.0, 44.0, params.quality));\n        for (var rs = 0; rs < reflSteps; rs = rs + 1) {',
            '        for (var rs = 0; rs < 44; rs = rs + 1) {');
        // The film's backdrop never read params; keep one harmless read so the binding stays used.
        b = swap(b, 'out.color = vec4f(finalCol + particles[0].xyz * 0.0, 1.0);', 'out.color = vec4f(finalCol + particles[0].xyz * 0.0 + params.quality * 0.0, 1.0);');
    }
    return b;
}

/** calibrate() at a chosen quality (calibrate itself always measures export quality, 1). */
async function measure(viewport: Viewport, runtime: SceneRuntime, quality: number, spec: SceneSpec): Promise<number> {
    const { device } = viewport.engine;
    viewport.enterExport(1280, 720);
    runtime.quality = quality;
    const view = firstView(spec.camera.keyframes);
    for (let i = 0; i < 3; i++) { runtime.view(view, 0); viewport.engine.render(runtime.draw()); }
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) { runtime.step(); runtime.view(view, 0); viewport.engine.render(runtime.draw()); }
    await device.queue.onSubmittedWorkDone();
    viewport.exitExport();
    return (performance.now() - t0) / 6;
}

async function main() {
    const viewport = await Viewport.create(document.getElementById('c') as HTMLCanvasElement);
    log(`GPU: ${viewport.gpuLabel}`);
    if (q.get('rung')) viewport.pinnedRung = Number(q.get('rung'));
    const ids = q.get('scene') ? [q.get('scene')!] : ARCHETYPES.map(a => a.id);
    const results: Record<string, unknown>[] = [];

    if (q.get('ab')) {
        // Interleaved A/B in one session, so driver and power-state drift hit every variant alike.
        const a = archetypeById(ids[0])!;
        const rows: string[] = [];
        for (let round = 0; round < 3; round++) {
            for (const v of q.get('ab')!.split(',')) {
                const spec = withProgramText(archetypeSpec(a), 'backdrop', toriiVariant(programText(archetypeSpec(a), 'backdrop')!, v));
                const { runtime } = await SceneRuntime.build(viewport.engine, spec, 1280, 720);
                const hi = await measure(viewport, runtime!, 1, spec);
                const lo = await measure(viewport, runtime!, 0.4, spec);
                rows.push(`${v} q1 ${hi.toFixed(1)} q0.4 ${lo.toFixed(1)}`);
                runtime!.destroy();
            }
        }
        log(`AB ${rows.join(' | ')}`);
        log('SMOKE-DONE []');
        return;
    }
    viewport.start();

    for (const id of ids) {
        const a = archetypeById(id)!;
        let spec = archetypeSpec(a);
        if (q.get('count')) spec.particles.count = Number(q.get('count'));
        if (q.get('nobackdrop')) spec = withProgramText(spec, 'backdrop', TRIVIAL_BACKDROP);
        if (q.get('post') === 'min') spec.post = { tonemap: { curve: 'aces', exposure: 1.1 } };
        if (q.get('variant') && programText(spec, 'backdrop')) spec = withProgramText(spec, 'backdrop', toriiVariant(programText(spec, 'backdrop')!, q.get('variant')!));

        const gate = await runGate(viewport.engine.device, spec);
        const warm = await runGate(viewport.engine.device, spec);
        const fmt = (g: typeof gate) => `${g.totalMs.toFixed(1)} ms [${g.targets.map(h => `${h.target} ${h.ms.toFixed(1)}`).join(', ')}]`;
        log(`${id}: gate ok=${gate.ok} cold ${fmt(gate)} warm ${fmt(warm)}`);
        for (const e of gate.errors) log(`  ${e.target}:${e.line}:${e.column} ${e.message}`);

        // The faulted draft must fail, and on the faulted line.
        const faulted = withProgramText(spec, a.fault.hook, programText(spec, a.fault.hook)!.replace(a.fault.find, a.fault.replace));
        const fgate = await runGate(viewport.engine.device, faulted);
        const first = fgate.errors[0];
        log(`${id}: faulted gate ok=${fgate.ok} -> ${first ? `${first.target}:${first.line}:${first.column} ${first.message} | ${first.snippet}` : 'NO ERROR'}`);

        const { runtime, smoke } = await SceneRuntime.build(viewport.engine, spec, viewport.canvas.width, viewport.canvas.height);
        log(`${id}: smoke ok=${smoke.ok} ${smoke.ms.toFixed(0)} ms ${smoke.error ?? ''} count=${runtime?.count}`);
        if (!runtime) { results.push({ id, gate: gate.ok, smoke }); continue; }

        let calib: Record<string, number> | undefined;
        if (q.get('calib')) {
            // GPU cost per frame at export quality, without the compositor in the loop.
            calib = {};
            const resume = viewport.pause();
            try {
                for (const [w, h] of [[1920, 1080], [1280, 720], [640, 360]]) {
                    const { msPerFrame } = await measureExport(viewport.engine.device, spec, runtime, { width: w, height: h, fps: 60 }, firstView(spec.camera.keyframes));
                    calib[`${w}x${h}`] = Math.round(msPerFrame * 10) / 10;
                }
            } finally {
                resume();
            }
            log(`${id}: calib ms/frame ${JSON.stringify(calib)}`);
        }

        viewport.setView(firstView(spec.camera.keyframes));
        viewport.path = cameraPath(spec.camera.keyframes, 12);
        viewport.mode = 'path';
        viewport.playing = true;
        viewport.setRuntime(runtime);
        await new Promise(r => setTimeout(r, Number(q.get('seconds') ?? 3) * 1000));
        const stats = { ...viewport.frameStats };
        log(`${id}: live ${stats.fps.toFixed(1)} fps, frame ${stats.frameMs.toFixed(1)} ms, ` +
            `scale ${stats.scale}, quality ${stats.quality}, ${stats.width}x${stats.height}`);

        let exported: Record<string, unknown> | undefined;
        if (q.get('export')) {
            const path = cameraPath(spec.camera.keyframes, 2)!;
            const resume = viewport.pause();
            let res;
            try {
                res = await recordExport({
                    device: viewport.engine.device, spec, live: runtime, settings: { width: 1280, height: 720, fps: 60, seconds: 2 }, path,
                    still: firstView(spec.camera.keyframes), name: `${id}.mp4`, target: 'memory', signal: new AbortController().signal,
                });
            } finally {
                resume();
            }
            exported = { codec: codecLabel(res.codec), bytes: res.file?.size ?? 0, frames: res.frames, ms: Math.round(res.report.timings.recordingMs) };
            log(`${id}: export ${JSON.stringify(exported)}`);
            if (q.get('keep')) {
                const buf = new Uint8Array(await res.file!.arrayBuffer());
                let s = '';
                for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
                (window as unknown as Record<string, string>).__mp4 = btoa(s);
            }
        }
        results.push({ id, gate: gate.ok, gateMs: gate.totalMs, warmGateMs: warm.totalMs, faultLine: first?.line, faultMsg: first?.message, smoke, calib, stats, exported });
        if (ids.length > 1) {
            viewport.setRuntime(null);
            runtime.destroy();
        }
    }
    log('SMOKE-DONE ' + JSON.stringify(results));
}

main().catch(e => { log('SMOKE-FAILED ' + (e?.stack ?? e)); console.error(e); });
