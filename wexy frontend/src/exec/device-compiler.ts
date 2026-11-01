// L3 on the device (EA5.1; executor-design.md §6): a checked body compiled in its assembled module by this device's own
// compiler. The module is made inside a validation error scope, pushed and popped in one synchronous section, so no
// other work's error lands in it and none of its own escapes uncaptured; its compilation info is read back, and
// compileBody places each message on the body's lines, the host's or none. It never throws. A pass needs both checks
// to pass: an error the scope caught that the compilation info does not show, a scope or info that failed, a module
// that could not be made, and a device lost or replaced before the verdict are each an error with no line, which
// accuses no module (the candidate stops, and no repair is spent on the device's trouble).
//
// Provenance (§6, "Close the provenance gap"; EA-D8): `producedBy: 'device'` is a label anyone can write. So every
// verdict compileBody builds from this compiler's own compile is registered here, by object, with the device
// generation it was made in and the exact module source it judged. `provenance` accepts only such verdicts, for exactly
// a sealed candidate's bodies, made on this device in its current generation: a JSON copy, a fake's, another device's,
// or one from before a device loss proves nothing. A lost device voids every verdict, and nothing here outlives it. The
// registry is the host's alone (I6); downloaded evidence is diagnostic data, never an admission.
//
// It is handed a GPUDevice and nothing else: no engine, no runtime, no canvas.

import { assembleModule, type CompileMessage, type CompiledBody, type ModuleCompiler } from '../contract/adapters/bodies';
import { sha256Hex } from '../contract/adapters/canonical';
import type { DeepReadonly } from '../contract/engine/frozen';
import type { SealedCandidate } from '../loop/snapshot';

/** The members of GPUDevice that L3 uses, so a test stands a fake device in. */
export type CompileDevice = Pick<GPUDevice, 'createShaderModule' | 'pushErrorScope' | 'popErrorScope' | 'lost'>;

/** At most this many of a module's messages are kept, errors first (§6: diagnostics are capped). */
export const MAX_COMPILE_MESSAGES = 32;
/** Each message's text, characters (compileBody keeps as many). */
const MAX_MESSAGE_CHARS = 400;
/** Compiles remembered until their verdicts are registered: the newest, a few candidates' modules. */
const REMEMBERED = 64;

export interface DeviceCompilerOptions {
    /** The host's device generation: it moves when the device is lost or replaced (executor.ts, `Present.device`). */
    generation?: () => number;
    /** The GPU's name, as the studio shows it: what judged each verdict. */
    gpu?: string;
}

export interface DeviceCompiler extends ModuleCompiler {
    readonly producedBy: 'device';
    readonly gpu: string;
    /** The device is gone: every verdict this compiler made proves nothing now. */
    readonly lost: boolean;
    /** Why `compiled` is not this device's own verdicts on exactly `snapshot`'s bodies, now; null when it is. */
    provenance(snapshot: DeepReadonly<SealedCandidate>, compiled: readonly DeepReadonly<CompiledBody>[]): string | null;
}

interface Compiled { generation: number; ok: boolean }
interface Attestation { generation: number; source: string; module: string; interfaceHash: string; codeHash: string; ok: boolean }

const text = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);
/** A message about the device's trouble, not the body: no line, so no module is accused. */
const trouble = (what: string): CompileMessage => ({ line: 0, type: 'error', message: `L3 could not judge this module on this device: ${what}`.slice(0, MAX_MESSAGE_CHARS) });
const RANK: Readonly<Record<CompileMessage['type'], number>> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then the rest, each in the device's order; at most MAX_COMPILE_MESSAGES, the cut said. */
function capped(messages: CompileMessage[]): CompileMessage[] {
    const sorted = messages.map((m, i) => [m, i] as const).sort((a, b) => RANK[a[0].type] - RANK[b[0].type] || a[1] - b[1]).map(([m]) => m);
    if (sorted.length <= MAX_COMPILE_MESSAGES) return sorted;
    const kept = sorted.slice(0, MAX_COMPILE_MESSAGES - 1);
    return [...kept, { line: 0, type: 'warning', message: `${sorted.length - kept.length} more of the device's messages were not kept` }];
}

/** L3 over `device`: its compiler's verdicts, each registered so a gate can tell them from a copy (EA-D4, EA-D8). */
export function createDeviceCompiler(device: CompileDevice, options: DeviceCompilerOptions = {}): DeviceCompiler {
    const generation = options.generation ?? (() => 0);
    let lost: string | null = null;
    /** Read through a call: the loss lands from a callback, between any two awaits. */
    const gone = (): string | null => lost;
    const compiled = new Map<string, Compiled>();
    const attested = new WeakMap<object, Attestation>();
    device.lost.then(info => {
        lost = (info?.message || info?.reason || 'lost').slice(0, 200);
        // Nothing it made is worth keeping now: `provenance` refuses everything once the device is lost.
        compiled.clear();
    }, () => { /* a lost promise that rejects tells nothing; the host's generation still guards */ });

    /** One module made in its own validation scope; what the compilation info and the scope said. */
    async function judge(source: string, label: string): Promise<CompileMessage[]> {
        let module: GPUShaderModule | null = null;
        let thrown: unknown = null;
        let scope: Promise<{ error: GPUError | null } | { failed: unknown }>;
        device.pushErrorScope('validation');
        try {
            module = device.createShaderModule({ code: source, label });
        } catch (e) {
            thrown = e;
        }
        // Popped in the same synchronous section as the push, whatever happened: no await between them, so no frame's
        // work runs inside this scope, and the module's own error cannot escape it.
        try {
            scope = device.popErrorScope().then(error => ({ error }), failed => ({ failed }));
        } catch (e) {
            scope = Promise.resolve({ failed: e });
        }
        const info: { messages: readonly GPUCompilationMessage[] } | { failed: unknown } = module
            ? await module.getCompilationInfo().then(i => ({ messages: i.messages }), failed => ({ failed }))
            : { messages: [] };
        const popped = await scope;
        const out: CompileMessage[] = [];
        if ('messages' in info) {
            for (const m of info.messages) {
                const type = m.type === 'error' || m.type === 'warning' ? m.type : 'info';
                out.push({ line: Number.isSafeInteger(m.lineNum) && m.lineNum > 0 ? m.lineNum : 0, type, message: String(m.message).slice(0, MAX_MESSAGE_CHARS) });
            }
        }
        const said = out.some(m => m.type === 'error');
        if (thrown !== null) out.push(trouble(`making the module threw: ${text(thrown)}`));
        if ('failed' in info) out.push(trouble(`its compilation info failed: ${text(info.failed)}`));
        if ('failed' in popped) out.push(trouble(`its validation scope failed: ${text(popped.failed)}`));
        // The same failure the compilation info placed on a line needs nothing more; one it does not show is never a pass.
        else if (popped.error && !said) out.push(trouble(`the device refused it: ${text(popped.error.message)}`));
        return capped(out);
    }

    return {
        producedBy: 'device',
        gpu: options.gpu ?? 'this device',
        get lost() { return gone() !== null; },

        async compile(source, label) {
            const at = generation();
            const key = await sha256Hex(source);
            const before = gone();
            let messages = before !== null ? [trouble(`the device was lost (${before})`)] : await judge(source, label);
            // A device lost or replaced while the module was judged: whatever it said proves nothing.
            const during = gone();
            if (before === null && during !== null) messages = [trouble(`the device was lost while it compiled (${during})`)];
            else if (generation() !== at) messages = [trouble(`the device generation moved from ${at} to ${generation()} while it compiled`)];
            compiled.delete(key);
            compiled.set(key, { generation: at, ok: !messages.some(m => m.type === 'error') });
            while (compiled.size > REMEMBERED) compiled.delete(compiled.keys().next().value!);
            return messages;
        },

        async attest(verdict, source) {
            const c = compiled.get(await sha256Hex(source));
            // Only a verdict on a compile this compiler made, saying what the device said; its generation and the
            // device's state are `provenance`'s to judge, at admission.
            if (!c || c.ok !== verdict.ok) return;
            attested.set(verdict, {
                generation: c.generation, source, module: verdict.module, interfaceHash: verdict.interfaceHash, codeHash: verdict.codeHash, ok: verdict.ok,
            });
        },

        provenance(snapshot, verdicts) {
            const why = gone();
            if (why !== null) return `the device was lost (${why}): its compile verdicts prove nothing now`;
            const now = generation();
            for (const body of snapshot.bodies) {
                const mine = verdicts.filter(c => c.module === body.module);
                if (mine.length !== 1) return mine.length ? `module ${body.module} has ${mine.length} compile verdicts` : `module ${body.module} has no compile verdict from this device`;
                const a = attested.get(mine[0]);
                if (!a) return `the compile verdict for ${body.module} is not one this device's compiler made: a copy, a fake's or another device's proves nothing`;
                if (a.generation !== now) return `the compile verdict for ${body.module} is from device generation ${a.generation}, and the device is at ${now}: compile it again`;
                const iface = snapshot.interfaces.find(i => i.module === body.module);
                if (a.module !== body.module || a.interfaceHash !== body.interfaceHash || a.codeHash !== body.codeHash || !iface
                    || assembleModule(iface, body.body).source !== a.source) {
                    return `the compile verdict for ${body.module} judged another module than this candidate's`;
                }
                if (!a.ok) return `${body.module} does not compile on this device`;
            }
            for (const c of verdicts) if (!snapshot.bodies.some(b => b.module === c.module)) return `module ${c.module} is not one of this candidate's`;
            return null;
        },
    };
}
